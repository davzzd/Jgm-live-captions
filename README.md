# JGM Live Translation System

A comprehensive live translation system for church services. Captures audio, translates in real-time, displays captions in Resolume, and provides a mobile-friendly viewer for congregation members.

## Features

- 🎤 **Dual Audio Input**: Capture from microphone OR browser tab/system audio
- 🌐 **Live Translation**: Real-time translation via Soniox (100+ languages)
- 📺 **Resolume Ready**: Transparent HTML output perfect for Browser Source
- 👥 **Audience Viewer**: Mobile-first page for congregation members to view translations
- 🔗 **Shareable Links**: One-click copy, QR codes, and secure token system
- ✏️ **Live Editing**: Edit captions on-the-fly, broadcasts to all viewers
- 🎨 **Broadcast Safe**: Centered, bottom-aligned subtitles with proper styling
- ⚡ **Real-time**: Low-latency translation and caption delivery
- 🔄 **Auto-reconnect**: Handles connection drops gracefully
- 📊 **Live Logging**: Real-time server logs viewable in browser
- 📝 **Transcript Export**: Save caption history as TXT, CSV, JSON, or SRT
- ⏱️ **Real-time Updates**: SSE-based live streaming for logs and transcripts
- 🔒 **Secure**: Token-based audience access, subdomain isolation

## Architecture

```
┌─────────────┐
│ Microphone  │
│  or Tab     │
└──────┬──────┘
       │
       v
┌─────────────────┐
│  client.html    │  ← Admin Control Panel
│  (localhost/)   │
└────────┬────────┘
         │ WebSocket
         v
┌─────────────────┐
│  ws-server.js   │  ← Node.js Server
│                 │
│  • Soniox API   │
│  • SSE Streams  │
│  • Token Mgmt   │
└────┬───┬───┬────┘
     │   │   │
     │   │   └──────────────┐
     │   │                  │
     v   v                  v
┌─────────┐  ┌──────────┐  ┌──────────────┐
│captions │  │transcript│  │ audience.html│
│  .html  │  │  .html   │  │ /audience/:  │
│         │  │          │  │   token      │
│Resolume │  │Edit View │  │              │
│ Overlay │  │          │  │Mobile Viewer │
└─────────┘  └──────────┘  └──────────────┘
```

**Components:**

1. **client.html** (`/`): Admin control panel
   - Audio capture (mic or tab)
   - Soniox connection controls
   - Settings management
   - Audience link generation

2. **ws-server.js**: Backend server
   - WebSocket for audio streaming
   - Soniox API integration
   - SSE for real-time updates
   - Token-based audience access

3. **captions.html** (`/captions`): Resolume overlay
   - Transparent background
   - Customizable styling
   - Real-time caption display

4. **transcript.html** (`/transcript`): Caption history
   - Full session transcript
   - Inline editing
   - Export (TXT, CSV, JSON, SRT)

5. **audience.html** (`/audience/:token`): Public viewer
   - Mobile-first design
   - Read-only access
   - Shows last 6 captions
   - Auto-updates via SSE

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

### Quick Start

1. **Start Server**: `npm start` or `docker-compose up -d`
2. **Open Admin Panel**: http://localhost:8080
3. **Configure Soniox**: Enter API key, select languages
4. **Start Connection**: Click "Start Soniox Connection"
5. **Share Audience Link**: Copy link or show QR code from settings panel
6. **Add to Resolume**: Use http://localhost:8080/captions as Browser Source

### Detailed Usage

#### For Administrators:

**Step 1: Open Admin Control Panel**

Open `http://localhost:8080` in your browser.

This is your main control panel with:
- Audio input controls
- Live caption preview
- Settings panel (right side)
- Navigation to other pages

**Step 2: Configure Soniox Connection**

In the settings panel (right side):
1. Enter your Soniox API key
2. Select source language (e.g., Malayalam)
3. Select target language (e.g., English)
4. Click "Start Soniox Connection"
5. Wait for green "Connected" status

**Step 3: Start Audio Capture**

Choose your audio source:
- **Microphone**: Click "🎤 Start Microphone"
- **Tab Audio**: Click "🖥️ Start Tab Audio" (for streaming audio)

You should see:
- Audio waveform moving
- Captions appearing in real-time

**Step 4: Share with Audience**

In the "👥 Audience Link" section:
1. Click "📋 Copy" to copy the link
2. Or click "📱 Show QR Code" to display QR code
3. Share via WhatsApp, SMS, or display QR on screen
4. Monitor "Active viewers" count

**Step 5: Setup Resolume Overlay**

In Resolume Arena:
1. Add a new layer
2. Add "Browser Source" effect
3. Enter URL: `http://localhost:8080/captions`
4. Adjust position/size as needed

#### For Audience Members:

**Step 1: Get the Link**

Receive the audience link from:
- WhatsApp/SMS message
- QR code scan
- Printed handout

**Step 2: Open on Phone/Tablet**

1. Open the link in any browser
2. Page will show "Live Translation"
3. Status will change from "Connecting..." to "Live"

**Step 3: View Translations**

- Last 6 captions will be displayed
- New captions appear automatically
- Page auto-scrolls when at bottom
- Works in portrait or landscape mode

**No app installation required!**

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

#### Edit Captions On-the-Fly

1. Open `http://localhost:8080/transcript` in a new tab
2. Click the ✏️ edit button next to any caption
3. Make your correction
4. Click ✅ save
5. **Edit broadcasts to all audience viewers automatically!**

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

## Audience Viewer Deployment

For production deployment with subdomains (e.g., `translate.yourchurch.com`), see:

- **Quick Start**: `AUDIENCE_QUICK_START.md`
- **Full Deployment Guide**: `AUDIENCE_DEPLOYMENT_GUIDE.md`
- **Nginx Configuration**: `nginx-subdomain.conf`

### Key Features:
- ✅ Secure token-based access
- ✅ Mobile-first responsive design
- ✅ One-click link copying
- ✅ QR code generation
- ✅ Real-time viewer count
- ✅ Live caption editing
- ✅ Subdomain isolation

### Quick Deploy:
```bash
# 1. Deploy with Docker
docker-compose up -d --build

# 2. Get audience token
curl http://localhost:8080/api/audience-token

# 3. Configure Nginx (see nginx-subdomain.conf)
sudo cp nginx-subdomain.conf /etc/nginx/sites-available/jgm-captions
# Edit file with your domain and token
sudo ln -s /etc/nginx/sites-available/jgm-captions /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 4. Setup SSL
sudo certbot --nginx -d admin.yourchurch.com -d translate.yourchurch.com
```

## License

MIT

