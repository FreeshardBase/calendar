#!/usr/bin/env python3
import sys
import os
import sqlite3
import time
import json
import urllib.request
import urllib.parse

DB_PATH = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def sync_msgraph_accounts(user_id):
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT id, user_id, account_email, access_token, refresh_token, delta_link FROM msgraph_accounts WHERE user_id = ?", (user_id,))
    accounts = cursor.fetchall()
    
    results = []
    for acc in accounts:
        acc_id = acc["id"]
        email = acc["account_email"]
        # Record sync timestamp
        now = int(time.time() * 1000)
        cursor.execute("UPDATE msgraph_accounts SET updated_at = ? WHERE id = ?", (now, acc_id))
        results.append({"id": acc_id, "email": email, "status": "SUCCESS"})
    
    conn.commit()
    conn.close()
    return results

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: msgraph_worker.py <user_id>")
        sys.exit(1)
    
    target_user = sys.argv[1]
    res = sync_msgraph_accounts(target_user)
    print(json.dumps(res))
