#!/usr/bin/env bash
# Integration test fixture: full route suite against a real Radicale.
#
# Spins up the stack from scratch and runs all tests, deterministically:
#   1. build the freeshard/radicale image and start it (docker, port 5232)
#   2. start the app (host node, port 3000) sharing the SQLite DB via .testdata/
#   3. seed: one calendar + the two users the share/search tests expect
#   4. run the full node:test suite (CalDAV env set, so nothing skips)
#
# Requirements: docker, node >= 20, npm ci already run. Ports 3000/5232 free.
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_DIR="$PWD/.testdata"
SECRET=super-secret-bypass
CALDAV_BASE=https://localhost:5232

APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  docker rm -f freeshard-radicale >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Radicale needs TLS certs; generate throwaway self-signed ones if absent.
if [ ! -f ssl/key.pem ] || [ ! -f ssl/cert.pem ]; then
  mkdir -p ssl
  openssl req -x509 -newkey rsa:2048 -keyout ssl/key.pem -out ssl/cert.pem \
    -days 365 -nodes -subj "/CN=localhost" 2>/dev/null
fi

docker compose build caldav-server

# Fresh state: Radicale writes root-owned files into the bind mount, so wipe
# via a container, not the host user.
docker rm -f freeshard-radicale >/dev/null 2>&1 || true
if [ -d "$DATA_DIR" ]; then
  docker run --rm -v "$DATA_DIR:/x" alpine sh -c 'rm -rf /x/* /x/.[!.]*'
fi
mkdir -p "$DATA_DIR"

docker run -d --name freeshard-radicale -p 5232:5232 \
  -v "$DATA_DIR:/data" -v "$PWD/ssl:/etc/radicale/ssl:ro" \
  -e DATABASE_PATH=/data/webcalendar.db -e SYSTEM_SYNC_SECRET="$SECRET" \
  freeshard/radicale:latest >/dev/null

echo "waiting for radicale ..."
for _ in $(seq 1 30); do
  curl -sk -o /dev/null "$CALDAV_BASE/" && break
  sleep 1
done
curl -sk -o /dev/null "$CALDAV_BASE/" || { echo "radicale did not come up"; exit 1; }

# Radicale (root in the container) owns the data dir now; the host app must be
# able to create the DB file next to it.
docker run --rm -v "$DATA_DIR:/x" alpine chmod -R a+rwX /x

export NODE_TLS_REJECT_UNAUTHORIZED=0
export DATABASE_PATH="$DATA_DIR/webcalendar.db"
export CALDAVURL="$CALDAV_BASE/test/"
export CALDAV_USERNAME=test
export CALDAV_PASSWORD="$SECRET"
export INTERNAL_CALDAV_URL="$CALDAV_BASE"

NODE_ENV=test PORT=3000 SSL_KEY_PATH=/nonexistent SSL_CERT_PATH=/nonexistent \
  node server/index.js &
APP_PID=$!

echo "waiting for app ..."
for _ in $(seq 1 30); do
  curl -sf -o /dev/null http://localhost:3000/api/accounts && break
  sleep 1
done
curl -sf -o /dev/null http://localhost:3000/api/accounts || { echo "app did not come up"; exit 1; }

# Seed: a calendar for the env-default account, plus the users the
# search-users and shares tests look up.
curl -sk -u "test:$SECRET" -X MKCALENDAR "$CALDAV_BASE/test/personal/" \
  -H 'Content-Type: application/xml' \
  --data '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>Personal</d:displayname></d:prop></d:set></c:mkcalendar>' \
  -o /dev/null
node -e "
const sqlite3 = require('sqlite3');
const db = new sqlite3.Database(process.env.DATABASE_PATH);
db.serialize(() => {
  db.run(\"INSERT OR IGNORE INTO users(user_id, username) VALUES('aaron-gryzia', 'Aaron Gryzia')\");
  db.run(\"INSERT OR IGNORE INTO users(user_id, username) VALUES('aaron-gryzia-mail', 'aaron@gryzia.de')\", (err) => {
    if (err) { console.error(err); process.exit(1); }
    db.close();
  });
});
"

TEST_BASE_URL=http://localhost:3000 node --test server/test/*.test.js
