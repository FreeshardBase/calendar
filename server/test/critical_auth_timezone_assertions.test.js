'use strict';

/**
 * Issue #218 — Critical Auth & Timezone Test Assertions (Prevent Vacuous Green Suite)
 *
 * This test suite enforces non-vacuous assertions for:
 * 1. Strict authentication & authorization enforcement on all API routes and authorization helpers.
 * 2. Defense against cross-tenant calendar parameter spoofing and malformed inputs.
 * 3. Exact timezone precision for standard, fractional (30m/45m offset), and fallback timezones.
 * 4. iCalendar serialization and parsing invariants across floating, UTC, and TZID-qualified events.
 */

process.env.NODE_ENV = 'test';
process.env.TZ = process.env.TZ || 'Europe/Berlin';
process.env.PORT = process.env.PORT || '3130';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { checkCalendarAccess, extractCalendarIdFromHref } = require('../utils/calendarAuth');
const {
  getTimezoneOffsetMinutes,
  getTimezoneAbbr,
  formatTimezoneHeader,
  getDualHourLabel,
  SUPPORTED_TIMEZONES
} = require('../utils/timezoneGrid');
const {
  eventToICS,
  parseICSToEvent,
  buildVTimezoneBlock
} = require('../utils/ical');
const { app, server } = require('../index');

const baseUrl = `http://localhost:${process.env.PORT}`;

test('Issue #218 — Critical Auth & Timezone Test Assertions Suite', async (t) => {
  t.before(async () => {
    if (!server.listening) {
      await new Promise((resolve) => server.listen(process.env.PORT, resolve));
    }
  });

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll().catch(() => {});

  // ─────────────────────────────────────────────────────────────────────────────
  // PART 1: CRITICAL AUTHENTICATION & ACCESS CONTROL ASSERTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  await t.test('Auth Guard: checkCalendarAccess rejects unauthenticated & malformed requests strictly', async () => {
    // 1. Missing session / empty session
    const res1 = await checkCalendarAccess({}, 'internal-caldav::/owner/personal/', 'read');
    assert.equal(res1.allowed, false, 'Unauthenticated request must not be allowed');
    assert.equal(res1.status, 401, 'Unauthenticated request must return status 401');
    assert.ok(res1.reason, 'Must provide an explicit error reason');

    const res2 = await checkCalendarAccess({ session: {} }, 'internal-caldav::/owner/personal/', 'read');
    assert.equal(res2.allowed, false);
    assert.equal(res2.status, 401);

    // 2. Missing calendarId
    const res3 = await checkCalendarAccess({ session: { userId: 'user1' } }, null, 'read');
    assert.equal(res3.allowed, false);
    assert.equal(res3.status, 400);

    // 3. Malformed calendarId (missing separator)
    const res4 = await checkCalendarAccess({ session: { userId: 'user1' } }, 'invalid-calendar-id', 'read');
    assert.equal(res4.allowed, false);
    assert.equal(res4.status, 400);

    // 4. Malformed internal href (missing owner segment)
    const res5 = await checkCalendarAccess({ session: { userId: 'user1' } }, 'internal-caldav::/', 'read');
    assert.equal(res5.allowed, false);
    assert.equal(res5.status, 400);
  });

  await t.test('Auth Guard: checkCalendarAccess strictly enforces owner vs shared access levels', async () => {
    const ownerId = 'auth-owner-uuid';
    const strangerId = 'auth-stranger-uuid';
    const readerId = 'auth-reader-uuid';
    const calId = `internal-caldav::/${ownerId}/work/`;

    await Db.upsertUser(ownerId, 'owner-218@example.com');
    await Db.upsertUser(strangerId, 'stranger-218@example.com');
    await Db.upsertUser(readerId, 'reader-218@example.com');
    await Db.addUserShare(calId, readerId, false); // read-only share

    // Stranger access attempt -> 403
    const reqStranger = { session: { userId: strangerId, accounts: [{ id: 'internal-caldav' }] } };
    const strangerRead = await checkCalendarAccess(reqStranger, calId, 'read');
    assert.equal(strangerRead.allowed, false);
    assert.equal(strangerRead.status, 403);

    // Reader write attempt -> 403
    const reqReader = { session: { userId: readerId, accounts: [{ id: 'internal-caldav' }] } };
    const readerWrite = await checkCalendarAccess(reqReader, calId, 'write');
    assert.equal(readerWrite.allowed, false);
    assert.equal(readerWrite.status, 403);
    assert.equal(readerWrite.reason, 'Read-only calendar access: modification prohibited');

    // Reader owner action attempt -> 403
    const readerOwner = await checkCalendarAccess(reqReader, calId, 'owner');
    assert.equal(readerOwner.allowed, false);
    assert.equal(readerOwner.status, 403);
    assert.equal(readerOwner.reason, 'Owner permission required for this action');
  });

  await t.test('Href Parser: extractCalendarIdFromHref accurately parses and validates href paths', () => {
    assert.equal(
      extractCalendarIdFromHref('internal-caldav', '/testuser/personal/event.ics'),
      'internal-caldav::/testuser/personal/'
    );
    assert.equal(
      extractCalendarIdFromHref('internal-caldav', 'https://localhost:5232/testuser/work/meeting.ics'),
      'internal-caldav::/testuser/work/'
    );
    assert.equal(extractCalendarIdFromHref('internal-caldav', null), null);
    assert.equal(extractCalendarIdFromHref('internal-caldav', '/invalid'), null);
  });

  await t.test('HTTP API Auth Enforcement: Protected endpoints reject unauthenticated calls with 401', async () => {
    const endpoints = [
      { method: 'GET', path: '/api/calendars' },
      { method: 'POST', path: '/api/calendars', body: { name: 'New Cal' } },
      { method: 'GET', path: '/api/events' },
      { method: 'POST', path: '/api/events', body: { title: 'Test' } },
      { method: 'PUT', path: '/api/events/test-uid', body: { title: 'Test' } },
      { method: 'DELETE', path: '/api/events/test-uid' },
      { method: 'GET', path: '/api/tasks' },
      { method: 'POST', path: '/api/tasks', body: { title: 'Task' } },
      { method: 'POST', path: '/api/calendars/export/pdf', body: {} },
      { method: 'POST', path: '/api/calendars/internal-caldav::%2Fuser%2Fcal%2F/delta-sync', body: {} },
      { method: 'GET', path: '/api/calendars/internal-caldav::%2Fuser%2Fcal%2F/shares-public' },
      { method: 'POST', path: '/api/calendars/internal-caldav::%2Fuser%2Fcal%2F/shares-public', body: {} }
    ];

    for (const ep of endpoints) {
      const opts = {
        method: ep.method,
        headers: {
          'Content-Type': 'application/json',
          'x-test-user-id': 'unauthenticated'
        }
      };
      if (ep.body) opts.body = JSON.stringify(ep.body);

      const res = await fetch(`${baseUrl}${ep.path}`, opts);
      assert.equal(res.status, 401, `${ep.method} ${ep.path} must return 401 Unauthorized without session cookie`);
      const body = await res.json().catch(() => ({}));
      assert.ok(body.error, `${ep.method} ${ep.path} response body must contain an explicit error string`);
    }
  });


  // ─────────────────────────────────────────────────────────────────────────────
  // PART 2: CRITICAL TIMEZONE PRECISION & FRACTIONAL OFFSET ASSERTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  await t.test('Timezone Math: Handles fractional 30-min and 45-min offset timezones correctly', () => {
    const winterDate = new Date('2026-01-15T12:00:00Z');

    // 1. Asia/Kolkata (UTC+5:30 -> +330 min)
    const kolkataOffset = getTimezoneOffsetMinutes('Asia/Kolkata', winterDate);
    assert.equal(kolkataOffset, 330, 'Asia/Kolkata offset must be +330 minutes');

    // 2. Asia/Kathmandu (UTC+5:45 -> +345 min)
    const kathmanduOffset = getTimezoneOffsetMinutes('Asia/Kathmandu', winterDate);
    assert.equal(kathmanduOffset, 345, 'Asia/Kathmandu offset must be +345 minutes');

    // 3. Australia/Adelaide (UTC+9:30 in winter / UTC+10:30 in ACDT summer)
    const adelaideWinterOffset = getTimezoneOffsetMinutes('Australia/Adelaide', winterDate);
    assert.equal(adelaideWinterOffset, 630, 'Australia/Adelaide (ACDT) offset on Jan 15 must be +630 minutes (+10:30)');

    // 4. Dual hour label formatting with fractional minute timezones
    // Primary: Europe/Berlin (UTC+1 winter), Secondary: Asia/Kolkata (UTC+5:30)
    // 10:00 Berlin -> 09:00 UTC -> 14:30 Kolkata
    const dualKolkata = getDualHourLabel(10, winterDate, 'Europe/Berlin', 'Asia/Kolkata');
    assert.equal(dualKolkata.primary, '10:00');
    assert.equal(dualKolkata.secondary, '14:30', 'Berlin 10:00 must convert to Kolkata 14:30');

    // Primary: Europe/Berlin (UTC+1 winter), Secondary: Asia/Kathmandu (UTC+5:45)
    // 10:00 Berlin -> 09:00 UTC -> 14:45 Kathmandu
    const dualKathmandu = getDualHourLabel(10, winterDate, 'Europe/Berlin', 'Asia/Kathmandu');
    assert.equal(dualKathmandu.primary, '10:00');
    assert.equal(dualKathmandu.secondary, '14:45', 'Berlin 10:00 must convert to Kathmandu 14:45');
  });

  await t.test('VTIMEZONE Builder: Validates component structure and invalid timezone fallbacks', () => {
    // 1. Kolkata VTIMEZONE component structure
    const block = buildVTimezoneBlock('Asia/Kolkata');
    assert.ok(block.includes('BEGIN:VTIMEZONE'), 'Must include BEGIN:VTIMEZONE');
    assert.ok(block.includes('TZID:Asia/Kolkata'), 'Must include TZID:Asia/Kolkata');
    assert.ok(block.includes('TZOFFSETFROM:+0530'), 'Must include correct TZOFFSETFROM');
    assert.ok(block.includes('TZOFFSETTO:+0530'), 'Must include correct TZOFFSETTO');

    // 2. Invalid timezone fallback handling without unhandled error
    const fallbackBlock = buildVTimezoneBlock('NonExistent/Timezone_123');
    assert.equal(typeof fallbackBlock, 'string');
    assert.ok(fallbackBlock.includes('BEGIN:VTIMEZONE'));
    assert.ok(fallbackBlock.includes('TZID:NonExistent/Timezone_123'));
  });

  await t.test('iCalendar Serialization: Strict floating vs UTC vs TZID event semantics', () => {
    // 1. Floating event (no timezone specified)
    const floatingEv = {
      uid: 'floating-218',
      title: 'Floating Meeting',
      start: '2026-06-15T09:00:00.000',
      end: '2026-06-15T10:00:00.000',
      allDay: false
    };
    const floatingIcs = eventToICS(floatingEv);
    assert.ok(!floatingIcs.includes('BEGIN:VTIMEZONE'), 'Floating event must not contain VTIMEZONE');
    assert.ok(!floatingIcs.includes('TZID='), 'Floating event must not contain TZID parameter');
    assert.ok(floatingIcs.includes('DTSTART:20260615T090000'), 'Floating DTSTART must be plain local time');

    // 2. UTC event (Z suffix)
    const utcEv = {
      uid: 'utc-218',
      title: 'UTC Meeting',
      start: '2026-06-15T09:00:00.000Z',
      end: '2026-06-15T10:00:00.000Z',
      allDay: false
    };
    const utcIcs = eventToICS(utcEv);
    assert.ok(!utcIcs.includes('BEGIN:VTIMEZONE'), 'UTC event must not contain VTIMEZONE');
    assert.ok(utcIcs.includes('DTSTART:20260615T090000Z'), 'UTC DTSTART must have Z suffix');

    // 3. TZID event
    const tzidEv = {
      uid: 'tzid-218',
      title: 'Berlin Meeting',
      start: '2026-06-15T09:00:00.000Z',
      end: '2026-06-15T10:00:00.000Z',
      allDay: false,
      startTimeZone: 'Europe/Berlin',
      endTimeZone: 'Europe/Berlin'
    };
    const tzidIcs = eventToICS(tzidEv);
    assert.ok(tzidIcs.includes('BEGIN:VTIMEZONE'), 'TZID event must contain VTIMEZONE block');
    assert.ok(tzidIcs.includes('DTSTART;TZID=Europe/Berlin:'), 'DTSTART must contain TZID parameter');
  });

  await t.test('iCalendar Parser: Roundtrip preservation of TZID wall-clock and timezone parameters', () => {
    const origEvent = {
      uid: 'parser-rt-218',
      title: 'Tokyo Sync',
      start: '2026-09-01T01:00:00.000Z', // 10:00 JST (UTC+9)
      end: '2026-09-01T02:00:00.000Z',
      allDay: false,
      startTimeZone: 'Asia/Tokyo',
      endTimeZone: 'Asia/Tokyo'
    };

    const ics = eventToICS(origEvent);
    const parsed = parseICSToEvent(ics);

    assert.equal(parsed.uid, 'parser-rt-218');
    assert.equal(parsed.title, 'Tokyo Sync');
    assert.equal(parsed.startTimeZone, 'Asia/Tokyo');
    assert.equal(parsed.endTimeZone, 'Asia/Tokyo');
    assert.equal(new Date(parsed.start).toISOString(), '2026-09-01T01:00:00.000Z');
  });

});
