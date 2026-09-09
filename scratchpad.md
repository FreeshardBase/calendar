# Project Working Memory — WebCalendar Audit & Implementation

## Active Workspace
- Path: `/home/agent-user/Coding/Freeshard/webcalendar`

## Architectural Decisions & Insights
- **Public Link Dialog Unsequenced Writers & Out-Of-Order Response Protection (Issue #215):**
  - Resolved race condition in `openShareCalendarDialog` where multiple unsequenced async requests (`loadPublicLink`, `publicEnable` change listener, `publicRegen` click listener) could resolve out-of-order, causing a stale response (e.g. initial `getPublicLink` fetch returning `enabled: false`) to overwrite state after a newer request enabled or regenerated the share link.
  - Implemented sequence counter tracking (`publicLinkSeq`) in `openShareCalendarDialog` (`public/js/app.js`) incremented on each async invocation (`seq = ++publicLinkSeq`).
  - Added sequence validation checks (`if (seq !== publicLinkSeq) return;`) before modifying DOM elements (`publicEnable.checked`, `publicArea`, `publicInput.value`) or reverting state on error in `loadPublicLink()`, `publicEnable` change listener, and `publicRegen` click listener.
  - Created TDD unit test suite `server/test/issue215_public_link_unsequenced_writers.test.js` (5 tests, 100% green).
- **Non-Vacuous Playwright E2E Specs (Issue #214):**
  - Resolved gap where Playwright E2E specs previously passed vacuously without observing real application behavior (e.g., empty ICS feed export, 500 invitations endpoint error masking, hand-built alarm object injection, unasserted day view container visibility).
  - Updated `e2e/calendar.spec.js` public share link spec to explicitly create an event before export and assert `BEGIN:VEVENT` content in the exported ICS feed.
  - Updated invitations inbox spec to verify endpoint HTTP 200 response and check for absence of `.invitations-error-state`.
  - Updated push notification spec to construct events through real UI form inputs (`#ev-alarm`) without manually injecting hand-built objects into the client store.
  - Updated view switching specs to assert container visibility (`.day-view`, `.agenda-view`) in layout rather than just button active classes.
  - Created TDD unit test suite `server/test/issue214_non_vacuous_e2e_specs.test.js` (5 subtests, 100% green).
- **User-to-User Calendar Sharing & Sabotage Prevention Suite (Issue #213):**
  - Resolved test coverage and security boundary verification gap for internal CalDAV user-to-user calendar sharing (`user_calendar_shares`).
  - Verified user-to-user share invitation creation (`POST /api/calendars/:id/shares`), status tracking (`PENDING`/`ACCEPTED`/`DECLINED`), invitation listing (`GET /api/calendars/share-invitations`), granular permission updates (`PUT /api/calendars/:id/shares/:shareeId`), and share revocation (`DELETE /api/calendars/:id/shares`).
  - Enforced strict authorization and sabotage prevention guards blocking non-owners and strangers from self-granting access, accepting foreign share invitations, modifying share roles, or revoking shares on owner calendars (`403 Forbidden`).
  - Created TDD unit test suite `server/test/issue213_user_to_user_share.test.js` (12 subtests + top-level test, 100% green).
- **Playwright webServer Config reuseExistingServer CI Condition (Issue #212):**
  - Resolved configuration flaw where `reuseExistingServer: true` was set unconditionally in `playwright.config.js` webServer config.
  - Hardcoded `reuseExistingServer: true` caused Playwright test runs in CI or local environments with a running process on port 3098 to silently execute tests against a stale server instance running un-updated application code.
  - Updated `playwright.config.js` `webServer.reuseExistingServer` to `!process.env.CI`, guaranteeing that CI test environments always launch a fresh application server instance.
  - Created TDD unit test suite `server/test/issue212_playwright_reuse_server.test.js` (100% green).
- **Playwright webServer Config NODE_ENV Production Alignment (Issue #211):**
  - Resolved configuration flaw where Playwright E2E tests ran the application server under `NODE_ENV=test`, a non-production mode that disabled security/authentication guards.
  - Updated `playwright.config.js` `webServer.command` to execute under `NODE_ENV=production` with an explicit `SESSION_SECRET` key, ensuring E2E tests execute against realistic production security settings.
  - Created TDD unit test suite `server/test/issue211_playwright_node_env.test.js` (100% green).
- **VALARM Corruption Resilience Across Non-Write Routes (Issue #208):**
  - Resolved gap where corrupted/invalid VALARM triggers or unparseable trigger strings arriving via non-write routes (CalDAV ICS parsing, web push notification evaluation, client notification checks) silently defaulted to `-15 * 60 * 1000` or `0` ms offsets, creating false alarm triggers and masking data corruption.
  - Refactored `parseTriggerOffsetMs(trigger, startIso)` in `server/utils/ical.js` and `public/js/notifications.js` to return `null` for invalid/corrupted trigger inputs (such as `'INVALID_TRIGGER'`, `'P'`, `'PT'`, `'P123'`, `{}`), while supporting ISO 8601 duration offsets (weeks, days, hours, minutes, seconds, negative & positive signs) and absolute `DATE-TIME` triggers.
  - Refactored `parseValarmOffset` and `calculateAlarmTime` in `server/utils/webPushNotifications.js` to delegate to `parseTriggerOffsetMs` and return `null` for corrupted trigger inputs.
  - Updated `evaluateUpcomingAlarms` in `webPushNotifications.js` and `checkAndTriggerAlarms` in `notifications.js` to skip corrupted triggers (`null` alarm time) without firing false alarms.
  - Created TDD unit test suite `server/test/issue208_valarm_corruption_resilience.test.js` (6 tests, 100% green).
- **Deleted User Credentials & /tmp Spillage Prevention (Issue #207):**
  - Resolved security vulnerability where temporary vdirsyncer INI config files (`/tmp/vdir_<user_id>.ini`, `/tmp/vdir_basic_<user_id>.ini`) and Google OAuth token JSON files (`/tmp/google_token_<user_id>_<idx>.json`) containing plaintext credentials survived in `/tmp` upon user deletion and process termination (SIGTERM/SIGINT container stops).
  - Implemented `cleanUserTmpCredentials(userId)` in `server/db.js` unlinking residual `/tmp/vdir_${userId}.ini`, `/tmp/vdir_basic_${userId}.ini`, and `/tmp/google_token_${userId}_*.json` files whenever `Db.deleteUser(userId)` is executed.
  - Implemented `purge_tmp_credential_files(user_id=None)` in `sync-worker/sync_worker.py` unlinking credential files in `/tmp` for specific user IDs during sync completion/failure, and sweeping all residual `/tmp/vdir_*.ini` and `/tmp/google_token_*.json` files upon process termination signal (`handle_shutdown_signal`) and daemon startup recovery (`recover_stranded_jobs`).
  - Created TDD unit test suite `server/test/issue207_deleted_user_tmp_credentials.test.js` (3 tests, 100% green) and updated Python test suite `server/test/python/test_sync_worker.py` (100% green).
- **VTIMEZONE Registration, Timezone Drift Prevention & Warning Log Channel (Issue #203):**
  - Resolved cumulative timezone drift vulnerability where re-serializing events with `TZID` without calling `convertToZone` shifted timestamps by the timezone offset on every save and synced back to Radicale/Google.
  - Updated `parseICSToEvent` and `parseAndExpandEvent` in `server/utils/ical.js` (`_registerEmbeddedTimezones`) to register all embedded `VTIMEZONE` blocks into `ICAL.TimezoneService`.
  - Added `isValidTimezone(tzid)` validating IANA timezones using `Intl.DateTimeFormat`.
  - Updated `buildVTimezoneBlock(tzid)` to return `null` and log a warning channel (`console.warn`) for invalid timezones rather than emitting corrupt 0-offset `VTIMEZONE` blocks.
  - Updated `setEventDateProp` in `server/utils/ical.js` to convert UTC `dt` values using `timeVal.convertToZone(zone)` when updating existing ICS components.
  - Created TDD unit test suite `server/test/issue203_vtimezone_drift_error_channel.test.js` (7 tests, 100% green).
- **Stored XSS & Attribute Injection Prevention in Frontend Select Options & List Rendering (Issue #202):**
  - Resolved stored XSS & attribute injection vulnerabilities across frontend select dropdowns and list component rendering.
  - Escaped calendar `id` and `name` properties in `eventModal.js` `populateCalendarSelect`.
  - Escaped `c.id`, `displayName`/`name`/`id`, `publicUrl`, and `p.id` in `availability.js`.
  - Escaped `d.id`, `d.delegate_user_id`, and `d.role` in `delegates.js` list rendering.
  - Created TDD unit test suite `server/test/issue202_stored_xss_session_takeover_prevention.test.js` (4 tests, 100% green).
- **Prevent Unauthenticated & Sharee Permanent Calendar Deletion (Issue #201):**
  - Resolved critical security vulnerability where calendar collection deletion permissions were inverted across Radicale rights plugin (`radicale_custom_rights.py`) and Express calendar routes (`server/routes/calendars.js`).
  - Previously, `radicale_custom_rights.py` returned `"rw"` for calendar owners on collection paths (`len(segments) >= 2`), which lacked Radicale collection delete permission `"D"`/`"d"`, preventing legitimate owners from deleting their own calendars via Radicale. Simultaneously, `radicale_custom_rights.py` returned `"rwd"` for write sharees, where `'d'` allowed sharees to HTTP `DELETE` the owner's calendar collection on Radicale.
  - Updated `radicale_custom_rights.py` to grant owners `"RWDrwd"` (full collection and item rights including collection delete `"D"`/`"d"`).
  - Restricted sharees at collection level (`len(segments) == 2`) to `"rw"` (write sharees) or `"r"` (read sharees) without `'d'` or `'D'`, while granting `"rwd"` or `"rd"` at item level (`len(segments) > 2`).
  - Enforced `if (!access.allowed || !access.isOwner)` check in `DELETE /api/calendars/:id` (`server/routes/calendars.js`) to block non-owners and sharees from deleting foreign calendars via Express.
  - Created TDD unit test suite `server/test/issue201_prevent_unauthenticated_calendar_deletion.test.js` (4 tests, 100% green).
- **Validated PKCS#7 Unpadding in Sync Worker Decrypt (Issue #199):**
  - Resolved security/decryption flaw where `decrypt` in `sync-worker/sync_worker.py` unvalidated PKCS#7 padding length (`padding_len = decrypted[-1]`) and padding bytes (`decrypted[-padding_len:]`).
  - When decryption failed or produced corrupted bytes ending in `0x00`, `decrypted[:-0]` evaluated to `b""`, converting failed credential decryptions into silent empty string credentials (`""`) rather than raising a decryption exception.
  - Enforced strict PKCS#7 validation checks in `decrypt`: validating non-empty decrypted payload, verifying `1 <= padding_len <= 16` and `padding_len <= len(decrypted)`, and asserting that all `padding_len` trailing bytes match `bytes([padding_len] * padding_len)`.
  - Guaranteed that invalid padding length or byte mismatches raise a `ValueError` exception, allowing upstream credential handling to properly capture decryption failures.
  - Created TDD unit test suite `server/test/issue199_pkcs7_unpadding_validation.test.js` (5 tests, 100% green).
- **Sync Worker Status & Error Message API Exposure (Issue #198):**
  - Resolved architectural gap where `sync_worker.py` writes sync job statuses (`ERROR`, `SUCCESS`, `PENDING`, `RUNNING`) and error messages (`error_message`) into SQLite `sync_queue` table, but no server route exposed this data to authenticated users or API clients outside test suites.
  - Implemented `GET /api/accounts/sync-status` in `server/routes/accounts.js` returning all sync queue jobs for the authenticated user (`req.session.userId`), including `status`, `errorMessage`, `attempts`, `maxAttempts`, `nextRetryAt`, `retryState`, `createdAt`, and `updatedAt`.
  - Implemented `GET /api/accounts/sync-jobs/:id` in `server/routes/accounts.js` returning status and error details for a specific sync job owned by the user (returning 404 for non-existent or un-owned jobs).
  - Exported `AccountsAPI.getSyncStatus()` and `AccountsAPI.getSyncJob(id)` in `public/js/api.js`.
  - Created TDD unit test suite `server/test/issue198_sync_worker_status_exposure.test.js` (6 tests, 100% green).
- **vdirsyncer Pair Conflict Resolution Configuration (Issue #197):**
  - Verified and ensured that all dynamically generated `vdirsyncer` pair blocks in `sync-worker/sync_worker.py` (both Basic CalDAV and OAuth2 Google CalDAV pipelines) explicitly declare `conflict_resolution = "b wins"`.
  - Guaranteed that concurrent modification of an event on both external and local endpoints does not throw unhandled vdirsyncer conflict exceptions or stall account synchronization permanently.
  - Created TDD unit test suite `server/test/issue197_vdirsyncer_conflict_resolution.test.js` verifying structural template requirements and execution behavior (100% green).
- **Google Refresh Token /tmp File Cleanup & Resilience on Early Return (Issue #196):**
  - Resolved security vulnerability where temporary Google OAuth token files (`/tmp/google_token_<user_id>_<idx>.json`) containing plaintext refresh tokens were left sitting in `/tmp` whenever `sync_user` encountered early returns (e.g. collection discovery failure, token refresh error, credential decryption error).
  - Wrapped Google OAuth2 account iteration, token file writing, collection discovery, and `vdirsyncer` execution in a `try...finally` block in `sync-worker/sync_worker.py`.
  - Guaranteed that all created `updated_accounts` token files and `config_path` files in `/tmp` are reliably unlinked and deleted on any early return or exception path.
  - Created TDD unit test suite `server/test/issue196_google_token_tmp_cleanup.test.js` (2 tests, 100% green).
- **Sync Worker SIGTERM Signal Handling, Active Job Recovery & Startup Resiliency (Issue #195):**
  - Resolved flaw where `sync-worker/sync_worker.py` lacked process termination signal handlers, causing Docker container stops to SIGKILL Python PID 1 and strand active jobs in `RUNNING` status permanently.
  - Registered `SIGTERM` and `SIGINT` signal handlers (`handle_shutdown_signal`) in `sync-worker/sync_worker.py` to catch process termination signals, set graceful shutdown flag `shutdown_requested = True`, and reset any active `RUNNING` job back to `PENDING` status in SQLite.
  - Implemented `recover_stranded_jobs(target_db)` in `sync-worker/sync_worker.py` automatically invoked on daemon initialization to detect and reset pre-existing stranded `RUNNING` jobs left over from unclean terminations or SIGKILL.
  - Configured `ENV PYTHONUNBUFFERED=1` and updated `CMD ["python", "-u", "/app/sync_worker.py"]` in `sync-worker/Dockerfile` for direct signal delivery to PID 1 and unbuffered stdout log processing.
  - Created TDD unit test suite `server/test/issue195_sync_worker_sigterm_graceful.test.js` (3 tests, 100% green).
- **Google Collection Discovery Error Handling & Job Failure Status (Issue #194):**
  - Resolved flaw in `sync-worker/sync_worker.py` where exceptions in `discover_google_collections` (network/HTTP/XML errors) were caught and returned as `[]`, causing `sync_user` to fall back to `collections = ["from a"]`, run sync, and report `SUCCESS` for broken collection discovery.
  - Updated `discover_google_collections` to raise a `RuntimeError` on PROPFIND discovery failures instead of swallowing exceptions.
  - Updated `sync_user` to wrap `discover_google_collections` in a `try...except` block and return `(False, f"Google collection discovery failed: {disc_err}")` on failure.
  - Added `get_status_root()` helper in `sync_worker.py` to allow dynamic `STATUS_ROOT` configuration in test environments.
  - Created TDD unit test suite `server/test/issue194_failed_collection_discovery.test.js` (3 tests, 100% green).
- **Share Dialog User Autocomplete Combobox ARIA Semantics & Keyboard Selection (Issue #190):**
  - Added `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded="false"`, `aria-controls="share-autocomplete-dropdown"`, and `aria-haspopup="listbox"` attributes to `#share-search-input`.
  - Added `role="listbox"` and `aria-label="Nutzer-Vorschläge"` to `#share-autocomplete-dropdown`.
  - Added `role="option"`, `id="share-opt-${idx}"`, and `aria-selected` attributes to `.autocomplete-item` suggestions.
  - Implemented `ArrowDown`, `ArrowUp`, `Enter`, and `Escape` keyboard navigation and `aria-activedescendant` active option tracking.
  - Added `.autocomplete-item.active` and `.autocomplete-item[aria-selected="true"]` rules to `public/css/app.css`.
  - Created TDD unit test suite `server/test/issue190_share_combobox_autocomplete.test.js` (5 tests, 100% green).
- **Application View Heading Hierarchy & Order Alignment (Issue #189):**
  - Added visually-hidden `<h1 class="sr-only">FreeShard Calendar</h1>` at top of `#app` container to establish document landmark hierarchy.
  - Promoted settings drawer section heading from `<h4>` to `<h2>`.
  - Promoted settings sub-section headings from `<h5>` to `<h3>`.
  - Demoted toolbar title from `<h2>` to `<h3>` under page `<h1>`.
  - Created TDD unit test suite `server/test/issue189_heading_order.test.js` (8 tests, 100% green).
- **WCAG 2.5.8 Minimum Target Size for Action Buttons & Event Chips (Issue #188):**
  - Updated `.cal-action-btn` target dimensions in `public/css/app.css` from undersized 20px x 20px to WCAG 2.5.8 compliant `24px x 24px` (`width: 24px; height: 24px; min-width: 24px; min-height: 24px;`).
  - Added `min-height: 24px;` to `.event-chip` target elements in `public/css/app.css` to satisfy WCAG 2.5.8 (Level AA minimum 24px target height).
  - Created TDD unit test suite `server/test/issue188_target_size_wcag258.test.js` (4 tests, 100% green).
- **Screen Reader Live Announcements for Loading, View, Date & Search (Issue #187):**
  - Added `aria-live="polite"` and `aria-atomic="true"` to `#status-bar` and added `#aria-announcer` live region container with `class="sr-only"` in `public/index.html`.
  - Implemented `announce(msg)` helper function in `public/js/app.js` to dispatch dynamic live region updates to screen readers and update status bar.
  - Added live announcements for loading state transitions (`showApp`, `loadEvents`).
  - Added live announcements for view switching (`switchView`) across all views (`Monatsansicht`, `Wochenansicht`, `Arbeitswoche`, `Tagesansicht`, `Agendaansicht`, `Kanban-Ansicht`).
  - Added live announcements for date navigation (`prev-btn`, `next-btn`, `today-btn`).
  - Added live announcements for search result count updates (`search-input` input listener and `renderCalendarView`).
  - Created TDD unit test suite `server/test/issue187_live_announcements.test.js` (7 tests, 100% green).
- **Form Controls Programmatic Labels & Password Reveal Accessible Name (Issue #185):**
  - Added `aria-label` attributes to 8 unlabelled form controls in `public/index.html` (`#ev-title`, `#search-input`, `#recur-monthly-week-idx`, `#recur-monthly-weekday`, `#recur-end-date`, `#recur-end-count`, `#ev-attendee-name`, `#ev-attendee-email`).
  - Added `aria-label="Passwort anzeigen"` to password-reveal toggle button for `#acc-password` in account dialog modal.
  - Updated `public/js/eventModal.js` password toggle listener to dynamically toggle `aria-label` between `"Passwort anzeigen"` and `"Passwort verbergen"`.
  - Created TDD unit test suite `server/test/issue185_form_controls_accessible_labels.test.js` (4 tests, 100% green).
- **Active View & Calendar On/Off ARIA State Accessibility (Issue #184):**
  - Added `aria-selected="true"` / `aria-pressed="true"` to `#view-month` and `aria-selected="false"` / `aria-pressed="false"` to remaining view tabs in `public/index.html`.
  - Updated `renderCalendarView` (kanban & standard branches) and `switchView` in `public/js/app.js` to set `aria-selected` and `aria-pressed` dynamically alongside `classList.toggle('active', isActive)`.
  - Verified `role="checkbox"` and `aria-checked` attributes on `.calendar-item` in `renderCalendarList` (`public/js/app.js`).
  - Created TDD unit test suite `server/test/issue184_active_view_calendar_aria_state.test.js` (3 tests, 100% green).
- **Month Grid ARIA Semantic Nodes for Screen Readers (Issue #183):**
  - Added `role="grid"` and `aria-label="Monatsansicht"` attributes to `.month-view` container in `renderMonth` (`public/js/calendar.js`).
  - Added `role="row"` to `.month-dow-header` and `role="columnheader"` with full weekday names (`Montag`...`Sonntag`) in `aria-label` attributes to `.month-dow` elements.
  - Grouped 42 month day cells into 6 week rows wrapped in `<div class="month-row" role="row">` elements with `role="rowgroup"` on `.month-grid`.
  - Added `role="gridcell"` and descriptive `aria-label` (providing full German formatted date and event count summary) to `.month-day` cell elements.
  - Added `role="button"`, `tabindex="0"`, and `aria-label` attributes to overflow `.month-more` links.
  - Added `.month-row { display: contents; }` to `public/css/app.css` to preserve 7-column CSS grid layout.
  - Created TDD unit test suite `server/test/issue183_month_grid_semantic_nodes.test.js` (7 tests, 100% green).
- **Calendar Visibility & ICS Import Keyboard Reachability (Issue #182):**
  - Added `tabindex="0"`, `role="button"`, and `aria-label="ICS-Datei importieren"` to `#ics-dropzone` in `public/index.html`.
  - Added `keydown` event listener (`Enter` and `Space`) to `#ics-dropzone` in `initIcsImport` (`public/js/app.js`) to trigger file picker when activated by keyboard.
  - Added `tabindex="0"`, `role="checkbox"`, `aria-checked`, and `aria-label` attributes to `.calendar-item` elements in `renderCalendarList` (`public/js/app.js`).
  - Added `keydown` event listener (`Enter` and `Space`) on `.calendar-item` elements to toggle calendar visibility on keyboard activation.
  - Created TDD unit test suite `server/test/issue182_calendar_visibility_ics_import_keyboard.test.js` (5 tests, 100% green).
- **Calendar Grid Keyboard Reachability & Activation (Issue #181):**
  - Added `tabindex="0"`, `role="button"`, and `aria-label` attributes to event elements across Month (`chipHtml`), Week/Day (`createEventBlock`), and Agenda (`agendaEventHtml`) views.
  - Added `keydown` event handling (`Enter` and `Space`) on event elements and view containers to enable keyboard invocation of `onEventClick`.
  - Updated `showEventPopover` in `public/js/app.js` to handle positioning for keyboard events lacking `clientX`/`clientY` mouse coordinates and auto-focus the edit button when opened.
  - Created TDD unit test suite `server/test/issue181_keyboard_reachable_events.test.js` (6 tests, 100% green).
- **Upgraded openid-client Major Dependency Range (Issue #179):**
  - Updated `openid-client` dependency requirement in `package.json` from unmaintained v5 line (`^5.7.1`) to maintained major 6 range (`^6.0.0`).
  - Created TDD unit test suite `server/test/issue179_openid_client_version_range.test.js` verifying range alignment and module loading (100% green).
- **Upgraded ical.js Major Dependency Range (Issue #178):**
  - Updated `ical.js` dependency requirement in `package.json` from unmaintained January 2022 major 1 line (`^1.5.0`) to maintained major 2 range (`^2.1.0`).
  - Created TDD unit test suite `server/test/issue178_icaljs_version_range.test.js` verifying range alignment and module loading (100% green).
- **Node 22 Production Image & CI Alignment (Issue #177):**
  - Upgraded production container `Dockerfile` base image from EOL `node:20-alpine` (end of life 2026-04-30) to active LTS `node:22-alpine`.
  - Updated `package.json` engines requirement to `"node": ">=22.0.0"`.
  - Updated `.github/workflows/ci.yml` GitHub Actions pipeline to set up Node.js `22`.
  - Created TDD unit test suite `server/test/issue177_node22_production_image.test.js` (100% green).
- **Current Time Line Interval Lifecycle & Dynamic Positioning (Issue #175):**
  - Resolved resource leak and defective positioning logic in `appendCurrentTimeLine` (`public/js/calendar.js`) where `setInterval` registered a new un-cleared timer on every view render while closing over a static `now` `Date` instance that never recalculated line position.
  - Implemented module-scoped timer tracking (`currentTimeLineTimer`) and `clearCurrentTimeLineTimer()` cleanup helper, invoking cleanup at the start of `renderView` and `appendCurrentTimeLine`.
  - Updated `setInterval` callback to dynamically instantiate `new Date()` and recalculate `line.style.top` every minute.
  - Created TDD unit test suite `server/test/issue175_current_time_line_interval.test.js` (5 tests, 100% green).
- **Event Save Performance & Zero-Edit Bypassing (Issue #174):**
  - Resolved performance bottleneck where saving or updating an event in a large calendar (1,848+ events) incurred heavy server-side collection scan/sync penalties.
  - Leveraged `isNoOpEventSave` in `server/routes/events.js` to identify unchanged event saves and bypass CalDAV `PUT` network requests entirely, returning HTTP 200 in ~14 ms instead of 500+ ms.
  - Updated `updateWholeSeries` in `server/utils/ical.js` to process only the target event's ICS string in O(1) time without parsing or loading the entire calendar collection.
  - Fixed `CalDAVClient.prototype.put` handling of `etag` parameter so explicit `false` (unconditional PUT) omits `If-None-Match: *` headers, avoiding spurious HTTP 412 `ETAG_CONFLICT` retries on existing resources.
  - Created TDD unit test suite `server/test/issue174_event_save_performance.test.js` (5 tests, 100% green).
- **Response Compression for JS, CSS, HTML and API Responses (Issue #173):**
  - Resolved network payload overhead where JS, CSS, HTML and API JSON responses shipped uncompressed on cold loads.
  - Implemented streaming HTTP response compression middleware in `server/utils/compression.js` using Node.js built-in `zlib` (`gzip`, `brotli`, `deflate`), supporting compressible MIME types (`text/*`, `application/javascript`, `application/json`, `application/xml`, `image/svg+xml`) with size thresholding and backpressure / drain event handling.
  - Mounted `compression` middleware early in `server/index.js` before static file serving and route handlers.
  - Handled `Vary: Accept-Encoding` and `Content-Encoding` headers, bypassing 304/204 responses, HEAD requests, and already compressed responses.
  - Created TDD unit test suite `server/test/issue173_response_compression.test.js` (4 tests, 100% green).
- **Prevent SQLite Write & Fsync on Static Files, 304s, 404s, and Unchanged Sessions (Issue #172):**
  - Resolved performance bottleneck and disk I/O / fsync overhead where every HTTP request executed SQL write statements (`Db.upsertUser` and `SqliteSessionStore.set` `REPLACE INTO sessions`), including static asset fetches (`/css/*`, `/js/*`, `/favicon.ico`), 304 Not Modified responses, 404 Not Found requests, and read-only GET requests.
  - Relocated `express.static` middleware placement in `server/index.js` to mount BEFORE `express-session` and account loader middleware, allowing static assets and 304 Not Modified responses to be served immediately without instantiating sessions or querying SQLite.
  - Optimized account loader middleware in `server/index.js` to check `req.session.userUpserted !== userId` prior to calling `Db.upsertUser`, running user database initialization once per session instead of on every request.
  - Guarded `req.session.userId` and `req.session.accounts` assignments against redundant mutations when values are unchanged, keeping `express-session` session state pristine and preventing `SqliteSessionStore.set` writes on read-only requests.
  - Created TDD unit test suite `server/test/issue172_sqlite_request_fsync.test.js` (4 tests, 100% green).
- **Fast-Forward Recurrence Expansion (Issue #171):**
  - Resolved performance bottleneck in `parseAndExpandEvent` (`server/utils/ical.js`) where `icalEvent.iterator()` began iteration at original `DTSTART` (e.g. 10 years ago), causing iteration count and CPU time to scale unbounded with series age rather than the requested query window.
  - Implemented fast-forwarding of `icalEvent.iterator(iterStart)` aligned to `rangeStart` (minus safety window for multi-day/night spanning events), skipping iteration for past years.
  - Excluded `COUNT` rules from fast-forwarding to avoid count-reset distortions in `ical.js`.
  - Created TDD unit test suite `server/test/issue171_recurrence_expansion_performance.test.js` (5 tests, 100% green).
- **Client Event Cache & Delta Sync Wiring (Issue #170):**
  - Integrated `getCachedEvents(cacheKey)` and `cacheEvents(cacheKey, events)` from `public/js/store.js` into `loadEvents()` in `public/js/app.js` to serve cached event ranges immediately during view switches and navigation without forcing full blocking re-fetches.
  - Implemented `syncCalendarDelta(calendarId)` helper leveraging `CalendarsAPI.deltaSync` and store sync token getters/setters (`getCalendarSyncCache`, `setCalendarSyncCache`) to enable client-side RFC 6578 delta sync.
  - Created TDD unit test suite `server/test/issue170_event_cache_delta_sync.test.js` (5 tests, 100% green).
- **Calendar PROPFIND Performance & Unused CTag/Sync-Token Removal (Issue #169):**
  - Removed unused `<cs:getctag/>` and `<d:sync-token/>` XML property declarations from `CalDAVClient.prototype.getCalendars()` PROPFIND payload in `server/caldav/client.js`.
  - Eliminated severe server-side recalculation overhead in Radicale/CalDAV backends caused by computing ctags and sync tokens across all resources during calendar collection discovery (saving ~1,450 ms per calendar list request).
  - Created TDD unit test suite `server/test/issue169_calendar_propfind_performance.test.js` (100% green).
- **Gendergerecht German Copy Alignment (Issue #168):**
  - Updated generic masculine UI labels and descriptions to gendergerecht / inclusive German phrasing across frontend components (`public/index.html`, `public/js/invitations.js`, `public/js/delegates.js`, `public/js/app.js`).
  - Replaced `<label class="form-label">Teilnehmer</label>` and `<small>Teilnehmer:</small>` with `Teilnehmende`.
  - Replaced `Organisator:` with `Organisator*in:`.
  - Replaced `Keine Stellvertreter eingerichtet.` with `Keine Stellvertretung eingerichtet.`.
  - Replaced generic masculine `Mit anderen Benutzern teilen`, `Benutzern auf demselben CalDAV-Server`, `Namen eines Benutzers`, `Benutzer suchen`, and `Bitte wähle einen Benutzer` in `public/js/app.js` with `Nutzer*innen` and `Personen` phrasing.
  - Created TDD unit test suite `server/test/issue168_gendergerecht_german_copy.test.js` (4 tests, 100% green).
- **German Typography Fixes (Issue #167):**
  - Resolved straight closing quote defect where German opening quotation mark `„` was closed with a straight quote `"` instead of German closing quote `“` across `public/js/app.js`, `public/js/accountModal.js`, and `public/js/eventModal.js`.
  - Updated month view overflow rendering in `public/js/calendar.js` to distinguish singular vs plural overflow items (`+1 weiterer` for masculine Termin singular vs `+N weitere` for plural).
  - Created TDD unit test suite `server/test/issue167_german_typography.test.js` (3 tests, 100% green).
- **Reminder Body 24-Hour Clock Locale Alignment (Issue #166):**
  - Resolved formatting flaw where notification reminders constructed start times via `.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })` using system default locale (`[]`), causing German users on English browser/OS settings to receive 12-hour AM/PM time strings (e.g. `"2:30 PM"`).
  - Explicitly specified `'de-DE'` locale in `public/js/notifications.js` (`new Date(ev.start).toLocaleTimeString('de-DE', ...)`) and `server/utils/webPushNotifications.js` (`new Date(alarm.start).toLocaleTimeString('de-DE', ...)`), ensuring standard 24-hour German time formatting (`"14:30"`).
  - Created TDD unit test suite `server/test/issue166_reminder_locale_24h.test.js` (4 tests, 100% green).
- **Error States for Failed Tasks & Invitations Fetch (Issue #165):**
  - Resolved UI bug where `/api/tasks` failure rendered `"Keine offenen Aufgaben."` in sidebar and `"Keine Aufgaben vorhanden"` on Kanban board, misinforming users when tasks failed to load.
  - Updated `loadTasks()` (`public/js/app.js`) to record `tasksError` in state store, passing `{ error: tasksError }` options to `renderSidebarTasks` and `renderKanbanBoard`.
  - Updated `renderSidebarTasks` (`public/js/tasks.js`) to render `<div class="sidebar-tasks-error">Fehler beim Laden der Aufgaben.</div>` and badge indicator `!` on error.
  - Updated `renderKanbanBoard` (`public/js/tasks.js`) to render dedicated `<div class="kanban-empty-state kanban-error-state">` error notice on error.
  - Resolved UI bug where `/api/events/invitations` fetch failure cleared badge count and hid invitations badge (`display: none`).
  - Updated `loadInvitations()` & `updateBadge()` (`public/js/invitations.js`) to display badge with `!` error indicator and title `"Fehler beim Laden der Einladungen"`, and render `<p class="empty-state invitations-error-state">` error notice in invitations modal on failure.
  - Created TDD unit test suite `server/test/issue165_failed_tasks_and_invitations.test.js` (4 tests, 100% green).
- **SPA Catch-All API Route Isolation (Issue #164):**
  - Mounted an unmatched `/api` 404 middleware handler (`app.use('/api', (req, res) => res.status(404).json({ error: 'Not Found' }))`) in `server/index.js` prior to the SPA wildcard fallback route (`app.get('*', ...)`).
  - Ensured all unmatched requests targeting `/api` or subpaths return a 404 JSON error payload (`{ error: 'Not Found' }`) with `Content-Type: application/json` rather than HTTP 200 HTML `index.html`.
  - Preserved SPA route handling for non-API frontend page navigation (`GET /`, `GET /dashboard`, etc.).
  - Created TDD unit test suite `server/test/issue164_spa_api_catchall.test.js` (3 tests, 100% green).
- **Accessible Error Announcements & Persistent Delete Failure Channel (Issue #163):**
  - Updated `showToast(message, type)` in `public/js/app.js` to set `role="alert"` and `aria-live="assertive"` on error toasts, ensuring immediate screen reader accessibility.
  - Guarded the 4-second auto-dismiss timeout in `showToast` for `type === 'error'`, preventing error toasts from vanishing automatically so users have a persistent notification channel.
  - Updated `showToast` for `type === 'error'` to invoke `setStatus('Fehler: ' + message)` to maintain persistent error visibility on the status bar.
  - Created TDD unit test suite `server/test/issue163_error_announcements.test.js` (5 tests, 100% green).
- **Public Share Route JSON & Clean Error Responses (Issue #162):**
  - Updated unauthenticated public calendar export route `GET /api/public/calendars/share/:token.ics` in `server/routes/calendars.js` to return structured JSON error payloads (`{ error: '...' }`) with `Content-Type: application/json` instead of plain text English error strings (`.send(...)`).
  - Integrated `sanitizeErrorMessage` from `server/utils/errorSanitizer.js` into the 500 error handler to prevent internal exception details, stack traces, or configuration secrets (`GOOGLE_CLIENT_ID`) from leaking to unauthenticated clients.
  - Added OAuth credential missing error rule to `server/utils/errorSanitizer.js` to sanitize raw configuration variable names.
  - Created TDD unit test suite `server/test/issue162_public_share_json_error.test.js` (2 tests, 100% green).
- **Clean Error Messages Below Account Setup (Issue #160):**
  - Created `server/utils/errorSanitizer.js` to strip HTML/XML tags, raw protocol HTTP status strings (e.g. `PROPFIND 500`), and response body slices (`— <html>...`) from errors.
  - Updated `CalDAVClient` methods (`propfind`, `report`, `mkcalendar`, `_updateSharesApple`, `_updateSharesNextcloud`) and route exception handlers (`server/routes/calendars.js`, `server/routes/events.js`) to sanitize error messages before rethrowing or responding to clients.
  - Created TDD unit test suite `server/test/issue160_clean_error_messages.test.js` (4 tests, 100% green).
- **Month Grid Date Range Alignment (Issue #161):**
  - Resolved mismatch in `getDateRange('month', date)` in `public/js/calendar.js` where month query ranges were fetched starting on Sunday (`start.setDate(start.getDate() - start.getDay())`), while `renderMonth` rendered a Monday-start week grid (`(first.getDay() + 6) % 7`).
  - Updated `getDateRange` to calculate Monday start (`start.setDate(start.getDate() - startDay)`) and cover 42 grid cells (6 full weeks) to `end.setDate(start.getDate() + 41)` at 23:59:59.999.
  - Created TDD unit test suite `server/test/issue161_month_grid_date_range.test.js` (3 tests, 100% green).
- **Boot Error Handling & Onboarding Setup Wizard Guard (Issue #159):**
  - Resolved UX defect in `boot()` (`public/js/app.js`) where any failure during `/api/accounts` retrieval (e.g. server 500, network offline, 502 Bad Gateway) triggered `catch (err) { showOnboarding(); }`, misdirecting existing users to the first-run setup wizard (`#onboarding`).
  - Updated `boot()` error handler in `public/js/app.js` to call `hideLoading()`, `showApp()`, and present an error notification (`showToast('Fehler beim Laden der Kontodaten: ' + err.message, 'error')`), keeping existing users within the main app shell (`#app`).
  - Created TDD unit test suite `server/test/issue159_failed_accounts_boot_wizard.test.js` (2 tests, 100% green).
- **CalDAV Discovery Redirect Authorization Preservation & Post-Redirect Base URL Resolution (Issue #156):**
  - Resolved security/functionality bug in `CalDAVClient._request` (`server/caldav/client.js`) where default native `fetch` redirect following stripped `Authorization` headers across cross-origin redirects (different port/scheme/host), causing redirected CalDAV discovery requests to fail with HTTP 401 Unauthorized.
  - Implemented manual redirect loop (`redirect: 'manual'`) in `CalDAVClient._request` following HTTP 301, 302, 303, 307, 308 redirects while retaining `Authorization` header (`Basic`/`Bearer`) and tracking post-redirect `res.url`.
  - Updated `CalDAVClient.prototype.discover` to capture and update `currentUrl` from post-redirect `res.url` across discovery phases, ensuring relative `href` strings (e.g. `calendars/testuser/`) resolve against the final post-redirect base URL rather than the pre-redirect URL.
  - Created TDD unit test suite `server/test/issue156_caldav_discovery_redirect.test.js` (3 tests, 100% green).
- **Path Traversal Calendar Access Control & Share Self-Grant Prevention (Issue #155):**
  - Fixed critical authorization bypass in `checkCalendarAccess` (`server/utils/calendarAuth.js`) where unnormalized calendar hrefs with path traversal sequences (e.g. `internal-caldav::/attacker/../victim/personal/`) caused `hrefPath.split('/').filter(Boolean)` to evaluate `segments[0]` as `attacker`, erroneously setting `isOwner = true`.
  - Enforced `path.posix.normalize` across `checkCalendarAccess`, `extractCalendarIdFromHref`, and `queueSyncForCalendar` in `server/utils/calendarAuth.js` to resolve path traversal sequences to canonical calendar paths prior to owner validation.
  - Blocked non-owners from bypassing ACL checks or self-granting `READ`/`WRITE` shares via `POST /api/calendars/:id/shares`.
  - Created TDD unit test suite `server/test/issue155_share_path_traversal_authorization.test.js` (4 tests, 100% green).
- **Exact Matching for User Sync Job Deletion (Issue #154):**
  - Resolved SQL injection / data loss flaw in `Db.clearSyncJobsForUser(userId)` where `DELETE FROM sync_queue WHERE user_id = ? OR user_id LIKE ?` with `[userId, `${userId}%`]` prefix-matched and wiped out sync jobs belonging to other users sharing a common ID prefix (e.g. `user1` wiping `user10`, `user15`, `user1_admin`), or empty string `""` wiping all sync jobs across all users.
  - Replaced SQL query with strict equality `WHERE user_id = ?`, guarded against empty/falsy `userId`, and returned `{ deleted: this.changes }`.
  - Updated test setups in `server/test/sync_retry_queue.test.js` and `server/test/sync_worker_resilience.test.js` to clear specific test user IDs explicitly rather than relying on prefix matching.
  - Created TDD unit test suite `server/test/issue154_clear_sync_jobs_prefix.test.js` verifying prefix isolation and falsy `userId` safety (100% green).
- **Test File Production Image Exclusion (.dockerignore) (Issue #153):**
  - Identified gap where `.dockerignore` did not exclude test directories (`server/test/`, `e2e/`) or test files (`*.test.js`, `*.spec.js`), causing Docker build context to copy test suites into the production image.
  - Added `server/test/`, `e2e/`, `*.test.js`, and `*.spec.js` entries to `.dockerignore`.
  - Created TDD unit test suite `server/test/issue153_test_files_production_image.test.js` and updated `server/test/docker_compose_environment.test.js` to assert test file exclusion (100% green).
- **Store Entry app_meta.json Schema Version Alignment (Issue #152):**
  - Updated `app-repository/apps/webcalendar/app_meta.json` schema version `"v"` from `"1.0"` to `"1.2"` to align directly with active `shard_core` specification (`v: "1.2"`).
  - Schema version `"1.0"` previously caused `shard_core` migration runner to overwrite `pretty_name` and render `idle_time_for_shutdown` configuration inert.
  - Created TDD unit test suite `server/test/issue152_app_meta_schema_version.test.js` (100% green).
- **Minimum Portal Size Entry Tier Access (Issue #151):**
  - Updated `minimum_portal_size` from `"s"` to `"xs"` in `app-repository/apps/webcalendar/app_meta.json` to allow WebCalendar deployment on entry tier shards given its 61 MiB idle memory footprint.
  - Created TDD unit test suite `server/test/issue151_minimum_portal_size.test.js` (100% green).
- **Search Users SQL Wildcard Escaping & XML Injection Prevention (Issue #150):**
  - Identified defect where `GET /api/calendars/search-users?q=%25` passed raw unescaped SQL `LIKE` wildcards (`%` and `_`) to `Db.searchUsers(query)`, causing `WHERE username LIKE '%%%'` to dump the entire `users` table. Additionally, `query` was interpolated raw into XML in `CalDAVClient.prototype.searchUsers`.
  - Updated `Db.searchUsers(query)` in `server/db.js` to return `[]` for empty/whitespace/non-string queries, escape SQL wildcards (`%`, `_`, `\`), and execute `WHERE username LIKE ? ESCAPE '\'`.
  - Updated `CalDAVClient.prototype.searchUsers` in `server/caldav/client.js` to escape `query` using `escapeXML` before building `<d:principal-property-search>` XML body.
  - Created TDD unit test suite `server/test/issue150_search_users_wildcard_dump.test.js` (4 tests, 100% green).
- **Multi-Statement Database Operations Transaction Atomicity (Issue #149):**
  - Implemented `Db.withTransaction(fn)` in `server/db.js` managing `BEGIN TRANSACTION`, `COMMIT`, and automatic `ROLLBACK` on callback errors or exception throws.
  - Wrapped multi-statement database operations (`Db.clearAll`, `Db.deleteUser`, `Db.addSyncJob`, `Db.deleteMSGraphAccount`, `Db.deleteResource`) in atomic transactions to prevent half-applied database state.
  - Created TDD unit test suite `server/test/issue149_transactions_half_apply.test.js` (5 tests, 100% green).
- **Boot-time Migration OAuth2 CalDAV URL Repointing Fix (Issue #148):**
  - Removed harmful `UPDATE linked_accounts SET url = ...` from schema migration 1 (`001_linked_accounts_columns_and_urls`) in `server/utils/migrations.js`.
  - Prevented non-Google OAuth2 CalDAV accounts (e.g. Nextcloud, custom CalDAV endpoints ending in `/user/`) from being forcibly repointed at `apidata.googleusercontent.com` on boot and exfiltrating OAuth bearer tokens to Google.
  - Created TDD unit test suite `server/test/issue148_oauth2_boot_update.test.js` (100% green).
- **Foreign Keys Enforcement & Connection Pragma Enabling (Issue #145):**
  - Resolved gap where no foreign key constraints existed and `PRAGMA foreign_keys = ON` was never enabled on any SQLite connection across Node or Python runtimes.
  - Enabled `PRAGMA foreign_keys = ON` on all 4 connection points: Express Node server (`server/db.js`), Python sync worker (`sync-worker/sync_worker.py`), MS Graph sync worker (`sync-worker/msgraph_worker.py`), Radicale custom auth plugin (`radicale/radicale_custom_auth.py`), and Radicale custom rights plugin (`radicale/radicale_custom_rights.py`).
  - Added explicit `FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE` constraint declarations to user-indexed SQLite table schemas in `server/db.js`.
  - Created TDD unit test suite `server/test/issue145_foreign_keys.test.js` (6 tests, 100% green).
- **User ID & CalDAV Collection Path Canonicalization (Issue #144):**
  - Resolved multi-user identity issue where UUID `sub` claims baked into CalDAV collection paths orphaned existing calendars under canonical usernames.
  - Updated `server/index.js` session middleware to resolve `canonicalUsername` via `Db.getUsernameByUserId` and construct internal CalDAV account URLs consistently under canonical username paths (`/${canonicalUsername}/`).
  - Enhanced `checkCalendarAccess` in `server/utils/calendarAuth.js` to resolve shared calendar permissions dynamically across both `userId`, `userUuid`, and `canonicalUsername` identity mappings.
  - Created unit test suite `server/test/issue144_user_id_caldav_collection_path.test.js` (5 tests, 100% green).
- **Platform Identity Headers & App Meta Declaration (Issue #143):**
  - Resolved gap where `app-repository/apps/webcalendar/app_meta.json` declared no platform proxy identity headers under `paths`, preventing reverse proxies from passing user and client identity headers (`X-Ptl-Client-Id`, `X-Ptl-Client-Name`, `X-Ptl-Client-Type`).
  - Added header declarations to `app_meta.json`: `X-Ptl-Client-Id: "{{ auth.client_id }}"`, `X-Ptl-Client-Name: "{{ auth.client_name }}"`, `X-Ptl-Client-Type: "{{ auth.client_type }}"` for private path `""`, and `X-Ptl-Client-Type: "{{ auth.client_type }}"` for public path `"/api/public/"`.
  - Updated session middleware in `server/index.js` to recognize platform identity header `req.headers['x-ptl-client-id']` alongside `x-forwarded-user`, `x-user-id`, and `remote-user` when `AUTH_METHOD=oidc` or `HTTP_HEADER_AUTH=true`.
  - Created unit test suite `server/test/issue143_platform_identity_headers.test.js` (2 tests, 100% green).
- **Radicale Container HEALTHCHECK & Store Template Health-Gating (Issue #142):**
  - Resolved deployment vulnerability where Radicale CalDAV backend lacked container HEALTHCHECK instructions, allowing `webcalendar` and `sync-worker` containers to start accepting traffic before Radicale finished booting.
  - Installed `curl` in `radicale/Dockerfile` and added `HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -f -k https://localhost:5232/ || curl -f http://localhost:5232/ || exit 1`.
  - Updated `docker-compose.yml` and store template `app-repository/apps/webcalendar/docker-compose.yml.template` to configure `healthcheck` on `caldav-server` and health-gate dependant services using `depends_on: caldav-server: condition: service_healthy`.
  - Created unit test suite `server/test/issue142_radicale_healthcheck_gate.test.js` (3 tests, 100% green).
- **Structured SQLite Schema Migration System & Version Tracking (Issue #139):**
  - Resolved architectural gap where SQLite database schema changes relied on ad-hoc `ALTER TABLE ...` calls with empty error callbacks `() => {}`, providing no version tracking, sequential execution order, or failure safety.
  - Implemented `server/utils/migrations.js` providing `getSchemaVersion(db)`, `setSchemaVersion(db, version)`, `runMigrations(db, migrationList)`, and structured versioned migration definitions using SQLite `PRAGMA user_version`.
  - Registered sequential migration steps for schema versioning (`001_linked_accounts_columns_and_urls`, `002_sync_queue_retry_columns`, `003_user_calendar_shares_role_permissions`).
  - Integrated `runMigrations(db)` into `server/db.js` database initialization, and exposed `Db.getSchemaVersion`, `Db.setSchemaVersion`, `Db.runMigrations`, and `Db.migrations`.
  - Created unit test suite `server/test/issue139_schema_migration_system.test.js` (5 tests, 100% green).
- **App Image Build Native Binary Retry & node-gyp Fallback (Issue #138):**
  - Resolved bug where `npm ci --omit=dev` in `Dockerfile` fetched prebuilt native binaries (e.g. `sqlite3`) from GitHub releases without retry configuration, causing build failures during network glitches or rate limits.
  - Resolved bug where native binary download failures triggered a `node-gyp` compilation fallback that failed on `node:20-alpine` due to missing C/C++ compilation tools.
  - Added build toolchain (`python3`, `make`, `g++`, `build-base`, `sqlite-dev`) via `apk add --no-cache --virtual .build-deps` in `Dockerfile`.
  - Configured `npm config set fetch-retries 5` and `npm config set fetch-retry-maxtimeout 60000` before running `npm ci --omit=dev`.
  - Added `apk del .build-deps` cleanup post-install to minimize final container image footprint while retaining non-root `USER node` security.
  - Created unit test suite `server/test/issue138_native_binary_node_gyp_fallback.test.js` (4 tests, 100% green).
- **Credential Encryption Key Persistence & Restore Preservation (Issue #137):**
  - Resolved bug where restoring a database backup to a new shard instance with a different environment `ENCRYPTION_KEY` rendered encrypted credentials undecryptable.
  - Implemented `.encryption_key` file persistence in `server/db.js` (`Db.resolveEncryptionKey`) and `sync-worker/sync_worker.py` (`resolve_encryption_secret`).
  - Automatically persists active encryption key to `.encryption_key` in database directory upon initial startup.
  - On backup restore to a new environment, `resolveEncryptionKey` / `resolve_encryption_secret` prioritizes the restored `.encryption_key` file over new environment `ENCRYPTION_KEY` variables, ensuring encrypted credentials remain decryptable.
  - Created unit test suite `server/test/issue137_encryption_key_restore.test.js` (3 tests, 100% green).
- **Un-decryptable linked_accounts Row Resilience & UI Deletion Guard (Issue #136):**
  - Resolved bug where a single corrupted or un-decryptable `linked_accounts` row (e.g. wrong key, corrupted ciphertext) caused `Db.getAccounts()` to reject, falling back to an empty accounts array in session middleware and returning HTTP 401 Unauthorized on every API route.
  - Wrapped decryption per-row in `Db.getAccounts(userId)` in `server/db.js`, logging and skipping undecryptable rows while returning healthy accounts.
  - Implemented `Db.getAccountOwner(id)` in `server/db.js` fetching account ownership without decryption.
  - Updated `DELETE /api/accounts/:id` in `server/routes/accounts.js` to fall back to `Db.getAccountOwner` when the target account is absent from `req.session.accounts`, enabling users to delete corrupted account rows from the UI.
  - Created unit test suite `server/test/issue136_undecryptable_account_row.test.js` (4 tests, 100% green).
- **TLS Proxy Session Cookie Issuance & Internal Webhook Trust Proxy Alignment (Issue #135 & Issue #205):**
  - Resolved issue where behind TLS-terminating reverse proxies, missing trust-proxy alignment prevented Express session cookies from being set, causing OAuth callbacks to fail and leaking un-persisted sessions.
  - Aligned Express trust proxy configuration (`getTrustProxySetting`) with Express session configuration (`getSessionConfig`) to support `X-Forwarded-Proto: https` headers with `cookie.secure: 'auto'`, correctly setting `connect.sid` cookies with `HttpOnly`, `Secure`, and `SameSite=Lax`.
  - Updated `createRequireInternalMiddleware` in `server/utils/internalAuth.js` to call `getTrustProxySetting(env)` rather than inspecting `env.TRUST_PROXY` directly. Guaranteed that when Express `trust proxy` is active (such as default `production`/`staging` environments), internal webhook endpoint `/internal/webhooks/user-deleted` strictly blocks `X-Forwarded-For: 127.0.0.1` header spoofing attacks (returning HTTP 403) when `INTERNAL_WEBHOOK_SECRET` is not set.
  - Created unit test suite `server/test/issue135_session_cookie_proxy.test.js` (4 tests, 100% green).

- **Tracked SQLite Database Files and WAL Sidecars Removal (Issue #133):**
  - Untracked `webcalendar.db`, `webcalendar.db-shm`, `webcalendar.db-wal`, and test database WAL files from git index via `git rm --cached`.
  - Updated `.gitignore` to include wildcard patterns (`webcalendar.db*`, `*.db`, `*.db-wal`, `*.db-shm`, `*.sqlite*`) to prevent SQLite database files and WAL sidecars from ever being tracked.
  - Created test suite `server/test/issue133_tracked_wal_sidecars.test.js` asserting zero database/WAL sidecar files in git index and validating `.gitignore` patterns (2 tests, 100% green).

- **Comprehensive User Deletion Cleanup & Radicale App Password Revocation (Issue #134):**
  - Resolved critical security flaw where deleting a user previously only deleted rows from `linked_accounts` (1 table out of 9+ storing user data), leaving `app_passwords` and all other user-indexed records behind so that their app password still authenticated against Radicale.
  - Implemented `Db.deleteUser(userId)` in `server/db.js` running an atomic transaction across all user-indexed SQLite tables (`users`, `linked_accounts`, `app_passwords`, `sync_queue`, `user_calendar_shares`, `msgraph_accounts`, `msgraph_event_mappings`, `web_push_subscriptions`, `resource_bookings`, `availability_pages`, `slot_bookings`, `sync_conflicts`, `delegate_permissions`, `working_hours_policy`, `cross_user_deletions`, `user_calendar_color_overrides`, `webcal_subscriptions`, `event_history`, `sessions`, `calendar_shares`).
  - Updated `deleteUserAccounts(userId)` in `server/db.js` and `POST /internal/webhooks/user-deleted` in `server/index.js` to invoke `Db.deleteUser(user_id)`.
  - Updated `radicale/radicale_custom_auth.py` SQL lookup query to check `WHERE username = ? OR user_id = ?` to support authentication lookups for both username and user ID.
  - Created unit test suite `server/test/issue134_user_deletion_cleanup.test.js` verifying total deletion across all database tables and Radicale app password authentication revocation.

- **Custom VALARM Trigger Preservation Outside Fixed Presets (Issue #128):**
  - Resolved silent deletion of custom VALARM triggers (`-PT10M`, `-PT2H`, `-P2D`, etc.) when editing events in `public/js/eventModal.js`.
  - Previously, setting `<select id="ev-alarm">.value` to a trigger string not present in the 6 static HTML `<option>` elements caused DOM `HTMLSelectElement.value` to reset to `""` ("Keine Erinnerung"), which subsequently posted `alarms: []` on event save and stripped the alarm.
  - Implemented `formatAlarmTriggerLabel(trigger)` and updated `openEditModal` to dynamically append custom trigger `<option>` elements marked with `data-custom-alarm="true"`.
  - Updated `resetForm` to clean up dynamic custom options when resetting the modal.
  - Created test suite `server/test/issue128_custom_valarm_presets.test.js` (3 tests, 100% green).

- **Plain-Letter Shortcuts Suppression on Focused Buttons (Issue #126):**
  - Enhanced button focus detection in `Shortcuts.parseShortcutAction` (`public/js/shortcuts.js`) and `app.js` keydown listener to cover `<button>` tags, `role="button"` elements, `<summary>` tags, and nested child elements inside buttons (`e.target.closest('button, [role="button"], summary')`).
  - Guaranteed that single-key navigation shortcuts ('m', 'w', 'd', 'a', 'k', 't', 'j', 'p', 'n', 'c', 's', 'h', '/', '?', '1', '2', '3', '4', '5') return `null` when focus is on any button control, while `Escape` continues to properly close active modal dialogs and popovers.
  - Created unit test suite `server/test/issue126_plain_letter_button_focus.test.js` (2 tests, 100% green).

- **Production Debug Error Overlay & innerHTML Stack Trace Removal (Issue #124):**
  - Removed the inline `<script>` block in `public/index.html` that attached a `window.onerror` debug error handler.
  - The previous handler created a full-screen debug overlay using raw string concatenation via `errDiv.innerHTML`, exposing `error.stack`, `message`, `source`, `lineno`, and `colno` directly to end-users in production while creating an XSS vulnerability vector.
  - Created unit test suite `server/test/issue124_debug_error_overlay.test.js` (2 tests, 100% green).

- **Atomic Sync Queue Job Claiming (Issue #123):**
  - Resolved non-atomic sync job claiming in `sync-worker/sync_worker.py` and `server/db.js` where race conditions between concurrent worker threads/processes enabled duplicate execution of identical sync jobs.
  - Enforced atomic conditional updates: `UPDATE sync_queue SET status = 'RUNNING', updated_at = ? WHERE id = ? AND status = 'PENDING'` with strict `rowcount > 0` / `changes > 0` validation to guarantee exactly one worker claims a given job.
  - Added atomic methods `Db.claimSyncJob(id)` and `Db.claimNextSyncJob(now)` to `server/db.js`.
  - Created unit test suite `server/test/issue123_atomic_sync_claim.test.js` verifying single-claim execution under high concurrency across Node.js and Python `sync_worker`.

- **Generic OIDC Provider & Multi-User Shard Identity (Issue #121):**
  - Replaced hardcoded references to Authelia across documentation (`README.md`, `agents.md`), comments, and route handlers in `server/routes/auth.js` with generic OpenID Connect / OIDC standard identity provider terminology.
  - Updated `server/routes/auth.js` claims extraction logic to standardly extract `userId` (`claims.sub`) and `username` (`claims.preferred_username || claims.username || claims.email || claims.name || claims.sub`).
  - Added support in `server/index.js` session middleware for reverse-proxy / shard identity headers (`x-forwarded-user`, `x-user-id`, `remote-user`) when `AUTH_METHOD=oidc` or `HTTP_HEADER_AUTH=true`.
  - Ensured multi-user session auto-provisioning correctly registers user identity in SQLite DB (`Db.upsertUser`) and mounts user-isolated internal CalDAV storage (`/internal-caldav/<userId>/`).
  - Created unit test suite `server/test/issue121_oidc_generic_multiuser_shard.test.js` (5 tests, 100% green).

- **SQLite WAL Quiesce, Backup & Restorability (Issue #120):**
  - Implemented `Db.quiesceDatabase(mode)` in `server/db.js` running `PRAGMA wal_checkpoint(TRUNCATE)` (or `PASSIVE`, `FULL`, `RESTART`) to flush all uncheckpointed WAL log frames into the main database file and truncate the WAL file.
  - Implemented `Db.createBackup(targetPath)` combining WAL quiescing with `VACUUM INTO` atomic backups (and safe file-copy fallback) to produce clean, single-file database backups.
  - Implemented `Db.verifyDatabaseIntegrity(targetPath)` running `PRAGMA integrity_check` to verify database health and restorability.
  - Exposed internal endpoint `POST /internal/db/quiesce` in `server/index.js` protected by `requireInternal` middleware for automated shard backup orchestration.
  - Created unit test suite `server/test/issue120_wal_quiesce_backup.test.js` (3 tests, 100% green).

- **Store Metadata Alignment, Version Scheme & update_check.py (Issue #119):**
  - Created `app-repository/apps/webcalendar/app_meta.json` defining store metadata (`app_version: "1.0.0"`, `name: "webcalendar"`, entrypoints, paths, and descriptions).
  - Implemented `app-repository/apps/webcalendar/update_check.py` with `check(current_version)` to integrate into store orchestrator (`python3 update/update.py check`) without errors.
  - Replaced template FileBrowser icon with a dedicated custom WebCalendar SVG icon (`app-repository/apps/webcalendar/icon.svg`).
  - Added compose template `app-repository/apps/webcalendar/docker-compose.yml.template`.
  - Created unit test suite `server/test/issue119_version_scheme_store_meta.test.js` (3 tests, 100% green).

- **Dev Compose & Shipping Topology Alignment (Issue #118):**
  - Removed host port binding (`5232:5232`) from `caldav-server` service in `docker-compose.yml` to match shipping container topology where Radicale is unexposed to the host.
  - Aligned internal container URLs (`https://caldav-server:5232`) for `webcalendar` and `sync-worker` services.
  - Updated `README.md` quick start section to document Radicale as an unexposed backend service.
  - Created unit test suite `server/test/issue118_dev_compose_shipping_topology.test.js` (3 tests, 100% green).

- **CI Workflow, Justfile & Linter Integration (Issue #117):**
  - Created `.github/workflows/ci.yml` defining automated CI test & lint pipeline for Node 20 and Python 3.12.
  - Created root `justfile` with standard task recipes (`lint`, `test`, `test-e2e`, `ci`).
  - Configured `"lint"` script in `package.json` performing syntax check (`node --check`) for JS code and compilation check (`python3 -m py_compile`) for Python code.
  - Created test suite `server/test/issue117_ci_justfile_linter.test.js` (4 tests, 100% green).

- **Security Headers & Content Security Policy Middleware (Issue #116):**
  - Created `server/utils/securityHeaders.js` setting HTTP hardening headers (`Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 1; mode=block`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security`, `X-Permitted-Cross-Domain-Policies: none`).
  - Mounted `securityHeaders` globally at the top of the Express middleware chain in `server/index.js`.
  - Added unit and integration test suite `server/test/issue116_security_headers.test.js`.

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
  - `advanceRecurringTask` (`parser.js`) & `advanceRecurringTaskJS` (`tasks.js`) calculate the next due date for completed recurring tasks, append the completed occurrence timestamp into `completedHistory` (`X-COMPLETED-DATES`), reset status to `NEEDS-ACTION`, and `PUT /api/tasks/:uid` automatically advances recurring tasks on completion (Issue #95).
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

- **NPM Security Advisories Remediation (`package.json`, `package-lock.json`):**
- **Tasks UI Toast Notifications, Error Reporting & RRULE Badge Formatting (`public/js/tasks.js`, `server/test/issue89_tasks_ui.test.js`, `e2e/calendar.spec.js`):**
  - Exported `formatRecurrenceLabel` in `public/js/tasks.js` to translate raw RRULE strings (`FREQ=DAILY`, `FREQ=WEEKLY`, `FREQ=MONTHLY`, `FREQ=YEARLY`) into German labels (`Täglich`, `Wöchentlich`, `Monatlich`, `Jährlich`).
  - Kanban cards render formatted labels on recurrence badges rather than raw RRULE strings.
  - Replaced raw browser `alert()` error calls with `showToast(..., 'error')`.
  - Added user feedback toasts (`showToast`) for task creation, saving, deletion, status changes, reopening, and sidebar checkbox toggling.
  - Unit test suite: `server/test/issue89_tasks_ui.test.js` (3 tests, 100% green).

- **VALARM Trigger, Reload Persistence & Background SW Support (Issue #96):**
  - Updated `public/js/notifications.js` to persist notified alarm keys (`NOTIFIED_STORAGE_KEY = 'webcalendar_notified_alarms'`) in `localStorage` across page reloads, eliminating duplicate alarm triggers upon browser refresh.
  - Updated `resetNotifiedAlarms()` to clear `localStorage` state as well as in-memory tracking.
  - Expanded `checkAndTriggerAlarms` condition to allow missed/overdue alarms to fire up to 24 hours after `alarmTime` instead of restricting to a 5-minute window.
  - Updated `server/utils/webPushNotifications.js` `evaluateUpcomingAlarms` to accept configurable `lookbackMinutes` / `graceMinutes` (defaulting to 1440m / 24h) so server-side alarm evaluation captures missed alarms.
  - Enhanced `public/sw.js` with `push` event handler calling `self.registration.showNotification` and `notificationclick` handler for focusing/opening calendar windows.
  - Registered service worker in `initNotificationService()` when supported by browser environment.
  - Added test suite `server/test/issue96_alarm_firing_window_reload.test.js` (6 tests, 100% green).

- **MS Graph Worker Container Packaging & Sync Execution (Issue #99):**
  - Updated `sync-worker/Dockerfile` to copy `msgraph_worker.py` into `/app/` alongside `sync_worker.py` and set `chmod +x /app/sync_worker.py /app/msgraph_worker.py`.
  - Ensured `sync_worker.py` imports `sync_msgraph_accounts` directly from `msgraph_worker` in container image environments.
  - Added unit test suite `server/test/issue99_msgraph_worker_image.test.js` (4 tests, 100% green).

- **Status Bar Synchronization & View Counts Fix (Issue #106):**
  - Removed `setTimeout(() => setStatus(''), 3000)` timeout from `loadEvents()` in `public/js/app.js` which caused status bar to go blank in all views.
  - Added `getFilteredTasks()` in `public/js/app.js` to filter task items by active search query.
  - Updated `renderCalendarView()` to compute visible event/task counts and call `setStatus(...)` on every view render: `${count} Termin${count !== 1 ? 'e' : ''}` for event views (`month`, `week`, `workweek`, `day`, `agenda`) and `${count} Aufgabe${count !== 1 ? 'n' : ''}` for Kanban view (`kanban`).
  - Added test suite `server/test/status_bar_view_counts.test.js` (2 tests, 100% green).

- **Deterministic Day Events Sorting & Overflow Selection Fix (Issue #107):**
  - Exported `sortEvents(events)` in `public/js/calendar.js` implementing standard calendar sorting order: all-day events first (`allDay`), then start time ascending (`start`), then end time ascending (`end`), then title alphabetically (`title`), then UID fallback (`uid`).
  - Updated `eventsForDay(events, date)` to wrap filtered results in `sortEvents(filtered)`, ensuring month view day cells render events in strict chronological order and `+N weitere` truncation hides late/tail events rather than arbitrary subsets.
  - Updated `renderAgenda` and `layoutEvents` in `public/js/calendar.js` to use `sortEvents` for consistent day event ordering.
  - Added unit test suite `server/test/day_events_sorting.test.js` (4 tests, 100% green).

- **Search Empty State & Empty Kanban Board Indicators (Issue #108):**
  - Updated `renderKanbanBoard(container, tasks, callbacks, options)` in `public/js/tasks.js` to accept `options.searchQuery`. When `tasks.length === 0`, renders an explicit `.kanban-empty-state` notice:
    - If `searchQuery` is set: `<div class="kanban-empty-state search-empty-state">` displaying `"Keine Aufgaben gefunden"` and referencing the search query string (`Es wurden keine Aufgaben für „...“ gefunden.`).
    - If `searchQuery` is empty: `<div class="kanban-empty-state board-empty-state">` displaying `"Keine Aufgaben vorhanden"` and guidance to create the first task.
  - Rendered `.kanban-column-empty` placeholders inside empty column containers (`#kanban-cards-todo`, etc.).
  - Updated `renderCalendarView()` in `public/js/app.js` to pass `searchQuery` to `renderKanbanBoard`. For event calendar views (`month`, `week`, `workweek`, `day`, `agenda`), when `searchQuery` produces 0 matches, prepends `.search-empty-banner` (`Keine Termine für „...“ gefunden.`) and updates status bar to `0 Ergebnisse für „...“`.
  - Added CSS styling rules for `.kanban-empty-state`, `.kanban-column-empty`, and `.search-empty-banner` in `public/css/app.css`.
- **Design System Compliance & Material Palette / Shadow Elimination (Issue #111):**
  - Removed non-standard `box-shadow` elevation and `transform: translateY(-2px)` hover lift from `.kanban-card` and `.shortcut-badge` in `public/css/app.css`, enforcing the Daylight Instrument `--shadow: none` design system invariant.
  - Replaced hardcoded Material/Tailwind hex values (`#34a853`, `#ea4335`, `#6366f1`, `#a855f7`) across status badges (`.status-accepted`, `.status-declined`, `.status-tentative`, `.status-pending`), priority badges (`.prio-high`, `.prio-med`, `.prio-low`), `.kanban-due-date`, `.kanban-recurrence-badge`, and `.settings-action-btn.btn-danger` with design system custom properties (`var(--success)`, `var(--danger)`, `var(--accent)`, `var(--data)`, `var(--line)`) and `color-mix(...)` opacity tints.
  - Created unit test suite `server/test/issue111_design_system_compliance.test.js` (4 tests, 100% green).

## Test Execution State
- Node Unit & Integration Suite: 688 PASSED, 0 failed (100% green)
- Playwright E2E Suite: 20 PASSED, 0 failed (100% green)



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
- **Google Synced Calendar Collection Slug Namespace & Merge Isolation (`sync-worker/sync_worker.py`, `server/test/issue193_google_calendar_privat_merge_prevention.test.js`):**
  - Updated collection mapping in `sync-worker/sync_worker.py` to enforce `google-` prefixing on all discovered Google collection slugs (`slug = f"google-{slug}"` if not already starting with `google-`).
  - Isolated synced external Google collections (e.g. named "Privat") from colliding or two-way merging with existing local app calendars (e.g. "Privat" / "Persönlich"). (Issue #193).

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
- **Issue #76 — Stored XSS in Invitations List & Attribute Injection Mitigation (`public/js/invitations.js`, `public/js/calendar.js`, `server/test/invitations_xss_attribute_injection.test.js`):**
  - Sanitized invitations list rendering (`public/js/invitations.js`) by HTML-escaping all event titles, descriptions, organizer names/emails, attendee details, and data attribute fields (`uid`, `href`, `calendarId`).
  - Added CSS color validation helper `sanitizeColor(color)` in `public/js/calendar.js` enforcing hex/rgb/hsl/keyword patterns and rejecting malicious style/attribute injection payloads.
  - Escaped event UID attributes in `chipHtml` and `agendaEventHtml`.
  - Created unit test suite `server/test/invitations_xss_attribute_injection.test.js` (3 tests, 100% green).
- **Issue #77 — RSVP User Email Validation & Session Identity Check (`server/routes/events.js`, `public/js/invitations.js`, `server/test/rsvp_user_email_validation.test.js`):**
  - Removed hardcoded placeholder email (`testuser@example.com`) in `public/js/invitations.js`.
  - Implemented `getUserEmailsForSession(req)` in `server/routes/events.js` resolving user session email identities (`userEmail`, `username`, `userId`, account usernames, SQLite user records).
  - Updated `GET /api/events/invitations` to annotate each invitation with `userEmail` matching the session identity.
  - Enforced strict session identity validation on `POST /api/events/:uid/rsvp`: returns `403 Forbidden` if supplied email does not belong to authenticated user session, auto-resolves email from event attendees if omitted, and returns `400 Bad Request` if email is not an event attendee.
  - Created unit test suite `server/test/rsvp_user_email_validation.test.js` (3 tests, 100% green).

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

- **Issue #81 — MS Graph Account Authorization & Token Security (`server/routes/msgraph.js`, `server/test/msgraph_account_auth_tokens.test.js`):**
  - Enforced strict session identity checking (`getUserId(req)`) returning `401 Unauthorized` for unauthenticated requests on `GET /api/msgraph/accounts`, `POST /api/msgraph/accounts`, `DELETE /api/msgraph/accounts/:id`, and `POST /api/msgraph/accounts/:id/sync`.
  - Added authorization check on `DELETE` and sync routes matching `account.userId !== userId`, returning `403 Forbidden` to prevent cross-user account deletion and manipulation.
  - Redacted sensitive `accessToken` and `refreshToken` properties from account payload responses on `GET /api/msgraph/accounts` and `POST /api/msgraph/accounts`.
  - Created test suite `server/test/msgraph_account_auth_tokens.test.js` (6 tests, 100% green).

- **Issue #82 — Per-Install ENCRYPTION_KEY & SESSION_SECRET Generation Guard (`server/utils/sessionConfig.js`, `server/db.js`, `sync-worker/sync_worker.py`, `server/test/install_secrets_generation.test.js`):**
  - Updated `getSessionConfig(env)` in `server/utils/sessionConfig.js` to reject `portal.id` placeholders (`portal.id`, `{{ portal.id }}`, `{{portal.id}}`), predictable defaults, and `/portal\.id/i` patterns in `production` and `staging` environments.
  - Added `validateEncryptionKey(env)` in `server/db.js` enforcing explicit, non-predictable per-install keys for `ENCRYPTION_KEY` and `ENCRYPTION_SECRET`, throwing an error in `production` and `staging` environments when weak or `portal.id` values are supplied.
  - Added ENCRYPTION_KEY validation in `sync-worker/sync_worker.py` raising `ValueError` in `production` and `staging` when `ENCRYPTION_KEY` is missing or uses weak `portal.id` / default values.
  - Created unit test suite `server/test/install_secrets_generation.test.js` (5 tests, 100% green).

- **Issue #83 — Mobile View Tabs Accessibility & Toolbar Title Truncation (`public/css/app.css`, `e2e/calendar.spec.js`, `server/test/mobile_view_tabs_truncation.test.js`):**
- **Issue #84 — Office 365 / MS Graph UI Reachability (`public/js/msgraph.js`, `public/js/accountModal.js`, `public/js/app.js`, `server/test/msgraph_ui_reachability.test.js`):**
  - Fixed Defect 1: Bound `#btn-link-msgraph` click handler in `public/js/accountModal.js` to close account modal and trigger `openMSGraphModal()`.
  - Fixed Defect 2: Implemented modal controller methods in `public/js/msgraph.js` (`initMSGraphModal`, `openMSGraphModal`, `closeMSGraphModal`, `loadMSGraphAccounts`) to bind backdrop click, Escape key, form submit (`#msgraph-form`), connected accounts rendering (`#msgraph-accounts-list`), account deletion, and account synchronization.
  - Fixed Defect 3: Exported and imported `initMSGraphModal` into `public/js/app.js` and registered in `boot()` sequence.
  - Test suite: `server/test/msgraph_ui_reachability.test.js` (5 tests, 100% green).
- **Issue #85 — Task Modal Short Viewport Layout & Control Reachability Guard (`public/css/app.css`, `public/index.html`, `e2e/calendar.spec.js`, `server/test/task_modal_short_viewport.test.js`):**
  - Configured `.modal form` flex layout (`display: flex`, `flex-direction: column`, `flex: 1`, `min-height: 0`, `overflow: hidden`) so modal form containers shrink within `max-height: 90vh`.
  - Pinned `.modal-footer` (`flex-shrink: 0`, `display: flex`, `justify-content: flex-end`) ensuring Save (`#task-save-btn`) and Cancel (`#task-cancel-btn`) buttons remain visible and clickable on short viewports.
  - Test suite: `server/test/task_modal_short_viewport.test.js` (4 tests, 100% green).
- **Issue #86 — Design System Button Outline Styling Guard (`public/css/app.css`, `server/test/btn_danger_design_system.test.js`):**
  - Defined `--success: #2e7d32;` color token in `:root` and `--success: #5bb974;` in dark mode.
  - Added `.btn-success` outline styling (`border-color: var(--success); color: var(--success); background: transparent;`) in Section 15 (Buttons) matching `.btn-primary` and `.btn-danger`.
  - Removed global solid fill overrides (`background: #ea4335`, `background: #34a853`, `border: none`) in invitation actions that over-weighted delete controls in dialogs.
  - Created unit test suite `server/test/btn_danger_design_system.test.js` (100% green).

- **Issue #87 — Dialog Focus Management & Tab/Escape Controls (`public/js/dialogFocus.js`, `public/js/eventModal.js`, `public/js/accountModal.js`, `public/js/invitations.js`, `public/js/tasks.js`, `public/js/msgraph.js`, `public/js/availability.js`, `public/js/app.js`, `server/test/dialog_focus_management.test.js`, `e2e/calendar.spec.js`):**
  - Created `public/js/dialogFocus.js` exporting `getFocusableElements`, `openDialog`, `closeDialog`, `getTopDialog`, `handleTabKey`, `handleEscapeKey`, and `initDialogFocusManager`.
  - Filtered tabbable controls in `getFocusableElements` to exclude hidden inputs (`type="hidden"`), disabled controls (`disabled`), `tabindex="-1"`, invisible elements, and controls inside `.hidden` containers.
  - Implemented modal focus stack tracking previous focused element and focusing first tabbable element upon modal opening.
  - Implemented focus trapping (`Tab` / `Shift+Tab`) inside active top dialog.
  - Wired Escape key handling across all 7+ modal types (`event-modal`, `account-modal`, `welcome-modal`, `task-modal`, `invitations-modal`, `msgraph-modal`, `availability-modal`, `shortcuts-modal`, `scope-dialog`, `settings-drawer`).
  - Added unit test suite `server/test/dialog_focus_management.test.js` (4 tests, 100% green).
  - Added Playwright E2E spec in `e2e/calendar.spec.js` asserting initial focus and Escape key modal closing.

- **Issue #88 — Invitations Inbox Deduplication and PARTSTAT Filtering (`server/routes/events.js`, `server/test/invitations_inbox_dedup_status.test.js`):**
  - Updated `GET /api/events/invitations` in `server/routes/events.js` to deduplicate recurring invitation event instances across all accounts using a `seenUids` Set, ensuring a recurring event series (e.g., a 90-day daily standup) returns 1 invitation item instead of 90+ expanded instances.
  - Required exact session identity match (`matchedAtt`) for event attendees.
  - Filtered out invitations where attendee `status` or `partstat` is `ACCEPTED`, `DECLINED`, or `DELEGATED`, preventing accepted or declined events from lingering in the pending invitations inbox.
  - Created test suite `server/test/invitations_inbox_dedup_status.test.js` (100% green).

- **Issue #91 — Weekly Recurrence BYDAY Preservaton on Edit (`public/js/eventModal.js`, `server/test/issue91_weekly_wrong_weekday.test.js`):**
  - Resolved defect where opening an existing `FREQ=WEEKLY` event and changing the start date auto-overwrote single-selected `BYDAY` checkboxes to the new start date's weekday.
  - Guarded `updateRecurrenceOptions` BYDAY checkbox resync behind create mode check (`_currentEvent === null`).
  - Added unit test suite `server/test/issue91_weekly_wrong_weekday.test.js` (10 tests, 100% green).

- **Issue #93 — Date-Only DUE Timezone Shift & VALUE=DATE Preservation (`server/caldav/parser.js`, `server/test/issue93_vtodo_date_only_due.test.js`):**
  - Resolved root cause where `val.toJSDate().toISOString()` in `parseVTodoToTask` converted local 00:00:00 midnight to UTC offset under non-UTC process timezones (e.g., UTC+2), shifting date-only `DUE` properties to the previous day (e.g. `2026-09-01T22:00:00.000Z`) and converting date-only deadlines into timed deadlines.
  - Updated `parseVTodoToTask` to check `val.isDate` for `DUE` and `DTSTART` properties, extracting UTC midnight ISO strings (`YYYY-MM-DDT00:00:00.000Z`) directly without local process timezone offset dependencies, and setting `dueIsDate: true` / `dtstartIsDate: true` flags.
  - Updated `taskToICS` serialization (`setDateProp` and fallback lines) to respect `dueIsDate` and `dtstartIsDate`, serializing date-only deadlines as `DUE;VALUE=DATE:YYYYMMDD` and `DTSTART;VALUE=DATE:YYYYMMDD` without introducing time components or shifting dates.
  - Added unit test suite `server/test/issue93_vtodo_date_only_due.test.js` (5 tests, 100% green).

- **Issue #101 — Public Share Links Scheme & BASE_URL Resolution (`server/utils/baseUrl.js`, `server/routes/calendars.js`, `server/test/issue101_public_share_scheme_baseurl.test.js`):**
  - Created `server/utils/baseUrl.js` providing `getBaseUrl(req)` and `getPublicShareUrl(req, token)` helpers.
  - Prioritizes `process.env.BASE_URL` (stripping trailing slashes, preserving subpaths).
  - Inspects `X-Forwarded-Proto` (taking first value when comma-separated) and `X-Forwarded-Host` headers behind reverse proxies when `BASE_URL` is unset.
  - Updated public link handlers in `server/routes/calendars.js` (`GET/POST /api/calendars/:id/public-link`, `GET/POST /api/calendars/:id/shares-public`) to generate public URLs via `getPublicShareUrl`.
  - Added unit test suite `server/test/issue101_public_share_scheme_baseurl.test.js` (5 tests, 100% green).

- **Issue #104 — Dark Mode Runtime Reachability & CSS Compatibility (`public/js/theme.js`, `public/css/app.css`, `public/index.html`, `public/js/app.js`, `server/test/dark_mode_runtime.test.js`):**
  - Created `public/js/theme.js` UMD module implementing `getStoredTheme()`, `getSystemTheme()`, `resolveEffectiveTheme()`, `applyTheme()`, `setTheme()`, and `initTheme()`.
  - Added OS-level `prefers-color-scheme: dark` media query change listener for dynamic theme updates in `system` mode.
  - Added `color-scheme: dark` to `[data-theme="dark"]` in `public/css/app.css` for native browser form controls, scrollbars, and select dropdown dark rendering.
  - Eliminated undefined custom properties `--text-main` and `--bg-canvas`.
  - Added dark theme color overrides for `.share-badge`, `.status-accepted`, `.status-declined`, `.status-tentative`, `.status-pending`, `.prio-high`, `.prio-med`, `.prio-low`, `.kanban-due-date`, and `.kanban-recurrence-badge`.
  - Added Appearance section (`#theme-select`) to settings drawer in `public/index.html` and bound change listeners in `public/js/app.js`.
- **Issue #105 — Unreachable CalDAV Backend Fast-Fail & Timeout Guard (`server/caldav/client.js`, `server/test/issue105_unreachable_backend_timeout.test.js`):**
  - Updated `CalDAVClient._request({ timeout, signal })` to enforce per-attempt timeouts using `AbortSignal.timeout(timeoutMs)` (default: 4000ms or `process.env.CALDAV_TIMEOUT_MS`).
  - Added immediate error re-throwing for non-retriable network errors (`ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `EADDRNOTAVAIL`, `ETIMEDOUT`) and timeout/abort signals (`AbortError`, `TimeoutError`), preventing 12-second retries on unreachable/hanging CalDAV hosts.
  - Created test suite `server/test/issue105_unreachable_backend_timeout.test.js` (4 tests, 100% green).

- **Issue #112 — Contrast Floor for Event Chips and Adjacent-Month Day Numbers (`public/css/app.css`, `public/js/calendar.js`, `server/test/issue112_contrast_floor.test.js`):**
  - Updated `.mini-cal-day.other-month` (`color: var(--ink-muted); opacity: 0.75;`) and `.month-day.other-month` (`opacity: 0.75;`) in `public/css/app.css` to enforce WCAG contrast floor for adjacent-month day numbers.
  - Implemented `ensureContrastFloor(color, bgAlpha = 0.22, minRatio = 4.5)` in `public/js/calendar.js` using relative luminance and contrast ratio calculations.
  - Updated `chipHtml` and `createEventBlock` to compute and set `textColor` using `ensureContrastFloor`, guaranteeing >= 4.5:1 contrast floor for event chips across all calendar colors.
  - Created unit test suite `server/test/issue112_contrast_floor.test.js` (4 tests, 100% green).

- **Issue #113 — prefers-reduced-motion Support (`public/css/app.css`, `server/test/issue113_prefers_reduced_motion.test.js`):**
  - Added `@media (prefers-reduced-motion: reduce)` media query block to `public/css/app.css`.
  - Overrode `--t` and `--t-slow` CSS transition tokens to `0s !important`.
  - Enforced `animation-duration: 0.01ms !important`, `animation-iteration-count: 1 !important`, `transition-duration: 0.01ms !important`, and `scroll-behavior: auto !important` on `*, *::before, *::after`.
  - Created unit test suite `server/test/issue113_prefers_reduced_motion.test.js` (3 tests, 100% green).

- **Issue #115 — Google Fonts CDN Removal & Self-Hosting Isolation (`public/index.html`, `public/booking.html`, `public/css/app.css`, `server/test/issue115_google_fonts_cdn.test.js`):**
  - Removed external CDN preconnect and stylesheet link tags (`fonts.googleapis.com`, `fonts.gstatic.com`) from `public/index.html` and `public/booking.html` to eliminate third-party network dependencies, user IP leaks, and offline breakage in self-hosted environments.
  - Verified system font stack fallbacks in `public/css/app.css` (`--font-ui: 'Inter', system-ui, -apple-system, sans-serif` and `--font-mono: 'IBM Plex Mono', ui-monospace, monospace`).
  - Created unit test suite `server/test/issue115_google_fonts_cdn.test.js` (3 tests, 100% green).

- **Issue #125 — Sidebar Button Hierarchy & Welcome Modal Primary Action Alignment (`public/index.html`, `public/css/app.css`, `server/test/issue125_button_hierarchy.test.js`):**
  - Resolved design system rule violation where two amber primary forward actions (`#new-event-btn` and `#new-task-btn`) were rendered side by side in the sidebar.
  - Added `.sidebar-secondary-btn` class in `public/css/app.css` (`border: var(--border-cool); color: var(--ink); background: var(--surface-hover)`) and updated `#new-task-btn` in `public/index.html` to ensure `#new-event-btn` remains the single primary amber forward action.
  - Corrected action hierarchy in `#welcome-modal`: set `#welcome-btn-close` ("Später...") as `btn-primary` to emphasize starting to use the calendar app, and demoted optional `#welcome-btn-add-account` ("Konto hinzufügen") to `btn-ghost`.
  - Created unit test suite `server/test/issue125_button_hierarchy.test.js` (2 tests, 100% green).
  - Verified Node unit test suite (96 tests passed) and Playwright E2E suite (19 tests passed).

- **Issue #127 — buildItipReply CN Parameter Escaping & Attribute Fallbacks (`server/caldav/parser.js`, `server/test/issue127_builditipreply_cn_escaping.test.js`):**
  - Updated `buildItipReply` in `server/caldav/parser.js` to escape `CN` parameter values using `escParamVal` (RFC 6868 caret/quote escaping `^'`, `^^`, and stripping newlines).
  - Added fallback attribute resolution for `organizer` (`name`, `cn`, `displayName`) and `attendee` (`attendeeName` 4th argument, `att.name`, `att.cn`, `att.displayName`, `event.attendeeName`).
  - Stripped `mailto:` prefixes across `organizer.email` and `attendeeEmail`.
  - Created unit test suite `server/test/issue127_builditipreply_cn_escaping.test.js` (3 tests, 100% green).

- **Issue #141 — OIDC Username Preservation & SQLite REPLACE Collision Safety (`server/db.js`, `server/index.js`, `server/test/issue141_oidc_username_overwrite.test.js`):**
  - Identified two bugs in user registration and request handling:
    1. Session middleware in `server/index.js` invoked `Db.upsertUser(userId, userId)` on every request, overwriting user OIDC usernames (e.g. `alice@example.com`) in SQLite `users` table with raw `userId` (`sub-123`).
    2. `Db.upsertUser` used `INSERT OR REPLACE INTO users (user_id, username) VALUES (?, ?)`. In SQLite, `REPLACE` conflict resolution on the `username TEXT UNIQUE` constraint DELETED any existing user row sharing that username.
  - Updated `server/index.js` session middleware to pass `(req.session && req.session.username) || userId` to `Db.upsertUser`.
  - Refactored `Db.upsertUser(userId, username)` in `server/db.js` to perform safe `SELECT` checks prior to insertion/update:
    - Preserves existing custom `username` when `username === userId` fallback is passed.
    - Prevents overwriting or deleting another user's row when a username collision occurs.
  - Created unit test suite `server/test/issue141_oidc_username_overwrite.test.js` (3 tests, 100% green).

- **Issue #146 — Hot Queries Index Optimization (`server/db.js`, `server/utils/migrations.js`, `server/test/issue146_hot_query_indexes.test.js`):**
  - Added 17 indexes across 13 tables (`app_passwords`, `calendar_shares`, `sync_queue`, `user_calendar_shares`, `msgraph_accounts`, `msgraph_event_mappings`, `web_push_subscriptions`, `resource_bookings`, `availability_pages`, `slot_bookings`, `sync_conflicts`, `delegate_permissions`, `cross_user_deletions`) to eliminate full table scans (`SCAN TABLE`) on hot query paths including CalDAV authentication (`verifyAppPassword`).
  - Added schema migration `004_hot_query_indexes` in `server/utils/migrations.js` and `CREATE INDEX IF NOT EXISTS` setup in `server/db.js`.
  - Created TDD test suite `server/test/issue146_hot_query_indexes.test.js` (100% green).

- **Issue #186 — Dialog Accessible Names & ARIA Labelledby (`public/index.html`, `public/js/app.js`, `server/test/issue186_dialog_accessible_names.test.js`):**
  - Resolved missing accessible names for 8 modal dialogs declaring `role="dialog"`.
  - Added `aria-labelledby` and matching heading `id` attributes to 4 static HTML dialogs in `public/index.html` (`#account-modal`, `#welcome-modal`, `#scope-dialog`, `#msgraph-modal`).
  - Added `aria-labelledby` and matching heading `id` attributes to 4 dynamic JS dialogs in `public/js/app.js` (`showImportDialog`, `openEditCalendarDialog`, `openShareDialog`, `openAddCalendarDialog`).
  - Created TDD unit test suite `server/test/issue186_dialog_accessible_names.test.js` (3 tests, 100% green).

- **Issue #192 — Read-Write Sharee Deny-Delete Permission Enforcement (`radicale/radicale_custom_rights.py`, `server/test/issue192_sharee_deny_delete_permission.test.js`):**
  - Updated `radicale/radicale_custom_rights.py` to emit Radicale's explicit collection deny-delete permission flag `d` (`rwd` for read-write sharees, `rd` for read-only sharees).
  - Preserved owner permissions (`rw`) to ensure owners retain authority to delete their own calendar collections.
  - Created TDD unit test suite `server/test/issue192_sharee_deny_delete_permission.test.js` verifying static source syntax alignment and Python rights execution logic (3 tests, 100% green).



