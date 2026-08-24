'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3109';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const helper = require('../caldav/helper');

// Mock CalDAV client for unit testing without live CalDAV backend
helper.getClientForAccount = async () => ({
  put: async (url, ics, ifMatch) => ({ etag: '"mock-etag"' }),
  get: async (url) => ({ ics: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Mock Event\r\nEND:VEVENT\r\nEND:VCALENDAR', etag: '"mock-etag"' }),
  delete: async (url, ifMatch) => ({})
});

const { app, server } = require('../index');

test('Issue #25 — Event Modification History and Audit Logs (Changelog)', async (t) => {
  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll().catch(() => {});

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let userCookie = '';
  let strangerCookie = '';

  const userId = 'test-history-user';
  const strangerId = 'test-history-stranger';

  await Db.upsertUser(userId, 'history_user@example.com');
  await Db.upsertUser(strangerId, 'history_stranger@example.com');

  const calId = `internal-caldav::/${userId}/personal/`;

  await t.test('computeEventDiff detects property changes between event versions', () => {
    const { computeEventDiff } = require('../utils/eventHistory');
    const oldEv = {
      title: 'Project Kickoff',
      start: '2026-09-01T10:00:00.000Z',
      end: '2026-09-01T11:00:00.000Z',
      location: 'Room 101',
      description: 'Initial planning',
      categories: ['Work']
    };

    const newEv = {
      title: 'Project Kickoff Meeting',
      start: '2026-09-01T10:30:00.000Z',
      end: '2026-09-01T11:30:00.000Z',
      location: 'Room 102',
      description: 'Initial planning',
      categories: ['Work', 'Urgent']
    };

    const diff = computeEventDiff(oldEv, newEv);
    assert.deepStrictEqual(diff.title, { old: 'Project Kickoff', new: 'Project Kickoff Meeting' });
    assert.deepStrictEqual(diff.start, { old: '2026-09-01T10:00:00.000Z', new: '2026-09-01T10:30:00.000Z' });
    assert.deepStrictEqual(diff.location, { old: 'Room 101', new: 'Room 102' });
    assert.deepStrictEqual(diff.categories, { old: ['Work'], new: ['Work', 'Urgent'] });
    assert.strictEqual(diff.description, undefined);
  });

  await t.test('Db event history persistence methods', async () => {
    const eventUid = 'test-uid-1001';

    await Db.recordEventHistory({
      eventUid,
      calendarId: calId,
      userId,
      action: 'CREATE',
      changes: { title: { new: 'Design Review' } }
    });

    await Db.recordEventHistory({
      eventUid,
      calendarId: calId,
      userId,
      action: 'UPDATE',
      changes: { location: { old: 'Online', new: 'Office' } }
    });

    const history = await Db.getEventHistory(eventUid);
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].action, 'UPDATE');
    assert.strictEqual(history[1].action, 'CREATE');

    const calHistory = await Db.getCalendarEventHistory(calId);
    assert.strictEqual(calHistory.length, 2);
  });

  await t.test('Authenticate test sessions', async () => {
    const res1 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': userId }
    });
    assert.strictEqual(res1.status, 200);
    userCookie = res1.headers.get('set-cookie').split(';')[0];

    const res2 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': strangerId }
    });
    assert.strictEqual(res2.status, 200);
    strangerCookie = res2.headers.get('set-cookie').split(';')[0];
  });

  await t.test('REST GET /api/events/:uid/history access control and retrieval', async () => {
    const eventUid = 'test-uid-rest-2002';
    await Db.recordEventHistory({
      eventUid,
      calendarId: calId,
      userId,
      action: 'CREATE',
      changes: { title: { new: 'REST Event' } }
    });

    // Unauthenticated -> 401
    const unauthRes = await fetch(`${baseUrl}/api/events/${eventUid}/history`, {
      headers: { 'x-test-user-id': 'unauthenticated' }
    });
    assert.strictEqual(unauthRes.status, 401);

    // Stranger -> 403
    const strangerRes = await fetch(`${baseUrl}/api/events/${eventUid}/history?calendarId=${encodeURIComponent(calId)}`, {
      headers: { cookie: strangerCookie, 'x-test-user-id': strangerId }
    });
    assert.strictEqual(strangerRes.status, 403);

    // Authorized owner -> 200
    const ownerRes = await fetch(`${baseUrl}/api/events/${eventUid}/history?calendarId=${encodeURIComponent(calId)}`, {
      headers: { cookie: userCookie, 'x-test-user-id': userId }
    });
    assert.strictEqual(ownerRes.status, 200);
    const body = await ownerRes.json();
    assert.strictEqual(Array.isArray(body), true);
    assert.strictEqual(body.length, 1);
    assert.strictEqual(body[0].event_uid, eventUid);
    assert.strictEqual(body[0].action, 'CREATE');
  });

  await t.test('REST POST and DELETE /api/events automatically record event history entries', async () => {
    const envCalId = `env-default::/${userId}/personal/`;
    const postRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: userCookie,
        'x-test-user-id': userId
      },
      body: JSON.stringify({
        calendarId: envCalId,
        title: 'Changelog Test Event',
        start: '2026-09-10T09:00:00.000Z',
        end: '2026-09-10T10:00:00.000Z'
      })
    });

    assert.strictEqual(postRes.status, 201);
    const createdEv = await postRes.json();
    assert.ok(createdEv.uid);

    const historyAfterPost = await Db.getEventHistory(createdEv.uid);
    assert.strictEqual(historyAfterPost.length, 1);
    assert.strictEqual(historyAfterPost[0].action, 'CREATE');

    const delRes = await fetch(`${baseUrl}/api/events/${createdEv.uid}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        cookie: userCookie,
        'x-test-user-id': userId
      },
      body: JSON.stringify({
        calendarId: envCalId,
        href: createdEv.href
      })
    });
    assert.strictEqual(delRes.status, 200);

    const historyAfterDel = await Db.getEventHistory(createdEv.uid);
    assert.strictEqual(historyAfterDel.length, 2);
    assert.strictEqual(historyAfterDel[0].action, 'DELETE');
    assert.strictEqual(historyAfterDel[1].action, 'CREATE');
  });
});
