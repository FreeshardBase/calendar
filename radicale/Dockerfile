FROM python:3-slim

# Install Radicale
RUN pip install --no-cache-dir radicale

# Copy plugin files
WORKDIR /app
COPY setup.py /app/setup.py
COPY radicale_custom_auth.py /app/radicale_custom_auth.py

# Install the custom auth plugin
RUN pip install --no-cache-dir /app

# Copy configuration
COPY config /etc/radicale/config

# Expose Radicale port
EXPOSE 5232

# Run Radicale
CMD ["radicale", "--config", "/etc/radicale/config", "--debug"]
