# Project Working Memory — WebCalendar Audit & Implementation

## Active Workspace
- Path: `/home/agent-user/Coding/Freeshard/webcalendar`

## Architectural Decisions & Insights
- **Sync Queue Mechanism (`server/db.js` & `sync-worker/sync_worker.py`):**
  - `sync_queue` table tracks vdirsyncer background job scheduling and execution states (`PENDING`, `RUNNING`, `SUCCESS`, `ERROR`).
  - `addSyncJob(userId)` enforces single pending job per user by purging existing `PENDING` records prior to insertion.
  - Enhanced error handling on SQLite statement execution to avoid silent drops.
  - Added helpers: `getSyncJobs`, `getPendingSyncJobs`, `updateSyncJobStatus`.

- **VALARM Trigger & Browser Push Notifications (`server/caldav/parser.js` & `public/js/notifications.js`):**
  - iCalendar parser now extracts `VALARM` subcomponents into `alarms` array on VEVENTs.
  - `eventToICS` serializes `alarms` back into valid `VALARM` RFC 5545 subcomponents.
  - `public/js/notifications.js` provides background trigger checking and Desktop/Browser notifications with UI toast fallbacks.
  - `eventModal.js` supports selecting alarm offset (`ev-alarm`).

- **VTODO / Kanban & Recurrence Support (`server/caldav/parser.js` & `public/js/tasks.js`):**
  - iCalendar parser extracts `VTODO` components into task objects with `uid`, `title`, `description`, `status`, `due`, `priority`, and `recurrence` (`RRULE`).
  - `taskToICS` serializes task state into standard RFC 5545 `VTODO` ICS string.
  - `advanceRecurringTask` calculates the next due date for completed recurring tasks (`FREQ=DAILY`, `WEEKLY`, `MONTHLY`) and resets status to `NEEDS-ACTION`.
  - Express API routes (`/api/tasks`) proxy CalDAV `VTODO` items to frontend `tasks.js`.
  - Side panel drawer and Kanban view (`#kanban-view`) allow filter by status and inline completion.

- **RFC 6578 Sync-Collection Protocol & CTag Caching (`server/caldav/client.js`, `server/caldav/parser.js`, `server/db.js`, `server/routes/calendars.js`):**
  - Added `CalDAVClient.prototype.syncCollection(calendarUrl, syncToken, syncLevel)` generating standard WebDAV `sync-collection` REPORT XML.
  - Implemented `parseSyncCollectionResponse(xml)` extracting `<d:sync-token>`, updated events, deleted resource hrefs (`404 Not Found`), and `invalidSyncToken` precondition status.
  - Automatic RFC 6578 Fallback: `CalDAVClient.prototype.syncCollection` and `POST /api/calendars/:id/delta-sync` catch HTTP 409 (Conflict), HTTP 412 (Precondition Failed), HTTP 403 (Forbidden), HTTP 400 (Bad Request), and XML multistatus `<valid-sync-token/>` precondition errors when `syncToken` is invalid. Automatically resets cached token in DB (`Db.upsertCalendarSyncCache`), falls back to initial full sync (`syncToken = null`), updates SQLite cache with the fresh token, and returns HTTP 200 without wedging delta sync (Issue #68).
  - Added SQLite `calendar_sync_cache` table and Db methods (`getCalendarSyncCache`, `upsertCalendarSyncCache`) for server-side state persistence.
  - Exposed `POST /api/calendars/:id/delta-sync` endpoint for delta retrieval and cache updates.
  - Extended frontend `CalendarsAPI.deltaSync` and `store.js` state store for client-side CTag/syncToken management.

- **Resource & Room Booking System (`server/db.js`, `server/utils/resourceBooking.js`, `server/routes/resources.js`):**
  - SQLite `resources` and `resource_bookings` tables track rooms, equipment, vehicles, and booking occupancy.
  - Overlap collision detection prevents double-booking resources for overlapping time slots (`start_time < endTime AND end_time > startTime`). Returns HTTP 409 Conflict when busy.
  - REST endpoints at `/api/resources` allow CRUD, availability check, room suggestions, and booking cancellation.

- **PDF Print Engine & Vector Export (`server/utils/pdfExport.js`, `server/routes/calendars.js`):**
  - Custom vector PDF 1.4 builder generates structured month and week calendar grids with text, lines, header boxes, and event blocks.
  - REST endpoint `POST /api/calendars/export/pdf` streams attachment downloads.
  - Frontend export action triggered via `#export-pdf-btn`.

- **Multi-Timezone Grid Engine & Secondary Timeline (`server/utils/timezoneGrid.js`, `public/js/calendar.js`):**
  - Backend utility `timezoneGrid.js` provides `SUPPORTED_TIMEZONES`, `getTimezoneOffsetMinutes`, `getTimezoneAbbr`, `formatTimezoneHeader`, and `getDualHourLabel` for standard IANA timezones.
  - Client-side `calendar.js` and `app.js` render dual time zone gutters and dual hour labels (primary/secondary) in week and day views.
  - Settings drawer controls (`#show-secondary-tz-toggle`, `#primary-tz-select`, `#secondary-tz-select`) persist preferences to `localStorage` and `store.js`.

- **Public Availability Slots Booking Engine (`server/db.js`, `server/utils/availabilityBooking.js`, `server/routes/availability.js`, `public/js/availability.js`, `public/booking.html`):**
  - SQLite `availability_pages` and `slot_bookings` tables manage user booking page slugs, duration, working hours, and guest slot bookings.
  - `calculateFreeSlots` utility extracts existing events/bookings and computes available time slots.
  - Public booking page (`/booking.html?slug=...`) allows guests to inspect slots and book appointments, returning 409 Conflict on double-booking.

- **Drive Attachment Link Integration (`server/utils/ical.js`, `public/js/eventModal.js`, `public/js/app.js`):**
  - iCalendar parser extracts `ATTACH` properties into `attachments` array with `url`, `name` (`X-FILENAME`), and `mimeType` (`FMTTYPE`).
  - `eventToICS` serializes `attachments` back into standard RFC 5545 `ATTACH` properties.
  - Modal input fields (`#ev-attachment-url`, `#ev-attachment-name`) capture drive file links; popover renders clickable links with `.attachment-drive-link`.
  - Fixed HTML nesting defect in `public/index.html` where unclosed `#invitations-modal-backdrop` container intercepted click events.

- **Delegate Permissions & Executive Assistant Management (`server/db.js`, `server/utils/delegatePermissions.js`, `server/routes/delegates.js`, `public/js/delegates.js`):**
  - SQLite `delegate_permissions` table stores delegation rules (`principal_user_id`, `delegate_user_id`, `calendar_id`, `role`, `can_manage_invitations`, `can_view_private`, `can_manage_delegates`).
  - Utility `delegatePermissions.js` checks delegation roles, private event visibility, invitation handling permissions, and decorates event payloads with `sentBy` / `onBehalfOf` / `X-DELEGATE-BY` audit metadata.
  - REST endpoints at `/api/delegates` support granting, updating, revoking, listing delegate permissions, and switching active delegation session context (`/api/delegates/act-as`).

- **Working Hours Policy & OOO Auto-Decline Engine (`server/db.js`, `server/utils/workingHoursPolicy.js`, `server/routes/workingHours.js`, `public/js/workingHours.js`, `e2e/calendar.spec.js`):**
  - SQLite `working_hours_policy` table stores configurable work hours (start/end), work days array, auto-decline toggle, OOO status, OOO date range, and custom decline messages.
  - Evaluation helper `evaluateWorkingHoursPolicy` checks date/time ranges against schedule and out-of-office dates, generating automatic rejection responses.
  - Settings drawer UI and REST endpoints (`/api/working-hours`, `/api/working-hours/evaluate`) allow users to save and test rules.

- **Calendar Access Control & Read/Write Auth Enforcement (`server/utils/calendarAuth.js`, `server/routes/calendars.js`, `server/routes/events.js`, `server/routes/tasks.js`):**
  - Added authorization gates (`checkCalendarAccess`) to `POST /api/calendars/:id/import/detect` (`write`), `POST /api/calendars/:id/import` (`write`), and legacy public link endpoints `GET/POST/DELETE /api/calendars/:id/public-link` (`owner`).
  - Added test suite `server/test/calendar_ownership_session.test.js` covering unauthenticated requests and foreign calendar access restrictions (Issue #51).

- **OIDC Back-Channel Logout 1.0 & JWT Validation (`server/utils/oidcClient.js`, `server/utils/oidcLogout.js`, `server/routes/auth.js`, `server/test/oidc_backchannel_logout.test.js`):**
  - Created `server/utils/oidcClient.js` to handle OIDC issuer discovery cleanly without circular dependencies.
  - Implemented `verifyLogoutToken` in `server/utils/oidcLogout.js` using `jose` for verifying symmetric (`HS256`/`HS384`/`HS512`) and asymmetric (`RS256`/JWKS) JWT logout tokens.
  - Enforced OpenID Connect Back-Channel Logout 1.0 Spec rules: prohibited `nonce` claim, validated `http://schemas.openid.net/event/backchannel-logout` in `events` claim, and required `sub` or `sid`.
  - Added HTTP endpoint `POST /api/auth/backchannel-logout` (and `/backchannel_logout`) in `server/routes/auth.js` to revoke sessions for specific `sid` or user `sub` with `Cache-Control: no-store` and `Pragma: no-cache` headers.
  - Unit and integration test suite: `server/test/oidc_backchannel_logout.test.js` (10 tests, 100% green).

- **CalDAV Fetch Error Channel & Status Enforcement (`server/routes/calendars.js`, `server/routes/events.js`, `server/routes/tasks.js`, `server/test/caldav_fetch_error_channel.test.js`):**
  - Captured CalDAV fetch errors across calendar, event, and task GET routes and exposed `X-CalDAV-Error` response header.
  - Enforced `HTTP 502 Bad Gateway` status on `GET /api/events` and `GET /api/tasks` when querying failing calendars or when all active CalDAV accounts fail (Issue #65).

- **UTF-8 Octet-Aware Line Folding (`server/utils/ical.js`, `server/caldav/parser.js`, `server/test/fold_lines_utf8.test.js`):**
  - Replaced naive string character length checks with UTF-8 byte length checks (`Buffer.byteLength(line, 'utf8') <= 75`).
  - Iterated string content by Unicode code points to prevent splitting 4-byte emoji surrogate pairs across fold boundaries or corrupting characters to `U+FFFD` (Issue #66).

- **Production Mounting Guard for `/mock-dav*` Test Endpoint (`server/index.js`, `server/caldav/client.js`, `server/test/mock_dav_production_guard.test.js`):**
  - Wrapped mock CalDAV route registration in `server/index.js` behind environment check (`process.env.NODE_ENV === 'test' || process.env.ENABLE_MOCK_DAV === 'true'`).
  - Added missing `escapeXML` helper function to `server/caldav/client.js`.
  - Added test suite `server/test/mock_dav_production_guard.test.js` (4 tests, 100% green).

- **Credential-at-Rest Gaps Security Fix (`server/db.js`, `radicale/radicale_custom_auth.py`, `sync-worker/sync_worker.py`, `sync-worker/msgraph_worker.py`, `server/test/credential_at_rest_gaps.test.js`):**
  - Encrypted MS Graph access/refresh tokens in SQLite using AES-256-CBC with scrypt key derivation.
  - Replaced unsalted SHA-256 app passwords with PBKDF2-HMAC-SHA256 (`salt:hash`, 100k iterations) in `server/db.js` and `radicale/radicale_custom_auth.py`.
  - Added support for custom `ENCRYPTION_SALT` environment configuration.


## Test Execution State
- Node Unit & Integration Suite: 551 PASSED, 0 skipped (100% green)
- Playwright E2E Suite: 17 PASSED, 1 skipped (100% green)

## Completed Tasks
- [x] Task 1: Onboarding & CalDAV Auto-Provisioning Flow
- [x] Task 2: Event CRUD & Popover Dialog Interactions
- [x] Task 3: Responsive Toolbar & Mobile Viewport Navigation
- [x] Task 4: Calendar Sharing, User Autocomplete & Permission Management
- [x] Task 5: Public Share Links & ICS Export Engine
- [x] Task 6: Sync Queue Worker & Error Resilience (vdirsyncer Daemon)
- [x] Task 7: Comprehensive Code & Security Anonymization Audit
- [x] Issue #37: [VALARM-PUSH] Browser-Push & Desktop-Erinnerungen für VEVENT VALARM-Trigger
- [x] Issue #38: [VTODO-KANBAN] VTODO-Unterstützung mit Aufgaben-Seitenleiste & Wiederholungslogik (RRULE)
- [x] Issue #39: [ITIP-RSVP] Einladungs-Posteingang & Zu-/Absage-Status (PARTSTAT)
- [x] Issue #40: [CTAG-DELTA-SYNC] RFC 6578 sync-collection Protocol & CTag Caching
- [x] Issue #41: [MS-GRAPH-CALENDAR] Bidirektionaler Sync-Worker für Microsoft Outlook / Office 365
- [x] Issue #42: [ICS-CONFLICT-RESOLVER] Konflikt- & Duplikat-Auflösungs-Dialog bei ICS-Import
- [x] Issue #43: [ROOM-RESOURCE-BOOKING] Ressourcen- & Raum-Buchungssystem mit Belegungs-Prüfung
- [x] Issue #44: [PDF-PRINT-ENGINE] Vektorbasierter PDF-Export & Druck-Optimierung für Monats-/Wochenansicht
- [x] Issue #45: [MULTI-TIMEZONE-GRID] Zeitzonen-Dual-Grid & Sekundäre Zeitleiste
- [x] Issue #46: [AVAILABILITY-SLOTS-BOOKING] Öffentliche Termin-Buchungsseite für freie Zeitslots
- [x] Issue #47: [ATTACHMENT-DRIVE-LINK] Integration von Dateianhängen über die FreeShard Files App
- [x] Issue #48: [DELEGATE-PERMISSIONS] Stellvertretende Kalenderverwaltung & Executive Assistant Berechtigungen
- [x] Issue #49: [WORKING-HOURS-POLICY] Einstellbare Arbeitszeiten & Automatische Absage bei Abwesenheit
- **Calendar Ownership & Session Authentication Verification (`server/index.js`, `server/routes/calendars.js`, `server/routes/events.js`, `server/routes/tasks.js`, `server/test/calendar_ownership_session.test.js`):**
  - Enforced strict session authentication checks (`401 Unauthorized`) across `GET/POST /api/calendars`, `GET /api/events`, `GET /api/events/invitations`, and `GET /api/tasks`.
  - Added authorization gates (`checkCalendarAccess`) to `POST /api/calendars/:id/import/detect` (`write`), `POST /api/calendars/:id/import` (`write`), and legacy public link endpoints `GET/POST/DELETE /api/calendars/:id/public-link` (`owner`).
  - Added test suite `server/test/calendar_ownership_session.test.js` covering unauthenticated requests and foreign calendar access restrictions (Issue #51).

## Test Execution State
- Node Unit & Integration Suite: 125 PASSED, 7 skipped (100% green)

## Completed Tasks
- [x] Task 1: Onboarding & CalDAV Auto-Provisioning Flow
- [x] Task 2: Event CRUD & Popover Dialog Interactions
- [x] Task 3: Responsive Toolbar & Mobile Viewport Navigation
- [x] Task 4: Calendar Sharing, User Autocomplete & Permission Management
- [x] Task 5: Public Share Links & ICS Export Engine
- [x] Task 6: Sync Queue Worker & Error Resilience (vdirsyncer Daemon)
- [x] Task 7: Comprehensive Code & Security Anonymization Audit
- [x] Issue #37: [VALARM-PUSH] Browser-Push & Desktop-Erinnerungen für VEVENT VALARM-Trigger
- [x] Issue #38: [VTODO-KANBAN] VTODO-Unterstützung mit Aufgaben-Seitenleiste & Wiederholungslogik (RRULE)
- [x] Issue #39: [ITIP-RSVP] Einladungs-Posteingang & Zu-/Absage-Status (PARTSTAT)
- [x] Issue #40: [CTAG-DELTA-SYNC] RFC 6578 sync-collection Protocol & CTag Caching
- [x] Issue #41: [MS-GRAPH-CALENDAR] Bidirektionaler Sync-Worker für Microsoft Outlook / Office 365
- [x] Issue #42: [ICS-CONFLICT-RESOLVER] Konflikt- & Duplikat-Auflösungs-Dialog bei ICS-Import
- [x] Issue #43: [ROOM-RESOURCE-BOOKING] Ressourcen- & Raum-Buchungssystem mit Belegungs-Prüfung
- [x] Issue #44: [PDF-PRINT-ENGINE] Vektorbasierter PDF-Export & Druck-Optimierung für Monats-/Wochenansicht
- [x] Issue #45: [MULTI-TIMEZONE-GRID] Zeitzonen-Dual-Grid & Sekundäre Zeitleiste
- [x] Issue #46: [AVAILABILITY-SLOTS-BOOKING] Öffentliche Termin-Buchungsseite für freie Zeitslots
- [x] Issue #47: [ATTACHMENT-DRIVE-LINK] Integration von Dateianhängen über die FreeShard Files App
- [x] Issue #48: [DELEGATE-PERMISSIONS] Stellvertretende Kalenderverwaltung & Executive Assistant Berechtigungen
- [x] Issue #49: [WORKING-HOURS-POLICY] Einstellbare Arbeitszeiten & Automatische Absage bei Abwesenheit
- [x] Issue #50: Unauthentifizierten Zugriff auf fremde Kalender schließen (Read/Write Auth Enforcement)
- [x] Issue #51: Calendar Ownership & Session Authentication Verification
- **Strict ACL Enforcement on Calendar, Event & Task Routes (`server/routes/calendars.js`, `server/routes/events.js`, `server/routes/tasks.js`, `server/utils/calendarAuth.js`, `server/test/strict_acl_enforcement.test.js`):**
  - Added strict authorization checks across search, PDF export, event CRUD, RSVP, and task endpoints (Issue #56).
  - Derived calendar ID from resource href parameters to block cross-calendar spoofing attacks.
- **Public Share Link Handlers Session Identity & Ownership Check (`server/routes/calendars.js`, `server/db.js`, `server/test/public_share_acl.test.js`):**
  - Enforced `checkCalendarAccess` (`owner`) and session auth (`401`) on `GET/POST/DELETE /api/calendars/:id/shares-public` (Issue #234).
  - Updated `Db.deleteCalendarShare(token, calendarId)` to strictly enforce token existence and calendar-level scoping, returning `404 Not Found` for unowned/mismatched share tokens.

## Test Execution State
- Node Unit & Integration Suite: 147 PASSED, 7 skipped (100% green)

- **VTIMEZONE Registration & Cumulative Timezone Drift Fix (`server/utils/ical.js`, `server/test/vtimezone.test.js`):**
  - Implemented `buildVTimezoneBlock(tzid)` generating RFC 5545 compliant `BEGIN:VTIMEZONE` blocks with `STANDARD` and `DAYLIGHT` sub-components derived from `Intl.DateTimeFormat`.
  - Embedded VTIMEZONE blocks before VEVENT components in `eventToICS` when `startTimeZone` / `endTimeZone` are present.
  - Registered VTIMEZONE definitions with `ICAL.TimezoneService` during parsing to resolve TZID-qualified timestamps without UTC drift (Issue #52).
- **No-Op Save Series Protection (`server/utils/ical.js`, `server/test/noop_save.test.js`):**
  - Exported `isNoOpEventSave(existingIcs, incomingEventData)` comparing title, start, end, allDay, description, location, recurrence rules, attendees, and alarms.
  - Safe-default fallback returns `false` if existing ICS is missing or unparseable (Issue #79).
- **Series Destruction & Recurrence Rule Preservation on No-Op Event Saves (`server/routes/events.js`, `server/caldav/parser.js`, `server/test/series_destruction_noop.test.js`):**
  - Exported `isNoOpEventSave` from `server/caldav/parser.js`.
- **Whole-Series Save EXDATE and Detached Override Preservation (`server/utils/ical.js`, `server/caldav/parser.js`, `server/routes/events.js`, `server/test/whole_series_preservation.test.js`):**
  - Exported `updateWholeSeries(existingIcs, eventData)` in `server/utils/ical.js` and `server/caldav/parser.js`.
  - Replaced naive `eventToICS` call in `PUT /api/events/:uid` with `updateWholeSeries(current ? current.ics : null, event)`.
  - **No-Op Whole-Series Save Detached Override Scope Isolation (`server/utils/ical.js`, `server/routes/events.js`, `server/caldav/parser.js`, `server/test/noop_detached_override_scope.test.js`):**
  - Enhanced `parseICSToEvent(icsString, meta)` to filter VEVENT components by `recurrenceId` when specified, or isolate master `VEVENT` (without `RECURRENCE-ID`) when omitted, even if detached override subcomponents are ordered first in raw ICS.
  - Enhanced `isNoOpEventSave(existingIcs, incomingEventData, recurrenceId = null)` to support targeting specific occurrence overrides or master series. Returns `false` when an occurrence save targets a non-existent override.
  - Updated `PUT /api/events/:uid` to evaluate `isNoOpEventSave(current.ics, eventData, recurrenceId)` for single-occurrence edits (`scope === 'occurrence'`) to avoid redundant CalDAV PUT requests. (Issue #242).

## Test Execution State
- Node Unit & Integration Suite: 193 PASSED, 7 skipped (100% green)
- Playwright E2E Suite: 18 PASSED 100% green

## Completed Tasks
- [x] Task 1: Onboarding & CalDAV Auto-Provisioning Flow
- [x] Task 2: Event CRUD & Popover Dialog Interactions
- [x] Task 3: Responsive Toolbar & Mobile Viewport Navigation
- [x] Task 4: Calendar Sharing, User Autocomplete & Permission Management
- [x] Task 5: Public Share Links & ICS Export Engine
- [x] Task 6: Sync Queue Worker & Error Resilience (vdirsyncer Daemon)
- [x] Task 7: Comprehensive Code & Security Anonymization Audit
- [x] Issue #37: [VALARM-PUSH] Browser-Push & Desktop-Erinnerungen für VEVENT VALARM-Trigger
- [x] Issue #38: [VTODO-KANBAN] VTODO-Unterstützung mit Aufgaben-Seitenleiste & Wiederholungslogik (RRULE)
- [x] Issue #39: [ITIP-RSVP] Einladungs-Posteingang & Zu-/Absage-Status (PARTSTAT)
- [x] Issue #40: [CTAG-DELTA-SYNC] RFC 6578 sync-collection Protocol & CTag Caching
- [x] Issue #41: [MS-GRAPH-CALENDAR] Bidirektionaler Sync-Worker für Microsoft Outlook / Office 365
- [x] Issue #42: [ICS-CONFLICT-RESOLVER] Konflikt- & Duplikat-Auflösungs-Dialog bei ICS-Import
- [x] Issue #43: [ROOM-RESOURCE-BOOKING] Ressourcen- & Raum-Buchungssystem mit Belegungs-Prüfung
- [x] Issue #44: [PDF-PRINT-ENGINE] Vektorbasierter PDF-Export & Druck-Optimierung für Monats-/Wochenansicht
- [x] Issue #45: [MULTI-TIMEZONE-GRID] Zeitzonen-Dual-Grid & Sekundäre Zeitleiste
- [x] Issue #46: [AVAILABILITY-SLOTS-BOOKING] Öffentliche Termin-Buchungsseite für freie Zeitslots
- [x] Issue #47: [ATTACHMENT-DRIVE-LINK] Integration von Dateianhängen über die FreeShard Files App
- [x] Issue #48: [DELEGATE-PERMISSIONS] Stellvertretende Kalenderverwaltung & Executive Assistant Berechtigungen
- [x] Issue #49: [WORKING-HOURS-POLICY] Einstellbare Arbeitszeiten & Automatische Absage bei Abwesenheit
- [x] Issue #50: Unauthentifizierten Zugriff auf fremde Kalender schließen (Read/Write Auth Enforcement)
- [x] Issue #51: Calendar Ownership & Session Authentication Verification
- [x] Issue #56: Strict ACL Enforcement on Calendar & Event Routes
- [x] Issue #234: Public Share Link Handlers (`shares-public`) Session Identity & Ownership Check
- [x] Issue #52: VTIMEZONE Registration & Cumulative Timezone Drift Fix
- [x] Issue #79: No-Op Save Series Protection
- [x] Issue #53: Series Destruction & Recurrence Rule Preservation on No-Op Event Saves
- [x] Issue #241: Whole-Series Save EXDATE and Detached Override Preservation
- [x] Issue #242: No-Op Whole-Series Save Detached Override Scope Isolation
- **VTODO Foreign Property Loss Prevention (`server/caldav/parser.js`, `server/routes/tasks.js`, `server/test/vtodo_foreign_properties.test.js`):**
  - Updated `parseICSToTask` and `parseVTodoToTask` in `server/caldav/parser.js` to preserve `rawIcs` on parsed task objects.
  - Enhanced `taskToICS(task, existingIcs)` to modify existing VTODO components in-place via ical.js when `existingIcs` (or `task.rawIcs`) is present, preserving all foreign properties (e.g. `CATEGORIES`, `LOCATION`, `ORGANIZER`, `ATTENDEE`, `VALARM`, `X-*`, `PRODID`).
  - Updated `PUT /api/tasks/:uid` in `server/routes/tasks.js` to fetch existing task content via `client.get` and pass it to `taskToICS`.
  - Added regression test suite `server/test/vtodo_foreign_properties.test.js` (Issue #260).

## Test Execution State
- Node Unit & Integration Suite: 220 PASSED, 7 skipped (100% green)
- Playwright E2E Suite: 17 PASSED, 1 skipped (100% green)

## Completed Tasks
- [x] Tasks 1–7 and Backlog Issues #37–#53, #56, #234, #241, #242, #258, #260, #324 completed 100% green.

- **Docker Quick Start & Compose Environment Fixes (`docker-compose.yml`, `radicale/Dockerfile`, `radicale/entrypoint.sh`, `sync-worker/sync_worker.py`, `Dockerfile`, `.dockerignore`, `server/test/docker_compose_environment.test.js`):**
  - Updated `docker-compose.yml` to use `shared-data` volume across `webcalendar`, `caldav-server`, and `sync-worker` services, fixing host bind mount permissions (`EACCES`) for `USER node`.
  - Added `env_file: - .env` to `caldav-server` in `docker-compose.yml`.
  - Created `radicale/entrypoint.sh` with automatic fallback self-signed SSL certificate generation (`openssl req`) when `/etc/radicale/ssl/cert.pem` / `key.pem` are missing on host. Updated `radicale/Dockerfile` to install `openssl` and run `entrypoint.sh`.
  - Aligned `sync-worker/sync_worker.py` default `ENCRYPTION_SECRET` fallback with `server/db.js` (`freeshard-default-encryption-key-do-not-use-in-prod`).
  - Added `verify = false` fallback in `sync_worker.py` for local HTTPS Radicale when certificate fingerprint is missing.
  - Updated `Dockerfile` healthcheck order and added runtime data/db patterns (`data/`, `webcalendar.db*`, `ssl/`) to `.dockerignore`.
  - Added test suite `server/test/docker_compose_environment.test.js` (6 tests, Issue #259).

- **App & Sync-Worker Encryption Key Alignment (`server/db.js`, `sync-worker/sync_worker.py`, `docker-compose.yml`, `server/test/encryption_key_alignment.test.js`):**
  - Updated `server/db.js` to inspect both `process.env.ENCRYPTION_KEY` and `process.env.ENCRYPTION_SECRET` before falling back to `'freeshard-default-encryption-key-do-not-use-in-prod'`.
  - Updated `sync-worker/sync_worker.py` to inspect both `os.environ.get("ENCRYPTION_KEY")` and `os.environ.get("ENCRYPTION_SECRET")` before falling back.
  - Aligned `docker-compose.yml` `webcalendar` service environment to export `ENCRYPTION_KEY: ${ENCRYPTION_KEY:-${ENCRYPTION_SECRET:-freeshard-default-encryption-key-do-not-use-in-prod}}`, matching `sync-worker`.
  - Added test suite `server/test/encryption_key_alignment.test.js` verifying fallback order, compose configuration, and Node/Python AES-256-CBC scrypt key derivation cross-decryption (Issue #322).

- **iCalendar Property Escaping & ATTENDEE Injection Guard (`server/utils/ical.js`, `server/caldav/parser.js`, `server/test/ical_property_escaping.test.js`):**
  - Exported `escParamVal(str)` in `server/utils/ical.js` stripping double-quotes (`"`) and newlines (`\r`/`\n`) to prevent parameter breakout in quoted parameter strings (e.g. `;CN="..."`, `;X-FILENAME="..."`, `;PARTSTAT=...`, `;FMTTYPE=...`).
  - Updated `escIcal(str)` and all property value formatters in `eventToICS` and `buildItipReply` to strip or escape newlines across `STATUS`, `UID`, `ORGANIZER`, `ATTENDEE`, `RRULE`, `VALARM`, and `ATTACH` properties, blocking header/property injection attacks.
  - Added test suite `server/test/ical_property_escaping.test.js` verifying parameter breakout protection and header injection prevention across event/iTIP reply payloads (Issue #314).

- **Local Color Customization for Subscribed/Shared Calendars (`server/db.js`, `server/routes/calendars.js`, `server/test/local_calendar_color.test.js`):**
  - Created SQLite table `user_calendar_color_overrides` with primary key `(user_id, calendar_id)` and added DB helpers (`setUserCalendarColorOverride`, `getUserCalendarColorOverrides`, `getUserCalendarColorOverride`, `deleteUserCalendarColorOverride`).
  - Updated `PATCH /api/calendars/:id` in `server/routes/calendars.js` to allow setting local color overrides for users with `read` access, while enforcing `write` access for renaming `name`.
  - Updated `GET /api/calendars` to apply per-user local color overrides to all returned calendars for `req.session.userId`.
  - Added endpoint `DELETE /api/calendars/:id/color-override` to clear per-user local color overrides.
  - Added test suite `server/test/local_calendar_color.test.js` (Issue #4).

- **Conflict Resolution for Concurrent Modifications (Two-Way Sync) (`server/utils/twoWaySyncResolver.js`, `server/db.js`, `server/routes/calendars.js`, `sync-worker/sync_worker.py`, `server/test/two_way_sync_conflict.test.js`):**
  - Created `server/utils/twoWaySyncResolver.js` exporting `detectTwoWayConflict(localIcs, remoteIcs)` to detect divergent property changes and `resolveTwoWayConflict(localIcs, remoteIcs, strategy)` supporting `LOCAL_WINS`, `REMOTE_WINS`, `LAST_MODIFIED_WINS`, and `MERGE_PROPERTIES`.
  - Added SQLite `sync_conflicts` table and DB helper functions (`addSyncConflict`, `getPendingSyncConflicts`, `resolveSyncConflict`) in `server/db.js`.
  - Added REST endpoints `GET /api/calendars/:id/sync/conflicts` and `POST /api/calendars/:id/sync/resolve-conflict` in `server/routes/calendars.js` to inspect and resolve two-way sync conflicts.
  - Updated `sync-worker/sync_worker.py` vdirsyncer pair generator to set `conflict_resolution = "b wins"` to prevent stranded background sync jobs on concurrent edits.
  - Added regression test suite `server/test/two_way_sync_conflict.test.js` (Issue #5).

- **Automatic Retry Queue for Synchronization Failures (`server/utils/syncRetryQueue.js`, `server/db.js`, `server/routes/calendars.js`, `sync-worker/sync_worker.py`, `server/test/sync_retry_queue.test.js`):**
  - Updated SQLite `sync_queue` table schema with `attempts` (default 0), `max_attempts` (default 3), `next_retry_at` timestamp, and `retry_state` (`IDLE`, `RETRY_PENDING`, `MAX_RETRIES_EXCEEDED`).
  - Created `server/utils/syncRetryQueue.js` implementing exponential backoff calculation (`calculateBackoff`), retry scheduling (`scheduleSyncFailure`), due job retrieval (`getDueSyncJobs`), retry resetting (`resetSyncJobRetries`), and status formatting (`getSyncQueueStatus`).
  - Added REST endpoints `GET /api/calendars/sync-queue/status` and `POST /api/calendars/sync-queue/retry` for inspecting sync retry queue state and manually re-triggering failed sync retries.
  - Updated `sync-worker/sync_worker.py` daemon loop to evaluate `next_retry_at` timestamp threshold and handle failure auto-retries with exponential backoff.
  - Added test suite `server/test/sync_retry_queue.test.js` (10 tests, Issue #6).

- **Issue #7 — OAuth Token Expiry Warning Banner (`server/routes/accounts.js`, `server/db.js`, `server/test/oauth_token_warning.test.js`):**
  - Route `GET /api/accounts/oauth-token-status` already existed in `accounts.js:115`. No new production code needed.
  - `Db.getOAuthTokenStatus(userId)` already existed in `db.js:421`, correctly computing `expired: true` when `expiresAt` is null or within 60 s grace window.
  - Test file was broken: used `supertest` + mocha-style `describe/it` — neither installed. Rewrote using `node:test` + `fetch` + port 3106, matching suite conventions. 9 tests, all green.

- **Issue #8 — Public ICS Subscription Caching & Rate-Limiting (`server/db.js`, `server/utils/icsPublicShareCache.js`, `server/routes/calendars.js`, `server/test/public_ics_cache_ratelimit.test.js`):**
  - SQLite `public_ics_cache` table stores cached ICS bodies with `expires_at` timestamps; `getIcsCache(token)` returns null when expired or missing; `upsertIcsCache(token, body, ttlSeconds)` inserts/replaces.
  - SQLite `ics_fetch_log` table records every fetch hit with `fetched_at`; `getIcsFetchCount(token, windowSeconds)` counts hits within a sliding window.
  - `recordIcsFetch(token)` appended for both cache-hit and cache-miss paths in `GET /api/public/calendars/share/:token.ics`.
  - Route logic: rate-limit gate (429 + `Retry-After` header) runs before any DB share lookup; cache-first serve with `X-Cache: HIT/MISS` header.
  - Config constants (`ICS_CACHE_TTL_SECONDS=300`, `ICS_RATE_LIMIT_MAX=60`, `ICS_RATE_LIMIT_WINDOW_SECONDS=3600`) env-overridable via `server/utils/icsPublicShareCache.js`.
  - 9-test suite all green (Issue #8).

- **Issue #9 — Background Replication & Sync for External CalDAV Servers (Basic Auth) (`server/routes/accounts.js`, `sync-worker/sync_worker.py`, `server/test/external_caldav_basic_sync.test.js`):**
  - Updated `POST /api/accounts` to automatically enqueue a `PENDING` sync job via `Db.addSyncJob(userId)` upon account creation so replication begins immediately.
  - Added REST endpoint `POST /api/accounts/:id/sync` to allow users to trigger background sync for linked CalDAV accounts with authentication (`401`) and ownership verification (`404`).
  - `sync_basic_caldav_accounts` in `sync_worker.py` builds vdirsyncer INI pairs for basic-auth accounts (`auth_type = 'basic'`), decrypts passwords, executes discovery and sync, and cleans up temporary config files.
  - Added test suite `server/test/external_caldav_basic_sync.test.js` (6 tests, 100% green).

- **Issue #11 / Issue #30 — CalDAV Provider Autoconfiguration Presets (`server/utils/caldavPresets.js`, `server/routes/accounts.js`, `public/js/api.js`, `public/js/accountModal.js`, `public/index.html`, `server/test/caldav_provider_presets.test.js`):**
  - Created `server/utils/caldavPresets.js` providing presets for GMX (`gmx.de`, `gmx.net`...), WEB.DE (`web.de`), mailbox.org (`mailbox.org`), and Posteo (`posteo.de`...) with `getPresets()`, `resolvePreset(emailOrPresetId)`, and `resolveCalDAVUrl(input)`.
  - Added REST endpoint `GET /api/accounts/presets` to expose available presets and resolve query parameters (`?email=...` / `?preset=...`).
  - Updated `POST /api/accounts` to automatically resolve CalDAV URLs when provider preset IDs or domain email addresses are provided.
  - Added provider selection `<select id="acc-provider">` to `#account-form` in `public/index.html` and integrated auto-detection on email entry in `public/js/accountModal.js`.
  - Added test suite `server/test/caldav_provider_presets.test.js` (6 tests, 100% green).

- **Issue #14 — Support Smart Quick-Add via Natural Language Parsing (NLP) (`server/utils/nlpQuickAdd.js`, `server/routes/quickAdd.js`, `server/index.js`, `server/test/nlp_quick_add.test.js`):**
  - Created `server/utils/nlpQuickAdd.js` exporting `parseQuickAdd(inputText, referenceDate)` to extract event/task title, type (`event` vs `task`), relative/explicit dates (`tomorrow`, `übermorgen`, `next Friday`, `YYYY-MM-DD`, `DD.MM.YYYY`), time ranges (`10:00 to 12:30`, `3pm`), locations (`at Room A`, `im Restaurant`), and RRULE recurrence (`every Monday`, `jeden Tag`).
  - Handled non-ASCII boundary matching (e.g. `übermorgen`) and specific-before-generic recurrence rule ordering.
  - Added REST endpoint `POST /api/quick-add/parse` requiring session authentication (`401` when unauthenticated).
  - Mounted `/api/quick-add` router in `server/index.js`.
  - Added unit and REST API test suite `server/test/nlp_quick_add.test.js` (16 tests, 100% green).

- **Issue #16 — Implement Participant Availability (Free/Busy) Scheduler (`server/utils/freebusyScheduler.js`, `server/routes/freebusy.js`, `server/index.js`, `server/test/freebusy_scheduler.test.js`):**
  - Created `server/utils/freebusyScheduler.js` implementing `isEventBusyInWindow`, `queryParticipantAvailability`, `findCommonFreeSlots`, `buildVFreeBusy`, `parseVFreeBusy`, and `formatICalDate`.
  - Created `server/routes/freebusy.js` exposing endpoints `POST /api/freebusy/query`, `POST /api/freebusy/find-slots`, and `GET /api/freebusy/vfreebusy`.
  - Enforced authentication gate (`requireAuth`) returning 401 for unauthenticated API access.
  - Added unit and REST API test suite `server/test/freebusy_scheduler.test.js` (10 tests, 100% green).

- **Issue #18 — Event Categorization and Tags (iCalendar CATEGORIES) (`server/utils/ical.js`, `server/caldav/parser.js`, `server/routes/events.js`, `server/routes/tasks.js`, `public/index.html`, `public/js/eventModal.js`, `server/test/event_categories.test.js`):**
  - Updated `parseVEventToEvent` and `parseVTodoToTask` to extract RFC 5545 `CATEGORIES` properties into `categories: string[]`.
  - Updated `eventToICS` and `taskToICS` to serialize categories into standard `CATEGORIES:tag1,tag2` strings.
  - Updated `isNoOpEventSave` to compare normalized category sets to prevent spurious saves or missed category edits.
  - Updated REST endpoints `GET /api/events` and `GET /api/tasks` to support filtering by `category` or `tag` query parameters.
  - Added `#ev-categories` input field to event modal in `public/index.html` and wired population/submission in `public/js/eventModal.js`.
  - Added unit & integration test suite `server/test/event_categories.test.js` (8 tests, 100% green).

- **Issue #19 — Support Working Hours Configuration and Grid Shading (`server/utils/workingHoursPolicy.js`, `public/js/store.js`, `public/js/workingHours.js`, `public/js/calendar.js`, `public/css/app.css`, `server/test/working_hours_grid.test.js`):**
  - Exported `isHourInWorkingHours(date, hour, policy)` helper in `server/utils/workingHoursPolicy.js` to evaluate whether a specific hour falls within user working hours and work days.
  - Added initial `workingHours` state to `store.js` and wired store updates upon loading/saving policy in `public/js/workingHours.js`.
  - Updated `createTimeCol` in `public/js/calendar.js` to tag non-workday columns with `non-working-day` and non-work-hour slot click areas with `non-working-hour`.
  - Added theme-aware grid shading CSS rules in `public/css/app.css` (`.time-slot-click-area.non-working-hour`, `.week-day-col.non-working-day`).
  - Added unit test suite `server/test/working_hours_grid.test.js` (4 tests, 100% green).

- **Issue #20 — Keyboard Shortcuts Engine for Power-User Navigation (`public/js/shortcuts.js`, `public/js/app.js`, `public/index.html`, `public/css/app.css`, `server/test/keyboard_shortcuts.test.js`):**
  - Created `public/js/shortcuts.js` module exporting `parseShortcutAction(eventPayload, isModalOpen)` and `getShortcutHelpList()`.
  - Implemented view switching shortcuts (`m`/`1` -> Month, `w`/`2` -> Week, `d`/`3` -> Day, `a`/`4` -> Agenda, `k`/`5` -> Kanban), navigation shortcuts (`t` -> Today, `j`/`ArrowRight` -> Next, `p`/`ArrowLeft` -> Prev), event creation (`n`/`c`), search focus (`/`/`s`), help toggle (`?`/`h`), and dialog closing (`Escape`).
  - Enforced input element protection (Issue #126: ignoring shortcuts when typing in `INPUT`, `TEXTAREA`, `SELECT`, `BUTTON`, or `[contenteditable]`, or when modifier keys `Ctrl`, `Alt`, `Meta` are active, or when modal backdrops are active).
  - Added Keyboard Shortcuts help modal (`#shortcuts-modal-backdrop`) and CSS styling (`.shortcut-row`, `.shortcut-badge`).
  - Added unit test suite `server/test/keyboard_shortcuts.test.js` (8 tests, 100% green).

- **Issue #26 — Implement PWA Support and Offline Mode with Local Caching (`public/manifest.json`, `public/sw.js`, `public/js/offlineCache.js`, `public/index.html`, `public/js/app.js`, `public/js/api.js`, `server/test/pwa_offline.test.js`):**
  - Created Web App Manifest (`public/manifest.json`) defining `standalone` display mode, theme colors, and icons.
  - Implemented Service Worker (`public/sw.js`) with cache management (`webcalendar-v1`), pre-caching core app shell assets, stale-while-revalidate for static assets, and network-first with cache fallback for API routes.
  - Created client-side `public/js/offlineCache.js` module for local storage persistence (`saveCalendars`, `getCalendars`, `saveEvents`, `getEvents`, `saveTasks`, `getTasks`, `isOffline`, `setOfflineStatus`) and offline banner updates (`#offline-status-banner`).
  - Integrated `OfflineCache` fallbacks into `CalendarsAPI.list`, `EventsAPI.list`, and `TasksAPI.list` in `public/js/api.js`.
  - Added unit test suite `server/test/pwa_offline.test.js` (4 tests, 100% green).

## Test Execution State
- Node Unit & Integration Suite: 431 tests PASSED, 7 skipped (100% green)
- Last Verified: 2026-08-24T19:23:10+02:00

## Completed Tasks
- [x] Tasks 1–7 and Backlog Issues #2, #3, #4, #5, #6, #7, #8, #9, #10, #11, #12, #13, #14, #16, #17, #18, #19, #20, #22, #23, #24, #25, #26, #30, #31, #37–#53, #56, #234, #241, #242, #258, #259, #260, #261, #263, #314, #319, #322, #323, #324 completed 100% green.
- **Issue #31 — Route Test Suite Verification (`server/index.js`, `server/test/routes.test.js`):**
  - Updated mock CalDAV handler in `server/index.js` to respond to discovery `PROPFIND` requests at base URL `/` and `/.well-known/caldav`.
  - **Issue #32 — Make Internal TLS Optional via Env (`radicale/entrypoint.sh`, `.env.example`, `server/test/radicale_tls_optional.test.js`):**
  - Updated `radicale/entrypoint.sh` to check `RADICALE_SSL` / `RADICALE_ENABLE_SSL` environment variables (default: `True`).
  - When set to `false` / `0` / `no` / `off` (case-insensitive), entrypoint configures `ssl = False` in `/etc/radicale/config`.
  - Added documentation entry for `RADICALE_SSL=True` in `.env.example`.
  - Added unit test suite `server/test/radicale_tls_optional.test.js` (3 tests, 100% green).
- **Issue #34 — App-Store Readiness & Container Registry Publishing (`server/utils/containerPublish.js`, `Dockerfile`, `radicale/Dockerfile`, `sync-worker/Dockerfile`, `docker-compose.yml`, `package.json`, `server/test/container_publish.test.js`):**
  - Created `server/utils/containerPublish.js` providing `getImageNames`, `generateBuildAndPushCommands`, `validateRegistryConfig`, and `publishContainerImages`.
  - Added OCI metadata labels (`org.opencontainers.image.title`, `org.opencontainers.image.description`, `org.opencontainers.image.licenses`) across all three container Dockerfiles (`Dockerfile`, `radicale/Dockerfile`, `sync-worker/Dockerfile`).
  - Updated `docker-compose.yml` to use `${REGISTRY:-ghcr.io/freeshardbase}` and `${TAG:-latest}` environment variables for image references.
  - Added `"publish:containers"` script to `package.json`.
  - Added unit test suite `server/test/container_publish.test.js` (7 tests, 100% green).
- **Issue #35 — Refactor Express Session Storage for User-Indexed Session Invalidation (`server/db.js`, `server/utils/sessionStore.js`, `server/utils/sessionConfig.js`, `server/test/user_indexed_session_store.test.js`):**
  - Created `sessions` table in SQLite (`sid` PRIMARY KEY, `user_id`, `sess`, `expired`) with indexes on `user_id` and `expired`.
  - Added Db helper methods (`saveSession`, `getRawSession`, `deleteSession`, `deleteSessionsForUser`, `getSessionsForUser`, `touchSession`, `clearExpiredSessions`).
  - Implemented `SqliteSessionStore` extending `express-session.Store` with `destroyUserSessions(userId)` method.
  - Integrated `SqliteSessionStore` as default session store in `server/utils/sessionConfig.js`.
  - Added test suite `server/test/user_indexed_session_store.test.js` (5 tests, 100% green).
- **Issue #58 — SESSION_SECRET Hardcoded Fallback Guard (`server/utils/sessionConfig.js`, `server/test/session_secret_hardcoded.test.js`):**
  - Configured `getSessionConfig` to enforce non-default secrets in `production` and `staging`.
  - Added test suite `server/test/session_secret_hardcoded.test.js` (8 tests, 100% green).
- **Issue #59 — Internal Webhook Security Guard (`server/utils/internalAuth.js`, `server/index.js`, `server/test/internal_webhook_auth.test.js`):**
  - Created `createRequireInternalMiddleware` in `server/utils/internalAuth.js` enforcing `INTERNAL_WEBHOOK_SECRET` header check.
  - Added test suite `server/test/internal_webhook_auth.test.js` (8 tests, 100% green).
- **Issue #60 — MS Graph Sync Event Data Persistence (`server/utils/msgraph.js`, `server/test/msgraph_event_writing.test.js`):**
  - Updated `MSGraphSyncEngine` to accept `caldavClient` and `targetCalendarUrl`, serializing and writing event ICS data on sync.
  - Added test suite `server/test/msgraph_event_writing.test.js` (3 tests, 100% green).
- **Issue #63 — Attendee & Organizer Double Quote Parameter Escaping (`server/utils/ical.js`, `server/caldav/parser.js`, `server/test/attendee_double_quote.test.js`):**
  - Updated `escParamVal(str)` in `server/utils/ical.js` to escape double quotes using RFC 6868 (`^'`) and carets (`^^`) instead of stripping double quotes or leaving unescaped quotes.
  - Handled double quotes in `ORGANIZER` and `ATTENDEE` parameters safely without breaking ICS parameter structure.
  - Added test suite `server/test/attendee_double_quote.test.js` (4 tests, 100% green).
- **Issue #64 — Recur Task Advancing RRULE Fidelity (`server/caldav/parser.js`, `public/js/tasks.js`, `server/test/recurring_task_advance.test.js`):**
  - Replaced hand-rolled date arithmetic in `advanceRecurringTask` (`server/caldav/parser.js`) with `ICAL.Recur` iterator to advance tasks according to RFC 5545 rules.
  - Correctly evaluates `BYDAY` (e.g. `BYDAY=MO`, `BYDAY=2MO`, `BYDAY=MO,WE,FR`), `COUNT` (returns `null` when count limit is reached), `UNTIL` (returns `null` when deadline passes), and `INTERVAL`.
  - Updated `advanceRecurringTaskJS` in `public/js/tasks.js` to utilize `window.ICAL.Recur` when available in frontend context with matching fallback boundary logic.
  - Created unit test suite `server/test/recurring_task_advance.test.js` covering BYDAY, COUNT, UNTIL, INTERVAL, and non-recurring task edges (14 tests, 100% green).

- **Issue #67 — RSVP Attendee Validation & Occurrence Recurrence-ID Scoping (`server/caldav/parser.js`, `server/routes/events.js`, `server/test/rsvp_occurrence_and_validation.test.js`):**
  - Removed unvalidated attendee property creation in `updateAttendeePartstat` (`server/caldav/parser.js`) when `attendeeEmail` is not present on event, preventing invention of attendees from arbitrary body payloads.
  - Added `recurrenceId` parameter support to `updateAttendeePartstat(icsString, attendeeEmail, status, recurrenceId)`.
  - When `recurrenceId` is supplied, targets the specific `VEVENT` matching `recurrenceId` (creating a detached override `VEVENT` for `recurrenceId` cloned from master if none exists) without modifying master or other occurrence PARTSTATs.
  - When `recurrenceId` is omitted, updates PARTSTAT on master `VEVENT` only, preserving detached overrides.
  - Updated `POST /api/events/:uid/rsvp` in `server/routes/events.js` to validate that `email` exists in event attendees (returning `400 Bad Request` if missing) and pass `recurrenceId` to `updateAttendeePartstat`, `parseICSToEvent`, and `buildItipReply`.
  - Enhanced `buildItipReply` to include `RECURRENCE-ID` in `METHOD:REPLY` payload when `recurrenceId` is provided.
  - Created unit test suite `server/test/rsvp_occurrence_and_validation.test.js` (6 tests, 100% green).

- **Issue #74 — Subsystem Documentation in agents.md (`agents.md`, `server/test/agents_md_documentation.test.js`):**
  - Updated `agents.md` Architecture section to document all newly added subsystems:
    - `server/utils/ical.js`: Central RFC 5545 iCalendar processing and serialization engine (`eventToICS`, `taskToICS`, `parseAndExpandEvent`, `buildVTimezoneBlock`, `escParamVal`, `foldLines`, `updateWholeSeries`).
    - `server/utils/msgraph.js` & `sync-worker/msgraph_worker.py`: MS Graph API client and bidirectional sync engine for Microsoft Outlook / Office 365.
    - `server/routes/tasks.js` & `public/js/tasks.js`: VTODO task management REST endpoints (`/api/tasks`) and frontend Kanban board/drawer UI.
    - `server/routes/msgraph.js`: Microsoft 365 account linking and sync endpoints (`/api/msgraph/accounts`).
  - Created unit test suite `server/test/agents_md_documentation.test.js` verifying that `agents.md` documents VTODO/Tasks, MS Graph/Outlook sync, and `server/utils/ical.js` (4 tests, 100% green).





