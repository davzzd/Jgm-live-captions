# Docker Setup Guide for Mac

This guide will help you run the JGM Live Captions app using Docker on your Mac.

## Prerequisites

1. **Install Docker Desktop for Mac**
   - Download from: https://www.docker.com/products/docker-desktop/
   - Install and start Docker Desktop
   - Verify installation: `docker --version` and `docker-compose --version`

## Quick Start

### Step 1: Navigate to the Project

```bash
cd captions-app
```

### Step 2: Create Environment File

Create a `.env` file in the `captions-app` directory:

```bash
# Copy the example file
cp .env.example .env

# Edit the file and add your Soniox API key
nano .env  # or use your preferred editor
```

Your `.env` file should look like:
```env
SONIOX_MASTER_API_KEY=885a41baf0c85746228dd44ab442c3770e2c69f4f6f22bb7e3244de0d6d7899c
PORT=8080
NODE_ENV=production
```

### Step 3: Build and Run

```bash
# Build and start the container
docker-compose up -d

# View logs to verify it's running
docker-compose logs -f
```

You should see:
```
🚀 WebSocket server running on http://localhost:8080
📡 Client endpoint: ws://localhost:8080/client
📺 Caption endpoint: ws://localhost:8080/captions
```

### Step 4: Access the Application

- **Caption Display**: http://localhost:8080 (for Resolume)
- **Client Interface**: http://localhost:8080/client.html (for microphone input)

## Common Docker Commands

### Start/Stop

```bash
# Start the container
docker-compose up -d

# Stop the container
docker-compose down

# Restart the container
docker-compose restart
```

### View Logs

```bash
# View all logs
docker-compose logs

# Follow logs in real-time
docker-compose logs -f

# View last 100 lines
docker-compose logs --tail=100
```

### Rebuild After Code Changes

```bash
# Rebuild and restart
docker-compose up -d --build

# Or rebuild without cache
docker-compose build --no-cache
docker-compose up -d
```

### Check Status

```bash
# Check if container is running
docker-compose ps

# Check container health
docker ps
```

### Access Container Shell (for debugging)

```bash
# Enter the running container
docker-compose exec captions-app sh
```

## Troubleshooting

### Port Already in Use

If port 8080 is already in use, edit `docker-compose.yml`:

```yaml
ports:
  - "8081:8080"  # Change 8081 to any available port
```

Then access at `http://localhost:8081`

### Container Won't Start

1. Check logs: `docker-compose logs`
2. Verify `.env` file exists and has correct API key
3. Check Docker Desktop is running
4. Try rebuilding: `docker-compose up -d --build`

### Permission Issues

If you get permission errors:

```bash
# On Mac, you might need to add your user to docker group
# Or run with sudo (not recommended for production)
sudo docker-compose up -d
```

### View Container Resources

```bash
# Check resource usage
docker stats jgm-live-captions

# Check container details
docker inspect jgm-live-captions
```

## Production Deployment

For production use, consider:

1. **Use Docker secrets** for API keys (instead of .env file)
2. **Set resource limits** in docker-compose.yml
3. **Use a reverse proxy** (nginx) for HTTPS
4. **Set up logging** to a file or logging service
5. **Use Docker volumes** for persistent data (if needed)

## Clean Up

```bash
# Stop and remove containers
docker-compose down

# Remove containers, networks, and volumes
docker-compose down -v

# Remove images
docker rmi captions-app_captions-app
```

## Notes

- The container runs in the background (`-d` flag)
- Logs are available via `docker-compose logs`
- The `.env` file is mounted as read-only for security
- Container automatically restarts unless stopped manually
- Health checks ensure the service is running correctly

