
import sqlite3
import time
import os
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, '/home/agent-user/Coding/Freeshard/webcalendar/sync-worker')
import sync_worker

def mock_sync(uid):
    time.sleep(0.1)
    return (True, "")
sync_worker.sync_user = mock_sync

db_path = '/home/agent-user/Coding/Freeshard/webcalendar/webcalendar.test.db'

with ThreadPoolExecutor(max_workers=2) as executor:
    f1 = executor.submit(sync_worker.process_next_job, db_path)
    f2 = executor.submit(sync_worker.process_next_job, db_path)
    r1 = f1.result()
    r2 = f2.result()

print(f"RESULTS:{r1},{r2}")
