#!/usr/bin/env python3
"""Microsoft 365 sync: every Outlook calendar of a linked account has its own mirror in Radicale (#613).

This is the only Microsoft Graph sync path (#97). The web app (server/routes/msgraph.js) runs the
OAuth authorization and enqueues sync jobs; everything that talks to Graph for syncing lives here.
Each Microsoft calendar is paired with an opaque, VEVENT-only collection (`msgraph-<hex>`, persisted
in `msgraph_calendar_collections`, like the Google mirrors of #193). A sync first writes what changed
in a mirror since the last sync to Graph (create, update, delete), then reads the calendar's changes
with a delta query. An event Microsoft deleted goes to the shard trash first; restoring it from there
queues it in `msgraph_restores`, and the next sync creates it at Graph again (#597).
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
import uuid
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as xml_escape
from zoneinfo import ZoneInfo
from tls_context import ssl_context_for
import provider_trash

DB_PATH = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")
LOCAL_CALDAV_URL = os.environ.get("LOCAL_CALDAV_URL", "http://caldav-server:5232")
SYSTEM_SYNC_SECRET = os.environ.get("SYSTEM_SYNC_SECRET")

# Microsoft identity platform, tenant "common": work, school and personal accounts (#97).
TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
# Must match the scopes the web app requests in server/utils/msgraph.js. Write access is for the
# two-way sync (#613).
SCOPES = "offline_access User.Read Calendars.ReadWrite"
# The account's calendars; each one's events are created at <calendar>/events, and its changes are
# tracked at <calendar>/calendarView/delta (the plain events collection carries no deltaLink and never
# reports deletions, #97). calendarView/delta fixes its time window when a delta round starts.
CALENDARS_URL = "https://graph.microsoft.com/v1.0/me/calendars"
# An event is updated and deleted by its id, whichever calendar holds it.
EVENTS_URL = "https://graph.microsoft.com/v1.0/me/events"
# A provider colour is taken as #RRGGBB only; Graph reports "" for a calendar whose colour was never set.
HEX_COLOR_RE = re.compile(r"#[0-9A-Fa-f]{6}")
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

def calendar_url(graph_calendar_id):
    return f"{CALENDARS_URL}/{urllib.parse.quote(graph_calendar_id, safe='')}"


def initial_delta_url(graph_calendar_id, now_s=None):
    now_s = time.time() if now_s is None else now_s
    start = datetime.datetime.fromtimestamp(now_s - DELTA_WINDOW_PAST_DAYS * 86400, datetime.timezone.utc)
    end = datetime.datetime.fromtimestamp(now_s + DELTA_WINDOW_FUTURE_DAYS * 86400, datetime.timezone.utc)
    return calendar_url(graph_calendar_id) + "/calendarView/delta?" + urllib.parse.urlencode({
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

# #536: the mirror collection and the Graph event id become Radicale path segments. Graph ids are
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
        except (ValueError, KeyError, OSError, RuntimeError, ET.ParseError) as account_err:
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
        "SELECT account_email, access_token, refresh_token, expires_at, reconnect_required"
        " FROM msgraph_accounts WHERE id = ?",
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

    try:
        calendars = _graph_calendars(headers)
    except (urllib.error.URLError, ValueError) as ce:
        return False, f"Microsoft Graph calendar list failed for account {acc_id}: {ce}"
    mirrors = [m for m in (_mirror_for_graph_calendar(conn, user_id, acc_id, cal) for cal in calendars) if m is not None]

    # Restores first: the delta round then reports each re-created event, already in place.
    restore_err = _push_restores(user_id, conn, acc_id, headers, now_ms)
    if restore_err:
        return False, restore_err

    not_synced = []
    for mirror in mirrors:
        # Local changes go out before the delta round, which then reports them back as Graph has them.
        push_err = _push_local_changes(user_id, conn, acc_id, mirror, headers, now_ms, not_synced)
        if push_err:
            return False, push_err
        pull_err = _pull_calendar(user_id, conn, acc_id, mirror, headers, now_ms)
        if pull_err:
            return False, pull_err
    if not_synced:
        return False, (f"Microsoft 365 ({acc['account_email']}): not synced to Microsoft: "
                       + "; ".join(not_synced))
    return True, ""


def _graph_json(url, headers, method="GET", body=None):
    """One request to Graph; the parsed JSON answer, or None for an empty one (204)."""
    req_headers = dict(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    with urllib.request.urlopen(req, context=ssl_context_for(url, LOCAL_CALDAV_URL), timeout=HTTP_TIMEOUT_SECONDS) as res:
        raw = res.read().decode("utf-8")
    return json.loads(raw) if raw.strip() else None


def _graph_calendars(headers):
    """Every calendar of the account: [{id, name, hexColor, canEdit}]."""
    calendars = []
    url = CALENDARS_URL + "?" + urllib.parse.urlencode({"$select": "id,name,hexColor,canEdit"})
    while url:
        page = _graph_json(url, headers)
        calendars.extend(page["value"])
        url = page.get("@odata.nextLink")
    return calendars


def _graph_color(graph_calendar):
    color = graph_calendar.get("hexColor") or ""
    return color if HEX_COLOR_RE.fullmatch(color) else None


def _mirror_for_graph_calendar(conn, user_id, acc_id, graph_calendar):
    """The local mirror collection of one Microsoft calendar, created on first sight (#613).

    The name is opaque (`msgraph-<uuid hex>`) and persisted per (account, Microsoft calendar id), so
    it never collides with another calendar, and the mirror takes VEVENT only (#572): Graph calendars
    hold events, Microsoft To Do is a separate API. A name or colour changed at Microsoft is applied
    to the mirror. None for a calendar whose mirror the user disconnected (#614).
    """
    import sync_worker
    graph_calendar_id = graph_calendar["id"]
    name = graph_calendar.get("name") or "Microsoft 365"
    color = _graph_color(graph_calendar)
    row = conn.execute(
        "SELECT * FROM msgraph_calendar_collections WHERE account_id = ? AND graph_calendar_id = ?",
        (acc_id, graph_calendar_id),
    ).fetchone()
    if row is not None and row["local_collection"].startswith(sync_worker.DETACHED_PREFIX):
        return None
    if row is None:
        collection = f"msgraph-{uuid.uuid4().hex}"
        sync_worker.create_local_collection(user_id, collection, name, components=("VEVENT",), color=color)
        conn.execute(
            "INSERT INTO msgraph_calendar_collections (account_id, user_id, graph_calendar_id, local_collection,"
            " graph_name, graph_color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (acc_id, user_id, graph_calendar_id, collection, name, color, int(time.time() * 1000)),
        )
    elif row["graph_name"] != name or row["graph_color"] != color:
        _set_collection_properties(user_id, row["local_collection"], name, color)
        conn.execute(
            "UPDATE msgraph_calendar_collections SET graph_name = ?, graph_color = ?"
            " WHERE account_id = ? AND graph_calendar_id = ?",
            (name, color, acc_id, graph_calendar_id),
        )
    conn.commit()
    mirror = dict(conn.execute(
        "SELECT * FROM msgraph_calendar_collections WHERE account_id = ? AND graph_calendar_id = ?",
        (acc_id, graph_calendar_id),
    ).fetchone())
    mirror["can_edit"] = graph_calendar.get("canEdit") is not False
    return mirror


def _set_collection_properties(user_id, collection, name, color):
    """PROPPATCH the mirror's display name and colour to what Microsoft reports."""
    color_prop = (f"<ical:calendar-color>{xml_escape(color)}</ical:calendar-color>" if color else "")
    remove = "" if color else "<d:remove><d:prop><ical:calendar-color/></d:prop></d:remove>"
    body = f"""<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:ical="http://apple.com/ns/ical/">
  <d:set><d:prop><d:displayname>{xml_escape(name)}</d:displayname>{color_prop}</d:prop></d:set>{remove}
</d:propertyupdate>"""
    root = ET.fromstring(_local_request(user_id, f"/{user_id}/{collection}/", "PROPPATCH", body))
    statuses = [(el.text or "").strip() for el in root.iter("{DAV:}status")]
    if not statuses or any(" 200 " not in f"{st} " for st in statuses):
        raise ValueError(f"PROPPATCH of {collection} was not applied: {statuses}")


def _local_url(href):
    return f"{LOCAL_CALDAV_URL.rstrip('/')}{urllib.parse.quote(href, safe='/')}"


def _local_request(user_id, href, method, body, depth=None):
    """One WebDAV request (PROPPATCH, REPORT) to the user's local Radicale; the multistatus body."""
    url = _local_url(href)
    headers = {"Authorization": _local_auth(user_id), "Accept-Encoding": "identity",
               "Content-Type": "application/xml; charset=utf-8"}
    if depth is not None:
        headers["Depth"] = depth
    req = urllib.request.Request(url, data=body.encode("utf-8"), headers=headers, method=method)
    with urllib.request.urlopen(req, context=ssl_context_for(url, LOCAL_CALDAV_URL), timeout=HTTP_TIMEOUT_SECONDS) as res:
        if res.status != 207:
            raise ValueError(f"{method} {url} returned {res.status}")
        return res.read()


def _mirror_contents(user_id, collection):
    """{href path (decoded): (etag, ICS)} of every item in a local mirror."""
    body = """<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"/></c:filter>
</c:calendar-query>"""
    root = ET.fromstring(_local_request(user_id, f"/{user_id}/{collection}/", "REPORT", body, depth="1"))
    items = {}
    for response in root.iter("{DAV:}response"):
        href = response.find("{DAV:}href")
        etag = response.find(".//{DAV:}getetag")
        data = response.find(".//{urn:ietf:params:xml:ns:caldav}calendar-data")
        if href is None or data is None or not (data.text or "").strip():
            continue
        if etag is None or not (etag.text or "").strip():
            raise ValueError(f"the local Radicale reported no ETag for {href.text}")
        path = urllib.parse.unquote(urllib.parse.urlsplit(href.text.strip()).path)
        items[path] = (etag.text.strip(), re.sub(r"\r?\n", "\r\n", data.text))
    return items


def _vevent_property(ics, name):
    """The value of one property of the first VEVENT (nested components excluded), or None."""
    text = re.sub(r"\r?\n[ \t]", "", ics)
    vevent = re.search(r"^BEGIN:VEVENT\s*$(.*?)^END:VEVENT\s*$", text, re.M | re.S)
    if vevent is None:
        return None
    own = re.sub(r"^BEGIN:(\w+)\s*$.*?^END:\1\s*$", "", vevent.group(1), flags=re.M | re.S)
    match = re.search(rf"^{name}(?:;[^:\r\n]*)?:(.*?)\s*$", own, re.M)
    return match.group(1) if match else None


def _push_local_changes(user_id, conn, acc_id, mirror, headers, now_ms, not_synced):
    """Writes to Graph what changed in one mirror since the last sync (#613); "" or an error message.

    An item without a mapping was created in the shard and is created in the Microsoft calendar; a
    mapped item whose local ETag differs from the one the sync recorded was edited and is updated
    there; a mapping whose item is gone was deleted in the shard and is deleted there. What cannot be
    written is named in `not_synced` and stays as it is locally.
    """
    collection = mirror["local_collection"]
    prefix = f"/{user_id}/{collection}/"
    local = _mirror_contents(user_id, collection)
    mapped = {row["href"]: row for row in conn.execute(
        "SELECT local_uid, graph_id, href, local_etag FROM msgraph_event_mappings"
        " WHERE account_id = ? AND substr(href, 1, ?) = ?",
        (acc_id, len(prefix), prefix))}
    events_url = calendar_url(mirror["graph_calendar_id"]) + "/events"
    try:
        for href, (etag, ics) in local.items():
            mapping = mapped.get(href)
            if mapping is not None and mapping["local_etag"] == etag:
                continue
            title = _ical_unescape(_vevent_property(ics, "SUMMARY") or "") or href.rsplit("/", 1)[-1]
            if not SAFE_EVENT_SEGMENT_RE.fullmatch(href[len(prefix):]):
                # The delta round only follows mappings to safe resource names (#536); a mapping to any
                # other name would stop every later sync of the account.
                not_synced.append(f"{title!r} (its resource name {href[len(prefix):]!r} cannot be synced;"
                                  " recreate the event in the calendar app)")
                continue
            if not mirror["can_edit"]:
                not_synced.append(f"{title!r} (the Microsoft calendar {mirror['graph_name']!r} is read-only)")
                continue
            if _vevent_property(ics, "RRULE") or _vevent_property(ics, "RDATE"):
                not_synced.append(f"{title!r} (a series created or changed in the shard is not written to Microsoft 365)")
                continue
            try:
                event = ics_to_graph_event(ics)
            except ValueError as convert_err:
                not_synced.append(f"{title!r} ({convert_err})")
                continue
            if mapping is None:
                created = _graph_json(events_url, headers, "POST", event)
                uid = _vevent_property(ics, "UID") or created["id"]
                conn.execute(
                    "INSERT OR REPLACE INTO msgraph_event_mappings"
                    " (local_uid, graph_id, account_id, last_synced_at, e_tag, href, local_etag) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (uid, created["id"], acc_id, now_ms, created.get("@odata.etag", ""), href, etag))
            else:
                try:
                    updated = _graph_json(f"{EVENTS_URL}/{urllib.parse.quote(mapping['graph_id'], safe='')}",
                                          headers, "PATCH", event)
                except urllib.error.HTTPError as patch_err:
                    # Deleted at Microsoft meanwhile: the delta round reports the removal (#597 trash).
                    if patch_err.code not in (404, 410):
                        raise
                    continue
                conn.execute(
                    "UPDATE msgraph_event_mappings SET local_etag = ?, e_tag = ?, last_synced_at = ? WHERE href = ? AND account_id = ?",
                    (etag, (updated or {}).get("@odata.etag", ""), now_ms, href, acc_id))
            conn.commit()
        for href, mapping in mapped.items():
            if href in local:
                continue
            if mirror["can_edit"]:
                try:
                    _graph_json(f"{EVENTS_URL}/{urllib.parse.quote(mapping['graph_id'], safe='')}", headers, "DELETE")
                except urllib.error.HTTPError as del_err:
                    # Already deleted at Microsoft.
                    if del_err.code not in (404, 410):
                        raise
            conn.execute("DELETE FROM msgraph_event_mappings WHERE href = ? AND account_id = ?", (href, acc_id))
            conn.commit()
    except urllib.error.URLError as push_err:
        return f"Microsoft 365: writing changes of {mirror['graph_name']!r} failed for account {acc_id}: {push_err}"
    return ""


def _pull_calendar(user_id, conn, acc_id, mirror, headers, now_ms):
    """One delta round of a Microsoft calendar into its mirror; "" or an error message."""
    cursor = conn.cursor()
    graph_calendar_id = mirror["graph_calendar_id"]
    delta_link = mirror["delta_link"]
    # A round pages through nextLink until a page carries the deltaLink; only that is persisted.
    round_started_at = mirror["delta_started_at"]
    if delta_link and round_started_at and now_ms - round_started_at > DELTA_ROUND_MAX_AGE_MS:
        delta_link = None
    if not delta_link:
        round_started_at = now_ms

    url = delta_link or initial_delta_url(graph_calendar_id, now_ms / 1000)
    new_delta_link = None
    while new_delta_link is None:
        try:
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, context=ssl_context_for(url, LOCAL_CALDAV_URL), timeout=HTTP_TIMEOUT_SECONDS) as res:
                resp_data = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as fe:
            if fe.code == 410 and delta_link:
                # syncStateNotFound: the delta link expired; the next sync starts a full delta round.
                cursor.execute("UPDATE msgraph_calendar_collections SET delta_link = NULL"
                               " WHERE account_id = ? AND graph_calendar_id = ?", (acc_id, graph_calendar_id))
                conn.commit()
            return f"Microsoft Graph fetch failed for account {acc_id}: {fe}"
        except (urllib.error.URLError, ValueError) as fe:
            # The delta link is not advanced, so the next sync fetches the same changes again.
            return f"Microsoft Graph fetch failed for account {acc_id}: {fe}"

        written = 0
        for item in resp_data.get("value", []):
            if _apply_graph_item(user_id, cursor, acc_id, mirror["local_collection"], item, now_ms):
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
            return f"Microsoft Graph delta page for account {acc_id} carried neither nextLink nor deltaLink"

    cursor.execute(
        "UPDATE msgraph_calendar_collections SET delta_link = ?, delta_started_at = ?"
        " WHERE account_id = ? AND graph_calendar_id = ?",
        (new_delta_link, round_started_at, acc_id, graph_calendar_id)
    )
    conn.commit()
    return ""


def _local_auth(user_id):
    return "Basic " + base64.b64encode(f"{user_id}:{SYSTEM_SYNC_SECRET}".encode("utf-8")).decode("ascii")


def _local_get(user_id, url):
    """The ICS of a resource in the local Radicale, or None when it is not there."""
    req = urllib.request.Request(url, headers={"Authorization": _local_auth(user_id), "Accept-Encoding": "identity"},
                                 method="GET")
    try:
        with urllib.request.urlopen(req, context=ssl_context_for(url, LOCAL_CALDAV_URL), timeout=HTTP_TIMEOUT_SECONDS) as res:
            ics = res.read().decode("utf-8")
    except urllib.error.HTTPError as get_err:
        if get_err.code in (404, 410):
            return None
        raise
    if not ics.strip():
        raise ValueError(f"the local Radicale answered GET {url} with an empty body")
    return ics


def _ical_unescape(value):
    """Unescape an iCalendar TEXT value (RFC 5545 3.3.11)."""
    return re.sub(r"\\([\\;,nN])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), value)


def _ical_time(params, value):
    """DTSTART/DTEND -> (Graph dateTimeTimeZone in UTC, all_day). A floating time has no zone to send."""
    if "VALUE=DATE" in params.upper() and "T" not in value:
        day = datetime.datetime.strptime(value, "%Y%m%d")
        return {"dateTime": day.strftime("%Y-%m-%dT00:00:00"), "timeZone": "UTC"}, True
    if value.endswith("Z"):
        stamp = datetime.datetime.strptime(value, "%Y%m%dT%H%M%SZ")
    else:
        zone = re.search(r';TZID="?([^;:"]+)', params)
        if zone is None:
            raise ValueError(f"time {value!r} carries neither UTC nor a TZID")
        stamp = (datetime.datetime.strptime(value, "%Y%m%dT%H%M%S").replace(tzinfo=ZoneInfo(zone.group(1)))
                 .astimezone(datetime.timezone.utc).replace(tzinfo=None))
    return {"dateTime": stamp.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": "UTC"}, False


def ics_to_graph_event(ics):
    """The Graph event body for the first VEVENT of an ICS: subject, body, location, start and end."""
    text = re.sub(r"\r?\n[ \t]", "", ics)
    vevent = re.search(r"^BEGIN:VEVENT\s*$(.*?)^END:VEVENT\s*$", text, re.M | re.S)
    if vevent is None:
        raise ValueError("the restored item holds no VEVENT")
    # Properties of nested components (VALARM) are not the event's.
    own = re.sub(r"^BEGIN:(\w+)\s*$.*?^END:\1\s*$", "", vevent.group(1), flags=re.M | re.S)
    props = {}
    for line in own.splitlines():
        prop = re.match(r'^([A-Za-z-]+)((?:;(?:[^:;"]|"[^"]*")*)*):(.*?)\r?$', line)
        if prop:
            props.setdefault(prop.group(1).upper(), (prop.group(2), prop.group(3)))
    if "DTSTART" not in props or "DTEND" not in props:
        raise ValueError("the restored event has no DTSTART or DTEND")
    start, all_day = _ical_time(*props["DTSTART"])
    end, _ = _ical_time(*props["DTEND"])
    event = {
        "subject": _ical_unescape(props.get("SUMMARY", ("", ""))[1]),
        "body": {"contentType": "text", "content": _ical_unescape(props.get("DESCRIPTION", ("", ""))[1])},
        "start": start,
        "end": end,
        "isAllDay": all_day,
    }
    location = props.get("LOCATION", ("", ""))[1]
    if location:
        event["location"] = {"displayName": _ical_unescape(location)}
    return event


def _push_restores(user_id, conn, acc_id, headers, now_ms):
    """Creates at Graph each event restored from the shard trash into one of this account's mirrors (#597).

    Microsoft gives it a new id (and the event a new UID), so the local copy moves to that id's
    resource. Returns an error message, or "" when every queued restore is done; a failed one stays
    queued for the next sync.
    """
    cursor = conn.cursor()
    queued = cursor.execute("SELECT href FROM msgraph_restores WHERE account_id = ? ORDER BY created_at",
                            (acc_id,)).fetchall()
    for row in queued:
        href = urllib.parse.unquote(row["href"])
        segments = href.split("/")
        if len(segments) != 4 or segments[0] != "" or segments[1] != user_id:
            raise ValueError(f"restored item {href!r} is not in the calendars of user {user_id}")
        mirror = cursor.execute(
            "SELECT graph_calendar_id FROM msgraph_calendar_collections WHERE account_id = ? AND local_collection = ?",
            (acc_id, segments[2])).fetchone()
        if mirror is None:
            raise ValueError(f"restored item {href!r} is not in a Microsoft 365 mirror of account {acc_id}")
        local_url = _local_url(href)
        ics = _local_get(user_id, local_url)
        # None: deleted again in the shard before this sync, so there is nothing to create.
        if ics is not None:
            try:
                created = _graph_json(calendar_url(mirror["graph_calendar_id"]) + "/events", headers, "POST",
                                      ics_to_graph_event(ics))
            except (urllib.error.URLError, ValueError) as post_err:
                return f"Microsoft 365: re-creating a restored event failed for account {acc_id}: {post_err}"
            _apply_graph_item(user_id, cursor, acc_id, segments[2], created, now_ms)
            if href != f"/{user_id}/{segments[2]}/msgraph-event-{created['id']}.ics":
                del_req = urllib.request.Request(local_url, headers={"Authorization": _local_auth(user_id)},
                                                 method="DELETE")
                try:
                    with urllib.request.urlopen(del_req, context=ssl_context_for(local_url, LOCAL_CALDAV_URL),
                                                timeout=HTTP_TIMEOUT_SECONDS):
                        pass
                except urllib.error.HTTPError as del_err:
                    # Already gone locally; any other failure propagates and fails the sync job.
                    if del_err.code not in (404, 410):
                        raise
        cursor.execute("DELETE FROM msgraph_restores WHERE account_id = ? AND href = ?", (acc_id, row["href"]))
        conn.commit()
    return ""


def _apply_graph_item(user_id, cursor, acc_id, collection, item, now_ms):
    """Writes or deletes the local copy of one Graph event in its mirror; True if a local event was changed.

    An event the sync has seen before keeps its local resource and UID (it may have been created in
    the shard); a new one becomes `msgraph-event-<id>.ics`.
    """
    graph_id = item.get("id")
    if not graph_id:
        return False
    calendar_segment = path_segment(collection, SAFE_CALENDAR_SEGMENT_RE, "mirror collection")
    path_segment(graph_id, SAFE_EVENT_SEGMENT_RE, "Graph event id")
    mapping = cursor.execute(
        "SELECT local_uid, href FROM msgraph_event_mappings WHERE graph_id = ? AND account_id = ?",
        (graph_id, acc_id)).fetchone()
    if mapping is not None:
        # #536: a mapped href is used as a Radicale path only as /<user>/<this mirror>/<safe resource>.
        segments = mapping["href"].split("/")
        if (len(segments) != 4 or segments[0] != "" or segments[1] != user_id or segments[2] != calendar_segment
                or not SAFE_EVENT_SEGMENT_RE.fullmatch(segments[3])):
            raise ValueError(f"Graph event {graph_id} is mapped to {mapping['href']!r}, outside the mirror {collection!r}")

    if item.get("@removed"):
        if mapping is None:
            return False
        del_url = _local_url(mapping["href"])
        # #597: the last known version goes to the shard trash before the mirror drops it.
        last_known = _local_get(user_id, del_url)
        if last_known is not None:
            provider_trash.add_provider_deletion(
                cursor.connection, user_id, mapping["href"].split("/")[2], mapping["href"], last_known,
                msgraph_account_id=acc_id, now_ms=now_ms)
        del_req = urllib.request.Request(del_url, headers={"Authorization": _local_auth(user_id)}, method="DELETE")
        try:
            with urllib.request.urlopen(del_req, context=ssl_context_for(del_url, LOCAL_CALDAV_URL), timeout=HTTP_TIMEOUT_SECONDS):
                pass
        except urllib.error.HTTPError as del_err:
            # Already gone locally; any other failure propagates and fails the sync job.
            if del_err.code not in (404, 410):
                raise
        cursor.execute("DELETE FROM msgraph_event_mappings WHERE graph_id = ? AND account_id = ?", (graph_id, acc_id))
        return True

    if mapping is not None:
        local_uid, href = mapping["local_uid"], mapping["href"]
    else:
        local_uid = f"msgraph-event-{graph_id}"
        path_segment(local_uid + ".ics", SAFE_EVENT_SEGMENT_RE, "local event uid")
        href = f"/{user_id}/{collection}/{local_uid}.ics"
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

    local_put_url = _local_url(href)
    put_req = urllib.request.Request(
        local_put_url,
        data=ics_content.encode("utf-8"),
        headers={
            "Content-Type": "text/calendar; charset=utf-8",
            "Authorization": _local_auth(user_id)
        },
        method="PUT"
    )
    # A failed PUT propagates (the sync job fails) before the mapping is recorded.
    with urllib.request.urlopen(put_req, context=ssl_context_for(local_put_url, LOCAL_CALDAV_URL), timeout=HTTP_TIMEOUT_SECONDS) as res:
        local_etag = res.headers.get("ETag")
    # The recorded ETag tells the next sync whether the item was edited in the shard since (#613).
    if not local_etag:
        raise ValueError(f"the local Radicale answered PUT {href} without an ETag")

    cursor.execute(
        "INSERT OR REPLACE INTO msgraph_event_mappings"
        " (local_uid, graph_id, account_id, last_synced_at, e_tag, href, local_etag) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (local_uid, graph_id, acc_id, now_ms, etag, href, local_etag)
    )
    return True

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: msgraph_worker.py <user_id>")
        sys.exit(1)

    target_user = sys.argv[1]
    res, err = sync_msgraph_accounts(target_user)
    print(json.dumps({"status": "SUCCESS" if res else "ERROR", "error": err}))
