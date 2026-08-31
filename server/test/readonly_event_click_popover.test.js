'use strict';
process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createMockDom() {
  const elements = new Map();

  function createElement(tagName) {
    const el = {
      tagName: tagName.toUpperCase(),
      id: '',
      className: '',
      style: {},
      dataset: {},
      innerHTML: '',
      classList: {
        add: (...names) => {
          const list = new Set((el.className || '').split(' ').filter(Boolean));
          names.forEach(n => list.add(n));
          el.className = Array.from(list).join(' ');
        },
        remove: (...names) => {
          const list = new Set((el.className || '').split(' ').filter(Boolean));
          names.forEach(n => list.delete(n));
          el.className = Array.from(list).join(' ');
        },
        contains: (name) => (el.className || '').split(' ').filter(Boolean).includes(name),
        toggle: (name, force) => {
          const list = new Set((el.className || '').split(' ').filter(Boolean));
          if (force !== undefined) {
            if (force) list.add(name); else list.delete(name);
          } else {
            if (list.has(name)) list.delete(name); else list.add(name);
          }
          el.className = Array.from(list).join(' ');
        }
      },
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 200, height: 100 }),
      querySelector: (selector) => {
        if (selector.startsWith('#')) {
          const id = selector.slice(1);
          return elements.get(id) || null;
        }
        return null;
      },
      querySelectorAll: () => []
    };
    return el;
  }

  const popover = createElement('div');
  popover.id = 'event-popover';
  popover.classList.add('hidden');
  elements.set('event-popover', popover);

  const document = {
    getElementById: (id) => {
      if (elements.has(id)) return elements.get(id);
      // If innerHTML created an element with id inside popover, query it
      if (popover.innerHTML.includes(`id="${id}"`)) {
        const child = createElement('button');
        child.id = id;
        elements.set(id, child);
        return child;
      }
      return null;
    },
    createElement,
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const window = {
    innerHeight: 800,
    innerWidth: 1200,
    location: { search: '' },
    addEventListener: () => {}
  };

  return { document, window, elements, popover };
}

function loadAppPopoverLogic(mockDom, mockStore) {
  const appPath = path.resolve(__dirname, '../../public/js/app.js');
  let code = fs.readFileSync(appPath, 'utf8');

  // Strip imports
  code = code.replace(/^\s*import\s+[^;]+;/gm, '');
  // Strip exports
  code = code.replace(/^\s*export\s+(async\s+)?function\s+/gm, '$1function ');
  code = code.replace(/^\s*export\s+const\s+/gm, 'const ');
  code = code.replace(/^\s*export\s+let\s+/gm, 'let ');
  // Prevent boot execution on load
  code = code.replace(/boot\(\)\.catch\(console\.error\);?/g, '');

  const context = {
    console,
    Date,
    Array,
    String,
    RegExp,
    parseInt,
    Boolean,
    Set,
    Map,
    document: mockDom.document,
    window: mockDom.window,
    store: mockStore,
    checkAndTriggerAlarms: () => {},
    initEventModal: () => {},
    initWelcomeModal: () => {},
    initIcsImport: () => {},
    openCreateModal: () => {},
    openEditModal: () => {},
    URLSearchParams,
    location: mockDom.window.location,
    showToast: () => {},
    closeModal: () => {},
    chooseRecurrenceScope: () => Promise.resolve('series'),
    initAccountModal: () => {},
    openAccountModal: () => {},
    initNotificationService: () => {},
    initTaskUI: () => {},
    openTaskModal: () => {},
    renderKanbanBoard: () => {},
    renderSidebarTasks: () => {},
    initInvitations: () => {},
    initAvailabilityManager: () => {},
    initTheme: () => {},
    setTheme: () => {},
    getStoredTheme: () => 'system',
    renderView: () => {},
    getToolbarTitle: () => '',
    navigate: () => new Date(),
    getDateRange: () => ({ start: new Date(), end: new Date() }),
    renderMiniCalendar: () => {},
    sanitizeColor: (c) => c || '#6366f1',
    EventsAPI: { remove: () => Promise.resolve() },
    invalidateEventCache: () => {},
    loadEvents: () => {},
    exports: {},
    module: { exports: {} }
  };
  context.global = context;

  vm.createContext(context);
  vm.runInContext(code, context);

  return context;
}

describe('Issue #78 — Read-Only Calendar Event Click & Popover Handling', () => {
  it('clicking an event on a read-only calendar must not throw uncaught TypeError on missing delete button', () => {
    const mockDom = createMockDom();
    const readOnlyCal = { id: 'cal-readonly-1', name: 'Shared Readonly', readOnly: true, color: '#3b82f6' };
    const mockStore = {
      get: (key) => {
        if (key === 'calendars') return [readOnlyCal];
        return null;
      }
    };

    const ctx = loadAppPopoverLogic(mockDom, mockStore);
    assert.strictEqual(typeof ctx.showEventPopover, 'function');

    const ev = {
      uid: 'evt-readonly-101',
      calendarId: 'cal-readonly-1',
      title: 'Read Only Meeting',
      start: '2026-08-25T10:00:00Z',
      end: '2026-08-25T11:00:00Z',
      allDay: false
    };

    const mouseEvent = { clientX: 150, clientY: 200 };

    // Executing showEventPopover on a read-only event must NOT throw
    assert.doesNotThrow(() => {
      ctx.showEventPopover(ev, mouseEvent);
    }, TypeError);

    const popover = mockDom.elements.get('event-popover');
    assert.ok(popover.innerHTML.includes('Schreibgeschützt'), 'Popover must show Schreibgeschützt label');
    assert.ok(popover.innerHTML.includes('id="popover-edit-btn"'), 'Popover must contain Details edit button');
    assert.strictEqual(popover.innerHTML.includes('id="popover-delete-btn"'), false, 'Popover must not contain delete button for read-only calendar');
  });

  it('clicking an event on a writable calendar attaches both edit and delete listeners', () => {
    const mockDom = createMockDom();
    const writableCal = { id: 'cal-writable-1', name: 'My Calendar', readOnly: false, color: '#10b981' };
    const mockStore = {
      get: (key) => {
        if (key === 'calendars') return [writableCal];
        return null;
      }
    };

    const ctx = loadAppPopoverLogic(mockDom, mockStore);

    const ev = {
      uid: 'evt-writable-102',
      calendarId: 'cal-writable-1',
      title: 'Writable Meeting',
      start: '2026-08-25T14:00:00Z',
      end: '2026-08-25T15:00:00Z',
      allDay: false
    };

    const mouseEvent = { clientX: 300, clientY: 400 };

    assert.doesNotThrow(() => {
      ctx.showEventPopover(ev, mouseEvent);
    });

    const popover = mockDom.elements.get('event-popover');
    assert.ok(popover.innerHTML.includes('id="popover-edit-btn"'));
    assert.ok(popover.innerHTML.includes('id="popover-delete-btn"'));
  });
});
