FROM node:20-alpine

# Install build dependencies for native modules (sqlite3) and runtime tools
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    sqlite \
    curl

# Set working directory
WORKDIR /app

# Copy package definition files and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the application source
COPY . .

# Ensure writable data directories exist
RUN mkdir -p /app/linda-data /app/gun-relays && \
    chown -R node:node /app

# Switch to non-root user provided by the base image
USER node

# Set environment defaults
ENV NODE_ENV=production \
    PORT=8765

# Expose HTTP port
EXPOSE 8765

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:${PORT}/api/health || exit 1

# Start the Linda optimization relay server
CMD ["node", "server.js"]

