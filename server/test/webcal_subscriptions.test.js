'use strict';
process.env.NODE_ENV = 'test';
// #337: the local feed servers stand in for remote ones — allow them explicitly.
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1,localhost';
process.env.PORT = '3288';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const Db = require('../db');
const {
  normalizeWebcalUrl,
  parseWebcalFeed,
  refreshWebcalFeed,
  syncDueWebcalSubscriptions,
  startWebcalSyncWorker
} = require('../utils/webcalSubscription');

test('Webcal Read-Only Calendar Subscriptions Suite (Issue #24)', async (t) => {
  const { app, server } = require('../index');

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

  const baseUrl = `http://localhost:${process.env.PORT}`;
  const userId = 'webcal-user@example.com';
  const otherUserId = 'other-user@example.com';

  await t.test('Utility - normalizeWebcalUrl handles webcal, http, and https URLs', () => {
    assert.equal(
      normalizeWebcalUrl('webcal://example.com/holidays.ics'),
      'https://example.com/holidays.ics'
    );
    assert.equal(
      normalizeWebcalUrl('webcal://http://example.com/feed.ics'),
      'http://example.com/feed.ics'
    );
    assert.equal(
      normalizeWebcalUrl('https://example.com/calendar.ics'),
      'https://example.com/calendar.ics'
    );
    assert.equal(
      normalizeWebcalUrl('http://example.com/calendar.ics'),
      'http://example.com/calendar.ics'
    );
    assert.throws(() => {
      normalizeWebcalUrl('ftp://example.com/feed.ics');
    }, /Unsupported subscription URL protocol/);
    assert.throws(() => {
      normalizeWebcalUrl('file:///etc/passwd');
    }, /Unsupported subscription URL protocol/);
  });

  await t.test('Utility - parseWebcalFeed parses ICS into read-only event objects', () => {
    const mockIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test Feed//EN',
      'BEGIN:VEVENT',
      'UID:holiday-2026-01-01@example.com',
      'SUMMARY:New Year Holiday',
      'DESCRIPTION:Public Holiday',
      'DTSTART;VALUE=DATE:20260101',
      'DTEND;VALUE=DATE:20260102',
      'LOCATION:Worldwide',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const subscription = { id: 'sub-123', name: 'Public Holidays', color: '#ff5722' };
    const events = parseWebcalFeed(mockIcs, subscription, '2025-12-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');

    assert.equal(events.length, 1);
    assert.equal(events[0].id, 'holiday-2026-01-01@example.com');
    assert.equal(events[0].title, 'New Year Holiday');
    assert.equal(events[0].readOnly, true);
    assert.equal(events[0].isSubscription, true);
    assert.equal(events[0].subscriptionId, 'sub-123');
    assert.equal(events[0].color, '#ff5722');
  });

  await t.test('Database - webcal subscription CRUD operations', async () => {
    await Db.upsertUser(userId, userId);
    const existing = await Db.getWebcalSubscriptions(userId);
    for (const s of existing) await Db.deleteWebcalSubscription(s.id, userId);

    const sub = await Db.createWebcalSubscription({
      userId,
      name: 'Team Holidays',
      url: 'https://example.com/team-holidays.ics',
      color: '#10b981',
      refreshInterval: 7200
    });

    assert.ok(sub.id, 'Subscription ID should be auto-generated');
    assert.equal(sub.user_id, userId);
    assert.equal(sub.name, 'Team Holidays');
    assert.equal(sub.url, 'https://example.com/team-holidays.ics');
    assert.equal(sub.color, '#10b981');
    assert.equal(sub.refresh_interval, 7200);

    const subs = await Db.getWebcalSubscriptions(userId);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].id, sub.id);

    const fetched = await Db.getWebcalSubscription(sub.id, userId);
    assert.equal(fetched.name, 'Team Holidays');

    const updated = await Db.updateWebcalSubscription(sub.id, userId, {
      name: 'Company Holidays',
      color: '#ef4444'
    });
    assert.equal(updated.name, 'Company Holidays');
    assert.equal(updated.color, '#ef4444');

    await Db.updateWebcalSubscriptionSyncTime(sub.id, 1786500000);
    const postSync = await Db.getWebcalSubscription(sub.id, userId);
    assert.equal(postSync.last_synced_at, 1786500000);

    // Cross-user lookup return null
    const crossUser = await Db.getWebcalSubscription(sub.id, otherUserId);
    assert.equal(crossUser, null);

    const deleted = await Db.deleteWebcalSubscription(sub.id, userId);
    assert.equal(deleted, true);

    const postDel = await Db.getWebcalSubscriptions(userId);
    assert.equal(postDel.length, 0);
  });

  await t.test('REST API Endpoints - /api/webcal/subscriptions lifecycle & auth', async () => {
    const existing = await Db.getWebcalSubscriptions(userId);
    for (const s of existing) await Db.deleteWebcalSubscription(s.id, userId);

    // 1. Unauthenticated request returns 401
    const unauthRes = await fetch(`${baseUrl}/api/webcal/subscriptions`, {
      headers: { 'x-test-user-id': 'unauthenticated' }
    });
    assert.equal(unauthRes.status, 401);

    // 2. Create subscription via POST
    const createRes = await fetch(`${baseUrl}/api/webcal/subscriptions`, {
      method: 'POST',
      headers: {
        'x-test-user-id': userId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'Conference Feed',
        url: 'webcal://example.com/conf.ics',
        color: '#8b5cf6'
      })
    });
    assert.equal(createRes.status, 201);
    const createdSub = await createRes.json();
    assert.equal(createdSub.name, 'Conference Feed');
    assert.equal(createdSub.url, 'https://example.com/conf.ics');
    assert.equal(createdSub.color, '#8b5cf6');

    // 3. List subscriptions via GET
    const listRes = await fetch(`${baseUrl}/api/webcal/subscriptions`, {
      headers: { 'x-test-user-id': userId }
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.subscriptions.length, 1);

    // 4. Update subscription via PATCH
    const patchRes = await fetch(`${baseUrl}/api/webcal/subscriptions/${createdSub.id}`, {
      method: 'PATCH',
      headers: {
        'x-test-user-id': userId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'Tech Conference 2026' })
    });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json();
    assert.equal(patchBody.name, 'Tech Conference 2026');

    // 5. Access control: other user gets 404
    const otherUserRes = await fetch(`${baseUrl}/api/webcal/subscriptions/${createdSub.id}`, {
      headers: { 'x-test-user-id': otherUserId }
    });
    assert.equal(otherUserRes.status, 404);

    // 6. Delete subscription via DELETE
    const delRes = await fetch(`${baseUrl}/api/webcal/subscriptions/${createdSub.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user-id': userId }
    });
    assert.equal(delRes.status, 200);
  });

  await t.test('Feed Caching - refreshWebcalFeed persists events in SQLite and caches them', async () => {
    let mockRequests = 0;
    const mockIcsPayload = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test User Feed//EN',
      'BEGIN:VEVENT',
      'UID:feed-event-1@example.com',
      'SUMMARY:Quarterly Planning',
      'DESCRIPTION:All-hands feed event',
      'DTSTART:20261015T090000Z',
      'DTEND:20261015T100000Z',
      'LOCATION:Main Conference Room',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const feedServer = http.createServer((req, res) => {
      mockRequests++;
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
      res.end(mockIcsPayload);
    });

    await new Promise((resolve) => feedServer.listen(0, resolve));
    const feedPort = feedServer.address().port;
    const feedUrl = `http://127.0.0.1:${feedPort}/team-feed.ics`;

    try {
      const sub = await Db.createWebcalSubscription({
        userId,
        name: 'Remote Team Feed',
        url: feedUrl,
        color: '#2563eb',
        refreshInterval: 3600
      });

      // 1. Initial fetch & cache
      const { eventCount } = await refreshWebcalFeed(sub);
      assert.equal(eventCount, 1);
      assert.equal(mockRequests, 1);

      // 2. Check persisted cache in Db
      const cachedIcs = await Db.getCachedWebcalIcs(sub.id, userId);
      const cached = parseWebcalFeed(cachedIcs, sub, '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z');
      assert.equal(cached.length, 1);
      assert.equal(cached[0].id, 'feed-event-1@example.com');
      assert.equal(cached[0].title, 'Quarterly Planning');
      assert.equal(cached[0].isSubscription, true);
      assert.equal(cached[0].readOnly, true);

      // 3. GET /api/webcal/subscriptions/:id/events serves from DB cache without new network request
      const getEventsRes = await fetch(`${baseUrl}/api/webcal/subscriptions/${sub.id}/events?start=2026-10-01T00:00:00.000Z&end=2026-10-31T00:00:00.000Z`, {
        headers: { 'x-test-user-id': userId }
      });
      assert.equal(getEventsRes.status, 200);
      const getEventsData = await getEventsRes.json();
      assert.equal(getEventsData.events.length, 1);
      assert.equal(getEventsData.events[0].title, 'Quarterly Planning');
      assert.equal(mockRequests, 1, 'Subsequent events query must hit cache instead of making a new HTTP request');

      // 4. Force sync via POST /api/webcal/subscriptions/:id/sync refreshes the cache
      const syncRes = await fetch(`${baseUrl}/api/webcal/subscriptions/${sub.id}/sync`, {
        method: 'POST',
        headers: { 'x-test-user-id': userId }
      });
      assert.equal(syncRes.status, 200);
      const syncData = await syncRes.json();
      assert.equal(syncData.success, true);
      assert.equal(syncData.eventCount, 1);
      assert.equal(mockRequests, 2, 'Explicit sync must hit the network to refresh');

      await Db.deleteWebcalSubscription(sub.id, userId);
    } finally {
      await new Promise((resolve) => feedServer.close(resolve));
    }
  });

  await t.test('Periodic Refresh Scheduler - syncDueWebcalSubscriptions and worker lifecycle', async () => {
    let mockRefreshRequests = 0;
    const sampleIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Periodic Test//EN',
      'BEGIN:VEVENT',
      'UID:periodic-event-99@example.com',
      'SUMMARY:Periodic Sync Event',
      'DTSTART:20261101T100000Z',
      'DTEND:20261101T110000Z',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const periodicServer = http.createServer((req, res) => {
      mockRefreshRequests++;
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
      res.end(sampleIcs);
    });

    await new Promise((resolve) => periodicServer.listen(0, resolve));
    const pPort = periodicServer.address().port;
    const pUrl = `http://127.0.0.1:${pPort}/periodic.ics`;

    try {
      const now = 1787000000;
      // Stale subscription (due for refresh)
      const staleSub = await Db.createWebcalSubscription({
        userId,
        name: 'Stale Feed',
        url: pUrl,
        color: '#10b981',
        refreshInterval: 1800
      });
      await Db.updateWebcalSubscriptionSyncTime(staleSub.id, now - 2000);

      // Fresh subscription (not due for refresh)
      const freshSub = await Db.createWebcalSubscription({
        userId,
        name: 'Fresh Feed',
        url: pUrl,
        color: '#f59e0b',
        refreshInterval: 7200
      });
      await Db.updateWebcalSubscriptionSyncTime(freshSub.id, now - 500);

      // Verify query returns only the stale subscription
      const due = await Db.getWebcalSubscriptionsDueForSync(now);
      const dueIds = due.map(s => s.id);
      assert.ok(dueIds.includes(staleSub.id), 'Stale subscription must be due for sync');
      assert.ok(!dueIds.includes(freshSub.id), 'Fresh subscription must not be due for sync');

      // Run syncDueWebcalSubscriptions
      const syncResults = await syncDueWebcalSubscriptions(now);
      assert.ok(syncResults.syncedCount >= 1);
      assert.equal(mockRefreshRequests, 1);

      // Verify staleSub cache was updated
      const updatedStaleCached = parseWebcalFeed(await Db.getCachedWebcalIcs(staleSub.id, userId), staleSub, '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
      assert.equal(updatedStaleCached.length, 1);
      assert.equal(updatedStaleCached[0].id, 'periodic-event-99@example.com');

      // Test worker start and clean stop
      const worker = startWebcalSyncWorker(60000);
      assert.ok(worker && typeof worker.stop === 'function', 'Worker must return a controller with stop()');
      worker.stop();

      await Db.deleteWebcalSubscription(staleSub.id, userId);
      await Db.deleteWebcalSubscription(freshSub.id, userId);
    } finally {
      await new Promise((resolve) => periodicServer.close(resolve));
    }
  });

  await t.test('UI & Client Integration - frontend modules consume api/webcal and expose overlay controls', () => {
    const fs = require('fs');
    const apiJs = fs.readFileSync(path.join(__dirname, '../../public/js/api.js'), 'utf-8');
    const appJs = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf-8');
    const indexHtml = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf-8');
    const calendarJs = fs.readFileSync(path.join(__dirname, '../../public/js/calendar.js'), 'utf-8');
    const eventModalJs = fs.readFileSync(path.join(__dirname, '../../public/js/eventModal.js'), 'utf-8');

    // Requirement 1: WebcalAPI exists in public/js/api.js
    assert.ok(apiJs.includes('WebcalAPI') || apiJs.includes('/api/webcal'), 'public/js/api.js must define Webcal API endpoints');

    // Requirement 1: UI for adding webcal feed by URL
    assert.ok(indexHtml.includes('add-webcal-btn') || indexHtml.includes('webcal-modal') || indexHtml.includes('Abonnement') || indexHtml.includes('webcal-list'), 'index.html must include Webcal subscription UI elements');
    assert.ok(appJs.includes('/api/webcal') || appJs.includes('WebcalAPI'), 'public/js/app.js must consume Webcal API');

    // Requirement 3: Overlay with toggle, isSubscription, subscriptionId, readOnly
    assert.ok(appJs.includes('isSubscription') || calendarJs.includes('isSubscription'), 'Frontend must consume isSubscription flag');
    assert.ok(appJs.includes('subscriptionId') || calendarJs.includes('subscriptionId'), 'Frontend must consume subscriptionId');
    assert.ok(eventModalJs.includes('isSubscription') || eventModalJs.includes('Webcal') || eventModalJs.includes('Abonnement'), 'Event modal must handle Webcal subscription read-only state');
  });
});

