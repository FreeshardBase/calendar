'use strict';
process.env.NODE_ENV = 'test';

// Issue #182: sidebar controls must be keyboard operable. This drives the real
// render functions and inspects each rendered element's own opening tag and
// listeners, so moving an attribute to another element is caught. The calendar
// visibility row and the ICS dropzone are covered in the browser by
// e2e/calendar.spec.js ("Issue #182 — sidebar controls are keyboard operable").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFrontendModule(filePath, mockGlobals = {}) {
  let code = fs.readFileSync(filePath, 'utf8');
  code = code.replace(/^\s*import\s+[^;]+;/gm, '');
  code = code.replace(/^\s*export\s+(async\s+)?function\s+/gm, '$1function ');
  code = code.replace(/^\s*export\s+const\s+/gm, 'const ');
  code = code.replace(/^\s*export\s+let\s+/gm, 'let ');

  const context = {
    console,
    Date,
    Array,
    String,
    RegExp,
    parseInt,
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    ...mockGlobals
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

// Minimal element that records listeners and attributes parsed from its own tag.
function fakeElement(openingTag) {
  const listeners = {};
  const attr = name => {
    const m = openingTag.match(new RegExp(`\\s${name}="([^"]*)"`));
    return m ? m[1] : null;
  };
  const dataset = {};
  const miniDay = attr('data-mini-day');
  if (miniDay !== null) dataset.miniDay = miniDay;
  return {
    openingTag,
    dataset,
    attr,
    getAttribute: attr,
    focused: false,
    focus() { this.focused = true; },
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    press(key) {
      let prevented = false;
      const ev = { key, target: this, preventDefault() { prevented = true; }, stopPropagation() {} };
      for (const fn of listeners.keydown || []) fn(ev);
      return prevented;
    },
  };
}

function openingTags(html, className) {
  return html.match(new RegExp(`<div class="${className}\\b[^>]*>`, 'g')) || [];
}

test('Issue #182 — mini-calendar day cells are focusable and activate on Enter/Space', async (t) => {
  const fakeDocument = { getElementById: () => null, activeElement: null };
  const mod = loadFrontendModule(path.resolve('public/js/calendar.js'), {
    store: { get: () => null },
    visibleCalendars: () => [],
    calendarById: () => null,
    document: fakeDocument,
  });

  let html = '';
  let dayEls = [];
  const container = {
    set innerHTML(v) {
      html = v;
      dayEls = openingTags(v, 'mini-cal-day').filter(tag => tag.includes('data-mini-day=')).map(fakeElement);
    },
    get innerHTML() { return html; },
    querySelectorAll: sel => (sel === '[data-mini-day]' ? dayEls : []),
    querySelector: sel => (sel === '.mini-cal-day.selected'
      ? dayEls.find(el => /\bselected\b/.test(el.attr('class'))) || null
      : null),
  };
  const picked = [];
  mod.renderMiniCalendar(container, new Date(2027, 2, 10), [], d => picked.push(d));

  await t.test('every selectable day carries tabindex="0", role="button" and a date label on its own tag', () => {
    assert.equal(dayEls.length, 31, 'March 2027 has 31 selectable days');
    for (const el of dayEls) {
      assert.equal(el.attr('tabindex'), '0', `day cell not focusable: ${el.openingTag}`);
      assert.equal(el.attr('role'), 'button', `day cell has no button role: ${el.openingTag}`);
      assert.match(el.attr('aria-label') || '', /\d+\. März 2027/, `day cell has no date label: ${el.openingTag}`);
    }
  });

  await t.test('Enter and Space on a day call onDayClick with that date and suppress the default', () => {
    const day20 = dayEls.find(el => new Date(el.dataset.miniDay).getDate() === 20);
    assert.ok(day20);
    assert.equal(day20.press('Enter'), true, 'Enter must preventDefault');
    assert.equal(day20.press(' '), true, 'Space must preventDefault (no page scroll)');
    assert.equal(day20.press('a'), false, 'other keys must pass through');
    assert.equal(picked.length, 2);
    for (const d of picked) assert.equal(d.toISOString(), new Date(2027, 2, 20).toISOString());
  });

  await t.test('a re-render keeps focus on the focused day, not the selected one', () => {
    const iso = new Date(2027, 2, 15).toISOString();
    fakeDocument.activeElement = dayEls.find(el => el.dataset.miniDay === iso);
    mod.renderMiniCalendar(container, new Date(2027, 2, 10), [], () => {});
    const focused = dayEls.filter(el => el.focused);
    assert.deepEqual(focused.map(el => el.dataset.miniDay), [iso]);

    fakeDocument.activeElement = null;
    mod.renderMiniCalendar(container, new Date(2027, 2, 10), [], () => {});
    assert.equal(dayEls.filter(el => el.focused).length, 0, 'focus elsewhere must not be pulled into the grid');
  });
});

test('Issue #182 — sidebar task info is focusable and opens the editor on Enter/Space', async (t) => {
  const items = [];
  const mod = loadFrontendModule(path.resolve('public/js/tasks.js'), {
    document: {
      getElementById: () => null,
      createElement: () => {
        const item = {
          className: '',
          setAttribute() {},
          parts: {},
          set innerHTML(v) {
            this._html = v;
            this.parts['.sidebar-task-info'] = fakeElement(openingTags(v, 'sidebar-task-info')[0] || '');
            this.parts['.sidebar-task-checkbox'] = fakeElement('');
          },
          get innerHTML() { return this._html; },
          querySelector(sel) { return this.parts[sel] || null; },
        };
        items.push(item);
        return item;
      },
    },
  });
  const opened = [];
  mod.openTaskModal = task => opened.push(task.uid);

  const container = { innerHTML: '', appendChild() {} };
  const badge = { textContent: '', removeAttribute() {} };
  const tasks = [
    { uid: 'task-1', title: 'Test task one', status: 'NEEDS-ACTION' },
    { uid: 'task-2', title: 'Test task two', status: 'NEEDS-ACTION' },
  ];
  mod.renderSidebarTasks(container, badge, tasks, {});

  await t.test('each .sidebar-task-info carries tabindex="0" and role="button" on its own tag', () => {
    assert.equal(items.length, 2);
    for (const item of items) {
      const info = item.parts['.sidebar-task-info'];
      assert.equal(info.attr('tabindex'), '0', `task info not focusable: ${info.openingTag}`);
      assert.equal(info.attr('role'), 'button', `task info has no button role: ${info.openingTag}`);
    }
  });

  await t.test('Enter and Space open the editor for that task', () => {
    const info = items[1].parts['.sidebar-task-info'];
    assert.equal(info.press('Enter'), true);
    assert.equal(info.press(' '), true);
    assert.equal(info.press('Tab'), false);
    assert.deepEqual(opened, ['task-2', 'task-2']);
  });
});
