from radicale.rights import BaseRights
from radicale import pathutils
import sqlite3
import os

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

        # 1. Owner always gets full permissions
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

        db_path = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")
        if not os.path.exists(db_path):
            return ""

        try:
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            cursor.execute(
                "SELECT read_write FROM user_calendar_shares WHERE calendar_id = ? AND sharee_user_id = ?",
                (calendar_id, user)
            )
            row = cursor.fetchone()
            conn.close()

            if row is not None:
                has_write = bool(row[0])
                return "rw" if has_write else "r"

            return ""
        except Exception:
            return ""
