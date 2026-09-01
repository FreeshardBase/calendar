'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Issue #128 — Custom VALARM Trigger Preservation Suite', async (t) => {
  const eventModalPath = path.join(__dirname, '../../public/js/eventModal.js');
  const eventModalCode = fs.readFileSync(eventModalPath, 'utf8');

  await t.test('formatAlarmTriggerLabel formats custom trigger offsets correctly', () => {
    // Import or evaluate formatAlarmTriggerLabel
    let formatAlarmTriggerLabel;
    if (eventModalCode.includes('export function formatAlarmTriggerLabel') || eventModalCode.includes('function formatAlarmTriggerLabel')) {
      const match = eventModalCode.match(/function formatAlarmTriggerLabel\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
      if (match) {
        formatAlarmTriggerLabel = new Function('trigger', `${match[0]}; return formatAlarmTriggerLabel(trigger);`);
      }
    }

    assert.ok(typeof formatAlarmTriggerLabel === 'function', 'formatAlarmTriggerLabel function must exist in eventModal.js');
    assert.strictEqual(formatAlarmTriggerLabel('PT0S'), 'Zum Zeitpunkt des Termins');
    assert.strictEqual(formatAlarmTriggerLabel('-PT5M'), '5 Minuten vorher');
    assert.strictEqual(formatAlarmTriggerLabel('-PT10M'), '10 Minuten vorher');
    assert.strictEqual(formatAlarmTriggerLabel('-PT2H'), '2 Stunden vorher');
    assert.strictEqual(formatAlarmTriggerLabel('-P2D'), '2 Tage vorher');
    assert.strictEqual(formatAlarmTriggerLabel('-P1W'), '1 Woche vorher');
    assert.strictEqual(formatAlarmTriggerLabel(''), 'Keine Erinnerung');
  });

  await t.test('openEditModal preserves non-preset VALARM triggers without deleting on save', () => {
    // Verify that eventModal.js dynamically injects custom trigger options into #ev-alarm select
    assert.ok(eventModalCode.includes('data-custom-alarm') || eventModalCode.includes('dataset.customAlarm'),
      'eventModal.js must mark dynamically injected custom alarm options');

    assert.ok(!eventModalCode.match(/\$('ev-alarm')\.value = firstAlarm \? \(firstAlarm\.trigger \|\| ''\) : '';\s*$/m),
      'eventModal.js must not naively set select.value without ensuring custom trigger option exists');
  });
});
