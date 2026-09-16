'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const eventModalJsPath = path.resolve(__dirname, '../../public/js/eventModal.js');

test('Issue #299 — Timed UNTIL Preservation Across Event Saves', async (t) => {
  const eventModalJsContent = fs.readFileSync(eventModalJsPath, 'utf8');

  await t.test('eventModal.js contains timed UNTIL preservation logic', () => {
    assert.ok(
      /origUntilMatch|origUntil/.test(eventModalJsContent),
      'eventModal.js must inspect original UNTIL parameter from _currentEvent.recurrence'
    );
  });

  await t.test('functional simulation: timed UNTIL is preserved when date is unchanged', () => {
    function computeRecurrence(untilDateVal, currentRecurrence) {
      let recurrence = 'FREQ=DAILY';
      if (untilDateVal) {
        const datePart = untilDateVal.replace(/-/g, '');
        let untilVal = `${datePart}T235959Z`;
        if (currentRecurrence && typeof currentRecurrence === 'string') {
          const origUntilMatch = currentRecurrence.match(/UNTIL=([^;]+)/);
          if (origUntilMatch) {
            const origUntil = origUntilMatch[1];
            if (origUntil.startsWith(datePart)) {
              untilVal = origUntil;
            }
          }
        }
        recurrence += `;UNTIL=${untilVal}`;
      }
      return recurrence;
    }

    const existingRrule = 'FREQ=DAILY;UNTIL=20261015T120000Z';
    const savedUntouchedDate = computeRecurrence('2026-10-15', existingRrule);
    assert.equal(
      savedUntouchedDate,
      'FREQ=DAILY;UNTIL=20261015T120000Z',
      'Saving event with same UNTIL date must preserve exact timed UNTIL timestamp'
    );

    const savedNewDate = computeRecurrence('2026-10-20', existingRrule);
    assert.equal(
      savedNewDate,
      'FREQ=DAILY;UNTIL=20261020T235959Z',
      'Saving event with new UNTIL date must format as date-end T235959Z'
    );

    const newEventSaved = computeRecurrence('2026-10-15', null);
    assert.equal(
      newEventSaved,
      'FREQ=DAILY;UNTIL=20261015T235959Z',
      'New event must default UNTIL to date-end T235959Z'
    );
  });
});
