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

# Copy requirements and install vdirsyncer and cryptography
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy sync worker script
WORKDIR /app
COPY sync_worker.py /app/sync_worker.py
COPY msgraph_worker.py /app/msgraph_worker.py
COPY tls_context.py /app/tls_context.py
RUN chmod +x /app/sync_worker.py /app/msgraph_worker.py
# Create non-root user and setup directory permissions
RUN groupadd -r syncworker && useradd -r -g syncworker -m -s /bin/false syncworker \
    && mkdir -p /data /data/vdir_status /app \
    && chown -R syncworker:syncworker /data /app

USER syncworker

ENV PYTHONUNBUFFERED=1

# Run the daemon
CMD ["python", "-u", "/app/sync_worker.py"]
