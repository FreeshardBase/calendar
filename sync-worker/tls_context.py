"""Per-request TLS contexts for the Python workers (Issue #335).

Python counterpart of server/utils/tlsDispatcher.js: certificate verification is skipped
ONLY for the internal Radicale host (self-signed cert), identified by exact host and port
of the worker's LOCAL_CALDAV_URL. Every other host (Google, Microsoft Graph, ...) gets the
default, fully verifying context.
"""
import ssl
import urllib.parse

_DEFAULT_PORTS = {"http": 80, "https": 443}


def _host_port(url):
    parsed = urllib.parse.urlsplit(url)
    if not parsed.hostname:
        raise ValueError(f"URL has no host: {url!r}")
    return parsed.hostname.lower(), parsed.port or _DEFAULT_PORTS.get(parsed.scheme.lower())


def is_internal_url(url, internal_base_url):
    return _host_port(url) == _host_port(internal_base_url)


def ssl_context_for(url, internal_base_url):
    ctx = ssl.create_default_context()
    if is_internal_url(url, internal_base_url):
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx
