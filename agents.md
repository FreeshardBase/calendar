# freeshard-webcalendar — agent notes

CalDAV web client for Freeshard shards. Node/Express backend + vanilla-JS frontend,
Radicale as the internal CalDAV server, a Python sync-worker for Google Calendar replication.

## Run / test

- `npm ci` — install (Node >= 20).
- `npm start` — serve on :3000 (HTTPS if `ssl/key.pem`+`ssl/cert.pem` exist or `SSL_*_PATH` set, else HTTP).
- `npm run dev` — same with `--watch`.
- `NODE_ENV=test npm test` — node:test route suite (`server/test/*.test.js`).
  Tests fetch `http://localhost:3000`; without a running server the suite skips
  (reachability gate) and only unit tests run — cold `npm test` is always green.
  CalDAV-dependent subtests skip unless `CALDAVURL`/`CALDAV_USERNAME`/`CALDAV_PASSWORD` are set.
- `npm run test:integration` — full suite (all 23 tests) against a real Radicale.
  `scripts/integration-test.sh` builds + starts the Radicale container (shared
  SQLite via bind-mounted `.testdata/`, wiped each run), generates throwaway TLS
  certs if `ssl/` is missing, starts the app in test mode with
  `INTERNAL_CALDAV_URL=https://localhost:5232`, seeds one calendar + two users
  (`Aaron Gryzia` for search-users, `aaron@gryzia.de` for the shares test), runs
  the suite, and tears everything down. Needs docker + free ports 3000/5232.
  Note: Radicale runs as root in its container and chowns the bind mount — the
  script fixes perms and cleans `.testdata/` via a throwaway alpine container.
- CI: `.github/workflows/ci.yml` — `unit` job (cold `npm test`) + `integration`
  job (`npm run test:integration`) on push to master and on PRs.
- `npx playwright test` — e2e (`e2e/calendar.spec.js`), starts its own server via `playwright.config.js`
  (`reuseExistingServer: true`). Needs a reachable internal CalDAV server; local recipe:
  ```
  docker build -t freeshard/radicale:local ./radicale
  docker run -d --name cal-radicale -p 5232:5232 -e DATABASE_PATH=/data/webcalendar.db \
    -v /tmp/cal-data:/data -v $PWD/ssl:/etc/radicale/ssl:ro freeshard/radicale:local
  NODE_TLS_REJECT_UNAUTHORIZED=0 INTERNAL_CALDAV_URL=https://localhost:5232 \
    DATABASE_PATH=/tmp/cal-app.db SSL_KEY_PATH= SSL_CERT_PATH= node server/index.js
  ```
  (self-signed certs: `openssl req -x509 -newkey rsa:2048 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes -subj "/CN=localhost"`)
- Full stack: `docker compose up --build` (webcalendar + caldav-server + sync-worker, shared SQLite volume).

## Architecture

- `server/index.js` — Express app. Session middleware injects accounts into `req.session.accounts`
  on every request: DB-stored linked accounts + `env-default` (from `CALDAVURL` env) +
  `internal-caldav` (Radicale at `INTERNAL_CALDAV_URL`, authed with `SYSTEM_SYNC_SECRET`).
  Auth modes via `AUTH_METHOD`: `env` (default; userId = `CALDAV_USERNAME`) or `oidc` (Authelia).
- `server/db.js` — sqlite3 wrapper, schema auto-created on boot. Tables: `linked_accounts`
  (AES-256-CBC-encrypted passwords/refresh-tokens, key = scrypt(`ENCRYPTION_KEY`)), `app_passwords`
  (sha256, for external CalDAV clients), `calendar_shares` (public ICS tokens), `sync_queue`
  (worker jobs), `users` (OIDC uuid↔username), `user_calendar_shares` (internal user-to-user shares).
- `server/caldav/client.js` — raw CalDAV over native fetch (PROPFIND/REPORT/PUT/MKCALENDAR/…,
  discovery via .well-known, Nextcloud/owncloud + calendarserver sharing dialects).
- `server/caldav/parser.js` — XML (@xmldom) + iCal (ical.js) parsing; RRULE expansion server-side
  (`parseAndExpandEvent`, occurrences get `uid = master::recurrenceId`); JSON→ICS serializer.
- `server/routes/` — `accounts` (CRUD + app-passwords), `calendars` (list/create/patch/delete,
  user shares, public share links), `events` (range query across all accounts, CRUD with ETag
  conflict handling), `auth` (Authelia OIDC login + Google OAuth2 account linking).
  Shares + user search are DB-backed (`users`/`user_calendar_shares`, enforced by the Radicale
  rights plugin) for any account whose URL origin matches `INTERNAL_CALDAV_URL` — Radicale has
  no CalDAV sharing extension; the CalDAV sharing dialects are only for external servers.
- Calendar IDs everywhere: `<accountId>::<href>`, e.g. `internal-caldav::/<user-uuid>/personal/`.
- `radicale/` — Radicale container with two entry-point plugins reading the shared SQLite DB:
  `radicale_custom_auth` (username→uuid mapping, `SYSTEM_SYNC_SECRET` bypass, app-password check)
  and `radicale_custom_rights` (owner full access, others via `user_calendar_shares`).
- `sync-worker/` — Python daemon polling `sync_queue`; builds a vdirsyncer config per user and
  two-way-syncs Google Calendar (google_calendar storage) ↔ Radicale (`/<uuid>/<slug>/`).
- `public/` — no-framework SPA: `js/app.js` (boot, views, sidebar, dialogs), `js/calendar.js`
  (month/week/day/agenda grid rendering), `js/eventModal.js`, `js/api.js` (fetch wrappers),
  `js/store.js` (pub/sub state), `js/accountModal.js`, `css/app.css`.

## Conventions

- UI language is German; code/comments English.
- Styling: Freeshard "Daylight Instrument" design tokens (CSS custom props in `app.css` §1,
  canonical source `~/knowledge_base/freeshard/ui-style/tokens/`). Light-first, no shadows,
  depth = border + surface tone. Reuse `.btn`, `.modal`, `.fs-label` etc. before inventing new classes.
- No build step, no bundler; plain CommonJS server-side, plain script tags client-side.
- Do not add METHOD to CalDAV VCALENDAR objects (RFC 4791 §4.1) — see `eventToICS`.
- Multi-process SQLite: node app, Radicale plugins, and sync-worker all open the same DB file —
  keep writes short-lived; schema changes must be additive (silent `ALTER TABLE` migrations in db.js).
