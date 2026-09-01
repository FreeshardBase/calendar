'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { checkCalendarAccess, extractCalendarIdFromHref } = require('../utils/calendarAuth');

test('Issue #144 — User ID & CalDAV Collection Path Canonicalization & Multi-User Preservation', async (t) => {
  const userId = 'sub-uuid-144-multitenant';
  const username = 'alice144';

  // Clean up existing test user
  await new Promise((resolve) => Db.db.run('DELETE FROM users WHERE user_id = ? OR username = ?', [userId, username], resolve));

  await t.test('1. Db.upsertUser registers user_id and canonical username mapping', async () => {
    await Db.upsertUser(userId, username);
    const resolvedUsername = await Db.getUsernameByUserId(userId);
    const resolvedUserId = await Db.getUserIdByUsername(username);

    assert.equal(resolvedUsername, username, 'Db.getUsernameByUserId should return mapped canonical username');
    assert.equal(resolvedUserId, userId, 'Db.getUserIdByUsername should return mapped user_id');
  });

  await t.test('2. checkCalendarAccess recognizes ownership under both user_id and canonical username collection paths', async () => {
    const reqWithUserId = { session: { userId } };
    const reqWithUsername = { session: { userId: username } };

    const calIdUsernamePath = `internal-caldav::/${username}/personal/`;
    const calIdUserIdPath = `internal-caldav::/${userId}/personal/`;

    // User logged in with UUID sub accessing calendar with username collection path
    const res1 = await checkCalendarAccess(reqWithUserId, calIdUsernamePath, 'write');
    assert.equal(res1.allowed, true, 'User with UUID sub should have access to calendar under canonical username path');
    assert.equal(res1.isOwner, true, 'User should be recognized as owner');

    // User logged in with UUID sub accessing calendar with userId collection path
    const res2 = await checkCalendarAccess(reqWithUserId, calIdUserIdPath, 'write');
    assert.equal(res2.allowed, true, 'User with UUID sub should have access to calendar under userId path');
    assert.equal(res2.isOwner, true, 'User should be recognized as owner');

    // User logged in with username accessing calendar with UUID sub path
    const res3 = await checkCalendarAccess(reqWithUsername, calIdUserIdPath, 'write');
    assert.equal(res3.allowed, true, 'User logged in with username should have access to calendar under UUID sub path');
    assert.equal(res3.isOwner, true);
  });

  await t.test('3. Shared calendar permissions resolve correctly regardless of user_id vs username in calendar_id', async () => {
    const shareeUserId = 'sub-uuid-144-sharee';
    const shareeUsername = 'bob144';
    await Db.upsertUser(shareeUserId, shareeUsername);

    const sharedCalId = `internal-caldav::/${username}/team/`;
    await Db.addUserShare(sharedCalId, shareeUserId, 1, 'ACCEPTED', 'WRITE');

    const reqSharee = { session: { userId: shareeUserId } };
    const accessRes = await checkCalendarAccess(reqSharee, sharedCalId, 'write');
    assert.equal(accessRes.allowed, true, 'Sharee should have write access to shared calendar');

    // Clean up share
    await new Promise((resolve) => Db.db.run('DELETE FROM user_calendar_shares WHERE calendar_id = ?', [sharedCalId], resolve));
    await new Promise((resolve) => Db.db.run('DELETE FROM users WHERE user_id = ?', [shareeUserId], resolve));
  });

  await t.test('4. Session accounts initializes internal-caldav URL with canonical username', async () => {
    const canonicalUsername = (await Db.getUsernameByUserId(userId)) || userId;
    assert.equal(canonicalUsername, username);
    const expectedUrlSegment = `/${username}/`;

    const localCalDAVCUrl = process.env.INTERNAL_CALDAV_URL || 'https://localhost:5232';
    const accountUrl = `${localCalDAVCUrl}/${canonicalUsername}/`;
    assert.ok(accountUrl.includes(expectedUrlSegment), 'Account URL should contain canonical username');
  });

  // Teardown
  await new Promise((resolve) => Db.db.run('DELETE FROM users WHERE user_id = ? OR username = ?', [userId, username], resolve));
});
