'use strict';
process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createMockDomEnvironment() {
  const elements = new Map();
  const eventListeners = new Map();

  function parseHtmlChildren(html, parent) {
    const regex = /<([a-z0-9-]+)([^>]*?)(?:>(.*?)<\/\1>|\/>|>)/gis;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const tagName = match[1];
      const attrStr = match[2] || '';
      const inner = match[3] || '';

      const child = createMockElement(tagName);
      const classMatch = attrStr.match(/class=["']([^"']+)["']/i);
      if (classMatch) child.className = classMatch[1];
      const idMatch = attrStr.match(/id=["']([^"']+)["']/i);
      if (idMatch) {
        child.id = idMatch[1];
        elements.set(idMatch[1], child);
      }
      const dataMatches = attrStr.matchAll(/data-([a-z0-9-]+)=["']([^"']*)["']/gi);
      for (const dm of dataMatches) {
        child.attributes.set('data-' + dm[1], dm[2]);
        child.dataset[dm[1]] = dm[2];
        const camelKey = dm[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        child.dataset[camelKey] = dm[2];
      }
      child.textContent = inner.replace(/<[^>]+>/g, '');
      child._innerHTML = inner;
      parent.appendChild(child);
      if (inner.includes('<')) {
        parseHtmlChildren(inner, child);
      }
    }
  }

  function createMockElement(tagName, id = '', className = '') {
    let _innerHTML = '';
    const el = {
      tagName: tagName.toUpperCase(),
      id,
      className,
      style: {},
      attributes: new Map(),
      dataset: {},
      children: [],
      parentNode: null,
      value: '',
      textContent: '',
      get _innerHTML() { return _innerHTML; },
      set _innerHTML(val) { _innerHTML = val; },
      get innerHTML() { return _innerHTML; },
      set innerHTML(val) {
        _innerHTML = val;
        el.children = [];
        parseHtmlChildren(val, el);
      },
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
        contains: (name) => (el.className || '').split(' ').filter(Boolean).includes(name)
      },
      setAttribute: (k, v) => {
        el.attributes.set(k, String(v));
        if (k.startsWith('data-')) {
          const rawKey = k.slice(5);
          el.dataset[rawKey] = String(v);
          const camelKey = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          el.dataset[camelKey] = String(v);
        }
      },
      getAttribute: (k) => el.attributes.get(k) || null,
      removeAttribute: (k) => {
        el.attributes.delete(k);
        if (k.startsWith('data-')) {
          const rawKey = k.slice(5);
          delete el.dataset[rawKey];
        }
      },
      hasAttribute: (k) => el.attributes.has(k),
      addEventListener: (type, handler) => {
        const list = eventListeners.get(el) || [];
        list.push({ type, handler });
        eventListeners.set(el, list);
      },
      appendChild: (child) => {
        child.parentNode = el;
        el.children.push(child);
        if (child.id) elements.set(child.id, child);
        return child;
      },
      querySelector: (selector) => querySelectorAll(el, selector)[0] || null,
      querySelectorAll: (selector) => querySelectorAll(el, selector)
    };

    if (id) elements.set(id, el);
    return el;
  }

  function querySelectorAll(root, selector) {
    const results = [];
    function walk(node) {
      if (!node || !node.children) return;
      for (const child of node.children) {
        if (matchesSelector(child, selector)) {
          results.push(child);
        }
        walk(child);
      }
    }
    walk(root);
    return results;
  }

  function matchesSelector(el, selector) {
    if (selector.startsWith('#')) return el.id === selector.slice(1);
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return el.classList.contains(cls);
    }
    return el.tagName === selector.toUpperCase();
  }

  const documentBody = createMockElement('body', 'body');

  const document = {
    body: documentBody,
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => createMockElement(tag),
    querySelectorAll: (selector) => querySelectorAll(documentBody, selector)
  };

  const toasts = [];
  const alerts = [];

  const window = {
    document,
    alert: (msg) => alerts.push(msg),
    showToast: (msg, type) => toasts.push({ msg, type }),
    confirm: () => true
  };

  return { document, window, createMockElement, toasts, alerts, eventListeners };
}

describe('Issue #89 — Tasks UI Feedback, Error Reporting & RRULE Badge Formatting', () => {
  const tasksJsPath = path.resolve(__dirname, '../../public/js/tasks.js');
  let rawCode = fs.readFileSync(tasksJsPath, 'utf8');

  // Strip import/export statements for Node vm execution
  const cjsCode = rawCode
    .replace(/^import\s+.*?;/gm, '')
    .replace(/^export\s+/gm, '');

  it('formatRecurrenceLabel formats raw RRULE strings into human-readable German text', () => {
    const env = createMockDomEnvironment();
    const context = {
      console,
      document: env.document,
      window: env.window,
      confirm: env.window.confirm,
      alert: env.window.alert,
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      escapeHtml: (s) => s,
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsCode, context);

    assert.strictEqual(typeof context.formatRecurrenceLabel, 'function', 'formatRecurrenceLabel must be exported/defined');
    assert.strictEqual(context.formatRecurrenceLabel('FREQ=DAILY'), 'Täglich');
    assert.strictEqual(context.formatRecurrenceLabel('FREQ=WEEKLY'), 'Wöchentlich');
    assert.strictEqual(context.formatRecurrenceLabel('FREQ=MONTHLY'), 'Monatlich');
    assert.strictEqual(context.formatRecurrenceLabel('FREQ=YEARLY'), 'Jährlich');
    assert.strictEqual(context.formatRecurrenceLabel('RRULE:FREQ=DAILY'), 'Täglich');
    assert.strictEqual(context.formatRecurrenceLabel(''), '');
  });

  it('createKanbanCard displays formatted recurrence label on card badge instead of raw RRULE string', () => {
    const env = createMockDomEnvironment();
    const context = {
      console,
      document: env.document,
      window: env.window,
      confirm: env.window.confirm,
      alert: env.window.alert,
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      escapeHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsCode, context);

    const task = {
      uid: 'task-123',
      title: 'Test Task',
      status: 'NEEDS-ACTION',
      recurrence: 'FREQ=WEEKLY',
      calendarId: 'cal-1'
    };

    const card = context.createKanbanCard(task, {});
    assert.ok(card.innerHTML.includes('Wöchentlich'), 'Card innerHTML must contain formatted German text "Wöchentlich"');
    assert.ok(!card.innerHTML.includes('🔄 FREQ=WEEKLY'), 'Card innerHTML must not display raw "FREQ=WEEKLY" on badge');
  });

  it('kanban card actions emit toasts and never trigger alert() on error or success', async () => {
    const env = createMockDomEnvironment();

    const TasksAPI = {
      remove: async () => { throw new Error('API delete failed'); },
      update: async () => { throw new Error('API update failed'); }
    };

    const context = {
      console,
      document: env.document,
      window: env.window,
      confirm: env.window.confirm,
      alert: env.window.alert,
      TasksAPI,
      openDialog: () => {},
      closeDialog: () => {},
      confirmDialog: async () => true,
      showToast: env.window.showToast,
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      escapeHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsCode, context);

    const task = {
      uid: 'task-123',
      title: 'Test Task',
      status: 'NEEDS-ACTION',
      recurrence: 'FREQ=DAILY',
      calendarId: 'cal-1'
    };

    const card = context.createKanbanCard(task, {});
    const deleteBtn = card.querySelector('.btn-delete');
    assert.ok(deleteBtn, 'Card must have delete button');

    // Trigger delete button handler registered via addEventListener
    const deleteListeners = env.eventListeners.get(deleteBtn) || [];
    const deleteHandler = deleteListeners.find(l => l.type === 'click')?.handler;
    assert.ok(deleteHandler, 'Delete click handler must be attached');

    await deleteHandler();

    assert.strictEqual(env.alerts.length, 0, 'No alert() must be called on delete error');
    assert.strictEqual(env.toasts.length, 1, 'showToast must be called on delete error');
    assert.strictEqual(env.toasts[0].type, 'error');
    assert.ok(env.toasts[0].msg.includes('API delete failed'));
  });

  it('kanban card .btn-complete on recurring task emits "Aufgabe auf <date> verschoben." toast', async () => {
    const env = createMockDomEnvironment();
    let updatedPayload = null;

    const TasksAPI = {
      update: async (uid, payload) => {
        updatedPayload = payload;
        return payload;
      }
    };

    const context = {
      console,
      document: env.document,
      window: env.window,
      confirm: env.window.confirm,
      alert: env.window.alert,
      TasksAPI,
      openDialog: () => {},
      closeDialog: () => {},
      confirmDialog: async () => true,
      showToast: env.window.showToast,
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      escapeHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsCode, context);

    const recurringTask = {
      uid: 'task-recur-1',
      title: 'Weekly Standup Prep',
      status: 'NEEDS-ACTION',
      due: '2026-08-14T00:00:00.000Z',
      dueIsDate: true,
      recurrence: 'FREQ=WEEKLY',
      calendarId: 'cal-1'
    };

    const card = context.createKanbanCard(recurringTask, {});
    const completeBtn = card.querySelector('.btn-complete');
    assert.ok(completeBtn, 'Card must have complete button');

    const listeners = env.eventListeners.get(completeBtn) || [];
    const completeHandler = listeners.find(l => l.type === 'click')?.handler;
    assert.ok(completeHandler, 'Complete click handler must be attached');

    await completeHandler();

    assert.ok(updatedPayload, 'TasksAPI.update should have been called');
    assert.strictEqual(env.alerts.length, 0, 'No alert() must be called');
    assert.strictEqual(env.toasts.length, 1, 'Exactly one toast must be emitted');
    assert.strictEqual(env.toasts[0].type, 'success');
    assert.strictEqual(
      env.toasts[0].msg,
      'Aufgabe auf 21.8.2026 verschoben.',
      'Toast must announce the shifted date rather than unconditionally stating "Aufgabe als erledigt markiert."'
    );
  });

  it('kanban card .btn-status-next on recurring task advances and emits "Aufgabe auf <date> verschoben." toast', async () => {
    const env = createMockDomEnvironment();
    let updatedPayload = null;

    const TasksAPI = {
      update: async (uid, payload) => {
        updatedPayload = payload;
        return payload;
      }
    };

    const context = {
      console,
      document: env.document,
      window: env.window,
      confirm: env.window.confirm,
      alert: env.window.alert,
      TasksAPI,
      openDialog: () => {},
      closeDialog: () => {},
      confirmDialog: async () => true,
      showToast: env.window.showToast,
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      escapeHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsCode, context);

    const recurringTask = {
      uid: 'task-recur-2',
      title: 'Weekly Review',
      status: 'IN-PROCESS',
      due: '2026-08-14T00:00:00.000Z',
      dueIsDate: true,
      recurrence: 'FREQ=WEEKLY',
      calendarId: 'cal-1'
    };

    const card = context.createKanbanCard(recurringTask, {});
    const nextBtn = card.querySelector('.btn-status-next');
    assert.ok(nextBtn, 'Card must have status-next button');

    const listeners = env.eventListeners.get(nextBtn) || [];
    const nextHandler = listeners.find(l => l.type === 'click')?.handler;
    assert.ok(nextHandler, 'Status-next click handler must be attached');

    await nextHandler();

    assert.ok(updatedPayload, 'TasksAPI.update should have been called');
    assert.strictEqual(env.toasts.length, 1, 'Exactly one toast must be emitted');
    assert.strictEqual(env.toasts[0].type, 'success');
    assert.strictEqual(
      env.toasts[0].msg,
      'Aufgabe auf 21.8.2026 verschoben.',
      'Toast on completing recurring task via status-next must announce the shifted date'
    );
  });

  it('sidebar task checkbox on recurring task emits "Aufgabe auf <date> verschoben." toast', async () => {
    const env = createMockDomEnvironment();
    let updatedPayload = null;

    const TasksAPI = {
      update: async (uid, payload) => {
        updatedPayload = payload;
        return payload;
      }
    };

    const context = {
      console,
      document: env.document,
      window: env.window,
      confirm: env.window.confirm,
      alert: env.window.alert,
      TasksAPI,
      openDialog: () => {},
      closeDialog: () => {},
      confirmDialog: async () => true,
      showToast: env.window.showToast,
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      escapeHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsCode, context);

    const recurringTask = {
      uid: 'task-recur-3',
      title: 'Weekly Standup',
      status: 'NEEDS-ACTION',
      due: '2026-08-14T00:00:00.000Z',
      dueIsDate: true,
      recurrence: 'FREQ=WEEKLY',
      calendarId: 'cal-1'
    };

    const container = env.createMockElement('div', 'sidebar-tasks-list');
    const countBadge = env.createMockElement('span', 'tasks-badge');

    context.renderSidebarTasks(container, countBadge, [recurringTask], {});

    const checkbox = container.querySelector('.sidebar-task-checkbox');
    assert.ok(checkbox, 'Sidebar item must have checkbox');

    const listeners = env.eventListeners.get(checkbox) || [];
    const changeHandler = listeners.find(l => l.type === 'change')?.handler;
    assert.ok(changeHandler, 'Checkbox change handler must be attached');

    await changeHandler({ stopPropagation: () => {} });

    assert.ok(updatedPayload, 'TasksAPI.update should have been called');
    assert.strictEqual(env.toasts.length, 1, 'Exactly one toast must be emitted');
    assert.strictEqual(env.toasts[0].type, 'success');
    assert.strictEqual(
      env.toasts[0].msg,
      'Aufgabe auf 21.8.2026 verschoben.',
      'Sidebar checkbox on recurring task must announce shifted date'
    );
  });

  it('non-recurring task completion emits "Aufgabe als erledigt markiert." toast', async () => {
    const env = createMockDomEnvironment();
    let updatedPayload = null;

    const TasksAPI = {
      update: async (uid, payload) => {
        updatedPayload = payload;
        return payload;
      }
    };

    const context = {
      console,
      document: env.document,
      window: env.window,
      confirm: env.window.confirm,
      alert: env.window.alert,
      TasksAPI,
      openDialog: () => {},
      closeDialog: () => {},
      confirmDialog: async () => true,
      showToast: env.window.showToast,
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      escapeHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsCode, context);

    const singleTask = {
      uid: 'task-single-1',
      title: 'One-off Task',
      status: 'NEEDS-ACTION',
      due: '2026-08-14T00:00:00.000Z',
      calendarId: 'cal-1'
    };

    const card = context.createKanbanCard(singleTask, {});
    const completeBtn = card.querySelector('.btn-complete');
    const listeners = env.eventListeners.get(completeBtn) || [];
    const completeHandler = listeners.find(l => l.type === 'click')?.handler;
    await completeHandler();

    assert.strictEqual(env.toasts.length, 1);
    assert.strictEqual(env.toasts[0].type, 'success');
    assert.strictEqual(env.toasts[0].msg, 'Aufgabe als erledigt markiert.');
  });

  it('terminal recurring task completion (UNTIL in past) emits "Aufgabe als erledigt markiert." toast', async () => {
    const env = createMockDomEnvironment();
    let updatedPayload = null;

    const TasksAPI = {
      update: async (uid, payload) => {
        updatedPayload = payload;
        return payload;
      }
    };

    const context = {
      console,
      document: env.document,
      window: env.window,
      confirm: env.window.confirm,
      alert: env.window.alert,
      TasksAPI,
      openDialog: () => {},
      closeDialog: () => {},
      confirmDialog: async () => true,
      showToast: env.window.showToast,
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      escapeHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsCode, context);

    const terminalTask = {
      uid: 'task-terminal-1',
      title: 'Last Occurrence Task',
      status: 'NEEDS-ACTION',
      due: '2026-08-14T00:00:00.000Z',
      dueIsDate: true,
      recurrence: 'FREQ=WEEKLY;UNTIL=20260814T000000Z',
      calendarId: 'cal-1'
    };

    const card = context.createKanbanCard(terminalTask, {});
    const completeBtn = card.querySelector('.btn-complete');
    const listeners = env.eventListeners.get(completeBtn) || [];
    const completeHandler = listeners.find(l => l.type === 'click')?.handler;
    await completeHandler();

    assert.strictEqual(env.toasts.length, 1);
    assert.strictEqual(env.toasts[0].type, 'success');
    assert.strictEqual(env.toasts[0].msg, 'Aufgabe als erledigt markiert.');
  });

  it('invitations.js RSVP error emits error toast and never triggers alert()', async () => {
    const invitationsJsPath = path.resolve(__dirname, '../../public/js/invitations.js');
    const rawInvCode = fs.readFileSync(invitationsJsPath, 'utf8');
    const cjsInvCode = rawInvCode
      .replace(/^import\s+.*?;/gm, '')
      .replace(/^export\s+/gm, '');

    const env = createMockDomEnvironment();

    const sampleInvitations = [{
      uid: 'inv-test-1',
      title: 'Team Sync',
      calendarId: 'cal-1',
      href: '/cal-1/sync.ics',
      userEmail: 'testuser@example.com',
      attendees: [{ name: 'Test User', email: 'testuser@example.com', status: 'NEEDS-ACTION' }]
    }];

    const InvitationsAPI = {
      rsvp: async () => {
        throw new Error('CalDAV 500 Internal Server Error');
      },
      list: async () => sampleInvitations
    };

    // Pre-create container element in document
    const listBody = env.createMockElement('div', 'invitations-list-body');
    env.document.body.appendChild(listBody);

    const context = {
      console,
      document: env.document,
      window: env.window,
      alert: env.window.alert,
      showToast: env.window.showToast,
      InvitationsAPI,
      openDialog: () => {},
      closeDialog: () => {},
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsInvCode, context);

    // Load sample invitations and render the list
    await context.loadInvitations();
    context.renderInvitationsList();

    const rsvpBtn = listBody.querySelector('.rsvp-btn');
    assert.ok(rsvpBtn, 'Must find rsvp button');
    const listeners = env.eventListeners.get(rsvpBtn) || [];
    const clickHandler = listeners.find(l => l.type === 'click')?.handler;
    assert.ok(clickHandler, 'RSVP button must have click handler attached');

    const clickEvent = {
      currentTarget: rsvpBtn,
      target: rsvpBtn,
      stopPropagation: () => {},
      preventDefault: () => {}
    };

    await clickHandler(clickEvent);

    assert.strictEqual(env.alerts.length, 0, 'Must NOT call window.alert() on RSVP failure');
    assert.strictEqual(env.toasts.length, 1, 'Must call showToast() on RSVP failure');
    assert.strictEqual(env.toasts[0].type, 'error', 'Toast type must be "error"');
    assert.ok(
      env.toasts[0].msg.includes('CalDAV 500 Internal Server Error'),
      'Toast message must contain the error message'
    );
  });
});
