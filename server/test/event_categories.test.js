'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const { parseVEventToEvent, parseICSToEvent, eventToICS, isNoOpEventSave } = require('../utils/ical');
const { parseVTodoToTask, taskToICS } = require('../caldav/parser');

test('Issue #18 — Event & Task Categorization (CATEGORIES) Test Suite', async (t) => {
  await t.test('parseICSToEvent extracts CATEGORIES into categories array', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:cat-test-1@example.com',
      'SUMMARY:Project Planning',
      'DTSTART:20260901T090000Z',
      'DTEND:20260901T100000Z',
      'CATEGORIES:WORK, PROJECT-ALPHA, MEETING ',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const event = parseICSToEvent(ics);
    assert.ok(event, 'Event should parse');
    assert.ok(Array.isArray(event.categories), 'categories should be an array');
    assert.deepEqual(event.categories, ['WORK', 'PROJECT-ALPHA', 'MEETING']);
  });

  await t.test('parseICSToEvent handles multiple CATEGORIES properties', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:cat-test-2@example.com',
      'SUMMARY:Multi Cat Event',
      'DTSTART:20260901T090000Z',
      'DTEND:20260901T100000Z',
      'CATEGORIES:URGENT,WORK',
      'CATEGORIES:CLIENT-X',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const event = parseICSToEvent(ics);
    assert.deepEqual(event.categories, ['URGENT', 'WORK', 'CLIENT-X']);
  });

  await t.test('eventToICS serializes categories array into CATEGORIES line', () => {
    const event = {
      uid: 'cat-test-3@example.com',
      title: 'Strategy Session',
      start: '2026-09-01T14:00:00Z',
      end: '2026-09-01T15:00:00Z',
      categories: ['WORK', 'STRATEGY']
    };

    const ics = eventToICS(event);
    assert.ok(ics.includes('CATEGORIES:WORK,STRATEGY'), 'ICS should contain CATEGORIES line');
  });

  await t.test('eventToICS handles string categories input', () => {
    const event = {
      uid: 'cat-test-4@example.com',
      title: 'String Cat Event',
      start: '2026-09-01T14:00:00Z',
      end: '2026-09-01T15:00:00Z',
      categories: 'PERSONAL, FITNESS'
    };

    const ics = eventToICS(event);
    assert.ok(ics.includes('CATEGORIES:PERSONAL,FITNESS'), 'ICS should format string categories');
  });

  await t.test('isNoOpEventSave detects category changes', () => {
    const existingIcs = eventToICS({
      uid: 'cat-noop-1@example.com',
      title: 'Status Sync',
      start: '2026-09-02T10:00:00Z',
      end: '2026-09-02T11:00:00Z',
      categories: ['WORK', 'SYNC']
    });

    const identicalData = {
      title: 'Status Sync',
      start: '2026-09-02T10:00:00Z',
      end: '2026-09-02T11:00:00Z',
      categories: ['SYNC', 'WORK'] // same categories, different order
    };

    const changedData = {
      title: 'Status Sync',
      start: '2026-09-02T10:00:00Z',
      end: '2026-09-02T11:00:00Z',
      categories: ['WORK', 'IMPORTANT']
    };

    assert.equal(isNoOpEventSave(existingIcs, identicalData), true, 'Identical categories should be no-op');
    assert.equal(isNoOpEventSave(existingIcs, changedData), false, 'Changed categories should NOT be no-op');
  });

  await t.test('parseVTodoToTask extracts CATEGORIES into task object', () => {
    const vtodoComp = new ICAL.Component(ICAL.parse([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-cat-1@example.com',
      'SUMMARY:Review PR',
      'STATUS:NEEDS-ACTION',
      'CATEGORIES:CODE,REVIEW',
      'END:VTODO',
      'END:VCALENDAR'
    ].join('\r\n'))).getFirstSubcomponent('vtodo');

    const task = parseVTodoToTask(vtodoComp);
    assert.ok(Array.isArray(task.categories), 'Task categories should be array');
    assert.deepEqual(task.categories, ['CODE', 'REVIEW']);
  });

  await t.test('taskToICS serializes task categories', () => {
    const task = {
      uid: 'task-cat-2@example.com',
      title: 'Refactor Auth',
      status: 'NEEDS-ACTION',
      categories: ['SECURITY', 'BACKEND']
    };

    const ics = taskToICS(task);
    assert.ok(ics.includes('CATEGORIES:SECURITY,BACKEND'), 'Task ICS should serialize categories');
  });
});
