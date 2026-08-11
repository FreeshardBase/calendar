'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3098';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectICSConflicts, resolveICSImport } = require('../utils/icsConflictResolver');

test('ICS Conflict Resolver Unit & Integration Suite', async (t) => {

  const existingEvents = [
    {
      uid: 'ev-1',
      title: 'Quarterly Planning',
      start: '2026-10-01T09:00:00.000Z',
      end: '2026-10-01T10:00:00.000Z',
      description: 'Discuss Q4 roadmap',
      location: 'Conference Room A'
    },
    {
      uid: 'ev-2',
      title: 'Sync with External Team',
      start: '2026-10-02T14:00:00.000Z',
      end: '2026-10-02T15:00:00.000Z',
      description: 'Initial kickoff',
      location: 'Online'
    }
  ];

  await t.test('detectICSConflicts identifies exact duplicates', () => {
    const duplicateIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:ev-1
SUMMARY:Quarterly Planning
DTSTART:20261001T090000Z
DTEND:20261001T100000Z
DESCRIPTION:Discuss Q4 roadmap
LOCATION:Conference Room A
END:VEVENT
END:VCALENDAR`;

    const result = detectICSConflicts(duplicateIcs, existingEvents);
    assert.equal(result.summary.total, 1);
    assert.equal(result.summary.duplicateCount, 1);
    assert.equal(result.conflicts[0].status, 'EXACT_DUPLICATE');
    assert.equal(result.conflicts[0].suggestedAction, 'SKIP');
  });

  await t.test('detectICSConflicts identifies modified conflicts', () => {
    const modifiedIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:ev-1
SUMMARY:Quarterly Planning (Updated)
DTSTART:20261001T093000Z
DTEND:20261001T110000Z
DESCRIPTION:Updated Q4 roadmap
LOCATION:Main Hall
END:VEVENT
END:VCALENDAR`;

    const result = detectICSConflicts(modifiedIcs, existingEvents);
    assert.equal(result.summary.total, 1);
    assert.equal(result.summary.conflictCount, 1);
    assert.equal(result.conflicts[0].status, 'MODIFIED_CONFLICT');
    assert.equal(result.conflicts[0].suggestedAction, 'OVERWRITE');
    assert.ok(result.conflicts[0].existingEvent);
  });

  await t.test('detectICSConflicts identifies time overlap collisions', () => {
    const overlapIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:ev-new-overlap
SUMMARY:Conflicting Client Call
DTSTART:20261002T143000Z
DTEND:20261002T153000Z
LOCATION:Zoom
END:VEVENT
END:VCALENDAR`;

    const result = detectICSConflicts(overlapIcs, existingEvents);
    assert.equal(result.summary.total, 1);
    assert.equal(result.conflicts[0].status, 'TIME_OVERLAP');
    assert.equal(result.conflicts[0].existingEvent.uid, 'ev-2');
  });

  await t.test('detectICSConflicts identifies completely new events', () => {
    const newIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:ev-brand-new
SUMMARY:All Hands Meeting
DTSTART:20261010T100000Z
DTEND:20261010T110000Z
END:VEVENT
END:VCALENDAR`;

    const result = detectICSConflicts(newIcs, existingEvents);
    assert.equal(result.summary.total, 1);
    assert.equal(result.summary.newCount, 1);
    assert.equal(result.conflicts[0].status, 'NEW');
    assert.equal(result.conflicts[0].suggestedAction, 'CREATE_NEW');
  });

  await t.test('resolveICSImport handles SKIP, OVERWRITE, and CREATE_NEW strategies', () => {
    const mixedIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:ev-1
SUMMARY:Quarterly Planning
DTSTART:20261001T090000Z
DTEND:20261001T100000Z
END:VEVENT
BEGIN:VEVENT
UID:ev-2
SUMMARY:Sync with External Team (Modified)
DTSTART:20261002T140000Z
DTEND:20261002T160000Z
END:VEVENT
BEGIN:VEVENT
UID:ev-3
SUMMARY:New Workshop
DTSTART:20261005T080000Z
DTEND:20261005T090000Z
END:VEVENT
END:VCALENDAR`;

    const resolutions = {
      'ev-1': 'SKIP',
      'ev-2': 'OVERWRITE',
      'ev-3': 'CREATE_NEW'
    };

    const resolved = resolveICSImport(mixedIcs, existingEvents, resolutions);
    assert.equal(resolved.length, 2); // ev-1 skipped
    assert.equal(resolved.find(r => r.uid === 'ev-2').action, 'OVERWRITE');
    assert.equal(resolved.find(r => r.originalUid === 'ev-3').action, 'CREATE_NEW');
    assert.notEqual(resolved.find(r => r.originalUid === 'ev-3').uid, 'ev-3'); // new UID generated
  });
});
