'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3287';
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
const { isNoOpEventSave, parseICSToEvent } = require('../caldav/parser');

test('Issue #242 — No-Op Whole-Series Save Detached Override Scope Isolation', async (t) => {
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

  await Db.clearAll().catch(() => {});

  // Construct ICS where detached override VEVENT comes BEFORE master VEVENT
  const icsWithOverrideFirst = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:series-242-scope',
    'RECURRENCE-ID:20260915T090000Z',
    'SUMMARY:Detached Exception Meeting',
    'DTSTART:20260915T110000Z',
    'DTEND:20260915T120000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:series-242-scope',
    'SUMMARY:Master Weekly Meeting',
    'DTSTART:20260901T090000Z',
    'DTEND:20260901T100000Z',
    'RRULE:FREQ=WEEKLY',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const masterEventData = {
    uid: 'series-242-scope',
    title: 'Master Weekly Meeting',
    start: '2026-09-01T09:00:00.000Z',
    end: '2026-09-01T10:00:00.000Z',
    allDay: false,
    recurrence: 'FREQ=WEEKLY'
  };

  const overrideEventData = {
    uid: 'series-242-scope',
    title: 'Detached Exception Meeting',
    start: '2026-09-15T11:00:00.000Z',
    end: '2026-09-15T12:00:00.000Z',
    allDay: false,
    recurrence: null
  };

  await t.test('parseICSToEvent selects master VEVENT when recurrenceId is omitted even if override is first', () => {
    const parsed = parseICSToEvent(icsWithOverrideFirst);
    assert.ok(parsed, 'must parse ICS');
    assert.equal(parsed.title, 'Master Weekly Meeting', 'Must select master VEVENT without recurrence-id');
  });

  await t.test('parseICSToEvent selects specific detached override when recurrenceId is passed', () => {
    const parsed = parseICSToEvent(icsWithOverrideFirst, { recurrenceId: '20260915T090000Z' });
    assert.ok(parsed, 'must parse ICS for recurrenceId');
    assert.equal(parsed.title, 'Detached Exception Meeting', 'Must select matching detached override VEVENT');
  });

  await t.test('parseICSToEvent returns null when recurrenceId is passed but no matching override exists', () => {
    const parsed = parseICSToEvent(icsWithOverrideFirst, { recurrenceId: '20260922T090000Z' });
    assert.equal(parsed, null, 'Must return null for non-existent recurrenceId override');
  });

  await t.test('isNoOpEventSave identifies master event no-op when override is first', () => {
    assert.equal(isNoOpEventSave(icsWithOverrideFirst, masterEventData), true,
      'Whole-series no-op save must match master VEVENT, ignoring leading detached override');
  });

  await t.test('isNoOpEventSave identifies modified master event as NOT no-op', () => {
    const modifiedMaster = { ...masterEventData, title: 'Renamed Master Meeting' };
    assert.equal(isNoOpEventSave(icsWithOverrideFirst, modifiedMaster), false,
      'Modified master event title must not be a no-op');
  });

  await t.test('isNoOpEventSave identifies detached override no-op when recurrenceId is passed', () => {
    assert.equal(isNoOpEventSave(icsWithOverrideFirst, overrideEventData, '20260915T090000Z'), true,
      'Detached override no-op save must match specified recurrenceId override');
  });

  await t.test('isNoOpEventSave returns false when recurrenceId is passed but override does not exist yet', () => {
    assert.equal(isNoOpEventSave(icsWithOverrideFirst, overrideEventData, '20260922T090000Z'), false,
      'Must return false when saving occurrence for which no detached override exists in ICS');
  });

  await t.test('PUT /api/events/:uid isolates master scope on whole-series no-op save', async () => {
    const baseUrl = `http://localhost:${process.env.PORT}`;
    const testUserId = 'test-series-user-242';
    await Db.upsertUser(testUserId, 'series242@example.com');

    const cookie = await loginAs(testUserId);
    const authRes = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie }
    });
    assert.equal(authRes.status, 200);
    const calendarId = `env-default::/users/${testUserId}/calendars/personal/`;

    const uid = 'series-242-http';
    const eventUrl = `http://localhost:1080/users/${testUserId}/calendars/personal/${uid}.ics`;

    mockStore.set(eventUrl, { ics: icsWithOverrideFirst, etag: '"etag-242"' });
    putCount = 0;

    // Execute whole-series PUT request with unchanged master properties
    const putRes = await fetch(`${baseUrl}/api/events/${uid}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        calendarId,
        href: `/users/${testUserId}/calendars/personal/${uid}.ics`,
        etag: 'etag-242',
        ...masterEventData
      })
    });

    assert.equal(putRes.status, 200, 'HTTP response must be 200 OK');
    assert.equal(putCount, 0, 'No-op whole series save MUST NOT issue CalDAV PUT request');
  });
});
