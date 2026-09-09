'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseTriggerOffsetMs, calculateAlarmTime, parseValarms } = require('../utils/ical');
const { parseValarmOffset, evaluateUpcomingAlarms } = require('../utils/webPushNotifications');

test('Issue #208 — VALARM Corruption Resilience Suite across Non-Write Routes', async (t) => {

  await t.test('parseTriggerOffsetMs returns null/NaN on corrupted or invalid trigger strings', () => {
    assert.strictEqual(parseTriggerOffsetMs('INVALID_TRIGGER'), null, 'Corrupted trigger string should return null');
    assert.strictEqual(parseTriggerOffsetMs('CORRUPTED'), null, 'Corrupted trigger string should return null');
    assert.strictEqual(parseTriggerOffsetMs('P'), null, 'Single letter P duration without numbers should return null');
    assert.strictEqual(parseTriggerOffsetMs('PT'), null, 'PT duration without numbers should return null');
    assert.strictEqual(parseTriggerOffsetMs('P123'), null, 'P followed by numbers without unit designator should return null');
    assert.strictEqual(parseTriggerOffsetMs({}), null, 'Object input should return null');
  });

  await t.test('parseTriggerOffsetMs correctly parses valid ISO 8601 durations and absolute date-times', () => {
    assert.strictEqual(parseTriggerOffsetMs('-PT15M'), -15 * 60 * 1000);
    assert.strictEqual(parseTriggerOffsetMs('PT30M'), 30 * 60 * 1000);
    assert.strictEqual(parseTriggerOffsetMs('-P1D'), -24 * 60 * 60 * 1000);
    assert.strictEqual(parseTriggerOffsetMs('-P2W'), -14 * 24 * 60 * 60 * 1000);
    assert.strictEqual(parseTriggerOffsetMs('PT0S'), 0);
    assert.strictEqual(parseTriggerOffsetMs('0'), 0);

    const eventStart = '2026-09-09T10:00:00.000Z';
    // Absolute DATE-TIME trigger: 2026-09-09T09:30:00Z (30 minutes before start)
    const absoluteOffset = parseTriggerOffsetMs('2026-09-09T09:30:00.000Z', eventStart);
    assert.strictEqual(absoluteOffset, -30 * 60 * 1000);
  });

  await t.test('calculateAlarmTime returns null for corrupted trigger inputs', () => {
    const eventStart = '2026-09-09T10:00:00.000Z';
    assert.strictEqual(calculateAlarmTime(eventStart, 'INVALID_CORRUPT_TRIGGER'), null);
    assert.strictEqual(calculateAlarmTime(eventStart, 'P'), null);
    assert.strictEqual(calculateAlarmTime(null, '-PT15M'), null);
  });

  await t.test('parseValarmOffset in webPushNotifications handles corrupted triggers correctly', () => {
    assert.strictEqual(parseValarmOffset('INVALID_TRIGGER'), null);
    assert.strictEqual(parseValarmOffset('CORRUPTED'), null);
    assert.strictEqual(parseValarmOffset('-PT15M'), -15 * 60 * 1000);
    assert.strictEqual(parseValarmOffset('-P1W'), -7 * 24 * 60 * 60 * 1000);
  });

  await t.test('evaluateUpcomingAlarms skips corrupted VALARM triggers without generating false notifications', () => {
    const events = [
      {
        id: 'ev-corrupt-1',
        title: 'Corrupted Trigger Event',
        start: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        alarms: [
          { action: 'DISPLAY', trigger: 'CORRUPTED_VALARM_TRIGGER' },
          { action: 'DISPLAY', trigger: '-PT15M' }
        ]
      }
    ];

    const triggered = evaluateUpcomingAlarms(events, { now: Date.now(), windowMinutes: 30, lookbackMinutes: 30 });
    assert.strictEqual(triggered.length, 1, 'Only the valid alarm should be triggered, corrupted alarm skipped');
    assert.strictEqual(triggered[0].trigger, '-PT15M');
  });

});
