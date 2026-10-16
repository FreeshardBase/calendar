# FreeShard WebCalendar

> **Work in progress, not ready for production use.** This project is under active
> development and has open, unresolved security issues (tracked publicly in the
> [issue tracker](https://github.com/FreeshardBase/calendar/issues), see the
> [roadmap issue](https://github.com/FreeshardBase/calendar/issues/361) for current
> status). It is not installed on any Freeshard shard today. Do not deploy this for
> real calendar data yet.

A self-hosted CalDAV web calendar for [Freeshard](https://freeshard.net) shards.
Month/week/day/agenda views, recurring events, calendar sharing between shard
users, public ICS links, app-passwords for internal service integration, and optional
two-way sync with Google Calendar and external CalDAV servers.

## Architecture

Three services around one shared SQLite database:

| Service | Stack | Role |
|---|---|---|
| `webcalendar` | Node 22 / Express, vanilla-JS SPA | Web UI + REST API, talks CalDAV to any server |
| `caldav-server` | [Radicale](https://radicale.org) + custom auth/rights plugins | Internal CalDAV storage engine (unexposed to external clients in shipping topology); auth against shared DB |
| `sync-worker` | Python + [vdirsyncer](https://vdirsyncer.pimutils.org) | Background two-way sync of linked Google/CalDAV calendars into Radicale |

### Shipping Topology & CalDAV Integration
The internal Radicale server (`caldav-server`) runs strictly as an unexposed backend container within the private container network. Direct connection from external CalDAV desktop or mobile clients (e.g. Thunderbird, iOS Calendar, DAVx5) is not exposed in the shipping topology. Users can link external CalDAV accounts (Nextcloud, Fastmail, etc.) inside the WebCalendar UI for background two-way synchronization.


Users authenticate via generic OpenID Connect (OIDC) / identity headers or a single env-configured account.
External CalDAV accounts (Nextcloud, …) can be linked per user; credentials are
stored AES-encrypted. See `agents.md` for a deeper code map.

## Quick start (Docker)

```sh
cp .env.example .env          # set SESSION_SECRET, ENCRYPTION_KEY, SYSTEM_SYNC_SECRET, …
docker compose up --build
```

The app listens on http://localhost:3000 (Radicale runs unexposed on the internal container network).
The compose file has the shape of the store template, so local runs exercise what ships: all three
services share one bind-mounted data directory (`./data`, gitignored), the app reaches Radicale over
plain HTTP on the compose network (`http://caldav-server:5232`, `RADICALE_SSL=false`), and every
setting comes from a variable that Compose fills from `.env`; `docker compose up` refuses to start
while a secret is missing. The app also runs on plain HTTP (`SSL_KEY_PATH`/`SSL_CERT_PATH` are
blank), as on a shard, where the platform proxy terminates TLS. With `COOKIE_SECURE=auto` the
session cookie is marked `Secure` only on HTTPS requests, so the session works on this local HTTP
URL as well.

## Development

```sh
npm ci
npm run dev            # server with --watch on :3000
```

Without Docker you still need a Radicale for the internal calendar — see the
local recipe in `agents.md`, or point `CALDAVURL` at any external CalDAV server.

### Tests

```sh
npm test               # node:test suite, starts its own servers
npx playwright test    # e2e (needs internal Radicale)
```

Do not start a server before `npm test`: each test file listens on its own fixed port and fails
with `EADDRINUSE` if that port is taken. The suite uses `webcalendar.test.db` (or `DATABASE_PATH`)
and empties it, and it must run inside a git checkout (one test runs `git ls-files`). CalDAV route
tests use an in-process mock DAV server. Details in `agents.md`.

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example)
for the full annotated list.

### Credential encryption key

Linked-account passwords and Google / Microsoft tokens are encrypted with the install's
key: `ENCRYPTION_KEY`, persisted to `.encryption_key` next to the database
(or `ENCRYPTION_KEY_FILE`). The file wins over the environment variable.

- **Fresh install only:** a key is generated only when neither the variable nor the file
  exists *and* the database holds no encrypted values.
- **Key check:** the database stores one value encrypted with the key
  (`encryption_key_check`). If the configured key cannot decrypt it, the web app and the
  sync worker refuse to start instead of producing unreadable credentials. Databases from
  before this check adopt it on the first boot whose key decrypts their credentials.
- **Backups** must contain `webcalendar.db` *and* `.encryption_key` (or the
  `ENCRYPTION_KEY` value). A database restored without its key cannot be used. Restore the
  key and the service starts again.
- **Consistent snapshot:** the shard backup copies the data directory file by file, which can
  tear the live WAL-mode `webcalendar.db` / `-wal` / `-shm` while writes happen. The web app
  therefore writes `webcalendar.db.backup` next to the database at boot and then every hour
  (`VACUUM INTO`, checked with `PRAGMA integrity_check`, renamed into place). **To restore**,
  stop all services, replace `webcalendar.db` with `webcalendar.db.backup`, delete
  `webcalendar.db-wal` and `webcalendar.db-shm`, and start again. Changes made after the
  snapshot (at most an hour before the backup) are lost.
- **Rotation:** there is no re-encryption tool yet. To replace a key, stop all services,
  delete the rows of `linked_accounts`, `msgraph_accounts` and `encryption_key_check`,
  remove `.encryption_key`, set the new `ENCRYPTION_KEY`, start, and re-link the accounts.
  The `.encryption_key` committed in `23ec28d` (untracked again in `03044ac`) is still
  in the git history. Treat it as public and never reuse it for a real install.
