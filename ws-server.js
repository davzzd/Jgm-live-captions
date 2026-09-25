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
const { CaptionSegmenter, sanitizeCaptionText } = require('./segmenter');
const { CaptionQueue } = require('./caption-queue');

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
  switch (level) {
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
console.log = function (...args) {
  log('INFO', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '));
};

console.error = function (...args) {
  log('ERROR', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '));
};

console.warn = function (...args) {
  log('WARN', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '));
};

/**
 * Unique, increasing ISO timestamp. Captions are identified by their timestamp
 * (edit/delete, audience de-duplication), so two captions must never share one.
 */
let lastCaptionTimeMs = 0;
function nextCaptionTimestamp() {
  let ms = Date.now();
  if (ms <= lastCaptionTimeMs) ms = lastCaptionTimeMs + 1;
  lastCaptionTimeMs = ms;
  return new Date(ms).toISOString();
}

/**
 * Log a caption to the caption history
 * @param {string} text - The caption text
 * @param {boolean} isFinal - Whether this is a final caption
 */
function logCaption(text, isFinal = true, tag = '', timestamp = nextCaptionTimestamp()) {
  text = sanitizeCaptionText(text); // captions.log is TSV: no tabs/newlines
  if (!text || !isFinal) return; // Only log final captions

  const entry = {
    timestamp,
    text,
    tag: tag || '', // Include tag in entry for SSE
    session: new Date().toISOString().split('T')[0] // Date as session ID
  };

  // Add to in-memory history (limit to last 1000 captions for quick access)
  captionHistory.push(entry);
  if (captionHistory.length > 1000) {
    captionHistory.shift();
  }

  // Write to file (append) - file grows indefinitely, no auto-clear
  // File is only cleared manually via /transcript/clear endpoint
  // Format: timestamp\ttext\ttag (tag is empty for new captions)
  const logLine = `${timestamp}\t${text}\t${tag || ''}\n`;
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

// Trust the reverse proxy (nginx) that terminates SSL in front of this app,
// so req.protocol reflects the original https scheme via X-Forwarded-Proto.
app.set('trust proxy', true);

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
const SONIOX_WS_URL = process.env.SONIOX_WS_URL || 'wss://stt-rt.soniox.com/transcribe-websocket';
const DEFAULT_SONIOX_API_KEY = process.env.SONIOX_MASTER_API_KEY || '';
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

// Soniox connection state management (the socket itself lives on activeSession)
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

// Active Soniox connection. Every socket event handler checks that its session is still
// the active one, so a socket being replaced can't touch the new connection's state.
let activeSession = null;
let sessionCounter = 0;

// Soniox closes the stream if it gets no audio or keepalive for >20s
const KEEPALIVE_IDLE_MS = 10000;
const KEEPALIVE_CHECK_MS = 5000;
const SEGMENTER_TICK_MS = 250;
const GRACEFUL_END_TIMEOUT_MS = 2000;

// Language hints for auto-detect mode (hints bias recognition, they don't restrict it)
const AUTO_LANGUAGE_HINTS = (process.env.SONIOX_AUTO_HINTS || 'ml,en,hi,ta,kn,te')
  .split(',').map(s => s.trim()).filter(Boolean);

// Overlay settings the server needs (learned from the settings the admin page forwards)
const overlaySettings = { pauseThreshold: 5000 };

// Operator controls (reset to defaults when the server restarts)
let youtubePaused = false;          // true = finished lines are not sent to YouTube
let youtubeSkippedWhilePaused = 0;  // lines not sent during the current pause
let captionDisplayEnabled = false;  // caption display (captions.html) only gets text when started

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

  /**
   * @param {string} caption
   * @param {number} [spokenAt] - ms timestamp the line belongs to (YouTube aligns it to the video)
   */
  async publish(caption, spokenAt) {
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
      const now = spokenAt ? new Date(spokenAt) : new Date();
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
 * Send the overlay's running caption text to all caption displays (captions.html).
 * Snapshot shape: { type: 'caption', gen, text, partial }
 */
function broadcastOverlay(snapshot) {
  if (!snapshot) return;
  const payload = JSON.stringify(snapshot);
  const deadClients = [];
  captionClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
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
function broadcastToAudience(text, isFinal = false, timestamp = nextCaptionTimestamp()) {
  if (!text) return;

  // Only add final captions to audience buffer
  if (isFinal) {
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
 * Serve the client.html file as default homepage
 */
// Home page - serve audience page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'audience.html'));
});

// Client/admin page
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
    // Format: timestamp\ttext\ttag (tag is optional)
    if (data) {
      const lines = data.split('\n').filter(line => line.trim());
      captions = lines.map(line => {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          // Has tag: timestamp, text (may contain tabs), tag
          return {
            timestamp: parts[0],
            text: parts.slice(1, -1).join('\t'), // Text is everything except first (timestamp) and last (tag)
            tag: parts[parts.length - 1] || '' // Last part is tag
          };
        } else if (parts.length === 2) {
          // No tag: timestamp, text
          return {
            timestamp: parts[0],
            text: parts[1],
            tag: ''
          };
        } else {
          // Fallback (shouldn't happen)
          return {
            timestamp: parts[0] || '',
            text: parts.slice(1).join('\t'),
            tag: ''
          };
        }
      });
    }

    // Get captions to display (all if limit is 0, otherwise last N)
    const displayCaptions = limit > 0 ? captions.slice(-limit) : captions;

    // Get time offset from query parameter (if provided from frontend)
    const timeOffset = parseInt(req.query.offset) || 0;
    const tz = req.query.tz || undefined;

    // Export formats
    if (format === 'json') {
      // Apply time offset to timestamps if provided
      const exportCaptions = timeOffset !== 0
        ? displayCaptions.map(c => ({
          timestamp: new Date(new Date(c.timestamp).getTime() + timeOffset).toISOString(),
          originalTimestamp: c.timestamp,
          text: c.text,
          tag: c.tag || ''
        }))
        : displayCaptions.map(c => ({
          timestamp: c.timestamp,
          text: c.text,
          tag: c.tag || ''
        }));
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
        csv = 'Timestamp,Caption,Tag\n' + displayCaptions.map(c => {
          const dateObj = timeOffset !== 0
            ? new Date(new Date(c.timestamp).getTime() + timeOffset)
            : new Date(c.timestamp);
          const dateOpts = tz ? { timeZone: tz } : undefined;
          const displayTimestamp = tz ? `${dateObj.toLocaleDateString(undefined, dateOpts)} ${dateObj.toLocaleTimeString(undefined, dateOpts)}` : dateObj.toISOString();
          const tag = c.tag || '';
          return `"${displayTimestamp}","${c.text.replace(/"/g, '""')}","${tag.replace(/"/g, '""')}"`;
        }).join('\n');
      } else {
        csv = 'Caption,Tag\n' + displayCaptions.map(c => {
          const tag = c.tag || '';
          return `"${c.text.replace(/"/g, '""')}","${tag.replace(/"/g, '""')}"`;
        }).join('\n');
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
          const dateOpts = tz ? { timeZone: tz } : undefined;
          const dateStr = tz ? `${date.toLocaleDateString(undefined, dateOpts)} ${date.toLocaleTimeString(undefined, dateOpts)}` : date.toLocaleString();
          const tag = c.tag ? `[${c.tag}] ` : '';
          return `[${dateStr}] ${tag}${c.text}`;
        }).join('\n\n');
      } else {
        txt = displayCaptions.map(c => {
          const tag = c.tag ? `[${c.tag}] ` : '';
          return `${tag}${c.text}`;
        }).join('\n\n');
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
        const tag = c.tag || '';
        const tagDisplay = tag ? `<span class="caption-tag tag-${tag.replace(/\s+/g, '-')}">[${tag}]</span>` : '';
        return `
            <div class="caption-item" data-timestamp="${c.timestamp}" data-index="${index}" data-tag="${escapeHtml(tag)}">
              <div class="caption-header">
                <div class="caption-time">
                  ${tagDisplay}
                  <span class="date">${date}</span>
                  <span class="time">${time}</span>
                </div>
                <div class="caption-actions">
                  <div class="tag-buttons">
                    <button class="tag-btn ${tag === 'prophecy' ? 'active' : ''}" onclick="setTag(this, 'prophecy')" title="Tag as prophecy">🔮</button>
                    <button class="tag-btn ${tag === 'healing declaration' ? 'active' : ''}" onclick="setTag(this, 'healing declaration')" title="Tag as healing declaration">💚</button>
                    <button class="tag-btn ${tag === 'scripture' ? 'active' : ''}" onclick="setTag(this, 'scripture')" title="Tag as scripture">📖</button>
                    <button class="tag-btn ${tag === 'person call out' ? 'active' : ''}" onclick="setTag(this, 'person call out')" title="Tag as person call out">👤</button>
                    <button class="tag-btn ${tag === 'emphasis' ? 'active' : ''}" onclick="setTag(this, 'emphasis')" title="Tag as emphasis">⭐</button>
                    <button class="tag-btn ${tag === 'POINT' ? 'active' : ''}" onclick="setTag(this, 'POINT')" title="Tag as POINT">📌</button>
                    <button class="tag-btn ${tag === 'ignore' ? 'active' : ''}" onclick="setTag(this, 'ignore')" title="Tag as ignore">🚫</button>
                    ${tag ? `<button class="tag-btn tag-clear" onclick="setTag(this, '')" title="Remove tag">✕</button>` : ''}
                  </div>
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
            .controls button.yt-btn.paused {
              background: #c5534b;
            }
            .controls button.yt-btn:disabled {
              background: #3c3c3c;
              color: #858585;
              cursor: default;
            }
            .rejected-btn {
              background: #3c3c3c !important;
            }
            .review-bar {
              display: flex;
              gap: 10px;
              align-items: center;
              flex-wrap: wrap;
              margin-top: 10px;
              font-size: 12px;
            }
            .review-label {
              color: #9cdcfe;
            }
            .mode-switch {
              display: inline-flex;
              border: 1px solid #555;
              border-radius: 4px;
              overflow: hidden;
            }
            .mode-btn {
              background: #3c3c3c;
              color: #d4d4d4;
              border: none;
              padding: 6px 12px;
              font-family: inherit;
              font-size: 12px;
              cursor: pointer;
            }
            .mode-btn + .mode-btn {
              border-left: 1px solid #555;
            }
            .mode-btn.active {
              background: #0e639c;
              color: #fff;
              font-weight: bold;
            }
            .mode-btn.active.veto {
              background: #b5890a;
            }
            .waiting-counter {
              color: #dcdcaa;
              font-weight: bold;
            }
            .waiting-counter.alert {
              color: #f48771;
            }
            .review-hint {
              color: #858585;
            }
            .queue-container:empty {
              display: none;
            }
            .queue-container {
              margin-top: 12px;
            }
            .queue-item {
              padding: 12px;
              border-left: 3px solid #d7ba7d;
              margin-bottom: 12px;
              background: #2d2a22;
              border-radius: 3px;
            }
            .queue-item.nudge {
              outline: 2px solid #f48771;
            }
            .queue-item.editing {
              background: #3a3a3d;
              border-left-color: #dcdcaa;
            }
            .queue-item.blocked {
              border-left-color: #858585;
            }
            .queue-meta {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 10px;
              margin-bottom: 6px;
              font-size: 11px;
              color: #858585;
            }
            .queue-status {
              color: #d7ba7d;
              font-weight: bold;
            }
            .queue-status.warn {
              color: #f48771;
            }
            .queue-text {
              color: #d4d4d4;
              font-size: 14px;
              line-height: 1.6;
              word-wrap: break-word;
            }
            .queue-edit-input {
              width: 100%;
              background: #1e1e1e;
              color: #d4d4d4;
              border: 1px solid #dcdcaa;
              border-radius: 3px;
              padding: 8px;
              font-family: inherit;
              font-size: 14px;
              line-height: 1.6;
              resize: vertical;
            }
            .queue-bar {
              height: 4px;
              background: #3e3e42;
              border-radius: 2px;
              overflow: hidden;
              margin: 8px 0;
            }
            .queue-bar-fill {
              height: 100%;
              background: #d7ba7d;
              width: 100%;
            }
            .queue-actions {
              display: flex;
              gap: 8px;
              flex-wrap: wrap;
            }
            .queue-actions button {
              background: #3c3c3c;
              color: #d4d4d4;
              border: 1px solid #555;
              padding: 6px 12px;
              border-radius: 3px;
              cursor: pointer;
              font-family: inherit;
              font-size: 12px;
            }
            .queue-actions button:hover:not(:disabled) {
              border-color: #d7ba7d;
            }
            .queue-actions button.send {
              background: #0e639c;
              border-color: #0e639c;
              color: #fff;
            }
            .queue-actions button.reject {
              background: #6b2b26;
              border-color: #c5534b;
              color: #fff;
            }
            .queue-actions button:disabled {
              opacity: 0.4;
              cursor: default;
            }
            .modal-backdrop {
              position: fixed;
              inset: 0;
              background: rgba(0, 0, 0, 0.6);
              z-index: 1000;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .modal {
              background: #252526;
              border: 1px solid #3e3e42;
              border-radius: 6px;
              width: min(720px, 100%);
              max-height: 80vh;
              display: flex;
              flex-direction: column;
            }
            .modal-header {
              padding: 15px;
              border-bottom: 1px solid #3e3e42;
            }
            .modal-header h2 {
              color: #f48771;
              font-size: 16px;
              margin-bottom: 4px;
            }
            .modal-note {
              color: #858585;
              font-size: 11px;
            }
            .rejected-list {
              padding: 10px 15px;
              overflow-y: auto;
              flex: 1;
            }
            .rejected-item {
              display: flex;
              gap: 10px;
              align-items: flex-start;
              padding: 8px 0;
              border-bottom: 1px solid #3e3e42;
              font-size: 13px;
            }
            .rejected-item .rejected-time {
              color: #858585;
              white-space: nowrap;
              font-size: 11px;
              padding-top: 2px;
            }
            .rejected-item .rejected-text {
              flex: 1;
              color: #d4d4d4;
              word-wrap: break-word;
            }
            .rejected-item button, .modal-actions button {
              background: #3c3c3c;
              color: #d4d4d4;
              border: 1px solid #555;
              padding: 4px 10px;
              border-radius: 3px;
              cursor: pointer;
              font-family: inherit;
              font-size: 12px;
            }
            .modal-actions {
              display: flex;
              justify-content: flex-end;
              gap: 10px;
              padding: 12px 15px;
              border-top: 1px solid #3e3e42;
            }
            .modal-actions button.danger {
              background: #6b2b26;
              border-color: #c5534b;
              color: #fff;
            }
            .rejected-empty {
              color: #858585;
              font-style: italic;
              padding: 20px 0;
              text-align: center;
            }
            .yt-paused-banner {
              margin-top: 10px;
              padding: 8px 12px;
              background: rgba(197, 83, 75, 0.2);
              border: 1px solid #c5534b;
              border-radius: 4px;
              color: #f48771;
              font-size: 13px;
              font-weight: bold;
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
              align-items: center;
            }
            .tag-buttons {
              display: flex;
              gap: 4px;
              margin-right: 4px;
              opacity: 0;
              transition: all 0.2s;
            }
            .caption-item:hover .tag-buttons {
              opacity: 1;
            }
            .tag-btn {
              background: transparent;
              border: 1px solid transparent;
              color: #858585;
              cursor: pointer;
              padding: 3px 6px;
              border-radius: 3px;
              font-size: 11px;
              transition: all 0.2s;
            }
            .tag-btn:hover {
              background: #3e3e42;
              border-color: #858585;
            }
            .tag-btn.active {
              background: #4ec9b0;
              border-color: #4ec9b0;
              color: #1e1e1e;
            }
            .tag-btn.tag-clear {
              font-size: 10px;
              padding: 2px 5px;
            }
            .tag-btn.tag-clear:hover {
              background: #c5534b;
              border-color: #c5534b;
              color: white;
            }
            .caption-tag {
              display: inline-block;
              padding: 2px 6px;
              border-radius: 3px;
              font-size: 9px;
              font-weight: 600;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              margin-right: 8px;
            }
            .caption-tag.tag-prophecy {
              background: rgba(156, 39, 176, 0.3);
              color: #ce93d8;
            }
            .caption-tag.tag-healing-declaration {
              background: rgba(76, 175, 80, 0.3);
              color: #81c784;
            }
            .caption-tag.tag-scripture {
              background: rgba(33, 150, 243, 0.3);
              color: #64b5f6;
            }
            .caption-tag.tag-ignore {
              background: rgba(158, 158, 158, 0.3);
              color: #bdbdbd;
            }
            .caption-tag.tag-person-call-out {
              background: rgba(255, 152, 0, 0.3);
              color: #ffb74d;
            }
            .caption-tag.tag-emphasis {
              background: rgba(255, 235, 59, 0.3);
              color: #fff59d;
            }
            .caption-tag.tag-POINT {
              background: rgba(244, 67, 54, 0.3);
              color: #ef5350;
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
              <button id="ytPauseBtn" class="yt-btn" onclick="toggleYoutubePause()" disabled title="Pause/resume sending captions to YouTube">📺 YouTube: …</button>
              <button id="rejectedBtn" class="rejected-btn" title="Lines you rejected (not in the transcript or exports)">🚫 Rejected (0)</button>
            </div>
            <div class="review-bar">
              <span class="review-label">Mode:</span>
              <div class="mode-switch" role="group" aria-label="Caption mode">
                <button id="modeAutoBtn" class="mode-btn active" title="Lines go to phones and YouTube immediately">⚡ Auto</button>
                <button id="modeVetoBtn" class="mode-btn" title="Lines wait 10 seconds so you can reject or fix them">⏳ Delay 10s</button>
              </div>
              <span id="waitingCounter" class="waiting-counter"></span>
              <span id="reviewHint" class="review-hint" style="display: none;">Keys: Enter = send now · Delete = reject · E = edit (oldest waiting line)</span>
            </div>
            <div id="ytPausedBanner" class="yt-paused-banner" style="display: none;">
              ⏸️ YouTube captions are PAUSED — lines appear here and on phones but are not sent to YouTube
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
          <div id="queueContainer" class="queue-container"></div>
          <div id="rejectedModal" class="modal-backdrop" style="display: none;">
            <div class="modal" role="dialog" aria-labelledby="rejectedTitle">
              <div class="modal-header">
                <h2 id="rejectedTitle">🚫 Rejected lines</h2>
                <span class="modal-note">Not in the transcript or exports. Copy a line if you want to add it back by editing an existing line.</span>
              </div>
              <div id="rejectedList" class="rejected-list"></div>
              <div class="modal-actions">
                <button id="rejectedClearBtn" class="danger">🧹 Clear list</button>
                <button id="rejectedCloseBtn">Close</button>
              </div>
            </div>
          </div>
          <script>
            // Fix server-rendered timestamps to match client locale/timezone
            // This ensures initial loading captions match the timezone of live SSE captions
            document.querySelectorAll('.caption-item').forEach(item => {
              const timestamp = item.getAttribute('data-timestamp');
              if (timestamp) {
                const dateObj = new Date(timestamp);
                const dateSpan = item.querySelector('.caption-time .date');
                const timeSpan = item.querySelector('.caption-time .time');
                if (dateSpan) dateSpan.textContent = dateObj.toLocaleDateString();
                if (timeSpan) timeSpan.textContent = dateObj.toLocaleTimeString();
              }
            });

            // Smart autoscroll state
            let isUserScrolling = false;
            let autoScrollEnabled = true;
            let scrollTimeout;

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
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                if (tz) url += '&tz=' + encodeURIComponent(tz);
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

            // Show a tag change on a transcript line without reloading the page
            function applyTagToItem(captionItem, tag) {
              captionItem.setAttribute('data-tag', tag);

              const timeDiv = captionItem.querySelector('.caption-time');
              const oldLabel = timeDiv.querySelector('.caption-tag');
              if (oldLabel) oldLabel.remove();
              if (tag) {
                const label = document.createElement('span');
                label.className = 'caption-tag tag-' + tag.replace(/\\s+/g, '-');
                label.textContent = '[' + tag + ']';
                timeDiv.insertBefore(label, timeDiv.firstChild);
              }

              const tagButtons = captionItem.querySelector('.tag-buttons');
              tagButtons.querySelectorAll('.tag-btn').forEach(btn => {
                const match = (btn.getAttribute('onclick') || '').match(/setTag\\(this, '([^']*)'\\)/);
                btn.classList.toggle('active', !!match && match[1] === tag && tag !== '');
              });
              let clearBtn = tagButtons.querySelector('.tag-clear');
              if (tag && !clearBtn) {
                clearBtn = document.createElement('button');
                clearBtn.className = 'tag-btn tag-clear';
                clearBtn.title = 'Remove tag';
                clearBtn.textContent = '✕';
                clearBtn.setAttribute('onclick', "setTag(this, '')");
                tagButtons.appendChild(clearBtn);
              } else if (!tag && clearBtn) {
                clearBtn.remove();
              }
            }

            // Tag management function
            function setTag(button, tag) {
              const captionItem = button.closest('.caption-item');
              const timestamp = captionItem.getAttribute('data-timestamp');
              
              if (!timestamp) {
                console.error('No timestamp found for caption');
                return;
              }
              
              // Update tag via API
              fetch('/transcript/tag', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timestamp, tag })
              })
              .then(res => res.json())
              .then(data => {
                if (data.success) {
                  // Update the line in place (no reload, so live review isn't interrupted)
                  applyTagToItem(captionItem, tag);
                } else {
                  alert('Failed to update tag: ' + (data.error || 'Unknown error'));
                }
              })
              .catch(err => {
                console.error('Error updating tag:', err);
                alert('Error updating tag: ' + err.message);
              });
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

            // ===== YouTube pause/resume =====
            let youtubePaused = false;

            function renderYoutubeState(state) {
              youtubePaused = !!state.paused;
              const btn = document.getElementById('ytPauseBtn');
              const banner = document.getElementById('ytPausedBanner');
              btn.classList.toggle('paused', youtubePaused);
              banner.style.display = youtubePaused ? 'block' : 'none';
              if (!state.configured && !youtubePaused) {
                btn.textContent = '📺 YouTube: Off';
                btn.title = 'No YouTube captions URL set (add it in the admin settings)';
                btn.disabled = true;
              } else {
                btn.textContent = youtubePaused ? '▶️ Resume YouTube' : '⏸️ Pause YouTube';
                btn.title = youtubePaused ? 'Resume sending captions to YouTube' : 'Stop sending captions to YouTube (transcript and phones stay live)';
                btn.disabled = false;
              }
            }

            function toggleYoutubePause() {
              const btn = document.getElementById('ytPauseBtn');
              btn.disabled = true;
              fetch('/api/youtube-pause', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paused: !youtubePaused })
              })
              .then(res => res.json())
              .then(state => {
                if (!state.success) throw new Error(state.error || 'Unknown error');
                renderYoutubeState(state);
              })
              .catch(err => {
                btn.disabled = false;
                alert('Could not change YouTube captions: ' + err.message);
              });
            }

            fetch('/api/youtube-status')
              .then(res => res.json())
              .then(renderYoutubeState)
              .catch(err => console.error('Could not load YouTube status:', err));

            // Real-time updates via Server-Sent Events
            const eventSource = new EventSource('/transcript/stream');

            eventSource.onmessage = function(event) {
              const caption = JSON.parse(event.data);
              if (caption.type === 'youtube_status') {
                renderYoutubeState(caption);
                return;
              }
              if (caption.type === 'queue') {
                if (window.renderQueueState) window.renderQueueState(caption);
                return;
              }
              const container = document.getElementById('captionsContainer');

              // Remove "no captions" message if present
              const noCaptions = container.querySelector('.no-captions');
              if (noCaptions) {
                noCaptions.remove();
              }

              const originalDate = new Date(caption.timestamp);
              const time = originalDate.toLocaleTimeString();
              const date = originalDate.toLocaleDateString();
              
              // Get tag from caption (default to empty string)
              const tag = caption.tag || '';
              const tagDisplay = tag ? \`<span class="caption-tag tag-\${tag.replace(/\\s+/g, '-')}">[\${tag}]</span>\` : '';

              const captionDiv = document.createElement('div');
              captionDiv.className = 'caption-item';
              captionDiv.setAttribute('data-timestamp', caption.timestamp); // Store original timestamp
              captionDiv.setAttribute('data-tag', tag); // Store tag for tag buttons
              captionDiv.innerHTML = \`
                <div class="caption-header">
                  <div class="caption-time">
                    \${tagDisplay}
                    <span class="date">\${date}</span>
                    <span class="time">\${time}</span>
                  </div>
                  <div class="caption-actions">
                    <div class="tag-buttons">
                      <button class="tag-btn \${tag === 'prophecy' ? 'active' : ''}" onclick="setTag(this, 'prophecy')" title="Tag as prophecy">🔮</button>
                      <button class="tag-btn \${tag === 'healing declaration' ? 'active' : ''}" onclick="setTag(this, 'healing declaration')" title="Tag as healing declaration">💚</button>
                      <button class="tag-btn \${tag === 'scripture' ? 'active' : ''}" onclick="setTag(this, 'scripture')" title="Tag as scripture">📖</button>
                      <button class="tag-btn \${tag === 'person call out' ? 'active' : ''}" onclick="setTag(this, 'person call out')" title="Tag as person call out">👤</button>
                      <button class="tag-btn \${tag === 'emphasis' ? 'active' : ''}" onclick="setTag(this, 'emphasis')" title="Tag as emphasis">⭐</button>
                      <button class="tag-btn \${tag === 'POINT' ? 'active' : ''}" onclick="setTag(this, 'POINT')" title="Tag as POINT">📌</button>
                      <button class="tag-btn \${tag === 'ignore' ? 'active' : ''}" onclick="setTag(this, 'ignore')" title="Tag as ignore">🚫</button>
                      \${tag ? \`<button class="tag-btn tag-clear" onclick="setTag(this, '')" title="Remove tag">✕</button>\` : ''}
                    </div>
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


          </script>
          <script src="/transcript-review.js"></script>
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

    // ...and the review queue and the rejected lines list
    captionQueue.clear();
    rejectedCaptions = [];
    saveQueueState();
    saveRejectedCaptions();
    broadcastQueueState();

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
  const { timestamp } = req.body;
  const newText = sanitizeCaptionText(req.body.newText); // captions.log is TSV: no tabs/newlines

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
    // Format: timestamp\ttext\ttag
    const lines = data.split('\n').filter(line => line.trim());
    let updated = false;
    const updatedLines = lines.map(line => {
      const parts = line.split('\t');
      if (parts[0] === timestamp) {
        updated = true;
        const oldText = parts.length >= 3 ? parts.slice(1, -1).join('\t') : parts.slice(1).join('\t');
        const tag = parts.length >= 3 ? (parts[parts.length - 1] || '') : '';
        logger.info(`Caption edited: "${oldText}" → "${newText}"`);
        return tag ? `${timestamp}\t${newText}\t${tag}` : `${timestamp}\t${newText}\t`;
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
    // Format: timestamp\ttext\ttag
    const lines = data.split('\n').filter(line => line.trim());
    let deleted = false;
    let deletedText = '';
    const updatedLines = lines.filter(line => {
      const parts = line.split('\t');
      if (parts[0] === timestamp) {
        deleted = true;
        deletedText = parts.length >= 3 ? parts.slice(1, -1).join('\t') : parts.slice(1).join('\t');
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
 * Update caption tag endpoint
 */
app.post('/transcript/tag', (req, res) => {
  const { timestamp, tag } = req.body;

  if (!timestamp) {
    return res.status(400).json({ success: false, error: 'Missing timestamp' });
  }

  // Validate tag
  const validTags = ['prophecy', 'healing declaration', 'scripture', 'ignore', 'person call out', 'emphasis', 'POINT', ''];
  if (tag && !validTags.includes(tag)) {
    return res.status(400).json({ success: false, error: 'Invalid tag. Valid tags: prophecy, healing declaration, scripture, ignore, person call out, emphasis, POINT' });
  }

  // Read the captions file
  fs.readFile(CAPTIONS_LOG_FILE, 'utf8', (err, data) => {
    if (err) {
      logger.error('Failed to read captions for tag update:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to read captions file' });
    }

    // Parse and update the caption tag
    // Format: timestamp\ttext\ttag
    const lines = data.split('\n').filter(line => line.trim());
    let updated = false;
    const updatedLines = lines.map(line => {
      const parts = line.split('\t');
      if (parts[0] === timestamp) {
        updated = true;
        const text = parts.length >= 3 ? parts.slice(1, -1).join('\t') : parts.slice(1).join('\t');
        const newTag = tag || '';
        logger.info(`Caption tagged: "${text}" → tag: "${newTag}"`);
        return newTag ? `${timestamp}\t${text}\t${newTag}` : `${timestamp}\t${text}\t`;
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
        logger.error('Failed to save tag update:', err.message);
        return res.status(500).json({ success: false, error: 'Failed to save changes' });
      }

      // Update in-memory history if present
      const memoryEntry = captionHistory.find(c => c.timestamp === timestamp);
      if (memoryEntry) {
        memoryEntry.tag = tag || '';
      }

      res.json({ success: true, message: 'Tag updated successfully' });
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

  // Send initial heartbeat and current YouTube state (also re-syncs after a reconnect)
  res.write(': heartbeat\n\n');
  res.write(`data: ${JSON.stringify(youtubeState())}\n\n`);
  res.write(`data: ${JSON.stringify(queueState())}\n\n`);

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
    // Read last N captions from file (optimized for mobile - only send last 50)
    const MAX_INITIAL_CAPTIONS = 50; // Limit initial load for mobile performance
    try {
      if (fs.existsSync(CAPTIONS_LOG_FILE)) {
        const data = fs.readFileSync(CAPTIONS_LOG_FILE, 'utf8');
        const lines = data.split('\n').filter(line => line.trim());

        // Only process last N lines (much faster for large files)
        const recentLines = lines.slice(-MAX_INITIAL_CAPTIONS);

        // Parse captions - format: timestamp\ttext\ttag
        // Tags are NOT sent to audience, only text
        const recentCaptions = recentLines.map(line => {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            // Has tag: timestamp, text (may contain tabs), tag
            return {
              type: 'caption',
              timestamp: parts[0],
              text: parts.slice(1, -1).join('\t') // Text is everything except first (timestamp) and last (tag)
            };
          } else if (parts.length === 2) {
            // No tag: timestamp, text
            return {
              type: 'caption',
              timestamp: parts[0],
              text: parts[1]
            };
          } else {
            // Fallback
            return {
              type: 'caption',
              timestamp: parts[0] || '',
              text: parts.slice(1).join('\t')
            };
          }
        });

        // Send recent captions to new viewer (only last 50 for fast loading)
        recentCaptions.forEach(caption => {
          res.write(`data: ${JSON.stringify(caption)}\n\n`);
        });

        // Also update memory buffer to match what we sent (ensures consistency)
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


// ===== OPERATOR CONTROLS (YouTube pause, caption display) =====

function youtubeState() {
  return { type: 'youtube_status', configured: !!youtubePublisher.enabled, paused: youtubePaused };
}

function captionDisplayState() {
  return { type: 'caption_display_status', enabled: captionDisplayEnabled };
}

/**
 * Push control state to every admin page (WebSocket) and transcript page (SSE)
 */
function broadcastControlState() {
  const messages = [youtubeState(), captionDisplayState()].map(m => JSON.stringify(m));
  clientWebSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      messages.forEach(m => {
        try { ws.send(m); } catch (e) { /* ignore */ }
      });
    }
  });
  transcriptSSEClients.forEach(client => {
    try {
      client.write(`data: ${messages[0]}\n\n`); // transcript page only shows YouTube state
    } catch (e) {
      transcriptSSEClients.delete(client);
    }
  });
}

app.get('/api/youtube-status', (req, res) => {
  res.json(youtubeState());
});

/**
 * Pause/resume sending captions to YouTube. Transcript and audience are unaffected.
 * Body: { paused: true|false }
 */
app.post('/api/youtube-pause', (req, res) => {
  if (typeof req.body.paused !== 'boolean') {
    return res.status(400).json({ success: false, error: 'paused must be true or false' });
  }
  const paused = req.body.paused;
  if (paused !== youtubePaused) {
    youtubePaused = paused;
    if (paused) {
      youtubeSkippedWhilePaused = 0;
      logger.info('⏸️ YouTube captions PAUSED by operator (transcript and audience still live)');
    } else {
      logger.info(`▶️ YouTube captions RESUMED by operator (${youtubeSkippedWhilePaused} line(s) were not sent while paused)`);
    }
    broadcastControlState();
  }
  res.json({ success: true, ...youtubeState() });
});

/**
 * Start/stop the caption display (captions.html). When stopped, no text is built or sent to it.
 * Body: { enabled: true|false }
 */
app.post('/api/caption-display', (req, res) => {
  if (typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'enabled must be true or false' });
  }
  const enabled = req.body.enabled;
  if (enabled !== captionDisplayEnabled) {
    captionDisplayEnabled = enabled;
    if (enabled) {
      logger.info('📺 Caption display started');
      if (activeSession) {
        broadcastOverlay(activeSession.segmenter.overlaySnapshot());
        activeSession.segmenter.overlayChanged(); // mark as sent
      }
    } else {
      logger.info('📺 Caption display stopped');
      captionClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          try { client.send(JSON.stringify({ type: 'clear' })); } catch (e) { /* ignore */ }
        }
      });
    }
    broadcastControlState();
  }
  res.json({ success: true, ...captionDisplayState() });
});

// ===== CAPTION REVIEW (transcript page) =====

function queueResult(res, result, logMessage) {
  if (!result.ok) {
    return res.status(409).json({ success: false, error: result.error });
  }
  if (logMessage) logger.info(logMessage);
  saveQueueState();
  broadcastQueueState();
  res.json({ success: true });
}

app.get('/api/queue', (req, res) => {
  res.json(queueState());
});

/**
 * Switch between 'auto' (send at once) and 'veto' (10s review delay)
 */
app.post('/api/caption-mode', (req, res) => {
  const { mode } = req.body;
  if (mode !== 'auto' && mode !== 'veto') {
    return res.status(400).json({ success: false, error: "mode must be 'auto' or 'veto'" });
  }
  if (captionQueue.setMode(mode, Date.now())) {
    logger.info(mode === 'veto'
      ? `⏳ Caption review ON: lines wait ${REVIEW_DELAY_MS / 1000}s before going to phones and YouTube`
      : '⚡ Caption review OFF: lines are sent immediately');
  }
  saveQueueState();
  broadcastQueueState();
  res.json({ success: true, mode: captionQueue.mode });
});

app.post('/api/queue/send-now', (req, res) => {
  queueResult(res, captionQueue.sendNow(req.body.id, Date.now()));
});

app.post('/api/queue/reject', (req, res) => {
  const result = captionQueue.reject(req.body.id, Date.now());
  if (result.ok) {
    rejectedCaptions.push({ timestamp: result.item.id, text: result.item.text, rejectedAt: new Date().toISOString() });
    saveRejectedCaptions();
  }
  queueResult(res, result, result.ok ? `🚫 Line rejected: "${result.item.text.substring(0, 60)}"` : null);
});

/**
 * Edit a waiting line. action: 'start' | 'renew' | 'save' | 'cancel'
 * The page renews while the editor is open; an abandoned edit expires and the original is sent.
 */
app.post('/api/queue/edit', (req, res) => {
  const { id, action } = req.body;
  const now = Date.now();
  let result;
  if (action === 'start') result = captionQueue.startEdit(id, now);
  else if (action === 'renew') result = captionQueue.renewEdit(id, now);
  else if (action === 'save') result = captionQueue.saveEdit(id, sanitizeCaptionText(req.body.text), now);
  else if (action === 'cancel') result = captionQueue.cancelEdit(id, now);
  else return res.status(400).json({ success: false, error: 'Unknown action' });

  if (action === 'renew' && result.ok) {
    return res.json({ success: true }); // no state change worth broadcasting
  }
  queueResult(res, result, action === 'save' && result.ok ? `✏️ Line edited before sending: "${sanitizeCaptionText(req.body.text).substring(0, 60)}"` : null);
});

app.get('/api/rejected', (req, res) => {
  res.json({ success: true, lines: rejectedCaptions });
});

/**
 * Empty the Rejected popup (doesn't touch the transcript or anything live)
 */
app.post('/api/rejected/clear', (req, res) => {
  rejectedCaptions = [];
  saveRejectedCaptions();
  broadcastQueueState();
  res.json({ success: true });
});

/**
 * Static assets. Only the logo is served; serving the whole directory would expose
 * server.log (contains connection details), captions.log and the source code.
 */
app.get('/Logo.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'Logo.png'));
});

app.get('/transcript-review.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'transcript-review.js'));
});

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

  // Current YouTube / caption display state for the buttons
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(youtubeState()));
      ws.send(JSON.stringify(captionDisplayState()));
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
        if (youtubeCaptionUrl && youtubeCaptionUrl.trim() === youtubePublisher.postUrl) {
          // Same stream: keep the publisher so YouTube's sequence numbers keep counting up
          console.log('📺 YouTube captions URL unchanged - continuing sequence');
        } else if (youtubeCaptionUrl && youtubeCaptionUrl.trim().length > 0) {
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
        broadcastControlState();

        // A user start resets the reconnect backoff
        reconnectAttempts = 0;
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
          reconnectTimeout = null;
        }

        // Replace any existing connection. Its socket handlers ignore events once it is
        // no longer the active session, so the new one can start right away.
        if (activeSession) {
          console.log('ℹ️ Closing existing Soniox connection to start new one');
          shutdownSonioxConnection();
        }
        connectToSoniox(apiKey, sourceLanguage, targetLanguage);
      } else if (data.type === 'stop_soniox') {
        // Client requesting to stop Soniox connection
        console.log('🛑 Client requested to stop Soniox connection');
        broadcastServiceStatus('ended', 'Service has ended');
        endSonioxSession(); // lets Soniox finalize the last words first
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
        const session = activeSession;
        if (session && !session.ending && session.ws.readyState === WebSocket.OPEN) {
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
              session.ws.send(audioData, { binary: true });
              lastAudioSentTime = Date.now();

              // Log occasionally for debugging (every ~100 chunks)
              if (Math.random() < 0.01) {
                console.log(`📤 Sending audio chunk: ${audioData.length} bytes (configured: ${isSonioxConfigured})`);
              }
            }
          } catch (error) {
            // Log errors but don't spam (reconnects are handled by the Soniox close handler)
            if (Math.random() < 0.001) {
              console.error('❌ Error processing audio:', error.message);
            }
          }
        } else if (Math.random() < 0.001) {
          // Not connected (or reconnecting) - audio is dropped until the connection is back
          console.warn('⚠️ Cannot send audio - Soniox not connected');
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
        // The server needs pauseThreshold to decide overlay paragraph breaks
        const pauseThreshold = Number(data.settings && data.settings.pauseThreshold);
        if (Number.isFinite(pauseThreshold) && pauseThreshold > 0) {
          overlaySettings.pauseThreshold = pauseThreshold;
          if (activeSession) activeSession.segmenter.setPauseThreshold(pauseThreshold);
        }

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
        if (activeSession) {
          activeSession.segmenter.resetOverlay(Date.now());
          activeSession.segmenter.overlayChanged(); // mark the empty snapshot as sent
        }
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

  // Repaint a (re)connected overlay immediately with the current text
  if (captionDisplayEnabled && activeSession) {
    try {
      ws.send(JSON.stringify(activeSession.segmenter.overlaySnapshot()));
    } catch (error) {
      // Ignore, the close handler cleans up
    }
  }

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
 * Soniox session lifecycle
 *
 * A session wraps one Soniox WebSocket plus its CaptionSegmenter and timers.
 * `activeSession` is the only session allowed to change global state; handlers of a
 * replaced or stopped socket see `activeSession !== session` and do nothing.
 */

const SERVICE_DISCLAIMER = 'Translation will begin when the talk starts only. Please note: Automated translation is approximately 95% accurate. Some errors may occur and captions may not be perfect.';

// Overlay state of the last session, so a reconnect keeps the Resolume text on screen
let lastOverlay = null;

function isActiveSession(session) {
  return !!session && activeSession === session;
}

function teardownSession(session) {
  clearTimeout(session.connectTimer);
  clearInterval(session.keepaliveTimer);
  clearInterval(session.tickTimer);
  clearTimeout(session.finishTimer);
  session.connectTimer = session.keepaliveTimer = session.tickTimer = session.finishTimer = null;
  lastOverlay = { ...session.segmenter.overlay };
}

/**
 * Send one finished caption line to the transcript, audience viewers and YouTube.
 */
function emitSegment(segment) {
  const { text, source, reason, avgConfidence } = segment;
  const confidence = avgConfidence != null ? ` ${(avgConfidence * 100).toFixed(1)}%` : '';
  logger.info(`📝 Caption [${source}/${reason}]${confidence}: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);

  // The timestamp is the caption's ID (edit/delete, audience de-duplication) and its spoken time
  const timestamp = nextCaptionTimestamp();
  captionQueue.add({ id: timestamp, text, createdAt: Date.parse(timestamp) }, Date.now());
  saveQueueState();
  broadcastQueueState();
}

// ===== CAPTION REVIEW QUEUE =====
// Every finished line goes through the queue. In 'auto' mode it is sent at once; in 'veto'
// mode it waits REVIEW_DELAY_MS so the operator can reject or fix it first.

const REVIEW_DELAY_MS = 10000;
// YouTube ignores caption timestamps that are too old (reportedly ~60s); skip rather than send late
const YOUTUBE_MAX_CAPTION_AGE_MS = 55000;
const QUEUE_STATE_FILE = path.join(__dirname, 'caption-queue.json');
const REJECTED_FILE = path.join(__dirname, 'rejected-captions.json');

/**
 * Send one approved line to the transcript, phones and YouTube.
 */
function sendApprovedCaption(item, now) {
  logCaption(item.text, true, '', item.id);
  broadcastToAudience(item.text, true, item.id);

  if (!youtubePublisher.enabled) return;
  if (youtubePaused) {
    // Dropped, not queued: sent later they would be out of sync (or too old for YouTube)
    youtubeSkippedWhilePaused++;
    return;
  }
  const age = now - item.createdAt;
  if (age > YOUTUBE_MAX_CAPTION_AGE_MS) {
    logger.warn(`📺 Not sent to YouTube (line is ${Math.round(age / 1000)}s old, too late for the stream): "${item.text.substring(0, 60)}"`);
    return;
  }
  youtubePublisher.publish(item.text, item.createdAt).catch(() => {
    // Error already logged in publish method
  });
}

const captionQueue = new CaptionQueue({
  mode: 'auto', // default when the server starts
  delayMs: REVIEW_DELAY_MS,
  onSend: sendApprovedCaption,
  onEditExpired: item => {
    logger.warn(`✏️ Edit abandoned (page closed?) - sending original line: "${item.text.substring(0, 60)}"`);
  }
});

let rejectedCaptions = []; // [{ timestamp, text, rejectedAt }] - only shown in the transcript's Rejected popup

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    logger.error(`Could not read ${path.basename(file)}:`, error.message);
    return fallback;
  }
}

function writeJsonFile(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (error) {
    logger.error(`Could not save ${path.basename(file)}:`, error.message);
  }
}

function saveQueueState() {
  writeJsonFile(QUEUE_STATE_FILE, captionQueue.serialize());
}

function saveRejectedCaptions() {
  writeJsonFile(REJECTED_FILE, rejectedCaptions);
}

function queueState() {
  return {
    type: 'queue',
    ...captionQueue.snapshot(Date.now()),
    rejectedCount: rejectedCaptions.length
  };
}

function broadcastQueueState() {
  const data = `data: ${JSON.stringify(queueState())}\n\n`;
  transcriptSSEClients.forEach(client => {
    try {
      client.write(data);
    } catch (error) {
      transcriptSSEClients.delete(client);
    }
  });
}

function processCaptionQueue() {
  const hadItems = captionQueue.items.length;
  const sent = captionQueue.process(Date.now());
  if (sent > 0 || captionQueue.items.length !== hadItems) {
    saveQueueState();
    broadcastQueueState();
  }
}

// Restore after a restart: lines that were waiting are sent right away; rejected list is kept
rejectedCaptions = readJsonFile(REJECTED_FILE, []);
{
  const savedQueue = readJsonFile(QUEUE_STATE_FILE, []);
  if (savedQueue.length > 0) {
    captionQueue.restore(savedQueue, Date.now());
    const sent = captionQueue.flushAll(Date.now());
    logger.info(`📨 Sent ${sent} line(s) that were waiting for review before the restart`);
    saveQueueState();
  }
}
setInterval(processCaptionQueue, 250);

function emitSegments(session, segments) {
  segments.forEach(emitSegment);
  if (session.segmenter.takeLateTranslationWarning()) {
    console.warn('⚠️ Translation arrived right after an untranslated fallback caption (possible duplicate line)');
  }
}

function publishOverlay(session) {
  if (!captionDisplayEnabled) return; // nobody should be shown captions: skip the work
  if (session.segmenter.overlayChanged()) {
    broadcastOverlay(session.segmenter.overlaySnapshot());
  }
}

/**
 * Stop the Soniox connection immediately (used when restarting with new settings).
 * Buffered finals are still emitted so nothing is lost.
 */
function shutdownSonioxConnection() {
  console.log('🛑 Shutting down Soniox connection...');

  manualDisconnect = true; // prevent auto-reconnect
  isReconnecting = false;
  isSonioxConfigured = false;
  sonioxConnectionState = 'disconnected';
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  const session = activeSession;
  activeSession = null;
  if (session) {
    teardownSession(session);
    emitSegments(session, session.segmenter.flush('stop', Date.now()));
    publishOverlay(session);
    try {
      if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
        session.ws.close(1000, 'Manual disconnect');
      }
    } catch (error) {
      console.error('❌ Error closing Soniox WebSocket:', error.message);
    }
  }

  broadcastSonioxStatus('disconnected', 'Connection stopped');
  console.log('✅ Soniox connection shut down');
}

/**
 * Stop the Soniox connection gracefully: send an empty frame so Soniox finalizes the last
 * words, wait (bounded) for its `finished` response, emit everything, then close.
 */
function endSonioxSession(done) {
  manualDisconnect = true;
  isReconnecting = false;
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  const session = activeSession;
  const finish = () => {
    if (session && !session.finished) {
      session.finished = true;
      if (activeSession === session) activeSession = null;
      teardownSession(session);
      emitSegments(session, session.segmenter.flush('end', Date.now()));
      publishOverlay(session);
      try {
        if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
          session.ws.close(1000, 'Session ended');
        }
      } catch (error) {
        // Ignore
      }
    }
    isSonioxConfigured = false;
    sonioxConnectionState = 'disconnected';
    broadcastSonioxStatus('disconnected', 'Connection stopped');
    console.log('✅ Soniox session ended');
    if (done) done();
  };

  if (!session || session.ws.readyState !== WebSocket.OPEN) {
    finish();
    return;
  }

  console.log('🛑 Ending Soniox session (waiting for final words)...');
  session.ending = true;
  session.onFinished = finish;
  clearInterval(session.keepaliveTimer);
  session.keepaliveTimer = null;
  try {
    session.ws.send(Buffer.alloc(0)); // empty frame = end of audio
  } catch (error) {
    finish();
    return;
  }
  session.finishTimer = setTimeout(() => {
    console.warn('⚠️ Soniox did not confirm end of stream in time, closing anyway');
    finish();
  }, GRACEFUL_END_TIMEOUT_MS);
}

/**
 * Build Soniox context for improved transcription/translation accuracy
 * Based on: https://soniox.com/docs/stt/concepts/context
 *
 * NOTE: Only uses fields supported by Soniox: general, text, terms, translation_terms.
 */
function buildSonioxContext() {
  return {
    general: [
      { key: "domain", value: "Church / Christianity" },
      { key: "topic", value: "Pastoral Sermon" },
      { key: "setting", value: "Church worship service" },
      { key: "speaker_role", value: "Pastor / Preacher" }
    ],

    text: `
This content is a pastor delivering a Christian sermon during a church service.
The speech includes Bible-based teaching, scripture references, exhortation,
prayerful language, and pastoral instruction addressed to a congregation.

The translation should sound natural to a church audience and reflect how
pastors commonly speak when preaching from the Bible.
`.trim(),

    terms: [
      // Core biblical & church vocabulary
      "Amen", "Hallelujah", "Praise the Lord", "Worship", "Prayer",
      "Scripture", "The Word", "Word of God", "The Gospel",
      "Salvation", "Redemption", "Grace", "Mercy", "Faith", "Repentance",
      "Anointing", "Covenant", "Blessing", "Obedience",

      // Names & titles
      "Jesus", "Jesus Christ", "Christ", "Lord", "God", "Father",
      "Holy Spirit", "Savior", "Messiah",

      // Sermon-specific language
      "Brothers and sisters", "Church", "Congregation",
      "Testimony", "Calling", "Ministry", "Preaching"
    ],

    translation_terms: [
      // Preserve biblical terms exactly
      { source: "Amen", target: "Amen" },
      { source: "Hallelujah", target: "Hallelujah" },
      { source: "Jesus Christ", target: "Jesus Christ" },
      { source: "Holy Spirit", target: "Holy Spirit" },
      { source: "Word of God", target: "Word of God" },
      { source: "The Gospel", target: "The Gospel" }
    ]
  };
}

/**
 * Build the Soniox configuration message
 * Field reference: https://soniox.com/docs/stt/api-reference/websocket-api
 */
function buildSonioxConfig(config) {
  const translate = config.sourceLanguage !== config.targetLanguage && config.targetLanguage !== 'none';
  const endpointDelay = Number(process.env.SONIOX_MAX_ENDPOINT_DELAY_MS) || 2000;

  const sonioxConfig = {
    api_key: config.apiKey,
    model: process.env.SONIOX_MODEL || 'stt-rt-v5',
    audio_format: 's16le',
    sample_rate: 16000,
    num_channels: 1,
    enable_endpoint_detection: true,
    max_endpoint_delay_ms: Math.min(3000, Math.max(500, endpointDelay)),
    enable_language_identification: true
  };

  if (config.sourceLanguage === 'auto') {
    // Hints only bias recognition; they make language identification more accurate
    sonioxConfig.language_hints = AUTO_LANGUAGE_HINTS;
  } else if (translate) {
    // Include the target so switches into it (e.g. English mid-sermon) are recognised well
    sonioxConfig.language_hints = [...new Set([config.sourceLanguage, config.targetLanguage])];
  } else {
    sonioxConfig.language_hints = [config.sourceLanguage];
  }

  if (translate) {
    sonioxConfig.translation = {
      type: 'one_way',
      target_language: config.targetLanguage
    };
  }

  sonioxConfig.context = buildSonioxContext();
  return sonioxConfig;
}

/**
 * Log how tokens are labelled in the first messages of a session
 * (shows whether target-language speech arrives as 'none' or 'original' + language)
 */
function logTokenBreakdown(session, tokens) {
  const counts = {};
  tokens.forEach(t => {
    const key = `${t.translation_status || 'no-status'}/${t.language || '?'}/${t.is_final ? 'final' : 'partial'}`;
    counts[key] = (counts[key] || 0) + 1;
  });
  console.log(`🔍 Soniox tokens (message ${session.messageCount}):`, counts);
}

// Soniox errors that retrying won't fix (bad key, billing, bad config)
function isFatalSonioxError(code, message) {
  if ([401, 402, 403].includes(code)) return true;
  if ([400, 413].includes(code) && !/duration/i.test(message || '')) return true;
  return false;
}

/**
 * Connect to Soniox WebSocket with configurable settings
 * @param {boolean} options.resume - true for an automatic reconnect (keeps overlay text)
 */
function connectToSoniox(apiKey, sourceLanguage, targetLanguage, options = {}) {
  const resume = !!options.resume;
  const config = {
    apiKey: apiKey || currentSonioxConfig.apiKey,
    sourceLanguage: sourceLanguage || currentSonioxConfig.sourceLanguage,
    targetLanguage: targetLanguage || currentSonioxConfig.targetLanguage
  };
  currentSonioxConfig = config;

  if (!config.apiKey || config.apiKey.trim().length === 0) {
    console.error('❌ Cannot connect: No API key provided');
    sonioxConnectionState = 'error';
    broadcastSonioxStatus('error', 'No API key provided');
    return;
  }

  const translate = config.sourceLanguage !== config.targetLanguage && config.targetLanguage !== 'none';
  const previousOverlay = resume
    ? lastOverlay
    : (lastOverlay ? { gen: lastOverlay.gen + 1, committed: '', lastActivityAt: 0 } : undefined);

  const session = {
    id: ++sessionCounter,
    config,
    ws: null,
    segmenter: new CaptionSegmenter({
      mode: translate ? 'translate' : 'transcribe',
      targetLanguage: config.targetLanguage,
      pauseThresholdMs: overlaySettings.pauseThreshold,
      previousOverlay
    }),
    messageCount: 0,
    lastKeepaliveAt: 0,
    keepaliveCount: 0,
    ending: false,
    finished: false,
    fatalError: null,
    onFinished: null,
    connectTimer: null,
    keepaliveTimer: null,
    tickTimer: null,
    finishTimer: null
  };

  console.log(`🔌 Connecting to Soniox (session ${session.id}${resume ? ', reconnect' : ''})...`);
  console.log(`   API Key: [redacted] (${config.apiKey.length} chars)`);
  console.log(`   ${config.sourceLanguage} → ${config.targetLanguage} (${translate ? 'translation' : 'transcription only'})`);

  activeSession = session;
  manualDisconnect = false;
  sonioxConnectionState = 'connecting';
  broadcastSonioxStatus('connecting', 'Establishing connection...');

  const ws = new WebSocket(SONIOX_WS_URL);
  session.ws = ws;

  session.connectTimer = setTimeout(() => {
    if (!isActiveSession(session) || ws.readyState === WebSocket.OPEN) return;
    console.error('❌ Soniox connection timeout after 30 seconds');
    activeSession = null;
    teardownSession(session);
    try {
      ws.terminate();
    } catch (e) {
      // Ignore
    }
    sonioxConnectionState = 'error';
    broadcastSonioxStatus('error', 'Connection timeout - check API key and network');
    if (resume) {
      // Mid-service network trouble: keep trying
      scheduleReconnect();
    } else {
      // First connect: let the user retry
      manualDisconnect = true;
    }
  }, 30000);

  ws.on('open', () => {
    if (!isActiveSession(session)) {
      try { ws.close(); } catch (e) { /* ignore */ }
      return;
    }
    clearTimeout(session.connectTimer);
    session.connectTimer = null;

    console.log('✅ Connected to Soniox WebSocket');
    connectionStartTime = Date.now();
    lastAudioSentTime = Date.now();

    const sonioxConfig = buildSonioxConfig(config);
    try {
      ws.send(JSON.stringify(sonioxConfig));
    } catch (error) {
      console.error('❌ Error sending configuration to Soniox:', error.message);
      ws.terminate(); // close handler reconnects
      return;
    }
    isSonioxConfigured = false; // set true on first response
    console.log('📋 Config sent:', JSON.stringify({ ...sonioxConfig, api_key: '[redacted]', context: '[omitted]' }));

    // Soniox buffers audio while it processes the config, so audio can flow immediately
    sonioxConnectionState = 'connected';
    broadcastSonioxStatus('connected', `Connected: ${config.sourceLanguage} → ${config.targetLanguage}`);

    // Emit captions on time-based rules (idle, end of utterance, untranslated fallback)
    session.tickTimer = setInterval(() => {
      if (!isActiveSession(session)) return;
      emitSegments(session, session.segmenter.tick(Date.now()));
      publishOverlay(session);
    }, SEGMENTER_TICK_MS);

    // Soniox closes the stream after 20s without audio or keepalive
    session.keepaliveTimer = setInterval(() => {
      if (!isActiveSession(session) || session.ending || ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (now - Math.max(lastAudioSentTime, session.lastKeepaliveAt) >= KEEPALIVE_IDLE_MS) {
        try {
          ws.send(JSON.stringify({ type: 'keepalive' }));
          session.lastKeepaliveAt = now;
          session.keepaliveCount++;
          if (session.keepaliveCount % 12 === 1) {
            console.log('💓 No audio - sending keepalive to Soniox');
          }
        } catch (error) {
          console.error('❌ Keepalive send failed:', error.message);
        }
      }
    }, KEEPALIVE_CHECK_MS);
  });

  ws.on('message', (data) => {
    if (!isActiveSession(session)) return;

    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      console.error('❌ Could not parse Soniox message:', error.message);
      return;
    }

    session.messageCount++;
    if (session.messageCount === 1) {
      console.log('📥 First message from Soniox received');
    } else if (session.messageCount % 1000 === 0) {
      const uptime = connectionStartTime ? ((Date.now() - connectionStartTime) / 1000 / 60).toFixed(1) : 0;
      console.log(`📊 Processed ${session.messageCount} messages (${uptime} min uptime)`);
    }

    if (message.error_code || message.error_message) {
      console.error(`❌ Soniox error ${message.error_code || ''}: ${message.error_message || ''}`);
      if (isFatalSonioxError(message.error_code, message.error_message)) {
        session.fatalError = message.error_message || `Error ${message.error_code}`;
      }
      return; // Soniox closes the socket after an error; the close handler decides what to do
    }

    if (Array.isArray(message.tokens)) {
      if (!isSonioxConfigured) {
        isSonioxConfigured = true;
        console.log('✅ Soniox configuration confirmed - receiving transcriptions');
        broadcastServiceStatus('ready', 'Service is live - Translations appearing below');
      }
      if (message.tokens.length > 0 && session.messageCount <= 10) {
        logTokenBreakdown(session, message.tokens);
      }

      emitSegments(session, session.segmenter.ingest(message.tokens, Date.now()));
      publishOverlay(session);
    }

    if (message.finished === true) {
      console.log('🏁 Soniox confirmed end of stream');
      if (session.onFinished) session.onFinished();
    }
  });

  ws.on('error', (error) => {
    if (!isActiveSession(session)) return;
    clearTimeout(session.connectTimer);
    session.connectTimer = null;

    const errorMessage = error?.message || error?.toString() || 'Unknown error';
    console.error('❌ Soniox WebSocket error:', errorMessage, error?.code ? `(${error.code})` : '');
    sonioxConnectionState = 'error';
    broadcastSonioxStatus('error', `Connection error: ${errorMessage}`);
    // The close handler reconnects
  });

  ws.on('close', (code, reason) => {
    // A replaced or stopped session was already cleaned up by whoever replaced it
    if (!isActiveSession(session)) return;

    const reasonStr = reason?.toString() || '';
    const sessionDuration = connectionStartTime ? ((Date.now() - connectionStartTime) / 1000 / 60).toFixed(1) : 0;
    console.log(`🔌 Soniox WebSocket closed: ${code} ${reasonStr} (session ${session.id}, ${sessionDuration} min)`);

    if (session.ending) {
      // Graceful end in progress: finish it now
      if (session.onFinished) session.onFinished();
      return;
    }

    activeSession = null;
    teardownSession(session);
    // Never lose finals that were waiting for punctuation or a translation
    emitSegments(session, session.segmenter.flush('close', Date.now()));
    publishOverlay(session);
    isSonioxConfigured = false;
    sonioxConnectionState = 'disconnected';

    if (manualDisconnect) {
      broadcastSonioxStatus('disconnected', 'Connection stopped by user');
      return;
    }

    if (session.fatalError) {
      sonioxConnectionState = 'error';
      broadcastSonioxStatus('error', session.fatalError);
      broadcastServiceStatus('offline', SERVICE_DISCLAIMER);
      manualDisconnect = true; // retrying won't help (bad key, billing, bad config)
      return;
    }

    // Any other close (network drop, Soniox idle close, max stream duration) → reconnect.
    // 'connecting' keeps captions visible on phones, 'offline' would hide them.
    broadcastSonioxStatus('disconnected', `Connection closed (code: ${code}${reasonStr ? `, ${reasonStr}` : ''}) - reconnecting`);
    broadcastServiceStatus('connecting', SERVICE_DISCLAIMER);
    scheduleReconnect();
  });
}

let isReconnecting = false; // Prevent multiple simultaneous reconnect attempts

function scheduleReconnect() {
  if (manualDisconnect) {
    console.log('ℹ️ Manual disconnect active - skipping reconnect');
    return;
  }
  if (isReconnecting && reconnectTimeout) {
    return; // Already scheduled
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

  console.log(`🔄 Reconnecting to Soniox in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts})...`);
  sonioxConnectionState = 'connecting';
  broadcastSonioxStatus('connecting', `Reconnecting... (attempt ${reconnectAttempts})`);

  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    isReconnecting = false;
    if (!manualDisconnect && !activeSession) {
      connectToSoniox(currentSonioxConfig.apiKey, currentSonioxConfig.sourceLanguage, currentSonioxConfig.targetLanguage, { resume: true });
    }
  }, delay);
}

/**
 * Graceful shutdown handler
 */
let shuttingDown = false;

function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n🛑 Shutting down gracefully...');

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('⚠️ Forced shutdown');
    process.exit(1);
  }, 10000);

  // End Soniox first so the last words reach captions.log before the files close
  endSonioxSession(() => {
    wssClients.clients.forEach(client => client.close());
    wssCaptions.clients.forEach(client => client.close());

    logStream.end(() => {
      originalConsoleLog('📝 Log file closed');
    });
    captionsStream.end(() => {
      originalConsoleLog('📝 Captions file closed');
    });

    server.close(() => {
      originalConsoleLog('✅ Server closed');
      process.exit(0);
    });
  });
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
  console.log(`👥 Audience viewer: http://localhost:${PORT} (home page)`);
  console.log(`🔧 Admin/Client page: http://localhost:${PORT}/client`);
  console.log(`⏱️  Optimized for long-running sessions (3+ hours)`);
});

