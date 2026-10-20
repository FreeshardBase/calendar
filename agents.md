# freeshard-webcalendar — agent notes

CalDAV web client for Freeshard shards. Node/Express backend + vanilla-JS frontend,
Radicale as the internal CalDAV server, a Python sync-worker for Google Calendar replication.

## Run / test

- `npm ci` — install (Node >= 22).
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
  under any `NODE_ENV` (#50/#245); the only header identity is the secret-gated proxy auth (`AUTH_METHOD=env` with `HTTP_HEADER_AUTH=true`, #523).
  A suite that sends POST/PUT/PATCH/DELETE with `fetch` requires `./helpers/sameOriginFetch` first: the CSRF
  guard (#340) refuses requests without a same-origin `Origin`/`Sec-Fetch-Site`, which Node's fetch never sends.
- `python3 -m unittest discover -s server/test/python` — Python test suite (`radicale_custom_auth`, `radicale_custom_rights`, `sync_worker`, `msgraph_worker`).
- `npm run lint` — syntax check JS files (`node --check`) and compile Python modules (`py_compile`).
  ESLint also rejects a test in `server/test/` that reads app sources (`.js`/`.css`/`.html`) instead of
  testing behaviour (#358/#398); today's offenders are listed in `server/test/source-grep-allowlist.json`.
  That list may only shrink: when you rewrite such a test with supertest, jsdom or Playwright, remove its
  entry (`server/test/source_grep_lint_rule.test.js` fails otherwise). `node scripts/list-source-grep-tests.js`
  prints every test the rule matches, ignoring the allowlist.
- `npm run test:all` — execute both `npm test` and `npm run test:e2e` (`npx playwright test`).
- `npx playwright test` — e2e (`e2e/calendar.spec.js`, and `e2e/dragdrop.spec.js` for drag and drop, #574, which
  also runs in the `mobile-touch` project: Pixel 7, `hasTouch`, touch drags sent through CDP; the phone layout of #351,
  `e2e/issue351_mobile_layout.spec.js`, runs there at 412×915 and in `mobile-iphone`, an iPhone 8 at 375×667 emulated in
  Chromium; at ≤768 px the app opens in the three-day view), starts its own server via `playwright.config.js`
  (`reuseExistingServer` outside CI). That server runs the shipping configuration (`NODE_ENV=production`,
  no test-mode switch, no fake users are seeded); specs seed fixtures themselves (#211). Every run is
  its own fixture (#217): `playwright.config.js` picks a run id (`E2E_RUN_ID`), signs the browser in as
  `e2e-<run id>` (`CALDAV_USERNAME`) with the database `$TMPDIR/webcalendar-e2e/<run id>/webcalendar.db`,
  and `e2e/global-teardown.js` deletes the run's Radicale principal `/e2e-<run id>/` and that directory
  afterwards, failed runs included. The teardown fails the run if Radicale refuses the delete. Inside a
  run every test is its own fixture too (#592): specs import `test` from `e2e/fixtures.js`, which gives
  each test the user `e2e-<run id>-w<worker>-t<n>` (fixture `e2eUser`), sent as the proxy's
  `X-Forwarded-User` (the server runs `HTTP_HEADER_AUTH=true`) on every context, and drops that user's
  principal after the test. A spec that mocks a list endpoint uses `e2e/mocks.js` (`mockCalendars`,
  `mockEvents`), whose collection applies the test's PATCH/PUT/DELETE like the server. A server you
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
  The property is non-enumerable and never reaches the session store, so `sessions.sess` holds no
  credentials (#526); at boot (`Db.ready`) rows that still carry `accounts`, and expired rows, are
  deleted before any request or backup. Do not assign `req.session.accounts` directly in production code.
  Auth modes via `AUTH_METHOD`: `env` (default and the shipping mode; one owner, userId = `CALDAV_USERNAME`,
  `owner` in the store template; a `CALDAV_USERNAME` that is not a safe path segment aborts boot, #536) or `oidc` (the shard's own OIDC provider; the identity comes only from the OIDC callback, never from
  proxy headers, and `oidc` with `HTTP_HEADER_AUTH=true` aborts boot, #523). With `env` and `HTTP_HEADER_AUTH=true`, `X-Forwarded-User`/`X-User-Id`/`Remote-User` plus the
  proxy secret set the user id (refused with 401 unless a safe path segment, #144); a changed identity regenerates the session.
  `shard_core` has no OIDC provider yet, so no shard can run `oidc`; `oidc` without `OIDC_ISSUER_URL`,
  `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` aborts boot (#121). The token endpoint auth method comes from
  `OIDC_TOKEN_AUTH_METHOD` (`client_secret_basic` | `client_secret_post`, anything else aborts boot) or else from
  the issuer's `token_endpoint_auth_methods_supported` (basic tried first, #490). At start each candidate is
  probed with an invalid code (`invalid_grant` = client accepted); the first accepted one is used and logged,
  none accepted aborts boot (#600, `server/utils/oidcClient.js`); a failed callback logs the
  provider's `error`/`error_description`, the browser never sees them. Decision (#121): user-to-user sharing waits
  for that provider and is not cut; until then a shard has only its owner. No users are seeded.
  In production (and staging) `env` mode answers 401 to every request without `X-Freeshard-Secret` =
  `HTTP_HEADER_AUTH_SECRET` (the platform proxy, timing-safe; exempt: `/health`, `/api/health`, `/internal/*`)
  and refuses to start without that secret (#246). Every such request outside `/api/public/` and the public
  booking page must also carry `X-Ptl-Client-Type: terminal`, so the store template's `app_meta.json` declares
  `"": { "access": "private", "headers": { "X-Ptl-Client-Type": "{{ auth.client_type }}" } }` (#143).
  The booking page is served to visitors outside the shard as `/public/booking/?slug=<slug>`, with exactly its
  files `/public/booking/booking.js`, `/public/booking/api.js` and `/public/booking/app.css`. Only these exact
  paths pass; anything else under the prefix stays private. The store template therefore declares
  `/public/booking/` public next to `/api/public/` (app-repository PR #37, #480).
  `X-Ptl-Client-Id` is a device id and never an identity source. Outside production the env identity needs no secret.
  Any other `AUTH_METHOD` value aborts boot.
- Healthcheck (#270): `GET /health` / `/api/health` (Dockerfile `HEALTHCHECK`, compose `healthcheck`) answers 200
  only while a fresh read-only connection can read the database file and a `PROPFIND` (Depth 0, login `healthcheck`,
  password `SYSTEM_SYNC_SECRET`) on `INTERNAL_CALDAV_URL/` answers 207; otherwise 503 with
  `{"database"|"caldav": "unavailable"}`. With `DISABLE_INTERNAL_CALDAV` only the database is checked.
- Lifecycle & logs (#344): on SIGTERM/SIGINT the server stops accepting connections, waits up to
  `SHUTDOWN_TIMEOUT_MS` (default 8000) for in-flight requests, stops the workers, closes the database
  (`Db.close`) and exits 0, or 1 if requests had to be cut off. Server code logs through `server/utils/logger.js`
  (never `console.*`): one JSON line `{time, level, msg, reqId}` per entry, `LOG_LEVEL` debug|info|warn|error
  (default info), credential keys / URL passwords / Basic+Bearer values redacted. Each request gets an
  `X-Request-Id` that every entry logged while serving it carries.
- Request security (#340): `BASE_URL` is mandatory in production (no start without it) and the only source of
  public share URLs, OIDC/Google/Microsoft redirect URIs (`<BASE_URL>/api/auth/callback`, `/api/auth/google/callback`,
  `/api/msgraph/callback`) and
  the CSRF origin; `X-Forwarded-Host` is never used. `utils/csrfGuard.js`: a non-GET/HEAD/OPTIONS request passes
  only with `Origin` = BASE_URL origin or, without Origin, `Sec-Fetch-Site: same-origin` (exempt: `/internal/*`,
  back-channel logout). OIDC login uses PKCE (S256), nonce and a mandatory state, and regenerates the session id;
  it runs on openid-client v6 (#179, loaded via `import()` in `utils/oidcClient.js`), which only talks to an https issuer;
  logout is `POST /api/auth/logout`; with OIDC it sends the browser to the provider's `end_session_endpoint` (id_token
  of the login as `id_token_hint`, `post_logout_redirect_uri` = BASE_URL, which must be registered at the provider)
  and the next login requests `prompt=login` (#535). Proxy header identity needs `HTTP_HEADER_AUTH_SECRET` (timing-safe, ≥32 characters in
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
- Drag and drop (#574): `public/js/eventDrag.js` moves and resizes events in the day/week view with Pointer
  Events (mouse after 5 px, touch after a 400 ms long press; 15-minute grid, Alt minute-exact; all-day ↔ timed by
  dropping into the other area). In the month view (#575) an event moves by whole days and keeps its time of day;
  a multi-day event's first chip carries the start edge and its last chip the end edge (first/last day, times
  stay). `app.js` (`onEventDrop`) asks the recurrence scope, then for events with attendees
  "Teilnehmer über die Änderung informieren?" (Ja resets their PARTSTAT to NEEDS-ACTION with RSVP), saves
  optimistically and offers "Verschoben · Rückgängig" for 8 s. Esc and the top "Abbrechen" zone cancel a drag.
  Only events of writable calendars get handles; the server's calendar write check rejects the rest.
  Dragging on empty space (#576) draws a new event and opens the new-event dialog (`onCreateRange`) with it: a
  timed range over the 15-minute slots of the grabbed day/week column, or in the month view an all-day event
  from the first to the last day crossed. A plain click in the time grid starts on its 15-minute slot.
  Keyboard (#577): a focused event moves with the arrows (time grid ↑/↓ 15 min, ←/→ a day; month ←/→ a day,
  ↑/↓ a week), Shift+arrow changes the end, Alt+Shift+arrow the start; the preview is drawn like a drag and
  read out through `#aria-announcer`; Enter goes through `onEventDrop`, Esc drops it. Open tasks with a DUE show
  in the month/week/day views (`calendarTaskItems`, uid `task:<uid>`, `.calendar-task`; date-only due in the
  all-day row, a due time as a 30-minute block) and move like events without edges; `onTaskDrop` shifts
  DTSTART by the same days and minutes and keeps DUE and DTSTART of the same value type.
- `server/caldav/client.js` — raw CalDAV over native fetch (PROPFIND/REPORT/PUT/MKCALENDAR/…,
  discovery via .well-known, Nextcloud/owncloud + calendarserver sharing dialects).
- `server/utils/ical.js` — Central iCalendar (RFC 5545) processing layer: `eventToICS`, `taskToICS`, `parseAndExpandEvent`, `buildVTimezoneBlock` (TZID registration), RFC 6868 parameter escaping (`escParamVal`), UTF-8 octet line folding (`foldLines`), foreign property preservation, `updateWholeSeries` (EXDATE & detached override isolation) and `splitSeries` (scope `following`, #346: the old series ends with UNTIL, a new UID takes the rest with its EXDATEs and overrides).
- Weather (#513) — opt-in per user: `routes/weather.js` stores a location (rounded to 0.01°, about 1 km) in
  `user_weather_location`; without one nothing is sent. `utils/weather.js` asks Bright Sky (DWD open data, no key;
  `WEATHER_BRIGHTSKY_URL`, default `https://api.brightsky.dev`, for a self-hosted instance) for the next 7 days,
  summarises them per local date, caches each location/zone for an hour, backs off 5 minutes after a failure and
  for Retry-After on 429/503. A failure answers 502 and the web app hides the `.weather-badge`s in the week/day headers.
- Video conference link (#521) — `public/js/conference.js`. Per-user Jitsi base URL
  (`user_preferences.conference_base_url`, `conferenceBaseUrl` in `/api/preferences`; null = off, the default; only
  plain http(s) without credentials, query or fragment, stored without trailing slash). Saving one in the settings asks
  via `confirmDialog`, naming the host. "Videokonferenz hinzufügen" in the event dialog appends a random room
  (`freeshard-` + 20 base32 chars from `crypto.getRandomValues`), with no request anywhere, and writes it as
  `event.conference` → `CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=Videokonferenz` (RFC 7986) plus a line
  `Videokonferenz: <url>` in the description; "Entfernen" drops both. Reading takes the first http(s) CONFERENCE;
  other CONFERENCE entries (tel: dial-ins) are kept on save.
- Address autocomplete and map preview (#512) — `routes/geo.js` + `public/js/geoLookup.js`. Per-user provider
  (`user_preferences.geo_provider`: `off` default, `osm` = Photon, `google` = Places Text Search, offered only with
  `GOOGLE_PLACES_API_KEY`); switching one on in the settings asks via `confirmDialog`, naming the hosts. The browser
  only talks to `/api/geo/search` and `/api/geo/tile/:z/:x/:y`, which answer 403 while the user's provider is `off`
  (nothing leaves the shard). The shard sends `User-Agent: FreeShard-WebCalendar/<version> (+repo)`, allows one lookup
  per second shard-wide (waits up to 3 s, then 429), refuses queries under 3 characters and caches repeats for an hour.
  Tiles: at most 60 upstream fetches per minute shard-wide (then 429), tiles over 256 KiB refused (502) while they
  stream in, fetched tiles cached in memory (200 tiles, 24 h).
  Servers: `GEOCODER_PHOTON_URL` (default photon.komoot.io), `OSM_TILE_URL` (default tile.openstreetmap.org),
  `GOOGLE_PLACES_URL`. A chosen suggestion is saved as LOCATION plus GEO (`event.geo = { lat, lon }`); editing the
  text by hand drops GEO.
- Microsoft 365 (#97) — optional, configured by `MSGRAPH_CLIENT_ID` (+ `MSGRAPH_CLIENT_SECRET` for a confidential
  client) and `BASE_URL`; without them `GET /api/msgraph/accounts` reports `available: false`, the modal says so and
  `/api/msgraph/authorize` answers 503. `server/utils/msgraph.js` + `routes/msgraph.js`: authorization code flow
  with PKCE (S256) at tenant `common`, state mandatory and single-use per session, scopes
  `offline_access User.Read Calendars.ReadWrite` (write for the two-way sync, #613). Microsoft returns cross-site, where a `SameSite=Strict` session
  cookie (`COOKIE_SAME_SITE=strict`; the default is `lax`, #491) would be withheld, so the registered `/api/msgraph/callback` (no auth) only serves a page that forwards
  code/state/error same-site to `/api/msgraph/callback/complete`, which checks the state, stores the tokens
  (re-connecting the same mailbox updates its row and clears `reconnect_required`) and enqueues a sync job. There is no token entry by request
  body. `POST /api/msgraph/accounts/:id/sync` only enqueues a job (202). The only Graph sync path is
  `sync-worker/msgraph_worker.py`, two-way per Microsoft calendar (#613): `GET /me/calendars`; each calendar gets its own opaque,
  VEVENT-only mirror `/<user-uuid>/msgraph-<hex>/` (row in `msgraph_calendar_collections` per account and Graph calendar id,
  created with the provider's name and `hexColor`, relabelled when they change at Microsoft); nothing goes into "Persönlich".
  Per sync: #597's trash restores (queued in `msgraph_restores`) are POSTed first; then per mirror the local changes since the
  last sync are written to Graph (`msgraph_event_mappings.href`/`local_etag`: unmapped item → POST `/me/calendars/<id>/events`,
  changed ETag → PATCH `/me/events/<id>`, mapping without item → DELETE; a series created in the shard and edits in a calendar
  Microsoft marks `canEdit: false` are not written and are named in the job error); then `/me/calendars/<id>/calendarView/delta` (window −365/+730 days,
  fixed per delta round; a round older than 30 days, `delta_started_at`, restarts with a current window; both kept per calendar), pages `@odata.nextLink`, persists only `@odata.deltaLink`, applies `@removed` (the local copy goes to the trash first, #597), sends
  `Prefer: outlook.timezone="UTC"` and rejects any other `timeZone`. Refresh sends `client_id`, `scope` and
  `client_secret` if set; `invalid_grant` sets `msgraph_accounts.reconnect_required` and the job fails with a
  "please reconnect" message, shown in the modal. A failing account does not stop the user's other Microsoft
  accounts or Google pairs; its error is the job's result. Requests time out after 30 s. A per-account lease (`sync_lock_until`, 15 min) keeps syncs of
  one account from overlapping across processes.
- `server/routes/` — `accounts` (CRUD + app-passwords), `calendars` (list/create/patch/delete, user shares, public share links), `events` (range query across accounts, CRUD with ETag conflict handling), `tasks` (`/api/tasks` VTODO CRUD & RFC 5545 task recurrence advancing), `trash` (`/api/trash` #348: every event/task/calendar/task-list delete keeps a copy in `trash_items` first; list, restore under the same href/UID, purge; entries go after 30 days; #597: an item the sync finds deleted at a provider (vdirsyncer pairs: mirror snapshot before `sync`, Graph: `@removed`) is put there with `origin = 'provider'`, and its restore re-creates it at the provider), `msgraph` (`/api/msgraph/*` Microsoft 365 OAuth connection, account list, sync request), `auth` (Generic OIDC login, Back-Channel Logout, Google OAuth2 account linking).
- Calendar IDs everywhere: `<accountId>::<href>`, e.g. `internal-caldav::/<user-uuid>/personal/`.
- `radicale/` — Radicale container with two entry-point plugins reading the shared SQLite DB:
  `radicale_custom_auth` (username→uuid mapping, `SYSTEM_SYNC_SECRET` bypass, app-password check)
  and `radicale_custom_rights` (owner full access, others via `user_calendar_shares` — only reachable once
  shards have an OIDC provider and thus a second user, #121).
- `sync-worker/` — Python daemon polling `sync_queue`: `sync_worker.py` (vdirsyncer Google Calendar ↔ Radicale sync) and `msgraph_worker.py` (Microsoft Graph ↔ Radicale, one mirror per Microsoft calendar, the only Graph sync path). Disconnecting a Microsoft account or deleting one of its mirrors unpairs it; the local copy stays and nothing is deleted at Microsoft (a deleted mirror is mirrored afresh on the next sync). Disconnecting any linked account or a single mirror (#614) records it in `detached_mirrors` and keeps it as a normal calendar; a mapping row pointing at `detached:<collection>` (a single detached calendar, or a re-attach offer awaiting the user) is skipped by both workers.
  Each Google calendar syncs into its own opaque collection `/<user-uuid>/google-<hex>/`, persisted in
  `google_calendar_collections` per (account, Google calendar id). The worker MKCALENDARs it with the Google
  name as `displayname` and a VEVENT-only
  `supported-calendar-component-set`, since Google's CalDAV has no tasks (#495). Radicale itself stores a
  VTODO in any collection, so `routes/tasks.js` PROPFINDs the target's component set and refuses (422) a task
  write into a collection without VTODO; the task dialog offers only VTODO collections, and a changed list
  moves the task (`sourceCalendarId`, create in target then delete source, like event moves #494). A `google-<slug>`
  collection from older worker versions is adopted only if that account's pair has vdirsyncer status for it.
  The create route never puts app calendars under `google-` (#193).
  Discovery reads each Google calendar's `supported-calendar-component-set`; the pair's storages get those
  components as vdirsyncer `item_types`, and on every run the worker PROPPATCHes each restricted mirror to that
  set and names every item outside it ("Nicht synchronisiert: „<title>“: Google nimmt keine Aufgaben an, …")
  in the job's `error_message`. An item Google still refuses (4xx in vdirsyncer's log) is named the same way
  by title; vdirsyncer syncs the pair's other items past it (#572). Every other `error:` line of that run is
  reported next to the refusals as "Sync-Fehler: <pair>: <reason>" (pair taken from the last `Syncing` line if
  the line does not name it), capped at `OTHER_FAILURES_CAP` characters with the cut amount stated (#581). The task dialog shows a stranded task's
  hint in `#task-stranded-hint`.
- Calendar colour and name (#505): every Google and Basic-auth CalDAV pair declares
  `metadata = ["color", "displayname"]` and the worker runs `vdirsyncer metasync` after `sync`. metasync compares
  both sides with its last run (`<status>/<pair>/<collection>.metadata`), so whichever side changed since then wins;
  if both changed, the pair's `conflict_resolution = "b wins"` keeps the shard's value, since every app change
  queues a sync at once and is the newer one. `PATCH /api/calendars/:id` on a calendar the user may write
  PROPPATCHes `displayname`/`apple:calendar-color` into the collection (a refused PROPPATCH fails the request)
  and drops the user's colour override, which would hide colours synced from the provider. On a read-only
  calendar (shared read-only) the colour is only the user's override in `user_calendar_color_overrides` (#4):
  it never reaches Radicale, so it is never pushed. The sidebar offers such calendars a colour-only dialog.
- Collection types (#500): `POST /api/calendars` requires `type` — `calendar` (VEVENT, "Kalender"), `tasklist`
  (VTODO, "Aufgabenliste") or `mixed` (both) — and MKCALENDARs that `supported-calendar-component-set`. A new
  user gets `/personal/` (Kalender) and `/tasks/` (Aufgabenliste). Calendar views and the event/import/booking
  pickers list collections with VEVENT, the Kanban view and task dialog those with VTODO; mixed ones show in both.
  The add dialog defaults to Aufgabenliste in the Kanban view, otherwise to Kalender.
- Sidebar order (#504, `public/js/sidebarOrder.js`): entries move within their group (own calendars, one linked
  account, subscriptions) by a pointer drag (as the Kanban cards; a reload during the drag waits for its end),
  Alt+↑/↓, or "Nach oben"/"Nach unten" in the menu a tap on the entry's grip opens (#573). A touch drags only by
  the grip (44 px on phones, `touch-action: none` there), so the rest of the entry still scrolls; see DESIGN.md. `PUT /api/calendars/order {calendarIds}` stores one group's
  order per user (`user_calendar_order`; subscriptions as `webcal::<id>`); `GET /api/calendars` and
  `GET /api/webcal/subscriptions` return entries in that order, unordered ones last. The user's own CalDAV
  collections also get `apple:calendar-order` (PROPPATCH; a refusal is logged), shared ones never.
- Kanban lanes (#499): one lane per VTODO STATUS (Zu erledigen, In Bearbeitung, Erledigt, Abgebrochen). A card
  changes status by a pointer drag (mouse anywhere on the card, touch on its grip) or its status `<select>`
  (keyboard, phones). The move is drawn at once and redrawn back, marked `.kanban-card-rolled-back`, when the PUT
  fails. Cards of `readOnly` collections and finished occurrences (#264) have no drag and no status controls.
  `reconcileTaskStatus` keeps an explicit CANCELLED and drops its COMPLETED date.
  Basic-auth CalDAV accounts work the same way (#531): the worker PROPFINDs the account's calendar home,
  refuses (job error) any calendar whose name — the unquoted last href segment, which vdirsyncer puts into
  its status path — is outside `[A-Za-z0-9_.-]`, and pairs each remote calendar with `caldav-<hex>`
  persisted in `caldav_calendar_collections`. Never `"from a"`/`"from b"`: local calendars are not
  published to a provider, and vdirsyncer's "create collection?" prompt is never confirmed.
  Outbound guard (#532, Python port of `server/utils/outboundFetch.js` in `sync-worker/outbound_guard.py`):
  every job re-checks each stored account URL (`assert_public_url`, DNS answers included, honouring
  `OUTBOUND_FETCH_ALLOW_HOSTS`, which must match the web app's) and fails with an `error_message` before any
  request. Discovery connects only to the validated addresses; vdirsyncer runs through
  `guarded_vdirsyncer.py`, whose socket guard lets a Basic pair reach only those pinned addresses and the
  local Radicale, so a redirect or DNS change away from the account host fails the run. The Google pair
  may reach public addresses only.
- Event and task templates (#515): `GET /api/templates?kind=event|task`, `POST /api/templates`
  (`{ kind, name, fields }`), `DELETE /api/templates/:id` (`routes/templates.js`, table `item_templates`). A
  template holds the dialog's fields without date, time and recurrence; the route refuses any other field and
  reminders at a fixed time (400). Templates live per user in SQLite only, never in Radicale, so they are not
  synced; `Db.deleteUser` removes them. The dialogs' "Duplizieren" (also in the right-click menu of events and
  tasks, `public/js/contextMenu.js`) only refills the dialog as a new item: nothing is stored, and no attendee
  sees the copy, before "Speichern"; the copy's attendees start at `NEEDS-ACTION`.
- Per-user preferences (#498): `GET`/`PUT /api/preferences` (`routes/preferences.js`, table `user_preferences`)
  hold the task area's view, `taskView` `list` or `kanban` (default `kanban`, anything else 400). It needs only a
  session identity, and `Db.deleteUser` removes the row. The list's sort, priority filter, grouping and "Erledigte
  anzeigen" last only for the page's lifetime.
- Tasks (#518): a subtask is a VTODO whose `RELATED-TO;RELTYPE=PARENT` (or no RELTYPE, as Thunderbird writes it)
  names the parent's UID; the task API carries it as `parentUid` and only ever rewrites that one relation, so
  other RELATED-TO values and foreign properties stay. The task dialog lists a saved task's subtasks as a
  checklist. PRIORITY 1–4 shows as Hoch, 5 Mittel, 6–9 Niedrig (RFC 5545); the app writes 1/5/9 and keeps
  another client's number while its level is unchanged. Open tasks with a due date show in the calendar views
  unless the user turned their list off with the toggle in the task view's sidebar: `PUT /api/preferences`
  `{ taskListInCalendar: { calendarId, shown } }`, read back as `tasksHiddenInCalendar` (table
  `user_tasks_hidden_in_calendar`, cleared by `Db.deleteUser` and `Db.deleteCalendarData`).
  Since #509 they also hold `secondaryTimezone`: the second hour column of the week/day grid, any IANA zone
  (checked by `Intl`, stored under its proper name) or `null` for off (the default). `PUT` takes either field
  alone. The settings drawer searches every zone `Intl.supportedValuesOf('timeZone')` knows
  (`public/js/timezones.js`). The badges show abbreviation and UTC offset at noon of the shown day. Each hour label
  is the second zone's time at that exact instant, so DST changes in either zone land on the right hour.
  Since #517 they also hold `showWeekNumbers` (boolean, default `false`, anything else 400): ISO 8601 week
  numbers ("KW n") in the month grid (in each row's first day), above the week grid's hour axis and as a column
  of the mini month. A row's number is the ISO week of its middle day, so it stays right for any week start.
- Mini month (#517, `renderMiniCalendar` in `public/js/calendar.js`, `renderMiniMonth` in `app.js`): marks
  every day of its month with an event (outside the month view it loads its month itself, cache key
  `minimonth_…`), highlights the main view's range (`.in-range`) and is one tab stop (the selected day):
  arrows move by day/week, Home/End to the row's ends, Page Up/Down by month, Enter/Space jump there. A move
  out of the shown month moves the main view along and keeps focus on the target day.
- CalDAV fan-out (#498): `GET /api/tasks`, `/api/events` and `/api/events/invitations` send one REPORT per
  collection, at most `CALDAV_REPORT_CONCURRENCY` (4, `utils/caldavFanout.js`) at a time per account; sent all
  at once, Radicale drops connections from about 60-100 on and those collections went missing.
- Containers: all three images run their service as uid:gid 1000:1000, because they open the same SQLite
  file. Each image's entrypoint is `drop-privileges.sh` (one copy per build context, kept identical): when
  started as root (the store template sets `user: "0:0"` because shard_core creates the data mount
  root-owned) it chowns the directories in `DATA_DIRS` to 1000:1000 and re-execs itself through `setpriv`;
  started as any other uid it refuses to start if a `DATA_DIRS` entry is not writable (#100).
- `public/` — no-framework SPA: `js/app.js` (boot, views, sidebar, dialogs), `js/calendar.js`
  (month/week/day/agenda grid rendering), `js/listView.js` (the list view, #510: unlike the day-grouped agenda a flat
  table of date, time, title, calendar and location over a chosen range; `GET /api/events` with `limit`/`offset`/`sort`/
  `order`/`q` sorts and filters the whole range on the server and answers one page plus `total`; rows can be selected to
  move them to another calendar or delete them), `js/tasks.js` (VTODO sidebar drawer and the task area: a "Liste | Kanban"
  switch over a sortable, groupable task list or the Kanban board, #498), `js/eventModal.js`, `js/api.js` (fetch wrappers),
  `js/store.js` (pub/sub state), `js/accountModal.js`, `css/app.css`.

## Conventions

- UI language is German; code/comments English.
- Styling: Freeshard "Daylight Instrument" design tokens (CSS custom props in `app.css` §1,
  canonical source `~/knowledge_base/freeshard/ui-style/tokens/`). Light-first, no shadows,
  depth = border + surface tone. Reuse `.btn`, `.modal`, `.fs-label` etc. before inventing new classes.
- No build step, no bundler; plain CommonJS server-side, plain script tags client-side.
- Container base images (#557): every `FROM` pins `<image>:<tag>@sha256:<multi-arch index digest>`
  (`server/test/base_image_digest_pinning.test.js`). Bump with `docker buildx imagetools inspect <image>:<tag>`,
  replace the digest in every `FROM` of that image and in the test's expected list; never use a
  single-platform manifest digest (arm64 shards) and never push an image. Details in README.
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
