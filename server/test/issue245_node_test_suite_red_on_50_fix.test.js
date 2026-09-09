'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3185';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { app, server } = require('../index');
const { checkCalendarAccess } = require('../utils/calendarAuth');

test('Issue #245 — Node Test Suite Enforcement of Multi-Identity Mechanism & #50 ACL Guard', async (t) => {
  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll().catch(() => {});

  const baseUrl = `http://localhost:${process.env.PORT}`;

  const ownerUserId = 'user245-owner';
  const strangerUserId = 'user245-stranger';
  const shareeUserId = 'user245-sharee';

  await Db.upsertUser(ownerUserId, 'owner245@example.com');
  await Db.upsertUser(strangerUserId, 'stranger245@example.com');
  await Db.upsertUser(shareeUserId, 'sharee245@example.com');

  const ownerCalId = `internal-caldav::/${ownerUserId}/personal/`;

  // Grant sharee read-only share access to owner's calendar
  await Db.addUserShare(ownerCalId, shareeUserId, false);

  await t.test('1. x-test-user-id dynamically switches req.session.userId across requests', async () => {
    const resOwner = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': ownerUserId }
    });
    assert.strictEqual(resOwner.status, 200);

    const resStranger = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': strangerUserId }
    });
    assert.strictEqual(resStranger.status, 200);
  });

  await t.test('2. RequireAuth and checkCalendarAccess enforce #50 ACL for unauthenticated user (401)', async () => {
    const resUnauthHeader = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: { 'x-test-user-id': 'unauthenticated' }
    });
    assert.strictEqual(resUnauthHeader.status, 401, 'unauthenticated x-test-user-id header must return 401');

    const resNoneHeader = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: { 'x-test-user-id': 'none' }
    });
    assert.strictEqual(resNoneHeader.status, 401, 'none x-test-user-id header must return 401');

    const reqUnauth = { session: {} };
    const aclCheck = await checkCalendarAccess(reqUnauth, ownerCalId, 'read');
    assert.strictEqual(aclCheck.allowed, false);
    assert.strictEqual(aclCheck.status, 401);
  });

  await t.test('3. RequireAuth and checkCalendarAccess enforce #50 ACL for stranger (403)', async () => {
    const resStranger = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: { 'x-test-user-id': strangerUserId }
    });
    assert.strictEqual(resStranger.status, 403, 'Stranger request to non-shared calendar must return 403');

    const reqStranger = { session: { userId: strangerUserId, accounts: [{ id: 'internal-caldav' }] } };
    const aclCheck = await checkCalendarAccess(reqStranger, ownerCalId, 'read');
    assert.strictEqual(aclCheck.allowed, false);
    assert.strictEqual(aclCheck.status, 403);
  });

  await t.test('4. RequireAuth and checkCalendarAccess enforce #50 ACL for read-only sharee (200 on read, 403 on write)', async () => {
    const reqSharee = { session: { userId: shareeUserId, accounts: [{ id: 'internal-caldav' }] } };
    const readCheck = await checkCalendarAccess(reqSharee, ownerCalId, 'read');
    assert.strictEqual(readCheck.allowed, true, 'Read-only sharee must have read access');
    assert.strictEqual(readCheck.readOnly, true);

    const writeCheck = await checkCalendarAccess(reqSharee, ownerCalId, 'write');
    assert.strictEqual(writeCheck.allowed, false, 'Read-only sharee must be denied write access');
    assert.strictEqual(writeCheck.status, 403);
  });

  await t.test('5. RequireAuth and checkCalendarAccess allow owner full access (200 on read/write/owner)', async () => {
    const resOwner = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares-public`, {
      headers: { 'x-test-user-id': ownerUserId }
    });
    assert.strictEqual(resOwner.status, 200, 'Owner request to own calendar must return 200');

    const reqOwner = { session: { userId: ownerUserId, accounts: [{ id: 'internal-caldav' }] } };
    const ownerCheck = await checkCalendarAccess(reqOwner, ownerCalId, 'owner');
    assert.strictEqual(ownerCheck.allowed, true, 'Owner must have full owner access');
    assert.strictEqual(ownerCheck.isOwner, true);
  });
});
