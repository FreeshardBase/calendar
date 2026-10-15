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
COPY drop-privileges.sh /app/drop-privileges.sh
# setpriv (util-linux, part of the Debian base) is what drop-privileges.sh drops root with.
RUN chmod +x /app/sync_worker.py /app/msgraph_worker.py /app/drop-privileges.sh && command -v setpriv
# Create non-root user and setup directory permissions. uid/gid 1000 is shared with the
# webcalendar and radicale images, which open the same SQLite file (issue #100).
RUN groupadd -r -g 1000 syncworker && useradd -r -u 1000 -g syncworker -m -s /bin/false syncworker \
    && mkdir -p /data /data/vdir_status /app \
    && chown -R syncworker:syncworker /data /app

USER syncworker

ENV PYTHONUNBUFFERED=1
ENV DATA_DIRS="/data /data/vdir_status"

# drop-privileges.sh takes ownership of the data mounts and drops to uid 1000 when started as root.
ENTRYPOINT ["/app/drop-privileges.sh"]
# Run the daemon
CMD ["python", "-u", "/app/sync_worker.py"]
