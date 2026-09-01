FROM python:3-slim

LABEL org.opencontainers.image.title="freeshard-radicale"
LABEL org.opencontainers.image.description="FreeShard Radicale CalDAV Server"
LABEL org.opencontainers.image.licenses="FSL-1.1-ALv2"

# Install system dependencies (openssl for fallback self-signed SSL certs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Radicale
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy plugin files and entrypoint
WORKDIR /app
COPY setup.py /app/setup.py
COPY radicale_custom_auth.py /app/radicale_custom_auth.py
COPY radicale_custom_rights.py /app/radicale_custom_rights.py
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Install the custom auth and rights plugins
RUN pip install --no-cache-dir /app

# Create non-root user and setup directory permissions
RUN groupadd -r radicale && useradd -r -g radicale -m -s /bin/false radicale \
    && mkdir -p /data /data/collections /etc/radicale /tmp/radicale_ssl /app \
    && chown -R radicale:radicale /data /etc/radicale /tmp/radicale_ssl /app

# Copy configuration
COPY config /etc/radicale/config
RUN chown -R radicale:radicale /etc/radicale

# Expose Radicale port
EXPOSE 5232

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f -k https://localhost:5232/ || curl -f http://localhost:5232/ || exit 1

USER radicale

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["radicale", "--config", "/etc/radicale/config", "--debug"]

