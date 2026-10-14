from radicale.rights import BaseRights
from radicale import pathutils
import sqlite3
import os
from contextlib import closing

class Rights(BaseRights):
    def authorization(self, user, path):
        # Verify authenticated user
        if not user:
            return ""

        sane_path = pathutils.strip_path(path)
        
        # If accessing the root path, allow read-only (so principal discovery works)
        if not sane_path:
            return "R"

        segments = sane_path.split("/")
        owner_id = segments[0]

        # 1. Owner always gets full permissions. "D"/"d" are deny-delete bits
        # in Radicale, so the owner must never receive them.
        if user.lower() == owner_id.lower():
            if len(segments) == 1:
                return "RW"
            return "rw"

        # 2. Accessing someone else's space
        if len(segments) < 2:
            # Can't read/write someone else's principal root directly
            return ""

        calendar_slug = segments[1]
        calendar_id = f"internal-caldav::/{owner_id}/{calendar_slug}/"

        collections_folder = os.environ.get("RADICALE_COLLECTIONS_FOLDER", "/data/collections")
        if os.path.exists(collections_folder):
            col_dir = os.path.join(collections_folder, owner_id, calendar_slug)
            col_dir_lower = os.path.join(collections_folder, owner_id.lower(), calendar_slug)
            if not os.path.exists(col_dir) and not os.path.exists(col_dir_lower):
                return ""

        db_path = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")
        if not os.path.exists(db_path):
            return ""

        # #343: database errors propagate; Radicale logs them and answers 500 instead of
        # pretending the share does not exist.
        with closing(sqlite3.connect(db_path)) as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            row = conn.execute(
                "SELECT read_write, role, status FROM user_calendar_shares WHERE LOWER(calendar_id) = LOWER(?) AND LOWER(sharee_user_id) = LOWER(?)",
                (calendar_id, user)
            ).fetchone()

        if row is not None:
            rw_flag, role, status = row[0], row[1], row[2]
            if status and status != 'ACCEPTED':
                return ""
            has_write = bool(rw_flag) or role in ('WRITE', 'ADMIN')
            if role in ('READ', 'FREE_BUSY'):
                has_write = False
            # "d" denies deleting the collection itself (Radicale checks it
            # against the collection path), so only the owner can delete it.
            return "rwd" if has_write else "rd"

        return ""
