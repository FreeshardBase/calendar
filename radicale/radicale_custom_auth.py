from radicale.auth import BaseAuth
import sqlite3
import hashlib
import os

import hmac

class Auth(BaseAuth):
    def _login(self, login, password):
        # 1. Resolve username-to-UUID mapping in SQLite database
        db_path = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")
        user_id = login
        
        if os.path.exists(db_path):
            try:
                conn = sqlite3.connect(db_path)
                conn.execute("PRAGMA foreign_keys = ON")
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT user_id FROM users WHERE username = ? OR user_id = ?",
                    (login, login)
                )
                row = cursor.fetchone()
                if row:
                    user_id = row[0]
                conn.close()
            except Exception:
                pass

        # 2. Allow SYSTEM_SYNC_SECRET bypass for sync worker
        system_secret = os.environ.get("SYSTEM_SYNC_SECRET")
        if system_secret and hmac.compare_digest(password, system_secret):
            return user_id

        # 3. Check App-Specific Password (ASP) in shared SQLite DB
        if not os.path.exists(db_path):
            return ""

        try:
            conn = sqlite3.connect(db_path)
            conn.execute("PRAGMA foreign_keys = ON")
            cursor = conn.cursor()
            cursor.execute(
                "SELECT password_hash FROM app_passwords WHERE user_id = ?",
                (user_id,)
            )
            rows = cursor.fetchall()
            conn.close()
            for r in rows:
                stored_hash = r[0]
                if ":" in stored_hash:
                    salt, expected = stored_hash.split(":", 1)
                    calc = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000).hex()
                    if hmac.compare_digest(calc, expected):
                        return user_id
                else:
                    legacy_calc = hashlib.sha256(password.encode('utf-8')).hexdigest()
                    if hmac.compare_digest(legacy_calc, stored_hash):
                        return user_id
            return ""
        except Exception:
            return ""
