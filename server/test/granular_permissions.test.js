'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3102';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');

test('Issue #3 — Granular Permission Management for Shared Calendars', async (t) => {
  if (server && !server.listening) {
    await new Promise((resolve) => server.listen(process.env.PORT || 3102, resolve));
  }

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll();

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let ownerCookie = '';
  let readOnlyCookie = '';
  let freeBusyCookie = '';
  let adminShareeCookie = '';

  const ownerUserId = 'test-owner-granular';
  const readOnlyUserId = 'test-readonly-granular';
  const freeBusyUserId = 'test-freebusy-granular';
  const adminShareeUserId = 'test-admin-granular';

  await Db.upsertUser(ownerUserId, 'owner_granular@example.com');
  await Db.upsertUser(readOnlyUserId, 'readonly_granular@example.com');
  await Db.upsertUser(freeBusyUserId, 'freebusy_granular@example.com');
  await Db.upsertUser(adminShareeUserId, 'admin_granular@example.com');

  const ownerCalId = `internal-caldav::/${ownerUserId}/personal/`;
  const timeQuery = '&start=2026-01-01T00:00:00Z&end=2026-12-31T23:59:59Z';

  await t.test('Authenticate user sessions', async () => {
    ownerCookie = await loginAs(ownerUserId);
    const res1 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: ownerCookie }
    });
    assert.strictEqual(res1.status, 200);

    readOnlyCookie = await loginAs(readOnlyUserId);
    const res2 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: readOnlyCookie }
    });
    assert.strictEqual(res2.status, 200);

    freeBusyCookie = await loginAs(freeBusyUserId);
    const res3 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: freeBusyCookie }
    });
    assert.strictEqual(res3.status, 200);

    adminShareeCookie = await loginAs(adminShareeUserId);
    const res4 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: adminShareeCookie }
    });
    assert.strictEqual(res4.status, 200);
  });

  await t.test('Owner creates a share with FREE_BUSY role', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      method: 'POST',
      headers: {
        'Cookie': ownerCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sharee: freeBusyUserId,
        role: 'FREE_BUSY',
        canViewPrivate: false,
        canManageShares: false
      })
    });
    assert.strictEqual(res.status, 200);
  });

  await t.test('Owner creates a share with READ role and canViewPrivate=false', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      method: 'POST',
      headers: {
        'Cookie': ownerCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sharee: readOnlyUserId,
        role: 'READ',
        canViewPrivate: false,
        canManageShares: false
      })
    });
    assert.strictEqual(res.status, 200);
  });

  await t.test('Owner creates a share with ADMIN role and canManageShares=true', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      method: 'POST',
      headers: {
        'Cookie': ownerCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sharee: adminShareeUserId,
        role: 'ADMIN',
        canViewPrivate: true,
        canManageShares: true
      })
    });
    assert.strictEqual(res.status, 200);
  });

  await t.test('Accept all share invitations for test sharees', async () => {
    const dbShares = await Db.getUserShares(ownerCalId);
    for (const share of dbShares) {
      await Db.updateShareStatus(share.id, 'ACCEPTED');
    }
  });

  await t.test('FREE_BUSY sharee cannot modify calendar events (returns 403)', async () => {
    const res = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: {
        'Cookie': freeBusyCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        calendarId: ownerCalId,
        title: 'Unauthorized Event',
        startDate: '2026-06-01',
        startTime: '10:00',
        endDate: '2026-06-01',
        endTime: '11:00'
      })
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('READ sharee cannot manage calendar shares (returns 403)', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      headers: { 'Cookie': readOnlyCookie }
    });
    assert.strictEqual(res.status, 403, 'Read-only sharee without canManageShares should be forbidden from reading share list');
  });

  await t.test('ADMIN sharee can manage calendar shares', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      headers: { 'Cookie': adminShareeCookie }
    });
    assert.strictEqual(res.status, 200, 'Admin sharee with canManageShares should be allowed to view share list');
    const data = await res.json();
    assert.ok(Array.isArray(data.shares));
  });

  await t.test('PUT /api/calendars/:id/shares/:shareeId updates granular permissions', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares/${encodeURIComponent(readOnlyUserId)}`, {
      method: 'PUT',
      headers: {
        'Cookie': ownerCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        role: 'WRITE',
        canViewPrivate: true,
        canManageShares: true
      })
    });
    assert.strictEqual(res.status, 200);

    const sharesRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      headers: { 'Cookie': ownerCookie }
    });
    const sharesData = await sharesRes.json();
    const updated = sharesData.shares.find(s => s.shareeUserId === readOnlyUserId || s.commonName === readOnlyUserId);
    assert.ok(updated);
    assert.strictEqual(updated.role, 'WRITE');
    assert.strictEqual(updated.canViewPrivate, true);
    assert.strictEqual(updated.canManageShares, true);
  });
});
