# FreeShard WebCalendar

A self-hosted CalDAV web calendar for [Freeshard](https://freeshard.net) shards.
Month/week/day/agenda views, recurring events, calendar sharing between shard
users, public ICS links, app-passwords for external CalDAV clients, and optional
two-way Google Calendar sync.

## Architecture

Three services around one shared SQLite database:

| Service | Stack | Role |
|---|---|---|
| `webcalendar` | Node 20 / Express, vanilla-JS SPA | Web UI + REST API, talks CalDAV to any server |
| `caldav-server` | [Radicale](https://radicale.org) + custom auth/rights plugins | Internal CalDAV storage; auth against the shared DB (OIDC users, app-passwords, user-to-user shares) |
| `sync-worker` | Python + [vdirsyncer](https://vdirsyncer.pimutils.org) | Background two-way sync of linked Google calendars into Radicale |

Users authenticate via OIDC (Authelia) or a single env-configured account.
External CalDAV accounts (Nextcloud, …) can be linked per user; credentials are
stored AES-encrypted. See `agents.md` for a deeper code map.

## Quick start (Docker)

```sh
cp .env.example .env          # set SESSION_SECRET, ENCRYPTION_KEY, SYSTEM_SYNC_SECRET
mkdir -p ssl && openssl req -x509 -newkey rsa:2048 -keyout ssl/key.pem \
  -out ssl/cert.pem -days 365 -nodes -subj "/CN=localhost"
docker compose up --build
```

The app listens on https://localhost:3000, Radicale on :5232.

## Development

```sh
npm ci
npm run dev            # server with --watch on :3000
```

Without Docker you still need a Radicale for the internal calendar — see the
local recipe in `agents.md`, or point `CALDAVURL` at any external CalDAV server.

### Tests

```sh
NODE_ENV=test SSL_KEY_PATH= SSL_CERT_PATH= node server/index.js &   # test server
NODE_ENV=test npm test                                              # node:test suite
npx playwright test                                                 # e2e (needs internal Radicale)
```

CalDAV-dependent tests skip unless `CALDAVURL`/`CALDAV_USERNAME`/`CALDAV_PASSWORD`
point at a real server.

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example)
for the full annotated list.
