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

## Test Execution State
- Node Unit & Integration Suite: 107 PASSED (100% green)
- Playwright E2E Suite: 16 PASSED, 1 skipped (100% green)

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

## Status
- Tasks 1–7 and Backlog Issues #37–#49 completed 100% green.


