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
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

# Configuration variables from environment
DB_PATH = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")
STATUS_ROOT = os.environ.get("STATUS_ROOT", "/data/vdir_status")
ENCRYPTION_SECRET = os.environ.get("ENCRYPTION_KEY", "default-secret-key-32-chars-long!")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
LOCAL_CALDAV_URL = os.environ.get("LOCAL_CALDAV_URL", "http://caldav-server:5232")
SYSTEM_SYNC_SECRET = os.environ.get("SYSTEM_SYNC_SECRET", "super-secret-bypass")

def derive_key(secret_str):
    kdf = Scrypt(
        salt=b'salt',
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
        # Access token and seconds until expiration
        return res_data["access_token"], int(time.time() + res_data.get("expires_in", 3600))

def sync_user(user_id):
    print(f"[Sync-Worker] Sync starting for user {user_id}...")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # 1. Fetch all linked OAuth2/Google accounts for the user
    cursor.execute(
        "SELECT id, url, username, password_encrypted, iv, auth_type, access_token, expires_at FROM linked_accounts WHERE user_id = ? AND auth_type = 'oauth2'",
        (user_id,)
    )
    accounts = cursor.fetchall()
    if not accounts:
        print(f"[Sync-Worker] No external OAuth2 accounts found for user {user_id}. Skipping.")
        conn.close()
        return True, ""

    config_path = f"/tmp/vdir_{user_id}.ini"
    status_dir = os.path.join(STATUS_ROOT, user_id)
    os.makedirs(status_dir, exist_ok=True)

    # We build a vdirsyncer configuration file dynamically
    config_content = f"""[general]
status_path = "{status_dir}"
"""

    updated_accounts = []
    
    for idx, acc in enumerate(accounts):
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
        
        if not access_token or not expires_at or expires_at < time.time() + 300:
            print(f"[Sync-Worker] Refreshing Google token for account {acc['username']}...")
            try:
                access_token, new_expires = refresh_google_token(refresh_token)
                # Store back to DB
                cursor.execute(
                    "UPDATE linked_accounts SET access_token = ?, expires_at = ? WHERE id = ?",
                    (access_token, new_expires, acc_id)
                )
                conn.commit()
                print(f"[Sync-Worker] Google token refreshed successfully.")
            except Exception as refresh_err:
                conn.close()
                return False, f"Google token refresh failed: {str(refresh_err)}"

        # Configure pairing for this account
        pair_name = f"sync_{idx}"
        storage_google = f"google_{idx}"
        storage_local = f"local_{idx}"

        # Write the token file for vdirsyncer google_calendar storage
        token_file_path = f"/tmp/google_token_{user_id}_{idx}.json"
        token_data = {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "expires_at": expires_at / 1000.0 if expires_at else time.time() + 3600
        }
        try:
            with open(token_file_path, "w") as tf:
                json.dump(token_data, tf)
            updated_accounts.append(token_file_path)
        except Exception as write_err:
            conn.close()
            return False, f"Failed to write Google token file: {str(write_err)}"

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

        verify_line = f'verify_fingerprint = "{fingerprint}"' if fingerprint else ""

        local_url = f"{LOCAL_CALDAV_URL.rstrip('/')}/{user_id}/"

        config_content += f"""
[pair {pair_name}]
a = "{storage_google}"
b = "{storage_local}"
collections = ["from a"]

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

def main():
    print("[Sync-Worker] Daemon started. Monitoring sqlite sync queue...")
    
    # Wait for DB to be created by the web app
    while not os.path.exists(DB_PATH):
        print(f"[Sync-Worker] Waiting for database at {DB_PATH}...")
        time.sleep(5)

    while True:
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            
            # Fetch the oldest pending job
            cursor.execute(
                "SELECT id, user_id FROM sync_queue WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 1"
            )
            job = cursor.fetchone()
            
            if job:
                job_id = job["id"]
                user_id = job["user_id"]
                
                # Mark job as running
                cursor.execute(
                    "UPDATE sync_queue SET status = 'RUNNING', updated_at = ? WHERE id = ?",
                    (int(time.time() * 1000), job_id)
                )
                conn.commit()
                conn.close()
                
                success, error_msg = sync_user(user_id)
                
                # Update job status
                conn = sqlite3.connect(DB_PATH)
                cursor = conn.cursor()
                if success:
                    cursor.execute(
                        "UPDATE sync_queue SET status = 'SUCCESS', updated_at = ? WHERE id = ?",
                        (int(time.time() * 1000), job_id)
                    )
                else:
                    print(f"[Sync-Worker] Job failed: {error_msg}")
                    cursor.execute(
                        "UPDATE sync_queue SET status = 'ERROR', error_message = ?, updated_at = ? WHERE id = ?",
                        (error_msg, int(time.time() * 1000), job_id)
                    )
                conn.commit()
            
            conn.close()
        except Exception as loop_err:
            print(f"[Sync-Worker] Queue loop error: {str(loop_err)}")
            
        time.sleep(5)

if __name__ == '__main__':
    main()
