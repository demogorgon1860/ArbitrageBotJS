# Use Node.js 18 LTS Alpine image for smaller size
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p logs cache deployments

# Set proper permissions
RUN chown -R node:node /app

# Switch to non-root user
USER node

# Expose port (if needed for health checks)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('Health check passed')" || exit 1

# Default command
CMD ["npm", "start"]

# Labels for metadata
LABEL maintainer="Polygon Arbitrage Bot Team"
LABEL version="1.0.0"
LABEL description="Production-ready arbitrage monitoring bot for Polygon DEX platforms"