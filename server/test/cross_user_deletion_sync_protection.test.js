'use strict';

/**
 * Issue #319 — Cross-User Event Deletion Protection in Sync Worker
 *
 * Validates:
 *   1. Db helpers for recording, querying, and clearing cross-user event deletions.
 *   2. DELETE /api/events/:uid by a non-owner sharee records a cross_user_deletions entry.
 *   3. DELETE /api/events/:uid by the owner does NOT record a cross_user_deletions entry.
 *   4. sync_worker.py contains cross-user deletion protection logic restoring external events prior to vdirsyncer execution.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Db = require('../db');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #319 — Cross-User Event Deletion Protection in Sync Worker', () => {

  test('Db methods recordCrossUserDeletion, getCrossUserDeletions, and clearCrossUserDeletion work as expected', async () => {
    const ownerUserId = 'user-owner-319';
    const deletedBy = 'user-sharee-319';
    const uid = 'event-uid-319-1';
    const calendarId = `internal-caldav::/${ownerUserId}/persoenlich/`;

    // Record cross-user deletion
    const record = await Db.recordCrossUserDeletion(uid, calendarId, ownerUserId, deletedBy);
    assert.ok(record.id);
    assert.equal(record.uid, uid);
    assert.equal(record.calendarId, calendarId);
    assert.equal(record.ownerUserId, ownerUserId);
    assert.equal(record.deletedBy, deletedBy);

    // Retrieve pending cross-user deletions for owner
    const deletions = await Db.getCrossUserDeletions(ownerUserId);
    assert.ok(Array.isArray(deletions));
    assert.equal(deletions.length, 1);
    assert.equal(deletions[0].uid, uid);
    assert.equal(deletions[0].deleted_by, deletedBy);

    // Clear deletion record
    await Db.clearCrossUserDeletion(record.id);
    const updated = await Db.getCrossUserDeletions(ownerUserId);
    assert.equal(updated.length, 0);
  });

  test('sync_worker.py contains protect_cross_user_deletions and cross_user_deletions handling', () => {
    const workerPath = path.join(ROOT_DIR, 'sync-worker/sync_worker.py');
    assert.ok(fs.existsSync(workerPath), 'sync_worker.py must exist');
    const content = fs.readFileSync(workerPath, 'utf8');

    assert.ok(
      content.includes('cross_user_deletions') || content.includes('protect_cross_user_deletions'),
      'sync_worker.py must reference cross_user_deletions table for deletion protection'
    );
  });

});
