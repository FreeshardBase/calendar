#!/usr/bin/env python3
import sys
import os

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(line_buffering=True)
os.environ["PYTHONUNBUFFERED"] = "1"
import re
import sqlite3
import time
import subprocess
import urllib.request
import urllib.parse
import urllib.error
import json
import xml.etree.ElementTree as ET
import signal
import traceback
import shutil
import tempfile
import threading
import uuid
import unicodedata
from xml.sax.saxutils import escape as xml_escape
import functools
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from tls_context import ssl_context_for

# Configuration variables from environment
DB_PATH = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")
STATUS_ROOT = os.environ.get("STATUS_ROOT", "/data/vdir_status")
VDIRSYNCER_TIMEOUT_SECONDS = int(os.environ.get("VDIRSYNCER_TIMEOUT_SECONDS", "900"))
CONFIG_DIR_PREFIX = "vdirsyncer-cfg-"

shutdown_requested = False
active_job_id = None
active_job_db_path = None

def purge_tmp_credential_files(user_id=None):
    """Purges plaintext INI configs and OAuth token JSON files from /tmp for user_id or all users on shutdown."""
    import glob
    if user_id:
        patterns = [
            f"/tmp/vdir_{user_id}.ini",
            f"/tmp/vdir_basic_{user_id}.ini",
            f"/tmp/google_token_{user_id}_*.json",
        ]
    else:
        patterns = [
            "/tmp/vdir_*.ini",
            "/tmp/vdir_basic_*.ini",
            "/tmp/google_token_*.json",
        ]
    for pat in patterns:
        for filepath in glob.glob(pat):
            try:
                os.remove(filepath)
            except FileNotFoundError:
                # Removed concurrently between glob() and remove(): already purged.
                continue

def handle_shutdown_signal(signum, frame):
    global shutdown_requested, active_job_id, active_job_db_path
    print(f"[Sync-Worker] Received signal {signum}, shutting down gracefully...")
    shutdown_requested = True
    if active_job_id and active_job_db_path and os.path.exists(active_job_db_path):
        try:
            conn = sqlite3.connect(active_job_db_path, timeout=10.0)
            conn.execute("PRAGMA foreign_keys = ON")
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE sync_queue SET status = 'PENDING', updated_at = ? WHERE id = ? AND status = 'RUNNING'",
                (int(time.time() * 1000), active_job_id)
            )
            conn.commit()
            conn.close()
            print(f"[Sync-Worker] Reset active job {active_job_id} back to PENDING on shutdown signal.")
        except sqlite3.Error as e:
            # Not fatal on shutdown: recover_stranded_jobs() resets the job on the next start.
            print(f"[Sync-Worker] Error resetting active job on shutdown signal: {e}", file=sys.stderr)
        active_job_id = None
        active_job_db_path = None
    purge_tmp_credential_files()
    sys.exit(0)

signal.signal(signal.SIGTERM, handle_shutdown_signal)
signal.signal(signal.SIGINT, handle_shutdown_signal)

def recover_stranded_jobs(target_db=None):
    """Resets pre-existing stranded RUNNING jobs back to PENDING status on daemon startup."""
    purge_tmp_credential_files()
    db_path = target_db or get_db_path()
    if not os.path.exists(db_path):
        return 0

    conn = sqlite3.connect(db_path, timeout=30.0)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        cursor = conn.cursor()
        now_ms = int(time.time() * 1000)
        cursor.execute(
            "UPDATE sync_queue SET status = 'PENDING', updated_at = ? WHERE status = 'RUNNING'",
            (now_ms,)
        )
        count = cursor.rowcount
        conn.commit()
    finally:
        conn.close()
    if count > 0:
        print(f"[Sync-Worker] Recovered {count} stranded RUNNING jobs back to PENDING.")
    return count

def get_db_path():
    return os.environ.get("DATABASE_PATH", DB_PATH)

def get_status_root():
    return os.environ.get("STATUS_ROOT", STATUS_ROOT)
_weak_keys = {
    "freeshard-default-encryption-key-do-not-use-in-prod",
    "freeshard-default-key",
    "change-me",
    "change-me-32-chars-or-more",
    "portal.id",
    "{{ portal.id }}",
    "{{portal.id}}",
}

def is_weak_encryption_secret(secret, portal_id=None):
    if not secret:
        return True
    s = str(secret).strip()
    if not s or s in _weak_keys or "portal.id" in s.lower() or len(s) == 103:
        return True
    if portal_id and s == portal_id.strip():
        return True
    return False

KEY_CHECK_PLAINTEXT = "freeshard-webcalendar-key-check-v1"
_ENCRYPTED_TOKEN_RE = re.compile(r"^[0-9a-fA-F]{56}:[0-9a-fA-F]+$")


def count_ciphertexts(db_path):
    """Issue #333: number of values in the database encrypted with the install's key."""
    if not os.path.exists(db_path):
        return 0
    conn = sqlite3.connect(db_path)
    try:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        count = 0
        if "encryption_key_check" in tables:
            count += conn.execute("SELECT COUNT(*) FROM encryption_key_check").fetchone()[0]
        if "linked_accounts" in tables:
            count += conn.execute("SELECT COUNT(*) FROM linked_accounts").fetchone()[0]
        if "msgraph_accounts" in tables:
            for access_token, refresh_token in conn.execute("SELECT access_token, refresh_token FROM msgraph_accounts"):
                count += sum(1 for t in (access_token, refresh_token) if isinstance(t, str) and _ENCRYPTED_TOKEN_RE.match(t))
        return count
    finally:
        conn.close()


def _persist_key_file(key_file_path, secret):
    key_dir = os.path.dirname(key_file_path)
    if key_dir:
        os.makedirs(key_dir, exist_ok=True)
    try:
        fd = os.open(key_file_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        # Another process (the web app) created the key first; use that one.
        with open(key_file_path, "r", encoding="utf-8") as f:
            existing = f.read().strip()
        if not existing:
            raise ValueError(f"Encryption key file {key_file_path} exists but is empty.")
        return existing
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(secret)
    return secret


def _persist_key_file_or_warn(key_file_path, secret, strict):
    # Outside production (e.g. importing the worker without a /data volume) an unpersistable key
    # is reported and used for this process only; in production it is fatal.
    try:
        return _persist_key_file(key_file_path, secret)
    except OSError as err:
        if strict:
            raise ValueError(f"Cannot persist encryption key to {key_file_path}: {err}") from err
        print(f"[Sync-Worker] WARNING: encryption key not persisted to {key_file_path}: {err}", file=sys.stderr)
        return secret


def resolve_encryption_secret(env=None, target_db_path=None):
    if env is None:
        env = os.environ
    if target_db_path is None:
        target_db_path = get_db_path()

    node_env = (env.get("NODE_ENV") or "").lower()
    is_prod_or_staging = node_env in ["production", "staging"]
    allow_insecure = env.get("ALLOW_INSECURE_ENCRYPTION_KEY") == "true"
    portal_id = env.get("PORTAL_ID")

    key_file_path = env.get("ENCRYPTION_KEY_FILE") or os.path.join(os.path.dirname(target_db_path), ".encryption_key")

    if os.path.exists(key_file_path):
        with open(key_file_path, "r", encoding="utf-8") as f:
            content = f.read().strip()
        if content:
            if is_prod_or_staging and not allow_insecure and is_weak_encryption_secret(content, portal_id):
                raise ValueError("ENCRYPTION_KEY must be explicitly configured with a secure, unique key per install in production environment.")
            return content

    raw_env_key = env.get("ENCRYPTION_KEY") or env.get("ENCRYPTION_SECRET")
    if env is os.environ and not raw_env_key:
        raw_env_key = os.environ.get("ENCRYPTION_KEY") or os.environ.get("ENCRYPTION_SECRET")
    if raw_env_key and str(raw_env_key).strip():
        secret = str(raw_env_key).strip()
        if is_prod_or_staging and not allow_insecure and is_weak_encryption_secret(secret, portal_id):
            raise ValueError("ENCRYPTION_KEY must be explicitly configured with a secure, unique key per install in production environment.")
        if not os.path.exists(key_file_path):
            _persist_key_file_or_warn(key_file_path, secret, is_prod_or_staging and not allow_insecure)
        return secret

    # Issue #333: a new key is only minted on a fresh install, never next to existing ciphertexts.
    existing = count_ciphertexts(target_db_path)
    if existing:
        raise ValueError(
            f"No ENCRYPTION_KEY and no {key_file_path}, but {target_db_path} holds {existing} encrypted value(s). "
            "Restore the original encryption key; refusing to generate a new one."
        )
    import secrets
    return _persist_key_file_or_warn(key_file_path, secrets.token_hex(32), is_prod_or_staging and not allow_insecure)


def verify_encryption_key(db_path, key_bytes):
    """Issue #333: raises if the key-check value written by the web app does not decrypt with key_bytes."""
    conn = sqlite3.connect(db_path)
    try:
        has_table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'encryption_key_check'"
        ).fetchone()
        row = conn.execute("SELECT ciphertext, iv FROM encryption_key_check WHERE id = 1").fetchone() if has_table else None
    finally:
        conn.close()
    if row is None:
        return
    try:
        plain = decrypt(row[0], row[1], key_bytes)
    except (ValueError, UnicodeDecodeError) as err:
        raise ValueError(f"The configured encryption key cannot decrypt the key-check value of {db_path}: {err}") from err
    if plain != KEY_CHECK_PLAINTEXT:
        raise ValueError(f"The configured encryption key cannot decrypt the key-check value of {db_path}.")

ENCRYPTION_SECRET = resolve_encryption_secret()
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
LOCAL_CALDAV_URL = os.environ.get("LOCAL_CALDAV_URL", "http://caldav-server:5232")
LOCAL_CALDAV_CERT_PATH = "/etc/ssl/certs/local/cert.pem"
SYSTEM_SYNC_SECRET = os.environ.get("SYSTEM_SYNC_SECRET")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from msgraph_worker import sync_msgraph_accounts

# #72: same format as server/db.js. Every value is AES-256-GCM under a key derived with scrypt from
# the install secret and a random salt of its own:
#   iv column (or token part before ':')        = salt (16 bytes) || nonce (12 bytes), hex
#   ciphertext column (or token part after ':') = ciphertext || auth tag (16 bytes), hex
SALT_BYTES = 16
NONCE_BYTES = 12
TAG_BYTES = 16


def key_material(secret_str):
    """The install secret as the input of the per-value scrypt derivation."""
    return secret_str.encode('utf-8')


@functools.lru_cache(maxsize=1024)
def _value_key(material, salt):
    # scrypt costs tens of milliseconds; each value's key is derived once per process.
    return Scrypt(salt=salt, length=32, n=16384, r=8, p=1).derive(material)


def decrypt(encrypted_hex, iv_hex, key_bytes):
    """Raises ValueError for a malformed, tampered or foreign-key value."""
    header = bytes.fromhex(iv_hex)
    body = bytes.fromhex(encrypted_hex)
    if len(header) != SALT_BYTES + NONCE_BYTES or len(body) < TAG_BYTES:
        raise ValueError("Stored value is not an AES-256-GCM value of this app")
    aesgcm = AESGCM(_value_key(bytes(key_bytes), header[:SALT_BYTES]))
    try:
        plain = aesgcm.decrypt(header[SALT_BYTES:], body, None)
    except InvalidTag as err:
        raise ValueError("Stored value failed authentication (tampered, corrupted or encrypted with another key)") from err
    return plain.decode('utf-8')


def encrypt(plain_text, key_bytes):
    salt = os.urandom(SALT_BYTES)
    nonce = os.urandom(NONCE_BYTES)
    encrypted = AESGCM(_value_key(bytes(key_bytes), salt)).encrypt(nonce, plain_text.encode('utf-8'), None)
    return encrypted.hex(), (salt + nonce).hex()


def encrypt_token(token, key_bytes):
    """A token column holds `iv:ciphertext` in one string; an absent token stays absent."""
    if not token:
        return token
    encrypted_hex, iv_hex = encrypt(token, key_bytes)
    return f"{iv_hex}:{encrypted_hex}"


def decrypt_token(token, key_bytes):
    """Raises ValueError for anything but an absent token or an encrypted value of this app."""
    if not token:
        return token
    if not _ENCRYPTED_TOKEN_RE.match(token):
        raise ValueError("Stored token is not an AES-256-GCM value of this app")
    iv_hex, encrypted_hex = token.split(":", 1)
    return decrypt(encrypted_hex, iv_hex, key_bytes)


KEY_BYTES = key_material(ENCRYPTION_SECRET) if ENCRYPTION_SECRET else None

def refresh_google_token(refresh_token):
    url = "https://oauth2.googleapis.com/token"
    data = urllib.parse.urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token"
    }).encode("utf-8")
    
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req) as res:
        res_data = json.loads(res.read().decode("utf-8"))
        # Access token and expiration timestamp in milliseconds
        expires_in = res_data.get("expires_in", 3600)
        expires_at_ms = int((time.time() + expires_in) * 1000)
        return res_data["access_token"], expires_at_ms

def discover_google_collections(google_url, access_token):
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Depth": "1",
        "Content-Type": "application/xml"
    }
    # PROPFIND body requesting displayname
    body = """<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname />
  </d:prop>
</d:propfind>"""
    
    req = urllib.request.Request(
        google_url,
        data=body.encode("utf-8"),
        headers=headers,
        method="PROPFIND"
    )
    
    try:
        import ssl
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, context=ctx) as res:
            xml_str = res.read().decode("utf-8")
            
        collections = []
        root = ET.fromstring(xml_str)
        for resp in root.findall('.//{*}response'):
            href_el = resp.find('{*}href')
            if href_el is None or not href_el.text:
                continue
            href = href_el.text
            
            # Google CalDAV collections end with /events/
            if not href.endswith('/events/'):
                continue
                
            displayname = ""
            disp_el = resp.find('.//{*}displayname')
            if disp_el is not None and disp_el.text:
                displayname = disp_el.text
                
            parts = href.split('/caldav/v2/')
            if len(parts) > 1:
                subparts = parts[1].split('/events/')
                if subparts:
                    cal_id = urllib.parse.unquote(subparts[0])
                    collections.append({
                        "id": cal_id,
                        "name": displayname or cal_id
                    })
        return collections
    except Exception as e:
        print(f"[Sync-Worker] Error discovering collections via PROPFIND: {e}")
        raise RuntimeError(f"Google collection discovery failed via PROPFIND: {e}") from e

import base64

class CrossUserRestoreError(Exception):
    """An event deleted by a sharee could not be put back; the sync must not run (#319)."""


def protect_cross_user_deletions(user_id, conn):
    """Put events that a sharee deleted from this owner's calendars back into the local Radicale (#319).

    The Basic-auth CalDAV and Google passes are two-way and would carry such a delete out into the
    owner's external calendar, where no shard backup can restore it. This therefore runs before
    any pass. The event is written back exactly as it was stored (href and ICS recorded by
    DELETE /api/events), with If-None-Match: * so an item created there in the meantime wins.
    A failed restore keeps its record and is raised, so no pass runs (#343).
    """
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, uid, href, ics FROM cross_user_deletions WHERE owner_user_id = ?",
        (user_id,)
    )
    for rec in cursor.fetchall():
        if not rec["href"].startswith("/"):
            raise CrossUserRestoreError(f"restoring event {rec['uid']} failed: href {rec['href']!r} is not a path")
        # The path may name the owner by username while the job runs under the UUID; Radicale's
        # rights plugin grants the owner by the path's first segment, so log in as that.
        path_owner = urllib.parse.unquote(rec["href"].split("/")[1])
        auth_str = base64.b64encode(f"{path_owner}:{SYSTEM_SYNC_SECRET}".encode("utf-8")).decode("ascii")
        put_url = f"{LOCAL_CALDAV_URL.rstrip('/')}{rec['href']}"
        req = urllib.request.Request(
            put_url,
            data=rec["ics"].encode("utf-8"),
            headers={
                "Content-Type": "text/calendar; charset=utf-8",
                "Authorization": f"Basic {auth_str}",
                "Accept-Encoding": "identity",
                "If-None-Match": "*",
            },
            method="PUT"
        )
        try:
            with urllib.request.urlopen(req, context=ssl_context_for(put_url, LOCAL_CALDAV_URL), timeout=30):
                print(f"[Sync-Worker] Restored event {rec['uid']} deleted by a sharee of owner {user_id}")
        except urllib.error.HTTPError as e:
            if e.code == 412:
                print(f"[Sync-Worker] Event {rec['uid']} exists again locally; keeping that version")
            elif e.code in (404, 409):
                # The calendar itself is gone, so there is nothing left to restore into or export from.
                print(f"[Sync-Worker] Calendar of event {rec['uid']} no longer exists; dropping its restore")
            else:
                raise CrossUserRestoreError(f"restoring event {rec['uid']} failed: {e}") from e
        except OSError as e:  # URLError, and TimeoutError while reading the response
            raise CrossUserRestoreError(f"restoring event {rec['uid']} failed: {e}") from e
        cursor.execute("DELETE FROM cross_user_deletions WHERE id = ?", (rec["id"],))
        conn.commit()


class SyncTimeout(Exception):
    """A vdirsyncer run exceeded VDIRSYNCER_TIMEOUT_SECONDS; the job is marked ERROR without retry."""


def ini_value(value):
    """Serialise a value for the vdirsyncer config (Issue #334).

    vdirsyncer reads the file with RawConfigParser and decodes each value with json.loads.
    json.dumps(ensure_ascii=True) escapes quotes, backslashes and every control or line-break
    character, so user-controlled values cannot end the line and inject keys or sections.
    """
    return json.dumps(value, ensure_ascii=True)


def local_caldav_verify_line():
    """TLS verification for the local Radicale storage (Issue #282).

    Needs vdirsyncer >= 0.19 (pinned in requirements.txt): `verify` must be a PEM path there,
    `verify_fingerprint` alone no longer trusts a self-signed cert, and `verify = false` is a
    fatal config error that stops every pair. Without the certificate the key is omitted, which
    keeps default verification (the shard topology talks plain HTTP to Radicale).
    """
    if os.path.exists(LOCAL_CALDAV_CERT_PATH):
        return f'verify = {ini_value(LOCAL_CALDAV_CERT_PATH)}'
    return ''


def legacy_google_collection_name(display_name):
    """Collection name earlier worker versions derived from the Google display name."""
    slug = unicodedata.normalize('NFKD', display_name).encode('ascii', 'ignore').decode('ascii').lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug).strip('-') or "calendar"
    return slug if slug.startswith("google-") else f"google-{slug}"


def create_local_collection(user_id, collection, display_name):
    """MKCALENDAR the paired collection in the user's Radicale principal, named by the Google calendar.

    The worker creates it rather than vdirsyncer so that the display name is set once, Google -> local;
    vdirsyncer metasync would also push renames made in the app back to Google.
    """
    url = f"{LOCAL_CALDAV_URL.rstrip('/')}/{user_id}/{collection}/"
    body = f"""<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:displayname>{xml_escape(display_name)}</d:displayname>
    </d:prop>
  </d:set>
</c:mkcalendar>"""
    auth_str = base64.b64encode(f"{user_id}:{SYSTEM_SYNC_SECRET}".encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        url,
        data=body.encode("utf-8"),
        headers={
            "Content-Type": "application/xml; charset=utf-8",
            "Authorization": f"Basic {auth_str}",
            "Accept-Encoding": "identity",
        },
        method="MKCALENDAR",
    )
    with urllib.request.urlopen(req, context=ssl_context_for(url, LOCAL_CALDAV_URL), timeout=30) as res:
        if res.status != 201:
            raise RuntimeError(f"MKCALENDAR {url} returned {res.status}")


def local_collection_for_google_calendar(conn, user_id, account_id, google_calendar, pair_status_dir):
    """Local Radicale collection paired with one Google calendar (Issue #193).

    The name is opaque (`google-<uuid hex>`) and persisted per (account, Google calendar id), so it
    never collides with an app calendar or another account's calendar of the same display name, and
    a rename on either side keeps the pair pointing at the same collection.

    A collection an earlier worker version synced under the display-name-derived name is adopted
    instead of downloading the calendar a second time, but only if this account's pair has vdirsyncer
    status for it (<status>/<pair>/<collection>.items) and no other Google calendar of the user owns it.
    """
    google_calendar_id = google_calendar["id"]
    row = conn.execute(
        "SELECT local_collection FROM google_calendar_collections WHERE account_id = ? AND google_calendar_id = ?",
        (account_id, google_calendar_id),
    ).fetchone()
    if row:
        return row[0]

    legacy = legacy_google_collection_name(google_calendar["name"])
    legacy_owned = conn.execute(
        "SELECT 1 FROM google_calendar_collections WHERE user_id = ? AND local_collection = ?",
        (user_id, legacy),
    ).fetchone()
    if not legacy_owned and os.path.exists(os.path.join(pair_status_dir, f"{legacy}.items")):
        local_collection = legacy
    else:
        local_collection = f"google-{uuid.uuid4().hex}"
        create_local_collection(user_id, local_collection, google_calendar["name"])
    conn.execute(
        "INSERT INTO google_calendar_collections"
        " (account_id, user_id, google_calendar_id, local_collection, created_at) VALUES (?, ?, ?, ?, ?)",
        (account_id, user_id, google_calendar_id, local_collection, int(time.time() * 1000)),
    )
    conn.commit()
    return local_collection


def create_private_config_dir():
    """Unpredictable per-run directory (mode 0700) for vdirsyncer config and token files."""
    return tempfile.mkdtemp(prefix=CONFIG_DIR_PREFIX)


def write_private_config(config_dir, content):
    """Write content to a fresh mode-0600 file inside config_dir and return its path."""
    fd, path = tempfile.mkstemp(suffix=".ini", dir=config_dir)
    with os.fdopen(fd, "w") as f:
        f.write(content)
    return path


PROGRESS_UPSERT = (
    "INSERT INTO sync_job_progress (job_id, items_done) VALUES (?, ?)"
    " ON CONFLICT(job_id) DO UPDATE SET items_done = items_done + excluded.items_done"
)


def record_sync_progress(cursor, items):
    """Adds `items` written events to the running job's progress (#174), which the web app shows.

    Outside a job (the worker run by hand) there is no progress to record.
    """
    if active_job_id is not None and items:
        cursor.execute(PROGRESS_UPSERT, (active_job_id, items))


# vdirsyncer logs one of these lines (stderr, INFO) for every item it writes to either side.
VDIRSYNCER_ITEM_MARKERS = ("Copying (uploading) item ", "Copying (updating) item ")


def _drain_vdirsyncer_log(read_fd, lines, job_id, db_path):
    conn = sqlite3.connect(db_path, timeout=30.0) if job_id is not None else None
    try:
        with os.fdopen(read_fd, "r", encoding="utf-8", errors="replace") as stream:
            for line in stream:
                lines.append(line)
                if conn is None or not any(marker in line for marker in VDIRSYNCER_ITEM_MARKERS):
                    continue
                try:
                    conn.execute(PROGRESS_UPSERT, (job_id, 1))
                    conn.commit()
                except sqlite3.OperationalError as progress_err:
                    # Only the progress display loses its count (logged here); the pipe must keep
                    # draining, or vdirsyncer would block on a full pipe.
                    print(f"[Sync-Worker] Sync progress of job {job_id} not recorded: {progress_err}", file=sys.stderr)
                    conn.close()
                    conn = None
    finally:
        if conn is not None:
            conn.close()


def run_vdirsyncer(config_path, command, stdin=None):
    # stderr goes through a pipe that a reader thread drains line by line, so the running job counts
    # the copied items while vdirsyncer is still at work (#174).
    read_fd, write_fd = os.pipe()
    lines = []
    reader = threading.Thread(target=_drain_vdirsyncer_log,
                              args=(read_fd, lines, active_job_id, active_job_db_path), daemon=True)
    reader.start()
    try:
        result = subprocess.run(
            ["vdirsyncer", "-c", config_path, command],
            input=stdin,
            stdout=subprocess.PIPE,
            stderr=write_fd,
            text=True,
            timeout=VDIRSYNCER_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise SyncTimeout(f"vdirsyncer {command} timed out after {VDIRSYNCER_TIMEOUT_SECONDS}s")
    finally:
        os.close(write_fd)
        reader.join()
    if result.stderr is None:
        result.stderr = "".join(lines)
    return result


def sync_basic_caldav_accounts(user_id, conn):
    """Replicate external CalDAV (Basic Auth) accounts into the local Radicale.

    For each linked account with auth_type='basic' we build a vdirsyncer
    caldav↔caldav pair: the external server is storage 'a', the local
    Radicale collection for this user is storage 'b'.  Conflict resolution
    defaults to 'b wins' so that manual local edits are authoritative.

    Returns (success: bool, error_message: str).
    """
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, url, username, password_encrypted, iv FROM linked_accounts"
        " WHERE user_id = ? AND auth_type = 'basic'",
        (user_id,)
    )
    basic_accounts = cursor.fetchall()

    if not basic_accounts:
        print(f"[Sync-Worker] No external Basic-Auth CalDAV accounts for user {user_id}.")
        return True, ""

    status_dir = os.path.join(get_status_root(), user_id + "_basic")
    os.makedirs(status_dir, exist_ok=True)

    config_content = f'[general]\nstatus_path = {ini_value(status_dir)}\n'

    verify_line = local_caldav_verify_line()
    local_url = f"{LOCAL_CALDAV_URL.rstrip('/')}/{user_id}/"

    for idx, acc in enumerate(basic_accounts):
        try:
            password = decrypt(acc["password_encrypted"], acc["iv"], KEY_BYTES)
        except (ValueError, TypeError) as de:
            return False, f"Basic-auth credential decryption failed for account {acc['id']}: {de}"

        pair_name    = f"basic_{idx}"
        storage_ext  = f"basic_ext_{idx}"
        storage_loc  = f"basic_local_{idx}"
        external_url = acc["url"].rstrip('/') + '/'
        username     = acc["username"]

        config_content += f"""
[pair {pair_name}]
a = "{storage_ext}"
b = "{storage_loc}"
collections = ["from a", "from b"]
conflict_resolution = "b wins"

[storage {storage_ext}]
type = "caldav"
url = {ini_value(external_url)}
username = {ini_value(username)}
password = {ini_value(password)}

[storage {storage_loc}]
type = "caldav"
url = {ini_value(local_url)}
username = {ini_value(user_id)}
password = {ini_value(SYSTEM_SYNC_SECRET)}
{verify_line}
"""

    config_dir = create_private_config_dir()
    try:
        config_path = write_private_config(config_dir, config_content)

        print(f"[Sync-Worker] Running Basic-CalDAV discover for user {user_id}...")
        disc_res = run_vdirsyncer(config_path, "discover", stdin="y\n" * 20)
        if disc_res.returncode != 0:
            return False, f"vdirsyncer basic discover failed: {disc_res.stderr}"

        print(f"[Sync-Worker] Running Basic-CalDAV sync for user {user_id}...")
        sync_res = run_vdirsyncer(config_path, "sync")
        if sync_res.returncode != 0:
            return False, f"vdirsyncer basic sync failed: {sync_res.stderr}"

        print(f"[Sync-Worker] Basic-CalDAV sync completed for user {user_id}.")
        return True, ""
    except SyncTimeout:
        raise
    # Reported as the sync job's error_message, which the user sees in the account status.
    except Exception as run_err:  # noqa: BLE001
        return False, f"vdirsyncer basic runner exception: {run_err}"
    finally:
        shutil.rmtree(config_dir)


def sync_user(user_id):
    print(f"[Sync-Worker] Sync starting for user {user_id}...")
    conn = sqlite3.connect(get_db_path(), timeout=30.0)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # 1. Fetch all linked accounts for the user (both oauth2 and basic)
    cursor.execute(
        "SELECT id, url, username, password_encrypted, iv, auth_type, access_token, expires_at"
        " FROM linked_accounts WHERE user_id = ? ORDER BY rowid",
        (user_id,)
    )
    all_accounts = cursor.fetchall()

    cursor.execute(
        "SELECT id FROM msgraph_accounts WHERE user_id = ?",
        (user_id,)
    )
    msgraph_accounts_list = cursor.fetchall()

    oauth2_accounts = [a for a in all_accounts if a["auth_type"] == "oauth2"]
    basic_accounts  = [a for a in all_accounts if a["auth_type"] == "basic"]

    if all_accounts:
        # Before any two-way pass: undo sharee deletes so none of them is exported (#319).
        try:
            protect_cross_user_deletions(user_id, conn)
        except CrossUserRestoreError as restore_err:
            conn.close()
            return False, str(restore_err)
    else:
        # Only the CalDAV / Google pairs write outward (MS Graph only imports), so without them
        # a sharee's delete cannot leave the shard and stands.
        cursor.execute("DELETE FROM cross_user_deletions WHERE owner_user_id = ?", (user_id,))
        conn.commit()

    if not oauth2_accounts and not basic_accounts and not msgraph_accounts_list:
        print(f"[Sync-Worker] No external accounts found for user {user_id}. Skipping.")
        conn.close()
        return True, ""

    # Run Basic-CalDAV replication first (independent of OAuth2 path)
    try:
        basic_ok, basic_err = sync_basic_caldav_accounts(user_id, conn)
    except SyncTimeout:
        conn.close()
        raise
    if not basic_ok:
        conn.close()
        return False, basic_err

    # Run MS Graph / M365 replication. A Microsoft account that fails (e.g. one waiting to be
    # reconnected, #97) does not stop the Google pairs; its error is the job's result at the end.
    msgraph_ok, msgraph_err = sync_msgraph_accounts(user_id, conn)

    if not oauth2_accounts:
        conn.close()
        return msgraph_ok, msgraph_err

    # --- OAuth2 / Google path ---

    status_dir = os.path.join(get_status_root(), user_id)
    os.makedirs(status_dir, exist_ok=True)

    # We build a vdirsyncer configuration file dynamically
    config_content = f"""[general]
status_path = {ini_value(status_dir)}
"""

    config_dir = create_private_config_dir()
    pairs_written = 0
    try:
        for idx, acc in enumerate(oauth2_accounts):
            acc_id = acc["id"]
            # Decrypt refresh token
            try:
                refresh_token = decrypt(acc["password_encrypted"], acc["iv"], KEY_BYTES)
                access_token = decrypt_token(acc["access_token"], KEY_BYTES)
            except (ValueError, TypeError) as decrypt_err:
                conn.close()
                return False, f"Token decryption failed: {str(decrypt_err)}"

            # Check if Google access token is expired or close to expiration (within 5 minutes)
            expires_at = acc["expires_at"]
            
            now_ms = int(time.time() * 1000)
            # Normalize expires_at if DB contains legacy seconds values (< 10^10)
            expires_at_ms = (expires_at * 1000) if (expires_at and expires_at < 10000000000) else expires_at
            
            if not access_token or not expires_at_ms or expires_at_ms < now_ms + 300000:
                print(f"[Sync-Worker] Refreshing Google token for account {acc['username']}...")
                try:
                    access_token, new_expires = refresh_google_token(refresh_token)
                    # Store back to DB in milliseconds
                    cursor.execute(
                        "UPDATE linked_accounts SET access_token = ?, expires_at = ? WHERE id = ?",
                        (encrypt_token(access_token, KEY_BYTES), new_expires, acc_id)
                    )
                    conn.commit()
                    expires_at = new_expires
                    expires_at_ms = new_expires
                    print("[Sync-Worker] Google token refreshed successfully.")
                # Reported as the sync job's error_message, which the user sees in the account status.
                except Exception as refresh_err:  # noqa: BLE001
                    conn.close()
                    return False, f"Google token refresh failed: {str(refresh_err)}"

            # Configure pairing for this account
            pair_name = f"sync_{idx}"
            storage_google = f"google_{idx}"
            storage_local = f"local_{idx}"

            # Write the token file for vdirsyncer google_calendar storage (vdirsyncer expects seconds)
            expires_at_sec = (expires_at_ms / 1000.0) if expires_at_ms else (time.time() + 3600)
            token_file_path = os.path.join(config_dir, f"google_token_{idx}.json")
            token_data = {
                "access_token": access_token,
                "refresh_token": refresh_token,
                "token_type": "Bearer",
                "expires_in": 3600,
                "expires_at": expires_at_sec
            }
            try:
                with os.fdopen(os.open(token_file_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as tf:
                    json.dump(token_data, tf)
            except OSError as write_err:
                conn.close()
                return False, f"Failed to write Google token file: {str(write_err)}"

            # Discover Google collections and pair each with its persisted opaque local collection.
            # The display name reaches Radicale as `displayname`, never as the path.
            try:
                google_collections = discover_google_collections(acc["url"], access_token)
            except RuntimeError as disc_err:
                conn.close()
                return False, f"Google collection discovery failed: {str(disc_err)}"
            items = []
            for col in google_collections or []:
                try:
                    local_collection = local_collection_for_google_calendar(
                        conn, user_id, acc_id, col, os.path.join(status_dir, pair_name))
                # Reported as the sync job's error_message, which the user sees in the account status.
                except Exception as map_err:  # noqa: BLE001
                    conn.close()
                    return False, f"Local collection for Google calendar {col['id']} failed: {map_err}"
                items.append([local_collection, col["id"], local_collection])

            if not items:
                # "from a" would let vdirsyncer name local collections itself, unmapped.
                mapped = conn.execute(
                    "SELECT 1 FROM google_calendar_collections WHERE account_id = ?", (acc_id,)
                ).fetchone()
                if mapped:
                    conn.close()
                    return False, f"Google discovery returned no calendars for account {acc_id}, which has synced calendars"
                print(f"[Sync-Worker] No Google calendars discovered for account {acc_id}. Skipping.")
                continue
            collections_toml = f"collections = {ini_value(items)}"
            pairs_written += 1

            verify_line = local_caldav_verify_line()
            local_url = f"{LOCAL_CALDAV_URL.rstrip('/')}/{user_id}/"

            config_content += f"""
[pair {pair_name}]
a = "{storage_google}"
b = "{storage_local}"
{collections_toml}
conflict_resolution = "b wins"

[storage {storage_google}]
type = "google_calendar"
token_file = {ini_value(token_file_path)}
client_id = {ini_value(GOOGLE_CLIENT_ID)}
client_secret = {ini_value(GOOGLE_CLIENT_SECRET)}

[storage {storage_local}]
type = "caldav"
url = {ini_value(local_url)}
username = {ini_value(user_id)}
password = {ini_value(SYSTEM_SYNC_SECRET)}
{verify_line}
"""

        conn.close()

        if not pairs_written:
            return msgraph_ok, msgraph_err

        config_path = write_private_config(config_dir, config_content)

        # Run vdirsyncer discover and sync
        print(f"[Sync-Worker] Running discover for user {user_id}...")
        disc_res = run_vdirsyncer(config_path, "discover", stdin="y\n" * 20)
        if disc_res.returncode != 0:
            return False, f"vdirsyncer discover failed: {disc_res.stderr}"

        print(f"[Sync-Worker] Running sync for user {user_id}...")
        sync_res = run_vdirsyncer(config_path, "sync")
        if sync_res.returncode != 0:
            return False, f"vdirsyncer sync failed: {sync_res.stderr}"

        print(f"[Sync-Worker] Sync completed successfully for user {user_id}.")
        return msgraph_ok, msgraph_err
    except SyncTimeout:
        raise
    # Reported as the sync job's error_message, which the user sees in the account status.
    except Exception as run_err:  # noqa: BLE001
        return False, f"vdirsyncer runner exception: {str(run_err)}"
    finally:
        shutil.rmtree(config_dir)

def process_next_job(db_path=None):
    """Fetches and processes one pending sync job safely without stranding in RUNNING."""
    target_db = db_path or DB_PATH
    if not os.path.exists(target_db):
        return False

    conn = sqlite3.connect(target_db)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Auto-prune completed/errored jobs older than 24 hours (86400000 ms)
    now_ms = int(time.time() * 1000)
    cutoff_ms = now_ms - (24 * 60 * 60 * 1000)
    cursor.execute(
        "DELETE FROM sync_queue WHERE status IN ('SUCCESS', 'ERROR') AND updated_at <= ?",
        (cutoff_ms,)
    )

    # Fetch the oldest pending job that is due for execution
    cursor.execute(
        "SELECT id, user_id, COALESCE(attempts, 0) AS attempts, COALESCE(max_attempts, 3) AS max_attempts FROM sync_queue WHERE status = 'PENDING' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at ASC LIMIT 1",
        (now_ms,)
    )
    job = cursor.fetchone()
    if not job:
        conn.commit()
        conn.close()
        return False

    job_id = job["id"]
    user_id = job["user_id"]
    attempts = job["attempts"]
    max_attempts = job["max_attempts"]

    # Mark job as RUNNING atomically using conditional UPDATE
    cursor.execute(
        "UPDATE sync_queue SET status = 'RUNNING', updated_at = ? WHERE id = ? AND status = 'PENDING'",
        (int(time.time() * 1000), job_id)
    )
    claimed = cursor.rowcount > 0
    if claimed:
        # A retried job counts its progress anew (#174).
        cursor.execute("DELETE FROM sync_job_progress WHERE job_id = ?", (job_id,))
    conn.commit()
    conn.close()

    if not claimed:
        return False

    global active_job_id, active_job_db_path
    active_job_id = job_id
    active_job_db_path = target_db

    # Safely execute sync_user
    success = False
    error_msg = ""
    timed_out = False
    try:
        success, error_msg = sync_user(user_id)
    except SyncTimeout as exc:
        print(f"[Sync-Worker] Sync for user {user_id} timed out: {exc}")
        timed_out = True
        error_msg = str(exc)
    # Any failure of one job is recorded on that job (error_message) instead of stopping the queue.
    except Exception as exc:  # noqa: BLE001
        print(f"[Sync-Worker] Unguarded exception during sync_user({user_id}): {exc}", file=sys.stderr)
        success = False
        error_msg = f"Unguarded exception: {str(exc)}"

    # Safely update job status after execution
    try:
        conn = sqlite3.connect(target_db)
        conn.execute("PRAGMA foreign_keys = ON")
        cursor = conn.cursor()
        now_ms = int(time.time() * 1000)
        if success:
            cursor.execute(
                "UPDATE sync_queue SET status = 'SUCCESS', error_message = NULL, attempts = ?, retry_state = 'IDLE', next_retry_at = NULL, updated_at = ? WHERE id = ?",
                (attempts + 1, now_ms, job_id)
            )
        else:
            print(f"[Sync-Worker] Job failed: {error_msg}")
            new_attempts = attempts + 1
            if timed_out:
                # A hanging remote would block the queue for the full timeout on every retry.
                cursor.execute(
                    "UPDATE sync_queue SET status = 'ERROR', error_message = ?, attempts = ?, retry_state = 'TIMEOUT', next_retry_at = NULL, updated_at = ? WHERE id = ?",
                    (error_msg, new_attempts, now_ms, job_id)
                )
            elif new_attempts < max_attempts:
                backoff_ms = min(5000 * (2 ** (new_attempts - 1)), 300000)
                next_retry_at = now_ms + backoff_ms
                cursor.execute(
                    "UPDATE sync_queue SET status = 'PENDING', error_message = ?, attempts = ?, retry_state = 'RETRY_PENDING', next_retry_at = ?, updated_at = ? WHERE id = ?",
                    (error_msg, new_attempts, next_retry_at, now_ms, job_id)
                )
            else:
                cursor.execute(
                    "UPDATE sync_queue SET status = 'ERROR', error_message = ?, attempts = ?, retry_state = 'MAX_RETRIES_EXCEEDED', next_retry_at = NULL, updated_at = ? WHERE id = ?",
                    (error_msg, new_attempts, now_ms, job_id)
                )
        conn.commit()
        conn.close()
    finally:
        active_job_id = None
        active_job_db_path = None

    return True

def main():
    print("[Sync-Worker] Daemon started. Monitoring sqlite sync queue...")
    
    # Wait for DB to be created by the web app
    while not os.path.exists(DB_PATH) and not shutdown_requested:
        print(f"[Sync-Worker] Waiting for database at {DB_PATH}...")
        for _ in range(5):
            if shutdown_requested:
                break
            time.sleep(1)

    if shutdown_requested:
        return

    # Issue #333: never sync with a key that does not belong to this database.
    verify_encryption_key(DB_PATH, KEY_BYTES)

    # Recover any stranded jobs left over from previous unclean process termination/SIGKILL
    recover_stranded_jobs(DB_PATH)

    while not shutdown_requested:
        try:
            process_next_job(DB_PATH)
        # The daemon outlives a failing iteration (e.g. a locked database); the error is logged
        # with its traceback and the next poll retries.
        except Exception:  # noqa: BLE001
            print("[Sync-Worker] Queue loop error:", file=sys.stderr)
            traceback.print_exc()
            
        for _ in range(5):
            if shutdown_requested:
                break
            time.sleep(1)

if __name__ == '__main__':
    main()
