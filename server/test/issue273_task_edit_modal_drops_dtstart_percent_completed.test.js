'use strict';
process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createMockDomEnvironment() {
  const elements = new Map();
  const eventListeners = new Map();

  function parseHtmlChildren(html, parent) {
    const regex = /<([a-z0-9-]+)([^>]*)>(.*?)<\/\1>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const tagName = match[1];
      const attrStr = match[2];
      const inner = match[3];

      const child = createMockElement(tagName);
      const classMatch = attrStr.match(/class=["']([^"']+)["']/i);
      if (classMatch) child.className = classMatch[1];
      const idMatch = attrStr.match(/id=["']([^"']+)["']/i);
      if (idMatch) {
        child.id = idMatch[1];
        elements.set(idMatch[1], child);
      }
      child.textContent = inner.replace(/<[^>]+>/g, '');
      child.innerHTML = inner;
      parent.appendChild(child);
      parseHtmlChildren(inner, child);
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
      children: [],
      parentNode: null,
      value: '',
      textContent: '',
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
      setAttribute: (k, v) => el.attributes.set(k, String(v)),
      getAttribute: (k) => el.attributes.get(k) || null,
      removeAttribute: (k) => el.attributes.delete(k),
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
    if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
    return el.tagName === selector.toUpperCase();
  }

  const documentBody = createMockElement('body', 'body');

  // Populate basic modal elements into DOM
  const backdrop = createMockElement('div', 'task-modal-backdrop');
  const modalTitle = createMockElement('h3', 'task-modal-title');
  const taskId = createMockElement('input', 'task-id');
  const taskHref = createMockElement('input', 'task-href');
  const taskEtag = createMockElement('input', 'task-etag');
  const taskTitle = createMockElement('input', 'task-title');
  const taskDesc = createMockElement('textarea', 'task-description');
  const taskStatus = createMockElement('select', 'task-status');
  const taskCal = createMockElement('select', 'task-calendar-id');
  const taskDue = createMockElement('input', 'task-due');
  const taskPrio = createMockElement('select', 'task-priority');
  const taskRecur = createMockElement('select', 'task-recurrence');

  documentBody.appendChild(backdrop);
  documentBody.appendChild(modalTitle);
  documentBody.appendChild(taskId);
  documentBody.appendChild(taskHref);
  documentBody.appendChild(taskEtag);
  documentBody.appendChild(taskTitle);
  documentBody.appendChild(taskDesc);
  documentBody.appendChild(taskStatus);
  documentBody.appendChild(taskCal);
  documentBody.appendChild(taskDue);
  documentBody.appendChild(taskPrio);
  documentBody.appendChild(taskRecur);

  const document = {
    body: documentBody,
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => createMockElement(tag),
    querySelectorAll: (selector) => querySelectorAll(documentBody, selector)
  };

  const toasts = [];
  const window = {
    document,
    showToast: (msg, type) => toasts.push({ msg, type }),
    confirm: () => true
  };

  return { document, window, elements, toasts, eventListeners };
}

describe('Issue #273 — Task Edit Modal Preservation of DTSTART, PERCENT-COMPLETE and COMPLETED', () => {
  const tasksJsPath = path.resolve(__dirname, '../../public/js/tasks.js');
  let rawCode = fs.readFileSync(tasksJsPath, 'utf8');

  // Strip import/export statements for Node vm execution
  const cjsCode = rawCode
    .replace(/^import\s+.*?;/gm, '')
    .replace(/^export\s+/gm, '');

  it('openTaskModal and handleTaskSave preserve dtstart, percentComplete, and completed when updating task', async () => {
    const env = createMockDomEnvironment();
    let updatedPayload = null;

    const TasksAPI = {
      update: async (uid, payload) => {
        updatedPayload = payload;
        return { uid, ...payload };
      },
      create: async (payload) => payload
    };

    const store = {
      get: (key) => {
        if (key === 'calendars') return [{ id: 'cal-1', name: 'Persönlich' }];
        return null;
      }
    };

    const context = {
      console,
      document: env.document,
      window: env.window,
      TasksAPI,
      store,
      openDialog: () => {},
      closeDialog: () => {},
      showToast: env.window.showToast,
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      escapeHtml: (s) => String(s || ''),
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsCode, context);

    const taskToEdit = {
      uid: 'task-999',
      href: '/tasks/task-999.ics',
      etag: '"etag-123"',
      title: 'Importierte Aufgabe mit Fortgang',
      description: 'Testbeschreibung',
      status: 'IN-PROCESS',
      calendarId: 'cal-1',
      due: '2026-09-15T18:00:00.000Z',
      dtstart: '2026-09-01T09:00:00.000Z',
      dtstartIsDate: false,
      dueIsDate: false,
      priority: 2,
      percentComplete: 65,
      completed: null,
      completedHistory: ['2026-08-15T10:00:00.000Z'],
      recurrence: 'FREQ=MONTHLY'
    };

    // 1. Open task in edit modal
    context.openTaskModal(taskToEdit);

    assert.strictEqual(env.elements.get('task-title').value, 'Importierte Aufgabe mit Fortgang');
    assert.strictEqual(env.elements.get('task-status').value, 'IN-PROCESS');

    // 2. Modify title in form
    env.elements.get('task-title').value = 'Importierte Aufgabe mit Fortgang (Aktualisiert)';

    // 3. Save task
    await context.handleTaskSave();

    assert.ok(updatedPayload, 'TasksAPI.update should have been invoked');
    assert.strictEqual(updatedPayload.title, 'Importierte Aufgabe mit Fortgang (Aktualisiert)');
    assert.strictEqual(updatedPayload.dtstart, '2026-09-01T09:00:00.000Z', 'dtstart must be preserved in update request');
    assert.strictEqual(updatedPayload.percentComplete, 65, 'percentComplete must be preserved in update request');
    assert.strictEqual(updatedPayload.completed, null, 'completed must be preserved in update request');
    assert.deepStrictEqual(updatedPayload.completedHistory, ['2026-08-15T10:00:00.000Z'], 'completedHistory must be preserved');
  });

  it('openTaskModal in create mode clears current task state', async () => {
    const env = createMockDomEnvironment();
    let createdPayload = null;

    const TasksAPI = {
      create: async (payload) => {
        createdPayload = payload;
        return payload;
      }
    };

    const store = {
      get: (key) => (key === 'calendars' ? [{ id: 'cal-1', name: 'Persönlich' }] : null)
    };

    const context = {
      console,
      document: env.document,
      window: env.window,
      TasksAPI,
      store,
      openDialog: () => {},
      closeDialog: () => {},
      showToast: env.window.showToast,
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      escapeHtml: (s) => String(s || ''),
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsCode, context);

    // Open in create mode
    context.openTaskModal(null);
    env.elements.get('task-title').value = 'Neue Aufgabe';
    env.elements.get('task-calendar-id').value = 'cal-1';

    await context.handleTaskSave();

    assert.ok(createdPayload, 'TasksAPI.create should have been invoked');
    assert.strictEqual(createdPayload.title, 'Neue Aufgabe');
    assert.strictEqual(createdPayload.dtstart, undefined, 'dtstart must be undefined for new tasks');
    assert.strictEqual(createdPayload.percentComplete, undefined, 'percentComplete must be undefined for new tasks');
  });

  it('PUT /api/tasks/:uid preserves dtstart, percentComplete, and completed attributes', async () => {
    const { parseICSToTask, taskToICS, reconcileTaskStatus } = require('../../server/caldav/parser');

    const rawTask = {
      uid: 'task-777',
      title: 'Server Task Preservation',
      status: 'IN-PROCESS',
      due: '2026-10-01T12:00:00.000Z',
      dtstart: '2026-09-01T08:00:00.000Z',
      priority: 1,
      percentComplete: 45,
      completed: null
    };

    const reconciled = reconcileTaskStatus(rawTask);
    assert.strictEqual(reconciled.dtstart, '2026-09-01T08:00:00.000Z');
    assert.strictEqual(reconciled.percentComplete, 45);
    assert.strictEqual(reconciled.status, 'IN-PROCESS');

    const ics = taskToICS(reconciled);
    assert.ok(ics.includes('DTSTART:20260901T080000Z'), 'ICS must contain DTSTART');
    assert.ok(ics.includes('PERCENT-COMPLETE:45'), 'ICS must contain PERCENT-COMPLETE');

    const parsed = parseICSToTask(ics);
    assert.strictEqual(parsed.dtstart, '2026-09-01T08:00:00.000Z');
    assert.strictEqual(parsed.percentComplete, 45);
  });
});
