'use strict';
process.env.NODE_ENV = 'test';

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
    document: {
      getElementById: () => null,
      createElement: () => ({
        style: {},
        dataset: {},
        setAttribute: function(key, val) { this[key] = val; },
        getAttribute: function(key) { return this[key]; },
        addEventListener: () => {}
      })
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    exports: {},
    module: { exports: {} },
    ...mockGlobals
  };
  context.window = context;
  context.global = context;

  vm.createContext(context);
  vm.runInContext(code, context);

  return context;
}

const calendarJsPath = path.resolve('public/js/calendar.js');

test('Issue #274 — Timed Event Chip Screen Reader Title Double Announcement Prevention', async (t) => {
  const mod = loadFrontendModule(calendarJsPath, {
    calendarById: () => ({ color: '#6366f1' }),
    sanitizeColor: c => c,
    ensureContrastFloor: c => c,
    hexToRgba: () => 'rgba(0,0,0,0.1)',
    escHtml: s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    fmtTime: iso => {
      const d = new Date(iso);
      const h = String(d.getUTCHours()).padStart(2, '0');
      const m = String(d.getUTCMinutes()).padStart(2, '0');
      return `${h}:${m}`;
    }
  });

  await t.test('chipHtml for timed event includes start time in aria-label and omits duplicate title attribute', () => {
    const timedEvent = {
      uid: 'ev-1',
      title: 'Project Standup',
      start: '2026-09-10T10:00:00Z',
      allDay: false,
      calendarId: 'cal-1'
    };

    const html = mod.chipHtml(timedEvent);
    const expectedTime = mod.fmtTime(timedEvent.start);
    assert.ok(html.includes(`aria-label="${expectedTime} Project Standup"`), `chipHtml must include time in aria-label for timed event (got html: ${html})`);
    assert.strictEqual(html.includes('title="Project Standup"'), false, 'chipHtml must omit redundant title attribute to prevent double title announcement');
  });

  await t.test('chipHtml for all-day event sets aria-label to title and omits duplicate title attribute', () => {
    const allDayEvent = {
      uid: 'ev-2',
      title: 'Company Holiday',
      start: '2026-09-10T00:00:00Z',
      allDay: true,
      calendarId: 'cal-1'
    };

    const html = mod.chipHtml(allDayEvent);
    assert.ok(html.includes('aria-label="Company Holiday"'), 'chipHtml must include title in aria-label for all-day event');
    assert.strictEqual(html.includes('title="Company Holiday"'), false, 'chipHtml must omit redundant title attribute');
  });

  await t.test('createEventBlock includes time and title in aria-label', () => {
    const timedEvent = {
      uid: 'ev-3',
      title: 'Architecture Review',
      start: '2026-09-10T14:00:00Z',
      end: '2026-09-10T15:00:00Z',
      allDay: false,
      calendarId: 'cal-1'
    };

    const block = mod.createEventBlock(timedEvent, new Date('2026-09-10T00:00:00Z'), 0, 1, false);
    const ariaLabel = block.getAttribute('aria-label');
    const expectedStart = mod.fmtTime(timedEvent.start);
    const expectedEnd = mod.fmtTime(timedEvent.end);
    assert.ok(ariaLabel.includes(`${expectedStart} – ${expectedEnd} Architecture Review`), `createEventBlock aria-label must include time and title (got: ${ariaLabel})`);
  });

  await t.test('agendaEventHtml includes time and title in aria-label', () => {
    const timedEvent = {
      uid: 'ev-4',
      title: '1-on-1 Sync',
      start: '2026-09-10T16:00:00Z',
      end: '2026-09-10T16:30:00Z',
      allDay: false,
      calendarId: 'cal-1'
    };

    const html = mod.agendaEventHtml(timedEvent);
    const expectedStart = mod.fmtTime(timedEvent.start);
    const expectedEnd = mod.fmtTime(timedEvent.end);
    assert.ok(html.includes(`aria-label="${expectedStart} – ${expectedEnd} 1-on-1 Sync"`), 'agendaEventHtml must include time and title in aria-label');
  });
});
