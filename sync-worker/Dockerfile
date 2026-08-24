FROM python:3-slim

LABEL org.opencontainers.image.title="freeshard-sync-worker"
LABEL org.opencontainers.image.description="FreeShard CalDAV Sync Worker Daemon"
LABEL org.opencontainers.image.licenses="FSL-1.1-ALv2"

# Install system dependencies (needed to build cryptography if slim lacks binary wheels)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libc-dev \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Install vdirsyncer with google support and cryptography library
RUN pip install --no-cache-dir "vdirsyncer[google]" cryptography

# Copy sync worker script
WORKDIR /app
COPY sync_worker.py /app/sync_worker.py
RUN chmod +x /app/sync_worker.py

# Run the daemon
CMD ["python", "/app/sync_worker.py"]
