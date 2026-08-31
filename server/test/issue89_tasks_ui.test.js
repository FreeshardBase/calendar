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
});
