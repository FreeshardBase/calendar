#!/usr/bin/env python3
import sys
import os

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(line_buffering=True)
os.environ["PYTHONUNBUFFERED"] = "1"
import sqlite3
import time
import json
import base64
import urllib.request
import urllib.parse

DB_PATH = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")
LOCAL_CALDAV_URL = os.environ.get("LOCAL_CALDAV_URL", "http://caldav-server:5232")
SYSTEM_SYNC_SECRET = os.environ.get("SYSTEM_SYNC_SECRET", "super-secret-bypass")

def get_db_path():
    return os.environ.get("DATABASE_PATH", DB_PATH)

def get_db(db_path=None):
    target_path = db_path or get_db_path()
    conn = sqlite3.connect(target_path)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn

def refresh_msgraph_token(tenant_id, client_id, refresh_token):
    tenant = tenant_id or "common"
    url = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
    data = urllib.parse.urlencode({
        "client_id": client_id or "freeshard-calendar-app",
        "grant_type": "refresh_token",
        "refresh_token": refresh_token
    }).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    import ssl
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, context=ctx) as res:
        res_data = json.loads(res.read().decode("utf-8"))
        new_token = res_data["access_token"]
        expires_in = res_data.get("expires_in", 3600)
        expires_at = int((time.time() + expires_in) * 1000)
        return new_token, expires_at

def decrypt_token(token):
    if not token or ":" not in token:
        return token
    parts = token.split(":", 1)
    if len(parts[0]) != 32:
        return token
    try:
        import sync_worker
        return sync_worker.decrypt(parts[1], parts[0], sync_worker.KEY_BYTES)
    except Exception:
        return token

def encrypt_token(token):
    if not token:
        return token
    if ":" in token and len(token.split(":", 1)[0]) == 32:
        return token
    try:
        import sync_worker
        return sync_worker.encrypt_token(token, sync_worker.KEY_BYTES)
    except Exception:
        return token

def sync_msgraph_accounts(user_id, conn=None):
    close_conn = False
    if conn is None:
        conn = get_db()
        close_conn = True

    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, tenant_id, client_id, account_email, access_token, refresh_token, expires_at, delta_link, target_calendar_id"
        " FROM msgraph_accounts WHERE user_id = ?",
        (user_id,)
    )
    accounts = cursor.fetchall()
    
    if not accounts:
        if close_conn:
            conn.close()
        return True, ""

    now_ms = int(time.time() * 1000)

    for acc in accounts:
        acc_id = acc["id"]
        access_token = decrypt_token(acc["access_token"])
        refresh_token = decrypt_token(acc["refresh_token"])
        expires_at = acc["expires_at"]
        tenant_id = acc["tenant_id"]
        client_id = acc["client_id"]
        delta_link = acc["delta_link"]
        target_cal = acc["target_calendar_id"] or "persoenlich"

        if refresh_token and (not access_token or not expires_at or expires_at < now_ms + 60000):
            if not refresh_token.startswith("mock-"):
                try:
                    access_token, expires_at = refresh_msgraph_token(tenant_id, client_id, refresh_token)
                    enc_access = encrypt_token(access_token)
                    cursor.execute(
                        "UPDATE msgraph_accounts SET access_token = ?, expires_at = ?, updated_at = ? WHERE id = ?",
                        (enc_access, expires_at, now_ms, acc_id)
                    )
                    conn.commit()
                except Exception as te:
                    print(f"[MSGraph-Worker] Token refresh warning for account {acc_id}: {te}")

        endpoint = delta_link or "https://graph.microsoft.com/v1.0/me/events"
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json"
        }

        events = []
        new_delta_link = endpoint
        try:
            req = urllib.request.Request(endpoint, headers=headers, method="GET")
            import ssl
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            with urllib.request.urlopen(req, context=ctx) as res:
                if res.status == 200:
                    resp_data = json.loads(res.read().decode("utf-8"))
                    events = resp_data.get("value", [])
                    new_delta_link = resp_data.get("@odata.deltaLink") or resp_data.get("@odata.nextLink") or endpoint
        except Exception as fe:
            print(f"[MSGraph-Worker] Fetch error (account {acc_id}): {fe}")

        for item in events:
            graph_id = item.get("id")
            if not graph_id:
                continue

            if item.get("@removed"):
                cursor.execute("SELECT local_uid FROM msgraph_event_mappings WHERE graph_id = ?", (graph_id,))
                row = cursor.fetchone()
                if row:
                    local_uid = row["local_uid"]
                    del_url = f"{LOCAL_CALDAV_URL.rstrip('/')}/{user_id}/{target_cal}/{local_uid}.ics"
                    auth_str = base64.b64encode(f"{user_id}:{SYSTEM_SYNC_SECRET}".encode("utf-8")).decode("ascii")
                    del_req = urllib.request.Request(del_url, headers={"Authorization": f"Basic {auth_str}"}, method="DELETE")
                    try:
                        import ssl
                        ctx = ssl.create_default_context()
                        ctx.check_hostname = False
                        ctx.verify_mode = ssl.CERT_NONE
                        with urllib.request.urlopen(del_req, context=ctx):
                            pass
                    except Exception:
                        pass
                    cursor.execute("DELETE FROM msgraph_event_mappings WHERE graph_id = ?", (graph_id,))
            else:
                local_uid = f"msgraph-event-{graph_id}"
                subject = item.get("subject", "(Ohne Titel)")
                body_content = ""
                if isinstance(item.get("body"), dict):
                    body_content = item["body"].get("content", "")

                start_str = "20260101T090000Z"
                end_str = "20260101T100000Z"
                if isinstance(item.get("start"), dict) and item["start"].get("dateTime"):
                    raw = item["start"]["dateTime"]
                    start_str = raw.replace("-", "").replace(":", "").split(".")[0]
                    if not start_str.endswith("Z"):
                        start_str += "Z"
                if isinstance(item.get("end"), dict) and item["end"].get("dateTime"):
                    raw = item["end"]["dateTime"]
                    end_str = raw.replace("-", "").replace(":", "").split(".")[0]
                    if not end_str.endswith("Z"):
                        end_str += "Z"

                etag = item.get("@odata.etag", "")

                ics_content = (
                    "BEGIN:VCALENDAR\r\n"
                    "VERSION:2.0\r\n"
                    "PRODID:-//FreeShard WebCalendar//MSGraph Sync//EN\r\n"
                    "BEGIN:VEVENT\r\n"
                    f"UID:{local_uid}\r\n"
                    f"SUMMARY:{subject}\r\n"
                    f"DESCRIPTION:{body_content}\r\n"
                    f"DTSTART:{start_str}\r\n"
                    f"DTEND:{end_str}\r\n"
                    "END:VEVENT\r\n"
                    "END:VCALENDAR\r\n"
                )

                local_put_url = f"{LOCAL_CALDAV_URL.rstrip('/')}/{user_id}/{target_cal}/{local_uid}.ics"
                auth_str = base64.b64encode(f"{user_id}:{SYSTEM_SYNC_SECRET}".encode("utf-8")).decode("ascii")
                put_req = urllib.request.Request(
                    local_put_url,
                    data=ics_content.encode("utf-8"),
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
                    with urllib.request.urlopen(put_req, context=ctx):
                        pass
                except Exception as put_err:
                    print(f"[MSGraph-Worker] Error putting event to local CalDAV: {put_err}")

                cursor.execute(
                    "INSERT OR REPLACE INTO msgraph_event_mappings (local_uid, graph_id, account_id, last_synced_at, e_tag)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (local_uid, graph_id, acc_id, now_ms, etag)
                )

        cursor.execute(
            "UPDATE msgraph_accounts SET delta_link = ?, updated_at = ? WHERE id = ?",
            (new_delta_link, now_ms, acc_id)
        )

    conn.commit()
    if close_conn:
        conn.close()
    return True, ""

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: msgraph_worker.py <user_id>")
        sys.exit(1)

    target_user = sys.argv[1]
    res, err = sync_msgraph_accounts(target_user)
    print(json.dumps({"status": "SUCCESS" if res else "ERROR", "error": err}))
