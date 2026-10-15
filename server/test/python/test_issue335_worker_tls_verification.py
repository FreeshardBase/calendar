"""Issue #335: the Python workers must verify TLS certificates for every external host.

Local HTTPS servers with generated certificates stand in for Google / Microsoft Graph:
  * an untrusted self-signed server must be rejected with a certificate error before any
    request (and thus any bearer token) reaches it;
  * a server whose CA is trusted via SSL_CERT_FILE must work, proving verification is on
    rather than every external call simply failing;
  * only the internal Radicale host (LOCAL_CALDAV_URL) may use its self-signed certificate.
"""
import datetime
import ipaddress
import json
import os
import shutil
import sqlite3
import ssl
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

SYNC_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../sync-worker"))
if SYNC_WORKER_DIR not in sys.path:
    sys.path.insert(0, SYNC_WORKER_DIR)

import msgraph_worker  # noqa: E402
import sync_worker  # noqa: E402

EVENT_ICS = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n"
    "BEGIN:VEVENT\r\nUID:evt-1\r\nSUMMARY:Test\r\nDTSTART:20260101T090000Z\r\n"
    "DTEND:20260101T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
)


def _write_self_signed(directory, name):
    """Self-signed certificate for 127.0.0.1 that is also its own CA."""
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"testuser-{name}")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_path = os.path.join(directory, f"{name}-cert.pem")
    key_path = os.path.join(directory, f"{name}-key.pem")
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(key_path, "wb") as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ))
    return cert_path, key_path


class _RecordingServer:
    """HTTPS server on 127.0.0.1 that records every request that completes the handshake."""

    def __init__(self, cert_path, key_path, routes):
        self.requests = []
        recorded = self.requests

        class Handler(BaseHTTPRequestHandler):
            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                recorded.append({
                    "method": self.command,
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "body": body.decode("utf-8", "replace"),
                })
                status, content_type, payload = routes.get((self.command, self.path), (404, "text/plain", "not found"))
                data = payload.encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = _handle
            do_PUT = _handle
            do_DELETE = _handle

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert_path, key_path)
        self.httpd.socket = ctx.wrap_socket(self.httpd.socket, server_side=True)
        self.httpd.handle_error = lambda request, client_address: None
        self.url = f"https://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class WorkerTlsVerificationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.untrusted_cert, self.untrusted_key = _write_self_signed(self.tmp, "untrusted")
        self.trusted_cert, self.trusted_key = _write_self_signed(self.tmp, "trusted")
        self.internal_cert, self.internal_key = _write_self_signed(self.tmp, "internal")
        # Production semantics: the only extra trust anchor is the "public" CA below.
        self._saved_env = {k: os.environ.get(k) for k in ("SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_ENV")}
        os.environ["SSL_CERT_FILE"] = self.trusted_cert
        os.environ["SSL_CERT_DIR"] = self.tmp + "/no-such-dir"
        os.environ["NODE_ENV"] = "production"
        self.servers = []
        self._saved_sync_local = sync_worker.LOCAL_CALDAV_URL
        self._saved_graph_local = msgraph_worker.LOCAL_CALDAV_URL

    def tearDown(self):
        for server in self.servers:
            server.close()
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        sync_worker.LOCAL_CALDAV_URL = self._saved_sync_local
        msgraph_worker.LOCAL_CALDAV_URL = self._saved_graph_local
        shutil.rmtree(self.tmp)

    def _server(self, kind, routes):
        cert, key = {
            "untrusted": (self.untrusted_cert, self.untrusted_key),
            "trusted": (self.trusted_cert, self.trusted_key),
            "internal": (self.internal_cert, self.internal_key),
        }[kind]
        server = _RecordingServer(cert, key, routes)
        self.servers.append(server)
        return server

    def _assert_cert_error(self, exc):
        reason = getattr(exc, "reason", exc)
        self.assertIsInstance(reason, ssl.SSLCertVerificationError, f"expected certificate error, got {exc!r}")

    # --- sync_worker.protect_cross_user_deletions ---------------------------------------

    def test_cross_user_restore_puts_to_internal_radicale(self):
        internal = self._server("internal", {("PUT", "/testuser/persoenlich/evt-1.ics"): (201, "text/plain", "")})
        sync_worker.LOCAL_CALDAV_URL = internal.url

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("CREATE TABLE cross_user_deletions (id INTEGER PRIMARY KEY, owner_user_id TEXT, uid TEXT, href TEXT, ics TEXT)")
        conn.execute("INSERT INTO cross_user_deletions (owner_user_id, uid, href, ics) VALUES (?, ?, ?, ?)",
                     ("testuser", "evt-1", "/testuser/persoenlich/evt-1.ics", EVENT_ICS))

        sync_worker.protect_cross_user_deletions("testuser", conn)

        puts = [r for r in internal.requests if r["method"] == "PUT"]
        self.assertEqual(len(puts), 1, "internal Radicale with self-signed cert must stay reachable")
        self.assertEqual(puts[0]["body"], EVENT_ICS)

    # --- msgraph_worker ------------------------------------------------------------------

    def _graph_db(self, endpoint):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("""CREATE TABLE msgraph_accounts (id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT, client_id TEXT,
            account_email TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, delta_link TEXT,
            target_calendar_id TEXT, updated_at INTEGER)""")
        conn.execute("""CREATE TABLE msgraph_event_mappings (local_uid TEXT PRIMARY KEY, graph_id TEXT UNIQUE NOT NULL,
            account_id TEXT NOT NULL, last_synced_at INTEGER, e_tag TEXT)""")
        conn.execute(
            "INSERT INTO msgraph_accounts VALUES ('acc1', 'testuser', 'common', 'cid', 'testuser@example.com', 'testuser-graph-token', NULL, ?, ?, 'persoenlich', 0)",
            (4102444800000, endpoint),
        )
        conn.commit()
        return conn

    def test_graph_fetch_rejects_self_signed_certificate(self):
        graph = self._server("untrusted", {("GET", "/v1.0/me/events"): (200, "application/json", json.dumps({"value": []}))})
        conn = self._graph_db(f"{graph.url}/v1.0/me/events")
        msgraph_worker.sync_msgraph_accounts("testuser", conn)
        self.assertEqual(graph.requests, [], "Graph bearer token must never reach an unverified host")

    def test_graph_sync_verified_fetch_and_internal_put(self):
        payload = {
            "value": [{"id": "g1", "subject": "Test", "start": {"dateTime": "2026-01-01T09:00:00"}, "end": {"dateTime": "2026-01-01T10:00:00"}}],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/events/delta?token=x",
        }
        graph = self._server("trusted", {("GET", "/v1.0/me/events"): (200, "application/json", json.dumps(payload))})
        internal = self._server("internal", {("PUT", "/testuser/persoenlich/msgraph-event-g1.ics"): (201, "text/plain", "")})
        msgraph_worker.LOCAL_CALDAV_URL = internal.url
        conn = self._graph_db(f"{graph.url}/v1.0/me/events")

        msgraph_worker.sync_msgraph_accounts("testuser", conn)

        self.assertEqual(graph.requests[0]["authorization"], "Bearer testuser-graph-token")
        puts = [r for r in internal.requests if r["method"] == "PUT"]
        self.assertEqual(len(puts), 1)
        self.assertIn("UID:msgraph-event-g1", puts[0]["body"])


if __name__ == "__main__":
    unittest.main()
