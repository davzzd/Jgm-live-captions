/**
 * WebSocket Server for Live Subtitles
 * 
 * This server:
 * 1. Captures microphone input from the browser
 * 2. Connects to Soniox WebSocket for real-time STT + translation
 * 3. Forwards translated text to caption display clients
 * 
 * Architecture:
 * - Browser (mic input) → This server → Soniox WebSocket → This server → captions.html
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// WebSocket server for browser clients (mic input)
const wssClients = new WebSocket.Server({ 
  noServer: true,
  path: '/client' // Browser connects to ws://localhost:8080/client
});

// WebSocket server for caption displays (captions.html)
const wssCaptions = new WebSocket.Server({ 
  noServer: true,
  path: '/captions' // captions.html connects to ws://localhost:8080/captions
});

// Soniox configuration
const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const SONIOX_API_KEY = process.env.SONIOX_MASTER_API_KEY || '885a41baf0c85746228dd44ab442c3770e2c69f4f6f22bb7e3244de0d6d7899c';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

let sonioxWs = null;
let isSonioxConfigured = false;
let captionClients = new Set(); // Connected caption display clients
let reconnectAttempts = 0;
let reconnectTimeout = null;
let lastAudioSentTime = 0;
let connectionStartTime = 0;
const MAX_RECONNECT_ATTEMPTS = Infinity; // Allow infinite reconnects for long sessions
const RECONNECT_DELAY = 2000; // Start with 2s, will use exponential backoff
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
let heartbeatInterval = null;

/**
 * Broadcast text to all caption clients (optimized)
 */
function broadcastToCaptions(text) {
  if (!text) return;
  const deadClients = [];
  captionClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(text);
      } catch (error) {
        deadClients.push(client);
      }
    } else {
      deadClients.push(client);
    }
  });
  // Clean up dead clients
  deadClients.forEach(client => captionClients.delete(client));
}

/**
 * Serve the captions.html file
 */
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/captions.html');
});

/**
 * Serve static files (if needed)
 */
app.use(express.static(__dirname));

/**
 * Upgrade HTTP to WebSocket
 */
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;

  if (pathname === '/client') {
    wssClients.handleUpgrade(request, socket, head, (ws) => {
      wssClients.emit('connection', ws, request);
    });
  } else if (pathname === '/captions') {
    wssCaptions.handleUpgrade(request, socket, head, (ws) => {
      wssCaptions.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

/**
 * Handle browser client connections (mic input)
 */
wssClients.on('connection', (ws) => {
  console.log('✅ Browser client connected (mic input)');

  // Connect to Soniox if not already connected
  if (!sonioxWs || sonioxWs.readyState !== WebSocket.OPEN) {
    connectToSoniox();
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'audio') {
        // Forward audio data to Soniox with minimal delay
        if (sonioxWs && sonioxWs.readyState === WebSocket.OPEN && isSonioxConfigured) {
          // Convert array of Int16 values to binary Buffer (optimized)
          let audioData;
          try {
            if (data.format === 'base64') {
              audioData = Buffer.from(data.data, 'base64');
            } else if (data.format === 'array') {
              // Direct conversion for better performance
              audioData = Buffer.from(new Int16Array(data.data).buffer);
            } else {
              audioData = Buffer.from(new Int16Array(data.data).buffer);
            }
            
            // Only send if we have valid audio data
            if (audioData && audioData.length > 0) {
              sonioxWs.send(audioData, { binary: true });
              lastAudioSentTime = Date.now();
            }
          } catch (error) {
            // Log errors but don't spam
            if (Math.random() < 0.001) {
              console.error('❌ Error processing audio:', error.message);
            }
            // If connection issue, attempt reconnection
            if (error.code === 'ECONNRESET' || error.message.includes('not open')) {
              scheduleReconnect();
            }
          }
        } else if (!isSonioxConfigured && sonioxWs && sonioxWs.readyState === WebSocket.OPEN) {
          // Still waiting for configuration, queue is handled by Soniox
        } else if (!sonioxWs || sonioxWs.readyState !== WebSocket.OPEN) {
          // Connection lost, attempt reconnection
          if (!reconnectTimeout) {
            scheduleReconnect();
          }
        }
      } else if (data.type === 'config') {
        // Client requesting configuration
        ws.send(JSON.stringify({
          type: 'config',
          sampleRate: 16000,
          channels: 1,
          format: 'pcm_s16le'
        }));
      } else if (data.type === 'settings') {
        // Forward settings to all caption display clients
        console.log('📤 Forwarding settings to caption displays:', data.settings);
        captionClients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'settings',
              settings: data.settings
            }));
          }
        });
      } else if (data.type === 'clear') {
        // Clear captions on all display clients
        console.log('🧹 Clearing captions on all displays');
        captionClients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'clear' }));
          }
        });
      }
    } catch (error) {
      console.error('❌ Error processing client message:', error);
    }
  });

  ws.on('close', () => {
    console.log('🔌 Browser client disconnected');
  });

  ws.on('error', (error) => {
    console.error('❌ Browser client error:', error);
  });
});

/**
 * Handle caption display connections (captions.html)
 */
wssCaptions.on('connection', (ws) => {
  console.log('✅ Caption display connected');
  captionClients.add(ws);

  ws.on('close', () => {
    console.log('🔌 Caption display disconnected');
    captionClients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('❌ Caption display error:', error);
    captionClients.delete(ws);
  });
});

/**
 * Connect to Soniox WebSocket
 */
function connectToSoniox() {
  console.log('🔌 Connecting to Soniox...');

  sonioxWs = new WebSocket(SONIOX_WS_URL);

  sonioxWs.on('open', () => {
    console.log('✅ Connected to Soniox WebSocket');
    reconnectAttempts = 0;
    connectionStartTime = Date.now();
    
    // Send configuration immediately (no delay for minimal latency)
    if (sonioxWs.readyState === WebSocket.OPEN) {
      const config = {
        api_key: SONIOX_API_KEY,
        model: 'stt-rt-v3',
        language_hints: ['ml'], // Malayalam
        endpoint_detection: true,
        audio_format: 's16le',
        sample_rate: 16000,
        num_channels: 1,
        translation: {
          type: 'one_way',
          target_language: 'en' // English
        }
      };

      try {
        sonioxWs.send(JSON.stringify(config));
        isSonioxConfigured = false; // Wait for confirmation
        console.log('📤 Configuration sent to Soniox');
      } catch (error) {
        console.error('❌ Error sending configuration to Soniox:', error);
        // Retry connection on config error
        setTimeout(() => connectToSoniox(), 1000);
      }
    }
    
    // Start heartbeat to keep connection alive
    startHeartbeat();
  });

  sonioxWs.on('message', (data) => {
    try {
      // Soniox sends JSON messages
      const message = JSON.parse(data.toString());
      
      // Reduced logging for performance (only log errors and occasional status)
      if (!sonioxWs._messageCount) sonioxWs._messageCount = 0;
      sonioxWs._messageCount++;
      
      // Only log first message and occasional status updates
      if (sonioxWs._messageCount === 1) {
        console.log('📥 First message from Soniox received');
      } else if (sonioxWs._messageCount % 1000 === 0) {
        const uptime = connectionStartTime ? ((Date.now() - connectionStartTime) / 1000 / 60).toFixed(1) : 0;
        console.log(`📊 Processed ${sonioxWs._messageCount} messages (${uptime} min uptime)`);
      }
      
      // Check for errors
      if (message.error_code || message.error_message) {
        console.error('❌ Soniox error:', message.error_message || message.error_code);
        return;
      }

      // Check if configuration was successful (first non-error message)
      if (!isSonioxConfigured && message.tokens !== undefined) {
        isSonioxConfigured = true;
        console.log('✅ Soniox configuration confirmed');
      }

      // Process transcription results
      // Soniox sends tokens with translation_status: 'original' or 'translation'
      // Translation often comes in separate messages after original is finalized
      // For LIVE translation, we send both partial and final results
      if (message.tokens && Array.isArray(message.tokens) && message.tokens.length > 0) {
        // Separate original and translated tokens
        const originalTokens = message.tokens.filter(t => t.translation_status === 'original');
        const translatedTokens = message.tokens.filter(t => t.translation_status === 'translation' || t.translation_status === 'translated');
        
        // Combine ALL token texts (both partial and final) for live feel
        const originalText = originalTokens.map(t => t.text || '').join('').trim();
        const translatedText = translatedTokens.map(t => t.text || '').join('').trim();
        
        // Check if we have final results
        const finalOriginalTokens = originalTokens.filter(t => t.is_final === true);
        const finalTranslatedTokens = translatedTokens.filter(t => t.is_final === true);
        
        // Handle translation-only messages (translation comes separately)
        if (translatedTokens.length > 0 && originalTokens.length === 0) {
          // Send translated text (both partial and final for live feel)
          if (translatedText) {
            const isFinal = finalTranslatedTokens.length > 0 && finalTranslatedTokens.length === translatedTokens.length;
            console.log(isFinal ? '📝 Final' : '📝 Partial', 'translation caption:', translatedText);
            
            // Broadcast translated text (live updates) - optimized
            broadcastToCaptions(translatedText);
          }
          return; // Don't process further if this is translation-only
        }
        
        // Handle original tokens (with or without translation in same message)
        if (originalTokens.length > 0) {
          // If we have translated text, send it (prefer translated over original)
          if (translatedText) {
            const isFinal = finalTranslatedTokens.length > 0 && finalTranslatedTokens.length === translatedTokens.length;
            // Reduced logging for performance
            if (isFinal && Math.random() < 0.1) {
              console.log('📝 Final caption:', translatedText.substring(0, 50) + '...');
            }
            
            // Broadcast translated text (live updates) - optimized
            broadcastToCaptions(translatedText);
          } else if (originalText) {
            // No translation yet, but we have original - send it for live feel
            // (User will see Malayalam until translation arrives)
            const isFinal = finalOriginalTokens.length > 0 && finalOriginalTokens.length === originalTokens.length;
            console.log(isFinal ? '📝 Final' : '📝 Partial', 'original (waiting for translation):', originalText);
            
            // For now, we'll wait for translation (don't send original Malayalam)
            // Uncomment below if you want to show original while waiting for translation:
            // captionClients.forEach(client => {
            //   if (client.readyState === WebSocket.OPEN) {
            //     client.send(originalText);
            //   }
            // });
          }
        }
      }
    } catch (error) {
      console.error('❌ Error processing Soniox message:', error);
    }
  });

  sonioxWs.on('error', (error) => {
    console.error('❌ Soniox WebSocket error:', error);
  });

  sonioxWs.on('error', (error) => {
    console.error('❌ Soniox WebSocket error:', error.message || error);
    // Don't reconnect immediately on error, let close handler do it
  });

  sonioxWs.on('close', (code, reason) => {
    const sessionDuration = connectionStartTime ? ((Date.now() - connectionStartTime) / 1000 / 60).toFixed(1) : 0;
    console.log(`🔌 Soniox WebSocket closed: ${code} ${reason?.toString() || ''} (Session: ${sessionDuration} min)`);
    isSonioxConfigured = false;
    stopHeartbeat();
    
    // Only reconnect if not a normal closure (1000) or going away (1001)
    if (code !== 1000 && code !== 1001) {
      scheduleReconnect();
    }
  });
}

/**
 * Schedule reconnection with exponential backoff
 */
function scheduleReconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('❌ Max reconnection attempts reached');
    return;
  }
  
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts - 1), 30000); // Max 30s delay
  
  console.log(`🔄 Reconnecting to Soniox in ${(delay/1000).toFixed(1)}s (attempt ${reconnectAttempts})...`);
  
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    if (!sonioxWs || sonioxWs.readyState !== WebSocket.OPEN) {
      connectToSoniox();
    }
  }, delay);
}

/**
 * Start heartbeat to keep connection alive
 */
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (sonioxWs && sonioxWs.readyState === WebSocket.OPEN) {
      // Check if we've sent audio recently (within last 60 seconds)
      const timeSinceLastAudio = Date.now() - lastAudioSentTime;
      if (timeSinceLastAudio > 60000) {
        // No audio for 60s, send a ping to keep connection alive
        try {
          // Soniox doesn't support ping frames, but we can send empty audio or check connection
          // For now, just log connection health
          const uptime = connectionStartTime ? ((Date.now() - connectionStartTime) / 1000 / 60).toFixed(1) : 0;
          if (Math.random() < 0.1) { // Log 10% of heartbeats
            console.log(`💓 Connection healthy (${uptime} min uptime)`);
          }
        } catch (error) {
          console.error('❌ Heartbeat error:', error.message);
        }
      }
    } else {
      stopHeartbeat();
    }
  }, HEARTBEAT_INTERVAL);
}

/**
 * Stop heartbeat
 */
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Graceful shutdown handler
 */
function gracefulShutdown() {
  console.log('\n🛑 Shutting down gracefully...');
  
  // Close Soniox connection
  if (sonioxWs) {
    stopHeartbeat();
    sonioxWs.close();
  }
  
  // Close all client connections
  wssClients.clients.forEach(client => {
    client.close();
  });
  wssCaptions.clients.forEach(client => {
    client.close();
  });
  
  // Close server
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('⚠️ Forced shutdown');
    process.exit(1);
  }, 10000);
}

// Handle process signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  // Don't exit, log and continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit, log and continue
});

/**
 * Start server
 */
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on http://localhost:${PORT}`);
  console.log(`📡 Client endpoint: ws://localhost:${PORT}/client`);
  console.log(`📺 Caption endpoint: ws://localhost:${PORT}/captions`);
  console.log(`🌐 Open http://localhost:${PORT} in Resolume Browser Source`);
  console.log(`⏱️  Optimized for long-running sessions (3+ hours)`);
});

