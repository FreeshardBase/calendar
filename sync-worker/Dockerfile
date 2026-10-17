# Pinned Python minor and Debian release: python:3-slim follows the newest Python major (#103).
# Build stage (#536): installs the hash-locked wheels into a venv; pip never builds from source, so
# no compiler is needed and none reaches the runtime image.
FROM python:3.12-slim-trixie AS build

RUN python -m venv /opt/venv
COPY locked-requirements.txt /tmp/locked-requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir --require-hashes --only-binary=:all: -r /tmp/locked-requirements.txt

FROM python:3.12-slim-trixie

LABEL org.opencontainers.image.title="freeshard-sync-worker"
LABEL org.opencontainers.image.description="FreeShard CalDAV Sync Worker Daemon"
LABEL org.opencontainers.image.licenses="FSL-1.1-ALv2"

COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Code and venv stay root-owned and read-only for the service uid (#536): a compromised worker
# cannot persist modified code.
WORKDIR /app
COPY sync_worker.py /app/sync_worker.py
COPY msgraph_worker.py /app/msgraph_worker.py
COPY tls_context.py /app/tls_context.py
COPY outbound_guard.py /app/outbound_guard.py
COPY guarded_vdirsyncer.py /app/guarded_vdirsyncer.py
COPY drop-privileges.sh /app/drop-privileges.sh
# setpriv (util-linux, part of the Debian base) is what drop-privileges.sh drops root with.
RUN chmod +x /app/sync_worker.py /app/msgraph_worker.py /app/drop-privileges.sh && chmod -R go-w /app \
    && command -v setpriv
# Create non-root user and setup directory permissions. uid/gid 1000 is shared with the
# webcalendar and radicale images, which open the same SQLite file (issue #100). Only the data
# directories belong to it.
RUN groupadd -r -g 1000 syncworker && useradd -r -u 1000 -g syncworker -m -s /bin/false syncworker \
    && mkdir -p /data /data/vdir_status \
    && chown -R syncworker:syncworker /data

USER syncworker

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV DATA_DIRS="/data /data/vdir_status"

# drop-privileges.sh takes ownership of the data mounts and drops to uid 1000 when started as root.
ENTRYPOINT ["/app/drop-privileges.sh"]
# Run the daemon
CMD ["python", "-u", "/app/sync_worker.py"]
