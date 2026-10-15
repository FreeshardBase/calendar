'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const Db = require('../db');
const {
  parseValarmOffset,
  calculateAlarmTime,
  evaluateUpcomingAlarms,
  formatPushPayload
} = require('../utils/webPushNotifications');
const notificationsRouter = require('../routes/notifications');
const { getSessionConfig } = require('../utils/sessionConfig');
const { loginAs } = require('./helpers/testSession');

const TEST_USER_ID = 'test-user-push-17';

test('Web Push Notifications & VALARM Engine (Issue #17)', async (t) => {

  await t.test('parseValarmOffset handles RFC 5545 ISO 8601 duration strings', () => {
    assert.equal(parseValarmOffset('-PT15M'), -15 * 60 * 1000);
    assert.equal(parseValarmOffset('-PT1H'), -60 * 60 * 1000);
    assert.equal(parseValarmOffset('-P1D'), -24 * 60 * 60 * 1000);
    assert.equal(parseValarmOffset('-PT30M'), -30 * 60 * 1000);
    assert.equal(parseValarmOffset('PT5M'), 5 * 60 * 1000);
    assert.equal(parseValarmOffset('invalid'), null);
  });

  await t.test('calculateAlarmTime computes correct timestamp relative to event start', () => {
    const eventStart = '2026-08-25T10:00:00.000Z';
    const alarm15m = calculateAlarmTime(eventStart, '-PT15M');
    assert.equal(new Date(alarm15m).toISOString(), '2026-08-25T09:45:00.000Z');

    const alarm1h = calculateAlarmTime(eventStart, '-PT1H');
    assert.equal(new Date(alarm1h).toISOString(), '2026-08-25T09:00:00.000Z');
  });

  await t.test('evaluateUpcomingAlarms identifies triggered VALARMs within time window', () => {
    const now = new Date('2026-08-25T09:45:00.000Z');
    const events = [
      {
        id: 'event-1',
        title: 'Team Standup',
        start: '2026-08-25T10:00:00.000Z',
        alarms: [{ trigger: '-PT15M', action: 'DISPLAY' }]
      },
      {
        id: 'event-2',
        title: 'Future Workshop',
        start: '2026-08-25T14:00:00.000Z',
        alarms: [{ trigger: '-PT15M', action: 'DISPLAY' }]
      }
    ];

    const triggered = evaluateUpcomingAlarms(events, { now, windowMinutes: 10 });
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].eventId, 'event-1');
    assert.equal(triggered[0].title, 'Team Standup');
    assert.equal(triggered[0].trigger, '-PT15M');
  });

  await t.test('formatPushPayload constructs standard Web Push payload structure', () => {
    const alarm = {
      eventId: 'event-101',
      title: 'Sprint Planning',
      start: '2026-08-25T10:00:00.000Z',
      trigger: '-PT15M',
      alarmTime: 1787651100000
    };
    const payload = formatPushPayload(alarm);
    assert.equal(payload.title, 'Erinnerung: Sprint Planning');
    assert.ok(payload.body.includes('Sprint Planning'));
    assert.equal(payload.data.eventId, 'event-101');
  });

  await t.test('Db push subscription CRUD operations', async () => {
    const subObj = {
      user_id: TEST_USER_ID,
      endpoint: 'https://push.example.com/sub/12345',
      keys_p256dh: 'test-p256dh-key',
      keys_auth: 'test-auth-key'
    };

    // Save
    const saved = await Db.savePushSubscription(subObj);
    assert.ok(saved.id);
    assert.equal(saved.user_id, TEST_USER_ID);

    // List
    const subs = await Db.getPushSubscriptions(TEST_USER_ID);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].endpoint, subObj.endpoint);

    // Delete
    await Db.deletePushSubscription(saved.id, TEST_USER_ID);
    const afterDelete = await Db.getPushSubscriptions(TEST_USER_ID);
    assert.equal(afterDelete.length, 0);
  });

  // REST API Endpoint Tests
  await t.test('Push Notifications REST API Endpoints', async (t2) => {
    const app = express();
    app.use(express.json());
    // Production session config (SQLite store + resolved secret), so loginAs()
    // sessions are the only way to be identified (#245/#50).
    app.use(session(getSessionConfig(process.env)));
    app.use('/api/notifications', notificationsRouter);

    const userCookie = await loginAs(TEST_USER_ID, { username: 'testuser', email: 'testuser@example.com' });

    let server;
    let baseUrl;

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    t2.after(() => {
      server.close();
    });

    await t2.test('GET /api/notifications/push-subscriptions returns 401 when unauthenticated', async () => {
      const res = await fetch(`${baseUrl}/api/notifications/push-subscriptions`);
      assert.equal(res.status, 401);
    });

    await t2.test('GET /api/notifications/push-subscriptions ignores an x-test-user-id header (#245/#50)', async () => {
      const res = await fetch(`${baseUrl}/api/notifications/push-subscriptions`, {
        headers: { 'x-test-user-id': TEST_USER_ID }
      });
      assert.equal(res.status, 401);
    });

    let createdSubId;
    await t2.test('POST /api/notifications/push-subscriptions creates push subscription', async () => {
      const res = await fetch(`${baseUrl}/api/notifications/push-subscriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userCookie
        },
        body: JSON.stringify({
          endpoint: 'https://fcm.googleapis.com/fcm/send/test-token-777',
          keys: {
            p256dh: 'test-key-p256dh',
            auth: 'test-key-auth'
          }
        })
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.ok(data.id);
      assert.equal(data.user_id, TEST_USER_ID);
      assert.equal(data.endpoint, 'https://fcm.googleapis.com/fcm/send/test-token-777');
      createdSubId = data.id;
    });

    await t2.test('GET /api/notifications/push-subscriptions returns user subscriptions', async () => {
      const res = await fetch(`${baseUrl}/api/notifications/push-subscriptions`, {
        headers: { cookie: userCookie }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(Array.isArray(data), true);
      assert.equal(data.length, 1);
      assert.equal(data[0].id, createdSubId);
    });

    await t2.test('POST /api/notifications/evaluate-alarms evaluates VALARMs and formats payloads', async () => {
      const res = await fetch(`${baseUrl}/api/notifications/evaluate-alarms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: userCookie
        },
        body: JSON.stringify({
          now: '2026-08-25T09:45:00.000Z',
          windowMinutes: 15,
          events: [
            {
              id: 'event-sync-99',
              title: 'Client Demo',
              start: '2026-08-25T10:00:00.000Z',
              alarms: [{ trigger: '-PT15M', action: 'DISPLAY' }]
            }
          ]
        })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.triggeredCount, 1);
      assert.equal(data.triggeredAlarms[0].eventId, 'event-sync-99');
      assert.equal(data.pushPayloads[0].title, 'Erinnerung: Client Demo');
    });

    await t2.test('DELETE /api/notifications/push-subscriptions/:id deletes subscription', async () => {
      const res = await fetch(`${baseUrl}/api/notifications/push-subscriptions/${createdSubId}`, {
        method: 'DELETE',
        headers: { cookie: userCookie }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);

      const checkRes = await fetch(`${baseUrl}/api/notifications/push-subscriptions`, {
        headers: { cookie: userCookie }
      });
      const checkData = await checkRes.json();
      assert.equal(checkData.length, 0);
    });
  });
});
