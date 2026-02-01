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
const path = require('path');
const fs = require('fs');

// Load .env file from the same directory as this script
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ===== LOGGING SYSTEM =====
const LOG_FILE = path.join(__dirname, 'server.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// Caption history logging
const CAPTIONS_LOG_FILE = path.join(__dirname, 'captions.log');
const captionsStream = fs.createWriteStream(CAPTIONS_LOG_FILE, { flags: 'a' });
const captionHistory = []; // In-memory store for current session (for quick access)

// SSE clients for real-time streaming
const transcriptSSEClients = new Set();
const logsSSEClients = new Set();
const audienceSSEClients = new Set(); // Audience viewers (read-only)

// Save original console methods FIRST (before any function uses them)
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

/**
 * Enhanced logging function that logs to both console and file
 * @param {string} level - Log level (INFO, ERROR, WARN, DEBUG)
 * @param {string} message - Log message
 * @param {...any} args - Additional arguments
 */
function log(level, message, ...args) {
  const timestamp = new Date().toISOString();
  const formattedMessage = args.length > 0
    ? `${message} ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')}`
    : message;

  const logEntry = `[${timestamp}] [${level}] ${formattedMessage}\n`;

  // Write to file (check if stream is still writable)
  try {
    if (logStream && logStream.writable && !logStream.destroyed) {
      logStream.write(logEntry);
    }
  } catch (err) {
    // Stream might be closed, ignore during shutdown
    if (err.code !== 'ERR_STREAM_WRITE_AFTER_END') {
      originalConsoleError('Error writing to log stream:', err.message);
    }
  }

  // Broadcast to SSE clients
  logsSSEClients.forEach(client => {
    try {
      client.write(`data: ${JSON.stringify({ timestamp, level, message: formattedMessage })}\n\n`);
    } catch (err) {
      logsSSEClients.delete(client);
    }
  });

  // Also log to console using ORIGINAL methods (avoid infinite recursion)
  const consoleMsg = `${message}`;
  switch(level) {
    case 'ERROR':
      originalConsoleError(consoleMsg, ...args);
      break;
    case 'WARN':
      originalConsoleWarn(consoleMsg, ...args);
      break;
    default:
      originalConsoleLog(consoleMsg, ...args);
  }
}

// Convenience functions
const logger = {
  info: (msg, ...args) => log('INFO', msg, ...args),
  error: (msg, ...args) => log('ERROR', msg, ...args),
  warn: (msg, ...args) => log('WARN', msg, ...args),
  debug: (msg, ...args) => log('DEBUG', msg, ...args)
};

// Override console methods to capture all logs
console.log = function(...args) {
  log('INFO', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '));
};

console.error = function(...args) {
  log('ERROR', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '));
};

console.warn = function(...args) {
  log('WARN', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '));
};

/**
 * Log a caption to the caption history
 * @param {string} text - The caption text
 * @param {boolean} isFinal - Whether this is a final caption
 */
function logCaption(text, isFinal = true) {
  if (!text || !isFinal) return; // Only log final captions

  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    text,
    session: new Date().toISOString().split('T')[0] // Date as session ID
  };

  // Add to in-memory history (limit to last 1000 captions for quick access)
  captionHistory.push(entry);
  if (captionHistory.length > 1000) {
    captionHistory.shift();
  }

  // Write to file (append) - file grows indefinitely, no auto-clear
  // File is only cleared manually via /transcript/clear endpoint
  const logLine = `${timestamp}\t${text}\n`;
  try {
    if (captionsStream && captionsStream.writable && !captionsStream.destroyed) {
      captionsStream.write(logLine);
    }
  } catch (err) {
    // Stream might be closed, ignore during shutdown
    if (err.code !== 'ERR_STREAM_WRITE_AFTER_END') {
      originalConsoleError('Error writing to captions stream:', err.message);
    }
  }

  // Broadcast to SSE clients
  const sseData = JSON.stringify(entry);
  transcriptSSEClients.forEach(client => {
    try {
      client.write(`data: ${sseData}\n\n`);
    } catch (err) {
      transcriptSSEClients.delete(client);
    }
  });
}

logger.info('===== Server starting =====');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(express.json()); // Parse JSON request bodies

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
const DEFAULT_SONIOX_API_KEY = process.env.SONIOX_MASTER_API_KEY || '885a41baf0c85746228dd44ab442c3770e2c69f4f6f22bb7e3244de0d6d7899c';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

// YouTube Captions configuration (optional - only used if YOUTUBE_CAPTION_URL is set)
// Support both YOUTUBE_CAPTION_URL (singular) and YOUTUBE_CAPTIONS_URL (plural) for compatibility
const YOUTUBE_CAPTIONS_URL = process.env.YOUTUBE_CAPTION_URL || process.env.YOUTUBE_CAPTIONS_URL;
const YOUTUBE_CAPTIONS_LANGUAGE = process.env.LANGUAGE || 'en';

// ===== AUDIENCE SYSTEM =====
// Token system removed - using simple /audience endpoint
let audienceCaptionBuffer = []; // Last 6 captions for audience display (kept for backwards compat)
// No limit - show all captions to audience (scrollable)

// Service status tracking (for audience status display)
let serviceStatus = {
  status: 'offline',  // 'offline', 'connecting', 'ready', 'paused', 'ended'
  message: 'Service has not started yet',
  timestamp: new Date().toISOString()
};

// Soniox connection state management
let sonioxWs = null;
let isSonioxConfigured = false;
let sonioxConnectionState = 'disconnected'; // 'disconnected', 'connecting', 'connected', 'error'
let currentSonioxConfig = {
  apiKey: DEFAULT_SONIOX_API_KEY,
  sourceLanguage: 'ml', // Malayalam (default)
  targetLanguage: 'en'  // English (default)
};
let manualDisconnect = false; // Track if user manually disconnected
let captionClients = new Set(); // Connected caption display clients
let clientWebSockets = []; // Browser clients (mic input)
let reconnectAttempts = 0;
let reconnectTimeout = null;
let lastAudioSentTime = 0;
let connectionStartTime = 0;
const MAX_RECONNECT_ATTEMPTS = Infinity; // Allow infinite reconnects for long sessions
const RECONNECT_DELAY = 2000; // Start with 2s, will use exponential backoff
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
let heartbeatInterval = null;

/**
 * Format caption text for YouTube Live (YouTube-safe format)
 * YouTube Live caption best practice:
 * - ≤ 2 lines
 * - ≤ 32 chars per line
 * - UNIX newline
 */
function formatYouTubeCaption(text) {
  if (!text) return '';
  
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  const lines = [];
  let current = '';

  for (const word of words) {
    if (current.length + word.length + 1 <= 32) {
      current = current ? `${current} ${word}` : word;
    } else {
      if (current) {
        lines.push(current);
        current = word;
        if (lines.length === 2) {
          break; // Max 2 lines
        }
      }
    }
  }

  if (current && lines.length < 2) {
    lines.push(current);
  }

  return lines.join('\n');
}

/**
 * YouTube Caption Publisher
 * Sends captions to YouTube Live via POST request
 */
class YouTubeCaptionPublisher {
  constructor(postUrl, language) {
    this.postUrl = postUrl;
    this.language = language;
    this.enabled = !!postUrl;
    this.sequenceNumber = 0; // YouTube requires incremental sequence numbers
  }

  async publish(caption) {
    if (!this.enabled || !caption) {
      return;
    }

    const formattedCaption = formatYouTubeCaption(caption);
    if (!formattedCaption || !formattedCaption.trim()) {
      console.log('⚠️ Skipping empty caption');
      return;
    }

    // Always log when attempting to send to YouTube
    console.log(`📤 Sending caption to YouTube (seq: ${this.sequenceNumber + 1}):`, formattedCaption.replace(/\n/g, ' | ').substring(0, 80) + (formattedCaption.length > 80 ? '...' : ''));

    const startTime = Date.now();
    
    // Variables for error handling and retry
    let cleanedLines = [];
    let isMultiLine = false;
    let finalCaption = '';
    let timestamp = '';
    let urlWithParams = '';
    
    try {
      // Increment sequence number for YouTube (required for live captions)
      this.sequenceNumber++;
      
      // Build URL with sequence number and language as query parameters
      urlWithParams = `${this.postUrl}${this.postUrl.includes('?') ? '&' : '?'}seq=${this.sequenceNumber}&lang=${this.language}`;
      
      // Generate timestamp in UTC format: YYYY-MM-DDTHH:MM:SS.mmm
      const now = new Date();
      timestamp = now.toISOString().replace('Z', '').substring(0, 23); // Remove 'Z' and keep milliseconds
      
      // Clean caption text - YouTube expects clean text
      // Process line by line to ensure proper formatting
      const lines = formattedCaption.split('\n').filter(line => line.trim().length > 0);
      
      // Validate: YouTube requires max 2 lines
      if (lines.length > 2) {
        console.warn(`⚠️ Caption has ${lines.length} lines, truncating to 2`);
        lines.splice(2);
      }
      
      // Clean and validate each line
      cleanedLines = [];
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i]
          .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '') // Remove control chars (keep structure)
          .replace(/[ \t]+/g, ' ') // Collapse spaces/tabs
          .trim();
        
        // Validate line length (YouTube limit: 32 chars per line)
        if (line.length > 32) {
          console.warn(`⚠️ Line ${i + 1} exceeds 32 chars (${line.length}), truncating: "${line.substring(0, 35)}..."`);
          line = line.substring(0, 32);
        }
        
        if (line.length > 0) {
          cleanedLines.push(line);
        }
      }
      
      // Validate we have at least one line
      if (cleanedLines.length === 0) {
        console.warn('⚠️ Skipping empty caption after cleaning');
        return;
      }
      
      // Final caption - YouTube seems to reject multi-line format, so always use single-line
      // Join lines with space instead of newline to ensure compatibility
      finalCaption = cleanedLines.join(' ');
      isMultiLine = false; // Always treat as single-line for YouTube compatibility
      
      // If the single-line would be too long, truncate to 64 chars (YouTube's practical limit)
      if (finalCaption.length > 64) {
        console.warn(`⚠️ Caption exceeds 64 chars (${finalCaption.length}), truncating`);
        finalCaption = finalCaption.substring(0, 61) + '...';
      }
      
      // YouTube expects: timestamp\ncaption\n (with trailing newline)
      // For multi-line: timestamp\nline1\nline2\n
      // For single-line: timestamp\nline1\n
      const payload = `${timestamp}\n${finalCaption}\n`;
      const payloadBytes = Buffer.from(payload, 'utf-8');
      
      // Debug: Log exact payload bytes for troubleshooting (always log for multi-line, and on errors)
      if (isMultiLine) {
        console.log(`   🔍 Multi-line caption (${cleanedLines.length} lines):`);
        cleanedLines.forEach((line, idx) => {
          console.log(`      Line ${idx + 1}: "${line}" (${line.length} chars)`);
        });
        console.log(`   🔍 Final caption: ${JSON.stringify(finalCaption)}`);
        console.log(`   🔍 Payload structure: timestamp\\nline1\\nline2\\n`);
        console.log(`   🔍 Payload hex (first 120 bytes): ${payloadBytes.slice(0, 120).toString('hex')}`);
        console.log(`   🔍 Payload repr: ${JSON.stringify(payload.substring(0, 200))}`);
      }
      
      // Validate payload doesn't contain invalid characters
      if (payloadBytes.includes(0x00)) {
        console.error('❌ Payload contains null bytes, skipping');
        return;
      }
      
      // Validate timestamp format is correct (YYYY-MM-DDTHH:MM:SS.mmm)
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(timestamp)) {
        console.error(`❌ Invalid timestamp format: ${timestamp}`);
        return;
      }

      console.log(`   URL: ${urlWithParams}`);
      console.log(`   Timestamp: ${timestamp}`);
      console.log(`   Sequence: ${this.sequenceNumber}`);
      console.log(`   Payload length: ${payloadBytes.length} bytes`);
      console.log(`   Payload preview: ${payload.substring(0, 100).replace(/\n/g, '\\n')}...`);
      
      // Ensure payload is valid UTF-8 and doesn't have BOM or other issues
      try {
        // Verify it's valid UTF-8
        payloadBytes.toString('utf-8');
      } catch (e) {
        console.error('❌ Payload is not valid UTF-8, skipping');
        return;
      }
      
      // Send as Buffer to ensure raw bytes are sent (matching Python implementation)
      const response = await axios.post(
        urlWithParams,
        payloadBytes,
        {
          timeout: 10000, // 10 second timeout
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'User-Agent': 'Soniox-Streamer/1.0',
          },
          // Ensure axios sends raw bytes, not JSON
          transformRequest: [(data) => {
            // If it's a Buffer, return it as-is
            if (Buffer.isBuffer(data)) {
              return data;
            }
            return data;
          }],
        }
      );

      const duration = Date.now() - startTime;

      if (response.status === 200) {
        console.log(`✅ YouTube caption sent successfully (seq: ${this.sequenceNumber}, ${duration}ms)`);
        if (response.data) {
          const responseStr = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
          console.log(`   YouTube response: ${responseStr.substring(0, 100).replace(/\n/g, '\\n')}`);
        } else {
          console.log(`   YouTube response: (empty body)`);
        }
      } else {
        console.warn(`⚠️ YouTube caption POST returned status ${response.status}: ${response.statusText}`);
        if (response.data) {
          console.warn(`   Response body: ${JSON.stringify(response.data).substring(0, 200)}`);
        }
      }
      } catch (error) {
        // Always log errors (not just 10% of the time) so user knows what's happening
        const duration = Date.now() - startTime;
        
        // Enhanced error logging for debugging - use try-catch to ensure we can always log
        try {
          console.error(`❌ YouTube caption POST failed: ${error.response?.status || 'No response'} ${error.response?.statusText || error.message} (${duration}ms)`);
          console.error(`   Sequence: ${this.sequenceNumber}`);
          
          // Safely access variables that might not exist if error occurred early
          if (typeof timestamp !== 'undefined') {
            console.error(`   Timestamp: ${timestamp}`);
          }
          if (typeof cleanedLines !== 'undefined') {
            console.error(`   Caption lines: ${cleanedLines.length}`);
            if (typeof isMultiLine !== 'undefined' && isMultiLine) {
              console.error(`   🔴 MULTI-LINE CAPTION THAT FAILED:`);
              cleanedLines.forEach((line, idx) => {
                console.error(`      Line ${idx + 1}: "${line}" (${line.length} chars)`);
              });
              if (typeof finalCaption !== 'undefined') {
                console.error(`   Final caption: ${JSON.stringify(finalCaption)}`);
              }
            } else if (typeof finalCaption !== 'undefined') {
              console.error(`   Single-line caption: "${finalCaption}"`);
            }
          }
          if (typeof payloadBytes !== 'undefined') {
            console.error(`   Payload length: ${payloadBytes.length} bytes`);
            if (typeof payload !== 'undefined') {
              console.error(`   Payload preview: ${payload.substring(0, 150).replace(/\n/g, '\\n')}`);
              console.error(`   Payload hex: ${payloadBytes.slice(0, 100).toString('hex')}`);
            }
          }
        } catch (logError) {
          console.error(`   (Error logging details failed: ${logError.message})`);
        }
        
        if (error.response) {
          // Server responded with error status
          if (error.response.data) {
            const errorData = typeof error.response.data === 'string' 
              ? error.response.data 
              : JSON.stringify(error.response.data);
            console.error(`   Error response: ${errorData.substring(0, 300)}`);
            
            // If multi-line caption failed with "Can't parse", try as single-line
            if (error.response.status === 400 && 
                typeof errorData === 'string' && 
                errorData.includes("Can't parse") &&
                isMultiLine &&
                cleanedLines.length > 0) {
              console.warn(`   ⚠️ Multi-line caption failed, retrying as single-line...`);
              // Retry as single-line (join with space instead of newline)
              const singleLineCaption = cleanedLines.join(' ').substring(0, 64); // YouTube max is typically 64 chars for single line
              const retryPayload = `${timestamp}\n${singleLineCaption}\n`;
              const retryPayloadBytes = Buffer.from(retryPayload, 'utf-8');
              
              try {
                const retryResponse = await axios.post(
                  urlWithParams,
                  retryPayloadBytes,
                  {
                    timeout: 10000,
                    headers: {
                      'Content-Type': 'text/plain; charset=utf-8',
                      'User-Agent': 'Soniox-Streamer/1.0',
                    },
                    transformRequest: [(data) => {
                      if (Buffer.isBuffer(data)) return data;
                      return data;
                    }],
                  }
                );
                if (retryResponse.status === 200) {
                  console.log(`   ✅ Retry as single-line succeeded (seq: ${this.sequenceNumber})`);
                  return; // Success on retry
                }
              } catch (retryError) {
                console.error(`   ❌ Retry as single-line also failed: ${retryError.message}`);
              }
            }
          }
      } else if (error.request) {
        // Request was made but no response received
        console.error(`❌ YouTube caption POST failed: No response received (timeout or network error) (${duration}ms)`);
        console.error(`   URL: ${this.postUrl}`);
        console.error(`   Error code: ${error.code || 'N/A'}`);
      } else {
        // Error setting up the request
        console.error(`❌ YouTube caption POST error: ${error.message}`);
        console.error(`   Stack: ${error.stack?.substring(0, 200)}`);
      }
    }
  }
}

// Initialize YouTube Caption Publisher (only if URL is configured)
// Debug: Check if environment variable is loaded
if (process.env.YOUTUBE_CAPTION_URL || process.env.YOUTUBE_CAPTIONS_URL) {
  const url = process.env.YOUTUBE_CAPTION_URL || process.env.YOUTUBE_CAPTIONS_URL;
  console.log('📺 YouTube caption URL found in env:', url.substring(0, 50) + '...');
} else {
  console.log('📺 YouTube caption URL not found in process.env');
  console.log('📺 Available env vars with YOUTUBE:', Object.keys(process.env).filter(k => k.includes('YOUTUBE') || k.includes('youtube')));
}

// YouTube publisher - can be updated dynamically from client settings
let youtubePublisher = new YouTubeCaptionPublisher(YOUTUBE_CAPTIONS_URL, YOUTUBE_CAPTIONS_LANGUAGE);
if (youtubePublisher.enabled) {
  console.log('📺 YouTube captions enabled:', YOUTUBE_CAPTIONS_URL.substring(0, 50) + '...');
} else {
  console.log('📺 YouTube captions disabled (YOUTUBE_CAPTION_URL or YOUTUBE_CAPTIONS_URL not set)');
  console.log('📺 Tip: You can set YouTube URL in the settings panel');
}

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
 * Broadcast caption to audience viewers via SSE
 * Maintains a buffer of last N captions for new connections
 */
function broadcastToAudience(text, isFinal = false) {
  if (!text) return;
  
  // Only add final captions to audience buffer
  if (isFinal) {
    const timestamp = new Date().toISOString();
    const caption = { text, timestamp, type: 'caption' };
    
    // Add to buffer (no limit - show all captions)
    audienceCaptionBuffer.push(caption);
    
    // Broadcast to all connected audience viewers
    const data = JSON.stringify(caption);
    audienceSSEClients.forEach(client => {
      try {
        client.write(`data: ${data}\n\n`);
      } catch (error) {
        // Client disconnected, will be cleaned up on close event
      }
    });
  }
}

/**
 * Broadcast service status to audience viewers
 * Shows pre-service, live, paused, ended states
 */
function broadcastServiceStatus(status, message) {
  serviceStatus = {
    type: 'status',
    status: status,  // 'offline', 'connecting', 'ready', 'paused', 'ended'
    message: message,
    timestamp: new Date().toISOString()
  };
  
  const data = JSON.stringify(serviceStatus);
  audienceSSEClients.forEach(client => {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (error) {
      // Client disconnected
    }
  });
  
  console.log(`📢 Service status broadcast: ${status} - ${message}`);
}

/**
 * Serve the audience.html file as default homepage
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'audience.html'));
});

/**
 * Serve the client.html file (admin panel)
 */
app.get('/client', (req, res) => {
  res.sendFile(path.join(__dirname, 'client.html'));
});

/**
 * Serve the captions.html file
 */
app.get('/captions', (req, res) => {
  res.sendFile(__dirname + '/captions.html');
});

/**
 * View logs endpoint - displays server logs in browser
 */
app.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 500; // Default to last 500 lines
  const level = req.query.level; // Optional filter by level (INFO, ERROR, WARN, DEBUG)

  fs.readFile(LOG_FILE, 'utf8', (err, data) => {
    if (err) {
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Server Logs - Error</title>
            <style>
              body { font-family: monospace; background: #1e1e1e; color: #d4d4d4; padding: 20px; }
              .error { color: #f48771; }
            </style>
          </head>
          <body>
            <h1>Error Reading Logs</h1>
            <p class="error">${err.message}</p>
            <p>Log file may not exist yet. Start the server to generate logs.</p>
          </body>
        </html>
      `);
    }

    let lines = data.split('\n').filter(line => line.trim());

    // Filter by log level if specified
    if (level) {
      lines = lines.filter(line => line.includes(`[${level.toUpperCase()}]`));
    }

    // Get last N lines
    const displayLines = lines.slice(-limit);

    // Color code the logs
    const coloredLogs = displayLines.map(line => {
      if (line.includes('[ERROR]')) {
        return `<div class="log-line error">${escapeHtml(line)}</div>`;
      } else if (line.includes('[WARN]')) {
        return `<div class="log-line warn">${escapeHtml(line)}</div>`;
      } else if (line.includes('[DEBUG]')) {
        return `<div class="log-line debug">${escapeHtml(line)}</div>`;
      } else {
        return `<div class="log-line info">${escapeHtml(line)}</div>`;
      }
    }).join('');

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Server Logs</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              font-family: 'Courier New', monospace;
              background: #1e1e1e;
              color: #d4d4d4;
              padding: 20px;
              font-size: 13px;
              line-height: 1.4;
            }
            .header {
              position: sticky;
              top: 0;
              background: #2d2d30;
              padding: 15px;
              margin: -20px -20px 20px -20px;
              border-bottom: 2px solid #3e3e42;
              z-index: 100;
            }
            h1 {
              color: #4ec9b0;
              margin-bottom: 10px;
              font-size: 20px;
            }
            .controls {
              display: flex;
              gap: 10px;
              flex-wrap: wrap;
              align-items: center;
            }
            .controls label {
              color: #9cdcfe;
              font-size: 12px;
            }
            .controls select, .controls input {
              background: #3c3c3c;
              color: #d4d4d4;
              border: 1px solid #555;
              padding: 5px 10px;
              border-radius: 3px;
              font-family: inherit;
              font-size: 12px;
            }
            .controls button {
              background: #0e639c;
              color: white;
              border: none;
              padding: 6px 12px;
              border-radius: 3px;
              cursor: pointer;
              font-family: inherit;
              font-size: 12px;
            }
            .controls button:hover {
              background: #1177bb;
            }
            .stats {
              color: #858585;
              margin-top: 10px;
              font-size: 11px;
            }
            .logs-container {
              background: #252526;
              border: 1px solid #3e3e42;
              border-radius: 4px;
              padding: 15px;
              overflow-x: auto;
            }
            .log-line {
              padding: 2px 0;
              white-space: pre-wrap;
              word-break: break-all;
            }
            .log-line.error { color: #f48771; }
            .log-line.warn { color: #dcdcaa; }
            .log-line.info { color: #d4d4d4; }
            .log-line.debug { color: #858585; }
            .no-logs {
              color: #858585;
              text-align: center;
              padding: 40px;
              font-style: italic;
            }
            @media (max-width: 768px) {
              body { padding: 10px; font-size: 11px; }
              .header { margin: -10px -10px 10px -10px; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>📊 Server Logs</h1>
            <div class="controls">
              <label>
                Filter:
                <select id="levelFilter" onchange="updateFilter()">
                  <option value="">All Levels</option>
                  <option value="INFO" ${level === 'INFO' ? 'selected' : ''}>INFO</option>
                  <option value="ERROR" ${level === 'ERROR' ? 'selected' : ''}>ERROR</option>
                  <option value="WARN" ${level === 'WARN' ? 'selected' : ''}>WARN</option>
                  <option value="DEBUG" ${level === 'DEBUG' ? 'selected' : ''}>DEBUG</option>
                </select>
              </label>
              <label>
                Lines:
                <input type="number" id="limitInput" value="${limit}" min="10" max="10000" step="50" onchange="updateFilter()">
              </label>
              <button onclick="location.reload()">🔄 Refresh</button>
              <button onclick="scrollToBottom()">⬇️ Bottom</button>
              <button onclick="clearLogs()">🗑️ Clear File</button>
              <span id="liveIndicator" style="color: #4ec9b0; font-size: 11px; margin-left: 10px;">🟢 Live</span>
            </div>
            <div class="stats">
              Showing ${displayLines.length.toLocaleString()} of ${lines.length.toLocaleString()} lines
              ${level ? `(filtered by ${level})` : ''}
            </div>
          </div>
          <div class="logs-container" id="logsContainer">
            ${displayLines.length > 0 ? coloredLogs : '<div class="no-logs">No logs yet. Logs will appear here as the server runs.</div>'}
          </div>
          <script>
            function updateFilter() {
              const level = document.getElementById('levelFilter').value;
              const limit = document.getElementById('limitInput').value;
              const url = new URL(window.location.href);
              if (level) url.searchParams.set('level', level);
              else url.searchParams.delete('level');
              url.searchParams.set('limit', limit);
              window.location.href = url.toString();
            }

            function scrollToBottom() {
              window.scrollTo(0, document.body.scrollHeight);
            }

            function clearLogs() {
              if (confirm('Are you sure you want to clear all logs? This cannot be undone.')) {
                fetch('/logs/clear', { method: 'POST' })
                  .then(res => res.json())
                  .then(data => {
                    alert(data.message);
                    location.reload();
                  })
                  .catch(err => alert('Error clearing logs: ' + err.message));
              }
            }

            // Auto-scroll to bottom on load
            setTimeout(scrollToBottom, 100);

            // Real-time log streaming via SSE
            const eventSource = new EventSource('/logs/stream');
            const container = document.getElementById('logsContainer');
            const liveIndicator = document.getElementById('liveIndicator');

            eventSource.onmessage = function(event) {
              const log = JSON.parse(event.data);

              // Create log line
              const logDiv = document.createElement('div');
              logDiv.className = 'log-line';

              if (log.level === 'ERROR') {
                logDiv.classList.add('error');
              } else if (log.level === 'WARN') {
                logDiv.classList.add('warn');
              } else if (log.level === 'DEBUG') {
                logDiv.classList.add('debug');
              } else {
                logDiv.classList.add('info');
              }

              const logText = \`[\${log.timestamp}] [\${log.level}] \${log.message}\`;
              logDiv.textContent = logText;

              // Check if we should filter this log
              const levelFilter = new URLSearchParams(window.location.search).get('level');
              if (!levelFilter || log.level === levelFilter) {
                container.appendChild(logDiv);

                // Auto-scroll if near bottom
                const scrolledToBottom = (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 100;
                if (scrolledToBottom) {
                  scrollToBottom();
                }
              }
            };

            eventSource.onerror = function(err) {
              console.error('SSE Error:', err);
              liveIndicator.textContent = '🔴 Disconnected';
              liveIndicator.style.color = '#c5534b';
              // Reconnection is automatic
            };

            eventSource.onopen = function() {
              liveIndicator.textContent = '🟢 Live';
              liveIndicator.style.color = '#4ec9b0';
            };
          </script>
        </body>
      </html>
    `;

    res.send(html);
  });
});

/**
 * Clear logs endpoint
 */
app.post('/logs/clear', (req, res) => {
  fs.writeFile(LOG_FILE, '', (err) => {
    if (err) {
      logger.error('Failed to clear logs:', err.message);
      return res.status(500).json({ error: 'Failed to clear logs', message: err.message });
    }
    logger.info('Logs cleared by user');
    res.json({ message: 'Logs cleared successfully' });
  });
});

/**
 * Transcript/Caption History endpoint - view and export all captions
 */
app.get('/transcript', (req, res) => {
  const format = req.query.format || 'html'; // html, txt, csv, json, srt
  // Default limit: 0 means show ALL captions (no limit)
  // Set ?limit=N to show only last N captions
  const limit = req.query.limit ? parseInt(req.query.limit) : 0;

  // Read from file for complete history
  fs.readFile(CAPTIONS_LOG_FILE, 'utf8', (err, data) => {
    if (err && err.code !== 'ENOENT') {
      return res.status(500).json({ error: 'Failed to read captions', message: err.message });
    }

    let captions = [];

    // Parse file data
    if (data) {
      const lines = data.split('\n').filter(line => line.trim());
      captions = lines.map(line => {
        const parts = line.split('\t');
        return {
          timestamp: parts[0],
          text: parts.slice(1).join('\t') // Handle text with tabs
        };
      });
    }

    // Get captions to display (all if limit is 0, otherwise last N)
    const displayCaptions = limit > 0 ? captions.slice(-limit) : captions;
    
    // Get time offset from query parameter (if provided from frontend)
    const timeOffset = parseInt(req.query.offset) || 0;

    // Export formats
    if (format === 'json') {
      // Apply time offset to timestamps if provided
      const exportCaptions = timeOffset !== 0 
        ? displayCaptions.map(c => ({
            timestamp: new Date(new Date(c.timestamp).getTime() + timeOffset).toISOString(),
            originalTimestamp: c.timestamp,
            text: c.text
          }))
        : displayCaptions;
      return res.json({ 
        captions: exportCaptions, 
        total: captions.length,
        timeOffset: timeOffset !== 0 ? timeOffset : undefined
      });
    }

    if (format === 'csv') {
      const includeTimestamp = req.query.timestamp !== 'false';
      let csv;
      if (includeTimestamp) {
        csv = 'Timestamp,Caption\n' + displayCaptions.map(c => {
          const timestamp = timeOffset !== 0 
            ? new Date(new Date(c.timestamp).getTime() + timeOffset).toISOString()
            : c.timestamp;
          return `"${timestamp}","${c.text.replace(/"/g, '""')}"`;
        }).join('\n');
      } else {
        csv = 'Caption\n' + displayCaptions.map(c =>
          `"${c.text.replace(/"/g, '""')}"`
        ).join('\n');
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="captions-${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(csv);
    }

    if (format === 'txt') {
      const includeTimestamp = req.query.timestamp !== 'false';
      let txt;
      if (includeTimestamp) {
        txt = displayCaptions.map(c => {
          const date = timeOffset !== 0
            ? new Date(new Date(c.timestamp).getTime() + timeOffset)
            : new Date(c.timestamp);
          return `[${date.toLocaleString()}] ${c.text}`;
        }).join('\n\n');
      } else {
        txt = displayCaptions.map(c => c.text).join('\n\n');
      }
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="transcript-${new Date().toISOString().split('T')[0]}.txt"`);
      return res.send(txt);
    }

    if (format === 'srt') {
      // SRT (SubRip) subtitle format
      // Format: sequence number, timestamp range, caption text, blank line
      
      if (displayCaptions.length === 0) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="captions-${new Date().toISOString().split('T')[0]}.srt"`);
        return res.send('');
      }
      
      // Get time offset from query parameter (if provided from frontend)
      const timeOffset = parseInt(req.query.offset) || 0;
      
      // Helper function to convert milliseconds to SRT time format (HH:MM:SS,mmm)
      function toSRTTime(totalMs) {
        // Ensure non-negative
        totalMs = Math.max(0, totalMs);
        
        const hours = Math.floor(totalMs / 3600000);
        const minutes = Math.floor((totalMs % 3600000) / 60000);
        const seconds = Math.floor((totalMs % 60000) / 1000);
        const milliseconds = totalMs % 1000;
        
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
      }
      
      // Get first caption's adjusted timestamp
      const firstCaptionOriginalTime = new Date(displayCaptions[0].timestamp).getTime();
      const firstCaptionAdjustedTime = firstCaptionOriginalTime + timeOffset;
      
      // Parse the start time from the query parameter if provided (format: HH:MM:SS)
      // This is the relative start time the user set (e.g., "00:05:30")
      let startTimeMs = 0; // Default to 00:00:00
      if (req.query.startTime) {
        const timeParts = req.query.startTime.split(':');
        const hours = parseInt(timeParts[0]) || 0;
        const minutes = parseInt(timeParts[1]) || 0;
        const seconds = parseInt(timeParts[2]) || 0;
        startTimeMs = (hours * 3600000) + (minutes * 60000) + (seconds * 1000);
      }
      
      const defaultDuration = 3000; // 3 seconds in milliseconds
      const maxDuration = 8000; // Max 8 seconds per caption
      const minDuration = 1000; // Min 1 second per caption
      
      let srtContent = '';
      let sequenceNumber = 1;
      
      for (let i = 0; i < displayCaptions.length; i++) {
        const caption = displayCaptions[i];
        // Apply time offset to get adjusted timestamp
        const captionOriginalTime = new Date(caption.timestamp).getTime();
        const captionAdjustedTime = captionOriginalTime + timeOffset;
        
        // Calculate relative time from first caption (in milliseconds)
        const relativeStart = captionAdjustedTime - firstCaptionAdjustedTime;
        
        // Calculate end time
        let relativeEnd;
        if (i < displayCaptions.length - 1) {
          const nextOriginalTime = new Date(displayCaptions[i + 1].timestamp).getTime();
          const nextAdjustedTime = nextOriginalTime + timeOffset;
          const duration = Math.min(nextAdjustedTime - captionAdjustedTime, maxDuration);
          relativeEnd = relativeStart + Math.max(duration, minDuration);
        } else {
          // Last caption: use default duration
          relativeEnd = relativeStart + defaultDuration;
        }
        
        // Format SRT entry - start from the user's set start time, then add relative offset
        const startSRT = toSRTTime(startTimeMs + relativeStart);
        const endSRT = toSRTTime(startTimeMs + relativeEnd);
        
        // Clean caption text (remove control characters, preserve line breaks if needed)
        const cleanText = caption.text
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/\n{3,}/g, '\n\n'); // Max 2 consecutive newlines
        
        srtContent += `${sequenceNumber}\n`;
        srtContent += `${startSRT} --> ${endSRT}\n`;
        srtContent += `${cleanText}\n`;
        srtContent += `\n`; // Blank line between entries
        
        sequenceNumber++;
      }
      
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="captions-${new Date().toISOString().split('T')[0]}.srt"`);
      return res.send(srtContent);
    }

    // HTML view (default)
    const captionHTML = displayCaptions.length > 0
      ? displayCaptions.map((c, index) => {
          const time = new Date(c.timestamp).toLocaleTimeString();
          const date = new Date(c.timestamp).toLocaleDateString();
          return `
            <div class="caption-item" data-timestamp="${c.timestamp}" data-index="${index}">
              <div class="caption-header">
                <div class="caption-time">
                  <span class="date">${date}</span>
                  <span class="time">${time}</span>
                </div>
                <div class="caption-actions">
                  <button class="edit-btn" onclick="editCaption(this)" title="Edit caption">✏️</button>
                  <button class="replace-btn" onclick="replaceWithTongues(this)" title="Replace with (speaking in tongues)">🔄</button>
                  <button class="delete-btn" onclick="deleteCaption(this)" title="Delete caption">🗑️</button>
                </div>
              </div>
              <div class="caption-text" data-original="${escapeHtml(c.text).replace(/"/g, '&quot;')}" onclick="if(!this.closest('.caption-item').classList.contains('editing')) editCaption(this.closest('.caption-item').querySelector('.edit-btn'))" style="cursor: pointer;" title="Click to edit">${escapeHtml(c.text)}</div>
            </div>
          `;
        }).join('')
      : '<div class="no-captions">No captions yet. Captions will appear here as they are spoken.</div>';

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Caption Transcript</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              font-family: 'Courier New', monospace;
              background: #1e1e1e;
              color: #d4d4d4;
              padding: 20px;
              font-size: 13px;
              line-height: 1.4;
            }
            .header {
              position: sticky;
              top: 0;
              background: #2d2d30;
              padding: 15px;
              margin: -20px -20px 20px -20px;
              border-bottom: 2px solid #3e3e42;
              z-index: 100;
            }
            h1 {
              color: #4ec9b0;
              margin-bottom: 10px;
              font-size: 20px;
            }
            .controls {
              display: flex;
              gap: 10px;
              flex-wrap: wrap;
              align-items: center;
            }
            .controls button, .controls a {
              background: #0e639c;
              color: white;
              border: none;
              padding: 6px 12px;
              border-radius: 3px;
              cursor: pointer;
              text-decoration: none;
              font-family: inherit;
              font-size: 12px;
            }
            .controls button:hover, .controls a:hover {
              background: #1177bb;
            }
            .controls .danger {
              background: #c5534b;
            }
            .controls .danger:hover {
              background: #d16b64;
            }
            .stats {
              color: #858585;
              margin-top: 10px;
              font-size: 11px;
            }
            .time-adjustment {
              margin-top: 10px;
              padding: 10px;
              background: #1e1e1e;
              border: 1px solid #3e3e42;
              border-radius: 3px;
              display: flex;
              align-items: center;
              gap: 10px;
              flex-wrap: wrap;
            }
            .time-adjustment label {
              color: #9cdcfe;
              font-size: 12px;
              font-weight: 600;
            }
            .time-adjustment input {
              background: #3c3c3c;
              color: #d4d4d4;
              border: 1px solid #555;
              padding: 5px 10px;
              border-radius: 3px;
              font-family: inherit;
              font-size: 12px;
            }
            .time-adjustment button {
              background: #0e639c;
              color: white;
              border: none;
              padding: 5px 12px;
              border-radius: 3px;
              cursor: pointer;
              font-size: 11px;
              font-weight: 600;
            }
            .time-adjustment button:hover {
              background: #1177bb;
            }
            .time-adjustment button.reset {
              background: #c5534b;
            }
            .time-adjustment button.reset:hover {
              background: #d16b64;
            }
            .time-offset-indicator {
              color: #dcdcaa;
              font-size: 11px;
              font-weight: 600;
              display: none;
            }
            .time-offset-indicator.active {
              display: inline;
            }
            .content {
              background: #252526;
              border: 1px solid #3e3e42;
              border-radius: 4px;
              padding: 15px;
              max-width: 100%;
            }
            .caption-item {
              padding: 12px;
              border-left: 3px solid #4ec9b0;
              margin-bottom: 12px;
              background: #2d2d30;
              border-radius: 3px;
              transition: all 0.2s;
              position: relative;
            }
            .caption-item:hover {
              background: #333337;
              border-left-color: #5fd4c3;
            }
            .caption-item.editing {
              border-left-color: #dcdcaa;
              background: #3a3a3d;
            }
            .caption-item.edited {
              border-left-color: #dcdcaa;
            }
            .caption-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 6px;
            }
            .caption-time {
              color: #858585;
              font-size: 11px;
              font-weight: 500;
            }
            .caption-time .date {
              margin-right: 8px;
              color: #6a6a6a;
            }
            .caption-time .time {
              color: #9cdcfe;
              font-weight: 600;
            }
            .caption-actions {
              display: flex;
              gap: 6px;
            }
            .edit-btn, .replace-btn, .delete-btn {
              background: transparent;
              border: 1px solid transparent;
              color: #858585;
              cursor: pointer;
              padding: 4px 8px;
              border-radius: 3px;
              font-size: 12px;
              opacity: 0;
              transition: all 0.2s;
            }
            .caption-item:hover .edit-btn,
            .caption-item:hover .replace-btn,
            .caption-item:hover .delete-btn {
              opacity: 1;
            }
            .edit-btn:hover {
              background: #3e3e42;
              border-color: #4ec9b0;
              color: #4ec9b0;
            }
            .replace-btn:hover {
              background: #3e3e42;
              border-color: #dcdcaa;
              color: #dcdcaa;
            }
            .delete-btn:hover {
              background: #3e3e42;
              border-color: #f44336;
              color: #f44336;
            }
            .caption-text {
              color: #d4d4d4;
              font-size: 14px;
              line-height: 1.6;
              min-height: 20px;
              cursor: pointer;
              word-wrap: break-word;
              word-break: normal;
              max-width: 100%;
            }
            .caption-text:hover {
              background: rgba(78, 201, 176, 0.1);
              border-radius: 3px;
            }
            .caption-text[contenteditable="true"] {
              background: #1e1e1e;
              padding: 8px;
              border: 1px solid #4ec9b0;
              border-radius: 3px;
              outline: none;
              cursor: text;
            }
            .caption-text[contenteditable="true"]:focus {
              border-color: #5fd4c3;
              box-shadow: 0 0 0 2px rgba(78, 201, 176, 0.2);
            }
            .edit-actions {
              display: flex;
              gap: 8px;
              margin-top: 8px;
              justify-content: flex-end;
            }
            .edit-actions button {
              padding: 6px 12px;
              border: none;
              border-radius: 3px;
              cursor: pointer;
              font-size: 12px;
              font-family: inherit;
              transition: all 0.2s;
            }
            .save-btn {
              background: #4ec9b0;
              color: #1e1e1e;
              font-weight: 600;
            }
            .save-btn:hover {
              background: #5fd4c3;
            }
            .cancel-btn {
              background: #3e3e42;
              color: #d4d4d4;
            }
            .cancel-btn:hover {
              background: #4a4a4f;
            }
            .edited-indicator {
              display: inline-block;
              margin-left: 8px;
              color: #dcdcaa;
              font-size: 10px;
              font-weight: 600;
            }
            .no-captions {
              color: #858585;
              text-align: center;
              padding: 60px 20px;
              font-style: italic;
              font-size: 13px;
            }
            @media (max-width: 768px) {
              body { padding: 10px; font-size: 11px; }
              .header { margin: -10px -10px 10px -10px; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>📝 Caption Transcript</h1>
            <div class="controls">
              <select id="exportFormat" style="background: #3c3c3c; color: #d4d4d4; border: 1px solid #555; padding: 5px 10px; border-radius: 3px; font-family: inherit; font-size: 12px;">
                <option value="">📥 Export...</option>
                <option value="txt-with">TXT (with timestamps)</option>
                <option value="txt-without">TXT (no timestamps)</option>
                <option value="csv-with">CSV (with timestamps)</option>
                <option value="csv-without">CSV (no timestamps)</option>
                <option value="json">JSON</option>
                <option value="srt">SRT (SubRip subtitles)</option>
              </select>
              <button onclick="location.reload()">🔄 Refresh</button>
              <button onclick="scrollToBottom()">⬇️ Latest</button>
              <button class="danger" onclick="clearCaptions()">🗑️ Clear All</button>
            </div>
            <div class="stats">
              Showing ${displayCaptions.length.toLocaleString()} of ${captions.length.toLocaleString()} captions
              ${limit > 0 ? `(limited to last ${limit})` : '(showing all)'}
              ${captions.length > 10000 ? '<br><span style="color: #dcdcaa;">⚠️ Large file detected. Consider using ?limit=N to view recent captions only.</span>' : ''}
              <span class="time-offset-indicator" id="timeOffsetIndicator"></span>
            </div>
            <div class="time-adjustment">
              <label for="startTime">⏰ Adjust Start Time:</label>
              <input type="time" id="startTime" step="1" title="Set start time in 24-hour format (e.g., 00:00:00 for video start, 01:23:45 for 1h 23m 45s into video)" placeholder="HH:MM:SS">
              <button onclick="applyTimeOffset()">Apply</button>
              <button class="reset" onclick="resetTimeOffset()">Reset to Actual</button>
              <span style="font-size: 11px; color: #858585; margin-left: 10px;">
                💡 Use 24-hour format (00:00:00 to 23:59:59) - perfect for video timecodes
              </span>
            </div>
          </div>
          <div class="content" id="captionsContainer">
            ${captionHTML}
          </div>
          <script>
            // Time adjustment state
            let timeOffsetMs = parseInt(localStorage.getItem('transcriptTimeOffset')) || 0;
            let startTimeValue = localStorage.getItem('transcriptStartTime') || ''; // Store the start time string (e.g., "00:05:30")
            let firstCaptionTimestamp = null;

            // Smart autoscroll state
            let isUserScrolling = false;
            let autoScrollEnabled = true;
            let scrollTimeout;

            // Initialize time offset on load
            function initTimeOffset() {
              // Get first caption timestamp
              const firstCaption = document.querySelector('.caption-item');
              if (firstCaption) {
                firstCaptionTimestamp = firstCaption.getAttribute('data-timestamp');
                
                // Load start time from localStorage if available
                const savedStartTime = localStorage.getItem('transcriptStartTime');
                if (savedStartTime) {
                  startTimeValue = savedStartTime;
                  document.getElementById('startTime').value = savedStartTime;
                }
                
                // If offset exists, apply it and update indicator
                if (timeOffsetMs !== 0) {
                  updateTimeOffsetIndicator();
                  applyStoredOffset();
                }
              }
            }

            // Apply time offset
            function applyTimeOffset() {
              const startTimeInput = document.getElementById('startTime').value;
              if (!startTimeInput) {
                alert('Please select a start time');
                return;
              }

              if (!firstCaptionTimestamp) {
                alert('No captions available');
                return;
              }

              // Parse the input time (HH:MM:SS)
              const [hours, minutes, seconds] = startTimeInput.split(':').map(Number);
              
              // Create target time using today's date
              const targetDate = new Date();
              targetDate.setHours(hours, minutes, seconds || 0, 0);
              const targetMs = targetDate.getTime();

              // Get first caption's actual timestamp
              const firstCaptionDate = new Date(firstCaptionTimestamp);
              const firstCaptionMs = firstCaptionDate.getTime();

              // Calculate offset
              timeOffsetMs = targetMs - firstCaptionMs;

              // Save to localStorage
              localStorage.setItem('transcriptTimeOffset', timeOffsetMs);
              localStorage.setItem('transcriptStartTime', startTimeInput); // Store the start time string

              // Store start time value
              startTimeValue = startTimeInput;

              // Apply to all captions
              applyOffsetToAllCaptions();
              updateTimeOffsetIndicator();
            }

            // Reset time offset
            function resetTimeOffset() {
              timeOffsetMs = 0;
              startTimeValue = '';
              localStorage.removeItem('transcriptTimeOffset');
              localStorage.removeItem('transcriptStartTime');
              document.getElementById('startTime').value = '';
              
              // Restore all original times
              const captions = document.querySelectorAll('.caption-item');
              captions.forEach(caption => {
                const originalTimestamp = caption.getAttribute('data-timestamp');
                if (originalTimestamp) {
                  const date = new Date(originalTimestamp);
                  const timeSpan = caption.querySelector('.caption-time .time');
                  const dateSpan = caption.querySelector('.caption-time .date');
                  if (timeSpan) timeSpan.textContent = date.toLocaleTimeString();
                  if (dateSpan) dateSpan.textContent = date.toLocaleDateString();
                }
              });

              // Hide indicator
              const indicator = document.getElementById('timeOffsetIndicator');
              indicator.classList.remove('active');
              indicator.textContent = '';
            }

            // Apply offset to all captions
            function applyOffsetToAllCaptions() {
              const captions = document.querySelectorAll('.caption-item');
              captions.forEach(caption => {
                const originalTimestamp = caption.getAttribute('data-timestamp');
                if (originalTimestamp) {
                  const originalDate = new Date(originalTimestamp);
                  const adjustedDate = new Date(originalDate.getTime() + timeOffsetMs);
                  
                  const timeSpan = caption.querySelector('.caption-time .time');
                  const dateSpan = caption.querySelector('.caption-time .date');
                  if (timeSpan) timeSpan.textContent = adjustedDate.toLocaleTimeString();
                  if (dateSpan) dateSpan.textContent = adjustedDate.toLocaleDateString();
                }
              });
            }

            // Apply stored offset on page load
            function applyStoredOffset() {
              if (timeOffsetMs !== 0) {
                applyOffsetToAllCaptions();
              }
            }

            // Update time offset indicator
            function updateTimeOffsetIndicator() {
              const indicator = document.getElementById('timeOffsetIndicator');
              if (timeOffsetMs !== 0) {
                const offsetHours = Math.floor(Math.abs(timeOffsetMs) / 3600000);
                const offsetMinutes = Math.floor((Math.abs(timeOffsetMs) % 3600000) / 60000);
                const offsetSeconds = Math.floor((Math.abs(timeOffsetMs) % 60000) / 1000);
                const sign = timeOffsetMs >= 0 ? '+' : '-';
                
                let offsetStr = '';
                if (offsetHours > 0) offsetStr += \`\${offsetHours}h \`;
                if (offsetMinutes > 0) offsetStr += \`\${offsetMinutes}m \`;
                if (offsetSeconds > 0 || offsetStr === '') offsetStr += \`\${offsetSeconds}s\`;
                
                indicator.textContent = \` (Time adjusted: \${sign}\${offsetStr})\`;
                indicator.classList.add('active');
              } else {
                indicator.classList.remove('active');
                indicator.textContent = '';
              }
            }

            // Detect if user is at bottom of page
            function isAtBottom() {
              const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
              const windowHeight = window.innerHeight;
              const documentHeight = document.documentElement.scrollHeight;
              return (documentHeight - (scrollTop + windowHeight)) < 100; // Within 100px of bottom
            }

            // Smart scroll: only autoscroll if user is at bottom
            function smartScroll() {
              if (autoScrollEnabled && isAtBottom()) {
                window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
              }
            }

            // Track user scrolling
            window.addEventListener('scroll', () => {
              clearTimeout(scrollTimeout);
              
              // Check if user scrolled away from bottom
              if (!isAtBottom()) {
                autoScrollEnabled = false;
              } else {
                // User scrolled back to bottom, re-enable autoscroll
                autoScrollEnabled = true;
              }
              
              // Mark as user scrolling
              isUserScrolling = true;
              scrollTimeout = setTimeout(() => {
                isUserScrolling = false;
              }, 150);
            });

            // Handle export dropdown
            document.getElementById('exportFormat').addEventListener('change', function(e) {
              const value = e.target.value;
              if (!value) return;

              let url;
              switch(value) {
                case 'txt-with':
                  url = '/transcript?format=txt&timestamp=true';
                  if (timeOffsetMs !== 0) url += '&offset=' + timeOffsetMs;
                  break;
                case 'txt-without':
                  url = '/transcript?format=txt&timestamp=false';
                  break;
                case 'csv-with':
                  url = '/transcript?format=csv&timestamp=true';
                  if (timeOffsetMs !== 0) url += '&offset=' + timeOffsetMs;
                  break;
                case 'csv-without':
                  url = '/transcript?format=csv&timestamp=false';
                  break;
                case 'json':
                  url = '/transcript?format=json';
                  if (timeOffsetMs !== 0) url += '&offset=' + timeOffsetMs;
                  break;
                case 'srt':
                  url = '/transcript?format=srt';
                  // Include time offset if set
                  if (timeOffsetMs !== 0) {
                    url += '&offset=' + timeOffsetMs;
                  }
                  // Include start time if set (for SRT base time)
                  if (startTimeValue) {
                    url += '&startTime=' + encodeURIComponent(startTimeValue);
                  }
                  break;
              }

              if (url) {
                window.location.href = url;
              }

              // Reset dropdown
              setTimeout(() => e.target.value = '', 100);
            });

            function scrollToBottom() {
              autoScrollEnabled = true;
              window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            }

            function clearCaptions() {
              if (confirm('Are you sure you want to clear all captions? This will delete the entire caption history and cannot be undone.')) {
                fetch('/transcript/clear', { method: 'POST' })
                  .then(res => res.json())
                  .then(data => {
                    alert(data.message);
                    location.reload();
                  })
                  .catch(err => alert('Error clearing captions: ' + err.message));
              }
            }

            // Inline editing functionality
            function editCaption(button) {
              const captionItem = button.closest('.caption-item');
              const captionText = captionItem.querySelector('.caption-text');
              const originalText = captionText.getAttribute('data-original');
              
              // Don't allow multiple edits at once
              if (document.querySelector('.caption-item.editing')) {
                alert('Please finish editing the current caption first.');
                return;
              }
              
              captionItem.classList.add('editing');
              captionText.contentEditable = true;
              captionText.focus();
              
              // Select all text
              const range = document.createRange();
              range.selectNodeContents(captionText);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              
              // Create action buttons
              const actionsDiv = document.createElement('div');
              actionsDiv.className = 'edit-actions';
              actionsDiv.innerHTML = \`
                <button class="cancel-btn" onclick="cancelEdit(this)">❌ Cancel</button>
                <button class="save-btn" onclick="saveEdit(this)">💾 Save</button>
              \`;
              captionItem.appendChild(actionsDiv);
              
              // Add Enter key handler for instant save
              const enterHandler = (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  const saveBtn = actionsDiv.querySelector('.save-btn');
                  if (saveBtn) {
                    saveEdit(saveBtn);
                  }
                }
              };
              captionText.addEventListener('keydown', enterHandler);
              
              // Store handler for cleanup
              captionText._enterHandler = enterHandler;
              
              // Hide edit button
              button.style.display = 'none';
            }

            function cancelEdit(button) {
              const captionItem = button.closest('.caption-item');
              const captionText = captionItem.querySelector('.caption-text');
              const originalText = captionText.getAttribute('data-original');
              
              // Remove Enter key handler
              if (captionText._enterHandler) {
                captionText.removeEventListener('keydown', captionText._enterHandler);
                delete captionText._enterHandler;
              }
              
              // Restore original text (decode HTML entities)
              const textarea = document.createElement('textarea');
              textarea.innerHTML = originalText;
              captionText.textContent = textarea.value;
              
              captionText.contentEditable = false;
              captionItem.classList.remove('editing');
              
              // Remove action buttons
              captionItem.querySelector('.edit-actions').remove();
              
              // Show edit button again
              captionItem.querySelector('.edit-btn').style.display = '';
            }

            function replaceWithTongues(button) {
              const captionItem = button.closest('.caption-item');
              const timestamp = captionItem.getAttribute('data-timestamp');
              const newText = '(speaking in tongues)';
              
              // Store original text before replacing
              const captionText = captionItem.querySelector('.caption-text');
              const originalText = captionText.getAttribute('data-original');
              const currentText = captionText.textContent;
              
              // Replace text instantly
              captionText.textContent = newText;
              captionText.setAttribute('data-original', newText.replace(/"/g, '&quot;'));
              
              // Mark as edited
              captionItem.classList.add('edited');
              
              // Add edited indicator if not already present
              if (!captionItem.querySelector('.edited-indicator')) {
                const timeDiv = captionItem.querySelector('.caption-time');
                const indicator = document.createElement('span');
                indicator.className = 'edited-indicator';
                indicator.textContent = 'EDITED';
                indicator.title = 'This caption has been manually edited';
                timeDiv.appendChild(indicator);
              }
              
              // Send update to server immediately
              fetch('/transcript/edit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timestamp, newText })
              })
              .then(res => res.json())
              .then(data => {
                if (!data.success) {
                  console.error('Failed to save replacement:', data.error);
                  // Revert on error
                  if (originalText) {
                    const textarea = document.createElement('textarea');
                    textarea.innerHTML = originalText;
                    captionText.textContent = textarea.value;
                    captionText.setAttribute('data-original', originalText);
                  } else {
                    captionText.textContent = currentText;
                  }
                  captionItem.classList.remove('edited');
                  alert('Failed to save: ' + (data.error || 'Unknown error'));
                }
              })
              .catch(err => {
                console.error('Error saving replacement:', err);
                // Revert on error
                if (originalText) {
                  const textarea = document.createElement('textarea');
                  textarea.innerHTML = originalText;
                  captionText.textContent = textarea.value;
                  captionText.setAttribute('data-original', originalText);
                } else {
                  captionText.textContent = currentText;
                }
                captionItem.classList.remove('edited');
                alert('Error saving replacement: ' + err.message);
              });
            }

            function deleteCaption(button) {
              const captionItem = button.closest('.caption-item');
              const timestamp = captionItem.getAttribute('data-timestamp');
              
              // Delete immediately - no confirmation for live editing speed
              // Send delete request to server
              fetch('/transcript/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timestamp })
              })
              .then(response => response.json())
              .then(data => {
                if (data.success) {
                  // Remove from DOM with animation
                  captionItem.style.opacity = '0';
                  captionItem.style.transform = 'translateX(-20px)';
                  setTimeout(() => {
                    captionItem.remove();
                    // Update stats
                    updateStats();
                  }, 300);
                } else {
                  alert('Failed to delete caption: ' + (data.error || 'Unknown error'));
                }
              })
              .catch(error => {
                console.error('Error deleting caption:', error);
                alert('Failed to delete caption. Check console for details.');
              });
            }

            function saveEdit(button) {
              // Get caption item from button or find currently editing item
              const captionItem = button ? button.closest('.caption-item') : document.querySelector('.caption-item.editing');
              if (!captionItem) return;
              
              const captionText = captionItem.querySelector('.caption-text');
              const newText = captionText.textContent.trim();
              const timestamp = captionItem.getAttribute('data-timestamp');
              
              if (!newText) {
                alert('Caption cannot be empty');
                return;
              }
              
              // Remove Enter key handler
              if (captionText._enterHandler) {
                captionText.removeEventListener('keydown', captionText._enterHandler);
                delete captionText._enterHandler;
              }
              
              // Disable buttons during save
              if (button) {
                button.disabled = true;
                button.textContent = '⏳ Saving...';
              }
              
              // Send update to server
              fetch('/transcript/edit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timestamp, newText })
              })
              .then(res => res.json())
              .then(data => {
                if (data.success) {
                  // Update successful
                  captionText.contentEditable = false;
                  captionItem.classList.remove('editing');
                  captionItem.classList.add('edited');
                  
                  // Update data-original
                  captionText.setAttribute('data-original', newText.replace(/"/g, '&quot;'));
                  
                  // Add edited indicator if not already present
                  if (!captionItem.querySelector('.edited-indicator')) {
                    const timeDiv = captionItem.querySelector('.caption-time');
                    const indicator = document.createElement('span');
                    indicator.className = 'edited-indicator';
                    indicator.textContent = 'EDITED';
                    indicator.title = 'This caption has been manually edited';
                    timeDiv.appendChild(indicator);
                  }
                  
                  // Remove action buttons
                  captionItem.querySelector('.edit-actions').remove();
                  
                  // Show edit button again
                  captionItem.querySelector('.edit-btn').style.display = '';
                } else {
                  alert('Failed to save: ' + (data.error || 'Unknown error'));
                  if (button) {
                    button.disabled = false;
                    button.textContent = '💾 Save';
                  }
                }
              })
              .catch(err => {
                alert('Error saving caption: ' + err.message);
                if (button) {
                  button.disabled = false;
                  button.textContent = '💾 Save';
                }
              });
            }

            // Auto-scroll to bottom on load
            setTimeout(scrollToBottom, 100);

            // Real-time updates via Server-Sent Events
            const eventSource = new EventSource('/transcript/stream');

            eventSource.onmessage = function(event) {
              const caption = JSON.parse(event.data);
              const container = document.getElementById('captionsContainer');

              // Set first caption timestamp if not set
              if (!firstCaptionTimestamp) {
                firstCaptionTimestamp = caption.timestamp;
              }

              // Remove "no captions" message if present
              const noCaptions = container.querySelector('.no-captions');
              if (noCaptions) {
                noCaptions.remove();
              }

              // Apply time offset if set
              const originalDate = new Date(caption.timestamp);
              const adjustedDate = new Date(originalDate.getTime() + timeOffsetMs);
              const time = adjustedDate.toLocaleTimeString();
              const date = adjustedDate.toLocaleDateString();

              const captionDiv = document.createElement('div');
              captionDiv.className = 'caption-item';
              captionDiv.setAttribute('data-timestamp', caption.timestamp); // Store original timestamp
              captionDiv.innerHTML = \`
                <div class="caption-header">
                  <div class="caption-time">
                    <span class="date">\${date}</span>
                    <span class="time">\${time}</span>
                  </div>
                  <div class="caption-actions">
                    <button class="edit-btn" onclick="editCaption(this)" title="Edit caption">✏️</button>
                    <button class="replace-btn" onclick="replaceWithTongues(this)" title="Replace with (speaking in tongues)">🔄</button>
                    <button class="delete-btn" onclick="deleteCaption(this)" title="Delete caption">🗑️</button>
                  </div>
                </div>
                <div class="caption-text" data-original="\${caption.text.replace(/"/g, '&quot;')}" onclick="if(!this.closest('.caption-item').classList.contains('editing')) editCaption(this.closest('.caption-item').querySelector('.edit-btn'))" style="cursor: pointer;" title="Click to edit">\${caption.text}</div>
              \`;

              container.appendChild(captionDiv);

              // Smart auto-scroll to new caption (only if user is at bottom)
              smartScroll();

              // Update stats
              const stats = document.querySelector('.stats');
              const match = stats.textContent.match(/Showing ([\\d,]+) of ([\\d,]+)/);
              if (match) {
                const newTotal = parseInt(match[2].replace(/,/g, '')) + 1;
                const newShowing = parseInt(match[1].replace(/,/g, '')) + 1;
                stats.textContent = \`Showing \${newShowing.toLocaleString()} of \${newTotal.toLocaleString()} captions\`;
              }
            };

            eventSource.onerror = function(err) {
              console.error('SSE Error:', err);
              // Reconnection is automatic
            };

            // Initialize time offset on page load
            window.addEventListener('DOMContentLoaded', initTimeOffset);
            // Also call immediately in case DOMContentLoaded already fired
            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', initTimeOffset);
            } else {
              initTimeOffset();
            }
          </script>
        </body>
      </html>
    `;

    res.send(html);
  });
});

/**
 * Clear captions endpoint
 */
app.post('/transcript/clear', (req, res) => {
  fs.writeFile(CAPTIONS_LOG_FILE, '', (err) => {
    if (err) {
      logger.error('Failed to clear captions:', err.message);
      return res.status(500).json({ error: 'Failed to clear captions', message: err.message });
    }
    // Also clear in-memory history
    captionHistory.length = 0;
    audienceCaptionBuffer = [];
    
    // Broadcast clear event to all audience viewers
    const clearEvent = JSON.stringify({ type: 'clear' });
    audienceSSEClients.forEach(client => {
      try {
        client.write(`data: ${clearEvent}\n\n`);
      } catch (error) {
        // Client disconnected
      }
    });
    
    logger.info('Captions cleared by user');
    console.log('🧹 Cleared captions from audience (transcript cleared)');
    res.json({ message: 'All captions cleared successfully' });
  });
});

/**
 * Edit caption endpoint
 */
app.post('/transcript/edit', (req, res) => {
  const { timestamp, newText } = req.body;
  
  if (!timestamp || !newText) {
    return res.status(400).json({ success: false, error: 'Missing timestamp or newText' });
  }
  
  // Read the captions file
  fs.readFile(CAPTIONS_LOG_FILE, 'utf8', (err, data) => {
    if (err) {
      logger.error('Failed to read captions for edit:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to read captions file' });
    }
    
    // Parse and update the caption
    const lines = data.split('\n').filter(line => line.trim());
    let updated = false;
    const updatedLines = lines.map(line => {
      const parts = line.split('\t');
      if (parts[0] === timestamp) {
        updated = true;
        logger.info(`Caption edited: "${parts.slice(1).join('\t')}" → "${newText}"`);
        return `${timestamp}\t${newText}`;
      }
      return line;
    });
    
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Caption not found' });
    }
    
    // Write back to file
    const newContent = updatedLines.join('\n') + '\n';
    fs.writeFile(CAPTIONS_LOG_FILE, newContent, 'utf8', (err) => {
      if (err) {
        logger.error('Failed to save edited caption:', err.message);
        return res.status(500).json({ success: false, error: 'Failed to save changes' });
      }
      
      // Update in-memory history if present
      const memoryEntry = captionHistory.find(c => c.timestamp === timestamp);
      if (memoryEntry) {
        memoryEntry.text = newText;
      }
      
      // Update audience buffer if this caption is in it
      const audienceEntry = audienceCaptionBuffer.find(c => c.timestamp === timestamp);
      if (audienceEntry) {
        audienceEntry.text = newText;
        
        // Broadcast edit to all audience viewers
        const editEvent = JSON.stringify({ 
          text: newText, 
          timestamp: timestamp,
          edited: true 
        });
        audienceSSEClients.forEach(client => {
          try {
            client.write(`data: ${editEvent}\n\n`);
          } catch (error) {
            // Client disconnected
          }
        });
      }
      
      res.json({ success: true, message: 'Caption updated successfully' });
    });
  });
});

/**
 * Delete a caption from the transcript
 */
app.post('/transcript/delete', (req, res) => {
  const { timestamp } = req.body;
  
  if (!timestamp) {
    return res.status(400).json({ success: false, error: 'Missing timestamp' });
  }
  
  // Read the captions file
  fs.readFile(CAPTIONS_LOG_FILE, 'utf8', (err, data) => {
    if (err) {
      logger.error('Failed to read captions for delete:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to read captions file' });
    }
    
    // Parse and remove the caption
    const lines = data.split('\n').filter(line => line.trim());
    let deleted = false;
    let deletedText = '';
    const updatedLines = lines.filter(line => {
      const parts = line.split('\t');
      if (parts[0] === timestamp) {
        deleted = true;
        deletedText = parts.slice(1).join('\t');
        logger.info(`Caption deleted: "${deletedText}" (${timestamp})`);
        return false; // Remove this line
      }
      return true; // Keep this line
    });
    
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Caption not found' });
    }
    
    // Write back to file
    const newContent = updatedLines.join('\n') + '\n';
    fs.writeFile(CAPTIONS_LOG_FILE, newContent, 'utf8', (err) => {
      if (err) {
        logger.error('Failed to save after caption delete:', err.message);
        return res.status(500).json({ success: false, error: 'Failed to save changes' });
      }
      
      // Remove from in-memory history if present
      const memoryIndex = captionHistory.findIndex(c => c.timestamp === timestamp);
      if (memoryIndex !== -1) {
        captionHistory.splice(memoryIndex, 1);
      }
      
      // Remove from audience buffer if present and broadcast deletion
      const audienceIndex = audienceCaptionBuffer.findIndex(c => c.timestamp === timestamp);
      if (audienceIndex !== -1) {
        audienceCaptionBuffer.splice(audienceIndex, 1);
        
        // Broadcast delete event to all audience viewers
        const deleteEvent = JSON.stringify({ 
          type: 'delete',
          timestamp: timestamp
        });
        audienceSSEClients.forEach(client => {
          try {
            client.write(`data: ${deleteEvent}\n\n`);
          } catch (error) {
            // Client disconnected
          }
        });
      }
      
      res.json({ success: true, message: 'Caption deleted successfully' });
    });
  });
});

/**
 * SSE endpoint for real-time transcript updates
 */
app.get('/transcript/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Add client to set
  transcriptSSEClients.add(res);

  // Send initial heartbeat
  res.write(': heartbeat\n\n');

  // Keep connection alive with periodic heartbeats
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  // Clean up on close
  req.on('close', () => {
    clearInterval(heartbeat);
    transcriptSSEClients.delete(res);
  });
});

/**
 * SSE endpoint for real-time log streaming
 */
app.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Add client to set
  logsSSEClients.add(res);

  // Send initial heartbeat
  res.write(': heartbeat\n\n');

  // Keep connection alive with periodic heartbeats
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  // Clean up on close
  req.on('close', () => {
    clearInterval(heartbeat);
    logsSSEClients.delete(res);
  });
});

// ===== AUDIENCE ENDPOINTS =====

/**
 * Audience page - public read-only caption viewer
 * Mobile-first design for church members
 * Access via: /audience (no token needed)
 */
app.get('/audience', (req, res) => {
  // Serve audience.html (public access)
  res.sendFile(path.join(__dirname, 'audience.html'));
});

/**
 * SSE endpoint for audience live caption stream
 * Sends last 6 captions to new connections, then streams updates
 */
app.get('/audience/stream', (req, res) => {
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Add client to set
  audienceSSEClients.add(res);
  
  console.log(`👥 Audience viewer connected (${audienceSSEClients.size} total)`);

  // Send initial service status
  res.write(`data: ${JSON.stringify(serviceStatus)}\n\n`);
  
  // Only send captions if service is live/ready (not offline, starting_soon, paused, or ended)
  const activeStatuses = ['ready', 'live'];
  if (activeStatuses.includes(serviceStatus.status)) {
    // Read last N captions from file (not memory buffer) to ensure sync with edits/deletes
    try {
      if (fs.existsSync(CAPTIONS_LOG_FILE)) {
        const data = fs.readFileSync(CAPTIONS_LOG_FILE, 'utf8');
        const lines = data.split('\n').filter(line => line.trim());
        
        // Get all captions from file (no limit - fully scrollable)
        const recentCaptions = lines.map(line => {
          const parts = line.split('\t');
          return {
            type: 'caption',
            timestamp: parts[0],
            text: parts.slice(1).join('\t')
          };
        });
        
        // Send recent captions to new viewer
        recentCaptions.forEach(caption => {
          res.write(`data: ${JSON.stringify(caption)}\n\n`);
        });
        
        // Also update memory buffer to match file (ensures consistency)
        audienceCaptionBuffer = recentCaptions;
      }
    } catch (error) {
      console.error('Error reading captions for audience:', error);
    }
  }
  
  // Send initial heartbeat
  res.write(': heartbeat\n\n');

  // Keep connection alive with periodic heartbeats
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (error) {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Clean up on close
  req.on('close', () => {
    clearInterval(heartbeat);
    audienceSSEClients.delete(res);
    console.log(`👥 Audience viewer disconnected (${audienceSSEClients.size} remaining)`);
  });
});

/**
 * Admin API: Get current audience URL
 * Returns simple /audience URL (no token needed)
 */
app.get('/api/audience-token', (req, res) => {
  const protocol = req.protocol;
  const host = req.get('host');
  const url = `${protocol}://${host}/audience`;
  
  res.json({
    url: url,
    activeViewers: audienceSSEClients.size,
    note: 'Token system removed - using simple /audience endpoint'
  });
});

/**
 * Admin API: Manually set audience status
 * Allows admin to control what message audience sees
 */
app.post('/api/audience-status', (req, res) => {
  const { status, message } = req.body;
  
  if (!status || !message) {
    return res.status(400).json({ success: false, error: 'Missing status or message' });
  }
  
  // Clear old captions when service is starting (fresh start for new service)
  if (status === 'starting_soon') {
    try {
      fs.writeFileSync(CAPTIONS_LOG_FILE, '', 'utf8');
      captionHistory.length = 0; // Clear in-memory history
      audienceCaptionBuffer = []; // Clear audience buffer
      
      // Broadcast clear event to all audience viewers
      const clearEvent = JSON.stringify({ type: 'clear' });
      audienceSSEClients.forEach(client => {
        try {
          client.write(`data: ${clearEvent}\n\n`);
        } catch (error) {
          // Client disconnected
        }
      });
      
      console.log('🧹 Cleared old captions for new service');
    } catch (error) {
      console.error('Failed to clear captions:', error);
    }
  }
  
  // Clear captions when service ends (not when paused)
  if (status === 'ended') {
    try {
      // Clear in-memory buffers
      captionHistory.length = 0;
      audienceCaptionBuffer = [];
      
      // Broadcast clear event to all audience viewers
      const clearEvent = JSON.stringify({ type: 'clear' });
      audienceSSEClients.forEach(client => {
        try {
          client.write(`data: ${clearEvent}\n\n`);
        } catch (error) {
          // Client disconnected
        }
      });
      
      console.log('🧹 Cleared captions from audience (service ended)');
    } catch (error) {
      console.error('Failed to clear captions:', error);
    }
  }
  
  // Update service status and broadcast to audience
  broadcastServiceStatus(status, message);
  
  console.log(`📢 Manual audience status set: ${status} - ${message}`);
  
  res.json({
    success: true,
    status: status,
    message: message
  });
});


/**
 * Serve static files (if needed)
 */
app.use(express.static(__dirname));

// Helper function to escape HTML
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

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

  // Don't auto-connect to Soniox - wait for user to start connection via UI
  // Send current connection status to the new client
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'soniox_status',
        status: sonioxConnectionState,
        message: sonioxConnectionState === 'connected' 
          ? `Connected: ${currentSonioxConfig.sourceLanguage} → ${currentSonioxConfig.targetLanguage}`
          : sonioxConnectionState === 'connecting'
          ? 'Connecting...'
          : 'Not connected'
      }));
    }
  }, 100);

  ws.on('message', (message) => {
    try {
      // Check if message is a string (JSON) or binary
      let data;
      if (typeof message === 'string') {
        try {
          data = JSON.parse(message);
        } catch (parseError) {
          console.warn('⚠️ Received non-JSON string message:', message.toString().substring(0, 100));
          return; // Skip non-JSON messages
        }
      } else if (Buffer.isBuffer(message)) {
        // Binary message - try to parse as UTF-8 string first (might be JSON)
        try {
          const messageStr = message.toString('utf8');
          data = JSON.parse(messageStr);
        } catch (parseError) {
          // If it's not JSON, it might be raw audio data
          // But we expect audio data to come as JSON with type: 'audio'
          // So this is unexpected - log once per 1000 messages to avoid spam
          if (Math.random() < 0.001) {
            console.warn('⚠️ Received binary message that is not JSON (might be raw audio):', message.length, 'bytes');
          }
          return; // Skip non-JSON binary messages
        }
      } else {
        // Try to convert to string and parse
        try {
          const messageStr = message.toString();
          data = JSON.parse(messageStr);
        } catch (parseError) {
          console.warn('⚠️ Received unknown message type that cannot be parsed:', typeof message);
          return;
        }
      }
      
      if (data.type === 'start_soniox') {
        // Client requesting to start Soniox connection
        const { apiKey, sourceLanguage, targetLanguage, youtubeCaptionUrl } = data;
        console.log(`🎬 Client requested to start Soniox connection: ${sourceLanguage} → ${targetLanguage}`);
        
        // Broadcast to audience that service is starting
        broadcastServiceStatus('connecting', 'Translation will begin when the talk starts only. Please note: Automated translation is approximately 95% accurate. Some errors may occur and captions may not be perfect.');
        
        // Validate inputs
        if (!apiKey || apiKey.trim().length === 0) {
          broadcastServiceStatus('offline', 'Translation will begin when the talk starts only. Please note: Automated translation is approximately 95% accurate. Some errors may occur and captions may not be perfect.');
          ws.send(JSON.stringify({
            type: 'soniox_status',
            status: 'error',
            message: 'API key is required'
          }));
          return;
        }
        
        // Update YouTube publisher if URL provided
        if (youtubeCaptionUrl && youtubeCaptionUrl.trim().length > 0) {
          youtubePublisher = new YouTubeCaptionPublisher(youtubeCaptionUrl.trim(), YOUTUBE_CAPTIONS_LANGUAGE);
          console.log('📺 YouTube captions URL updated from client settings');
          if (youtubePublisher.enabled) {
            console.log('📺 YouTube captions enabled:', youtubeCaptionUrl.substring(0, 50) + '...');
          }
        } else {
          // Disable YouTube captions if URL is empty
          youtubePublisher = new YouTubeCaptionPublisher(null, YOUTUBE_CAPTIONS_LANGUAGE);
          console.log('📺 YouTube captions disabled (no URL provided)');
        }
        
        // Close existing connection if any (properly clean up first)
        if (sonioxWs) {
          console.log('ℹ️ Closing existing Soniox connection to start new one');
          shutdownSonioxConnection();
          // Wait for proper cleanup before reconnecting
          setTimeout(() => {
            connectToSoniox(apiKey, sourceLanguage, targetLanguage);
          }, 300);
        } else {
          // No existing connection, start immediately
          connectToSoniox(apiKey, sourceLanguage, targetLanguage);
        }
      } else if (data.type === 'stop_soniox') {
        // Client requesting to stop Soniox connection
        console.log('🛑 Client requested to stop Soniox connection');
        broadcastServiceStatus('ended', 'Service has ended');
        shutdownSonioxConnection();
      } else if (data.type === 'get_soniox_status') {
        // Client requesting current Soniox status
        ws.send(JSON.stringify({
          type: 'soniox_status',
          status: sonioxConnectionState,
          message: sonioxConnectionState === 'connected' 
            ? `Connected: ${currentSonioxConfig.sourceLanguage} → ${currentSonioxConfig.targetLanguage}`
            : sonioxConnectionState === 'connecting'
            ? 'Connecting...'
            : 'Not connected'
        }));
      } else if (data.type === 'audio') {
        // Forward audio data to Soniox with minimal delay
        // Allow audio to be sent as long as connection is open, even if config not yet confirmed
        // Soniox can buffer audio while waiting for configuration
        if (sonioxWs && sonioxWs.readyState === WebSocket.OPEN) {
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
              
              // Log occasionally for debugging (every ~100 chunks)
              if (Math.random() < 0.01) {
                console.log(`📤 Sending audio chunk: ${audioData.length} bytes (configured: ${isSonioxConfigured})`);
              }
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
        } else if (!sonioxWs || sonioxWs.readyState !== WebSocket.OPEN) {
          // Connection lost, log once
          if (Math.random() < 0.001) {
            console.warn('⚠️ Cannot send audio - Soniox not connected');
          }
          // Attempt reconnection (only if not manual disconnect)
          if (!manualDisconnect && !reconnectTimeout) {
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
      // Better error logging
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      const errorStack = error?.stack || '';
      console.error('❌ Error processing client message:', errorMessage);
      if (errorStack && errorStack.length < 500) {
        console.error('   Stack:', errorStack);
      }
      // Log the raw message if it's not too large
      try {
        const messageStr = message.toString();
        if (messageStr.length < 200) {
          console.error('   Raw message:', messageStr.substring(0, 200));
        } else {
          console.error('   Message type:', typeof message, 'length:', messageStr.length);
        }
      } catch (e) {
        // Ignore errors in error logging
      }
    }
  });

  ws.on('close', () => {
    console.log('🔌 Browser client disconnected');
    // Remove from client list
    const index = clientWebSockets.indexOf(ws);
    if (index > -1) {
      clientWebSockets.splice(index, 1);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ Browser client error:', error);
    // Remove from client list on error
    const index = clientWebSockets.indexOf(ws);
    if (index > -1) {
      clientWebSockets.splice(index, 1);
    }
  });

  // Add to client list
  clientWebSockets.push(ws);
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
 * Broadcast Soniox connection status to all connected clients
 */
function broadcastSonioxStatus(status, message = '') {
  const statusMessage = JSON.stringify({
    type: 'soniox_status',
    status: status, // 'connecting', 'connected', 'disconnected', 'error'
    message: message
  });

  console.log(`📢 Broadcasting Soniox status: ${status} to ${clientWebSockets.length} client(s)`);

  // Broadcast to all browser clients
  let sentCount = 0;
  clientWebSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(statusMessage);
        sentCount++;
      } catch (err) {
        console.error('❌ Error broadcasting status to client:', err.message);
      }
    }
  });
  
  if (sentCount === 0 && clientWebSockets.length > 0) {
    console.warn('⚠️ No clients received status update (all clients may be disconnected)');
  }
}

/**
 * Gracefully shutdown Soniox connection
 */
function shutdownSonioxConnection() {
  console.log('🛑 Shutting down Soniox connection gracefully...');
  
  // Set flags FIRST to prevent any race conditions
  manualDisconnect = true; // Mark as manual disconnect to prevent auto-reconnect
  isReconnecting = false; // Reset reconnecting flag
  isSonioxConfigured = false; // Reset config flag
  sonioxConnectionState = 'disconnected';
  
  // Broadcast disconnected status immediately (before closing)
  broadcastSonioxStatus('disconnected', 'Connection stopped');
  
  // Stop heartbeat
  stopHeartbeat();
  
  // Clear reconnect timeout if any
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  // Close WebSocket connection
  if (sonioxWs) {
    try {
      // Close with normal closure code
      if (sonioxWs.readyState === WebSocket.OPEN || sonioxWs.readyState === WebSocket.CONNECTING) {
        sonioxWs.close(1000, 'Manual disconnect');
      }
    } catch (error) {
      console.error('❌ Error closing Soniox WebSocket:', error);
    }
    // Clear the reference immediately
    sonioxWs = null;
  }
  
  console.log('✅ Soniox connection shut down successfully');
}

/**
 * Connect to Soniox WebSocket with configurable settings
 */
function connectToSoniox(apiKey, sourceLanguage, targetLanguage) {
  // Use provided settings or fall back to current config
  const config = {
    apiKey: apiKey || currentSonioxConfig.apiKey,
    sourceLanguage: sourceLanguage || currentSonioxConfig.sourceLanguage,
    targetLanguage: targetLanguage || currentSonioxConfig.targetLanguage
  };
  
  // Update current config
  currentSonioxConfig = config;
  
  // Validate API key
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    console.error('❌ Cannot connect: No API key provided');
    sonioxConnectionState = 'error';
    broadcastSonioxStatus('error', 'No API key provided');
    return;
  }
  
  console.log('🔌 Connecting to Soniox...');
  console.log(`   API Key: ${config.apiKey.substring(0, 10)}... (${config.apiKey.length} chars)`);
  console.log(`   Source Language: ${config.sourceLanguage}`);
  console.log(`   Target Language: ${config.targetLanguage}`);
  
  manualDisconnect = false; // Reset manual disconnect flag
  sonioxConnectionState = 'connecting';
  broadcastSonioxStatus('connecting', 'Establishing connection...');

  // Add connection timeout (30 seconds)
  let connectionTimeout = setTimeout(() => {
    if (sonioxWs && sonioxWs.readyState !== WebSocket.OPEN) {
      console.error('❌ Soniox connection timeout after 30 seconds');
      sonioxConnectionState = 'error';
      broadcastSonioxStatus('error', 'Connection timeout - check API key and network');
      if (sonioxWs) {
        try {
          sonioxWs.close();
        } catch (e) {
          // Ignore
        }
        sonioxWs = null;
      }
      // Don't auto-reconnect on timeout - let user retry
      manualDisconnect = true;
    }
  }, 30000);

  sonioxWs = new WebSocket(SONIOX_WS_URL);

  sonioxWs.on('open', () => {
    // Clear connection timeout
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      connectionTimeout = null;
    }
    
    console.log('✅ Connected to Soniox WebSocket');
    reconnectAttempts = 0;
    connectionStartTime = Date.now();
    
    // Send configuration immediately (no delay for minimal latency)
    if (sonioxWs.readyState === WebSocket.OPEN) {
      // Build Soniox configuration
      const sonioxConfig = {
        api_key: config.apiKey,
        model: 'stt-rt-v3',
        endpoint_detection: true,
        audio_format: 's16le',
        sample_rate: 16000,
        num_channels: 1
      };
      
      // Handle source language (auto-detect or specific language)
      if (config.sourceLanguage === 'auto') {
        // Auto-detect mode - don't specify language_hints
        console.log('🌐 Auto-detect mode: Soniox will detect language automatically');
      } else {
        // Specific language
        sonioxConfig.language_hints = [config.sourceLanguage];
      }
      
      // Add translation if source and target are different
      if (config.sourceLanguage !== config.targetLanguage && config.targetLanguage !== 'none') {
        sonioxConfig.translation = {
          type: 'one_way',
          target_language: config.targetLanguage
        };
        console.log(`🌍 Translation enabled: ${config.sourceLanguage} → ${config.targetLanguage}`);
      } else {
        console.log('📝 Translation disabled (same language or target is "none")');
      }

      try {
        sonioxWs.send(JSON.stringify(sonioxConfig));
        isSonioxConfigured = false; // Will be set true when we receive first tokens
        console.log('📤 Configuration sent to Soniox');
        console.log('📋 Config:', JSON.stringify(sonioxConfig, null, 2));
        
        // Mark as connected immediately - Soniox buffers audio while processing config
        // This ensures audio isn't dropped and UI shows correct status
        sonioxConnectionState = 'connected';
        broadcastSonioxStatus('connected', `Connected: ${config.sourceLanguage} → ${config.targetLanguage}`);
        console.log('✅ Soniox ready to receive audio');
      } catch (error) {
        console.error('❌ Error sending configuration to Soniox:', error);
        sonioxConnectionState = 'error';
        broadcastSonioxStatus('error', 'Failed to send configuration');
        // Retry connection on config error
        setTimeout(() => {
          if (!manualDisconnect) connectToSoniox(config.apiKey, config.sourceLanguage, config.targetLanguage);
        }, 1000);
        return;
      }
    }
    
    // Start heartbeat to keep connection alive
    startHeartbeat();
  });

  sonioxWs.on('message', (data) => {
    // Check if connection is still valid (might be closed during shutdown)
    if (!sonioxWs || sonioxWs.readyState !== WebSocket.OPEN) {
      return; // Ignore messages after connection closed
    }
    
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
        console.log('✅ Soniox configuration confirmed - receiving transcriptions');
        // Broadcast to audience that service is now live
        broadcastServiceStatus('ready', 'Service is live - Translations appearing below');
      }

      // Process transcription results
      // Soniox sends tokens with translation_status: 'original' or 'translation'
      // When source = target (no translation), tokens may not have translation_status
      // Translation often comes in separate messages after original is finalized
      // For LIVE translation, we send both partial and final results
      if (message.tokens && Array.isArray(message.tokens) && message.tokens.length > 0) {
        // Log first tokens to verify we're receiving them (with details for debugging)
        if (sonioxWs._messageCount < 10) {
          console.log(`🔍 Received ${message.tokens.length} tokens from Soniox`);
          // Log token structure for first few messages to debug
          if (message.tokens.length > 0) {
            const sampleToken = message.tokens[0];
            const hasOriginal = message.tokens.some(t => !t.translation_status || t.translation_status === 'original');
            const hasTranslation = message.tokens.some(t => t.translation_status === 'translation' || t.translation_status === 'translated');
            console.log(`   Token analysis:`, {
              totalTokens: message.tokens.length,
              hasText: !!sampleToken.text,
              hasOriginalTokens: hasOriginal,
              hasTranslatedTokens: hasTranslation,
              sampleTranslationStatus: sampleToken.translation_status,
              sampleIsFinal: sampleToken.is_final
            });
          }
        } else if (Math.random() < 0.01) {
          console.log(`🔍 Received ${message.tokens.length} tokens from Soniox`);
        }
        
        // Check if translation is disabled (source = target)
        const isTranslationDisabled = currentSonioxConfig.sourceLanguage === currentSonioxConfig.targetLanguage || 
                                     currentSonioxConfig.targetLanguage === 'none';
        
        // Separate original and translated tokens
        // When source = target, tokens may not have translation_status - treat ALL tokens as original
        let originalTokens, translatedTokens;
        if (isTranslationDisabled) {
          // No translation - all tokens are "original" text
          originalTokens = message.tokens.filter(t => t.text); // Only tokens with text
          translatedTokens = []; // No translations
        } else {
          // Translation enabled - filter by translation_status
          originalTokens = message.tokens.filter(t => 
            !t.translation_status || 
            t.translation_status === 'original'
          );
          translatedTokens = message.tokens.filter(t => 
            t.translation_status === 'translation' || 
            t.translation_status === 'translated'
          );
        }
        
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
            // Log first few translations to debug startup delay
            if (sonioxWs._messageCount < 10 || isFinal) {
              console.log(`📝 ${isFinal ? 'Final' : 'Partial'} translation caption:`, translatedText);
            }
            
            // Broadcast translated text immediately (live updates) - don't wait for final
            broadcastToCaptions(translatedText);
            
            // Send to YouTube and audience (only final results)
            if (isFinal) {
              logCaption(translatedText, true); // Log final caption to history
              broadcastToAudience(translatedText, true); // Send to audience viewers
              youtubePublisher.publish(translatedText).catch(err => {
                // Error already logged in publish method
              });
            }
          }
          return; // Don't process further if this is translation-only
        }
        
        // Handle original tokens (with or without translation in same message)
        if (originalTokens.length > 0) {
          // If we have translated text, send it (prefer translated over original)
          if (translatedText) {
            const isFinal = finalTranslatedTokens.length > 0 && finalTranslatedTokens.length === translatedTokens.length;
            // Log first few translations to debug startup delay
            if (sonioxWs._messageCount < 10 || (isFinal && Math.random() < 0.1)) {
              console.log(`📝 ${isFinal ? 'Final' : 'Partial'} caption:`, translatedText.substring(0, 50) + (translatedText.length > 50 ? '...' : ''));
            }
            
            // Broadcast translated text immediately (live updates) - don't wait for final
            broadcastToCaptions(translatedText);
            
            // Send to YouTube and audience (only final results)
            if (isFinal) {
              logCaption(translatedText, true); // Log final caption to history
              broadcastToAudience(translatedText, true); // Send to audience viewers
              youtubePublisher.publish(translatedText).catch(err => {
                // Error already logged in publish method
              });
            }
          } else if (originalText) {
            // No translation - send original text
            // If translation is disabled (source = target), always send original
            // Otherwise, we wait for translation (don't send original source language)
            const isFinal = finalOriginalTokens.length > 0 && finalOriginalTokens.length === originalTokens.length;
            
            if (isTranslationDisabled) {
              // Translation disabled - send original text immediately
              if (isFinal) {
                console.log('📝 Final caption (no translation):', originalText);
              }
              
              // Broadcast original text (live updates)
              broadcastToCaptions(originalText);
              
              // Log and send to YouTube and audience (only final results)
              if (isFinal) {
                logCaption(originalText, true);
                broadcastToAudience(originalText, true); // Send to audience viewers
                youtubePublisher.publish(originalText).catch(err => {
                  // Error already logged in publish method
                });
              }
            } else {
              // Translation enabled - wait for translation
              // Only log final results to reduce log spam (partial results are too frequent)
              if (isFinal) {
                console.log('📝 Final original (waiting for translation):', originalText);
              }
              
              // For now, we'll wait for translation (don't send original source language)
              // Uncomment below if you want to show original while waiting for translation:
              // captionClients.forEach(client => {
              //   if (client.readyState === WebSocket.OPEN) {
              //     client.send(originalText);
              //   }
              // });
            }
          }
        }
      }
    } catch (error) {
      // Only log if connection is still open (avoid errors during shutdown)
      if (sonioxWs && sonioxWs.readyState === WebSocket.OPEN) {
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        console.error('❌ Error processing Soniox message:', errorMessage);
        if (error?.stack && error.stack.length < 500) {
          console.error('   Stack:', error.stack);
        }
      }
      // Silently ignore errors during shutdown
    }
  });

  sonioxWs.on('error', (error) => {
    // Clear connection timeout
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      connectionTimeout = null;
    }
    
    const errorMessage = error?.message || error?.toString() || 'Unknown error';
    console.error('❌ Soniox WebSocket error:', errorMessage);
    if (error?.code) {
      console.error('   Error code:', error.code);
    }
    if (error?.stack && error.stack.length < 500) {
      console.error('   Stack:', error.stack);
    }
    // Update connection state
    sonioxConnectionState = 'error';
    broadcastSonioxStatus('error', `Connection error: ${errorMessage}`);
    // Don't reconnect immediately on error, let close handler do it
  });

  sonioxWs.on('close', (code, reason) => {
    // Clear connection timeout
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      connectionTimeout = null;
    }
    
    const sessionDuration = connectionStartTime ? ((Date.now() - connectionStartTime) / 1000 / 60).toFixed(1) : 0;
    console.log(`🔌 Soniox WebSocket closed: ${code} ${reason?.toString() || ''} (Session: ${sessionDuration} min)`);
    isSonioxConfigured = false;
    stopHeartbeat();
    
    // Update connection state
    if (manualDisconnect) {
      sonioxConnectionState = 'disconnected';
      broadcastSonioxStatus('disconnected', 'Connection stopped by user');
      broadcastServiceStatus('offline', 'Service has ended');
    } else {
      sonioxConnectionState = 'disconnected';
      const reasonStr = reason?.toString() || 'Unknown reason';
      broadcastSonioxStatus('disconnected', `Connection closed: ${reasonStr} (code: ${code})`);
      broadcastServiceStatus('offline', 'Translation will begin when the talk starts only. Please note: Automated translation is approximately 95% accurate. Some errors may occur and captions may not be perfect.');
    }
    
    // Only reconnect if not a normal closure (1000) or going away (1001), and not a manual disconnect
    if (code !== 1000 && code !== 1001 && !manualDisconnect) {
      scheduleReconnect();
    } else if (manualDisconnect) {
      console.log('ℹ️ Manual disconnect - not reconnecting');
    }
  });
}

// Update scheduleReconnect to respect manual disconnect
let isReconnecting = false; // Prevent multiple simultaneous reconnect attempts

function scheduleReconnect() {
  if (manualDisconnect) {
    // Only log once per shutdown to avoid spam
    if (!isReconnecting) {
      console.log('ℹ️ Manual disconnect active - skipping reconnect');
      isReconnecting = true; // Set flag to prevent repeated logs
    }
    return;
  }
  
  // Prevent multiple simultaneous reconnect attempts
  if (isReconnecting && reconnectTimeout) {
    return; // Already reconnecting
  }
  
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('❌ Max reconnection attempts reached');
    sonioxConnectionState = 'error';
    broadcastSonioxStatus('error', 'Max reconnection attempts reached');
    isReconnecting = false;
    return;
  }
  
  isReconnecting = true;
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts - 1), 30000); // Max 30s delay
  
  console.log(`🔄 Reconnecting to Soniox in ${(delay/1000).toFixed(1)}s (attempt ${reconnectAttempts})...`);
  sonioxConnectionState = 'connecting';
  broadcastSonioxStatus('connecting', `Reconnecting... (attempt ${reconnectAttempts})`);
  
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    isReconnecting = false;
    if (!manualDisconnect && (!sonioxWs || sonioxWs.readyState !== WebSocket.OPEN)) {
      connectToSoniox(currentSonioxConfig.apiKey, currentSonioxConfig.sourceLanguage, currentSonioxConfig.targetLanguage);
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

  // Close log streams
  logStream.end(() => {
    console.log('📝 Log file closed');
  });
  captionsStream.end(() => {
    console.log('📝 Captions file closed');
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
  console.log(`📊 Server logs: http://localhost:${PORT}/logs`);
  console.log(`📝 Caption transcript: http://localhost:${PORT}/transcript`);
  console.log(`👥 Audience viewer: http://localhost:${PORT}/audience`);
  console.log(`⏱️  Optimized for long-running sessions (3+ hours)`);
});

