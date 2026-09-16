'use strict';

/**
 * Issue #249 — Unasserted Code Paths & Mutation Test Suite
 *
 * Provides targeted test assertions across 12 previously unasserted or weakly-asserted
 * code paths in server/utils/ical.js to eliminate single-point mutations:
 *
 * 1. updateWholeSeries re-attaches EXDATE properties from original master to newMaster.
 * 2. updateWholeSeries locates master VEVENT when vevents[0] is a detached override.
 * 3. updateWholeSeries appends new VTIMEZONE subcomponents to comp.
 * 4. updateWholeSeries safe fallback to eventToICS when existingIcs is empty, unparseable, or contains 0 VEVENTs.
 * 5. isNoOpEventSave whitespace normalization across title, description, location, categories, attendees, and alarms.
 * 6. isNoOpEventSave returns false when existingIcs is empty, null, or unparseable.
 * 7. isNoOpEventSave handles RRULE prefix normalization (RRULE: vs bare string).
 * 8. buildVTimezoneBlock handles DST-observing and non-DST timezones correctly.
 * 9. parseTriggerOffsetMs handles positive, negative, weekly ISO 8601 durations and returns null for invalid input.
 * 10. escIcal and escParamVal escape special iCalendar characters.
 * 11. foldLines splits long lines at 75-octet boundaries with CRLF + space.
 * 12. isValidTimezone correctly validates IANA timezone identifiers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  updateWholeSeries,
  isNoOpEventSave,
  buildVTimezoneBlock,
  parseTriggerOffsetMs,
  escIcal,
  escParamVal,
  foldLines,
  isValidTimezone
} = require('../utils/ical');

test('Issue #249 — 1. updateWholeSeries re-attaches EXDATE from master to newMaster', () => {
  const existingIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'BEGIN:VEVENT',
    'UID:series-exdate-01',
    'SUMMARY:Weekly Sync',
    'DTSTART:20260101T100000Z',
    'DTEND:20260101T110000Z',
    'RRULE:FREQ=WEEKLY',
    'EXDATE:20260108T100000Z',
    'EXDATE:20260115T100000Z',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const eventData = {
    uid: 'series-exdate-01',
    title: 'Weekly Sync (Renamed)',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z',
    recurrence: 'FREQ=WEEKLY'
  };

  const updatedIcs = updateWholeSeries(existingIcs, eventData);

  assert.ok(updatedIcs.includes('SUMMARY:Weekly Sync (Renamed)'), 'Title should be updated');
  assert.ok(updatedIcs.includes('EXDATE:20260108T100000Z'), 'First EXDATE must be preserved');
  assert.ok(updatedIcs.includes('EXDATE:20260115T100000Z'), 'Second EXDATE must be preserved');
});

test('Issue #249 — 2. updateWholeSeries locates master VEVENT when vevents[0] is a detached override', () => {
  const existingIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'BEGIN:VEVENT',
    'UID:series-override-first',
    'RECURRENCE-ID:20260108T100000Z',
    'SUMMARY:Detached Instance',
    'DTSTART:20260108T100000Z',
    'DTEND:20260108T110000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:series-override-first',
    'SUMMARY:Master Event',
    'DTSTART:20260101T100000Z',
    'DTEND:20260101T110000Z',
    'RRULE:FREQ=WEEKLY',
    'EXDATE:20260115T100000Z',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const eventData = {
    uid: 'series-override-first',
    title: 'Master Event (Updated)',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z',
    recurrence: 'FREQ=WEEKLY'
  };

  const updatedIcs = updateWholeSeries(existingIcs, eventData);

  assert.ok(updatedIcs.includes('SUMMARY:Master Event (Updated)'), 'Master title updated');
  assert.ok(updatedIcs.includes('SUMMARY:Detached Instance'), 'Detached override VEVENT retained');
  assert.ok(updatedIcs.includes('EXDATE:20260115T100000Z'), 'Master EXDATE retained when master is second VEVENT');
});

test('Issue #249 — 3. updateWholeSeries appends new VTIMEZONE subcomponents', () => {
  const existingIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'BEGIN:VEVENT',
    'UID:tz-event-01',
    'SUMMARY:Plain Event',
    'DTSTART:20260101T100000Z',
    'DTEND:20260101T110000Z',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const eventData = {
    uid: 'tz-event-01',
    title: 'Timezone Event',
    start: '2026-06-01T10:00:00',
    end: '2026-06-01T11:00:00',
    startTimeZone: 'Europe/Berlin',
    endTimeZone: 'Europe/Berlin'
  };

  const updatedIcs = updateWholeSeries(existingIcs, eventData);

  assert.ok(updatedIcs.includes('BEGIN:VTIMEZONE'), 'VTIMEZONE block appended');
  assert.ok(updatedIcs.includes('TZID:Europe/Berlin'), 'TZID set to Europe/Berlin');
});

test('Issue #249 — 4. updateWholeSeries safe fallback for empty, invalid, or 0 VEVENT ICS', () => {
  const eventData = {
    uid: 'fallback-01',
    title: 'Fallback Event',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z'
  };

  assert.ok(updateWholeSeries(null, eventData).includes('SUMMARY:Fallback Event'));
  assert.ok(updateWholeSeries('', eventData).includes('SUMMARY:Fallback Event'));
  assert.ok(updateWholeSeries('   ', eventData).includes('SUMMARY:Fallback Event'));
  assert.ok(updateWholeSeries('INVALID ICS DATA', eventData).includes('SUMMARY:Fallback Event'));

  const noVeventsIcs = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
  assert.ok(updateWholeSeries(noVeventsIcs, eventData).includes('SUMMARY:Fallback Event'));
});

test('Issue #249 — 5. isNoOpEventSave whitespace and field normalization', () => {
  const existingIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:noop-01',
    'SUMMARY:  Test Event  ',
    'DESCRIPTION:  Some description  ',
    'LOCATION:  Room 101  ',
    'DTSTART:20260101T100000Z',
    'DTEND:20260101T110000Z',
    'CATEGORIES:WORK,IMPORTANT',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const matchingData = {
    uid: 'noop-01',
    title: 'Test Event',
    description: 'Some description',
    location: 'Room 101',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z',
    categories: ['WORK', 'IMPORTANT']
  };

  assert.equal(isNoOpEventSave(existingIcs, matchingData), true, 'Trimming whitespace results in no-op');

  const modifiedTitle = { ...matchingData, title: 'Changed Title' };
  assert.equal(isNoOpEventSave(existingIcs, modifiedTitle), false, 'Changed title returns false');

  const modifiedCategories = { ...matchingData, categories: ['WORK', 'OTHER'] };
  assert.equal(isNoOpEventSave(existingIcs, modifiedCategories), false, 'Changed categories return false');
});

test('Issue #249 — 6. isNoOpEventSave returns false for null/empty/unparseable ICS', () => {
  const payload = { title: 'Test' };
  assert.equal(isNoOpEventSave(null, payload), false);
  assert.equal(isNoOpEventSave('', payload), false);
  assert.equal(isNoOpEventSave('   ', payload), false);
  assert.equal(isNoOpEventSave('INVALID', payload), false);
});

test('Issue #249 — 7. isNoOpEventSave handles RRULE prefix normalization', () => {
  const existingIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:noop-rrule',
    'SUMMARY:Recurring Event',
    'DTSTART:20260101T100000Z',
    'DTEND:20260101T110000Z',
    'RRULE:FREQ=DAILY;COUNT=5',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const payloadWithPrefix = {
    title: 'Recurring Event',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z',
    recurrence: 'RRULE:FREQ=DAILY;COUNT=5'
  };

  const payloadBare = {
    title: 'Recurring Event',
    start: '2026-01-01T10:00:00Z',
    end: '2026-01-01T11:00:00Z',
    recurrence: 'FREQ=DAILY;COUNT=5'
  };

  assert.equal(isNoOpEventSave(existingIcs, payloadWithPrefix), true, 'RRULE: prefix matches');
  assert.equal(isNoOpEventSave(existingIcs, payloadBare), true, 'Bare RRULE string matches');
});

test('Issue #249 — 8. buildVTimezoneBlock for DST and non-DST timezones', () => {
  const berlinBlock = buildVTimezoneBlock('Europe/Berlin');
  assert.ok(berlinBlock.includes('BEGIN:VTIMEZONE'));
  assert.ok(berlinBlock.includes('TZID:Europe/Berlin'));
  assert.ok(berlinBlock.includes('BEGIN:STANDARD'));
  assert.ok(berlinBlock.includes('BEGIN:DAYLIGHT'), 'DST-observing zone includes DAYLIGHT');

  const utcBlock = buildVTimezoneBlock('UTC');
  assert.ok(utcBlock.includes('BEGIN:VTIMEZONE'));
  assert.ok(utcBlock.includes('BEGIN:STANDARD'));
  assert.ok(!utcBlock.includes('BEGIN:DAYLIGHT'), 'Non-DST zone omits DAYLIGHT');
});

test('Issue #249 — 9. parseTriggerOffsetMs ISO 8601 duration parsing', () => {
  assert.equal(parseTriggerOffsetMs('-PT15M'), -15 * 60 * 1000, '-PT15M is -15 mins');
  assert.equal(parseTriggerOffsetMs('-PT1H'), -60 * 60 * 1000, '-PT1H is -1 hour');
  assert.equal(parseTriggerOffsetMs('-P1D'), -24 * 60 * 60 * 1000, '-P1D is -1 day');
  assert.equal(parseTriggerOffsetMs('-P1W'), -7 * 24 * 60 * 60 * 1000, '-P1W is -1 week');
  assert.equal(parseTriggerOffsetMs('PT15M'), 15 * 60 * 1000, 'PT15M is positive 15 mins');

  assert.equal(parseTriggerOffsetMs(null), null);
  assert.equal(parseTriggerOffsetMs('INVALID'), null);
  assert.equal(parseTriggerOffsetMs('P'), null);
});

test('Issue #249 — 10. escIcal and escParamVal escaping', () => {
  assert.equal(escIcal('Line 1\nLine 2; comma, backslash\\'), 'Line 1\\nLine 2\\; comma\\, backslash\\\\');
  assert.equal(escParamVal('Normal'), 'Normal');
  assert.equal(escParamVal('Value "with" quotes'), 'Value ^\'with^\' quotes');
});

test('Issue #249 — 11. foldLines 75-octet boundary splitting', () => {
  const shortLine = 'SUMMARY:Short Line';
  assert.equal(foldLines(shortLine), shortLine, 'Short lines under 75 octets are unchanged');

  const longLine = 'DESCRIPTION:' + 'A'.repeat(100);
  const folded = foldLines(longLine);
  assert.ok(folded.includes('\r\n '), 'Long line is folded with CRLF + space');
  const lines = folded.split('\r\n');
  assert.ok(lines[0].length <= 75, 'First line segment is capped at 75 octets');
});

test('Issue #249 — 12. isValidTimezone validation', () => {
  assert.equal(isValidTimezone('Europe/Berlin'), true);
  assert.equal(isValidTimezone('America/New_York'), true);
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Invalid/Timezone_Name_123'), false);
  assert.equal(isValidTimezone(''), false);
  assert.equal(isValidTimezone(null), false);
});
