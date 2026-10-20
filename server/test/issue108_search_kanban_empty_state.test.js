'use strict';
process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// app.js expects window.SafeUrl (loaded by index.html as a classic script).
const SafeUrl = require('../../public/js/safeUrl');
// #626: app.js takes its strings from the message catalogues through i18n.js.
const { t } = require('./helpers/i18n').loadI18n(rel => fs.readFileSync(path.join(__dirname, '../../public/js', rel), 'utf8'));

function createMockDomEnvironment() {
  const elements = new Map();
  const eventListeners = new Map();

  function parseHtmlChildren(html, parent) {
    const tagRegex = /<([a-z0-9-]+)([^>]*)>|<([\/])([a-z0-9-]+)>/gi;
    const stack = [{ node: parent, tagName: 'ROOT' }];
    let match;
    let lastIndex = 0;

    while ((match = tagRegex.exec(html)) !== null) {
      const text = html.slice(lastIndex, match.index);
      if (text && stack.length > 0) {
        const top = stack[stack.length - 1].node;
        top.textContent += text.replace(/<[^>]+>/g, '');
      }
      lastIndex = tagRegex.lastIndex;

      const isOpen = match[1];
      const isClose = match[3];

      if (isOpen) {
        const tagName = match[1];
        const attrStr = match[2];
        const child = createMockElement(tagName);
        const classMatch = attrStr.match(/class=["']([^"']+)["']/i);
        if (classMatch) child.className = classMatch[1];
        const idMatch = attrStr.match(/id=["']([^"']+)["']/i);
        if (idMatch) {
          child.id = idMatch[1];
          elements.set(idMatch[1], child);
        }
        const dataStatusMatch = attrStr.match(/data-status=["']([^"']+)["']/i);
        if (dataStatusMatch) child.setAttribute('data-status', dataStatusMatch[1]);

        stack[stack.length - 1].node.appendChild(child);
        if (!attrStr.endsWith('/')) {
          stack.push({ node: child, tagName: tagName.toUpperCase() });
        }
      } else if (isClose) {
        const closeTag = match[4].toUpperCase();
        if (stack.length > 1 && stack[stack.length - 1].tagName === closeTag) {
          stack.pop();
        }
      }
    }
    const tailText = html.slice(lastIndex);
    if (tailText && stack.length > 0) {
      stack[stack.length - 1].node.textContent += tailText.replace(/<[^>]+>/g, '');
    }
  }

  function createMockElement(tagName, id = '', className = '') {
    let _innerHTML = '';
    let _textContent = '';
    const el = {
      tagName: tagName.toUpperCase(),
      id,
      className,
      style: {},
      attributes: new Map(),
      children: [],
      parentNode: null,
      value: '',
      get textContent() {
        let text = _textContent || '';
        if (el.children.length > 0) {
          text += ' ' + el.children.map(c => c.textContent).join(' ');
        }
        return text.trim();
      },
      set textContent(val) {
        _textContent = val;
      },
      get innerHTML() {
        if (el.children.length > 0) {
          return el.children.map(c => {
            const attrs = Array.from(c.attributes.entries()).map(([k, v]) => ` ${k}="${v}"`).join('');
            const cls = c.className ? ` class="${c.className}"` : '';
            const idAttr = c.id ? ` id="${c.id}"` : '';
            return `<${c.tagName.toLowerCase()}${idAttr}${cls}${attrs}>${c.innerHTML}</${c.tagName.toLowerCase()}>`;
          }).join('');
        }
        return _innerHTML;
      },
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
      insertBefore: (child, refNode) => {
        child.parentNode = el;
        const idx = refNode ? el.children.indexOf(refNode) : -1;
        if (idx >= 0) {
          el.children.splice(idx, 0, child);
        } else {
          el.children.unshift(child);
        }
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
    if (selector.includes(',')) {
      return selector.split(',').some(sub => matchesSelector(el, sub.trim()));
    }
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

  const window = {
    document,
    SafeUrl,
    alert: () => {},
    showToast: () => {},
    confirm: () => true
  };

  return { document, window, createMockElement, elements };
}

describe('Issue #108 — Search with No Hits & Empty Kanban Board Indicators', () => {
  const tasksJsPath = path.resolve(__dirname, '../../public/js/tasks.js');
  const rawTasksJs = fs.readFileSync(tasksJsPath, 'utf8');
  const cjsTasksJs = rawTasksJs
    .replace(/^import\s+.*?;/gm, '')
    .replace(/^export\s+/gm, '');

  it('renderKanbanBoard displays an explicit empty board notice when there are no tasks and search is inactive', () => {
    const env = createMockDomEnvironment();
    const container = env.document.createElement('div');

    const context = {
      console,
      document: env.document,
      window: env.window,
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      escapeHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      t,
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsTasksJs, context);

    context.renderKanbanBoard(container, [], {}, { searchQuery: '' });

    const emptyNotice = container.querySelector('.kanban-empty-state');
    assert.ok(emptyNotice, 'Kanban container must render a .kanban-empty-state notice when board has 0 tasks');
    assert.ok(
      emptyNotice.innerHTML.includes('Keine Aufgaben') || emptyNotice.textContent.includes('Keine Aufgaben'),
      'Empty state notice must contain informative text "Keine Aufgaben"'
    );

    const columnEmpties = container.querySelectorAll('.kanban-column-empty');
    // One lane per VTODO STATUS (#499): Zu erledigen, In Bearbeitung, Erledigt, Abgebrochen.
    assert.strictEqual(columnEmpties.length, 4, 'Each empty column must display a .kanban-column-empty placeholder');
  });

  it('renderKanbanBoard displays explicit search empty state message with search query when search returns 0 hits', () => {
    const env = createMockDomEnvironment();
    const container = env.document.createElement('div');

    const context = {
      console,
      document: env.document,
      window: env.window,
      String,
      Set,
      Array,
      Date,
      parseInt,
      isNaN,
      escapeHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      t,
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsTasksJs, context);

    context.renderKanbanBoard(container, [], {}, { searchQuery: 'ProjektX' });

    const searchEmpty = container.querySelector('.kanban-empty-state, .search-empty-state');
    assert.ok(searchEmpty, 'Kanban container must render an empty state notice when search has 0 hits');
    assert.ok(
      searchEmpty.innerHTML.includes('ProjektX') || searchEmpty.textContent.includes('ProjektX'),
      'Search empty state must reference the search query "ProjektX"'
    );
    assert.ok(
      searchEmpty.innerHTML.includes('Keine') || searchEmpty.textContent.includes('Keine'),
      'Search empty state must convey zero matches were found'
    );
  });

  it('calendar view renders .search-empty-banner and updates status bar when search has 0 matches', () => {
    const env = createMockDomEnvironment();
    const calendarContainer = env.document.createElement('div');
    calendarContainer.id = 'calendar-container';
    env.document.body.appendChild(calendarContainer);

    const toolbarTitle = env.document.createElement('div');
    toolbarTitle.id = 'toolbar-title';
    env.document.body.appendChild(toolbarTitle);

    const statusEl = env.document.createElement('div');
    statusEl.id = 'status-bar';
    env.document.body.appendChild(statusEl);

    let currentStatus = '';

    const appJsPath = path.resolve(__dirname, '../../public/js/app.js');
    const rawAppJs = fs.readFileSync(appJsPath, 'utf8');
    const cjsAppJs = rawAppJs
      .replace(/^import\s+.*?;/gm, '')
      .replace(/^export\s+/gm, '')
      .replace(/boot\(\)\.catch\(console\.error\);/, '');

    const storeState = {
      view: 'month',
      currentDate: new Date('2026-08-31T00:00:00Z'),
      events: [],
      tasks: [],
      hiddenCalendars: new Set(),
      searchQuery: 'NichtVorhanden'
    };

    const store = {
      get: (k) => storeState[k],
      set: (obj) => Object.assign(storeState, obj)
    };

    const context = {
      console,
      document: env.document,
      window: env.window,
      $: (id) => env.document.getElementById(id),
      store,
      t,
      setStatus: (txt) => { currentStatus = txt; },
      getToolbarTitle: () => 'August 2026',
      renderView: (container) => { container.innerHTML = '<div class="month-view"></div>'; },
      renderKanbanBoard: () => {},
      renderMiniCalendar: () => {},
      getDateRange: () => ({ start: new Date(2026, 7, 1), end: new Date(2026, 8, 30) }),
      checkAndTriggerAlarms: () => {},
      TasksAPI: { list: async () => [] },
      CalendarsAPI: { searchUsers: async () => [] },
      String, Set, Array, Date, parseInt, isNaN,
      exports: {},
      module: { exports: {} }
    };
    vm.createContext(context);
    vm.runInContext(cjsAppJs, context);

    assert.strictEqual(typeof context.renderCalendarView, 'function');
    context.renderCalendarView();

    const banner = calendarContainer.querySelector('.search-empty-banner');
    assert.ok(banner, 'calendar-container must prepend .search-empty-banner when search has 0 matches');
    assert.ok(
      banner.textContent.includes('NichtVorhanden') || banner.innerHTML.includes('NichtVorhanden'),
      'Search empty banner must contain the search query'
    );
    assert.ok(statusEl.textContent.includes('0 Ergebnisse'), 'Status bar must display "0 Ergebnisse" for empty search hits');
  });
});
