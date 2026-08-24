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
  - Implemented `parseSyncCollectionResponse(xml)` extracting `<d:sync-token>`, updated events, and deleted resource hrefs (`404 Not Found`).
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
  - Added centralized authorization gate `checkCalendarAccess(req, calendarId, requiredAccess)` verifying session auth (`401`), ownership, user shares, and delegation rules (`403`).
  - Integrated `checkCalendarAccess` across calendar management, event CRUD/RSVP, task CRUD, and share administration endpoints to block unauthorized access to foreign calendars.
  - Added regression test suite `server/test/calendar_auth.test.js`.

## Test Execution State
- Node Unit & Integration Suite: 115 PASSED, 7 skipped (100% green)
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

## Test Execution State
- Node Unit & Integration Suite: 239 tests, 232 PASSED, 7 skipped, 0 fail (100% green)
- Playwright E2E Suite: 17 PASSED, 1 skipped (100% green)

## Completed Tasks
- [x] Tasks 1–7 and Backlog Issues #37–#53, #56, #234, #241, #242, #258, #259, #260, #261, #324 completed 100% green.
