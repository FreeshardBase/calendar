#!/usr/bin/env python3
import sys
import os
import sqlite3
import hashlib
import time
import subprocess
import urllib.request
import urllib.parse
import json
import xml.etree.ElementTree as ET
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

# Configuration variables from environment
DB_PATH = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")
STATUS_ROOT = os.environ.get("STATUS_ROOT", "/data/vdir_status")

def get_db_path():
    return os.environ.get("DATABASE_PATH", DB_PATH)
_weak_keys = {
    "freeshard-default-encryption-key-do-not-use-in-prod",
    "freeshard-default-key",
    "change-me",
    "change-me-32-chars-or-more",
    "portal.id",
    "{{ portal.id }}",
    "{{portal.id}}",
}

def resolve_encryption_secret(env=None, target_db_path=None):
    if env is None:
        env = os.environ
    if target_db_path is None:
        target_db_path = get_db_path()

    key_file_path = env.get("ENCRYPTION_KEY_FILE") or os.path.join(os.path.dirname(target_db_path), ".encryption_key")
    if os.path.exists(key_file_path):
        try:
            with open(key_file_path, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if content:
                    return content
        except Exception:
            pass

    secret = env.get("ENCRYPTION_KEY") or env.get("ENCRYPTION_SECRET") or os.environ.get("ENCRYPTION_KEY") or os.environ.get("ENCRYPTION_SECRET") or "freeshard-default-encryption-key-do-not-use-in-prod"
    node_env = env.get("NODE_ENV", "").lower()
    if (node_env in ["production", "staging"] and 
        env.get("ALLOW_INSECURE_ENCRYPTION_KEY") != "true" and 
        (not secret or secret.strip() in _weak_keys or "portal.id" in secret.lower())):
        raise ValueError("ENCRYPTION_KEY must be explicitly configured with a secure, unique key per install in production environment.")

    try:
        key_dir = os.path.dirname(key_file_path)
        if os.path.exists(key_dir):
            with open(key_file_path, "w", encoding="utf-8") as f:
                f.write(secret)
    except Exception:
        pass

    return secret

ENCRYPTION_SECRET = resolve_encryption_secret()
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
LOCAL_CALDAV_URL = os.environ.get("LOCAL_CALDAV_URL", "http://caldav-server:5232")
SYSTEM_SYNC_SECRET = os.environ.get("SYSTEM_SYNC_SECRET", "super-secret-bypass")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from msgraph_worker import sync_msgraph_accounts
except ImportError:
    def sync_msgraph_accounts(user_id, conn=None):
        return True, ""

ENCRYPTION_SALT = os.environ.get("ENCRYPTION_SALT", "salt").encode('utf-8')

def derive_key(secret_str, salt=None):
    if salt is None:
        salt_bytes = ENCRYPTION_SALT
    elif isinstance(salt, str):
        salt_bytes = salt.encode('utf-8')
    else:
        salt_bytes = salt
    kdf = Scrypt(
        salt=salt_bytes,
        length=32,
        n=16384,
        r=8,
        p=1,
        backend=default_backend()
    )
    return kdf.derive(secret_str.encode('utf-8'))

def decrypt(encrypted_hex, iv_hex, key_bytes):
    encrypted = bytes.fromhex(encrypted_hex)
    iv = bytes.fromhex(iv_hex)
    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv), backend=default_backend())
    decryptor = cipher.decryptor()
    decrypted = decryptor.update(encrypted) + decryptor.finalize()
    # Remove PKCS7 padding
    padding_len = decrypted[-1]
    return decrypted[:-padding_len].decode('utf-8')

def encrypt(plain_text, key_bytes):
    iv = os.urandom(16)
    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv), backend=default_backend())
    encryptor = cipher.encryptor()
    padding_len = 16 - (len(plain_text.encode('utf-8')) % 16)
    padded = plain_text.encode('utf-8') + bytes([padding_len] * padding_len)
    encrypted = encryptor.update(padded) + encryptor.finalize()
    return encrypted.hex(), iv.hex()

def encrypt_token(token, key_bytes):
    if not token or (isinstance(token, str) and ":" in token and len(token.split(":", 1)[0]) == 32):
        return token
    encrypted_hex, iv_hex = encrypt(token, key_bytes)
    return f"{iv_hex}:{encrypted_hex}"

# Derive key once on startup
KEY_BYTES = derive_key(ENCRYPTION_SECRET)

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
        return []

import base64

def fetch_external_event_ics(url, access_token, uid):
    try:
        event_url = f"{url.rstrip('/')}/{uid}.ics"
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Accept": "text/calendar, application/xml, */*"
        }
        req = urllib.request.Request(event_url, headers=headers, method="GET")
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with urllib.request.urlopen(req, context=ctx) as res:
            if res.status == 200:
                return res.read().decode("utf-8")
    except Exception:
        pass
    return None

def protect_cross_user_deletions(user_id, conn, accounts):
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, uid, calendar_id, deleted_by FROM cross_user_deletions WHERE owner_user_id = ?",
            (user_id,)
        )
        records = cursor.fetchall()
        if not records:
            return

        for rec in records:
            rec_id = rec["id"]
            uid = rec["uid"]
            calendar_id = rec["calendar_id"]
            
            parts = calendar_id.split('::')
            calendar_href = parts[1] if len(parts) > 1 else parts[0]
            segments = [s for s in calendar_href.split('/') if s]
            calendar_slug = segments[1] if len(segments) > 1 else "persoenlich"

            for acc in accounts:
                access_token = acc["access_token"] if "access_token" in acc.keys() else None
                url = acc["url"] if "url" in acc.keys() else None
                if not access_token or not url:
                    continue

                event_ics = fetch_external_event_ics(url, access_token, uid)
                if event_ics:
                    local_put_url = f"{LOCAL_CALDAV_URL.rstrip('/')}/{user_id}/{calendar_slug}/{uid}.ics"
                    auth_str = base64.b64encode(f"{user_id}:{SYSTEM_SYNC_SECRET}".encode("utf-8")).decode("ascii")
                    req = urllib.request.Request(
                        local_put_url,
                        data=event_ics.encode("utf-8"),
                        headers={
                            "Content-Type": "text/calendar; charset=utf-8",
                            "Authorization": f"Basic {auth_str}"
                        },
                        method="PUT"
                    )
                    try:
                        import ssl
                        ctx = ssl.create_default_context()
                        ctx.check_hostname = False
                        ctx.verify_mode = ssl.CERT_NONE
                        with urllib.request.urlopen(req, context=ctx) as res:
                            print(f"[Sync-Worker] Protected & restored cross-user deleted event {uid} for owner {user_id}")
                    except Exception as put_err:
                        print(f"[Sync-Worker] Error restoring event {uid}: {put_err}")

            cursor.execute("DELETE FROM cross_user_deletions WHERE id = ?", (rec_id,))
        conn.commit()
    except Exception as e:
        print(f"[Sync-Worker] Error in protect_cross_user_deletions: {e}")

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

    status_dir = os.path.join(STATUS_ROOT, user_id + "_basic")
    os.makedirs(status_dir, exist_ok=True)
    config_path = f"/tmp/vdir_basic_{user_id}.ini"

    config_content = f'[general]\nstatus_path = "{status_dir}"\n'

    # Determine SSL verification for local CalDAV
    cert_path = "/etc/ssl/certs/local/cert.pem"
    fingerprint = None
    if os.path.exists(cert_path):
        try:
            from cryptography import x509
            from cryptography.hazmat.backends import default_backend
            from cryptography.hazmat.primitives import hashes
            with open(cert_path, "rb") as cf:
                cert_data = cf.read()
            cert = x509.load_pem_x509_certificate(cert_data, default_backend())
            fingerprint = cert.fingerprint(hashes.SHA256()).hex()
        except Exception as fe:
            print(f"[Sync-Worker] Error reading certificate fingerprint: {fe}")

    verify_line = f'verify_fingerprint = "{fingerprint}"' if fingerprint else 'verify = false'
    local_url = f"{LOCAL_CALDAV_URL.rstrip('/')}/{user_id}/"

    for idx, acc in enumerate(basic_accounts):
        try:
            password = decrypt(acc["password_encrypted"], acc["iv"], KEY_BYTES)
        except Exception as de:
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
url = "{external_url}"
username = "{username}"
password = "{password}"

[storage {storage_loc}]
type = "caldav"
url = "{local_url}"
username = "{user_id}"
password = "{SYSTEM_SYNC_SECRET}"
{verify_line}
"""

    with open(config_path, "w") as f:
        f.write(config_content)

    try:
        print(f"[Sync-Worker] Running Basic-CalDAV discover for user {user_id}...")
        disc_res = subprocess.run(
            ["vdirsyncer", "-c", config_path, "discover"],
            input="y\n" * 20,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        if disc_res.returncode != 0:
            return False, f"vdirsyncer basic discover failed: {disc_res.stderr}"

        print(f"[Sync-Worker] Running Basic-CalDAV sync for user {user_id}...")
        sync_res = subprocess.run(
            ["vdirsyncer", "-c", config_path, "sync"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        if sync_res.returncode != 0:
            return False, f"vdirsyncer basic sync failed: {sync_res.stderr}"

        print(f"[Sync-Worker] Basic-CalDAV sync completed for user {user_id}.")
        return True, ""
    except Exception as run_err:
        return False, f"vdirsyncer basic runner exception: {run_err}"
    finally:
        if os.path.exists(config_path):
            os.remove(config_path)


def sync_user(user_id):
    print(f"[Sync-Worker] Sync starting for user {user_id}...")
    conn = sqlite3.connect(get_db_path())
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # 1. Fetch all linked accounts for the user (both oauth2 and basic)
    cursor.execute(
        "SELECT id, url, username, password_encrypted, iv, auth_type, access_token, expires_at"
        " FROM linked_accounts WHERE user_id = ?",
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

    if not oauth2_accounts and not basic_accounts and not msgraph_accounts_list:
        print(f"[Sync-Worker] No external accounts found for user {user_id}. Skipping.")
        conn.close()
        return True, ""

    # Run Basic-CalDAV replication first (independent of OAuth2 path)
    basic_ok, basic_err = sync_basic_caldav_accounts(user_id, conn)
    if not basic_ok:
        conn.close()
        return False, basic_err

    # Run MS Graph / M365 replication
    msgraph_ok, msgraph_err = sync_msgraph_accounts(user_id, conn)
    if not msgraph_ok:
        conn.close()
        return False, msgraph_err

    if not oauth2_accounts:
        conn.close()
        return True, ""

    # --- OAuth2 / Google path ---

    # Protect against cross-user deletions prior to vdirsyncer execution
    protect_cross_user_deletions(user_id, conn, oauth2_accounts)

    config_path = f"/tmp/vdir_{user_id}.ini"
    status_dir = os.path.join(STATUS_ROOT, user_id)
    os.makedirs(status_dir, exist_ok=True)

    # We build a vdirsyncer configuration file dynamically
    config_content = f"""[general]
status_path = "{status_dir}"
"""

    updated_accounts = []
    
    for idx, acc in enumerate(oauth2_accounts):
        acc_id = acc["id"]
        # Decrypt refresh token
        try:
            refresh_token = decrypt(acc["password_encrypted"], acc["iv"], KEY_BYTES)
        except Exception as decrypt_err:
            conn.close()
            return False, f"Token decryption failed: {str(decrypt_err)}"

        # Check if Google access token is expired or close to expiration (within 5 minutes)
        access_token = acc["access_token"]
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
                    (access_token, new_expires, acc_id)
                )
                conn.commit()
                expires_at = new_expires
                expires_at_ms = new_expires
                print(f"[Sync-Worker] Google token refreshed successfully.")
            except Exception as refresh_err:
                conn.close()
                return False, f"Google token refresh failed: {str(refresh_err)}"

        # Configure pairing for this account
        pair_name = f"sync_{idx}"
        storage_google = f"google_{idx}"
        storage_local = f"local_{idx}"

        # Write the token file for vdirsyncer google_calendar storage (vdirsyncer expects seconds)
        expires_at_sec = (expires_at_ms / 1000.0) if expires_at_ms else (time.time() + 3600)
        token_file_path = f"/tmp/google_token_{user_id}_{idx}.json"
        token_data = {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "expires_at": expires_at_sec
        }
        try:
            with open(token_file_path, "w") as tf:
                json.dump(token_data, tf)
            updated_accounts.append(token_file_path)
        except Exception as write_err:
            conn.close()
            return False, f"Failed to write Google token file: {str(write_err)}"

        # Discover Google collections to create friendly mapped slugs
        google_collections = discover_google_collections(acc["url"], access_token)
        collections_mapped = []
        if google_collections:
            for col in google_collections:
                google_id = col["id"]
                friendly_name = col["name"]
                
                # Slugify the display name
                import re
                import unicodedata
                slug = unicodedata.normalize('NFKD', friendly_name).encode('ascii', 'ignore').decode('ascii')
                slug = slug.lower()
                slug = re.sub(r'[^a-z0-9]+', '-', slug)
                slug = slug.strip('-')
                
                if not slug:
                    slug = "calendar"
                
                # Deduplicate slugs
                base_slug = slug
                collision_idx = 1
                while any(c[1] == slug for c in collections_mapped):
                    slug = f"{base_slug}-{collision_idx}"
                    collision_idx += 1
                    
                collections_mapped.append([google_id, slug])

        if collections_mapped:
            items = []
            for item in collections_mapped:
                items.append(f'["{item[1]}", "{item[0]}", "{item[1]}"]')
            collections_toml = f"collections = [{', '.join(items)}]"
        else:
            collections_toml = 'collections = ["from a"]'

        # Determine SSL verification for local CalDAV server
        cert_path = "/etc/ssl/certs/local/cert.pem"
        fingerprint = None
        if os.path.exists(cert_path):
            try:
                from cryptography import x509
                from cryptography.hazmat.backends import default_backend
                from cryptography.hazmat.primitives import hashes
                with open(cert_path, "rb") as cf:
                    cert_data = cf.read()
                cert = x509.load_pem_x509_certificate(cert_data, default_backend())
                fingerprint = cert.fingerprint(hashes.SHA256()).hex()
            except Exception as fe:
                print(f"[Sync-Worker] Error reading certificate fingerprint: {fe}")

        verify_line = f'verify_fingerprint = "{fingerprint}"' if fingerprint else 'verify = false'

        local_url = f"{LOCAL_CALDAV_URL.rstrip('/')}/{user_id}/"

        config_content += f"""
[pair {pair_name}]
a = "{storage_google}"
b = "{storage_local}"
{collections_toml}
conflict_resolution = "b wins"

[storage {storage_google}]
type = "google_calendar"
token_file = "{token_file_path}"
client_id = "{GOOGLE_CLIENT_ID}"
client_secret = "{GOOGLE_CLIENT_SECRET}"

[storage {storage_local}]
type = "caldav"
url = "{local_url}"
username = "{user_id}"
password = "{SYSTEM_SYNC_SECRET}"
{verify_line}
"""

    conn.close()

    # Write config file
    with open(config_path, "w") as f:
        f.write(config_content)

    # Run vdirsyncer discover and sync
    try:
        print(f"[Sync-Worker] Running discover for user {user_id}...")
        disc_res = subprocess.run(
            ["vdirsyncer", "-c", config_path, "discover"],
            input="y\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\n",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        if disc_res.returncode != 0:
            return False, f"vdirsyncer discover failed: {disc_res.stderr}"

        print(f"[Sync-Worker] Running sync for user {user_id}...")
        sync_res = subprocess.run(
            ["vdirsyncer", "-c", config_path, "sync"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        if sync_res.returncode != 0:
            return False, f"vdirsyncer sync failed: {sync_res.stderr}"

        print(f"[Sync-Worker] Sync completed successfully for user {user_id}.")
        return True, ""
    except Exception as run_err:
        return False, f"vdirsyncer runner exception: {str(run_err)}"
    finally:
        if os.path.exists(config_path):
            os.remove(config_path)
        for tf_path in updated_accounts:
            if os.path.exists(tf_path):
                os.remove(tf_path)

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
    conn.commit()
    claimed = cursor.rowcount > 0
    conn.close()

    if not claimed:
        return False

    # Safely execute sync_user
    success = False
    error_msg = ""
    try:
        success, error_msg = sync_user(user_id)
    except Exception as exc:
        print(f"[Sync-Worker] Unguarded exception during sync_user({user_id}): {exc}")
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
            if new_attempts < max_attempts:
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
    except Exception as db_err:
        print(f"[Sync-Worker] Error updating sync job status in database: {db_err}")

    return True

def main():
    print("[Sync-Worker] Daemon started. Monitoring sqlite sync queue...")
    
    # Wait for DB to be created by the web app
    while not os.path.exists(DB_PATH):
        print(f"[Sync-Worker] Waiting for database at {DB_PATH}...")
        time.sleep(5)

    while True:
        try:
            process_next_job(DB_PATH)
        except Exception as loop_err:
            print(f"[Sync-Worker] Queue loop error: {str(loop_err)}")
            
        time.sleep(5)

if __name__ == '__main__':
    main()
