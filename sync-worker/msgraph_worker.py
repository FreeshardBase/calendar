#!/usr/bin/env python3
"""Microsoft 365 import: mirrors the user's Outlook calendar into Radicale via Graph delta queries.

This is the only Microsoft Graph sync path (#97). The web app (server/routes/msgraph.js) runs the
OAuth authorization and enqueues sync jobs; everything that talks to Graph for syncing lives here.
"""
import sys
import os

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(line_buffering=True)
os.environ["PYTHONUNBUFFERED"] = "1"
import re
import sqlite3
import ssl
import time
import json
import base64
import datetime
import urllib.request
import urllib.parse
import urllib.error
from tls_context import ssl_context_for

DB_PATH = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")
LOCAL_CALDAV_URL = os.environ.get("LOCAL_CALDAV_URL", "http://caldav-server:5232")
SYSTEM_SYNC_SECRET = os.environ.get("SYSTEM_SYNC_SECRET")

# Microsoft identity platform, tenant "common": work, school and personal accounts (#97).
TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
# Must match the scopes the web app requests in server/utils/msgraph.js.
SCOPES = "offline_access User.Read Calendars.Read"
# Change tracking needs a delta endpoint: the plain /me/events collection carries no deltaLink and
# never reports deletions (#97). calendarView/delta fixes its time window when a delta round starts.
DELTA_URL = "https://graph.microsoft.com/v1.0/me/calendarView/delta"
DELTA_WINDOW_PAST_DAYS = 365
DELTA_WINDOW_FUTURE_DAYS = 730
# The window is part of the deltaLink, so a round older than this starts over with a current window.
DELTA_ROUND_MAX_AGE_MS = 30 * 86400 * 1000
# Times come back in UTC and bodies as plain text, so the converter never guesses a zone (#97).
GRAPH_PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"'
# Per-account lease in the database: two syncs of one account never overlap, whichever process runs them (#97).
SYNC_LEASE_MS = 15 * 60 * 1000
# Every request to Microsoft or Radicale is bounded, so a stalled peer cannot hold the queue.
HTTP_TIMEOUT_SECONDS = 30


class ReconnectRequired(Exception):
    """Microsoft refused the refresh token; the user has to connect the account again."""


def get_db_path():
    return os.environ.get("DATABASE_PATH", DB_PATH)

def get_db(db_path=None):
    target_path = db_path or get_db_path()
    conn = sqlite3.connect(target_path)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn

def msgraph_client_credentials(env=None):
    env = os.environ if env is None else env
    client_id = (env.get("MSGRAPH_CLIENT_ID") or "").strip()
    if not client_id:
        raise RuntimeError("MSGRAPH_CLIENT_ID is not configured; Microsoft 365 accounts cannot be synced")
    return client_id, (env.get("MSGRAPH_CLIENT_SECRET") or "").strip()

def refresh_msgraph_token(refresh_token, env=None):
    """Returns (access_token, refresh_token, expires_at_ms); raises ReconnectRequired on invalid_grant."""
    client_id, client_secret = msgraph_client_credentials(env)
    params = {
        "client_id": client_id,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "scope": SCOPES,
    }
    if client_secret:
        params["client_secret"] = client_secret
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(TOKEN_URL, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, context=ssl.create_default_context(), timeout=HTTP_TIMEOUT_SECONDS) as res:
            res_data = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as he:
        body = he.read().decode("utf-8", "replace") if he.fp else ""
        try:
            error_code = json.loads(body).get("error")
        except ValueError:
            error_code = None
        if error_code == "invalid_grant":
            raise ReconnectRequired(body) from he
        raise
    expires_at = int((time.time() + res_data.get("expires_in", 3600)) * 1000)
    # Microsoft may rotate the refresh token; the old one is kept only when no new one is issued.
    return res_data["access_token"], res_data.get("refresh_token") or refresh_token, expires_at

def initial_delta_url(now_s=None):
    now_s = time.time() if now_s is None else now_s
    start = datetime.datetime.fromtimestamp(now_s - DELTA_WINDOW_PAST_DAYS * 86400, datetime.timezone.utc)
    end = datetime.datetime.fromtimestamp(now_s + DELTA_WINDOW_FUTURE_DAYS * 86400, datetime.timezone.utc)
    return DELTA_URL + "?" + urllib.parse.urlencode({
        "startDateTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "endDateTime": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
    })

def graph_time_to_ical(value, all_day):
    """Graph dateTimeTimeZone -> (DTSTART/DTEND parameter suffix, value). Only UTC is accepted (GRAPH_PREFER)."""
    zone = value.get("timeZone")
    if zone != "UTC":
        raise ValueError(f"Microsoft Graph returned time zone {zone!r}; the sync requests UTC (Prefer: outlook.timezone)")
    stamp = datetime.datetime.strptime(value["dateTime"][:19], "%Y-%m-%dT%H:%M:%S")
    if all_day:
        return ";VALUE=DATE", stamp.strftime("%Y%m%d")
    return "", stamp.strftime("%Y%m%dT%H%M%SZ")

def ics_text(value):
    """RFC 5545 TEXT escaping, so a subject or body cannot inject properties."""
    return (value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
            .replace("\r\n", "\\n").replace("\n", "\\n").replace("\r", "\\n"))

# #536: target_calendar_id and the Graph event id become Radicale path segments. Graph ids are
# base64 (+, /, = in older ids, - and _ in URL-safe ones); "/" is refused, because Radicale decodes
# %2F back into a path separator.
SAFE_CALENDAR_SEGMENT_RE = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}")
SAFE_EVENT_SEGMENT_RE = re.compile(r"[A-Za-z0-9_+=-][A-Za-z0-9_.+=-]{0,1023}")


def path_segment(value, pattern, what):
    """value percent-encoded as one URL path segment; ValueError unless it fully matches pattern."""
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError(f"unsafe {what} {value!r}")
    return urllib.parse.quote(value, safe="")


def acquire_sync_lease(conn, acc_id, now_ms):
    lease_until = now_ms + SYNC_LEASE_MS
    cursor = conn.execute(
        "UPDATE msgraph_accounts SET sync_lock_until = ? WHERE id = ? AND (sync_lock_until IS NULL OR sync_lock_until < ?)",
        (lease_until, acc_id, now_ms),
    )
    conn.commit()
    return lease_until if cursor.rowcount == 1 else None

def release_sync_lease(conn, acc_id, lease_until):
    conn.execute("UPDATE msgraph_accounts SET sync_lock_until = NULL WHERE id = ? AND sync_lock_until = ?",
                 (acc_id, lease_until))
    conn.commit()

def decrypt_token(token):
    # #343/#72: a token that does not decrypt is an error, never sent on as a bearer token.
    import sync_worker
    return sync_worker.decrypt_token(token, sync_worker.KEY_BYTES)

def encrypt_token(token):
    # #343: a failed encryption is an error, never a fallback to storing the plaintext token.
    import sync_worker
    return sync_worker.encrypt_token(token, sync_worker.KEY_BYTES)

def sync_msgraph_accounts(user_id, conn=None):
    """Returns (ok, error_message); the message becomes the sync job's error_message."""
    if conn is not None:
        return _sync_msgraph_accounts(user_id, conn)
    conn = get_db()
    try:
        return _sync_msgraph_accounts(user_id, conn)
    finally:
        conn.close()


def _sync_msgraph_accounts(user_id, conn):
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, account_email FROM msgraph_accounts WHERE user_id = ? ORDER BY rowid",
        (user_id,)
    )
    accounts = cursor.fetchall()

    # One failing account (e.g. waiting to be reconnected) does not keep the others from syncing.
    errors = []
    for acc in accounts:
        lease_until = acquire_sync_lease(conn, acc["id"], int(time.time() * 1000))
        if lease_until is None:
            print(f"[MSGraph] Account {acc['id']} is already being synced; skipping it in this run")
            continue
        try:
            ok, error = _sync_account(user_id, conn, acc["id"])
        # An event Graph sends in an unexpected shape, or a failed local write, fails this account
        # loudly (job error, delta link not advanced) without stopping the others.
        except (ValueError, KeyError, OSError) as account_err:
            ok, error = False, f"Microsoft 365 sync of {acc['account_email']} failed: {account_err}"
        finally:
            release_sync_lease(conn, acc["id"], lease_until)
        if not ok:
            errors.append(error)

    if errors:
        return False, "; ".join(errors)
    return True, ""


def _sync_account(user_id, conn, acc_id):
    cursor = conn.cursor()
    acc = cursor.execute(
        "SELECT account_email, access_token, refresh_token, expires_at, delta_link, delta_started_at,"
        " target_calendar_id, reconnect_required FROM msgraph_accounts WHERE id = ?",
        (acc_id,)
    ).fetchone()
    reconnect_message = (f"Microsoft 365 authorization for {acc['account_email']} has expired; "
                         "please reconnect the account")
    if acc["reconnect_required"]:
        return False, reconnect_message

    now_ms = int(time.time() * 1000)
    access_token = decrypt_token(acc["access_token"])
    refresh_token = decrypt_token(acc["refresh_token"])
    expires_at = acc["expires_at"]
    delta_link = acc["delta_link"]
    target_cal = acc["target_calendar_id"] or "persoenlich"

    if not access_token or not expires_at or expires_at < now_ms + 60000:
        try:
            if not refresh_token:
                raise ReconnectRequired("no refresh token stored")
            access_token, refresh_token, expires_at = refresh_msgraph_token(refresh_token)
        except ReconnectRequired:
            # Only the refused token is flagged: a reconnect in the meantime has stored a new one.
            cursor.execute("UPDATE msgraph_accounts SET reconnect_required = 1, updated_at = ? WHERE id = ? AND refresh_token IS ?",
                           (now_ms, acc_id, acc["refresh_token"]))
            conn.commit()
            return False, reconnect_message
        except (urllib.error.URLError, ValueError, KeyError, RuntimeError) as te:
            return False, f"Microsoft token refresh failed for account {acc_id}: {te}"
        cursor.execute(
            "UPDATE msgraph_accounts SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE id = ?",
            (encrypt_token(access_token), encrypt_token(refresh_token), expires_at, now_ms, acc_id)
        )
        conn.commit()

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "Prefer": GRAPH_PREFER,
    }

    # A round pages through nextLink until a page carries the deltaLink; only that is persisted.
    round_started_at = acc["delta_started_at"]
    if delta_link and round_started_at and now_ms - round_started_at > DELTA_ROUND_MAX_AGE_MS:
        delta_link = None
    if not delta_link:
        round_started_at = now_ms
    url = delta_link or initial_delta_url(now_ms / 1000)
    new_delta_link = None
    while new_delta_link is None:
        try:
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, context=ssl_context_for(url, LOCAL_CALDAV_URL), timeout=HTTP_TIMEOUT_SECONDS) as res:
                resp_data = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as fe:
            if fe.code == 410 and delta_link:
                # syncStateNotFound: the delta link expired; the next sync starts a full delta round.
                cursor.execute("UPDATE msgraph_accounts SET delta_link = NULL, updated_at = ? WHERE id = ?", (now_ms, acc_id))
                conn.commit()
            return False, f"Microsoft Graph fetch failed for account {acc_id}: {fe}"
        except (urllib.error.URLError, ValueError) as fe:
            # The delta link is not advanced, so the next sync fetches the same changes again.
            return False, f"Microsoft Graph fetch failed for account {acc_id}: {fe}"

        written = 0
        for item in resp_data.get("value", []):
            if _apply_graph_item(user_id, cursor, acc_id, target_cal, item, now_ms):
                written += 1
        # Mappings (and the job's progress, #174) are committed per page, so the database is not
        # write-locked for a whole round.
        import sync_worker
        sync_worker.record_sync_progress(cursor, written)
        conn.commit()

        if resp_data.get("@odata.nextLink"):
            url = resp_data["@odata.nextLink"]
        elif resp_data.get("@odata.deltaLink"):
            new_delta_link = resp_data["@odata.deltaLink"]
        else:
            return False, f"Microsoft Graph delta page for account {acc_id} carried neither nextLink nor deltaLink"

    cursor.execute(
        "UPDATE msgraph_accounts SET delta_link = ?, delta_started_at = ?, updated_at = ? WHERE id = ?",
        (new_delta_link, round_started_at, now_ms, acc_id)
    )
    conn.commit()
    return True, ""


def _apply_graph_item(user_id, cursor, acc_id, target_cal, item, now_ms):
    """Writes or deletes the local copy of one Graph event; True if a local event was changed."""
    graph_id = item.get("id")
    if not graph_id:
        return False
    calendar_segment = path_segment(target_cal, SAFE_CALENDAR_SEGMENT_RE, "target calendar id")
    path_segment(graph_id, SAFE_EVENT_SEGMENT_RE, "Graph event id")
    auth_str = base64.b64encode(f"{user_id}:{SYSTEM_SYNC_SECRET}".encode("utf-8")).decode("ascii")

    if item.get("@removed"):
        cursor.execute("SELECT local_uid FROM msgraph_event_mappings WHERE graph_id = ?", (graph_id,))
        row = cursor.fetchone()
        if row:
            resource = path_segment(row["local_uid"] + ".ics", SAFE_EVENT_SEGMENT_RE, "local event uid")
            del_url = f"{LOCAL_CALDAV_URL.rstrip('/')}/{user_id}/{calendar_segment}/{resource}"
            del_req = urllib.request.Request(del_url, headers={"Authorization": f"Basic {auth_str}"}, method="DELETE")
            try:
                with urllib.request.urlopen(del_req, context=ssl_context_for(del_url, LOCAL_CALDAV_URL), timeout=HTTP_TIMEOUT_SECONDS):
                    pass
            except urllib.error.HTTPError as del_err:
                # Already gone locally; any other failure propagates and fails the sync job.
                if del_err.code not in (404, 410):
                    raise
            cursor.execute("DELETE FROM msgraph_event_mappings WHERE graph_id = ?", (graph_id,))
            return True
        return False

    local_uid = f"msgraph-event-{graph_id}"
    subject = item.get("subject") or "(Ohne Titel)"
    body_content = ""
    if isinstance(item.get("body"), dict):
        body_content = item["body"].get("content") or ""
    location = ""
    if isinstance(item.get("location"), dict):
        location = item["location"].get("displayName") or ""
    all_day = bool(item.get("isAllDay"))
    start_param, start_value = graph_time_to_ical(item["start"], all_day)
    end_param, end_value = graph_time_to_ical(item["end"], all_day)
    etag = item.get("@odata.etag", "")

    ics_content = (
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "PRODID:-//FreeShard WebCalendar//MSGraph Sync//EN\r\n"
        "BEGIN:VEVENT\r\n"
        f"UID:{ics_text(local_uid)}\r\n"
        f"SUMMARY:{ics_text(subject)}\r\n"
        f"DESCRIPTION:{ics_text(body_content)}\r\n"
        + (f"LOCATION:{ics_text(location)}\r\n" if location else "") +
        f"DTSTART{start_param}:{start_value}\r\n"
        f"DTEND{end_param}:{end_value}\r\n"
        "END:VEVENT\r\n"
        "END:VCALENDAR\r\n"
    )

    resource = path_segment(local_uid + ".ics", SAFE_EVENT_SEGMENT_RE, "local event uid")
    local_put_url = f"{LOCAL_CALDAV_URL.rstrip('/')}/{user_id}/{calendar_segment}/{resource}"
    put_req = urllib.request.Request(
        local_put_url,
        data=ics_content.encode("utf-8"),
        headers={
            "Content-Type": "text/calendar; charset=utf-8",
            "Authorization": f"Basic {auth_str}"
        },
        method="PUT"
    )
    # A failed PUT propagates (the sync job fails) before the mapping is recorded.
    with urllib.request.urlopen(put_req, context=ssl_context_for(local_put_url, LOCAL_CALDAV_URL), timeout=HTTP_TIMEOUT_SECONDS):
        pass

    cursor.execute(
        "INSERT OR REPLACE INTO msgraph_event_mappings (local_uid, graph_id, account_id, last_synced_at, e_tag)"
        " VALUES (?, ?, ?, ?, ?)",
        (local_uid, graph_id, acc_id, now_ms, etag)
    )
    return True

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: msgraph_worker.py <user_id>")
        sys.exit(1)

    target_user = sys.argv[1]
    res, err = sync_msgraph_accounts(target_user)
    print(json.dumps({"status": "SUCCESS" if res else "ERROR", "error": err}))
