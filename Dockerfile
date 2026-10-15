FROM node:22-alpine

LABEL org.opencontainers.image.title="FreeShard WebCalendar"
LABEL org.opencontainers.image.description="CalDAV web client for FreeShard"

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ build-base sqlite-dev && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-maxtimeout 60000 && \
    npm ci --omit=dev && \
    apk del .build-deps

# Copy application code
COPY server/  ./server/
COPY public/  ./public/

# Create data directory and set permissions for SQLite volume
USER root
RUN mkdir -p /app/data && chown -R node:node /app/data && chmod -R 777 /app/data
USER node

# The image is the production build: the #246 proxy-secret gate and the boot checks key on it.
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/api/health || wget -qO- --no-check-certificate https://localhost:3000/api/health || exit 1

CMD ["node", "server/index.js"]
