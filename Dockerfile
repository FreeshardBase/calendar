FROM node:20-alpine

LABEL org.opencontainers.image.title="FreeShard WebCalendar"
LABEL org.opencontainers.image.description="CalDAV web client for FreeShard"

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY server/  ./server/
COPY public/  ./public/

# Create data directory and set permissions for SQLite volume
USER root
RUN mkdir -p /app/data && chown -R node:node /app/data && chmod -R 777 /app/data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "server/index.js"]
