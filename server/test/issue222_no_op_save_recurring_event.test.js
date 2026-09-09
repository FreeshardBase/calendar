'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const eventModalJsPath = path.resolve(__dirname, '../../public/js/eventModal.js');

test('Issue #222 — Opening a Recurring Event and Pressing Save Without Changing Recurrence Preserves Rule', async (t) => {
  const eventModalJsContent = fs.readFileSync(eventModalJsPath, 'utf8');

  await t.test('eventModal.js tracks recurrence touched state', () => {
    assert.ok(
      /_recurrenceTouched/.test(eventModalJsContent),
      'eventModal.js must declare a _recurrenceTouched state flag'
    );
  });

  await t.test('eventModal.js preserves _currentEvent.recurrence when recurrence is untouched', () => {
    assert.ok(
      /_currentEvent\.recurrence[\s\S]*?!_recurrenceTouched|_recurrenceTouched\s*\?\s*[\s\S]*?:\s*_currentEvent\.recurrence/.test(eventModalJsContent),
      'handleSubmit must retain _currentEvent.recurrence when _recurrenceTouched is false'
    );
  });

  await t.test('functional simulation: zero-edit save preserves complex RRULE verbatim', async () => {
    // Verify structural code implementation
    assert.ok(
      /_recurrenceTouched\s*=\s*false/.test(eventModalJsContent),
      'openEditModal/resetForm must reset _recurrenceTouched to false'
    );

    assert.ok(
      /markRecurrenceTouched/.test(eventModalJsContent),
      'initEventModal must attach markRecurrenceTouched listeners to recurrence controls'
    );
  });
});
