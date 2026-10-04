/**
 * Issue #91 — HIGH: a weekly series recurs on the wrong weekday if the start
 * date is changed after the dialog opens.
 *
 * Root cause:
 * 1. public/js/eventModal.js previously guarded BYDAY auto-resync with
 *    `_currentEvent === null`, skipping the resync in edit mode.
 * 2. ev-start-date change listener did not call markRecurrenceTouched(),
 *    leaving _recurrenceTouched false.
 * 3. On save, handleSubmit reused _currentEvent.recurrence verbatim.
 * 4. Nothing downstream on the write path re-derived single BYDAY against DTSTART.
 *
 * Result:
 * When editing a weekly event originally on Wednesday (BYDAY=WE) and changing
 * the start date to Monday (2026-08-10), the series saved with BYDAY=WE,
 * causing occurrences to land on Wednesdays and completely miss Monday (DTSTART).
 *
 * Fix:
 * 1. Allow BYDAY auto-resync in both create and edit modes when checkedBoxes.length <= 1.
 * 2. Mark recurrence touched on ev-start-date change so the updated BYDAY is saved.
 * 3. Preserve multi-day selections (e.g. MO,WE,FR) without collapsing them.
 * 4. Normalise / re-derive single BYDAY against DTSTART on the server write path
 *    (normalizeRecurrenceRule, eventToICS, updateWholeSeries).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');
const {
  parseICSToEvent,
  eventToICS,
  updateWholeSeries,
  parseAndExpandEvent,
  normalizeRecurrenceRule
} = require('../utils/ical');

const modalSrc = fs.readFileSync(
  path.resolve('public/js/eventModal.js'), 'utf8'
);

// ---------------------------------------------------------------------------
// Helper: build a minimal DOM sandbox for eventModal.js
// ---------------------------------------------------------------------------
function buildSandbox({ freq = 'WEEKLY', checkedDays = [], startDate = '2026-09-02' } = {}) {
  const domElements = {};
  function makeEl(value = '') {
    return {
      value,
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      textContent: '',
      style: {}
    };
  }
  domElements['ev-start-date']           = makeEl(startDate);
  domElements['ev-recurrence']           = makeEl(freq);
  domElements['recur-monthly-day-lbl']   = makeEl();
  domElements['recur-monthly-week-idx']  = makeEl();
  domElements['recur-monthly-weekday']   = makeEl();
  domElements['recur-weekly-days']       = makeEl();
  domElements['recur-monthly-opts']      = makeEl();
  domElements['recur-end-section']       = makeEl();

  const dayValues  = ['SU','MO','TU','WE','TH','FR','SA'];
  const checkboxes = dayValues.map(v => ({ value: v, checked: checkedDays.includes(v) }));

  const sandbox = {
    _currentEvent: null,
    _recurrenceTouched: false,
    document: {
      getElementById: id => domElements[id] || makeEl(),
      querySelector(sel) {
        if (sel.startsWith('.recur-byday[value=')) {
          const m = sel.match(/value="([A-Z]{2})"/);
          return m ? (checkboxes.find(c => c.value === m[1]) || null) : null;
        }
        if (sel.startsWith('input[name="recur-end-type"]')) {
          return { value: 'NEVER' };
        }
        if (sel.startsWith('input[name="recur-monthly-type"]')) {
          return { value: 'BYMONTHDAY' };
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '.recur-byday')         return checkboxes;
        if (sel === '.recur-byday:checked') return checkboxes.filter(c => c.checked);
        return [];
      }
    },
    console,
    __checkboxes: checkboxes,
  };
  return sandbox;
}

/**
 * Extract and run updateRecurrenceOptions from eventModal.js in a VM sandbox.
 */
function runUpdateRecurrenceOptions(sandbox, skipDefaultSelects = false) {
  const fnStart = modalSrc.indexOf('function updateRecurrenceOptions(');
  assert.notEqual(fnStart, -1, 'updateRecurrenceOptions must exist in eventModal.js');

  let depth = 0, fnEnd = fnStart;
  for (let i = fnStart; i < modalSrc.length; i++) {
    if (modalSrc[i] === '{') depth++;
    else if (modalSrc[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
  }
  const fnSrc = modalSrc.slice(fnStart, fnEnd);

  const script = new vm.Script(`
    var $ = id => document.getElementById(id);
    ${fnSrc}
    updateRecurrenceOptions(${skipDefaultSelects});
  `);
  script.runInContext(vm.createContext(sandbox));
}

/**
 * Evaluate recurrence computation as done in handleSubmit in eventModal.js.
 */
function computeSubmittedRecurrence(sandbox) {
  const script = new vm.Script(`
    var $ = id => document.getElementById(id);
    let recurrence = null;
    if (_currentEvent && typeof _currentEvent.recurrence === 'string' && _currentEvent.recurrence.trim() !== '' && !_recurrenceTouched) {
      recurrence = _currentEvent.recurrence;
    } else {
      const recurrenceVal = $('ev-recurrence').value;
      if (recurrenceVal === 'DAILY') {
        recurrence = 'FREQ=DAILY';
      } else if (recurrenceVal === 'YEARLY') {
        recurrence = 'FREQ=YEARLY';
      } else if (recurrenceVal === 'WEEKLY') {
        const byday = [...document.querySelectorAll('.recur-byday:checked')].map(cb => cb.value).join(',');
        recurrence = byday ? \`FREQ=WEEKLY;BYDAY=\${byday}\` : 'FREQ=WEEKLY';
      } else if (recurrenceVal === 'MONTHLY') {
        recurrence = 'FREQ=MONTHLY';
      }

      if (_currentEvent && typeof _currentEvent.recurrence === 'string' && _currentEvent.recurrence.trim() !== '' && recurrence) {
        const origFreqMatch = _currentEvent.recurrence.match(/FREQ=([A-Z]+)/);
        const newFreqMatch = recurrence.match(/FREQ=([A-Z]+)/);
        if (origFreqMatch && newFreqMatch && origFreqMatch[1] === newFreqMatch[1]) {
          const origParts = _currentEvent.recurrence.split(';');
          const newParts = recurrence.split(';');
          const newKeys = new Set(newParts.map(p => p.split('=')[0]));
          const mergedParts = [...newParts];
          origParts.forEach(part => {
            const key = part.split('=')[0];
            if (!newKeys.has(key) && key !== '') {
              mergedParts.push(part);
            }
          });
          recurrence = mergedParts.join(';');
        }
      }
    }
    recurrence;
  `);
  return script.runInContext(vm.createContext(sandbox));
}

// ---------------------------------------------------------------------------
test('Issue #91 — Weekly series BYDAY weekday tracking after start-date change', async t => {

  // ── Structural (static source) ──────────────────────────────────────────

  await t.test('structural: reads .recur-byday:checked elements', () => {
    assert.ok(modalSrc.includes('recur-byday:checked'),
      'eventModal.js must query .recur-byday:checked');
  });

  await t.test('structural: BYDAY auto-resync is NOT blocked on edit mode (_currentEvent === null removed)', () => {
    // Must NOT restrict BYDAY resync to create mode only
    assert.ok(
      !modalSrc.includes('_currentEvent === null && checkedBoxes.length <= 1'),
      'BYDAY resync must not be restricted to _currentEvent === null'
    );
  });

  await t.test('structural: <=1 checked-box guard is preserved', () => {
    assert.ok(modalSrc.includes('checkedBoxes.length <= 1'),
      'checkedBoxes.length <= 1 guard must remain in eventModal.js');
  });

  await t.test('structural: ev-start-date wired to updateRecurrenceOptions(false) and marks touched', () => {
    assert.ok(
      modalSrc.includes("'ev-start-date'") && modalSrc.includes('updateRecurrenceOptions(false)'),
      'initEventModal must wire ev-start-date change → updateRecurrenceOptions(false)');
    // Must call markRecurrenceTouched when start date changes so edit mode saves new recurrence
    const initMatch = modalSrc.match(/export function initEventModal\(\)[\s\S]*?^}/m);
    assert.ok(initMatch, 'initEventModal must exist');
    assert.ok(
      initMatch[0].includes("'ev-start-date'") && initMatch[0].includes('markRecurrenceTouched'),
      'initEventModal must wire ev-start-date to markRecurrenceTouched'
    );
  });

  await t.test('structural: openCreateModal pre-checks start-date weekday', () => {
    assert.ok(
      modalSrc.includes('Pre-check the weekday of the start date') ||
      (modalSrc.includes("['SU','MO','TU','WE','TH','FR','SA'][d.getDay()]") &&
       modalSrc.includes('openCreateModal')),
      'openCreateModal should pre-check the weekday of the start date');
  });

  // ── Behavioural (VM-executed frontend) ──────────────────────────────────

  await t.test('behaviour: create mode — date change updates single BYDAY to new weekday', () => {
    // 2026-09-02 = Wednesday (day index 3 → WE)
    const sb = buildSandbox({ freq: 'WEEKLY', checkedDays: ['MO'], startDate: '2026-09-02' });
    sb._currentEvent = null; // create mode
    runUpdateRecurrenceOptions(sb, false);
    const checked = sb.__checkboxes.filter(c => c.checked).map(c => c.value);
    assert.deepEqual(checked, ['WE'],
      'create mode: date change Mon→Wed must update BYDAY to WE');
  });

  await t.test('behaviour: edit mode — date change updates single BYDAY to new weekday (Clayde finding)', () => {
    // Clayde reproduction:
    // Event loaded from existing rule FREQ=WEEKLY;BYDAY=WE.
    // User changes start date to 2026-08-10 (Monday).
    // In edit mode, updateRecurrenceOptions(false) must update BYDAY from WE to MO.
    const sb = buildSandbox({ freq: 'WEEKLY', checkedDays: ['WE'], startDate: '2026-08-10' });
    sb._currentEvent = { uid: 'test-uid', recurrence: 'FREQ=WEEKLY;BYDAY=WE' };
    runUpdateRecurrenceOptions(sb, false);
    const checked = sb.__checkboxes.filter(c => c.checked).map(c => c.value);
    assert.deepEqual(checked, ['MO'],
      'edit mode: date change Wed→Mon must update BYDAY to MO');
  });

  await t.test('behaviour: edit mode save produces FREQ=WEEKLY;BYDAY=MO and first occurrence on Monday', () => {
    const sb = buildSandbox({ freq: 'WEEKLY', checkedDays: ['WE'], startDate: '2026-08-10' });
    sb._currentEvent = { uid: 'test-uid', recurrence: 'FREQ=WEEKLY;BYDAY=WE;INTERVAL=2' };
    // Simulate user changing start date:
    runUpdateRecurrenceOptions(sb, false);
    sb._recurrenceTouched = true; // because ev-start-date listener marks touched

    const savedRecurrence = computeSubmittedRecurrence(sb);
    assert.ok(savedRecurrence.includes('BYDAY=MO'), `Saved rule should have BYDAY=MO, got: ${savedRecurrence}`);
    assert.ok(savedRecurrence.includes('INTERVAL=2'), `Saved rule should preserve INTERVAL=2, got: ${savedRecurrence}`);
    assert.ok(!savedRecurrence.includes('BYDAY=WE'), `Saved rule must not have old BYDAY=WE, got: ${savedRecurrence}`);

    // Verify first occurrence with ical expansion:
    const ics = eventToICS({
      uid: 'test-uid',
      title: 'Weekly Standup',
      start: '2026-08-10T09:00:00.000Z',
      end: '2026-08-10T10:00:00.000Z',
      recurrence: savedRecurrence
    });
    const expanded = parseAndExpandEvent(ics, '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    assert.ok(expanded.length >= 1, 'Series must have expanded occurrences');
    assert.equal(expanded[0].start, '2026-08-10T09:00:00.000Z',
      'First occurrence must be Monday 2026-08-10, NOT Wednesday 2026-08-12');
  });

  await t.test('behaviour: multi-day selection preserved on date change in edit and create modes', () => {
    // Multi-day selection (e.g. MO, WE) must NOT collapse when start date changes
    const sbCreate = buildSandbox({ freq: 'WEEKLY', checkedDays: ['MO', 'WE'], startDate: '2026-09-04' });
    sbCreate._currentEvent = null;
    runUpdateRecurrenceOptions(sbCreate, false);
    assert.deepEqual(sbCreate.__checkboxes.filter(c => c.checked).map(c => c.value).sort(), ['MO', 'WE']);

    const sbEdit = buildSandbox({ freq: 'WEEKLY', checkedDays: ['MO', 'WE'], startDate: '2026-09-04' });
    sbEdit._currentEvent = { uid: 'test-uid', recurrence: 'FREQ=WEEKLY;BYDAY=MO,WE' };
    runUpdateRecurrenceOptions(sbEdit, false);
    assert.deepEqual(sbEdit.__checkboxes.filter(c => c.checked).map(c => c.value).sort(), ['MO', 'WE']);
  });

  await t.test('behaviour: edit mode skipDefaultSelects=true — BYDAY completely untouched on dialog open', () => {
    const sb = buildSandbox({ freq: 'WEEKLY', checkedDays: ['TH'], startDate: '2026-09-03' });
    sb._currentEvent = { uid: 'test-uid' };
    runUpdateRecurrenceOptions(sb, true);
    const checked = sb.__checkboxes.filter(c => c.checked).map(c => c.value);
    assert.deepEqual(checked, ['TH'],
      'skipDefaultSelects=true path must never touch BYDAY');
  });

  await t.test('behaviour: zero-edit save in edit mode preserves original rule verbatim', () => {
    const sb = buildSandbox({ freq: 'WEEKLY', checkedDays: ['WE'], startDate: '2026-08-05' });
    sb._currentEvent = { uid: 'test-uid', recurrence: 'FREQ=WEEKLY;BYDAY=WE;INTERVAL=3;WKST=MO' };
    sb._recurrenceTouched = false; // untouched!
    const savedRecurrence = computeSubmittedRecurrence(sb);
    assert.equal(savedRecurrence, 'FREQ=WEEKLY;BYDAY=WE;INTERVAL=3;WKST=MO',
      'Zero-edit save must preserve original recurrence verbatim');
  });

  // ── Server-side write path normalisation ─────────────────────────────────

  await t.test('server: normalizeRecurrenceRule re-derives single weekly BYDAY against DTSTART', () => {
    assert.equal(typeof normalizeRecurrenceRule, 'function', 'normalizeRecurrenceRule must be exported');
    // 2026-08-10 is Monday
    assert.equal(
      normalizeRecurrenceRule('FREQ=WEEKLY;BYDAY=WE', '2026-08-10T09:00:00.000Z'),
      'FREQ=WEEKLY;BYDAY=MO'
    );
    // Already matching
    assert.equal(
      normalizeRecurrenceRule('FREQ=WEEKLY;BYDAY=MO', '2026-08-10T09:00:00.000Z'),
      'FREQ=WEEKLY;BYDAY=MO'
    );
    // Preserves INTERVAL and other parts
    assert.equal(
      normalizeRecurrenceRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;UNTIL=20261231T235959Z', '2026-08-10T09:00:00.000Z'),
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;UNTIL=20261231T235959Z'
    );
    // Preserves multi-day rules
    assert.equal(
      normalizeRecurrenceRule('FREQ=WEEKLY;BYDAY=MO,WE,FR', '2026-08-10T09:00:00.000Z'),
      'FREQ=WEEKLY;BYDAY=MO,WE,FR'
    );
    // Preserves MONTHLY rules
    assert.equal(
      normalizeRecurrenceRule('FREQ=MONTHLY;BYDAY=2TH', '2026-08-10T09:00:00.000Z'),
      'FREQ=MONTHLY;BYDAY=2TH'
    );
  });

  await t.test('server: eventToICS normalises single weekly BYDAY against start date', () => {
    const ics = eventToICS({
      title: 'Mismatched Standup',
      start: '2026-08-10T09:00:00.000Z',
      end: '2026-08-10T10:00:00.000Z',
      recurrence: 'FREQ=WEEKLY;BYDAY=WE'
    });
    assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO/, 'eventToICS must normalise single BYDAY to match DTSTART Monday');
    assert.doesNotMatch(ics, /BYDAY=WE/, 'eventToICS must not write mismatched BYDAY=WE');

    const expanded = parseAndExpandEvent(ics, '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    assert.equal(expanded[0].start, '2026-08-10T09:00:00.000Z');
  });

  await t.test('server: updateWholeSeries re-derives single weekly BYDAY when series is shifted', () => {
    // Existing series starts Wednesday 2026-08-05 with BYDAY=WE
    const origIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:series-shift-test',
      'SUMMARY:Weekly Meeting',
      'DTSTART:20260805T090000Z',
      'DTEND:20260805T100000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=WE',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // User shifts series to Monday 2026-08-10 (-2 days delta from occurrence on 2026-08-12)
    const updatedIcs = updateWholeSeries(origIcs, {
      uid: 'series-shift-test',
      recurrenceId: '2026-08-12T09:00:00.000Z',
      start: '2026-08-10T09:00:00.000Z',
      end: '2026-08-10T10:00:00.000Z',
      title: 'Weekly Meeting Shifted'
    });

    assert.match(updatedIcs, /RRULE:FREQ=WEEKLY;BYDAY=MO/,
      'updateWholeSeries must update single BYDAY=WE to BYDAY=MO when master is shifted to Monday');
    assert.doesNotMatch(updatedIcs, /BYDAY=WE/,
      'updateWholeSeries must eliminate stale BYDAY=WE');

    const expanded = parseAndExpandEvent(updatedIcs, '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    assert.equal(expanded[0].start, '2026-08-03T09:00:00.000Z', 'Prior occurrence shifted to Monday');
    assert.equal(expanded[1].start, '2026-08-10T09:00:00.000Z', 'Target occurrence on Monday 2026-08-10');
  });

});
