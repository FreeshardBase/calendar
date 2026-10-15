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

# Data directory for the SQLite volume, owned by node (uid 1000, shared with the radicale and
# sync-worker images). A bind mount shadows it, so drop-privileges.sh takes ownership of the
# mount at start when the container runs as root, then drops to uid 1000 (issue #100).
USER root
COPY drop-privileges.sh /usr/local/bin/drop-privileges.sh
RUN apk add --no-cache setpriv && chmod +x /usr/local/bin/drop-privileges.sh \
    && mkdir -p /app/data && chown node:node /app/data
USER node
ENV DATA_DIRS="/app/data"

# The image is the production build: the #246 proxy-secret gate and the boot checks key on it.
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/api/health || wget -qO- --no-check-certificate https://localhost:3000/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/drop-privileges.sh"]
CMD ["node", "server/index.js"]
