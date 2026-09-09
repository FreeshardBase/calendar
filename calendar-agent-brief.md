---
type: project
first_mentioned: 2026-09-01
status: active brief — supersedes the current queue for testuser's agent on FreeshardBase/calendar
---

# Freeshard Calendar — brief for the next agent run

Written 2026-09-01 after verifying a week of `BeSovereign` agent work against `origin/master` @ 70f4794. Companion notes: [[calendar-hardening-spec]], [[calendar-caldav-ci-spec]], [[dedup-map]]. Findings corpus: `freeshard/calendar-review/`.

Hand this to the agent in place of its current queue. Work the tasks in order. Do not resume board-wide passes until Task 5.

## Where things stand

The write-path rewrite landed and is correct: `eventToICS(event, existingIcs)` mutates the parsed component in place and `updateWholeSeries` preserves `EXDATE`, detached `RECURRENCE-ID` overrides and `VTIMEZONE`. That was the hardest and most valuable change on the board and it is done. 32 issues have been verified and closed. Three things block everything else, and none of them are on the current queue.

## Standing rules

These change how every task below is finished. They matter more than the tasks.

1. **Never cite a local test-pass count as evidence that something works.** "237/237 PASSED | 100% grün" has been posted on 150 issues while `lint-and-test` failed on every push to `master` for over a day. Cite the CI run URL and its conclusion instead: `gh run list --branch <branch> --limit 1 --json conclusion,url`.
2. **Before claiming an issue fixed, write the check that fails on the unfixed code.** Revert the fix, run the check, confirm it goes red, restore the fix. A check that has never failed has not been tested. Say in the issue comment that this was done and what the red output was.
3. **One issue per pull request, against `master`, merged only when CI is green.** Do not push directly to `master`. Nine commits an hour to the base branch made PR #326 conflict within forty minutes.
4. **Write commit subjects that say what changed.** Sixty-two of the last sixty-three commits are titled `feat: autonomous vacation homework progress update`, which makes the history unreadable and unbisectable. Use `<scope>: <description>`, for example `ical: preserve TZID local-time form on whole-series save`.
5. **Do not commit generated or binary files.** `webcalendar.db` reached 14 MB in the repo before being removed, and `sync-worker/__pycache__/*.pyc` are still tracked. Check `git status` before committing; never `git add -A` blindly.
6. **Do not report an issue fixed by naming a function that was added.** Report the production call path that reaches it, or the stored bytes that changed.

## Task 1 — Make CI green. Nothing else counts until this is done.

`lint-and-test` has failed on every push to `master` for over a day:

```
not ok 2 - App passwords are saved using salted PBKDF2 (salt:hash) and verified securely
  error: 'SQLITE_CONSTRAINT: FOREIGN KEY constraint failed'
not ok 14 - Issue #72 — Credential-at-Rest Gaps Security Suite
```

Cause: enabling `PRAGMA foreign_keys` (the #145 fix, correct and should stay) now rejects the app-password test's insert, which creates a row with no matching parent in `users`. Fix the test fixture to create the parent user, not the pragma.

**Done when:** the most recent `lint-and-test` run on `master` has conclusion `success`. Paste the run URL.

## Task 2 — Issue #325: TZID + Z corruption. P1, live data loss.

https://github.com/FreeshardBase/calendar/issues/325

`eventToICS`'s in-place branch writes a UTC-formatted value into a property that keeps its inherited `TZID` parameter, producing `DTSTART;TZID=Europe/Berlin:20260610T100000Z`. RFC 5545 §3.3.5 forbids the combination: `Z` is UTC form and UTC form must not carry `TZID`.

Effect, measured by driving `server/utils/ical.js` directly with no server running:

```
after 0 edit(s): user sees 2026-06-10T10:00:00.000Z   stored DTSTART;TZID=Europe/Berlin:20260610T100000
after 1 edit(s): user sees 2026-06-10T10:00:00.000Z   stored DTSTART;TZID=Europe/Berlin:20260610T100000Z
after 2 edit(s): user sees 2026-06-10T08:00:00.000Z   stored DTSTART;TZID=Europe/Berlin:20260610T100000
after 3 edit(s): user sees 2026-06-10T06:00:00.000Z   stored DTSTART;TZID=Europe/Berlin:20260610T080000
```

Minus one full UTC offset per save, unbounded. Each round is the eleven-field payload `public/js/eventModal.js:499` builds, with only the title changed. `isNoOpEventSave()` short-circuits a genuine zero-edit save, so the trigger is any edit at all, not the "open and Save" case.

Look at the `dtstart` and `dtend` values passed to `setPropValue` in the in-place branch of `eventToICS`, and at `fmtDateTime` versus `fmtDateTimeTzid`. Either write the local-time form for the named zone, or drop the `TZID` parameter and write true UTC. Not both.

**Done when:** these hold, and both fail on the current code:

```js
const out = updateWholeSeries(stored, payloadWithNewTitle);
assert.doesNotMatch(out, /DTSTART;TZID=[^:]+:\d{8}T\d{6}Z/);
assert.doesNotMatch(out, /DTEND;TZID=[^:]+:\d{8}T\d{6}Z/);
```

plus a test that saves three times in a row and asserts the parsed start is unchanged. Assert on the stored bytes, not only the parsed value — the parsed value is still correct after one save and only diverges from the second.

## Task 3 — Issue #50: header authentication bypass. P1.

https://github.com/FreeshardBase/calendar/issues/50

`server/index.js:60-62` still trusts `x-test-user-id` in production, ungated by `NODE_ENV`. Lines 63-69 added a second route: when `AUTH_METHOD=oidc` or `HTTP_HEADER_AUTH=true`, the app takes its identity from `x-forwarded-user`, `x-user-id`, `remote-user` or `x-ptl-client-id` with no check that a trusted proxy set them and no check that the client did not.

On a shard every co-resident app container can reach `webcalendar:3000` on the `portal` network, so this is reachable by any neighbour app.

This nullifies the ownership checks added for #155 and #234: `checkCalendarAccess(..., 'owner')` is correct, but it reads `req.session.userId`, which this lets the caller choose.

Reproduced against `NODE_ENV=production AUTH_METHOD=oidc` with real random secrets and the internal CalDAV account injected as it is on a shard:

| Request | Result |
|---|---|
| `GET /` unauthenticated (control A) | `302` → `/api/auth/login` |
| `GET /api/calendars` no header (control B) | `401` |
| `GET /api/calendars` + `X-Test-User-Id: victim-0001` | `502`, served as that user |
| `GET /api/calendars` + `X-Forwarded-User: victim-0001` | `502`, identical |
| `POST /api/calendars` + `X-Test-User-Id: victim-0001` | `400`, not `401` |

Gate `x-test-user-id` on `NODE_ENV === 'test'`. For the forwarded-user headers, either remove the branch or require a shared secret that the proxy sets and an app container cannot guess. Reaching the app over the `portal` network must not be sufficient to assert an identity.

**Done when:** the table above is re-run and rows 3 to 5 all return `401`, while controls A and B still return `302` and `401`. Controls A and B are what make the result meaningful; report all five rows, not only the fixed ones.

## Task 4 — Reconcile the branches.

`main` is the default branch and is still at cd1e945 from 12 August. `master` carries a week of work. Nothing merges them, so none of the work is on the branch the repository presents by default.

Merge `master` into `main`, or make `master` the default branch, and then use one branch. State which was done.

**Done when:** `git rev-list --count main..master` is 0, or the repository's default branch is `master`.

## Task 5 — Raise the mutation score on `eventToICS`.

Mutation testing is wired: `npm run test:mutation`, added in PR #326 with the threshold set in PR #327. The measured baseline over `server/utils/ical.js` and `server/caldav/parser.js` is **36.62 %** — 1139 killed, 916 survived, 1073 uncovered, 3273 mutants, 22 minutes at concurrency 2.

`eventToICS` is the least-defended function in the codebase and the most important: **474 of its 601 mutants go unkilled**, 307 of them not reached by any test. That is how a per-save timezone corruption shipped with a green suite. `fmtDateTime` kills 6 of 34, which is the same hole seen from the other side.

Known survivors to kill first, all in `updateWholeSeries`, all of which leave `whole_series_preservation.test.js` green today:

- emptying the `EXDATE` preservation loop at `server/utils/ical.js:1055`
- `getAllSubcomponents('vevent')` → `getAllSubcomponents("")`, which makes the function fall back to the old rebuild-from-scratch path — the exact defect the rewrite removed — with both tests still passing
- `const master = vevents.find(...) || vevents[0]` → `&&`
- weakening the `existingIcs.trim()` guard

**Done when:** `npm run test:mutation` reports a higher score for `ical.js` than 36.55 %, those four named mutants are killed, and the run output is in the PR. Raise `thresholds.break` in `stryker.config.json` to just under the new score in the same PR, so the floor ratchets.

## Not now

Do not resume the MEDIUM and LOW board sweep until Tasks 1 to 4 are done. Do not open new issues that only correct or annotate an existing issue; comment on that issue instead. Do not touch the Microsoft Graph subsystem — the standing recommendation is to cut it, and it is not worth fixing before that decision is made.
