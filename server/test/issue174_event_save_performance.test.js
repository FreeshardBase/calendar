'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isNoOpEventSave, updateWholeSeries } = require('../utils/ical.js');
const CalDAVClient = require('../caldav/client.js');

test('Issue #174 — Event Save Performance & Zero-Edit Bypassing', async (t) => {

  await t.test('isNoOpEventSave returns true for identical event payload in O(1) time', () => {
    const existingIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Freeshard//WebCalendar 1.0//EN
BEGIN:VEVENT
UID:test-event-174
DTSTAMP:20260901T120000Z
DTSTART:20260901T140000Z
DTEND:20260901T150000Z
SUMMARY:Meeting with Team
LOCATION:Room 101
DESCRIPTION:Discuss Q3 Roadmap
END:VEVENT
END:VCALENDAR`;

    const incomingData = {
      uid: 'test-event-174',
      title: 'Meeting with Team',
      start: '2026-09-01T14:00:00.000Z',
      end: '2026-09-01T15:00:00.000Z',
      allDay: false,
      location: 'Room 101',
      description: 'Discuss Q3 Roadmap'
    };

    const t0 = performance.now();
    const isNoOp = isNoOpEventSave(existingIcs, incomingData);
    const durationMs = performance.now() - t0;

    assert.strictEqual(isNoOp, true, 'Unchanged event payload must be identified as no-op save');
    assert.ok(durationMs < 10, `No-op check should execute in < 10ms, took ${durationMs.toFixed(2)}ms`);
  });

  await t.test('updateWholeSeries updates single target event ICS in O(1) time without parsing calendar collection', () => {
    const existingIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:single-event-174
DTSTART:20260901T100000Z
DTEND:20260901T110000Z
SUMMARY:Original Summary
EXDATE:20260905T100000Z
END:VEVENT
END:VCALENDAR`;

    const updatedData = {
      uid: 'single-event-174',
      title: 'Updated Summary',
      start: '2026-09-01T10:00:00.000Z',
      end: '2026-09-01T11:00:00.000Z'
    };

    const t0 = performance.now();
    const resultIcs = updateWholeSeries(existingIcs, updatedData);
    const durationMs = performance.now() - t0;

    assert.ok(resultIcs.includes('SUMMARY:Updated Summary'), 'Updated ICS must contain new title');
    assert.ok(resultIcs.includes('EXDATE:20260905T100000Z'), 'Updated ICS must preserve EXDATE');
    assert.ok(durationMs < 15, `updateWholeSeries should execute in < 15ms, took ${durationMs.toFixed(2)}ms`);
  });

  await t.test('CalDAVClient.prototype.put omits If-None-Match when etag is explicitly false', async () => {
    let capturedHeaders = null;
    const client = new CalDAVClient({ url: 'http://localhost:9999', username: 'testuser', password: 'testpass' });

    client._request = async (method, url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, status: 200, headers: new Map() };
    };

    await client.put('http://localhost:9999/event.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', false);

    assert.ok(capturedHeaders, 'Headers must be captured');
    assert.strictEqual(capturedHeaders['If-None-Match'], undefined, 'Unconditional PUT (etag=false) must not send If-None-Match: *');
    assert.strictEqual(capturedHeaders['If-Match'], undefined, 'Unconditional PUT (etag=false) must not send If-Match');
  });

  await t.test('CalDAVClient.prototype.put sends If-None-Match: * when etag is null (resource creation)', async () => {
    let capturedHeaders = null;
    const client = new CalDAVClient({ url: 'http://localhost:9999', username: 'testuser', password: 'testpass' });

    client._request = async (method, url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, status: 201, headers: new Map() };
    };

    await client.put('http://localhost:9999/event.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', null);

    assert.ok(capturedHeaders, 'Headers must be captured');
    assert.strictEqual(capturedHeaders['If-None-Match'], '*', 'Resource creation (etag=null) must send If-None-Match: *');
  });
});
