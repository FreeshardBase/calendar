"""Outbound guard for user-supplied URLs in the sync worker (Issue #532).

Python counterpart of server/utils/outboundFetch.js. On a shard the worker shares a network with
Radicale, the web app and the platform, so a linked account's stored URL must never reach loopback,
link-local, private, ULA or other non-public addresses, no matter what its DNS answers or its
server's redirects say today.

  - assert_public_url(url): http(s) only, rejects single-label / .local / .internal / ... names,
    IP literals in blocked ranges and hostnames whose DNS answers contain a blocked address.
    Returns the validated addresses the host is pinned to (None for an allow-listed host).
  - pinned_opener(pins, context): urllib opener that connects a pinned host only to its validated
    addresses (no DNS-rebinding window between check and connect).
  - install_socket_guard(pins, trusted, allow_public): process-wide restriction for the vdirsyncer
    subprocess (guarded_vdirsyncer.py), checked at name resolution and again at connect().
  - install_redirect_guard(aiohttp): vdirsyncer's HTTP client fails on any redirect off the origin.

OUTBOUND_FETCH_ALLOW_HOSTS (comma-separated hostnames) lets an operator explicitly allow specific
hosts, e.g. a CalDAV server on the home LAN; it must match the web app's setting.
"""
import functools
import http.client
import ipaddress
import os
import re
import socket
import urllib.parse
import urllib.request

_BLOCKED_V4 = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8",        # "this" network
    "10.0.0.0/8",       # private
    "100.64.0.0/10",    # carrier-grade NAT
    "127.0.0.0/8",      # loopback
    "169.254.0.0/16",   # link-local, cloud metadata
    "172.16.0.0/12",    # private (Docker/Podman default bridges)
    "192.0.0.0/24",     # IETF protocol assignments
    "192.0.2.0/24",     # TEST-NET-1
    "192.168.0.0/16",   # private
    "198.18.0.0/15",    # benchmarking
    "198.51.100.0/24",  # TEST-NET-2
    "203.0.113.0/24",   # TEST-NET-3
    "224.0.0.0/4",      # multicast
    "240.0.0.0/4",      # reserved, broadcast
)]
_BLOCKED_V6 = [ipaddress.ip_network(n) for n in (
    "::/128",           # unspecified
    "::1/128",          # loopback
    "::ffff:0:0/96",    # IPv4-mapped
    "64:ff9b::/96",     # NAT64 (embeds IPv4)
    "100::/64",         # discard
    "2001:db8::/32",    # documentation
    "fc00::/7",         # unique local
    "fe80::/10",        # link-local
    "ff00::/8",         # multicast
)]

_DEFAULT_PORTS = {"http": 80, "https": 443}
_INTERNAL_SUFFIX_RE = re.compile(r"\.(localhost|local|internal|lan|home\.arpa)$")

# Captured before install_socket_guard replaces them.
_real_getaddrinfo = socket.getaddrinfo
_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex


class OutboundUrlBlockedError(OSError):
    """A user-supplied URL or connection target is not a permitted public address."""


def _ip(value):
    """The address `value` names, or None if it is a hostname."""
    try:
        return ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return None


def is_blocked_address(ip):
    networks = _BLOCKED_V4 if ip.version == 4 else _BLOCKED_V6
    return any(ip in net for net in networks)


def normalize_host(host):
    """Lower-case ASCII form (IDNA for non-ASCII names, as aiohttp resolves them), no brackets or final dot."""
    host = host.strip("[]").rstrip(".").lower()
    if not host.isascii():
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError as err:
            raise OutboundUrlBlockedError(f"Invalid hostname: {host!r}") from err
    return host


def allowed_hosts():
    raw = os.environ.get("OUTBOUND_FETCH_ALLOW_HOSTS", "")
    return {normalize_host(h.strip()) for h in raw.split(",") if h.strip()}


def _is_internal_hostname(host):
    return "." not in host or bool(_INTERNAL_SUFFIX_RE.search(host))


def url_host(url):
    """Normalized host of an http(s) URL; raises OutboundUrlBlockedError for anything else."""
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError as err:
        raise OutboundUrlBlockedError(f"Invalid URL: {err}") from err
    if parts.scheme not in _DEFAULT_PORTS:
        raise OutboundUrlBlockedError(f"Protocol not allowed: {parts.scheme or '(none)'}")
    if not parts.hostname:
        raise OutboundUrlBlockedError("URL has no host")
    return normalize_host(parts.hostname), port or _DEFAULT_PORTS[parts.scheme]


def assert_public_url(url):
    """Validated addresses (list of str) that `url`'s host must be pinned to.

    None if the host is in OUTBOUND_FETCH_ALLOW_HOSTS. Raises OutboundUrlBlockedError for a
    non-http(s) URL, an internal name or a host with any non-public DNS answer; a failing DNS
    lookup raises socket.gaierror. Both are OSError.
    """
    host, port = url_host(url)
    if host in allowed_hosts():
        return None
    literal = _ip(host)
    if literal is not None:
        if is_blocked_address(literal):
            raise OutboundUrlBlockedError(f"Target address not allowed: {host}")
        return [str(literal)]
    if _is_internal_hostname(host):
        raise OutboundUrlBlockedError(f"Internal hostname not allowed: {host}")
    answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    addresses = list(dict.fromkeys(str(_ip(a[4][0])) for a in answers))
    if any(is_blocked_address(_ip(a)) for a in addresses):
        raise OutboundUrlBlockedError(f"Host {host} resolves to a non-public address")
    return addresses


def _connect_pinned(pins, address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None, **kwargs):
    host, port = address
    key = normalize_host(host)
    if key in pins:
        last_err = None
        for ip in pins[key]:
            try:
                return socket.create_connection((ip, port), timeout, source_address, **kwargs)
            except OSError as err:  # the next validated address may answer; the last error is raised
                last_err = err
        raise last_err
    if key in allowed_hosts():
        return socket.create_connection(address, timeout, source_address, **kwargs)
    raise OutboundUrlBlockedError(f"Host {key} not allowed: not the linked account's validated host")


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args, pins, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = functools.partial(_connect_pinned, pins)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, pins, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = functools.partial(_connect_pinned, pins)


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, pins):
        super().__init__()
        self._pins = pins

    def http_open(self, req):
        return self.do_open(functools.partial(_PinnedHTTPConnection, pins=self._pins), req)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, pins, context):
        super().__init__(context=context)
        self._pins = pins

    def https_open(self, req):
        return self.do_open(functools.partial(_PinnedHTTPSConnection, pins=self._pins), req,
                            context=self._context)


def pinned_opener(pins, context):
    """urllib opener whose connections go only to `pins` ({host: [address]}) or allow-listed hosts.

    TLS still verifies the certificate against the hostname (SNI), not the pinned address.
    """
    pins = {normalize_host(h): list(a) for h, a in pins.items()}
    return urllib.request.build_opener(_PinnedHTTPHandler(pins), _PinnedHTTPSHandler(pins, context))


def same_origin(a, b):
    return urllib.parse.urlsplit(a).scheme == urllib.parse.urlsplit(b).scheme and url_host(a) == url_host(b)


def install_redirect_guard(aiohttp):
    """Fail every aiohttp request that is redirected off its origin (scheme, host, port).

    vdirsyncer keeps the method, body and credentials across a redirect; the socket guard alone would
    still let a provider redirect to the trusted local Radicale.
    """
    async def refuse_cross_origin_redirect(session, ctx, params):
        source = str(params.url)
        location = params.response.headers.get("Location") or params.response.headers.get("URI") or ""
        target = urllib.parse.urljoin(source, location)
        if not same_origin(source, target):
            raise OutboundUrlBlockedError(f"Redirect from {source} to {target} not allowed")

    trace = aiohttp.TraceConfig()
    trace.on_request_redirect.append(refuse_cross_origin_redirect)
    original_init = aiohttp.ClientSession.__init__

    def init(self, *args, trace_configs=None, **kwargs):
        original_init(self, *args, trace_configs=[*(trace_configs or ()), trace], **kwargs)

    aiohttp.ClientSession.__init__ = init


def install_socket_guard(pins, trusted, allow_public):
    """Restrict every TCP connection of this process (the vdirsyncer subprocess).

    - a host in `pins` ({host: [address]}) resolves only to its validated addresses, never through
      DNS again; connect() may reach those addresses on any port;
    - a host in `trusted` ([[host, port]], the local Radicale) resolves normally, and connect() may
      reach its addresses on that port only;
    - a host in OUTBOUND_FETCH_ALLOW_HOSTS resolves normally and is reachable on any port;
    - any other host is refused unless `allow_public`, and then only if every DNS answer is public;
    - connect() checks the address again, so an IP-literal redirect target is covered too.
    With allow_public False, any hop (redirect, discovery href) away from the pinned hosts fails.
    """
    pins = {normalize_host(h): [str(_ip(a)) for a in addrs] for h, addrs in pins.items()}
    trusted_ports = {normalize_host(h): int(p) for h, p in trusted}
    allowed = allowed_hosts()
    permitted = {_ip(a) for addrs in pins.values() for a in addrs}  # any port
    permitted |= {_ip(h) for h in allowed if _ip(h) is not None}
    permitted_endpoints = {(_ip(h), p) for h, p in trusted_ports.items() if _ip(h) is not None}

    def guarded_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        name = host.decode("ascii") if isinstance(host, bytes) else host
        if name is None or _ip(name) is not None:
            # No name lookup; connect() decides about the address.
            return _real_getaddrinfo(host, port, family, type, proto, flags)
        key = normalize_host(name)
        if key in pins:
            results = []
            # AI_ADDRCONFIG (aiohttp sets it) would make a numeric lookup of a validated IPv6 address
            # fail outright on a host without IPv6; the connection attempt to it fails over instead.
            numeric = (flags & ~socket.AI_ADDRCONFIG) | socket.AI_NUMERICHOST
            for addr in pins[key]:
                addr_family = socket.AF_INET if _ip(addr).version == 4 else socket.AF_INET6
                if family in (0, socket.AF_UNSPEC, addr_family):
                    results += _real_getaddrinfo(addr, port, addr_family, type, proto, numeric)
            if not results:
                raise OutboundUrlBlockedError(f"Host {key} has no validated address of the requested family")
            return results
        results = _real_getaddrinfo(host, port, family, type, proto, flags)
        if key in trusted_ports:
            permitted_endpoints.update((_ip(r[4][0]), trusted_ports[key]) for r in results)
            return results
        if key in allowed:
            permitted.update(_ip(r[4][0]) for r in results)
            return results
        if not allow_public:
            raise OutboundUrlBlockedError(f"Host {key} not allowed: not the linked account's validated host")
        if any(is_blocked_address(_ip(r[4][0])) for r in results):
            raise OutboundUrlBlockedError(f"Host {key} resolves to a non-public address")
        return results

    def check(sock, address):
        if sock.family not in (socket.AF_INET, socket.AF_INET6):
            return
        ip = _ip(address[0])
        if ip is None:
            raise OutboundUrlBlockedError(f"Connection target {address[0]!r} is not an address")
        if ip in permitted or (ip, address[1]) in permitted_endpoints:
            return
        if not allow_public or is_blocked_address(ip):
            raise OutboundUrlBlockedError(f"Connection to {ip} port {address[1]} not allowed")

    def guarded_connect(self, address):
        check(self, address)
        return _real_connect(self, address)

    def guarded_connect_ex(self, address):
        check(self, address)
        return _real_connect_ex(self, address)

    socket.getaddrinfo = guarded_getaddrinfo
    socket.socket.connect = guarded_connect
    socket.socket.connect_ex = guarded_connect_ex
