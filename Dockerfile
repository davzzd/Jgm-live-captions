# Use official Node.js runtime as base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY ws-server.js ./
COPY captions.html ./
COPY client.html ./

# Create .env file placeholder (user should mount their own)
# This ensures the app doesn't crash if .env is missing
RUN touch .env

# Expose the port the app runs on
EXPOSE 8080

# Set environment variable for port
ENV PORT=8080

# Health check to ensure container is running
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Run the application
CMD ["node", "ws-server.js"]



