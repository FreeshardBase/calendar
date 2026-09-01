'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { checkCalendarAccess } = require('../utils/calendarAuth');

test('Issue #140 — Deleting a calendar purges shares and prevents access resurrection upon recreation', async (t) => {
  const ownerUserId = 'test-owner-issue140';
  const shareeUserId = 'test-sharee-issue140';
  const calendarId = `internal-caldav::/${ownerUserId}/test-calendar-140/`;

  t.after(async () => {
    await Db.deleteUser(ownerUserId);
    await Db.deleteUser(shareeUserId);
    await Db.deleteCalendarData(calendarId);
  });

  // 1. Seed users & share entries
  await Db.upsertUser(ownerUserId, 'owner140@example.com');
  await Db.upsertUser(shareeUserId, 'sharee140@example.com');

  // Add internal user share
  await Db.addUserShare(calendarId, shareeUserId, true, 'ACCEPTED', 'WRITE');

  // Add public share token
  const publicShare = await Db.addCalendarShare(calendarId, 'Test Public Link');

  // Add color override
  await Db.setUserCalendarColorOverride(ownerUserId, calendarId, '#123456');
  await Db.setUserCalendarColorOverride(shareeUserId, calendarId, '#654321');

  // Verify setup
  const sharesBefore = await Db.getUserShares(calendarId);
  assert.strictEqual(sharesBefore.length, 1);
  assert.strictEqual(sharesBefore[0].shareeUserId, shareeUserId);

  const publicSharesBefore = await Db.getCalendarShares(calendarId);
  assert.strictEqual(publicSharesBefore.length, 1);
  assert.strictEqual(publicSharesBefore[0].token, publicShare.token);

  const reqSharee = { session: { userId: shareeUserId } };
  const accessBefore = await checkCalendarAccess(reqSharee, calendarId, 'read');
  assert.strictEqual(accessBefore.allowed, true);

  // 2. Delete calendar data
  await Db.deleteCalendarData(calendarId);

  // 3. Assert all DB entries purged
  const sharesAfter = await Db.getUserShares(calendarId);
  assert.strictEqual(sharesAfter.length, 0);

  const publicSharesAfter = await Db.getCalendarShares(calendarId);
  assert.strictEqual(publicSharesAfter.length, 0);

  const sharedForUserAfter = await Db.getSharedCalendarsForUser(shareeUserId);
  const matchingShared = sharedForUserAfter.find(s => s.calendar_id === calendarId);
  assert.strictEqual(matchingShared, undefined);

  // 4. Assert access resurrection is prevented (sharee can no longer access this calendar ID)
  const accessAfter = await checkCalendarAccess(reqSharee, calendarId, 'read');
  assert.strictEqual(accessAfter.allowed, false);
});
