'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3243';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

// Issue #243: after a whole-series save, the stored file must never hold an
// EXDATE value or a RECURRENCE-ID override that the new DTSTART + RRULE does
// not generate — the expander would silently ignore it.

const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const CalDAVClient = require('../caldav/client');
const Db = require('../db');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');
const { updateWholeSeries, parseAndExpandEvent } = require('../caldav/parser');

const UID = 'probe-uid';
const PROBE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Freeshard//WebCalendar//EN',
  'BEGIN:VEVENT',
  `UID:${UID}`,
  'SUMMARY:PROBE',
  'DTSTART:20260805T090000Z',
  'DTEND:20260805T100000Z',
  'RRULE:FREQ=WEEKLY;BYDAY=WE',
  'EXDATE:20260812T090000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  `UID:${UID}`,
  'RECURRENCE-ID:20260819T090000Z',
  'SUMMARY:PROBE-OVR19',
  'DTSTART:20260819T090000Z',
  'DTEND:20260819T100000Z',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

// Series save as public/js/eventModal.js builds it, opened from the 2026-08-26 occurrence.
function seriesPayload(overrides) {
  return {
    uid: UID,
    recurrenceId: '20260826T090000Z',
    title: 'PROBE',
    start: '2026-08-26T09:00:00.000Z',
    end: '2026-08-26T10:00:00.000Z',
    allDay: false,
    recurrence: 'FREQ=WEEKLY;BYDAY=WE',
    ...overrides
  };
}

// Independent of the code under test: walk the stored master's own RRULE.
function ruleGenerates(master, time) {
  const dtstart = master.getFirstPropertyValue('dtstart');
  const rrule = master.getFirstPropertyValue('rrule');
  const target = time.toUnixTime();
  if (dtstart.toUnixTime() === target) return true;
  const rdates = master.getAllProperties('rdate').flatMap(p => p.getValues());
  if (rdates.some(v => v.toUnixTime() === target)) return true;
  if (!rrule) return false;
  const it = rrule.iterator(dtstart);
  let next;
  while ((next = it.next())) {
    const t = next.toUnixTime();
    if (t === target) return true;
    if (t > target) return false;
  }
  return false;
}

function orphans(ics) {
  const comp = new ICAL.Component(ICAL.parse(ics));
  const vevents = comp.getAllSubcomponents('vevent');
  const master = vevents.find(v => !v.getFirstProperty('recurrence-id'));
  const out = [];
  for (const p of master.getAllProperties('exdate')) {
    for (const v of p.getValues()) {
      if (!ruleGenerates(master, v)) out.push(`EXDATE ${v.toString()}`);
    }
  }
  for (const v of vevents) {
    const rid = v.getFirstPropertyValue('recurrence-id');
    if (rid && !ruleGenerates(master, rid)) out.push(`RECURRENCE-ID ${rid.toString()}`);
  }
  return out;
}

function expand(ics) {
  return parseAndExpandEvent(ics, '2026-08-01T00:00:00Z', '2026-09-10T00:00:00Z')
    .map(o => ({ start: new Date(o.start).toISOString(), title: o.title }));
}

test('#243 series time shift from a later occurrence carries the exceptions along', () => {
  const out = updateWholeSeries(PROBE_ICS, seriesPayload({
    start: '2026-08-26T11:00:00.000Z',
    end: '2026-08-26T12:00:00.000Z'
  }));
  assert.match(out, /DTSTART:20260805T110000Z/);
  assert.deepEqual(orphans(out), []);

  const occ = expand(out);
  assert.equal(occ.find(o => o.start.startsWith('2026-08-12')), undefined,
    'the deleted 2026-08-12 occurrence must stay deleted');
  const ovr = occ.find(o => o.start.startsWith('2026-08-19'));
  assert.ok(ovr, '2026-08-19 occurrence must exist');
  assert.equal(ovr.title, 'PROBE-OVR19', 'the customisation must stay visible');
  assert.equal(ovr.start, '2026-08-19T11:00:00.000Z', 'an override at its slot follows the series');
  assert.match(out, /DTEND:20260819T120000Z/, 'and keeps its length');
});

test('#243 series time shift keeps an override the user moved elsewhere at its own time', () => {
  const movedIcs = PROBE_ICS
    .replace('DTSTART:20260819T090000Z', 'DTSTART:20260819T140000Z')
    .replace('DTEND:20260819T100000Z', 'DTEND:20260819T150000Z');
  const out = updateWholeSeries(movedIcs, seriesPayload({
    start: '2026-08-26T11:00:00.000Z',
    end: '2026-08-26T12:00:00.000Z'
  }));
  assert.deepEqual(orphans(out), []);
  assert.match(out, /RECURRENCE-ID:20260819T110000Z/);
  const ovr = expand(out).filter(o => o.start.startsWith('2026-08-19'));
  assert.deepEqual(ovr, [{ start: '2026-08-19T14:00:00.000Z', title: 'PROBE-OVR19' }]);
});

test('#243 series moved a day (rule rewritten WE->TH server-side) carries the exceptions along', () => {
  const out = updateWholeSeries(PROBE_ICS, seriesPayload({
    start: '2026-08-27T09:00:00.000Z',
    end: '2026-08-27T10:00:00.000Z'
  }));
  assert.match(out, /BYDAY=TH/);
  assert.deepEqual(orphans(out), []);

  const occ = expand(out);
  assert.equal(occ.find(o => o.start.startsWith('2026-08-13')), undefined,
    'the deleted occurrence moves with the series and stays deleted');
  const ovr = occ.find(o => o.start.startsWith('2026-08-20'));
  assert.ok(ovr);
  assert.equal(ovr.title, 'PROBE-OVR19');
});

test('#243 rule change the old exceptions cannot follow prunes them instead of orphaning', () => {
  // Fortnightly from 2026-08-05: 08-19 is still generated, 08-12 is not.
  const biweekly = updateWholeSeries(PROBE_ICS, seriesPayload({
    recurrence: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE'
  }));
  assert.deepEqual(orphans(biweekly), []);
  assert.doesNotMatch(biweekly, /EXDATE/, 'EXDATE for a date the rule no longer generates is dropped');
  assert.match(biweekly, /RECURRENCE-ID:20260819T090000Z/, 'override still generated by the rule is kept');
  assert.equal(expand(biweekly).find(o => o.start.startsWith('2026-08-19')).title, 'PROBE-OVR19');

  // Monthly on the 5th: neither exception is generated any more.
  const monthly = updateWholeSeries(PROBE_ICS, seriesPayload({
    recurrence: 'FREQ=MONTHLY;BYMONTHDAY=5'
  }));
  assert.deepEqual(orphans(monthly), []);
  assert.doesNotMatch(monthly, /RECURRENCE-ID/);
  assert.doesNotMatch(monthly, /PROBE-OVR19/);
});

test('#243 a plain rename leaves every exception untouched', () => {
  const out = updateWholeSeries(PROBE_ICS, seriesPayload({ title: 'PROBE-RENAMED' }));
  assert.match(out, /DTSTART:20260805T090000Z/);
  assert.match(out, /EXDATE:20260812T090000Z/);
  assert.match(out, /RECURRENCE-ID:20260819T090000Z/);
  assert.deepEqual(orphans(out), []);
});

test('#243 exceptions the new rule still generates stay where they are', () => {
  // Series moved a whole week later: 08-12 and 08-19 are still Wednesdays of
  // the rule, so they must not be pushed onto 08-19 / 08-26.
  const out = updateWholeSeries(PROBE_ICS, seriesPayload({
    start: '2026-09-02T09:00:00.000Z',
    end: '2026-09-02T10:00:00.000Z'
  }));
  assert.match(out, /DTSTART:20260812T090000Z/);
  assert.deepEqual(orphans(out), []);
  assert.match(out, /EXDATE:20260812T090000Z/);
  assert.match(out, /RECURRENCE-ID:20260819T090000Z/);
  const occ = expand(out);
  assert.equal(occ.find(o => o.start.startsWith('2026-08-19')).title, 'PROBE-OVR19');
  assert.equal(occ.find(o => o.start.startsWith('2026-08-26')).title, 'PROBE');
});

test('#243 RDATE series keeps exceptions on its unmoved RDATEs', () => {
  const rdateIcs = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Freeshard//WebCalendar//EN',
    'BEGIN:VEVENT', 'UID:rdate-uid', 'SUMMARY:RD',
    'DTSTART:20260805T090000Z', 'DTEND:20260805T100000Z',
    'RDATE:20260808T090000Z,20260812T090000Z',
    'EXDATE:20260808T090000Z',
    'END:VEVENT',
    'BEGIN:VEVENT', 'UID:rdate-uid', 'RECURRENCE-ID:20260812T090000Z', 'SUMMARY:RD-OVR',
    'DTSTART:20260812T090000Z', 'DTEND:20260812T100000Z',
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  const out = updateWholeSeries(rdateIcs, {
    uid: 'rdate-uid', title: 'RD',
    start: '2026-08-05T11:00:00.000Z', end: '2026-08-05T12:00:00.000Z', allDay: false
  });
  assert.deepEqual(orphans(out), []);
  assert.match(out, /EXDATE:20260808T090000Z/);
  assert.match(out, /RECURRENCE-ID:20260812T090000Z/);
  const occ = expand(out);
  assert.equal(occ.find(o => o.start.startsWith('2026-08-08')), undefined);
  assert.equal(occ.find(o => o.start.startsWith('2026-08-12')).title, 'RD-OVR');
});

test('#243 a rule too dense to verify refuses the write instead of hanging', () => {
  const denseIcs = PROBE_ICS
    .replace('RRULE:FREQ=WEEKLY;BYDAY=WE', 'RRULE:FREQ=MINUTELY')
    .replace('EXDATE:20260812T090000Z', 'EXDATE:20290101T000000Z');
  const t0 = Date.now();
  assert.throws(() => updateWholeSeries(denseIcs, {
    uid: UID, title: 'DENSE', start: '2026-08-05T09:00:00.000Z', end: '2026-08-05T10:00:00.000Z',
    allDay: false, recurrence: 'FREQ=MINUTELY'
  }), /too dense/);
  assert.ok(Date.now() - t0 < 5000);
});

test('#243 PUT /api/events/:uid series time shift stores no orphaned exception', async (t) => {
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
    const record = { ics, etag: '"etag-243-put"' };
    store.set(url, record);
    return record;
  };
  t.after(() => {
    CalDAVClient.prototype.get = originalGet;
    CalDAVClient.prototype.put = originalPut;
    if (server && server.close) server.close();
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;
  const userId = 'testuser-243';
  await Db.upsertUser(userId, 'testuser@example.com');
  const cookie = await loginAs(userId);
  const authRes = await fetch(`${baseUrl}/api/accounts`, { headers: { cookie } });
  assert.equal(authRes.status, 200);
  const href = `/users/${userId}/calendars/personal/${UID}.ics`;
  const eventUrl = `http://localhost:1080${href}`;
  store.set(eventUrl, { ics: PROBE_ICS, etag: '"etag-243-0"' });

  const res = await fetch(`${baseUrl}/api/events/${UID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      calendarId: `env-default::/users/${userId}/calendars/personal/`,
      href,
      etag: 'etag-243-0',
      scope: 'series',
      ...seriesPayload({ start: '2026-08-26T11:00:00.000Z', end: '2026-08-26T12:00:00.000Z' })
    })
  });
  assert.equal(res.status, 200);

  const stored = store.get(eventUrl).ics;
  assert.match(stored, /DTSTART:20260805T110000Z/);
  assert.deepEqual(orphans(stored), []);
  const occ = expand(stored);
  assert.equal(occ.find(o => o.start.startsWith('2026-08-12')), undefined);
  assert.equal(occ.find(o => o.start.startsWith('2026-08-19')).title, 'PROBE-OVR19');
});
