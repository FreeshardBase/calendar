'use strict';
process.env.NODE_ENV = 'test';
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
  fetchAndParseWebcalFeed
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
    const events = parseWebcalFeed(mockIcs, subscription);

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
});
