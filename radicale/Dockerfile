FROM python:3-slim

# Install Radicale
RUN pip install --no-cache-dir radicale

# Copy configuration and helper
COPY config /etc/radicale/config
COPY auth_helper.py /etc/radicale/auth_helper.py
RUN chmod +x /etc/radicale/auth_helper.py

# Expose Radicale port
EXPOSE 5232

# Run Radicale
CMD ["radicale", "--config", "/etc/radicale/config"]
