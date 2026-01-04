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

  // Write to file
  logStream.write(logEntry);

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
  captionsStream.write(logLine);

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

// YouTube Captions configuration (optional - only used if YOUTUBE_CAPTION_URL is set)
// Support both YOUTUBE_CAPTION_URL (singular) and YOUTUBE_CAPTIONS_URL (plural) for compatibility
const YOUTUBE_CAPTIONS_URL = process.env.YOUTUBE_CAPTION_URL || process.env.YOUTUBE_CAPTIONS_URL;
const YOUTUBE_CAPTIONS_LANGUAGE = process.env.LANGUAGE || 'en';

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

const youtubePublisher = new YouTubeCaptionPublisher(YOUTUBE_CAPTIONS_URL, YOUTUBE_CAPTIONS_LANGUAGE);
if (youtubePublisher.enabled) {
  console.log('📺 YouTube captions enabled:', YOUTUBE_CAPTIONS_URL.substring(0, 50) + '...');
} else {
  console.log('📺 YouTube captions disabled (YOUTUBE_CAPTION_URL or YOUTUBE_CAPTIONS_URL not set)');
  console.log('📺 Tip: Make sure .env file is in the same directory as ws-server.js');
  console.log('📺 Tip: Restart the server after adding/editing .env file');
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
 * Serve the captions.html file
 */
app.get('/', (req, res) => {
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

    // Export formats
    if (format === 'json') {
      return res.json({ captions: displayCaptions, total: captions.length });
    }

    if (format === 'csv') {
      const includeTimestamp = req.query.timestamp !== 'false';
      let csv;
      if (includeTimestamp) {
        csv = 'Timestamp,Caption\n' + displayCaptions.map(c =>
          `"${c.timestamp}","${c.text.replace(/"/g, '""')}"`
        ).join('\n');
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
        txt = displayCaptions.map(c =>
          `[${new Date(c.timestamp).toLocaleString()}] ${c.text}`
        ).join('\n\n');
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
      
      // Helper function to convert milliseconds to SRT time format (HH:MM:SS,mmm)
      function toSRTTime(totalMs) {
        const hours = Math.floor(totalMs / 3600000);
        const minutes = Math.floor((totalMs % 3600000) / 60000);
        const seconds = Math.floor((totalMs % 60000) / 1000);
        const milliseconds = totalMs % 1000;
        
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
      }
      
      // Calculate relative times from first caption (SRT standard)
      const firstCaptionTime = new Date(displayCaptions[0].timestamp).getTime();
      const defaultDuration = 3000; // 3 seconds in milliseconds
      const maxDuration = 8000; // Max 8 seconds per caption
      const minDuration = 1000; // Min 1 second per caption
      
      let srtContent = '';
      let sequenceNumber = 1;
      
      for (let i = 0; i < displayCaptions.length; i++) {
        const caption = displayCaptions[i];
        const currentTime = new Date(caption.timestamp).getTime();
        const relativeStart = currentTime - firstCaptionTime;
        
        // Calculate end time
        let relativeEnd;
        if (i < displayCaptions.length - 1) {
          const nextTime = new Date(displayCaptions[i + 1].timestamp).getTime();
          const duration = Math.min(nextTime - currentTime, maxDuration);
          relativeEnd = relativeStart + Math.max(duration, minDuration);
        } else {
          // Last caption: use default duration
          relativeEnd = relativeStart + defaultDuration;
        }
        
        // Format SRT entry
        const startSRT = toSRTTime(relativeStart);
        const endSRT = toSRTTime(relativeEnd);
        
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
      ? displayCaptions.map(c => {
          const time = new Date(c.timestamp).toLocaleTimeString();
          const date = new Date(c.timestamp).toLocaleDateString();
          return `
            <div class="caption-item">
              <div class="caption-time">
                <span class="date">${date}</span>
                <span class="time">${time}</span>
              </div>
              <div class="caption-text">${escapeHtml(c.text)}</div>
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
            .content {
              background: #252526;
              border: 1px solid #3e3e42;
              border-radius: 4px;
              padding: 15px;
            }
            .caption-item {
              padding: 12px;
              border-left: 3px solid #4ec9b0;
              margin-bottom: 12px;
              background: #2d2d30;
              border-radius: 3px;
              transition: all 0.2s;
            }
            .caption-item:hover {
              background: #333337;
              border-left-color: #5fd4c3;
            }
            .caption-time {
              color: #858585;
              font-size: 11px;
              margin-bottom: 6px;
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
            .caption-text {
              color: #d4d4d4;
              font-size: 14px;
              line-height: 1.6;
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
            </div>
          </div>
          <div class="content" id="captionsContainer">
            ${captionHTML}
          </div>
          <script>
            // Handle export dropdown
            document.getElementById('exportFormat').addEventListener('change', function(e) {
              const value = e.target.value;
              if (!value) return;

              let url;
              switch(value) {
                case 'txt-with':
                  url = '/transcript?format=txt&timestamp=true';
                  break;
                case 'txt-without':
                  url = '/transcript?format=txt&timestamp=false';
                  break;
                case 'csv-with':
                  url = '/transcript?format=csv&timestamp=true';
                  break;
                case 'csv-without':
                  url = '/transcript?format=csv&timestamp=false';
                  break;
                case 'json':
                  url = '/transcript?format=json';
                  break;
                case 'srt':
                  url = '/transcript?format=srt';
                  break;
              }

              if (url) {
                window.location.href = url;
              }

              // Reset dropdown
              setTimeout(() => e.target.value = '', 100);
            });

            function scrollToBottom() {
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

            // Auto-scroll to bottom on load
            setTimeout(scrollToBottom, 100);

            // Real-time updates via Server-Sent Events
            const eventSource = new EventSource('/transcript/stream');

            eventSource.onmessage = function(event) {
              const caption = JSON.parse(event.data);
              const container = document.getElementById('captionsContainer');

              // Remove "no captions" message if present
              const noCaptions = container.querySelector('.no-captions');
              if (noCaptions) {
                noCaptions.remove();
              }

              // Create new caption element
              const time = new Date(caption.timestamp).toLocaleTimeString();
              const date = new Date(caption.timestamp).toLocaleDateString();

              const captionDiv = document.createElement('div');
              captionDiv.className = 'caption-item';
              captionDiv.innerHTML = \`
                <div class="caption-time">
                  <span class="date">\${date}</span>
                  <span class="time">\${time}</span>
                </div>
                <div class="caption-text">\${caption.text}</div>
              \`;

              container.appendChild(captionDiv);

              // Auto-scroll to new caption
              scrollToBottom();

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
    logger.info('Captions cleared by user');
    res.json({ message: 'All captions cleared successfully' });
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
            
            // Send to YouTube (only final results)
            if (isFinal) {
              logCaption(translatedText, true); // Log final caption to history
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
            // Reduced logging for performance
            if (isFinal && Math.random() < 0.1) {
              console.log('📝 Final caption:', translatedText.substring(0, 50) + '...');
            }
            
            // Broadcast translated text (live updates) - optimized
            broadcastToCaptions(translatedText);
            
            // Send to YouTube (only final results)
            if (isFinal) {
              logCaption(translatedText, true); // Log final caption to history
              youtubePublisher.publish(translatedText).catch(err => {
                // Error already logged in publish method
              });
            }
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
  console.log(`⏱️  Optimized for long-running sessions (3+ hours)`);
});

