'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3342';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

// #242: a whole-series save started from a detached override carries the
// override's own values (the modal is filled from the override). Fields the
// user did not change must not be promoted onto the master.

const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const CalDAVClient = require('../caldav/client');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');
const { updateWholeSeries, parseAndExpandEvent } = require('../utils/ical');

const UID = 'series-242-promo';

const FIXTURE = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  `UID:${UID}`,
  'DTSTART:20260805T090000Z', 'DTEND:20260805T100000Z',
  'RRULE:FREQ=WEEKLY;BYDAY=WE',
  'EXDATE:20260812T090000Z',
  'SUMMARY:Team Meeting',
  'LOCATION:Room 1',
  'DESCRIPTION:series note',
  'CATEGORIES:Work',
  'ATTENDEE;CN=Test User;PARTSTAT=ACCEPTED:mailto:testuser@example.com',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Team Meeting', 'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  `UID:${UID}`,
  'RECURRENCE-ID:20260819T090000Z',
  'DTSTART:20260819T090000Z', 'DTEND:20260819T100000Z',
  'SUMMARY:Dentist',
  'LOCATION:Dental Practice',
  'DESCRIPTION:override note',
  'CATEGORIES:Private',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT1H', 'DESCRIPTION:Dentist', 'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

// What the modal posts after opening the 19 Aug chip and pressing Save with
// zero edits, answered "Ganze Serie" (public/js/eventModal.js payload).
function overridePayload(overrides = {}) {
  return {
    uid: UID,
    title: 'Dentist',
    start: '2026-08-19T09:00:00.000Z',
    end: '2026-08-19T10:00:00.000Z',
    allDay: false,
    location: 'Dental Practice',
    description: 'override note',
    categories: ['Private'],
    attendees: [],
    recurrence: 'FREQ=WEEKLY;BYDAY=WE',
    alarms: [{ action: 'DISPLAY', trigger: '-PT1H', description: 'Dentist' }],
    attachments: [],
    startTimeZone: null,
    endTimeZone: null,
    scope: 'series',
    recurrenceId: '20260819T090000Z',
    ...overrides
  };
}

function masterOf(ics) {
  const comp = new ICAL.Component(ICAL.parse(ics));
  return comp.getAllSubcomponents('vevent').find(v => !v.getFirstProperty('recurrence-id'));
}

function occurrences(ics) {
  return parseAndExpandEvent(ics, '2026-08-01T00:00:00.000Z', '2026-09-10T00:00:00.000Z')
    .map(e => ({ day: e.start.slice(0, 10), title: e.title, location: e.location }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

const UNTOUCHED = [
  { day: '2026-08-05', title: 'Team Meeting', location: 'Room 1' },
  { day: '2026-08-19', title: 'Dentist', location: 'Dental Practice' },
  { day: '2026-08-26', title: 'Team Meeting', location: 'Room 1' },
  { day: '2026-09-02', title: 'Team Meeting', location: 'Room 1' },
  { day: '2026-09-09', title: 'Team Meeting', location: 'Room 1' }
];

function assertMasterUnchanged(ics) {
  const m = masterOf(ics);
  assert.equal(m.getFirstPropertyValue('summary'), 'Team Meeting');
  assert.equal(m.getFirstPropertyValue('location'), 'Room 1');
  assert.equal(m.getFirstPropertyValue('description'), 'series note');
  assert.deepEqual(m.getAllProperties('categories').flatMap(p => p.getValues()), ['Work']);
  const attendees = m.getAllProperties('attendee').map(p => p.getFirstValue().replace(/^mailto:/i, ''));
  assert.deepEqual(attendees, ['testuser@example.com']);
  const triggers = m.getAllSubcomponents('valarm').map(a => a.getFirstPropertyValue('trigger').toString());
  assert.deepEqual(triggers, ['-PT15M']);
  assert.equal(m.getFirstPropertyValue('dtstart').toJSDate().toISOString(), '2026-08-05T09:00:00.000Z');
  assert.deepEqual(occurrences(ics), UNTOUCHED);
}

test('Issue #242 — series save from a detached override does not promote the override', async (t) => {
  t.after(() => { if (server && server.close) server.close(); });

  await t.test('sanity: fixture expands to the expected occurrence set', () => {
    assert.deepEqual(occurrences(FIXTURE), UNTOUCHED);
  });

  await t.test('updateWholeSeries: zero-edit override-valued payload leaves master content alone', () => {
    assertMasterUnchanged(updateWholeSeries(FIXTURE, overridePayload()));
  });

  await t.test('updateWholeSeries: only the field the user edited reaches the master', () => {
    const ics = updateWholeSeries(FIXTURE, overridePayload({ title: 'Weekly Sync' }));
    const m = masterOf(ics);
    assert.equal(m.getFirstPropertyValue('summary'), 'Weekly Sync');
    assert.equal(m.getFirstPropertyValue('location'), 'Room 1', 'unedited LOCATION must stay the master\'s');
    assert.equal(m.getFirstPropertyValue('description'), 'series note');
    const triggers = m.getAllSubcomponents('valarm').map(a => a.getFirstPropertyValue('trigger').toString());
    assert.deepEqual(triggers, ['-PT15M'], 'unedited alarm must stay the master\'s');
    const occ = occurrences(ics);
    assert.deepEqual(occ.map(o => o.title),
      ['Weekly Sync', 'Dentist', 'Weekly Sync', 'Weekly Sync', 'Weekly Sync']);
  });

  await t.test('updateWholeSeries: an edited location from the override is applied', () => {
    const m = masterOf(updateWholeSeries(FIXTURE, overridePayload({ location: 'Room 2' })));
    assert.equal(m.getFirstPropertyValue('location'), 'Room 2');
    assert.equal(m.getFirstPropertyValue('summary'), 'Team Meeting');
  });

  await t.test('updateWholeSeries: edited description, categories, alarm and attendees from the override are applied', () => {
    const m = masterOf(updateWholeSeries(FIXTURE, overridePayload({
      description: 'new agenda',
      categories: ['Team'],
      alarms: [{ action: 'DISPLAY', trigger: '-PT30M', description: 'Dentist' }],
      attendees: [{ name: 'Test User', email: 'testuser2@example.com', status: 'NEEDS-ACTION' }]
    })));
    assert.equal(m.getFirstPropertyValue('description'), 'new agenda');
    assert.deepEqual(m.getAllProperties('categories').flatMap(p => p.getValues()), ['Team']);
    assert.deepEqual(m.getAllSubcomponents('valarm').map(a => a.getFirstPropertyValue('trigger').toString()), ['-PT30M']);
    assert.deepEqual(m.getAllProperties('attendee').map(p => p.getFirstValue().replace(/^mailto:/i, '')),
      ['testuser2@example.com']);
    assert.equal(m.getFirstPropertyValue('summary'), 'Team Meeting');
    assert.equal(m.getFirstPropertyValue('location'), 'Room 1');
  });

  await t.test('updateWholeSeries: a series save from a non-overridden occurrence still applies its values', () => {
    const ics = updateWholeSeries(FIXTURE, overridePayload({
      title: 'Renamed', location: 'Room 1', description: 'series note', categories: ['Work'],
      alarms: [{ action: 'DISPLAY', trigger: '-PT15M', description: 'Renamed' }],
      start: '2026-08-26T09:00:00.000Z', end: '2026-08-26T10:00:00.000Z',
      recurrenceId: '20260826T090000Z'
    }));
    assert.equal(masterOf(ics).getFirstPropertyValue('summary'), 'Renamed');
  });

  await t.test('updateWholeSeries: shifting a moved override keeps the master\'s duration', () => {
    // Override moved to 14:00-16:00; the user shifts it by +1h, so the modal
    // posts 15:00-17:00 (the override's 2h length, echoed back).
    const moved = FIXTURE
      .replace('DTSTART:20260819T090000Z', 'DTSTART:20260819T140000Z')
      .replace('DTEND:20260819T100000Z', 'DTEND:20260819T160000Z');
    const ics = updateWholeSeries(moved, overridePayload({
      start: '2026-08-19T15:00:00.000Z', end: '2026-08-19T17:00:00.000Z'
    }));
    const m = masterOf(ics);
    assert.equal(m.getFirstPropertyValue('dtstart').toJSDate().toISOString(), '2026-08-05T10:00:00.000Z');
    assert.equal(m.getFirstPropertyValue('dtend').toJSDate().toISOString(), '2026-08-05T11:00:00.000Z');
    assert.equal(m.getFirstPropertyValue('summary'), 'Team Meeting');
  });

  const ALL_DAY = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
    'BEGIN:VEVENT', `UID:${UID}-ad`,
    'DTSTART;VALUE=DATE:20260805', 'DTEND;VALUE=DATE:20260806',
    'RRULE:FREQ=WEEKLY;BYDAY=WE', 'SUMMARY:Office Day', 'LOCATION:HQ',
    'END:VEVENT',
    'BEGIN:VEVENT', `UID:${UID}-ad`,
    'RECURRENCE-ID;VALUE=DATE:20260819',
    'DTSTART;VALUE=DATE:20260819', 'DTEND;VALUE=DATE:20260820',
    'SUMMARY:Holiday', 'LOCATION:Home',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const allDayPayload = (o) => ({
    uid: `${UID}-ad`, start: '2026-08-19', end: '2026-08-20', allDay: true,
    description: null, categories: [], attendees: [], alarms: [], attachments: [],
    recurrence: 'FREQ=WEEKLY;BYDAY=WE', startTimeZone: null, endTimeZone: null,
    scope: 'series', ...o
  });

  await t.test('updateWholeSeries: all-day zero-edit series save from an override keeps the master', () => {
    const ics = updateWholeSeries(ALL_DAY, allDayPayload({
      title: 'Holiday', location: 'Home', recurrenceId: '2026-08-19'
    }));
    const m = masterOf(ics);
    assert.equal(m.getFirstPropertyValue('summary'), 'Office Day');
    assert.equal(m.getFirstPropertyValue('location'), 'HQ');
    assert.equal(m.getFirstPropertyValue('dtstart').toString(), '2026-08-05');
  });

  await t.test('updateWholeSeries: all-day series rename from a plain occurrence applies', () => {
    const ics = updateWholeSeries(ALL_DAY, allDayPayload({
      title: 'Renamed', location: 'HQ', start: '2026-08-26', end: '2026-08-27', recurrenceId: '2026-08-26'
    }));
    assert.equal(masterOf(ics).getFirstPropertyValue('summary'), 'Renamed');
  });

  await t.test('PUT /api/events/:uid with scope=series from the override keeps the master', async () => {
    const store = new Map();
    const originalGet = CalDAVClient.prototype.get;
    const originalPut = CalDAVClient.prototype.put;
    CalDAVClient.prototype.get = async function (url) {
      if (store.has(url)) return store.get(url);
      const err = new Error('HTTP 404 Not Found');
      err.status = 404;
      throw err;
    };
    CalDAVClient.prototype.put = async function (url, ics) {
      const record = { ics, etag: '"etag-after"' };
      store.set(url, record);
      return record;
    };
    t.after(() => {
      CalDAVClient.prototype.get = originalGet;
      CalDAVClient.prototype.put = originalPut;
    });

    await Db.clearAll().catch(() => {});
    const baseUrl = `http://localhost:${process.env.PORT}`;
    const testUserId = 'testuser-242';
    await Db.upsertUser(testUserId, 'testuser@example.com');
    const cookie = await loginAs(testUserId);
    const authRes = await fetch(`${baseUrl}/api/accounts`, { headers: { cookie } });
    assert.equal(authRes.status, 200);

    const href = `/users/${testUserId}/calendars/personal/${UID}.ics`;
    const eventUrl = `http://localhost:1080${href}`;
    store.set(eventUrl, { ics: FIXTURE, etag: '"etag-before"' });

    const { uid: _uid, ...body } = overridePayload();
    const res = await fetch(`${baseUrl}/api/events/${UID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        ...body,
        calendarId: `env-default::/users/${testUserId}/calendars/personal/`,
        href,
        etag: 'etag-before'
      })
    });
    assert.equal(res.status, 200, await res.clone().text());
    assertMasterUnchanged(store.get(eventUrl).ics);
  });
});
