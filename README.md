# Resolume Live Subtitles

A localhost web application that displays live translated subtitles for Resolume Arena. Captures microphone input, translates from Malayalam to English using Soniox, and displays the text on a transparent canvas suitable for Resolume Browser Source.

## Features

- 🎤 **Dual Audio Input**: Capture from microphone OR browser tab/system audio
- 🌐 **Live Translation**: Real-time Malayalam → English translation via Soniox
- 📺 **Resolume Ready**: Transparent HTML output perfect for Browser Source
- 🎨 **Broadcast Safe**: Centered, bottom-aligned subtitles with proper styling
- ⚡ **Real-time**: Only displays final captions (no partials)
- 🔄 **Auto-reconnect**: Handles connection drops gracefully
- 📊 **Live Logging**: Real-time server logs viewable in browser
- 📝 **Transcript Export**: Save caption history as TXT, CSV, or JSON
- ⏱️ **Real-time Updates**: SSE-based live streaming for logs and transcripts

## Architecture

```
Microphone → client.html → ws-server.js → Soniox WebSocket → ws-server.js → captions.html → Resolume
```

1. **client.html**: Captures microphone input, sends audio to server
2. **ws-server.js**: WebSocket server that:
   - Receives audio from client.html
   - Connects to Soniox for STT + translation
   - Forwards translated text to captions.html
3. **captions.html**: Displays subtitles on transparent background (for Resolume)

## Setup

### Option 1: Docker (Recommended for Mac/Cross-platform)

#### Prerequisites
- Docker Desktop installed on your Mac
- Docker Compose (included with Docker Desktop)

#### Steps

1. **Create `.env` file**:
   ```bash
   cd captions-app
   cp .env.example .env
   # Edit .env and add your Soniox API key
   ```

2. **Build and run with Docker Compose**:
   ```bash
   docker-compose up -d
   ```

3. **View logs** (optional):
   ```bash
   docker-compose logs -f
   ```

4. **Stop the container**:
   ```bash
   docker-compose down
   ```

The server will be available at `http://localhost:8080`

#### Docker Commands Reference

```bash
# Start in background
docker-compose up -d

# Start and view logs
docker-compose up

# Stop
docker-compose down

# Rebuild after code changes
docker-compose up -d --build

# View logs
docker-compose logs -f

# Check container status
docker-compose ps
```

### Option 2: Local Node.js Installation

#### 1. Install Dependencies

```bash
cd captions-app
npm install
```

#### 2. Configure Environment

Create a `.env` file:

```env
SONIOX_MASTER_API_KEY=your_api_key_here
PORT=8080
```

#### 3. Start the Server

```bash
npm start
```

The server will start on `http://localhost:8080`

## Usage

### Step 1: Open Caption Display

Open `http://localhost:8080` in a browser (or use this URL in Resolume Browser Source).

This will show the transparent subtitle display that Resolume will capture.

### Step 2: Start Audio Input

Open `http://localhost:8080/client.html` in a separate browser window/tab.

#### Option A: Microphone Mode
1. Select "🎤 Microphone" from the Audio Source dropdown
2. Choose your microphone device
3. Click "Start Recording"
4. Grant microphone permissions
5. Speak in Malayalam

#### Option B: Tab/System Audio Mode
1. Select "🖥️ Tab/System Audio (Screen Share)" from the dropdown
2. Click "Start Recording"
3. Browser will ask to share a screen/tab:
   - Select the Chrome Tab with your audio source (e.g., YouTube)
   - **IMPORTANT**: Check the "Share audio" checkbox
   - Click "Share"
4. Play your audio - it will be transcribed in real-time

### Step 3: Add to Resolume

1. In Resolume Arena, add a **Browser Source** layer
2. Set the URL to: `http://localhost:8080`
3. Enable **Transparent Background** (if available)
4. The subtitles will appear as an NDI RGBA stream with alpha channel

### Additional Features

#### View Live Server Logs
Open `http://localhost:8080/logs` to view:
- Real-time server activity
- Connection status
- Translation processing
- Errors and warnings
- Filter by log level (INFO, ERROR, WARN, DEBUG)
- Live updates via Server-Sent Events (no refresh needed)

#### View & Export Caption Transcript
Open `http://localhost:8080/transcript` to:
- View all captions with timestamps
- Export as TXT (with or without timestamps)
- Export as CSV (with or without timestamps)
- Export as JSON
- Real-time caption updates
- Clear caption history

## File Structure

```
captions-app/
├── captions.html      # Subtitle display (for Resolume)
├── client.html        # Audio input interface (mic or tab audio)
├── ws-server.js       # WebSocket server with logging & transcript
├── package.json       # Dependencies
├── server.log         # Server activity logs (auto-generated)
├── captions.log       # Caption transcript (auto-generated)
└── README.md          # This file
```

## Styling

The subtitle display is optimized for broadcast:

- **Position**: Centered horizontally, 85% from top (subtitle-safe area)
- **Max Width**: 80% of viewport
- **Max Lines**: 2 lines with natural wrapping
- **Font**: Responsive size (24px - 48px)
- **Color**: White (#ffffff) with text shadow for contrast
- **Background**: Fully transparent (true alpha)
- **Transitions**: Smooth fade-in/fade-out

## Technical Details

### HTTP Endpoints

- `http://localhost:8080/` - Caption display (for Resolume)
- `http://localhost:8080/client.html` - Audio input control panel
- `http://localhost:8080/logs` - Live server logs viewer
- `http://localhost:8080/transcript` - Caption transcript & export
- `http://localhost:8080/transcript?format=txt&timestamp=false` - Export TXT (no timestamps)
- `http://localhost:8080/transcript?format=csv&timestamp=true` - Export CSV (with timestamps)
- `http://localhost:8080/transcript?format=json` - Export JSON

### WebSocket Endpoints

- `ws://localhost:8080/client` - Browser clients (audio input)
- `ws://localhost:8080/captions` - Caption displays

### SSE Endpoints (Server-Sent Events)

- `http://localhost:8080/logs/stream` - Real-time log streaming
- `http://localhost:8080/transcript/stream` - Real-time caption streaming

### Audio Format

- **Sample Rate**: 16kHz
- **Channels**: Mono (1)
- **Format**: PCM 16-bit little-endian (s16le)

### Soniox Configuration

- **Model**: stt-rt-v3
- **Source Language**: Malayalam (ml)
- **Target Language**: English (en)
- **Translation**: One-way (ml → en)

## Troubleshooting

### No Subtitles Appearing

1. Check that the server is running: `npm start`
2. Verify microphone access in client.html
3. Check browser console for WebSocket errors
4. Ensure Soniox API key is correct in `.env`

### Audio Not Capturing

**Microphone Mode:**
1. Grant microphone permissions in browser
2. Check browser console for errors
3. Verify microphone is working in other applications

**Tab Audio Mode:**
1. Make sure to check "Share audio" when selecting the tab
2. Some tabs may not support audio capture (security restrictions)
3. Try selecting "Entire Screen" instead of "Chrome Tab"
4. Check browser console for errors

### Resolume Not Showing Transparent Background

1. Ensure Resolume Browser Source supports transparency
2. Check that `background: transparent` is set in captions.html
3. Verify Resolume is using the correct URL

## Export Formats

### TXT Export
- **With timestamps**: `[1/2/2026, 12:34:56 PM] Caption text`
- **Without timestamps**: `Caption text` only

### CSV Export
- **With timestamps**: Two columns (Timestamp, Caption)
- **Without timestamps**: One column (Caption)

### JSON Export
- Full data including timestamps and metadata
- Useful for programmatic access

## Notes

- This app is designed for **localhost use only**
- The caption display has no UI controls (as per Resolume requirements)
- Only **final** captions are displayed (partial results are ignored)
- The server handles reconnection automatically
- Log files (`server.log`, `captions.log`) persist between restarts
- Real-time updates use Server-Sent Events (SSE) - no polling required

## License

MIT

