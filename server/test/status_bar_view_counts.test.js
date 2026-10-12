'use strict';
process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// app.js expects window.SafeUrl (loaded by index.html as a classic script).
const SafeUrl = require('../../public/js/safeUrl');

describe('Issue #106 — Status Bar Synchronization, View Counts & Timeout Removal', () => {
  const appJsPath = path.resolve(__dirname, '../../public/js/app.js');
  const appJsCode = fs.readFileSync(appJsPath, 'utf8');

  it('loadEvents must not clear status bar after 3 seconds timeout', () => {
    assert.strictEqual(
      appJsCode.includes("setTimeout(() => setStatus(''), 3000)"),
      false,
      'loadEvents must not contain setTimeout(() => setStatus(""), 3000) that clears status bar to blank'
    );
  });

  it('renderCalendarView updates status bar across all 6 views accurately', () => {
    const statusHistory = [];
    const state = {
      view: 'month',
      currentDate: new Date('2026-08-31T00:00:00Z'),
      events: [
        { uid: 'ev1', title: 'Meeting A', calendarId: 'cal1' },
        { uid: 'ev2', title: 'Meeting B', calendarId: 'cal2' }
      ],
      tasks: [
        { uid: 't1', title: 'Task 1', status: 'NEEDS-ACTION' },
        { uid: 't2', title: 'Task 2', status: 'COMPLETED' },
        { uid: 't3', title: 'Task 3', status: 'IN-PROCESS' }
      ],
      hiddenCalendars: new Set(),
      searchQuery: ''
    };

    const store = {
      get: (key) => state[key],
      set: (obj) => Object.assign(state, obj)
    };

    const statusBar = { textContent: '' };
    const elements = new Map([
      ['calendar-container', { innerHTML: '' }],
      ['toolbar-title', { textContent: '' }],
      ['mini-calendar', { innerHTML: '' }],
      ['status-bar', statusBar]
    ]);

    const setStatus = (msg) => {
      statusBar.textContent = msg;
      statusHistory.push(msg);
    };

    const getEl = (id) => elements.get(id) || { textContent: '', innerHTML: '', querySelectorAll: () => [], addEventListener: () => {} };

    const context = {
      console,
      store,
      setStatus,
      URLSearchParams,
      window: {
        location: { search: '' },
        addEventListener: () => {},
        SafeUrl
      },
      $: getEl,
      document: {
        getElementById: getEl,
        querySelectorAll: () => [],
        addEventListener: () => {}
      },
      getToolbarTitle: () => 'Title',
      renderView: () => {},
      renderKanbanBoard: () => {},
      renderMiniCalendar: () => {},
      initEventModal: () => {},
      initAccountModal: () => {},
      initWelcomeModal: () => {},
      initIcsImport: () => {},
      initNotificationService: () => {},
      initTaskUI: () => {},
      initInvitations: () => {},
      initAvailabilityManager: () => {},
      initMSGraphModal: () => {},
      initDialogFocusManager: () => {},
      openCreateModal: () => {},
      onEventSaved: () => {},
      onEventDeleted: () => {},
      showEventPopover: () => {},
      loadEvents: () => {},
      loadTasks: () => {},
      openEditModal: () => {},
      AccountsAPI: {},
      CalendarsAPI: {},
      EventsAPI: {},
      TasksAPI: {},
      checkAndTriggerAlarms: () => {},
      exports: {},
      module: { exports: {} }
    };

    // Extract renderCalendarView, getFilteredEvents, getFilteredTasks
    const fnCode = appJsCode + '\nexports.renderCalendarView = renderCalendarView;\nexports.getFilteredEvents = getFilteredEvents;\nexports.getFilteredTasks = getFilteredTasks;';
    const cjsCode = fnCode.replace(/^import\s+.*?;/gm, '').replace(/^export\s+/gm, '');

    vm.createContext(context);
    vm.runInContext(cjsCode, context);

    // 1. Month View
    state.view = 'month';
    context.renderCalendarView();
    assert.strictEqual(statusBar.textContent, '2 Termine', 'Month view must display "2 Termine"');

    // 2. Week View
    state.view = 'week';
    context.renderCalendarView();
    assert.strictEqual(statusBar.textContent, '2 Termine', 'Week view must display "2 Termine"');

    // 3. Workweek View
    state.view = 'workweek';
    context.renderCalendarView();
    assert.strictEqual(statusBar.textContent, '2 Termine', 'Workweek view must display "2 Termine"');

    // 4. Day View
    state.view = 'day';
    context.renderCalendarView();
    assert.strictEqual(statusBar.textContent, '2 Termine', 'Day view must display "2 Termine"');

    // 5. Agenda View
    state.view = 'agenda';
    context.renderCalendarView();
    assert.strictEqual(statusBar.textContent, '2 Termine', 'Agenda view must display "2 Termine"');

    // 6. Kanban View
    state.view = 'kanban';
    context.renderCalendarView();
    assert.strictEqual(statusBar.textContent, '3 Aufgaben', 'Kanban view must display "3 Aufgaben" instead of blank or event count');

    // 7. Hidden calendar filtering
    state.view = 'month';
    state.hiddenCalendars.add('cal2');
    context.renderCalendarView();
    assert.strictEqual(statusBar.textContent, '1 Termin', 'Status bar must show 1 Termin when 1 calendar is hidden');

    // 8. Search query filtering for tasks in Kanban
    state.view = 'kanban';
    state.searchQuery = 'Task 1';
    context.renderCalendarView();
    assert.strictEqual(statusBar.textContent, '1 Aufgabe', 'Kanban status bar must reflect search query filtering');
  });
});
