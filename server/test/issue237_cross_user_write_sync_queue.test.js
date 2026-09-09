'use strict';

/**
 * Issue #237 — Cross-user write enqueues owner's Google sync
 *
 * Root cause: queueSyncForCalendar (server/utils/calendarAuth.js) calls
 * Db.addSyncJob(ownerUserId) whenever the acting user has write access to
 * the calendar, regardless of whether they ARE the owner.  A write-sharee
 * therefore triggers the victim's Google sync, potentially pushing the
 * injected event out to the victim's real external calendar.
 *
 * Fix: only enqueue the owner's sync job when access.isOwner is true.
 * A sharee with write access must only enqueue their own job (if any).
 *
 * Validates:
 *   1. Owner writing their own calendar: only owner job enqueued.
 *   2. Write-sharee writing owner's calendar: NO owner sync job enqueued,
 *      only the sharee's own job.
 *   3. Read-sharee: no owner sync job enqueued regardless.
 *   4. Unauthorized (unknown) user: no sync job enqueued.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');

// ─── helpers ─────────────────────────────────────────────────────────────────

async function clearJobsForUsers(...userIds) {
  for (const uid of userIds) {
    if (!uid) continue;
    await new Promise((res, rej) =>
      Db.db.run('DELETE FROM sync_queue WHERE user_id = ?', [uid], (err) => (err ? rej(err) : res()))
    );
  }
}

async function getJobsForUser(userId) {
  return new Promise((res, rej) =>
    Db.db.all('SELECT * FROM sync_queue WHERE user_id = ?', [userId], (err, rows) => (err ? rej(err) : res(rows || [])))
  );
}

test.describe('Issue #237 — cross-user write must not enqueue owner sync', () => {

  const OWNER_UUID    = 'aaaabbbb-cccc-dddd-eeee-ffff00000001';
  const SHAREE_UUID   = 'aaaabbbb-cccc-dddd-eeee-ffff00000002';
  const STRANGER_UUID = 'aaaabbbb-cccc-dddd-eeee-ffff00000003';
  const CALENDAR_ID   = `internal-caldav::/${OWNER_UUID}/persoenlich/`;

  let _origGetShared, _origGetIdByUsername, _origGetUsernameById;

  function patchDb({ sharedCalendars = [] } = {}) {
    _origGetShared       = Db.getSharedCalendarsForUser.bind(Db);
    _origGetIdByUsername = Db.getUserIdByUsername.bind(Db);
    _origGetUsernameById = Db.getUsernameByUserId.bind(Db);

    Db.getUserIdByUsername   = async () => null;
    Db.getUsernameByUserId   = async () => null;
    Db.getSharedCalendarsForUser = async (userId) =>
      sharedCalendars.filter(s => s.sharee_user_id === userId);
  }

  function restoreDb() {
    if (_origGetShared)       Db.getSharedCalendarsForUser = _origGetShared;
    if (_origGetIdByUsername) Db.getUserIdByUsername       = _origGetIdByUsername;
    if (_origGetUsernameById) Db.getUsernameByUserId       = _origGetUsernameById;
  }

  const { queueSyncForCalendar } = require('../utils/calendarAuth');

  test('owner writing their own calendar: owner sync job enqueued', async () => {
    patchDb({ sharedCalendars: [] });
    await clearJobsForUsers(OWNER_UUID);
    try {
      await queueSyncForCalendar(CALENDAR_ID, OWNER_UUID);
      const ownerJobs = await getJobsForUser(OWNER_UUID);
      assert.equal(ownerJobs.length, 1, 'owner must have one sync job');
    } finally {
      await clearJobsForUsers(OWNER_UUID);
      restoreDb();
    }
  });

  test('write-sharee writing owner calendar: NO owner sync job, only sharee job', async () => {
    patchDb({
      sharedCalendars: [{
        calendar_id: CALENDAR_ID,
        sharee_user_id: SHAREE_UUID,
        role: 'WRITE',
        read_write: 1,
        can_manage_shares: 0,
        can_view_private: 0,
      }]
    });
    await clearJobsForUsers(OWNER_UUID, SHAREE_UUID);
    try {
      await queueSyncForCalendar(CALENDAR_ID, SHAREE_UUID);
      const ownerJobs  = await getJobsForUser(OWNER_UUID);
      const shareeJobs = await getJobsForUser(SHAREE_UUID);
      assert.equal(ownerJobs.length,  0, 'owner must NOT have a sync job triggered by sharee write');
      assert.equal(shareeJobs.length, 1, 'sharee must have their own sync job');
    } finally {
      await clearJobsForUsers(OWNER_UUID, SHAREE_UUID);
      restoreDb();
    }
  });

  test('read-sharee: no owner sync job enqueued', async () => {
    patchDb({
      sharedCalendars: [{
        calendar_id: CALENDAR_ID,
        sharee_user_id: SHAREE_UUID,
        role: 'READ',
        read_write: 0,
        can_manage_shares: 0,
        can_view_private: 0,
      }]
    });
    await clearJobsForUsers(OWNER_UUID, SHAREE_UUID);
    try {
      await queueSyncForCalendar(CALENDAR_ID, SHAREE_UUID);
      const ownerJobs = await getJobsForUser(OWNER_UUID);
      assert.equal(ownerJobs.length, 0, 'read-sharee must NOT trigger owner sync job');
    } finally {
      await clearJobsForUsers(OWNER_UUID, SHAREE_UUID);
      restoreDb();
    }
  });

  test('completely unauthorized user: no sync jobs enqueued', async () => {
    patchDb({ sharedCalendars: [] });
    await clearJobsForUsers(OWNER_UUID, STRANGER_UUID);
    try {
      await queueSyncForCalendar(CALENDAR_ID, STRANGER_UUID);
      const ownerJobs    = await getJobsForUser(OWNER_UUID);
      const strangerJobs = await getJobsForUser(STRANGER_UUID);
      assert.equal(ownerJobs.length,    0, 'owner must not have sync job from stranger');
      assert.equal(strangerJobs.length, 0, 'stranger must not have sync job');
    } finally {
      await clearJobsForUsers(OWNER_UUID, STRANGER_UUID);
      restoreDb();
    }
  });

});
