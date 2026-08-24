#!/bin/sh
set -e

CERT="/etc/radicale/ssl/cert.pem"
KEY="/etc/radicale/ssl/key.pem"

# Check if SSL cert/key files exist; if not, generate self-signed cert in /tmp/radicale_ssl
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "[Radicale Entrypoint] SSL certificate or key not found at $CERT / $KEY. Generating fallback self-signed certificate..."
  mkdir -p /tmp/radicale_ssl
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout /tmp/radicale_ssl/key.pem \
    -out /tmp/radicale_ssl/cert.pem \
    -days 3650 -subj "/CN=caldav-server" 2>/dev/null || true

  if [ -f /tmp/radicale_ssl/cert.pem ] && [ -f /tmp/radicale_ssl/key.pem ]; then
    sed -i 's|/etc/radicale/ssl/cert.pem|/tmp/radicale_ssl/cert.pem|g' /etc/radicale/config
    sed -i 's|/etc/radicale/ssl/key.pem|/tmp/radicale_ssl/key.pem|g' /etc/radicale/config
  fi
fi

exec "$@"
