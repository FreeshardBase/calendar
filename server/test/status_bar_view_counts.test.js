'use strict';
process.env.NODE_ENV = 'test';

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// app.js expects window.SafeUrl (loaded by index.html as a classic script).
const SafeUrl = require('../../public/js/safeUrl');

const appJsCode = fs.readFileSync(path.resolve(__dirname, '../../public/js/app.js'), 'utf8');

// Runs the real app.js in a VM with a stubbed DOM and returns the context, the
// store state and the #status-bar element.
function loadApp() {
  const state = {
    view: 'month',
    currentDate: new Date(2026, 7, 31),
    events: [],
    tasks: [],
    hiddenCalendars: new Set(),
    searchQuery: '',
    calendars: [],
    eventErrors: []
  };
  const store = { get: (key) => state[key], set: (obj) => Object.assign(state, obj) };

  const stub = () => ({
    textContent: '', innerHTML: '', style: {},
    querySelectorAll: () => [], querySelector: () => stub(),
    addEventListener: () => {}, setAttribute: () => {}, removeAttribute: () => {}, appendChild: () => {},
    insertBefore: () => {}, remove: () => {}, classList: { add() {}, remove() {}, toggle() {} }
  });
  const statusBar = stub();
  const elements = new Map([['status-bar', statusBar]]);
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, stub());
    return elements.get(id);
  };

  const context = {
    console,
    setTimeout: () => {},
    setInterval: () => {},
    URLSearchParams,
    window: { location: { search: '' }, addEventListener: () => {}, SafeUrl },
    document: {
      getElementById: getEl,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => stub()
    },
    store,
    invalidateEventCache: () => {},
    cacheEvents: () => {},
    getCachedEvents: () => null,
    getCalendarSyncCache: () => null,
    setCalendarSyncCache: () => {},
    toggleCalendar: () => {},
    holdsEvents: (c) => c.supportsVEVENT === true,
    holdsTasks: (c) => c.supportsVTODO === true,
    getToolbarTitle: () => 'Title',
    getDateRange: () => ({ start: new Date(2026, 7, 31), end: new Date(2026, 7, 31, 23, 59) }),
    navigate: () => {},
    sanitizeColor: (c) => c,
    renderView: () => {},
    renderTaskArea: () => {},
    renderSidebarTasks: () => {},
    renderMiniCalendar: () => {},
    initEventModal: () => {},
    initAccountModal: () => {},
    initNotificationService: () => {},
    initTaskUI: () => {},
    initInvitations: () => {},
    initAvailabilityManager: () => {},
    initMSGraphModal: () => {},
    initDialogFocusManager: () => {},
    openCreateModal: () => {},
    openEditModal: () => {},
    checkAndTriggerAlarms: () => {},
    setUnauthorizedHandler: () => {},
    // boot() runs on load; its account load never settles, so it leaves the state these tests set alone.
    AccountsAPI: { list: () => new Promise(() => {}) },
    CalendarsAPI: {},
    EventsAPI: {},
    TasksAPI: {},
    WebcalAPI: {},
    exports: {},
    module: { exports: {} }
  };

  const cjsCode = appJsCode.replace(/^import\s+[\s\S]*?;$/gm, '').replace(/^export\s+/gm, '');
  vm.createContext(context);
  vm.runInContext(cjsCode, context);
  return { context, state, statusBar };
}

const EMPTY_BY_VIEW = {
  month: 'Keine Termine in diesem Monat.',
  week: 'Keine Termine in dieser Woche.',
  workweek: 'Keine Termine in dieser Arbeitswoche.',
  day: 'Keine Termine an diesem Tag.',
  agenda: 'Keine Termine im gewählten Zeitraum.'
};

describe('Issue #106 — the status bar states loading, empty, error and count for every view', () => {
  let app;
  beforeEach(() => { app = loadApp(); });

  // Each render starts from a blank bar, so a view that never writes it fails
  // instead of passing on the previous view's text.
  function render(view) {
    app.state.view = view;
    app.statusBar.textContent = '';
    app.context.renderCalendarView();
    return app.statusBar.textContent;
  }

  it('says per view that the visible range is free instead of reporting a bare zero', () => {
    for (const [view, text] of Object.entries(EMPTY_BY_VIEW)) {
      assert.strictEqual(render(view), text, `${view} view with no events`);
    }
    assert.strictEqual(render('kanban'), 'Keine Aufgaben vorhanden.');
  });

  it('counts events in every calendar view and tasks on the Kanban board', () => {
    app.state.events = [
      { uid: 'ev1', title: 'Meeting A', calendarId: 'cal1' },
      { uid: 'ev2', title: 'Meeting B', calendarId: 'cal2' }
    ];
    app.state.tasks = [
      { uid: 't1', title: 'Task 1', status: 'NEEDS-ACTION' },
      { uid: 't2', title: 'Task 2', status: 'COMPLETED' },
      { uid: 't3', title: 'Task 3', status: 'IN-PROCESS' }
    ];
    for (const view of Object.keys(EMPTY_BY_VIEW)) {
      assert.strictEqual(render(view), '2 Termine', `${view} view`);
    }
    assert.strictEqual(render('kanban'), '3 Aufgaben');

    app.state.hiddenCalendars.add('cal2');
    assert.strictEqual(render('month'), '1 Termin');
    app.state.searchQuery = 'Task 1';
    assert.strictEqual(render('kanban'), '1 Aufgabe');
  });

  it('does not call a range free when some calendars could not be read', () => {
    app.state.eventErrors = [{ accountId: 'acc1', error: 'timeout' }];
    assert.strictEqual(render('day'), 'Keine Termine geladen – nicht alle Kalender konnten gelesen werden.');
    app.state.events = [{ uid: 'ev1', title: 'Meeting A', calendarId: 'cal1' }];
    assert.strictEqual(render('day'), '1 Termin – nicht alle Kalender konnten gelesen werden.');
  });

  it('keeps the error in the bar after a failed load, and on later re-renders', async () => {
    const writes = [];
    let text = '';
    Object.defineProperty(app.statusBar, 'textContent', {
      get: () => text,
      set: (v) => { text = v; writes.push(v); }
    });
    app.state.view = 'day';
    app.context.EventsAPI.list = async () => { throw new Error('boom'); };
    app.context.loadWebcalEvents = async () => [];

    await app.context.loadEvents();

    assert.strictEqual(writes[0], 'Lade Termine…');
    assert.strictEqual(text, 'Fehler: Fehler beim Laden der Termine: boom', `writes: ${JSON.stringify(writes)}`);
    assert.ok(!writes.some(w => w.startsWith('Keine Termine')), `a failed load must never read as a free day: ${JSON.stringify(writes)}`);

    // Re-rendering (e.g. toggling a calendar) must not turn the failure into "free".
    assert.strictEqual(render('day'), 'Fehler beim Laden der Termine: boom');

    // A later successful load clears the error state.
    app.context.EventsAPI.list = async () => ({ events: [], errors: [] });
    await app.context.loadEvents();
    assert.strictEqual(text, 'Keine Termine an diesem Tag.');
  });
});
