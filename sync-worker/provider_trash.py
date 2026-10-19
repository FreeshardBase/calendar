"""The shard trash for items a sync finds deleted at a linked provider (#597).

Before a sync drops the local mirror's copy of an event or task the provider deleted, the last
known version goes into `trash_items` (server/db.js) with origin 'provider', so the person can
restore it for 30 days like any other delete; the provider's own trash is not relied on. The row
has the shape the app writes (#348): payload { href, ics }, plus { msgraph: { accountId } } for the
Microsoft 365 import, whose worker re-creates a restored event at Graph.
"""
import json
import re
import time
import uuid

TRASH_KINDS = {"VEVENT": "event", "VTODO": "task"}


def _ical_text(value):
    """Unescape an iCalendar TEXT value (RFC 5545 3.3.11)."""
    return re.sub(r"\\([\\;,nN])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), value)


def item_kind_and_title(ics):
    """('event' | 'task' | None, title) of a resource: its first VEVENT/VTODO, titled by SUMMARY or UID."""
    text = re.sub(r"\r?\n[ \t]", "", ics)
    comp = re.search(r"^BEGIN:(VEVENT|VTODO|VJOURNAL)\s*$", text, re.M)
    if comp is None:
        raise ValueError("the resource holds no VEVENT, VTODO or VJOURNAL")
    rest = text[comp.end():]
    end = re.search(rf"^END:{comp.group(1)}\s*$", rest, re.M)
    body = rest[:end.start()] if end else rest
    summary = re.search(r"^SUMMARY(?:;[^:\r\n]*)?:(.*?)\s*$", body, re.M)
    uid = re.search(r"^UID(?:;[^:\r\n]*)?:(.*?)\s*$", body, re.M)
    title = _ical_text(summary.group(1)) if summary and summary.group(1) else (uid.group(1) if uid else "")
    return TRASH_KINDS.get(comp.group(1)), title


def add_provider_deletion(conn, user_id, collection, href, ics, msgraph_account_id=None, now_ms=None):
    """Insert the trash row for one item of the user's local collection; False for a journal entry,
    which the app neither shows nor restores. The caller commits."""
    kind, title = item_kind_and_title(ics)
    if kind is None:
        return False
    payload = {"href": href, "ics": ics}
    if msgraph_account_id is not None:
        payload["msgraph"] = {"accountId": msgraph_account_id}
    conn.execute(
        "INSERT INTO trash_items (id, user_id, kind, calendar_id, title, linked, origin, payload, deleted_at)"
        " VALUES (?, ?, ?, ?, ?, 1, 'provider', ?, ?)",
        (str(uuid.uuid4()), user_id, kind, f"internal-caldav::/{user_id}/{collection}/", title,
         json.dumps(payload), int(time.time() * 1000) if now_ms is None else now_ms),
    )
    print(f"[Sync-Worker] {kind} {title!r} was deleted at the provider; kept in the trash of user {user_id}")
    return True
