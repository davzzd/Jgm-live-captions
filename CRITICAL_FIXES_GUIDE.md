# Critical Fixes Implementation Guide

## ✅ What Was Fixed

This document covers the 4 high-priority fixes implemented to ensure production stability and better user experience.

---

## 1. ✅ Persistent Token System

### **Problem:**
- Audience token regenerated on every server restart
- Subdomain links broke when server restarted
- Hard to maintain stable audience URL

### **Solution:**
Token is now stored in `.env` file for persistence across restarts.

### **Implementation:**

**Server-side (`ws-server.js`):**
```javascript
// Token loaded from environment variable
let AUDIENCE_TOKEN = process.env.AUDIENCE_TOKEN || crypto.randomBytes(16).toString('hex');

// Warning if not set
if (!process.env.AUDIENCE_TOKEN) {
  console.warn('⚠️  WARNING: AUDIENCE_TOKEN not set in .env file!');
  console.warn('⚠️  Token will change on server restart, breaking subdomain links.');
  console.warn(`⚠️  Add this to your .env file: AUDIENCE_TOKEN=${AUDIENCE_TOKEN}`);
}
```

### **Setup Instructions:**

**Step 1: Generate a secure token**
```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

**Step 2: Add to `.env` file**
```bash
# In captions-app/.env
AUDIENCE_TOKEN=a1b2c3d4e5f6789abcdef0123456789
```

**Step 3: Update nginx config (if using subdomain)**
```nginx
# In /etc/nginx/sites-available/jgm-captions
server {
    server_name translate.yourchurch.com;
    location / {
        set $audience_token "a1b2c3d4e5f6789abcdef0123456789";  # Same token!
        proxy_pass http://localhost:8080/audience/$audience_token;
    }
}
```

**Step 4: Restart services**
```bash
# Restart app
docker-compose restart

# Reload nginx
sudo systemctl reload nginx
```

### **Verification:**

```bash
# Check server logs on startup
docker-compose logs | grep "Audience token"

# Should see:
# ✅ Audience token is persistent (from .env)

# NOT:
# ⚠️  Audience token is temporary (will change on restart)
```

### **Testing:**

1. Start server
2. Note the audience URL
3. Restart server
4. Audience URL should be the same!

---

## 2. ✅ Pre-Service Status Display

### **Problem:**
- Audience sees "Waiting for translations..." with no context
- Don't know if service hasn't started or if there's a technical issue
- No indication of service state

### **Solution:**
Server broadcasts service status to audience viewers in real-time.

### **Implementation:**

**Server-side (`ws-server.js`):**
```javascript
// Service status tracking
let serviceStatus = {
  status: 'offline',  // 'offline', 'connecting', 'ready', 'paused', 'ended'
  message: 'Service has not started yet',
  timestamp: new Date().toISOString()
};

// Broadcast function
function broadcastServiceStatus(status, message) {
  serviceStatus = {
    type: 'status',
    status: status,
    message: message,
    timestamp: new Date().toISOString()
  };
  
  // Send to all audience viewers
  audienceSSEClients.forEach(client => {
    client.write(`data: ${JSON.stringify(serviceStatus)}\n\n`);
  });
}

// Called at key moments:
// - When Soniox connection starts: broadcastServiceStatus('connecting', '...')
// - When Soniox is ready: broadcastServiceStatus('ready', 'Service is live')
// - When connection stops: broadcastServiceStatus('ended', 'Service has ended')
```

**Client-side (`audience.html`):**
```javascript
// Handle status messages
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'status') {
    updateServiceStatus(data.status, data.message);
  } else if (data.type === 'caption') {
    addCaption(data);
  }
};

// Display status with appropriate icon and color
function updateServiceStatus(status, message) {
  const statusConfig = {
    'offline': { icon: '🔴', title: 'Service Not Started', color: '#f44336' },
    'connecting': { icon: '🟡', title: 'Connecting...', color: '#ff9800' },
    'ready': { icon: '🟢', title: 'Service is Live', color: '#4caf50' },
    'ended': { icon: '⏹️', title: 'Service Ended', color: '#9e9e9e' }
  };
  // ... update UI
}
```

### **Status Flow:**

```
1. Audience opens link
   └─> Shows: 🔴 "Service Not Started - Check back soon"

2. Admin starts Soniox
   └─> Shows: 🟡 "Connecting to translation service..."

3. Soniox confirms connection
   └─> Shows: 🟢 "Service is Live - Translations appearing below"

4. Admin stops Soniox
   └─> Shows: ⏹️ "Service Ended"

5. Connection lost (unintentional)
   └─> Shows: 🔴 "Connection lost - Reconnecting..."
```

### **Testing:**

1. Open audience page before starting service
   - Should see: "Service Not Started"
2. Start Soniox connection on admin page
   - Should change to: "Connecting..." then "Service is Live"
3. Stop Soniox connection
   - Should change to: "Service Ended"

---

## 3. ✅ Browser Tab Close Warning

### **Problem:**
- Admin accidentally closes browser tab
- All connections lost (Soniox, audio, WebSocket)
- Audience sees "Offline" with no warning
- Service disrupted

### **Solution:**
Browser shows confirmation dialog when trying to close tab while Soniox is connected.

### **Implementation:**

**Client-side (`client.html`):**
```javascript
window.addEventListener('beforeunload', (e) => {
  // Check if Soniox is connected
  const isSonioxConnected = sonioxStatusText && 
                             (sonioxStatusText.textContent.includes('Connected') || 
                              sonioxStatusText.textContent.includes('Live'));
  
  if (isSonioxConnected) {
    // Show browser warning
    e.preventDefault();
    e.returnValue = 'Soniox connection is active. Closing this tab will stop all translations. Are you sure?';
    return e.returnValue;
  }
  
  // Cleanup if not connected
  stopRecording();
  if (ws) {
    ws.close();
  }
});
```

### **User Experience:**

**Scenario 1: Soniox Connected**
```
User clicks X to close tab
  ↓
Browser shows dialog:
"Soniox connection is active. Closing this tab will 
 stop all translations. Are you sure?"
  ↓
User can:
  - Click "Leave" → Tab closes, service stops
  - Click "Stay" → Tab stays open, service continues
```

**Scenario 2: Soniox Not Connected**
```
User clicks X to close tab
  ↓
Tab closes immediately (no warning)
```

### **Testing:**

1. Open admin page
2. **Don't** start Soniox
3. Try to close tab → Should close immediately
4. Open admin page again
5. **Start** Soniox connection
6. Try to close tab → Should show warning dialog
7. Click "Stay" → Tab remains open
8. Stop Soniox connection
9. Try to close tab → Should close immediately

### **Note:**
- Warning only appears when Soniox is actively connected
- Browser may show its own generic message (browser-dependent)
- Modern browsers require user interaction for custom messages

---

## 4. ✅ Nginx Token Validation Endpoint

### **Problem:**
- Token mismatch between nginx and server is hard to debug
- Subdomain returns 404 with no helpful error message
- IT person doesn't know if token is wrong or something else

### **Solution:**
Added validation endpoint to check if nginx token matches server token.

### **Implementation:**

**Server-side (`ws-server.js`):**
```javascript
/**
 * Validate nginx token configuration
 * GET /api/audience-token/validate/:token
 */
app.get('/api/audience-token/validate/:token', (req, res) => {
  const providedToken = req.params.token;
  const isValid = providedToken === AUDIENCE_TOKEN;
  
  res.json({
    valid: isValid,
    message: isValid 
      ? 'Token is valid and matches server configuration' 
      : 'Token mismatch! Update nginx config or regenerate token.',
    currentToken: isValid ? AUDIENCE_TOKEN : `${AUDIENCE_TOKEN.substring(0, 8)}...`,
    providedToken: `${providedToken.substring(0, 8)}...`,
    hint: isValid 
      ? 'Nginx configuration is correct' 
      : 'Update nginx config: set $audience_token "' + AUDIENCE_TOKEN + '";'
  });
});
```

### **Usage:**

**Scenario 1: Check if token is valid**
```bash
# Get current server token
curl http://localhost:8080/api/audience-token

# Response:
# {
#   "token": "a1b2c3d4e5f6789...",
#   "url": "http://localhost:8080/audience/a1b2c3d4e5f6789...",
#   "activeViewers": 0
# }

# Validate token
curl http://localhost:8080/api/audience-token/validate/a1b2c3d4e5f6789...

# Response (if valid):
# {
#   "valid": true,
#   "message": "Token is valid and matches server configuration",
#   "currentToken": "a1b2c3d4e5f6789...",
#   "providedToken": "a1b2c3d4...",
#   "hint": "Nginx configuration is correct"
# }
```

**Scenario 2: Debug nginx mismatch**
```bash
# Nginx has wrong token
curl http://localhost:8080/api/audience-token/validate/wrong-token-here

# Response (if invalid):
# {
#   "valid": false,
#   "message": "Token mismatch! Update nginx config or regenerate token.",
#   "currentToken": "a1b2c3d4...",
#   "providedToken": "wrong-to...",
#   "hint": "Update nginx config: set $audience_token \"a1b2c3d4e5f6789...\";"
# }
```

### **Debugging Workflow:**

**Problem: Subdomain returns 404**

```bash
# Step 1: Get current server token
curl http://localhost:8080/api/audience-token | jq '.token'
# Output: "a1b2c3d4e5f6789..."

# Step 2: Check what token nginx is using
# Look in nginx config:
sudo grep 'audience_token' /etc/nginx/sites-available/jgm-captions
# Output: set $audience_token "old-token-xyz";

# Step 3: Validate nginx token
curl http://localhost:8080/api/audience-token/validate/old-token-xyz
# Output: { "valid": false, ... }

# Step 4: Fix nginx config
sudo nano /etc/nginx/sites-available/jgm-captions
# Update: set $audience_token "a1b2c3d4e5f6789...";

# Step 5: Reload nginx
sudo nginx -t && sudo systemctl reload nginx

# Step 6: Verify fix
curl http://localhost:8080/api/audience-token/validate/a1b2c3d4e5f6789...
# Output: { "valid": true, ... }
```

### **Integration with Regenerate:**

When regenerating token, server now warns about nginx:

```javascript
// POST /api/audience-token/regenerate
console.warn('⚠️  WARNING: If using subdomain with nginx, update nginx config with new token!');
console.warn(`⚠️  New token: ${AUDIENCE_TOKEN}`);

// Response includes warning
{
  "token": "new-token-here",
  "url": "http://localhost:8080/audience/new-token-here",
  "message": "Token regenerated successfully. Old links are now invalid.",
  "warning": "If using nginx subdomain, update nginx config with new token"
}
```

---

## 🧪 Complete Testing Checklist

### **Test 1: Persistent Token**
- [ ] Generate token, add to .env
- [ ] Start server, note audience URL
- [ ] Restart server
- [ ] Audience URL is the same
- [ ] Server logs show "✅ Audience token is persistent"

### **Test 2: Pre-Service Status**
- [ ] Open audience page (service not started)
- [ ] See "🔴 Service Not Started"
- [ ] Start Soniox on admin page
- [ ] Audience page shows "🟡 Connecting..."
- [ ] After config, shows "🟢 Service is Live"
- [ ] Stop Soniox
- [ ] Audience page shows "⏹️ Service Ended"

### **Test 3: Tab Close Warning**
- [ ] Open admin page (no Soniox)
- [ ] Close tab → No warning
- [ ] Open admin page, start Soniox
- [ ] Close tab → Warning appears
- [ ] Click "Stay" → Tab stays open
- [ ] Stop Soniox
- [ ] Close tab → No warning

### **Test 4: Token Validation**
- [ ] Get server token via API
- [ ] Validate correct token → Returns valid: true
- [ ] Validate wrong token → Returns valid: false
- [ ] Response includes helpful hint
- [ ] Regenerate token → Shows nginx warning

---

## 📋 Deployment Checklist

### **Before Deployment:**
- [ ] Generate persistent token
- [ ] Add to `.env` file
- [ ] Update nginx config with same token
- [ ] Test token validation endpoint
- [ ] Verify audience page shows status correctly

### **After Deployment:**
- [ ] Check server logs for token warnings
- [ ] Test audience page (should show "Service Not Started")
- [ ] Start Soniox, verify status changes
- [ ] Test tab close warning
- [ ] Validate nginx token matches server

### **Maintenance:**
- [ ] Document token in secure location
- [ ] Add token to backup procedures
- [ ] Train operators on tab close warning
- [ ] Monitor service status broadcasts

---

## 🚨 Troubleshooting

### **Issue: Token changes on restart**

**Symptom:** Subdomain breaks after server restart

**Cause:** `AUDIENCE_TOKEN` not in `.env`

**Fix:**
```bash
# Check if token is in .env
grep AUDIENCE_TOKEN captions-app/.env

# If not found, add it:
echo "AUDIENCE_TOKEN=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")" >> captions-app/.env

# Restart server
docker-compose restart
```

### **Issue: Subdomain returns 404**

**Symptom:** `https://translate.yourchurch.com` shows "Page not found"

**Diagnosis:**
```bash
# Get server token
curl http://localhost:8080/api/audience-token | jq '.token'

# Check nginx token
sudo grep 'audience_token' /etc/nginx/sites-available/jgm-captions

# Validate
curl http://localhost:8080/api/audience-token/validate/YOUR_NGINX_TOKEN
```

**Fix:** Update nginx config with correct token, reload nginx

### **Issue: Tab close warning not showing**

**Symptom:** Can close tab without warning even when connected

**Cause:** Browser security restrictions or Soniox status not detected

**Check:**
1. Open browser console (F12)
2. Check `sonioxStatusText.textContent`
3. Should include "Connected" or "Live"

**Fix:** Ensure Soniox is fully connected (green status)

### **Issue: Audience sees old status**

**Symptom:** Audience page shows "Service Not Started" but service is live

**Cause:** SSE connection not established or status not broadcast

**Check:**
```bash
# Check server logs
docker-compose logs -f | grep "Service status broadcast"

# Should see:
# 📢 Service status broadcast: ready - Service is live
```

**Fix:** Refresh audience page, check SSE connection in Network tab

---

## 📚 Related Documentation

- **Deployment Guide:** `AUDIENCE_DEPLOYMENT_GUIDE.md`
- **Quick Start:** `AUDIENCE_QUICK_START.md`
- **Nginx Config:** `nginx-subdomain.conf`
- **Implementation Summary:** `IMPLEMENTATION_SUMMARY.md`

---

**Version:** 1.0.0  
**Last Updated:** 2026-01-14  
**Status:** ✅ Production Ready


