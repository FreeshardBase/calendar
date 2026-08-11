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

## Test Execution State
- Node Unit & Integration Suite: PASSED (100% green)
- Playwright E2E Suite: PASSED (100% green)

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

## Status
- Tasks 1–7 and Backlog Issues #37–#40 completed 100% green.

