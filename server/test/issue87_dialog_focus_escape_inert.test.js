'use strict';
process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createMockDomEnvironment() {
  let activeElement = null;
  const elements = new Map();
  const eventListeners = new Map();

  function createMockElement(tagName, id = '', className = '') {
    const el = {
      tagName: tagName.toUpperCase(),
      id,
      className,
      style: {},
      attributes: new Map(),
      dataset: {},
      children: [],
      parentNode: null,
      offsetWidth: 100,
      offsetHeight: 30,
      getClientRects: () => [{ width: 100, height: 30 }],
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
      setAttribute: (k, v) => el.attributes.set(k, String(v)),
      getAttribute: (k) => el.attributes.get(k) || null,
      removeAttribute: (k) => el.attributes.delete(k),
      hasAttribute: (k) => el.attributes.has(k),
      focus: () => {
        activeElement = el;
      },
      click: () => {
        if (el.onclick) el.onclick();
        const listeners = eventListeners.get(el) || [];
        listeners.filter(l => l.type === 'click').forEach(l => l.handler({ target: el, currentTarget: el, preventDefault: () => {} }));
      },
      appendChild: (child) => {
        child.parentNode = el;
        el.children.push(child);
        if (child.id) elements.set(child.id, child);
        return child;
      },
      contains: (other) => {
        let cur = other;
        while (cur) {
          if (cur === el) return true;
          cur = cur.parentNode;
        }
        return false;
      },
      querySelector: (selector) => {
        return querySelectorAll(el, selector)[0] || null;
      },
      querySelectorAll: (selector) => {
        return querySelectorAll(el, selector);
      },
      closest: (selector) => {
        let cur = el;
        while (cur) {
          if (selector.startsWith('.') && cur.classList && cur.classList.contains(selector.slice(1))) {
            return cur;
          }
          if (selector.startsWith('#') && cur.id === selector.slice(1)) {
            return cur;
          }
          if (selector.startsWith('[') && selector.endsWith(']')) {
            const attr = selector.slice(1, -1);
            if (cur.hasAttribute && cur.hasAttribute(attr)) return cur;
          }
          cur = cur.parentNode;
        }
        return null;
      }
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
    const parts = selector.split(',').map(s => s.trim());
    return parts.some(part => {
      if (part.includes(':not(')) {
        const base = part.slice(0, part.indexOf(':not('));
        const notParts = part.match(/:not\(([^)]+)\)/g) || [];
        if (base && !matchesSingleSelector(el, base)) return false;
        for (const notP of notParts) {
          const negSelector = notP.slice(5, -1);
          if (matchesSingleSelector(el, negSelector)) return false;
        }
        return true;
      }
      return matchesSingleSelector(el, part);
    });
  }

  function matchesSingleSelector(el, sel) {
    if (sel.startsWith('#')) return el.id === sel.slice(1);
    if (sel.startsWith('.')) return el.classList && el.classList.contains(sel.slice(1));
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const attr = sel.slice(1, -1);
      if (attr.includes('=')) {
        const [k, v] = attr.split('=').map(s => s.replace(/["']/g, ''));
        return el.getAttribute(k) === v;
      }
      return el.hasAttribute(attr);
    }
    if (/^[A-Za-z0-9_-]+$/.test(sel)) return el.tagName === sel.toUpperCase();
    return false;
  }

  const documentBody = createMockElement('body', 'body');

  const document = {
    body: documentBody,
    get activeElement() { return activeElement; },
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => createMockElement(tag),
    addEventListener: (type, handler) => {
      const list = eventListeners.get(document) || [];
      list.push({ type, handler });
      eventListeners.set(document, list);
    },
    removeEventListener: (type, handler) => {
      const list = eventListeners.get(document) || [];
      eventListeners.set(document, list.filter(l => l.handler !== handler));
    },
    querySelectorAll: (selector) => querySelectorAll(documentBody, selector)
  };

  const window = {
    document,
    getComputedStyle: (el) => ({
      visibility: el.style?.visibility || 'visible',
      display: el.style?.display || 'block'
    }),
    addEventListener: (type, handler) => {
      const list = eventListeners.get(window) || [];
      list.push({ type, handler });
      eventListeners.set(window, list);
    }
  };

  function dispatchDocumentKeydown(key, options = {}) {
    const listeners = eventListeners.get(document) || [];
    let prevented = false;
    const evt = {
      key,
      shiftKey: !!options.shiftKey,
      target: activeElement,
      preventDefault: () => { prevented = true; }
    };
    listeners.filter(l => l.type === 'keydown').forEach(l => l.handler(evt));
    return { prevented, evt };
  }

  return { document, window, createMockElement, dispatchDocumentKeydown, getActiveElement: () => activeElement };
}

function loadDialogFocusModule(customEnv) {
  const { document, window } = customEnv;
  const dialogFocusPath = path.resolve(__dirname, '../../public/js/dialogFocus.js');
  let code = fs.readFileSync(dialogFocusPath, 'utf8');
  code = code.replace(/^\s*export\s+/gm, '');

  const context = {
    console,
    document,
    window,
    Array,
    Set,
    exports: {},
    module: { exports: {} }
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

describe('Issue #87 — Detailed Audit Reproduction Suite (@ClaydeCode)', () => {
  it('1. HTML markup: #invitations-modal, #availability-modal, #shortcuts-modal, and #settings-drawer have role="dialog", aria-modal="true", and aria-labelledby', () => {
    const htmlPath = path.resolve(__dirname, '../../public/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    // 1. Invitations modal
    const invMatch = html.match(/id="invitations-modal"[^>]*>/);
    assert.ok(invMatch, 'invitations-modal must exist');
    assert.ok(invMatch[0].includes('role="dialog"'), 'invitations-modal must have role="dialog"');
    assert.ok(invMatch[0].includes('aria-modal="true"'), 'invitations-modal must have aria-modal="true"');
    assert.ok(invMatch[0].includes('aria-labelledby="invitations-modal-title"'), 'invitations-modal must have aria-labelledby');
    assert.ok(html.includes('id="invitations-modal-title"'), 'invitations-modal-title element must exist');

    // 2. Availability modal
    const availMatch = html.match(/id="availability-modal"[^>]*>/);
    assert.ok(availMatch, 'availability-modal must exist');
    assert.ok(availMatch[0].includes('role="dialog"'), 'availability-modal must have role="dialog"');
    assert.ok(availMatch[0].includes('aria-modal="true"'), 'availability-modal must have aria-modal="true"');
    assert.ok(availMatch[0].includes('aria-labelledby="availability-modal-title"'), 'availability-modal must have aria-labelledby');
    assert.ok(html.includes('id="availability-modal-title"'), 'availability-modal-title element must exist');

    // 3. Shortcuts modal
    const shortMatch = html.match(/id="shortcuts-modal"[^>]*>/);
    assert.ok(shortMatch, 'shortcuts-modal must exist');
    assert.ok(shortMatch[0].includes('role="dialog"'), 'shortcuts-modal must have role="dialog"');
    assert.ok(shortMatch[0].includes('aria-modal="true"'), 'shortcuts-modal must have aria-modal="true"');
    assert.ok(shortMatch[0].includes('aria-labelledby="shortcuts-modal-title"'), 'shortcuts-modal must have aria-labelledby');
    assert.ok(html.includes('id="shortcuts-modal-title"'), 'shortcuts-modal-title element must exist');

    // 4. Settings drawer
    const settingsMatch = html.match(/id="settings-drawer"[^>]*>/);
    assert.ok(settingsMatch, 'settings-drawer must exist');
    assert.ok(settingsMatch[0].includes('role="dialog"'), 'settings-drawer must have role="dialog"');
    assert.ok(settingsMatch[0].includes('aria-modal="true"'), 'settings-drawer must have aria-modal="true"');
    assert.ok(settingsMatch[0].includes('aria-labelledby="settings-drawer-title"'), 'settings-drawer must have aria-labelledby');
    assert.ok(html.includes('id="settings-drawer-title"'), 'settings-drawer-title element must exist');
  });

  it('2. Transform-hidden containers: CSS has visibility rules and HTML/JS frontend uses inert', () => {
    const cssPath = path.resolve(__dirname, '../../public/css/app.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    // CSS visibility assertions
    assert.ok(css.includes('.sidebar-settings-drawer') && css.includes('visibility: hidden'), 'sidebar-settings-drawer must have visibility: hidden when closed');
    assert.ok(css.includes('.sidebar-settings-drawer.open') && css.includes('visibility: visible'), 'sidebar-settings-drawer.open must have visibility: visible');
    assert.ok(css.includes('.sidebar') && css.includes('transform: translateX(-100%)'), 'sidebar must have transform: translateX(-100%)');

    // HTML inert assertion
    const htmlPath = path.resolve(__dirname, '../../public/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const settingsMatch = html.match(/id="settings-drawer"[^>]*>/);
    assert.ok(settingsMatch, 'settings-drawer must exist in HTML');
    assert.ok(settingsMatch[0].includes('inert'), 'settings-drawer must have inert attribute when closed in HTML');

    // getFocusableElements must exclude elements inside inert containers
    const env = createMockDomEnvironment();
    const mod = loadDialogFocusModule(env);

    const drawer = env.createMockElement('div', 'settings-drawer', 'sidebar-settings-drawer');
    drawer.setAttribute('inert', '');
    const deleteCalBtn = env.createMockElement('button', 'delete-cal-btn');
    drawer.appendChild(deleteCalBtn);
    env.document.body.appendChild(drawer);

    const focusables = mod.getFocusableElements(drawer);
    assert.strictEqual(focusables.length, 0, 'Off-screen inert drawer controls must NOT be returned by getFocusableElements');
  });

  it('3. Regression check: Tab and Escape are NOT hijacked on a page with no dialog open (shipped markup without hidden)', () => {
    const env = createMockDomEnvironment();
    const mod = loadDialogFocusModule(env);

    // Build DOM matching shipped markup: settings-drawer has class="sidebar-settings-drawer", inert, NOT hidden
    const settingsDrawer = env.createMockElement('div', 'settings-drawer', 'sidebar-settings-drawer');
    settingsDrawer.setAttribute('inert', '');
    const closeSettingsBtn = env.createMockElement('button', 'close-settings-btn');
    settingsDrawer.appendChild(closeSettingsBtn);
    env.document.body.appendChild(settingsDrawer);

    // Main page controls
    const newEventBtn = env.createMockElement('button', 'new-event-btn');
    const otherBtn = env.createMockElement('button', 'other-btn');
    env.document.body.appendChild(newEventBtn);
    env.document.body.appendChild(otherBtn);

    newEventBtn.focus();
    assert.strictEqual(env.getActiveElement().id, 'new-event-btn');

    // getTopDialog() must return null on page load
    const top = mod.getTopDialog();
    assert.strictEqual(top, null, 'getTopDialog() must be null when no dialog is open');

    // Tab key press must NOT be prevented and must NOT focus into settings-drawer
    let tabPrevented = false;
    const tabHandled = mod.handleTabKey({
      key: 'Tab',
      shiftKey: false,
      preventDefault: () => { tabPrevented = true; }
    });
    assert.strictEqual(tabHandled, false, 'handleTabKey must return false when no dialog is open');
    assert.strictEqual(tabPrevented, false, 'Tab key must not be prevented');
    assert.strictEqual(env.getActiveElement().id, 'new-event-btn', 'Focus must NOT land in off-screen drawer');

    // Escape key press must NOT trigger and must NOT stamp "hidden" onto settings-drawer
    const escHandled = mod.handleEscapeKey({ key: 'Escape' });
    assert.strictEqual(escHandled, false, 'handleEscapeKey must return false when no dialog is open');
    assert.strictEqual(settingsDrawer.classList.contains('hidden'), false, 'Escape must not stamp hidden onto settings-drawer');
  });

  it('4. Regression check: settings drawer opens with .open, removes inert, traps focus, and closes restoring focus and inert', () => {
    const env = createMockDomEnvironment();
    const mod = loadDialogFocusModule(env);

    const triggerBtn = env.createMockElement('button', 'sidebar-settings-btn');
    env.document.body.appendChild(triggerBtn);
    triggerBtn.focus();

    const drawer = env.createMockElement('div', 'settings-drawer', 'sidebar-settings-drawer');
    drawer.setAttribute('inert', '');
    const closeBtn = env.createMockElement('button', 'close-settings-btn');
    const itemBtn = env.createMockElement('button', 'settings-item-btn');
    drawer.appendChild(closeBtn);
    drawer.appendChild(itemBtn);
    env.document.body.appendChild(drawer);

    // Open settings drawer
    mod.openDialog(drawer);
    assert.ok(drawer.classList.contains('open'), 'openDialog must add "open" class to settings drawer');
    assert.strictEqual(drawer.hasAttribute('inert'), false, 'openDialog must remove "inert" from settings drawer');
    assert.strictEqual(env.getActiveElement().id, 'close-settings-btn', 'openDialog must focus first element in drawer');
    assert.strictEqual(mod.getTopDialog()?.element?.id, 'settings-drawer');

    // Tab trap inside open settings drawer
    itemBtn.focus();
    mod.handleTabKey({ key: 'Tab', shiftKey: false, preventDefault: () => {} });
    assert.strictEqual(env.getActiveElement().id, 'close-settings-btn', 'Tab must wrap from last to first in drawer');

    // Close settings drawer
    mod.closeDialog(drawer);
    assert.strictEqual(drawer.classList.contains('open'), false, 'closeDialog must remove "open" class');
    assert.strictEqual(drawer.hasAttribute('inert'), true, 'closeDialog must restore "inert" on settings drawer');
    assert.strictEqual(env.getActiveElement().id, 'sidebar-settings-btn', 'closeDialog must restore focus to trigger button');
    assert.strictEqual(mod.getTopDialog(), null, 'getTopDialog must return null after closing drawer');
  });

  it('5. Escape key closes all dialog types via their specific close/cancel buttons with teeth', () => {
    const env = createMockDomEnvironment();
    const mod = loadDialogFocusModule(env);

    const dialogSpecs = [
      { id: 'event-modal-backdrop', closeBtnId: 'event-modal-close', isDrawer: false },
      { id: 'account-modal-backdrop', closeBtnId: 'account-modal-close', isDrawer: false },
      { id: 'welcome-modal-backdrop', closeBtnId: 'welcome-modal-close', isDrawer: false },
      { id: 'scope-dialog-backdrop', closeBtnId: 'scope-cancel-btn', isDrawer: false },
      { id: 'task-modal-backdrop', closeBtnId: 'task-modal-close', isDrawer: false },
      { id: 'invitations-modal-backdrop', closeBtnId: 'invitations-modal-close', isDrawer: false },
      { id: 'msgraph-modal-backdrop', closeBtnId: 'msgraph-modal-close', isDrawer: false },
      { id: 'availability-modal-backdrop', closeBtnId: 'availability-modal-close', isDrawer: false },
      { id: 'shortcuts-modal-backdrop', closeBtnId: 'shortcuts-modal-close', isDrawer: false },
      { id: 'settings-drawer', closeBtnId: 'close-settings-btn', isDrawer: true },
      { id: 'webcal-modal-backdrop', closeBtnId: 'webcal-modal-close', isDrawer: false },
      { id: 'confirm-dialog-backdrop', closeBtnId: 'confirm-dialog-close', isDrawer: false }
    ];

    dialogSpecs.forEach(spec => {
      const containerClass = spec.isDrawer ? 'sidebar-settings-drawer' : 'modal-backdrop hidden';
      const container = env.createMockElement('div', spec.id, containerClass);
      if (spec.isDrawer) container.setAttribute('inert', '');

      // Crucial for teeth: close button only has its SPECIFIC ID (not a generic modal-close class)
      const closeBtn = env.createMockElement('button', spec.closeBtnId);
      let closeBtnClicked = false;
      closeBtn.onclick = () => {
        closeBtnClicked = true;
        mod.closeDialog(container);
      };
      container.appendChild(closeBtn);
      env.document.body.appendChild(container);

      mod.openDialog(container);
      assert.strictEqual(mod.getTopDialog()?.element?.id, spec.id, `${spec.id} must be top dialog when opened`);

      const handled = mod.handleEscapeKey({ key: 'Escape' });
      assert.strictEqual(handled, true, `Escape should handle ${spec.id}`);
      assert.strictEqual(closeBtnClicked, true, `Escape MUST trigger specific close button #${spec.closeBtnId} for ${spec.id}`);
      assert.strictEqual(mod.getTopDialog(), null, `No dialog should be active after closing ${spec.id}`);
    });
  });
});
