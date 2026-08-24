FROM python:3-slim

LABEL org.opencontainers.image.title="freeshard-radicale"
LABEL org.opencontainers.image.description="FreeShard Radicale CalDAV Server"
LABEL org.opencontainers.image.licenses="FSL-1.1-ALv2"

# Install system dependencies (openssl for fallback self-signed SSL certs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Install Radicale
RUN pip install --no-cache-dir radicale

# Copy plugin files and entrypoint
WORKDIR /app
COPY setup.py /app/setup.py
COPY radicale_custom_auth.py /app/radicale_custom_auth.py
COPY radicale_custom_rights.py /app/radicale_custom_rights.py
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Install the custom auth and rights plugins
RUN pip install --no-cache-dir /app

# Copy configuration
COPY config /etc/radicale/config

# Expose Radicale port
EXPOSE 5232

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["radicale", "--config", "/etc/radicale/config", "--debug"]
