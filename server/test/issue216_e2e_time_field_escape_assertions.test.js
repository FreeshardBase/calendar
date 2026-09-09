'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { eventToICS, parseICSToEvent, escIcal } = require('../utils/ical');

test('Issue #216 — E2E specs must assert clock times, stored field values, and escaped characters', async (t) => {
  const specPath = path.join(__dirname, '../../e2e/calendar.spec.js');
  const specContent = fs.readFileSync(specPath, 'utf8');

  await t.test('E2E spec must assert timed event clock times to catch DTSTART timezone shifts', () => {
    assert.strictEqual(
      specContent.includes('#ev-start-time') && specContent.includes('#ev-end-time'),
      true,
      'e2e/calendar.spec.js must configure and assert timed event start and end times via #ev-start-time and #ev-end-time'
    );
  });

  await t.test('E2E spec must assert stored field values (DESCRIPTION and LOCATION)', () => {
    assert.strictEqual(
      specContent.includes('#ev-description') && specContent.includes('#ev-location'),
      true,
      'e2e/calendar.spec.js must assert stored description and location fields'
    );
    assert.strictEqual(
      specContent.includes('popover-description'),
      true,
      'e2e/calendar.spec.js must observe popover description element'
    );
  });

  await t.test('E2E spec must assert special character preservation and escIcal escaping', () => {
    assert.strictEqual(
      specContent.includes('Special & Critical') || specContent.includes('escIcal') || specContent.includes('Escaped Characters'),
      true,
      'e2e/calendar.spec.js must assert special/escaped characters in event title, description, or location'
    );
  });

  await t.test('eventToICS and parseICSToEvent must preserve clock time, DESCRIPTION, LOCATION, and special characters without identity escIcal leaks', () => {
    const event = {
      uid: 'test-216-uid-123',
      title: 'Sprint Review & Retrospective: "Q3"',
      location: 'Room #101 (Bldg B; Floor 2, Zone 3)',
      description: 'Notes:\n- Feature A; test\n- Feature B, ok',
      start: '2028-10-15T09:30:00.000Z',
      end: '2028-10-15T10:30:00.000Z',
      allDay: false
    };

    const ics = eventToICS(event);
    assert.strictEqual(ics.includes('SUMMARY:Sprint Review & Retrospective: "Q3"'), true);
    assert.strictEqual(ics.includes('LOCATION:Room #101 (Bldg B\\; Floor 2\\, Zone 3)'), true);
    assert.strictEqual(ics.includes('DESCRIPTION:Notes:\\n- Feature A\\; test\\n- Feature B\\, ok'), true);

    const parsed = parseICSToEvent(ics);
    assert.strictEqual(parsed.title, event.title);
    assert.strictEqual(parsed.location, event.location);
    assert.strictEqual(parsed.description, event.description);
    assert.strictEqual(parsed.start, event.start);
    assert.strictEqual(parsed.end, event.end);
  });
});
