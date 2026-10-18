"""Issue #532 — the sync worker re-validates a linked account's stored URL on every job and keeps
vdirsyncer on the validated addresses (no redirect or DNS answer may lead it to an internal service).

Runs under NODE_ENV=production with OUTBOUND_FETCH_ALLOW_HOSTS unset. DNS is simulated by replacing
socket.getaddrinfo for *.testuser.example names; every "internal service" is a mock HTTP server on a
loopback address that records whether any request reached it. vdirsyncer is replaced by a fake
executable on PATH that makes the HTTP requests named in ISSUE532_URLS (following redirects, as
vdirsyncer does) and exits 1 on the first failure.
"""
import http.server
import os
import shutil
import socket
import sqlite3
import stat
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch, MagicMock

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import sync_worker  # noqa: E402
from test_issue531_basic_caldav_collection_scope import MockCalDAV  # noqa: E402

USER_ID = "testuser"
ACC_ID = "acc-532"
PUBLIC_IP = "93.184.215.14"

FAKE_VDIRSYNCER = r'''#!/usr/bin/env python3
import asyncio, json, os, sys, types, urllib.parse, urllib.request
import aiohttp


async def raw_get(url):
    # asyncio's own resolution and connect path, which aiohttp takes.
    parts = urllib.parse.urlsplit(url)
    reader, writer = await asyncio.open_connection(parts.hostname, parts.port)
    writer.write(f"GET {parts.path} HTTP/1.0\r\nHost: {parts.hostname}\r\n\r\n".encode())
    await writer.drain()
    await reader.read()
    writer.close()


def redirect_hooks(source, location):
    # What aiohttp does before following a redirect.
    session = aiohttp.ClientSession()
    params = types.SimpleNamespace(url=source, response=types.SimpleNamespace(headers={"Location": location}))
    for trace in session.trace_configs:
        for hook in trace.on_request_redirect:
            asyncio.run(hook(session, None, params))


for url in json.loads(os.environ["ISSUE532_URLS"]):
    try:
        if url.startswith("asyncio+"):
            asyncio.run(raw_get(url[len("asyncio+"):]))
        elif url.startswith("redirect "):
            redirect_hooks(*url.split()[1:])
        else:
            urllib.request.urlopen(url, timeout=10).read()
    except Exception as err:
        sys.stderr.write(f"request to {url} failed: {err}\n")
        sys.exit(1)
'''

# vdirsyncer's aiohttp is not installed for the tests; the parts guarded_vdirsyncer.py uses.
STUB_AIOHTTP = '''
class TraceConfig:
    def __init__(self):
        self.on_request_redirect = []


class ClientSession:
    def __init__(self, trace_configs=None):
        self.trace_configs = list(trace_configs or [])
'''


def stub_aiohttp_path(base_dir):
    """Directory to put on PYTHONPATH so guarded_vdirsyncer.py can import aiohttp in tests."""
    path = os.path.join(base_dir, "stubs")
    os.makedirs(os.path.join(path, "aiohttp"), exist_ok=True)
    with open(os.path.join(path, "aiohttp", "__init__.py"), "w") as f:
        f.write(STUB_AIOHTTP)
    return path

_real_getaddrinfo = socket.getaddrinfo


def fake_dns(answers):
    """socket.getaddrinfo with `answers` ({name: [address]}) for the simulated names."""
    def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        name = host.decode() if isinstance(host, bytes) else host
        if name in answers:
            out = []
            for addr in answers[name]:
                out += _real_getaddrinfo(addr, port, family, type, proto, flags | socket.AI_NUMERICHOST)
            return out
        return _real_getaddrinfo(host, port, family, type, proto, flags)
    return getaddrinfo


class Recorder:
    """HTTP server on `host` that records every request; /hop redirects (307) to `redirect_to`."""

    def __init__(self, host="127.0.0.1", port=0):
        self.requests = []
        self.redirect_to = None
        rec = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _any(self):
                rec.requests.append((self.command, self.path))
                if self.path == "/hop" and rec.redirect_to:
                    self.send_response(307)
                    self.send_header("Location", rec.redirect_to)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = b'<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>'
                self.send_response(207 if self.command == "PROPFIND" else 200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_PROPFIND = do_PUT = do_DELETE = do_MKCOL = do_REPORT = _any

        self.server = http.server.ThreadingHTTPServer((host, port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class WorkerOutboundGuardBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmp, "webcalendar.db")
        env = {k: v for k, v in os.environ.items() if k != "OUTBOUND_FETCH_ALLOW_HOSTS"}
        env.update({"NODE_ENV": "production", "DATABASE_PATH": self.db_path,
                    "STATUS_ROOT": os.path.join(self.tmp, "status"),
                    "PYTHONPATH": stub_aiohttp_path(self.tmp)})
        self.env = patch.dict(os.environ, env, clear=True)
        self.env.start()
        self.stoppables = []

    def tearDown(self):
        for s in self.stoppables:
            s.stop()
        self.env.stop()
        shutil.rmtree(self.tmp)

    def recorder(self, host="127.0.0.1", port=0):
        r = Recorder(host, port)
        self.stoppables.append(r)
        return r

    def install_fake_vdirsyncer(self, urls):
        bin_dir = os.path.join(self.tmp, "bin")
        os.makedirs(bin_dir, exist_ok=True)
        exe = os.path.join(bin_dir, "vdirsyncer")
        with open(exe, "w") as f:
            f.write(FAKE_VDIRSYNCER)
        os.chmod(exe, os.stat(exe).st_mode | stat.S_IXUSR)
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ["PATH"]
        import json
        os.environ["ISSUE532_URLS"] = json.dumps(urls)


class StoredUrlRevalidationTest(WorkerOutboundGuardBase):
    """Acceptance: a stored URL whose host is (now) internal fails the job before any request."""

    def setUp(self):
        super().setUp()
        conn = sqlite3.connect(self.db_path)
        conn.executescript("""
            CREATE TABLE linked_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, username TEXT,
                password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER);
            CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
            CREATE TABLE cross_user_deletions (id TEXT PRIMARY KEY, uid TEXT, owner_user_id TEXT, href TEXT, ics TEXT);
            CREATE TABLE caldav_calendar_collections (account_id TEXT NOT NULL, user_id TEXT NOT NULL,
                remote_collection TEXT NOT NULL, local_collection TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, remote_collection), UNIQUE (user_id, local_collection));
            CREATE TABLE sync_queue (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
                error_message TEXT, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 5,
                next_retry_at INTEGER, retry_state TEXT, created_at INTEGER, updated_at INTEGER);
            CREATE TABLE sync_job_progress (job_id TEXT PRIMARY KEY, items_done INTEGER NOT NULL DEFAULT 0);
        """)
        conn.commit()
        conn.close()
        # The internal service the stored URL now points at, and the local Radicale.
        self.internal = MockCalDAV("/dav/")
        self.internal.collections["work"] = "Arbeit"
        self.local = MockCalDAV(f"/{USER_ID}/")
        self.stoppables += [self.internal, self.local]

    def link(self, url):
        enc, iv = sync_worker.encrypt("testpassword", sync_worker.KEY_BYTES)
        conn = sqlite3.connect(self.db_path)
        conn.execute("DELETE FROM linked_accounts")
        conn.execute("DELETE FROM sync_queue")
        conn.execute(
            "INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, auth_type)"
            " VALUES (?, ?, ?, 'testuser@example.com', ?, ?, 'basic')", (ACC_ID, USER_ID, url, enc, iv))
        conn.execute("INSERT INTO sync_queue (id, user_id, max_attempts, created_at) VALUES ('job-532', ?, 1, ?)",
                     (USER_ID, int(time.time() * 1000)))
        conn.commit()
        conn.close()

    def run_job(self, dns):
        run = MagicMock(return_value=MagicMock(returncode=0, stdout="", stderr=""))
        with patch.object(sync_worker, "LOCAL_CALDAV_URL", self.local.base + "/"), \
             patch.object(sync_worker, "sync_msgraph_accounts", return_value=(True, "")), \
             patch.object(socket, "getaddrinfo", fake_dns(dns)), \
             patch("subprocess.run", run):
            self.assertTrue(sync_worker.process_next_job(self.db_path))
        conn = sqlite3.connect(self.db_path)
        row = conn.execute("SELECT status, error_message FROM sync_queue WHERE id = 'job-532'").fetchone()
        conn.close()
        return row, run

    def test_internal_target_fails_the_job_without_any_request(self):
        port = self.internal.server.server_address[1]
        cases = {
            "host resolving to loopback": (f"http://caldav.testuser.example:{port}/dav/",
                                           {"caldav.testuser.example": ["127.0.0.1"]}),
            "one of several answers internal": (f"http://mixed.testuser.example:{port}/dav/",
                                                {"mixed.testuser.example": ["127.0.0.1", PUBLIC_IP]}),
            "internal answer after a public one": (f"http://mixed2.testuser.example:{port}/dav/",
                                                   {"mixed2.testuser.example": [PUBLIC_IP, "127.0.0.1"]}),
            "loopback literal": (f"http://127.0.0.1:{port}/dav/", {}),
            "compose service name": (f"http://localhost:{port}/dav/", {}),
        }
        for label, (url, dns) in cases.items():
            with self.subTest(label):
                self.link(url)
                self.internal.requests.clear()
                (status, error), run = self.run_job(dns)
                self.assertEqual(self.internal.requests, [], "no request reaches the internal service")
                self.assertEqual(self.local.creations(), [])
                run.assert_not_called()
                self.assertEqual(status, "ERROR")
                self.assertIn(ACC_ID, error)
                self.assertIn("URL refused", error)

    def test_operator_allow_listed_host_still_syncs(self):
        os.environ["OUTBOUND_FETCH_ALLOW_HOSTS"] = "127.0.0.1"
        self.link(self.internal.url)
        (status, error), run = self.run_job({})
        self.assertEqual(status, "SUCCESS", error)
        self.assertEqual([m for m, _, _ in self.internal.requests], ["PROPFIND"])
        self.assertEqual(run.call_count, 3)  # discover, sync, metasync (#505)


class DiscoveryPinningTest(WorkerOutboundGuardBase):
    def test_discovery_connects_only_to_the_validated_address(self):
        # Same port on two loopback addresses; retried while 127.0.0.1 has that port taken.
        for _ in range(50):
            validated = self.recorder("127.0.0.2")
            try:
                rebound = self.recorder("127.0.0.1", validated.port)
                break
            except OSError:
                continue
        else:
            self.fail("no port free on both 127.0.0.1 and 127.0.0.2")
        url = f"http://caldav.testuser.example:{validated.port}/dav/"
        # DNS answers differently by the time discovery connects (rebinding).
        with patch.object(socket, "getaddrinfo", fake_dns({"caldav.testuser.example": ["127.0.0.1"]})):
            sync_worker.discover_caldav_collections(
                url, "testuser", "testpassword", {"caldav.testuser.example": ["127.0.0.2"]})
        self.assertEqual(rebound.requests, [])
        self.assertEqual(validated.requests, [("PROPFIND", "/dav/")])

    def test_discovery_refuses_a_host_without_validated_address(self):
        target = self.recorder()
        with patch.object(socket, "getaddrinfo", fake_dns({"other.testuser.example": ["127.0.0.1"]})), \
             self.assertRaises(OSError):
            sync_worker.discover_caldav_collections(
                f"http://other.testuser.example:{target.port}/dav/", "testuser", "testpassword", {})
        self.assertEqual(target.requests, [])

    def test_google_discovery_refuses_a_stored_url_resolving_internally(self):
        target = self.recorder()
        with patch.object(socket, "getaddrinfo", fake_dns({"apidata.testuser.example": ["127.0.0.1"]})), \
             self.assertRaises(RuntimeError) as ctx:
            sync_worker.discover_google_collections(
                f"http://apidata.testuser.example:{target.port}/caldav/v2/", "testtoken")
        self.assertIn("non-public", str(ctx.exception))
        self.assertEqual(target.requests, [])


class VdirsyncerGuardTest(WorkerOutboundGuardBase):
    """vdirsyncer itself runs behind the guard: pinned hosts only, redirects off them fail."""

    def setUp(self):
        super().setUp()
        self.account = self.recorder("127.0.0.2")   # the linked provider, pinned
        self.internal = self.recorder("127.0.0.1")  # caldav-server, webcalendar, shard_core, ...
        self.local = self.recorder("127.0.0.3")     # the local Radicale
        self.config = os.path.join(self.tmp, "config.ini")
        open(self.config, "w").close()

    def run_guarded(self, urls, allow_public=False):
        self.install_fake_vdirsyncer(urls)
        pins = {"caldav.testuser.example": ["127.0.0.2"]}
        with patch.object(sync_worker, "LOCAL_CALDAV_URL", f"http://127.0.0.3:{self.local.port}"):
            policy = sync_worker.outbound_policy({} if allow_public else pins, allow_public=allow_public)
            return sync_worker.run_vdirsyncer(self.config, "sync", policy)

    def test_pinned_host_and_local_radicale_are_reachable(self):
        res = self.run_guarded([f"http://caldav.testuser.example:{self.account.port}/dav/",
                                f"http://127.0.0.3:{self.local.port}/{USER_ID}/"])
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(self.account.requests, [("GET", "/dav/")])
        self.assertEqual(self.local.requests, [("GET", f"/{USER_ID}/")])

    def test_redirect_off_the_pinned_host_fails_the_run(self):
        for target in (f"http://127.0.0.1:{self.internal.port}/", f"http://localhost:{self.internal.port}/"):
            with self.subTest(target):
                self.account.redirect_to = target
                res = self.run_guarded([f"http://caldav.testuser.example:{self.account.port}/hop"])
                self.assertNotEqual(res.returncode, 0)
                self.assertIn("not allowed", res.stderr)
                self.assertEqual(self.internal.requests, [])

    def test_asyncio_connections_are_guarded_like_aiohttp_ones(self):
        res = self.run_guarded([f"asyncio+http://caldav.testuser.example:{self.account.port}/dav/"])
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(self.account.requests, [("GET", "/dav/")])
        for url in (f"asyncio+http://127.0.0.1:{self.internal.port}/", f"asyncio+http://localhost:{self.internal.port}/"):
            with self.subTest(url):
                res = self.run_guarded([url])
                self.assertNotEqual(res.returncode, 0)
                self.assertIn("not allowed", res.stderr)
        self.assertEqual(self.internal.requests, [])

    def test_local_radicale_is_reachable_on_its_port_only(self):
        other_port = self.recorder("127.0.0.3")
        res = self.run_guarded([f"http://127.0.0.3:{other_port.port}/"])
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("not allowed", res.stderr)
        self.assertEqual(other_port.requests, [])

    def test_redirect_to_the_local_radicale_fails_the_run(self):
        radicale = f"http://127.0.0.3:{self.local.port}/{USER_ID}/"
        account = f"http://caldav.testuser.example:{self.account.port}/dav/"
        res = self.run_guarded([f"redirect {account} {account}calendars/"])
        self.assertEqual(res.returncode, 0, res.stderr)
        for location in (radicale, f"https://caldav.testuser.example:{self.account.port}/dav/"):
            with self.subTest(location):
                res = self.run_guarded([f"redirect {account} {location}"])
                self.assertNotEqual(res.returncode, 0)
                self.assertIn("Redirect from", res.stderr)

    def test_public_mode_still_refuses_internal_addresses(self):
        res = self.run_guarded([f"http://127.0.0.1:{self.internal.port}/"], allow_public=True)
        self.assertNotEqual(res.returncode, 0)
        self.assertEqual(self.internal.requests, [])
        res = self.run_guarded([f"http://127.0.0.3:{self.local.port}/{USER_ID}/"], allow_public=True)
        self.assertEqual(res.returncode, 0, res.stderr)


class AssertPublicUrlTest(WorkerOutboundGuardBase):
    """Every blocked range of outboundFetch.js, reached by DNS answer and by literal; no connection is made."""

    BLOCKED = ["0.0.0.1", "10.0.0.5", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.18.0.2",
               "192.0.0.1", "192.0.2.1", "192.168.1.5", "198.18.0.1", "198.51.100.1", "203.0.113.1",
               "224.0.0.1", "240.0.0.1", "::", "::1", "::ffff:127.0.0.1", "64:ff9b::a00:5", "100::1",
               "2001:db8::1", "fd00::1", "fe80::1", "ff02::1"]

    def test_every_blocked_range_is_refused(self):
        import outbound_guard
        for addr in self.BLOCKED:
            literal = f"[{addr}]" if ":" in addr else addr
            with self.subTest(addr):
                with patch.object(socket, "getaddrinfo", fake_dns({"caldav.testuser.example": [PUBLIC_IP, addr]})), \
                     self.assertRaises(outbound_guard.OutboundUrlBlockedError):
                    outbound_guard.assert_public_url("https://caldav.testuser.example/dav/")
                with self.assertRaises(outbound_guard.OutboundUrlBlockedError):
                    outbound_guard.assert_public_url(f"https://{literal}/dav/")

    def test_public_answers_are_returned_for_pinning(self):
        import outbound_guard
        with patch.object(socket, "getaddrinfo", fake_dns({"caldav.testuser.example": [PUBLIC_IP]})):
            self.assertEqual(outbound_guard.assert_public_url("https://caldav.testuser.example/dav/"), [PUBLIC_IP])

    def test_internal_names_are_refused_even_with_a_public_answer(self):
        import outbound_guard
        names = ["caldav-server", "webcalendar", "shard-core.local", "host.internal", "x.lan", "x.home.arpa"]
        with patch.object(socket, "getaddrinfo", fake_dns({n: [PUBLIC_IP] for n in names})):
            for name in names:
                with self.subTest(name), self.assertRaises(outbound_guard.OutboundUrlBlockedError):
                    outbound_guard.assert_public_url(f"http://{name}:5232/")

    def test_non_http_schemes_are_refused(self):
        import outbound_guard
        for url in ("file:///etc/passwd", "ftp://caldav.testuser.example/", "caldav.testuser.example/dav"):
            with self.subTest(url), self.assertRaises(outbound_guard.OutboundUrlBlockedError):
                outbound_guard.assert_public_url(url)


class PinnedResolutionTest(unittest.TestCase):
    def test_pinned_ipv4_survives_ai_addrconfig_on_a_host_without_ipv6(self):
        import outbound_guard

        def glibc_without_ipv6(host, port, family=0, type=0, proto=0, flags=0):
            if family == socket.AF_INET6 and flags & socket.AI_ADDRCONFIG:
                raise socket.gaierror(socket.EAI_NONAME, "Name or service not known")
            return _real_getaddrinfo(host, port, family, type, proto, flags)

        with patch.object(outbound_guard, "_real_getaddrinfo", glibc_without_ipv6), \
             patch.object(socket, "getaddrinfo", socket.getaddrinfo), \
             patch.object(socket.socket, "connect", socket.socket.connect), \
             patch.object(socket.socket, "connect_ex", socket.socket.connect_ex):
            outbound_guard.install_socket_guard(
                {"caldav.testuser.example": [PUBLIC_IP, "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]}, [], False)
            # aiohttp's ThreadedResolver passes AI_ADDRCONFIG.
            results = socket.getaddrinfo("caldav.testuser.example", 443, 0, socket.SOCK_STREAM, 0,
                                         socket.AI_ADDRCONFIG)
        self.assertIn(PUBLIC_IP, [r[4][0] for r in results])


class BasicPassUsesGuardTest(WorkerOutboundGuardBase):
    """The Basic-auth pass of a real job runs vdirsyncer pinned to the account's validated address."""

    def test_vdirsyncer_of_a_job_cannot_reach_internal_services(self):
        internal = self.recorder("127.0.0.1")
        local = MockCalDAV(f"/{USER_ID}/")
        self.stoppables.append(local)
        conn = sqlite3.connect(self.db_path)
        conn.executescript("""
            CREATE TABLE linked_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, username TEXT,
                password_encrypted TEXT, iv TEXT, auth_type TEXT, access_token TEXT, expires_at INTEGER);
            CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
            CREATE TABLE cross_user_deletions (id TEXT PRIMARY KEY, uid TEXT, owner_user_id TEXT, href TEXT, ics TEXT);
            CREATE TABLE caldav_calendar_collections (account_id TEXT NOT NULL, user_id TEXT NOT NULL,
                remote_collection TEXT NOT NULL, local_collection TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, remote_collection), UNIQUE (user_id, local_collection));
        """)
        enc, iv = sync_worker.encrypt("testpassword", sync_worker.KEY_BYTES)
        conn.execute(
            "INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, auth_type)"
            " VALUES (?, ?, 'https://caldav.testuser.example/dav/', 'testuser@example.com', ?, ?, 'basic')",
            (ACC_ID, USER_ID, enc, iv))
        conn.commit()
        conn.close()
        # vdirsyncer is redirected to an internal service by IP literal and by internal name.
        self.install_fake_vdirsyncer([f"http://localhost:{internal.port}/"])

        with patch.object(sync_worker, "LOCAL_CALDAV_URL", local.base + "/"), \
             patch.object(sync_worker, "sync_msgraph_accounts", return_value=(True, "")), \
             patch.object(sync_worker, "discover_caldav_collections", return_value={"work": "Arbeit"}) as disc, \
             patch.object(socket, "getaddrinfo", fake_dns({"caldav.testuser.example": [PUBLIC_IP]})):
            ok, err = sync_worker.sync_user(USER_ID)

        self.assertFalse(ok)
        self.assertIn("not allowed", err)
        self.assertEqual(internal.requests, [])
        self.assertEqual(disc.call_args.args[3], {"caldav.testuser.example": [PUBLIC_IP]})


if __name__ == "__main__":
    unittest.main()
