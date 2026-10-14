# freeshard-webcalendar — agent notes

CalDAV web client for Freeshard shards. Node/Express backend + vanilla-JS frontend,
Radicale as the internal CalDAV server, a Python sync-worker for Google Calendar replication.

## Run / test

- `npm ci` — install (Node >= 20).
- `npm start` — serve on :3000 (HTTPS if `ssl/key.pem`+`ssl/cert.pem` exist or `SSL_*_PATH` set, else HTTP).
- `npm run dev` — same with `--watch`.
- `NODE_ENV=test npm test` — node:test integration suite (`server/test/*.test.js`).
  Tests are self-contained and spin up isolated Express instances on ephemeral ports. No pre-started server is required.
  Tests isolate database state using `webcalendar.test.db` when `DATABASE_PATH` is unset to protect developer databases.
- `python3 -m unittest discover -s server/test/python` — Python test suite (`radicale_custom_auth`, `radicale_custom_rights`, `sync_worker`, `msgraph_worker`).
- `npm run lint` — syntax check JS files (`node --check`) and compile Python modules (`py_compile`).
- `npm run test:all` — execute both `npm test` and `npm run test:e2e` (`npx playwright test`).
- `npx playwright test` — e2e (`e2e/calendar.spec.js`), starts its own server via `playwright.config.js`
  (`reuseExistingServer` outside CI). That server runs the shipping configuration (`NODE_ENV=production`,
  no test-mode switch: `X-Test-*` headers are ignored, no fake users are seeded) on its own database
  `$TMPDIR/webcalendar-e2e/webcalendar.db`; specs seed fixtures there themselves (#211). A server you
  started yourself on :3098 is reused as-is, so leave the port free and let Playwright start it. Needs a
  reachable internal CalDAV server whose `SYSTEM_SYNC_SECRET` matches `playwright.config.js`; local recipe:
  ```
  docker build -t freeshard/radicale:local ./radicale
  docker run -d --name cal-radicale -p 5232:5232 -e DATABASE_PATH=/data/webcalendar.db \
    -e SYSTEM_SYNC_SECRET=super-secret-bypass \
    -v /tmp/cal-data:/data -v $PWD/ssl:/etc/radicale/ssl:ro freeshard/radicale:local
  npx playwright test
  # running the app by hand against the same Radicale (shares its database; not on :3098):
  INTERNAL_CALDAV_URL=https://localhost:5232 SYSTEM_SYNC_SECRET=super-secret-bypass \
    DATABASE_PATH=/tmp/cal-data/webcalendar.db SSL_KEY_PATH= SSL_CERT_PATH= node server/index.js
  ```
  (self-signed certs: `openssl req -x509 -newkey rsa:2048 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes -subj "/CN=localhost"`)
- Full stack: `docker compose up --build` (webcalendar + caldav-server + sync-worker, shared SQLite volume).

## Architecture

- `server/index.js` — Express app. Session middleware injects accounts into `req.session.accounts`
  on every request: DB-stored linked accounts + `env-default` (from `CALDAVURL` env) +
  `internal-caldav` (Radicale at `INTERNAL_CALDAV_URL`, authed with `SYSTEM_SYNC_SECRET`).
  Auth modes via `AUTH_METHOD`: `env` (default; userId = `CALDAV_USERNAME`) or `oidc` (Generic OpenID Connect / OIDC standard identity provider or reverse-proxy header auth).
- `server/db.js` — sqlite3 wrapper, schema auto-created on boot. Tables: `linked_accounts`
  (AES-256-CBC-encrypted passwords/refresh-tokens, key = scrypt(`ENCRYPTION_KEY`)), `app_passwords`
  (PBKDF2-HMAC-SHA256, for internal service/app authentication), `calendar_shares` (public ICS tokens), `sync_queue`
  (worker jobs), `users` (OIDC uuid↔username), `user_calendar_shares` (internal user-to-user shares).
- `server/caldav/client.js` — raw CalDAV over native fetch (PROPFIND/REPORT/PUT/MKCALENDAR/…,
  discovery via .well-known, Nextcloud/owncloud + calendarserver sharing dialects).
- `server/utils/ical.js` — Central iCalendar (RFC 5545) processing layer: `eventToICS`, `taskToICS`, `parseAndExpandEvent`, `buildVTimezoneBlock` (TZID registration), RFC 6868 parameter escaping (`escParamVal`), UTF-8 octet line folding (`foldLines`), foreign property preservation, and `updateWholeSeries` (EXDATE & detached override isolation).
- `server/utils/msgraph.js` — MS Graph API client and `MSGraphSyncEngine` for Microsoft 365 / Outlook calendar integration and event format mapping (`veventToGraphEvent` / `graphEventToVEVENT`).
- `server/routes/` — `accounts` (CRUD + app-passwords), `calendars` (list/create/patch/delete, user shares, public share links), `events` (range query across accounts, CRUD with ETag conflict handling), `tasks` (`/api/tasks` VTODO CRUD & RFC 5545 task recurrence advancing), `msgraph` (`/api/msgraph/accounts` MS Graph OAuth account management), `auth` (Generic OIDC login, Back-Channel Logout, Google OAuth2 account linking).
- Calendar IDs everywhere: `<accountId>::<href>`, e.g. `internal-caldav::/<user-uuid>/personal/`.
- `radicale/` — Radicale container with two entry-point plugins reading the shared SQLite DB:
  `radicale_custom_auth` (username→uuid mapping, `SYSTEM_SYNC_SECRET` bypass, app-password check)
  and `radicale_custom_rights` (owner full access, others via `user_calendar_shares`).
- `sync-worker/` — Python daemon polling `sync_queue`: `sync_worker.py` (vdirsyncer Google Calendar ↔ Radicale sync) and `msgraph_worker.py` (MS Graph / Outlook bidirectional sync worker).
  Each Google calendar syncs into its own opaque collection `/<user-uuid>/google-<hex>/`, persisted in
  `google_calendar_collections` per (account, Google calendar id). The worker MKCALENDARs it with the Google
  name as `displayname` (one-way; no metasync, which would push app renames to Google). A `google-<slug>`
  collection from older worker versions is adopted only if that account's pair has vdirsyncer status for it.
  The create route never puts app calendars under `google-` (#193).
- `public/` — no-framework SPA: `js/app.js` (boot, views, sidebar, dialogs), `js/calendar.js`
  (month/week/day/agenda grid rendering), `js/tasks.js` (VTODO sidebar drawer & Kanban board), `js/eventModal.js`, `js/api.js` (fetch wrappers),
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
