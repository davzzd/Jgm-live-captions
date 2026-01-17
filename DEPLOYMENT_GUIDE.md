# Deployment Guide - JGM Live Translation

## 🚀 Overview

This guide covers deploying the JGM Live Translation application for production use.

## 📋 Pre-Deployment Checklist

### 1. Configuration
- [ ] Soniox API key ready
- [ ] `.env` file configured (if using server-side key)
- [ ] Port configuration decided (default: 8080)
- [ ] YouTube Caption URL configured (optional)

### 2. Security
- [ ] Remove any hardcoded API keys from code
- [ ] Enable environment variables only
- [ ] Consider rate limiting for production
- [ ] Review CORS settings if needed

## 🌐 Deployment Options

### Option 1: VPS Deployment (Recommended for Production)

**Platforms**: DigitalOcean, Linode, AWS EC2, Google Cloud Compute Engine

**Pros**:
- Full control over environment
- Cost-effective for long-running applications ($5-20/month)
- Easy to scale resources
- Docker-ready

**Cons**:
- Requires server management
- Manual SSL/TLS setup
- Responsible for security updates

#### Steps:

1. **Provision VPS**
   ```bash
   # Recommended specs:
   # - 1 vCPU, 1GB RAM (minimum)
   # - 2 vCPU, 2GB RAM (recommended)
   # - Ubuntu 22.04 LTS or similar
   ```

2. **Install Docker**
   ```bash
   # On Ubuntu/Debian
   curl -fsSL https://get.docker.com -o get-docker.sh
   sudo sh get-docker.sh
   sudo usermod -aG docker $USER
   ```

3. **Clone Repository**
   ```bash
   git clone <your-repo-url>
   cd jgmvc/captions-app
   ```

4. **Configure Environment**
   ```bash
   # Copy env example
   cp .env.example .env
   
   # Edit .env with your settings
   nano .env
   ```

5. **Deploy with Docker**
   ```bash
   # Build and run
   docker-compose up -d
   
   # Check logs
   docker-compose logs -f
   ```

6. **Setup Reverse Proxy (Nginx)**
   ```nginx
   # /etc/nginx/sites-available/captions
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://localhost:8080;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

7. **Enable SSL with Let's Encrypt**
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d your-domain.com
   ```

### Option 2: Platform-as-a-Service (Easiest)

**Platforms**: Railway, Render, Fly.io

**Pros**:
- Easiest deployment
- Automatic SSL/TLS
- Git-based deployment
- Auto-scaling

**Cons**:
- Higher cost
- Less control
- Platform-specific limitations

#### Railway Deployment:

1. **Connect Repository**
   - Go to [railway.app](https://railway.app)
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository

2. **Configure Environment Variables**
   ```
   PORT=8080
   SONIOX_MASTER_API_KEY=your_key_here
   YOUTUBE_CAPTION_URL=your_youtube_url (optional)
   NODE_ENV=production
   ```

3. **Configure Build**
   - Root Directory: `/captions-app`
   - Build Command: `npm install`
   - Start Command: `npm start`

4. **Deploy**
   - Railway will automatically deploy
   - Get your public URL

#### Render Deployment:

1. **Create New Web Service**
   - Go to [render.com](https://render.com)
   - New → Web Service
   - Connect repository

2. **Configure Service**
   ```
   Name: jgm-captions
   Root Directory: captions-app
   Environment: Node
   Build Command: npm install
   Start Command: npm start
   ```

3. **Add Environment Variables** (same as Railway)

4. **Deploy** - Render will build and deploy automatically

### Option 3: Docker Hub + Remote Server

1. **Build and Push Image**
   ```bash
   # Build image
   docker build -t yourusername/jgm-captions:latest .
   
   # Push to Docker Hub
   docker push yourusername/jgm-captions:latest
   ```

2. **Pull and Run on Remote Server**
   ```bash
   # On your server
   docker pull yourusername/jgm-captions:latest
   docker run -d -p 8080:8080 \
     -e SONIOX_MASTER_API_KEY=your_key \
     --restart unless-stopped \
     yourusername/jgm-captions:latest
   ```

## 🔐 Security Best Practices

### 1. Environment Variables
Never commit API keys. Always use environment variables:
```bash
# .env file (add to .gitignore)
SONIOX_MASTER_API_KEY=your_actual_key_here
```

### 2. Rate Limiting
Add rate limiting for production:
```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use(limiter);
```

### 3. CORS Configuration
Restrict CORS to your domain:
```javascript
const cors = require('cors');

app.use(cors({
  origin: 'https://your-domain.com',
  credentials: true
}));
```

### 4. HTTPS Only
Always use HTTPS in production. Use Let's Encrypt for free certificates.

## 📊 Monitoring & Logging

### 1. PM2 (for non-Docker deployments)
```bash
# Install PM2
npm install -g pm2

# Start app with PM2
pm2 start ws-server.js --name jgm-captions

# Enable startup script
pm2 startup
pm2 save

# View logs
pm2 logs jgm-captions
```

### 2. Docker Logs
```bash
# View logs
docker-compose logs -f

# Export logs
docker-compose logs > logs.txt
```

### 3. Log Rotation
Configure log rotation to prevent disk space issues:
```bash
# /etc/logrotate.d/jgm-captions
/path/to/captions-app/*.log {
    daily
    missingok
    rotate 14
    compress
    notifempty
    create 0640 www-data www-data
}
```

## 🔧 Maintenance

### Updating the Application
```bash
# Pull latest code
git pull origin main

# Rebuild Docker image
docker-compose build

# Restart with zero downtime
docker-compose up -d
```

### Backup
```bash
# Backup logs and transcripts
tar -czf backup-$(date +%Y%m%d).tar.gz \
  captions.log \
  server.log

# Upload to cloud storage (example)
aws s3 cp backup-$(date +%Y%m%d).tar.gz s3://your-bucket/
```

## 💰 Cost Estimates

### VPS (DigitalOcean/Linode)
- **Basic**: $5-10/month (1GB RAM, 1 vCPU)
- **Recommended**: $12-20/month (2GB RAM, 2 vCPU)
- **Plus**: Soniox API costs (~$0.10-0.15/hour of audio)

### Platform-as-a-Service
- **Railway**: ~$5-15/month (usage-based)
- **Render**: ~$7/month (starter), $25/month (standard)
- **Plus**: Soniox API costs

### Total Monthly Cost Estimate
- **Hobby/Personal**: $15-30/month
- **Small Business**: $30-50/month
- **Production**: $50-100+/month

## 🌍 Domain Setup

1. **Purchase Domain** (e.g., Namecheap, Google Domains)
2. **Configure DNS**
   ```
   Type: A Record
   Name: @ or captions
   Value: <your-server-ip>
   TTL: 3600
   ```
3. **Wait for DNS propagation** (up to 48 hours, usually 1-2 hours)

## 🚨 Troubleshooting

### WebSocket Connection Failures
- Check firewall allows port 8080 (or your configured port)
- Ensure reverse proxy is configured for WebSocket upgrade
- Verify SSL/TLS certificate is valid

### Soniox Connection Issues
- Verify API key is correct
- Check server logs for error messages
- Test API key with a simple curl request
- Ensure server has internet connectivity

### High CPU/Memory Usage
- Monitor with `htop` or `docker stats`
- Consider upgrading server resources
- Check for memory leaks in logs
- Optimize audio buffer size

## 📚 Additional Resources

- [Soniox Documentation](https://soniox.com/docs)
- [Docker Documentation](https://docs.docker.com/)
- [Nginx Configuration Guide](https://nginx.org/en/docs/)
- [Let's Encrypt](https://letsencrypt.org/)

## ✅ Post-Deployment Checklist

- [ ] Application accessible via public URL
- [ ] SSL/TLS certificate installed and working
- [ ] Soniox connection works with API key
- [ ] WebSocket connections stable
- [ ] Captions displaying correctly
- [ ] Transcript logging working
- [ ] Server monitoring set up
- [ ] Backup strategy in place
- [ ] Domain DNS configured
- [ ] Firewall rules configured

## 🎯 Recommended Deployment Path

For most users, we recommend:

1. **Start with Railway or Render** (easiest, good for testing)
2. **Move to VPS when ready** (more control, lower cost for production)
3. **Use Docker** (consistent deployments, easy updates)
4. **Enable monitoring** (PM2 or Docker logs)
5. **Set up automated backups** (daily cron job)

---

**Need Help?** Check the main README.md or create an issue in the repository.




