#!/usr/bin/env python3
import sys
import sqlite3
import hashlib
import os

def main():
    try:
        # Read username and password from stdin
        username = sys.stdin.readline().strip()
        password = sys.stdin.readline().strip()
        
        if not username or not password:
            sys.exit(1)
            
        # Database path from env or default shared docker volume path
        db_path = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")
        if not os.path.exists(db_path):
            sys.stderr.write(f"Database not found at {db_path}\n")
            sys.exit(1)
            
        # Compute SHA-256 hash matching the web app's ASP implementation
        password_hash = hashlib.sha256(password.encode('utf-8')).hexdigest()
        
        # Connect and check credentials
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT 1 FROM app_passwords WHERE user_id = ? AND password_hash = ?",
            (username, password_hash)
        )
        row = cursor.fetchone()
        conn.close()
        
        if row:
            sys.exit(0)
        else:
            sys.exit(1)
            
    except Exception as e:
        sys.stderr.write(f"Auth helper exception: {str(e)}\n")
        sys.exit(1)

if __name__ == '__main__':
    main()
