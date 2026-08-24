'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { checkCalendarAccess } = require('../utils/calendarAuth');

test('Calendar Authorization & Access Control Suite (Issue #50)', async (t) => {
  await Db.clearAll().catch(() => {});

  const ownerUserId = 'user-owner-uuid';
  const strangerUserId = 'user-stranger-uuid';
  const readOnlyUser = 'user-readonly-uuid';
  const readWriteUser = 'user-readwrite-uuid';

  await Db.upsertUser(ownerUserId, 'owner@example.com');
  await Db.upsertUser(strangerUserId, 'stranger@example.com');
  await Db.upsertUser(readOnlyUser, 'readonly@example.com');
  await Db.upsertUser(readWriteUser, 'readwrite@example.com');

  const foreignCalId = `internal-caldav::/${ownerUserId}/personal/`;

  await Db.addUserShare(foreignCalId, readOnlyUser, false);
  await Db.addUserShare(foreignCalId, readWriteUser, true);

  await t.test('Owner has full access (read, write, owner)', async () => {
    const req = { session: { userId: ownerUserId, accounts: [{ id: 'internal-caldav' }] } };
    
    const readCheck = await checkCalendarAccess(req, foreignCalId, 'read');
    assert.strictEqual(readCheck.allowed, true);
    assert.strictEqual(readCheck.isOwner, true);

    const writeCheck = await checkCalendarAccess(req, foreignCalId, 'write');
    assert.strictEqual(writeCheck.allowed, true);
    assert.strictEqual(writeCheck.isOwner, true);

    const ownerCheck = await checkCalendarAccess(req, foreignCalId, 'owner');
    assert.strictEqual(ownerCheck.allowed, true);
    assert.strictEqual(ownerCheck.isOwner, true);
  });

  await t.test('Unauthenticated user receives 401', async () => {
    const req = { session: {} };
    const res = await checkCalendarAccess(req, foreignCalId, 'read');
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.status, 401);
  });

  await t.test('Unauthorized stranger receives 403 Forbidden on read/write/owner', async () => {
    const req = { session: { userId: strangerUserId, accounts: [{ id: 'internal-caldav' }] } };

    const readCheck = await checkCalendarAccess(req, foreignCalId, 'read');
    assert.strictEqual(readCheck.allowed, false);
    assert.strictEqual(readCheck.status, 403);

    const writeCheck = await checkCalendarAccess(req, foreignCalId, 'write');
    assert.strictEqual(writeCheck.allowed, false);
    assert.strictEqual(writeCheck.status, 403);

    const ownerCheck = await checkCalendarAccess(req, foreignCalId, 'owner');
    assert.strictEqual(ownerCheck.allowed, false);
    assert.strictEqual(ownerCheck.status, 403);
  });

  await t.test('Read-only shared user is allowed read, but denied write and owner', async () => {
    const req = { session: { userId: readOnlyUser, accounts: [{ id: 'internal-caldav' }] } };

    const readCheck = await checkCalendarAccess(req, foreignCalId, 'read');
    assert.strictEqual(readCheck.allowed, true);
    assert.strictEqual(readCheck.readOnly, true);

    const writeCheck = await checkCalendarAccess(req, foreignCalId, 'write');
    assert.strictEqual(writeCheck.allowed, false);
    assert.strictEqual(writeCheck.status, 403);

    const ownerCheck = await checkCalendarAccess(req, foreignCalId, 'owner');
    assert.strictEqual(ownerCheck.allowed, false);
    assert.strictEqual(ownerCheck.status, 403);
  });

  await t.test('Read-write shared user is allowed read and write, but denied owner actions', async () => {
    const req = { session: { userId: readWriteUser, accounts: [{ id: 'internal-caldav' }] } };

    const readCheck = await checkCalendarAccess(req, foreignCalId, 'read');
    assert.strictEqual(readCheck.allowed, true);

    const writeCheck = await checkCalendarAccess(req, foreignCalId, 'write');
    assert.strictEqual(writeCheck.allowed, true);

    const ownerCheck = await checkCalendarAccess(req, foreignCalId, 'owner');
    assert.strictEqual(ownerCheck.allowed, false);
    assert.strictEqual(ownerCheck.status, 403);
  });
});
