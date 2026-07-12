from radicale.rights import BaseRights
import sqlite3
import os

class Rights(BaseRights):
    def authorized(self, user, path, permission):
        # If not authenticated, deny access
        if not user:
            return False

        # Normalize requested path (strip leading/trailing slashes)
        clean_path = path.strip("/")
        
        # Allow authenticated users access to the root/discovery endpoints
        if not clean_path or clean_path.startswith(".well-known"):
            return True

        # Split path segments
        segments = clean_path.split("/")
        owner_id = segments[0]

        # 1. If the logged-in user is the owner, allow all access (read/write)
        if user.lower() == owner_id.lower():
            return True

        # 2. Otherwise, check if this is a shared calendar request
        # The path must look like "ownerId/calendarSlug" or "ownerId/calendarSlug/item.ics"
        if len(segments) < 2:
            return False

        calendar_slug = segments[1]
        # Construct the full calendar ID that matches the database format:
        # "internal-caldav::/ownerId/calendarSlug/"
        calendar_id = f"internal-caldav::/{owner_id}/{calendar_slug}/"

        # Check SQLite database for share permissions
        db_path = os.environ.get("DATABASE_PATH", "/data/webcalendar.db")
        if not os.path.exists(db_path):
            return False

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
                has_write_permission = bool(row[0])
                if permission == "r":
                    return True
                elif permission == "w":
                    return has_write_permission

            return False
        except Exception:
            return False
