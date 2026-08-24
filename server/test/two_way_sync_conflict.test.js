'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3099';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { detectTwoWayConflict, resolveTwoWayConflict } = require('../utils/twoWaySyncResolver');
const db = require('../db');

test('Two-Way Sync Conflict Resolution Suite (Issue #5)', async (t) => {
  const localIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test Local//EN
BEGIN:VEVENT
UID:sync-event-100
SEQUENCE:1
LAST-MODIFIED:20260824T100000Z
SUMMARY:Local Event Title
DESCRIPTION:Local description
LOCATION:Office A
DTSTART:20260901T100000Z
DTEND:20260901T110000Z
END:VEVENT
END:VCALENDAR`;

  const remoteIcsNewer = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test Remote//EN
BEGIN:VEVENT
UID:sync-event-100
SEQUENCE:2
LAST-MODIFIED:20260824T120000Z
SUMMARY:Remote Event Title Updated
DESCRIPTION:Remote description updated
LOCATION:Room B
DTSTART:20260901T100000Z
DTEND:20260901T110000Z
END:VEVENT
END:VCALENDAR`;

  await t.test('detectTwoWayConflict identifies identical events as no conflict', () => {
    const res = detectTwoWayConflict(localIcs, localIcs);
    assert.equal(res.hasConflict, false);
  });

  await t.test('detectTwoWayConflict detects divergence between local and remote events', () => {
    const res = detectTwoWayConflict(localIcs, remoteIcsNewer);
    assert.equal(res.hasConflict, true);
    assert.equal(res.uid, 'sync-event-100');
    assert.equal(res.localSequence, 1);
    assert.equal(res.remoteSequence, 2);
  });

  await t.test('resolveTwoWayConflict supports LOCAL_WINS strategy', () => {
    const resolved = resolveTwoWayConflict(localIcs, remoteIcsNewer, 'LOCAL_WINS');
    assert.ok(resolved.includes('Local Event Title'));
  });

  await t.test('resolveTwoWayConflict supports REMOTE_WINS strategy', () => {
    const resolved = resolveTwoWayConflict(localIcs, remoteIcsNewer, 'REMOTE_WINS');
    assert.ok(resolved.includes('Remote Event Title Updated'));
  });

  await t.test('resolveTwoWayConflict supports LAST_MODIFIED_WINS strategy', () => {
    const resolved = resolveTwoWayConflict(localIcs, remoteIcsNewer, 'LAST_MODIFIED_WINS');
    assert.ok(resolved.includes('Remote Event Title Updated'));
  });

  await t.test('resolveTwoWayConflict supports MERGE_PROPERTIES strategy', () => {
    const localPart = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:sync-event-200
SEQUENCE:1
SUMMARY:Merged Meeting
DESCRIPTION:Local updated description
LOCATION:Room 101
DTSTART:20260902T100000Z
DTEND:20260902T110000Z
X-LOCAL-TAG:value1
END:VEVENT
END:VCALENDAR`;

    const remotePart = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:sync-event-200
SEQUENCE:2
SUMMARY:Merged Meeting
DESCRIPTION:Original description
LOCATION:Room 202 Remote
DTSTART:20260902T100000Z
DTEND:20260902T110000Z
X-REMOTE-TAG:value2
END:VEVENT
END:VCALENDAR`;

    const merged = resolveTwoWayConflict(localPart, remotePart, 'MERGE_PROPERTIES');
    assert.ok(merged.includes('Merged Meeting'));
    assert.ok(merged.includes('Local updated description'));
    assert.ok(merged.includes('Room 202 Remote'));
    assert.ok(merged.includes('X-LOCAL-TAG:value1'));
    assert.ok(merged.includes('X-REMOTE-TAG:value2'));
  });

  await t.test('Database sync_conflicts helper persistence', async () => {
    const testUser = 'user-sync-test';
    const testCal = 'cal-sync-test';
    const testUid = 'sync-event-db-1';

    const conflictId = await db.addSyncConflict(testUser, testCal, testUid, localIcs, remoteIcsNewer);
    assert.ok(conflictId);

    const pending = await db.getPendingSyncConflicts(testUser, testCal);
    assert.ok(Array.isArray(pending));
    const found = pending.find(c => c.uid === testUid);
    assert.ok(found);
    assert.equal(found.status, 'PENDING');

    const resolvedIcs = resolveTwoWayConflict(localIcs, remoteIcsNewer, 'LAST_MODIFIED_WINS');
    const updated = await db.resolveSyncConflict(conflictId, testUser, 'LAST_MODIFIED_WINS', resolvedIcs);
    assert.equal(updated, true);

    const pendingAfter = await db.getPendingSyncConflicts(testUser, testCal);
    const foundAfter = pendingAfter.find(c => c.uid === testUid);
    assert.equal(foundAfter, undefined);
  });
});
