# freeshard-webcalendar — agent notes

CalDAV web client for Freeshard shards. Node/Express backend + vanilla-JS frontend,
Radicale as the internal CalDAV server, a Python sync-worker for Google Calendar replication.

## Run / test

- `npm ci` — install (Node >= 20).
- `npm start` — serve on :3000 (HTTPS if `ssl/key.pem`+`ssl/cert.pem` exist or `SSL_*_PATH` set, else HTTP).
- `npm run dev` — same with `--watch`.
- `npm test` — node:test integration suite: `scripts/test-unit.sh` runs `NODE_ENV=test node --test
  --test-concurrency=1` over `server/test/*.test.js` (minus the files that need a sibling `../app-repository`, #332).
  Each HTTP-touching file starts its own server on its own fixed port (literals spread over 3091–3958, a few use
  `listen(0)`); because the ports are fixed and some are shared, files must run one at a time, hence
  `--test-concurrency=1`. Do **not** start a server first: one listening on a test file's port makes that file
  fail with `EADDRINUSE`. With `NODE_ENV=test` and `DATABASE_PATH` unset the suite uses `webcalendar.test.db`
  in the checkout (`server/db.js`), never `webcalendar.db`; several files call `Db.clearAll()`, so never point
  `DATABASE_PATH` at a database you want to keep. Run it inside a git checkout:
  `server/test/issue133_tracked_wal_sidecars.test.js` runs `git ls-files` and fails without `.git`.
  CalDAV route tests run against an in-process mock DAV server; nothing is skipped and no Radicale is needed.
  Requiring `server/index.js` never binds a port (#255): only `node server/index.js` listens. A test that needs HTTP
  calls `server.listen(process.env.PORT)` itself, and sets `process.env.PORT` to its own fixed literal (never
  `process.env.PORT || …`), so an exported `PORT` (e.g. `PORT=3000` from `.env.example`) cannot make files collide.
  A test becomes a user with `await loginAs(userId, { username, email })` from `server/test/helpers/testSession.js`:
  it writes a real session row and returns a signed `cookie` header value. No request header asserts an identity,
  under any `NODE_ENV` (#50/#245); the only header identity is the secret-gated proxy auth (`HTTP_HEADER_AUTH`/`oidc`).
  A suite that sends POST/PUT/PATCH/DELETE with `fetch` requires `./helpers/sameOriginFetch` first: the CSRF
  guard (#340) refuses requests without a same-origin `Origin`/`Sec-Fetch-Site`, which Node's fetch never sends.
- `python3 -m unittest discover -s server/test/python` — Python test suite (`radicale_custom_auth`, `radicale_custom_rights`, `sync_worker`, `msgraph_worker`).
- `npm run lint` — syntax check JS files (`node --check`) and compile Python modules (`py_compile`).
- `npm run test:all` — execute both `npm test` and `npm run test:e2e` (`npx playwright test`).
- `npx playwright test` — e2e (`e2e/calendar.spec.js`), starts its own server via `playwright.config.js`
  (`reuseExistingServer` outside CI). That server runs the shipping configuration (`NODE_ENV=production`,
  no test-mode switch, no fake users are seeded); specs seed fixtures themselves (#211). Every run is
  its own fixture (#217): `playwright.config.js` picks a run id (`E2E_RUN_ID`), signs the browser in as
  `e2e-<run id>` (`CALDAV_USERNAME`) with the database `$TMPDIR/webcalendar-e2e/<run id>/webcalendar.db`,
  and `e2e/global-teardown.js` deletes the run's Radicale principal `/e2e-<run id>/` and that directory
  afterwards, failed runs included. The teardown fails the run if Radicale refuses the delete. A server you
  started yourself on :3098 is reused as-is and does not sign in as the run's user, so leave the port free
  and let Playwright start it. Needs a reachable internal CalDAV server whose `SYSTEM_SYNC_SECRET` matches
  `playwright.config.js`: `just test-e2e` starts one (`just e2e-radicale`, as in CI) if nothing answers
  on :5232. Manual recipe:
  ```
  docker build -t freeshard/radicale:local ./radicale
  # --user 0:0 lets the entrypoint chown the bind mount to uid 1000 before Radicale starts (#100)
  docker run -d --name cal-radicale --user 0:0 -p 5232:5232 -e DATABASE_PATH=/data/webcalendar.db \
    -e SYSTEM_SYNC_SECRET=super-secret-bypass \
    -v /tmp/cal-data:/data -v $PWD/ssl:/etc/radicale/ssl:ro freeshard/radicale:local
  npx playwright test
  # running the app by hand against the same Radicale (shares its database; not on :3098):
  INTERNAL_CALDAV_URL=https://localhost:5232 SYSTEM_SYNC_SECRET=super-secret-bypass \
    DATABASE_PATH=/tmp/cal-data/webcalendar.db SSL_KEY_PATH= SSL_CERT_PATH= node server/index.js
  ```
  (self-signed certs: `openssl req -x509 -newkey rsa:2048 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes -subj "/CN=localhost"`)
- Full stack: `cp .env.example .env` first (`.env` is gitignored and Compose fills the required secret variables
  from it; set `SESSION_SECRET`, `ENCRYPTION_KEY`, `SYSTEM_SYNC_SECRET`, `INTERNAL_WEBHOOK_SECRET`, `BASE_URL`,
  `HTTP_HEADER_AUTH_SECRET`), then `docker compose up --build` (webcalendar + caldav-server + sync-worker).
  The compose file mirrors the store template (#118): no `env_file`, no published Radicale port, plain HTTP to
  Radicale (`http://caldav-server:5232`, `RADICALE_SSL=false`), services started as `user: "0:0"`, and one bind
  mount `./data` (app at `/app/data`, Radicale and sync-worker at `/data`, vdirsyncer status at
  `/data/vdir_status`) holding the same `webcalendar.db`.

## Architecture

- `server/index.js` — Express app. Session middleware injects accounts into `req.session.accounts`
  on every request: DB-stored linked accounts + `env-default` (from `CALDAVURL` env) +
  `internal-caldav` (Radicale at `INTERNAL_CALDAV_URL`, authed with `SYSTEM_SYNC_SECRET`).
  Auth modes via `AUTH_METHOD`: `env` (default and the shipping mode; one owner, userId = `CALDAV_USERNAME`,
  `owner` in the store template) or `oidc` (the shard's own OIDC provider, plus secret-gated proxy header identity).
  `shard_core` has no OIDC provider yet, so no shard can run `oidc`; `oidc` without `OIDC_ISSUER_URL`,
  `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` aborts boot (#121). Decision (#121): user-to-user sharing waits
  for that provider and is not cut; until then a shard has only its owner. No users are seeded.
  In production (and staging) `env` mode answers 401 to every request without `X-Freeshard-Secret` =
  `HTTP_HEADER_AUTH_SECRET` (the platform proxy, timing-safe; exempt: `/health`, `/api/health`, `/internal/*`)
  and refuses to start without that secret (#246). Every such request outside `/api/public/` must also carry
  `X-Ptl-Client-Type: terminal`, so the store template's `app_meta.json` declares
  `"": { "access": "private", "headers": { "X-Ptl-Client-Type": "{{ auth.client_type }}" } }` (#143).
  `X-Ptl-Client-Id` is a device id and never an identity source. Outside production the env identity needs no secret.
  Any other `AUTH_METHOD` value aborts boot.
- Healthcheck (#270): `GET /health` / `/api/health` (Dockerfile `HEALTHCHECK`, compose `healthcheck`) answers 200
  only while a fresh read-only connection can read the database file and a `PROPFIND` (Depth 0, login `healthcheck`,
  password `SYSTEM_SYNC_SECRET`) on `INTERNAL_CALDAV_URL/` answers 207; otherwise 503 with
  `{"database"|"caldav": "unavailable"}`. With `DISABLE_INTERNAL_CALDAV` only the database is checked.
- Request security (#340): `BASE_URL` is mandatory in production (no start without it) and the only source of
  public share URLs, OIDC/Google/Microsoft redirect URIs (`<BASE_URL>/api/auth/callback`, `/api/auth/google/callback`,
  `/api/msgraph/callback`) and
  the CSRF origin; `X-Forwarded-Host` is never used. `utils/csrfGuard.js`: a non-GET/HEAD/OPTIONS request passes
  only with `Origin` = BASE_URL origin or, without Origin, `Sec-Fetch-Site: same-origin` (exempt: `/internal/*`,
  back-channel logout). OIDC login uses PKCE (S256), nonce and a mandatory state, and regenerates the session id;
  it runs on openid-client v6 (#179, loaded via `import()` in `utils/oidcClient.js`), which only talks to an https issuer;
  logout is `POST /api/auth/logout`. Proxy header identity needs `HTTP_HEADER_AUTH_SECRET` (timing-safe, ≥32 characters in
  production, must differ from `INTERNAL_WEBHOOK_SECRET`, `SYSTEM_SYNC_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`). `utils/rateLimit.js`: per client IP (`req.ip`, `TRUST_PROXY` hop count, default 1
  in production) 30/min on `/api/auth/*`, 120/min on `/api/public/*`, then 429 with `Retry-After`.
- `server/db.js` — sqlite3 wrapper, schema auto-created on boot. Tables: `linked_accounts`
  (passwords and OAuth tokens, like `msgraph_accounts` tokens, are AES-256-GCM with key = scrypt(`ENCRYPTION_KEY`,
  random per-value salt); `iv` = salt‖nonce, ciphertext = ciphertext‖tag, same format in `sync-worker/sync_worker.py`;
  a tampered value fails to decrypt (#72)), `app_passwords`
  (PBKDF2-HMAC-SHA256, for internal service/app authentication), `calendar_shares` (public ICS tokens), `sync_queue`
  (worker jobs), `sync_job_progress` (events a running job has written so far, #174), `users` (OIDC uuid↔username),
  `user_calendar_shares` (internal user-to-user shares; the sharee must be a row in `users`, otherwise
  `POST`/`DELETE /api/calendars/:id/shares` answer 404 — multi-user, waits for the shard's OIDC provider, #121).
- Long writes (#174): Radicale's create cost grows with the collection size (the `has_uid` scan on every new
  item), so big imports and first syncs take minutes. `POST /api/calendars/:id/import` answers 202 with a job
  (`utils/importJobs.js`, in-process, kept an hour after it ends) whose `processed`/`total` the import banner polls
  at `GET /api/calendars/import-jobs/:jobId` (owner only). The sync worker counts every event it writes
  (vdirsyncer's "Copying (uploading|updating) item" log lines, read live; Graph items per committed page)
  into `sync_job_progress`; `GET /api/accounts/sync-status` returns it as `itemsDone` and the app polls every
  2 s while a job is RUNNING. Event saves are optimistic: the dialog closes and the event is drawn (dashed,
  "wird gespeichert") while the request runs; on failure it is removed or rolled back, an error toast says
  so, and the dialog reopens with the entries.
- `server/caldav/client.js` — raw CalDAV over native fetch (PROPFIND/REPORT/PUT/MKCALENDAR/…,
  discovery via .well-known, Nextcloud/owncloud + calendarserver sharing dialects).
- `server/utils/ical.js` — Central iCalendar (RFC 5545) processing layer: `eventToICS`, `taskToICS`, `parseAndExpandEvent`, `buildVTimezoneBlock` (TZID registration), RFC 6868 parameter escaping (`escParamVal`), UTF-8 octet line folding (`foldLines`), foreign property preservation, and `updateWholeSeries` (EXDATE & detached override isolation).
- Microsoft 365 (#97) — optional, configured by `MSGRAPH_CLIENT_ID` (+ `MSGRAPH_CLIENT_SECRET` for a confidential
  client) and `BASE_URL`; without them `GET /api/msgraph/accounts` reports `available: false`, the modal says so and
  `/api/msgraph/authorize` answers 503. `server/utils/msgraph.js` + `routes/msgraph.js`: authorization code flow
  with PKCE (S256) at tenant `common`, state mandatory and single-use per session, scopes
  `offline_access User.Read Calendars.Read`. Microsoft returns cross-site, where the `SameSite=Strict` session
  cookie is withheld, so the registered `/api/msgraph/callback` (no auth) only serves a page that forwards
  code/state/error same-site to `/api/msgraph/callback/complete`, which checks the state, stores the tokens
  (re-connecting the same mailbox updates its row and clears `reconnect_required`) and enqueues a sync job. There is no token entry by request
  body. `POST /api/msgraph/accounts/:id/sync` only enqueues a job (202). The only Graph sync path is
  `sync-worker/msgraph_worker.py`: import only (Graph → Radicale), `/me/calendarView/delta` (window −365/+730 days,
  fixed per delta round; a round older than 30 days, `delta_started_at`, restarts with a current window), pages `@odata.nextLink`, persists only `@odata.deltaLink`, applies `@removed`, sends
  `Prefer: outlook.timezone="UTC"` and rejects any other `timeZone`. Refresh sends `client_id`, `scope` and
  `client_secret` if set; `invalid_grant` sets `msgraph_accounts.reconnect_required` and the job fails with a
  "please reconnect" message, shown in the modal. A failing account does not stop the user's other Microsoft
  accounts or Google pairs; its error is the job's result. Requests time out after 30 s. A per-account lease (`sync_lock_until`, 15 min) keeps syncs of
  one account from overlapping across processes.
- `server/routes/` — `accounts` (CRUD + app-passwords), `calendars` (list/create/patch/delete, user shares, public share links), `events` (range query across accounts, CRUD with ETag conflict handling), `tasks` (`/api/tasks` VTODO CRUD & RFC 5545 task recurrence advancing), `msgraph` (`/api/msgraph/*` Microsoft 365 OAuth connection, account list, sync request), `auth` (Generic OIDC login, Back-Channel Logout, Google OAuth2 account linking).
- Calendar IDs everywhere: `<accountId>::<href>`, e.g. `internal-caldav::/<user-uuid>/personal/`.
- `radicale/` — Radicale container with two entry-point plugins reading the shared SQLite DB:
  `radicale_custom_auth` (username→uuid mapping, `SYSTEM_SYNC_SECRET` bypass, app-password check)
  and `radicale_custom_rights` (owner full access, others via `user_calendar_shares` — only reachable once
  shards have an OIDC provider and thus a second user, #121).
- `sync-worker/` — Python daemon polling `sync_queue`: `sync_worker.py` (vdirsyncer Google Calendar ↔ Radicale sync) and `msgraph_worker.py` (Microsoft Graph → Radicale import, the only Graph sync path).
  Each Google calendar syncs into its own opaque collection `/<user-uuid>/google-<hex>/`, persisted in
  `google_calendar_collections` per (account, Google calendar id). The worker MKCALENDARs it with the Google
  name as `displayname` (one-way; no metasync, which would push app renames to Google). A `google-<slug>`
  collection from older worker versions is adopted only if that account's pair has vdirsyncer status for it.
  The create route never puts app calendars under `google-` (#193).
- Containers: all three images run their service as uid:gid 1000:1000, because they open the same SQLite
  file. Each image's entrypoint is `drop-privileges.sh` (one copy per build context, kept identical): when
  started as root (the store template sets `user: "0:0"` because shard_core creates the data mount
  root-owned) it chowns the directories in `DATA_DIRS` to 1000:1000 and re-execs itself through `setpriv`;
  started as any other uid it refuses to start if a `DATA_DIRS` entry is not writable (#100).
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
  keep writes short-lived; schema changes must be additive and go into a new numbered entry in
  `server/utils/migrations.js` (never an ad-hoc `ALTER TABLE` in db.js). The server listens only after
  `Db.ready` (migrations + encryption-key check) resolved; a failed migration exits with status 1 (#343).
  The server process (`server/utils/dbBackup.js`) writes the consistent snapshot `webcalendar.db.backup`
  via `Db.createBackup` at boot and hourly, for the shard backup that copies the live files (#120).
- Fail fast (#343): no empty or comment-only `catch {}`, no `.catch(() => {})` / `.catch(() => [])` /
  `.catch(noop)` (ESLint errors) and no `except Exception: pass`
  or blind `except Exception` (ruff S110/BLE001). Catch only the specific expected error, or let it reach
  the user (HTTP error, toast, sync job `error_message`); a deliberate catch-all at a job/loop boundary
  carries `# noqa: BLE001` and a comment saying where the error goes.
