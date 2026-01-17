# Audience Translation Viewer - Quick Start

## 🎯 What is this?

A mobile-friendly page where church members can view live translations on their phones/tablets during services.

---

## ⚡ 5-Minute Setup (Local Testing)

### 1. Start Server
```bash
cd captions-app
npm start
```

### 2. Open Admin Page
```
http://localhost:8080
```

### 3. Get Audience Link
- Look for **"👥 Audience Link"** in settings panel (right side)
- Click **"📋 Copy"** button
- Or click **"📱 Show QR Code"**

### 4. Share Link
- Send via WhatsApp/SMS
- Or scan QR code with phone

### 5. Test
- Open link on phone
- Start speaking on admin page
- See translations appear on phone!

---

## 📱 How It Looks

### Admin View (Your Screen)
```
┌─────────────────────────────────────┐
│ 🏠 JGM Live Translation             │
├─────────────────────────────────────┤
│                                     │
│ [Audio Waveform]                    │
│ [Live Captions]                     │
│                                     │
│ Settings Panel:                     │
│ ┌─────────────────────────────────┐ │
│ │ 👥 Audience Link                │ │
│ │ ─────────────────────────────── │ │
│ │ http://localhost:8080/audience/ │ │
│ │ abc123...                       │ │
│ │                                 │ │
│ │ [📋 Copy]  [📱 QR]  [🔄 Regen] │ │
│ │                                 │ │
│ │ 👁️ Active viewers: 5            │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### Audience View (Their Phones)
```
┌─────────────────────────────────────┐
│ 🌐 Live Translation        🟢 Live  │
├─────────────────────────────────────┤
│                                     │
│  12:34 PM                           │
│  Welcome to the service today.      │
│                                     │
│  12:35 PM                           │
│  We will begin with a song of       │
│  praise.                            │
│                                     │
│  12:36 PM                           │
│  Please turn to page 42 in your     │
│  hymnals.                           │
│                                     │
│  [Auto-scrolls as new captions      │
│   appear...]                        │
│                                     │
└─────────────────────────────────────┘
```

---

## 🎬 Usage Workflow

### Before Service:
1. ✅ Start server
2. ✅ Open admin page
3. ✅ Start Soniox connection
4. ✅ Test audio
5. ✅ Share audience link/QR code

### During Service:
1. 🎤 Speak into microphone
2. 👀 Monitor translations on admin page
3. ✏️ Edit mistakes in `/transcript` page
4. 📊 Watch "Active viewers" count

### After Service:
1. 🛑 Stop Soniox connection
2. 💾 Export transcript (optional)
3. 🔄 Regenerate link (optional)

---

## 🔑 Key Features

### For You (Admin):
- ✅ One-click copy link
- ✅ QR code generation
- ✅ Edit captions on-the-fly
- ✅ Monitor viewer count
- ✅ Regenerate link anytime

### For Audience:
- ✅ Mobile-optimized (works on any phone)
- ✅ Large, readable text
- ✅ Auto-scrolls
- ✅ Dark/light mode
- ✅ Works offline (caches last 6 captions)
- ✅ No ads, no tracking, no login required

---

## 🚀 Production Deployment

### Option 1: Subdomains (Recommended)
```
Admin:    https://admin.yourchurch.com
Audience: https://translate.yourchurch.com
```

**Setup:** See `AUDIENCE_DEPLOYMENT_GUIDE.md`

### Option 2: Single Domain
```
Admin:    https://yourchurch.com/admin
Audience: https://yourchurch.com/jgmtranslate
```

**Setup:** Use alternative nginx config in `nginx-subdomain.conf`

---

## 🔒 Security

### Token System
- Each audience link has a unique token
- Token is hard to guess (32 random characters)
- Regenerate token to invalidate old links
- No way to access admin pages from audience link

### Best Practices:
1. ✅ Regenerate token after each service
2. ✅ Use HTTPS in production
3. ✅ Password-protect admin page (optional)
4. ✅ Monitor active viewers

---

## 🐛 Troubleshooting

### "Page not found" on audience link
**Fix:** Restart server, get new link

### Captions not showing
**Check:**
1. Is Soniox connected? (green dot on admin page)
2. Is audio being captured? (waveform moving)
3. Are captions showing on admin page?

### Slow translations
**Causes:**
- Slow internet
- Soniox API latency
- Server overload

**Fix:** Check internet speed, upgrade server

### Viewers disconnecting
**Fix:** Increase nginx timeout (see deployment guide)

---

## 📞 Quick Commands

### Restart Server
```bash
cd captions-app
docker-compose restart
```

### Get Current Link
```bash
curl http://localhost:8080/api/audience-token
```

### View Logs
```bash
docker-compose logs -f | grep "👥"
```

### Check Active Viewers
```bash
curl http://localhost:8080/api/audience-token | jq '.activeViewers'
```

---

## 💡 Pro Tips

### Tip 1: Pre-Service QR Code
- Generate QR code before service
- Display on projector as people arrive
- Save QR image for bulletin/handout

### Tip 2: WhatsApp Group
- Create church WhatsApp group
- Share link at start of service
- Easy for members to access

### Tip 3: Printed Cards
- Print QR codes on business cards
- Hand to visitors who don't understand language
- Reusable if you don't regenerate token

### Tip 4: Multiple Languages
- Run multiple instances for different target languages
- Example: Malayalam → English, Malayalam → Hindi
- Give each a different subdomain

### Tip 5: Backup Plan
- Have printed transcripts ready
- Test everything before service
- Keep phone hotspot as backup internet

---

## 📊 Typical Usage Stats

### Data Usage (per viewer):
- **Initial load:** ~50 KB (HTML, CSS, JS)
- **Per caption:** ~100 bytes
- **Per hour:** ~100-200 KB total
- **Very mobile-data friendly!**

### Latency:
- **Microphone → Soniox:** ~500ms
- **Soniox → Server:** ~200ms
- **Server → Audience:** ~100ms
- **Total delay:** ~1 second

### Capacity:
- **Small church (10-50 viewers):** Any server works
- **Medium (50-200 viewers):** 2GB RAM, 2 CPU cores
- **Large (200+ viewers):** Use CDN, load balancer

---

## ✅ Pre-Service Checklist

**5 Minutes Before:**
- [ ] Server running
- [ ] Admin page open
- [ ] Soniox connected (green dot)
- [ ] Audio test passed
- [ ] QR code displayed/link shared
- [ ] At least 1 test viewer connected
- [ ] `/transcript` page open in another tab (for editing)

**If something fails:**
1. Check internet connection
2. Restart server: `docker-compose restart`
3. Regenerate link if needed
4. Have backup plan ready

---

## 🎓 Training New Operators

### What they need to know:
1. How to start/stop Soniox connection
2. How to share audience link
3. How to edit captions in `/transcript`
4. How to check if viewers are connected
5. Emergency restart command

### Practice session:
1. Start server
2. Connect Soniox
3. Share link with trainer's phone
4. Speak and verify translations appear
5. Make an intentional mistake
6. Edit it in `/transcript`
7. Verify edit appears on phone
8. Stop connection

**Time needed:** 15 minutes

---

## 📚 More Help

- **Full deployment guide:** `AUDIENCE_DEPLOYMENT_GUIDE.md`
- **Nginx configuration:** `nginx-subdomain.conf`
- **Server logs:** `docker-compose logs -f`
- **API documentation:** Check `/api/audience-token` endpoint

---

**Questions? Check the full deployment guide or server logs for details.**

**Version:** 1.0.0 | **Last Updated:** 2026-01-14


