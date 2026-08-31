/**
 * Issue #91 — HIGH: a weekly series recurs on the wrong weekday if the start
 * date is changed after the dialog opens.
 *
 * Root cause: updateRecurrenceOptions(false) unconditionally replaced the
 * BYDAY checkbox whenever ≤1 box was checked.  In edit mode the existing RRULE
 * populates exactly 1 checkbox (e.g. BYDAY=WE).  Changing the start date from
 * Wednesday to Friday therefore silently flipped the series to FREQ=WEEKLY;BYDAY=FR.
 *
 * Fix: guard the BYDAY auto-resync on _currentEvent === null (create mode only).
 * In edit mode the BYDAY selection loaded from the existing RRULE must be preserved
 * regardless of subsequent start-date changes.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');

const modalSrc = fs.readFileSync(
  path.resolve('public/js/eventModal.js'), 'utf8'
);

// ---------------------------------------------------------------------------
// Helper: build a minimal DOM sandbox for updateRecurrenceOptions.
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
    document: {
      getElementById: id => domElements[id] || makeEl(),
      querySelector(sel) {
        if (sel.startsWith('.recur-byday[value=')) {
          const m = sel.match(/value="([A-Z]{2})"/);
          return m ? (checkboxes.find(c => c.value === m[1]) || null) : null;
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
    const $ = id => document.getElementById(id);
    ${fnSrc}
    updateRecurrenceOptions(${skipDefaultSelects});
  `);
  script.runInContext(vm.createContext(sandbox));
}

// ---------------------------------------------------------------------------
test('Issue #91 — Weekly series BYDAY weekday tracking after start-date change', async t => {

  // ── Structural (static source) ──────────────────────────────────────────

  await t.test('structural: reads .recur-byday:checked elements', () => {
    assert.ok(modalSrc.includes('recur-byday:checked'),
      'eventModal.js must query .recur-byday:checked');
  });

  await t.test('structural: BYDAY auto-resync is guarded on create mode (_currentEvent === null or !_currentEvent)', () => {
    const hasGuard =
      modalSrc.includes('_currentEvent === null') ||
      modalSrc.includes('!_currentEvent');
    assert.ok(hasGuard,
      'updateRecurrenceOptions BYDAY resync must be guarded on create mode');
  });

  await t.test('structural: <=1 checked-box guard is preserved', () => {
    assert.ok(modalSrc.includes('checkedBoxes.length <= 1'),
      'checkedBoxes.length <= 1 guard must remain in eventModal.js');
  });

  await t.test('structural: ev-start-date wired to updateRecurrenceOptions(false)', () => {
    assert.ok(
      modalSrc.includes("'ev-start-date'") && modalSrc.includes('updateRecurrenceOptions(false)'),
      'initEventModal must wire ev-start-date change → updateRecurrenceOptions(false)');
  });

  await t.test('structural: openCreateModal pre-checks start-date weekday', () => {
    assert.ok(
      modalSrc.includes('Pre-check the weekday of the start date') ||
      (modalSrc.includes("['SU','MO','TU','WE','TH','FR','SA'][d.getDay()]") &&
       modalSrc.includes('openCreateModal')),
      'openCreateModal should pre-check the weekday of the start date');
  });

  // ── Behavioural (VM-executed) ───────────────────────────────────────────

  await t.test('behaviour: create mode — date change updates single BYDAY to new weekday', () => {
    // 2026-09-02 = Wednesday (day index 3 → WE)
    const sb = buildSandbox({ freq: 'WEEKLY', checkedDays: ['MO'], startDate: '2026-09-02' });
    sb._currentEvent = null; // create mode
    runUpdateRecurrenceOptions(sb, false);
    const checked = sb.__checkboxes.filter(c => c.checked).map(c => c.value);
    assert.deepEqual(checked, ['WE'],
      'create mode: date change Mon→Wed must update BYDAY to WE');
  });

  await t.test('behaviour: edit mode — date change must NOT alter BYDAY (bug scenario)', () => {
    // Editing WEEKLY;BYDAY=WE event. User changes start date from Wed → Fri.
    // BYDAY must remain WE, not flip to FR.
    const sb = buildSandbox({ freq: 'WEEKLY', checkedDays: ['WE'], startDate: '2026-09-04' });
    sb._currentEvent = { uid: 'test-uid', recurrence: 'FREQ=WEEKLY;BYDAY=WE' };
    runUpdateRecurrenceOptions(sb, false);
    const checked = sb.__checkboxes.filter(c => c.checked).map(c => c.value);
    assert.deepEqual(checked, ['WE'],
      'edit mode: date change must not replace BYDAY=WE with FR');
  });

  await t.test('behaviour: create mode — multi-day selection preserved on date change', () => {
    const sb = buildSandbox({ freq: 'WEEKLY', checkedDays: ['MO', 'WE'], startDate: '2026-09-04' });
    sb._currentEvent = null;
    runUpdateRecurrenceOptions(sb, false);
    const checked = sb.__checkboxes.filter(c => c.checked).map(c => c.value).sort();
    assert.deepEqual(checked, ['MO', 'WE'],
      'multi-day BYDAY selection preserved in create mode');
  });

  await t.test('behaviour: edit mode skipDefaultSelects=true — BYDAY completely untouched', () => {
    const sb = buildSandbox({ freq: 'WEEKLY', checkedDays: ['TH'], startDate: '2026-09-03' });
    sb._currentEvent = { uid: 'test-uid' };
    runUpdateRecurrenceOptions(sb, true);
    const checked = sb.__checkboxes.filter(c => c.checked).map(c => c.value);
    assert.deepEqual(checked, ['TH'],
      'skipDefaultSelects=true path must never touch BYDAY');
  });
});
