from radicale.auth import BaseAuth
import sqlite3
import hashlib
import os

class Auth(BaseAuth):
    def _login(self, login, password):
        # 1. Allow SYSTEM_SYNC_SECRET bypass for sync worker
        system_secret = os.environ.get("SYSTEM_SYNC_SECRET", "super-secret-bypass")
        if password == system_secret:
            return login

        # 2. Check App-Specific Password (ASP) in shared SQLite DB
        db_path = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")
        if not os.path.exists(db_path):
            return ""

        try:
            password_hash = hashlib.sha256(password.encode('utf-8')).hexdigest()
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            cursor.execute(
                "SELECT 1 FROM app_passwords WHERE user_id = ? AND password_hash = ?",
                (login, password_hash)
            )
            row = cursor.fetchone()
            conn.close()
            if row is not None:
                return login
            return ""
        except Exception:
            return ""
