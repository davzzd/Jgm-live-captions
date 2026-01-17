# Audience Translation Viewer - Deployment Guide

## Overview

The Audience Translation Viewer is a mobile-first, read-only page where church members can view live translations on their phones or tablets during services. This guide covers setup, deployment, and usage.

---

## 🎯 Features

### For Administrators:
- ✅ Generate secure, shareable audience links
- ✅ Copy link with one click
- ✅ Generate QR codes for easy mobile access
- ✅ Regenerate links to invalidate old ones
- ✅ Monitor active viewers in real-time
- ✅ Edit captions on-the-fly (broadcasts to audience)

### For Audience:
- ✅ Mobile-first, responsive design
- ✅ Shows last 6 captions in large, readable text
- ✅ Auto-scrolls when at bottom
- ✅ Light/dark mode support
- ✅ Works offline (shows cached captions)
- ✅ No navigation to admin pages
- ✅ Clean, distraction-free interface

---

## 🚀 Quick Start (Local Testing)

### 1. Start the Server

```bash
cd captions-app
npm start
```

### 2. Access Admin Page

Open http://localhost:8080 in your browser

### 3. Get Audience Link

1. Look for the **"👥 Audience Link"** section in the settings panel
2. Click **"📋 Copy"** to copy the link
3. Or click **"📱 Show QR Code"** to display a QR code

### 4. Share with Audience

- **Option A**: Send the link via WhatsApp, email, or SMS
- **Option B**: Display the QR code on screen for people to scan
- **Option C**: Project the QR code on a slide before the service

### 5. Test the Audience View

1. Open the copied link in a new browser tab or on your phone
2. You should see "Live Translation" page
3. Start speaking into your microphone on the admin page
4. Translations will appear on the audience page in real-time

---

## 🌐 Production Deployment with Subdomains

### Prerequisites

- A domain name (e.g., `yourchurch.com`)
- A server with:
  - Ubuntu 20.04+ or similar Linux distribution
  - Docker and Docker Compose installed
  - Nginx installed
  - Port 80 and 443 open

### Step 1: DNS Configuration

Add two A records in your domain's DNS settings:

```
admin.yourchurch.com    →  YOUR_SERVER_IP
translate.yourchurch.com →  YOUR_SERVER_IP
```

Wait for DNS propagation (5-30 minutes).

### Step 2: Deploy with Docker

```bash
# Navigate to project
cd captions-app

# Build and start container
docker-compose up -d --build

# Verify it's running
docker-compose ps
docker-compose logs -f
```

### Step 3: Get Audience Token

```bash
# Get the token from the running container
curl http://localhost:8080/api/audience-token

# Response will look like:
# {
#   "token": "a1b2c3d4e5f6...",
#   "url": "http://localhost:8080/audience/a1b2c3d4e5f6...",
#   "activeViewers": 0
# }

# Copy the token value (you'll need it for nginx config)
```

### Step 4: Configure Nginx

```bash
# Copy the nginx config template
sudo cp nginx-subdomain.conf /etc/nginx/sites-available/jgm-captions

# Edit the config
sudo nano /etc/nginx/sites-available/jgm-captions
```

**Important changes to make:**

1. Replace `translate.yourchurch.com` with your actual audience domain
2. Replace `admin.yourchurch.com` with your actual admin domain
3. Replace `YOUR_AUDIENCE_TOKEN_HERE` with the token from Step 3

```nginx
# Line 28: Update audience domain
server_name translate.yourchurch.com;  # Your actual domain

# Line 36: Update token
set $audience_token "a1b2c3d4e5f6...";  # Your actual token from Step 3

# Line 83: Update admin domain
server_name admin.yourchurch.com;  # Your actual domain
```

```bash
# Enable the site
sudo ln -s /etc/nginx/sites-available/jgm-captions /etc/nginx/sites-enabled/

# Test nginx configuration
sudo nginx -t

# If test passes, reload nginx
sudo systemctl reload nginx
```

### Step 5: Setup SSL (HTTPS)

```bash
# Install certbot if not already installed
sudo apt update
sudo apt install certbot python3-certbot-nginx

# Get SSL certificates for both domains
sudo certbot --nginx -d admin.yourchurch.com -d translate.yourchurch.com

# Follow the prompts:
# - Enter your email
# - Agree to terms
# - Choose whether to redirect HTTP to HTTPS (recommended: yes)

# Certbot will automatically update your nginx config

# Test auto-renewal
sudo certbot renew --dry-run
```

### Step 6: Verify Deployment

**Test Admin Page:**
```
https://admin.yourchurch.com
```
- Should show the main control panel
- Settings panel should be visible
- Audience Link section should show the full URL

**Test Audience Page:**
```
https://translate.yourchurch.com
```
- Should show "Live Translation" page
- Status should show "Connecting..." then "Live"
- No navigation or admin controls visible

---

## 📱 Usage During Service

### Before Service Starts:

1. **Setup Equipment**
   - Connect microphone or audio source
   - Open admin page: `https://admin.yourchurch.com`
   - Test audio levels

2. **Start Translation**
   - Enter Soniox API key (if not saved)
   - Select source language (e.g., Malayalam)
   - Select target language (e.g., English)
   - Click "Start Soniox Connection"
   - Verify status shows "Connected"

3. **Share Audience Link**
   - **Method 1 (QR Code):**
     - Click "📱 Show QR Code" in Audience Link section
     - Display QR code on projector/screen
     - Ask congregation to scan with phone camera
   
   - **Method 2 (Direct Link):**
     - Click "📋 Copy" to copy link
     - Send via WhatsApp group, SMS, or email
   
   - **Method 3 (Printed):**
     - Print QR code on bulletin/handout
     - Place at entrance for visitors

4. **Verify Audience Connection**
   - Check "Active viewers" count
   - Should increase as people join

### During Service:

1. **Monitor Translation Quality**
   - Watch captions on admin page
   - Check `/transcript` page for full history

2. **Edit Mistakes**
   - Open `/transcript` in new tab
   - Click ✏️ edit button on any caption
   - Make correction
   - Click ✅ save
   - **Edits broadcast to audience automatically**

3. **Monitor Audience**
   - "Active viewers" count shows how many are connected
   - If count drops suddenly, check internet connection

### After Service:

1. **Stop Translation**
   - Click "Stop Soniox Connection"
   - Audience viewers will see "Offline" status

2. **Export Transcript** (optional)
   - Go to `/transcript`
   - Click "Download TXT" or "Download SRT"
   - Save for records

3. **Regenerate Link** (optional for security)
   - Click "🔄 Regenerate Link"
   - Old link will stop working
   - Share new link for next service

---

## 🔒 Security Best Practices

### 1. Token Management

**Regenerate tokens regularly:**
```bash
# Via admin UI: Click "Regenerate Link" button
# Or via API:
curl -X POST https://admin.yourchurch.com/api/audience-token/regenerate
```

**When to regenerate:**
- After each service (if link was widely shared)
- If link was accidentally posted publicly
- Monthly as a security practice

### 2. Admin Access Protection

**Option A: IP Whitelist (Recommended)**

Edit `/etc/nginx/sites-available/jgm-captions`:

```nginx
server {
    server_name admin.yourchurch.com;
    
    # Only allow access from specific IPs
    allow 203.0.113.0/24;  # Your church network
    allow 198.51.100.5;    # Your home IP
    deny all;
    
    # ... rest of config
}
```

**Option B: Password Protection**

```bash
# Install apache2-utils
sudo apt install apache2-utils

# Create password file
sudo htpasswd -c /etc/nginx/.htpasswd admin

# Add to nginx config
location / {
    auth_basic "Admin Access";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://localhost:8080;
}
```

### 3. HTTPS Only

Ensure both subdomains use HTTPS:
- Certbot handles this automatically
- Force HTTPS redirect in nginx (certbot does this)

### 4. Firewall Configuration

```bash
# Allow only necessary ports
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 22/tcp  # SSH
sudo ufw enable
```

---

## 🎨 Customization

### Audience Page Styling

Edit `captions-app/audience.html`:

**Change colors:**
```css
:root {
  --bg-primary: #1a1a1a;        /* Background color */
  --text-primary: #ffffff;       /* Text color */
  --accent: #4a9eff;             /* Accent color */
}
```

**Change font size:**
```css
:root {
  --font-size-caption: 20px;     /* Mobile */
}

@media (min-width: 768px) {
  :root {
    --font-size-caption: 24px;   /* Tablet */
  }
}
```

**Change number of visible captions:**

Edit `captions-app/ws-server.js`:
```javascript
const AUDIENCE_CAPTION_LIMIT = 6; // Change to 8, 10, etc.
```

### Branding

Add your church logo to audience page:

```html
<!-- In audience.html, inside .header-content -->
<div class="title">
  <img src="/path/to/logo.png" alt="Logo" style="height: 24px;">
  <span>Live Translation</span>
</div>
```

---

## 🐛 Troubleshooting

### Issue: Audience page shows "Page not found"

**Cause:** Token mismatch between nginx and server

**Solution:**
```bash
# Get current token
curl http://localhost:8080/api/audience-token

# Update nginx config with correct token
sudo nano /etc/nginx/sites-available/jgm-captions

# Reload nginx
sudo systemctl reload nginx
```

### Issue: Captions not appearing on audience page

**Checks:**
1. Is Soniox connected? (Check admin page status)
2. Is audio being captured? (Check waveform on admin page)
3. Are captions appearing on admin page?
4. Open browser console (F12) on audience page - any errors?

**Solution:**
```bash
# Check server logs
docker-compose logs -f

# Look for:
# - "👥 Audience viewer connected"
# - "📝 Final translation caption: ..."
# - "broadcastToAudience" messages
```

### Issue: SSL certificate errors

**Solution:**
```bash
# Renew certificates
sudo certbot renew

# If renewal fails, check DNS
nslookup translate.yourchurch.com
nslookup admin.yourchurch.com

# Both should point to your server IP
```

### Issue: High latency (slow translations)

**Causes:**
- Network latency to Soniox API
- Server overload
- Too many audience viewers

**Solutions:**
1. Check server resources: `docker stats`
2. Upgrade server if CPU/RAM maxed out
3. Use CDN for audience page (advanced)

### Issue: Audience viewers disconnecting

**Cause:** Nginx timeout settings too low

**Solution:**

Edit `/etc/nginx/sites-available/jgm-captions`:
```nginx
location ~ ^/audience/([^/]+)/stream$ {
    proxy_read_timeout 24h;  # Increase from default
    # ... other settings
}
```

---

## 📊 Monitoring

### View Active Viewers

**In Admin UI:**
- Check "Active viewers" count in Audience Link section

**Via API:**
```bash
curl https://admin.yourchurch.com/api/audience-token
```

### Server Logs

```bash
# Real-time logs
docker-compose logs -f

# Search for audience-related logs
docker-compose logs | grep "👥"

# Check for errors
docker-compose logs | grep "ERROR"
```

### Nginx Access Logs

```bash
# View audience page access
sudo tail -f /var/log/nginx/access.log | grep "/audience/"

# Count unique IPs (approximate viewer count)
sudo grep "/audience/" /var/log/nginx/access.log | awk '{print $1}' | sort -u | wc -l
```

---

## 🔄 Backup and Recovery

### Backup Caption History

```bash
# Backup captions.log
docker cp jgm-live-captions:/app/captions.log ./backup/captions-$(date +%Y%m%d).log

# Automate with cron (daily at 2 AM)
0 2 * * * docker cp jgm-live-captions:/app/captions.log /backup/captions-$(date +\%Y\%m\%d).log
```

### Backup Configuration

```bash
# Backup nginx config
sudo cp /etc/nginx/sites-available/jgm-captions ./backup/

# Backup .env file
cp captions-app/.env ./backup/

# Backup audience token
curl http://localhost:8080/api/audience-token > ./backup/audience-token.json
```

---

## 📈 Scaling for Large Audiences

### For 100+ Concurrent Viewers:

1. **Use a CDN** (Cloudflare, AWS CloudFront)
   - Cache audience.html
   - Proxy SSE stream through CDN

2. **Horizontal Scaling**
   - Run multiple server instances
   - Use load balancer (nginx, HAProxy)
   - Share state via Redis

3. **Optimize SSE**
   - Reduce heartbeat frequency
   - Compress messages
   - Use WebSocket instead of SSE

### Example: Cloudflare Setup

1. Add domain to Cloudflare
2. Enable "Orange Cloud" for both subdomains
3. Set SSL/TLS to "Full (strict)"
4. Create Page Rule for audience subdomain:
   - URL: `translate.yourchurch.com/*`
   - Cache Level: Standard
   - Browser Cache TTL: 4 hours

---

## 🆘 Support

### Common Questions

**Q: Can I use a single domain instead of subdomains?**

A: Yes! Use the alternative nginx config at the bottom of `nginx-subdomain.conf`. Access will be:
- Admin: `yourchurch.com/admin`
- Audience: `yourchurch.com/jgmtranslate`

**Q: Can audience members edit captions?**

A: No, the audience page is read-only. Only admins can edit via the `/transcript` page.

**Q: How much data does the audience page use?**

A: Very little - approximately 1-2 KB per caption, or ~100-200 KB per hour.

**Q: Does it work offline?**

A: The page caches the last 6 captions, so if connection drops briefly, viewers still see recent captions. When connection returns, it auto-reconnects.

**Q: Can I have multiple audience pages for different languages?**

A: Yes! You can run multiple Soniox connections with different target languages and create separate audience tokens for each. This requires code modifications.

---

## ✅ Checklist for First Service

- [ ] Server deployed and running
- [ ] DNS configured for both subdomains
- [ ] SSL certificates installed
- [ ] Nginx configured with correct token
- [ ] Admin page accessible
- [ ] Audience page accessible
- [ ] Soniox API key configured
- [ ] Audio source tested
- [ ] Translation tested end-to-end
- [ ] QR code generated and tested
- [ ] Backup plan if internet fails
- [ ] Phone number to text link to latecomers

---

## 📞 Emergency Contacts

**If something goes wrong during service:**

1. **No internet:** Have printed transcripts ready
2. **Server down:** Restart: `docker-compose restart`
3. **Audience link not working:** Regenerate token and share new link
4. **Audio not working:** Check microphone permissions in browser

**Quick restart command:**
```bash
cd captions-app && docker-compose restart && docker-compose logs -f
```

---

**Last Updated:** 2026-01-14
**Version:** 1.0.0


