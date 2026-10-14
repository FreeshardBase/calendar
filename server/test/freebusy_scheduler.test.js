'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');

const {
  isEventBusyInWindow,
  queryParticipantAvailability,
  findCommonFreeSlots,
  buildVFreeBusy,
  parseVFreeBusy,
  formatICalDate
} = require('../utils/freebusyScheduler');

const freebusyRouter = require('../routes/freebusy');
const { getSessionConfig } = require('../utils/sessionConfig');
const { loginAs } = require('./helpers/testSession');

test('Participant Availability (Free/Busy) Scheduler Unit Suite', async (t) => {

  await t.test('isEventBusyInWindow detects opaque overlap and excludes transparent events', () => {
    const windowStart = new Date('2026-08-25T10:00:00Z').getTime();
    const windowEnd = new Date('2026-08-25T11:00:00Z').getTime();

    // 1. Opaque event overlapping window
    const evBusy = {
      uid: 'ev-1',
      title: 'Strategy Meeting',
      start: '2026-08-25T10:30:00Z',
      end: '2026-08-25T11:30:00Z',
      transp: 'OPAQUE'
    };
    const resBusy = isEventBusyInWindow(evBusy, windowStart, windowEnd);
    assert.notEqual(resBusy, null);
    assert.equal(resBusy.uid, 'ev-1');
    assert.equal(resBusy.start, '2026-08-25T10:30:00.000Z');
    assert.equal(resBusy.end, '2026-08-25T11:00:00.000Z');

    // 2. Transparent event (non-blocking)
    const evTransp = {
      uid: 'ev-2',
      title: 'Coffee Break',
      start: '2026-08-25T10:30:00Z',
      end: '2026-08-25T11:30:00Z',
      transp: 'TRANSPARENT'
    };
    const resTransp = isEventBusyInWindow(evTransp, windowStart, windowEnd);
    assert.equal(resTransp, null);

    // 3. Excluded event UID
    const resExcl = isEventBusyInWindow(evBusy, windowStart, windowEnd, 'ev-1');
    assert.equal(resExcl, null);
  });

  await t.test('queryParticipantAvailability computes per-participant free/busy and overall availability', async () => {
    const mockEvents = {
      'user1@example.com': [
        { uid: 'u1-1', title: 'Focus Time', start: '2026-08-25T09:00:00Z', end: '2026-08-25T10:00:00Z' }
      ],
      'user2@example.com': [
        { uid: 'u2-1', title: 'Lunch', start: '2026-08-25T12:00:00Z', end: '2026-08-25T13:00:00Z' }
      ]
    };

    const mockGetEvents = async (participant) => mockEvents[participant] || [];

    // Query 09:30-10:30 -> user1 is busy, user2 is free -> overall false
    const res1 = await queryParticipantAvailability({
      participants: ['user1@example.com', 'user2@example.com'],
      startTime: '2026-08-25T09:30:00Z',
      endTime: '2026-08-25T10:30:00Z',
      getEventsForUserFn: mockGetEvents
    });

    assert.equal(res1.overallAvailable, false);
    assert.equal(res1.participants.length, 2);
    assert.equal(res1.participants[0].status, 'BUSY');
    assert.equal(res1.participants[1].status, 'FREE');

    // Query 14:00-15:00 -> both free -> overall true
    const res2 = await queryParticipantAvailability({
      participants: ['user1@example.com', 'user2@example.com'],
      startTime: '2026-08-25T14:00:00Z',
      endTime: '2026-08-25T15:00:00Z',
      getEventsForUserFn: mockGetEvents
    });

    assert.equal(res2.overallAvailable, true);
    assert.equal(res2.participants[0].status, 'FREE');
    assert.equal(res2.participants[1].status, 'FREE');
  });

  await t.test('findCommonFreeSlots returns common available slots in window', async () => {
    const mockEvents = {
      'alice@example.com': [
        { uid: 'a1', title: 'Meeting 1', start: '2026-08-25T09:00:00Z', end: '2026-08-25T10:00:00Z' }
      ],
      'bob@example.com': [
        { uid: 'b1', title: 'Meeting 2', start: '2026-08-25T10:00:00Z', end: '2026-08-25T11:00:00Z' }
      ]
    };

    const mockGetEvents = async (participant) => mockEvents[participant] || [];

    const slots = await findCommonFreeSlots({
      participants: ['alice@example.com', 'bob@example.com'],
      startDate: '2026-08-25',
      endDate: '2026-08-25',
      durationMinutes: 60,
      workHoursStart: 9,
      workHoursEnd: 12,
      getEventsForUserFn: mockGetEvents
    });

    // 09-10 (Alice busy), 10-11 (Bob busy), 11-12 (Both free)
    assert.equal(slots.length, 1);
    assert.equal(slots[0].startTime, '2026-08-25T11:00:00.000Z');
    assert.equal(slots[0].endTime, '2026-08-25T12:00:00.000Z');
  });

  await t.test('buildVFreeBusy and parseVFreeBusy serialize and deserialize RFC 5545 VFREEBUSY', () => {
    const busySlots = [
      { start: '2026-08-25T10:00:00Z', end: '2026-08-25T11:00:00Z' },
      { start: '2026-08-25T14:00:00Z', end: '2026-08-25T15:00:00Z' }
    ];

    const ics = buildVFreeBusy({
      organizerEmail: 'organizer@example.com',
      startTime: '2026-08-25T00:00:00Z',
      endTime: '2026-08-25T23:59:59Z',
      busySlots
    });

    assert.ok(ics.includes('BEGIN:VFREEBUSY'));
    assert.ok(ics.includes('ORGANIZER:mailto:organizer@example.com'));
    assert.ok(ics.includes('FREEBUSY;FBTYPE=BUSY:'));
    assert.ok(ics.includes('END:VFREEBUSY'));

    const parsed = parseVFreeBusy(ics);
    assert.equal(parsed.organizer, 'mailto:organizer@example.com');
    assert.equal(parsed.periods.length, 2);
    assert.equal(parsed.periods[0].fbtype, 'BUSY');
  });
});

test('Participant Availability (Free/Busy) Scheduler REST API Suite', async (t) => {
  let app;
  let server;
  let baseUrl;

  t.before(async () => {
    app = express();
    app.use(express.json());
    // #245: production session store and secret, so a loginAs() session authenticates.
    app.use(session(getSessionConfig(process.env)));
    app.use('/api/freebusy', freebusyRouter);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  t.after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('POST /api/freebusy/query returns 401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/freebusy/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participants: ['test@example.com'],
        startTime: '2026-08-25T10:00:00Z',
        endTime: '2026-08-25T11:00:00Z'
      })
    });
    assert.equal(res.status, 401);
  });

  await t.test('POST /api/freebusy/query returns availability status for authenticated user', async () => {
    const res = await fetch(`${baseUrl}/api/freebusy/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: await loginAs('testuser-id')
      },
      body: JSON.stringify({
        participants: ['testuser@example.com'],
        startTime: '2026-08-25T10:00:00Z',
        endTime: '2026-08-25T11:00:00Z'
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.overallAvailable, 'boolean');
    assert.ok(Array.isArray(body.participants));
    assert.equal(body.participants[0].participant, 'testuser@example.com');
  });

  await t.test('POST /api/freebusy/find-slots returns available slots list', async () => {
    const res = await fetch(`${baseUrl}/api/freebusy/find-slots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: await loginAs('testuser-id')
      },
      body: JSON.stringify({
        participants: ['testuser@example.com'],
        startDate: '2026-08-25',
        endDate: '2026-08-25',
        durationMinutes: 30,
        workHoursStart: 9,
        workHoursEnd: 17
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.slots));
    assert.ok(body.totalSlots >= 0);
  });

  await t.test('GET /api/freebusy/vfreebusy returns text/calendar VFREEBUSY attachment', async () => {
    const res = await fetch(`${baseUrl}/api/freebusy/vfreebusy?user=testuser@example.com&startTime=2026-08-25T00:00:00Z&endTime=2026-08-25T23:59:59Z`, {
      headers: {
        cookie: await loginAs('testuser-id')
      }
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/calendar'));
    const icsText = await res.text();
    assert.ok(icsText.includes('BEGIN:VCALENDAR'));
    assert.ok(icsText.includes('BEGIN:VFREEBUSY'));
    assert.ok(icsText.includes('END:VFREEBUSY'));
  });
});
