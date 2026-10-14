'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3138';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const CalDAVClient = require('../caldav/client');
const Db = require('../db');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');
const { isNoOpEventSave, updateWholeSeries, parseICSToEvent, parseAndExpandEvent } = require('../caldav/parser');

test('Issue #238 — No-Op Save on Recurring Event Preserves Stored Bytes, EXDATE, Overrides and Timezones', async (t) => {
  const mockStore = new Map();
  let putCount = 0;

  const originalGet = CalDAVClient.prototype.get;
  const originalPut = CalDAVClient.prototype.put;

  CalDAVClient.prototype.get = async function(url) {
    if (mockStore.has(url)) {
      return mockStore.get(url);
    }
    const err = new Error('HTTP 404 Not Found');
    err.status = 404;
    throw err;
  };

  CalDAVClient.prototype.put = async function(url, ics, ifMatch) {
    putCount++;
    const etag = '"etag-v' + putCount + '"';
    const record = { ics, etag };
    mockStore.set(url, record);
    return record;
  };

  t.after(() => {
    CalDAVClient.prototype.get = originalGet;
    CalDAVClient.prototype.put = originalPut;
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll();

  const recurringIcsWithAllFeatures = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FreeShard//WebCalendar//EN',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Berlin',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:recurring-238-master',
    'SUMMARY:Weekly Team Sync',
    'DESCRIPTION:Weekly status sync',
    'LOCATION:Room 404',
    'DTSTART;TZID=Europe/Berlin:20260901T100000',
    'DTEND;TZID=Europe/Berlin:20260901T110000',
    'RRULE:FREQ=WEEKLY;BYDAY=TU;INTERVAL=1',
    'EXDATE;TZID=Europe/Berlin:20260908T100000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:recurring-238-master',
    'RECURRENCE-ID;TZID=Europe/Berlin:20260915T100000',
    'SUMMARY:Special Team Sync (Moved)',
    'DTSTART;TZID=Europe/Berlin:20260915T140000',
    'DTEND;TZID=Europe/Berlin:20260915T150000',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  await t.test('isNoOpEventSave recognizes zero-edit payload on complex recurring event', () => {
    const parsedEvent = parseICSToEvent(recurringIcsWithAllFeatures);
    assert.ok(parsedEvent, 'parseICSToEvent must successfully parse recurring ICS');

    const incomingPayload = {
      uid: parsedEvent.uid,
      title: parsedEvent.title,
      start: parsedEvent.start,
      end: parsedEvent.end,
      allDay: parsedEvent.allDay,
      location: parsedEvent.location,
      description: parsedEvent.description,
      recurrence: parsedEvent.recurrence
    };

    const isNoOp = isNoOpEventSave(recurringIcsWithAllFeatures, incomingPayload);
    assert.equal(isNoOp, true, 'isNoOpEventSave must return true for identical recurring event payload');
  });

  await t.test('PUT /api/events/:uid with no-op recurring payload short-circuits without CalDAV PUT call', async () => {
    const baseUrl = `http://localhost:${process.env.PORT}`;
    const testUserId = 'test-user-238';
    await Db.upsertUser(testUserId, 'user238@example.com');

    const cookie = await loginAs(testUserId, { email: 'user238@example.com' });
    const authRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie }
    });
    assert.equal(authRes.status, 200);
    const calendarId = `env-default::/users/${testUserId}/calendars/personal/`;

    const uid = 'recurring-238-master';
    const eventUrl = `http://localhost:1080/users/${testUserId}/calendars/personal/${uid}.ics`;

    mockStore.set(eventUrl, { ics: recurringIcsWithAllFeatures, etag: '"initial-etag-238"' });
    putCount = 0;

    const parsedEvent = parseICSToEvent(recurringIcsWithAllFeatures);

    const putRes = await fetch(`${baseUrl}/api/events/${uid}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        calendarId,
        href: `/users/${testUserId}/calendars/personal/${uid}.ics`,
        etag: 'initial-etag-238',
        title: parsedEvent.title,
        start: parsedEvent.start,
        end: parsedEvent.end,
        allDay: parsedEvent.allDay,
        location: parsedEvent.location,
        description: parsedEvent.description,
        recurrence: parsedEvent.recurrence
      })
    });

    assert.equal(putRes.status, 200, 'PUT response must be 200 OK');
    assert.equal(putCount, 0, 'No-op save MUST short-circuit and NOT call CalDAV PUT');

    const storedRecord = mockStore.get(eventUrl);
    assert.equal(storedRecord.ics, recurringIcsWithAllFeatures, 'Stored ICS bytes must remain completely untouched');
  });

  await t.test('updateWholeSeries preserves EXDATE, detached overrides, VTIMEZONE, and RRULE without drift', () => {
    const parsedEvent = parseICSToEvent(recurringIcsWithAllFeatures);
    const updatedPayload = {
      ...parsedEvent,
      title: 'Weekly Team Sync (Updated Title)'
    };

    const updatedIcs = updateWholeSeries(recurringIcsWithAllFeatures, updatedPayload);

    assert.ok(updatedIcs.includes('SUMMARY:Weekly Team Sync (Updated Title)'), 'Updated title must be present');
    assert.ok(updatedIcs.includes('EXDATE'), 'EXDATE must be preserved');
    assert.ok(updatedIcs.includes('SUMMARY:Special Team Sync (Moved)'), 'Detached override VEVENT summary must be preserved');
    assert.ok(updatedIcs.includes('RECURRENCE-ID'), 'Detached RECURRENCE-ID must be preserved');
    assert.ok(updatedIcs.includes('TZID:Europe/Berlin'), 'VTIMEZONE TZID must be preserved');
    assert.ok(updatedIcs.includes('RRULE:FREQ=WEEKLY'), 'RRULE must be preserved');

    assert.doesNotMatch(updatedIcs, /DTSTART;TZID=[^:]+:\d{8}T\d{6}Z/, 'Must not mix TZID with Z suffix on DTSTART');
    assert.doesNotMatch(updatedIcs, /DTEND;TZID=[^:]+:\d{8}T\d{6}Z/, 'Must not mix TZID with Z suffix on DTEND');
  });

  // The issue's `man0` series, stored with UTC values and no VTIMEZONE.
  const man0Ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//t//EN',
    'BEGIN:VEVENT',
    'UID:man0',
    'SUMMARY:man0',
    'DTSTART:20260813T100000Z',
    'DTEND:20260813T110000Z',
    'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const man0TestUser = 'test-user-238-man0';
  const man0Href = `/users/${man0TestUser}/calendars/personal/man0.ics`;
  const man0Url = `http://localhost:1080${man0Href}`;
  const man0CalendarId = `env-default::/users/${man0TestUser}/calendars/personal/`;
  let man0Cookie;

  // The chip the grid hands the modal for the 2026-08-24 occurrence.
  const laterChip = () => {
    const chip = parseAndExpandEvent(man0Ics, new Date('2026-08-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z'))
      .find(e => e.recurrenceId && e.recurrenceId.startsWith('2026-08-24'));
    assert.ok(chip, 'expansion must yield the 2026-08-24 occurrence');
    assert.equal(chip.start, '2026-08-24T10:00:00.000Z');
    return chip;
  };

  const putMan0 = async (uid, body) => {
    if (!man0Cookie) {
      await Db.upsertUser(man0TestUser, 'testuser@example.com');
      man0Cookie = await loginAs(man0TestUser, { email: 'testuser@example.com' });
      const authRes = await fetch(`http://localhost:${process.env.PORT}/api/accounts`, {
        headers: { cookie: man0Cookie }
      });
      assert.equal(authRes.status, 200);
    }
    mockStore.set(man0Url, { ics: man0Ics, etag: '"man0-etag"' });
    putCount = 0;
    return fetch(`http://localhost:${process.env.PORT}/api/events/${encodeURIComponent(uid)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Cookie': man0Cookie },
      body: JSON.stringify({ calendarId: man0CalendarId, href: man0Href, etag: 'man0-etag', ...body })
    });
  };

  const chipPayload = (chip, overrides = {}) => ({
    uid: chip.uid,
    recurrenceId: chip.recurrenceId,
    title: chip.title,
    start: chip.start,
    end: chip.end,
    allDay: chip.allDay,
    startTimeZone: 'UTC',
    recurrence: chip.recurrence,
    ...overrides
  });

  await t.test('zero-edit series save from a later occurrence leaves the stored series untouched (defect 2, #79)', async () => {
    const chip = laterChip();
    const res = await putMan0(chip.uid, { ...chipPayload(chip), scope: 'series' });
    assert.equal(res.status, 200);
    assert.equal(putCount, 0, 'zero-edit series save must not write to CalDAV');
    assert.equal(mockStore.get(man0Url).ics, man0Ics, 'stored bytes must stay identical');
  });

  await t.test('series retitle from a later occurrence keeps master DTSTART and RRULE (defects 1+2)', async () => {
    const chip = laterChip();
    const res = await putMan0(chip.uid, { ...chipPayload(chip, { title: 'man0 retitled' }), scope: 'series' });
    assert.equal(res.status, 200);
    assert.equal(putCount, 1);
    const stored = mockStore.get(man0Url).ics;
    assert.match(stored, /SUMMARY:man0 retitled/);
    assert.match(stored, /DTSTART(;TZID=UTC)?:20260813T100000Z?\r\n/, `master DTSTART must stay on 20260813, got:\n${stored}`);
    assert.doesNotMatch(stored, /DTSTART[^\r\n]*:20260824/, 'master must not be re-anchored to the clicked occurrence');
    assert.match(stored, /RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO/);
  });

  await t.test('series retitle sent with the master start (no recurrenceId) keeps the off-pattern BYDAY', async () => {
    const master = parseICSToEvent(man0Ics);
    assert.equal(master.start, '2026-08-13T10:00:00.000Z');
    const res = await putMan0('man0', {
      title: 'man0 retitled', start: master.start, end: master.end, allDay: false,
      startTimeZone: 'UTC', recurrence: master.recurrence, scope: 'series'
    });
    assert.equal(res.status, 200);
    const stored = mockStore.get(man0Url).ics;
    assert.match(stored, /SUMMARY:man0 retitled/);
    assert.match(stored, /RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO\r\n/, `BYDAY must not follow the Thursday DTSTART:\n${stored}`);
  });

  // The modal re-syncs BYDAY to the new weekday on a date move (BYDAY=TU); an
  // API client may send the stored rule unchanged (BYDAY=MO). Both mean Tuesdays.
  for (const sentRule of ['FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO']) {
    await t.test(`moving the off-pattern series +1 day from a later occurrence (client sends ${sentRule}) recurs on Tuesdays`, async () => {
      const chip = laterChip();
      const res = await putMan0(chip.uid, {
        ...chipPayload(chip, { start: '2026-08-25T10:00:00.000Z', end: '2026-08-25T11:00:00.000Z', recurrence: sentRule }),
        scope: 'series'
      });
      assert.equal(res.status, 200);
      const stored = mockStore.get(man0Url).ics;
      assert.match(stored, /DTSTART(;TZID=UTC)?:20260814T100000Z?\r\n/, `master must shift by the delta:\n${stored}`);
      assert.match(stored, /RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU\r\n/, `Monday occurrences moved +1 day recur on Tuesdays:\n${stored}`);
    });
  }

  // Every TZID parameter must resolve to a VTIMEZONE in the same resource (RFC 5545 §3.2.19).
  const danglingTzids = (ics) => {
    const used = new Set([...ics.matchAll(/;TZID=([^;:]+)[;:]/g)].map(m => m[1]));
    const defined = new Set([...ics.matchAll(/BEGIN:VTIMEZONE\r\nTZID:([^\r\n]+)/g)].map(m => m[1]));
    return [...used].filter(tz => !defined.has(tz));
  };

  // Read stored bytes the way any other CalDAV client would: a fresh process
  // with only the VTIMEZONE blocks the file itself carries.
  const overrideStartFromFreshProcess = (ics) => {
    const { execFileSync } = require('node:child_process');
    const script = `
      const ICAL = require('ical.js');
      const comp = new ICAL.Component(ICAL.parse(require('fs').readFileSync(0, 'utf8')));
      for (const tz of comp.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz);
      const ov = comp.getAllSubcomponents('vevent').find(v => v.getFirstProperty('recurrence-id'));
      process.stdout.write(ov.getFirstPropertyValue('dtstart').toJSDate().toISOString());
    `;
    // A host zone unlike the TZIDs under test, so a floating read-back cannot pass by accident.
    return execFileSync(process.execPath, ['-e', script], {
      input: ics, cwd: __dirname, env: { ...process.env, TZ: 'America/New_York' }
    }).toString();
  };

  for (const tz of ['Europe/Berlin', 'UTC']) {
    await t.test(`occurrence save with startTimeZone=${tz} stores a VTIMEZONE for every TZID (defect 3, #52)`, async () => {
      const chip = laterChip();
      const res = await putMan0(chip.uid, {
        ...chipPayload(chip, {
          title: 'man0 (this one only)',
          start: '2026-08-24T12:00:00.000Z',
          end: '2026-08-24T13:00:00.000Z',
          startTimeZone: tz
        }),
        scope: 'occurrence'
      });
      assert.equal(res.status, 200);
      assert.equal(putCount, 1);
      const stored = mockStore.get(man0Url).ics;
      assert.match(stored, new RegExp(`DTSTART;TZID=${tz.replace('/', '\\/')}:`), `override must carry TZID=${tz}:\n${stored}`);
      assert.match(stored, /RECURRENCE-ID[^\r\n]*:20260824T100000/);
      assert.deepEqual(danglingTzids(stored), [], `no TZID may dangle without a VTIMEZONE:\n${stored}`);
      assert.doesNotMatch(stored, /;TZID=[^:]+:\d{8}T\d{6}Z/, 'no TZID-qualified value may carry a Z suffix');
      assert.equal(overrideStartFromFreshProcess(stored), '2026-08-24T12:00:00.000Z',
        'override must read back at the intended instant off disk');
      // Series itself is untouched by an occurrence save.
      assert.match(stored, /DTSTART:20260813T100000Z\r\n/);
      assert.match(stored, /RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO/);
    });
  }
});
