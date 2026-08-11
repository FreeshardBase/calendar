'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseICSToEvent, parseAndExpandEvent, eventToICS } = require('../caldav/parser');

test('VALARM Parser & Serialization Suite', async (t) => {

  await t.test('should parse VEVENT with VALARM subcomponent correctly', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:valarm-test-1',
      'DTSTART:20260810T100000Z',
      'DTEND:20260810T110000Z',
      'SUMMARY:Important Strategy Sync',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT15M',
      'DESCRIPTION:Reminder: Important Strategy Sync',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const ev = parseICSToEvent(ics);

    assert.strictEqual(ev.uid, 'valarm-test-1');
    assert.strictEqual(ev.title, 'Important Strategy Sync');
    assert.ok(Array.isArray(ev.alarms), 'ev.alarms should be an array');
    assert.strictEqual(ev.alarms.length, 1);
    assert.strictEqual(ev.alarms[0].action, 'DISPLAY');
    assert.strictEqual(ev.alarms[0].trigger, '-PT15M');
    assert.strictEqual(ev.alarms[0].description, 'Reminder: Important Strategy Sync');
  });

  await t.test('should parse multiple VALARM triggers in VEVENT', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:valarm-multi-2',
      'DTSTART:20260810T140000Z',
      'DTEND:20260810T150000Z',
      'SUMMARY:Project Deadline',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-P1D',
      'DESCRIPTION:1 day before deadline',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT1H',
      'DESCRIPTION:1 hour before deadline',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const ev = parseICSToEvent(ics);

    assert.strictEqual(ev.alarms.length, 2);
    assert.strictEqual(ev.alarms[0].trigger, '-P1D');
    assert.strictEqual(ev.alarms[1].trigger, '-PT1H');
  });

  await t.test('should serialize event object with alarms to valid iCalendar VALARM block', () => {
    const event = {
      uid: 'valarm-serialize-3',
      title: 'Doctor Appointment',
      start: '2026-08-11T09:00:00.000Z',
      end: '2026-08-11T10:00:00.000Z',
      alarms: [
        { action: 'DISPLAY', trigger: '-PT30M', description: 'Doctor Appointment in 30 minutes' }
      ]
    };

    const ics = eventToICS(event);

    assert.match(ics, /BEGIN:VALARM/);
    assert.match(ics, /ACTION:DISPLAY/);
    assert.match(ics, /TRIGGER:-PT30M/);
    assert.match(ics, /DESCRIPTION:Doctor Appointment in 30 minutes/);
    assert.match(ics, /END:VALARM/);
  });

  await t.test('should carry alarms when expanding recurring events', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:valarm-recur-4',
      'DTSTART:20260810T090000Z',
      'DTEND:20260810T100000Z',
      'SUMMARY:Daily Standup',
      'RRULE:FREQ=DAILY;COUNT=3',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT10M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const instances = parseAndExpandEvent(ics, '2026-08-09T00:00:00Z', '2026-08-15T23:59:59Z');

    assert.strictEqual(instances.length, 3);
    for (const inst of instances) {
      assert.ok(Array.isArray(inst.alarms), 'expanded instance should have alarms array');
      assert.strictEqual(inst.alarms.length, 1);
      assert.strictEqual(inst.alarms[0].trigger, '-PT10M');
    }
  });

  await t.test('should parse trigger offsets and calculate target alarm times', () => {
    const { parseTriggerOffsetMs, calculateAlarmTime } = require('../utils/ical');

    assert.strictEqual(parseTriggerOffsetMs('-PT15M'), -15 * 60 * 1000);
    assert.strictEqual(parseTriggerOffsetMs('-PT1H'), -60 * 60 * 1000);
    assert.strictEqual(parseTriggerOffsetMs('-P1D'), -24 * 60 * 60 * 1000);
    assert.strictEqual(parseTriggerOffsetMs('-P1W'), -7 * 24 * 60 * 60 * 1000);
    assert.strictEqual(parseTriggerOffsetMs('PT0S'), 0);
    assert.strictEqual(parseTriggerOffsetMs('TRIGGER:-PT30M'), -30 * 60 * 1000);

    const eventStart = '2026-08-11T10:00:00.000Z';
    const alarmTime = calculateAlarmTime(eventStart, '-PT15M');
    assert.strictEqual(alarmTime.toISOString(), '2026-08-11T09:45:00.000Z');
  });

});


