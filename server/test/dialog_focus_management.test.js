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
    return prevented;
  }

  return { document, window, createMockElement, dispatchDocumentKeydown, getActiveElement: () => activeElement };
}

describe('Issue #87 — Dialog Focus Management & Tab/Escape Controls', () => {
  it('getFocusableElements excludes hidden, disabled, type="hidden", and tabindex="-1" controls', () => {
    const { document, window, createMockElement } = createMockDomEnvironment();
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

    const modal = createMockElement('div', 'test-modal', 'modal');
    const input1 = createMockElement('input', 'input1');
    const hiddenInput = createMockElement('input', 'input-hidden');
    hiddenInput.setAttribute('type', 'hidden');

    const disabledBtn = createMockElement('button', 'btn-disabled');
    disabledBtn.setAttribute('disabled', 'disabled');

    const tabIndexNeg = createMockElement('button', 'btn-neg-tab');
    tabIndexNeg.setAttribute('tabindex', '-1');

    const hiddenGroup = createMockElement('div', 'hidden-group', 'form-group hidden');
    const inputInsideHiddenGroup = createMockElement('input', 'input-in-hidden-group');
    hiddenGroup.appendChild(inputInsideHiddenGroup);

    const visibleBtn = createMockElement('button', 'btn-visible');

    modal.appendChild(input1);
    modal.appendChild(hiddenInput);
    modal.appendChild(disabledBtn);
    modal.appendChild(tabIndexNeg);
    modal.appendChild(hiddenGroup);
    modal.appendChild(visibleBtn);

    document.body.appendChild(modal);

    const focusables = context.getFocusableElements(modal);
    assert.strictEqual(focusables.length, 2, 'Should only include input1 and btn-visible');
    assert.strictEqual(focusables[0].id, 'input1');
    assert.strictEqual(focusables[1].id, 'btn-visible');
  });

  it('openDialog focuses first focusable element and restores focus on closeDialog', () => {
    const { document, window, createMockElement, getActiveElement } = createMockDomEnvironment();
    const dialogFocusPath = path.resolve(__dirname, '../../public/js/dialogFocus.js');
    let code = fs.readFileSync(dialogFocusPath, 'utf8');
    code = code.replace(/^\s*export\s+/gm, '');

    const context = { console, document, window, Array, Set, exports: {}, module: { exports: {} } };
    vm.createContext(context);
    vm.runInContext(code, context);

    const triggerBtn = createMockElement('button', 'trigger-btn');
    document.body.appendChild(triggerBtn);
    triggerBtn.focus();
    assert.strictEqual(getActiveElement().id, 'trigger-btn');

    const modalBackdrop = createMockElement('div', 'modal-backdrop-1', 'modal-backdrop hidden');
    const modalContent = createMockElement('div', 'modal-1', 'modal');
    const inputTitle = createMockElement('input', 'modal-input-title');
    const cancelBtn = createMockElement('button', 'modal-cancel-btn');
    modalContent.appendChild(inputTitle);
    modalContent.appendChild(cancelBtn);
    modalBackdrop.appendChild(modalContent);
    document.body.appendChild(modalBackdrop);

    context.openDialog(modalBackdrop);
    assert.strictEqual(modalBackdrop.classList.contains('hidden'), false);
    assert.strictEqual(getActiveElement().id, 'modal-input-title');

    context.closeDialog(modalBackdrop);
    assert.strictEqual(modalBackdrop.classList.contains('hidden'), true);
    assert.strictEqual(getActiveElement().id, 'trigger-btn');
  });

  it('handleTabKey traps focus inside active modal dialog', () => {
    const { document, window, createMockElement, dispatchDocumentKeydown, getActiveElement } = createMockDomEnvironment();
    const dialogFocusPath = path.resolve(__dirname, '../../public/js/dialogFocus.js');
    let code = fs.readFileSync(dialogFocusPath, 'utf8');
    code = code.replace(/^\s*export\s+/gm, '');

    const context = { console, document, window, Array, Set, exports: {}, module: { exports: {} } };
    vm.createContext(context);
    vm.runInContext(code, context);

    const modalBackdrop = createMockElement('div', 'modal-backdrop-tab', 'modal-backdrop hidden');
    const firstInput = createMockElement('input', 'first-input');
    const lastBtn = createMockElement('button', 'last-btn');
    modalBackdrop.appendChild(firstInput);
    modalBackdrop.appendChild(lastBtn);
    document.body.appendChild(modalBackdrop);

    context.openDialog(modalBackdrop);
    assert.strictEqual(getActiveElement().id, 'first-input');

    // Focus last element and press Tab -> should wrap to first element
    lastBtn.focus();
    assert.strictEqual(getActiveElement().id, 'last-btn');
    context.handleTabKey({ key: 'Tab', shiftKey: false, preventDefault: () => {} });
    assert.strictEqual(getActiveElement().id, 'first-input');

    // Focus first element and press Shift+Tab -> should wrap to last element
    firstInput.focus();
    context.handleTabKey({ key: 'Tab', shiftKey: true, preventDefault: () => {} });
    assert.strictEqual(getActiveElement().id, 'last-btn');
  });

  it('handleEscapeKey closes all 7+ modal types on Escape', () => {
    const { document, window, createMockElement, getActiveElement } = createMockDomEnvironment();
    const dialogFocusPath = path.resolve(__dirname, '../../public/js/dialogFocus.js');
    let code = fs.readFileSync(dialogFocusPath, 'utf8');
    code = code.replace(/^\s*export\s+/gm, '');

    const context = { console, document, window, Array, Set, exports: {}, module: { exports: {} } };
    vm.createContext(context);
    vm.runInContext(code, context);

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
      const className = spec.isDrawer ? 'sidebar-settings-drawer' : 'modal-backdrop hidden';
      const container = createMockElement('div', spec.id, className);
      if (spec.isDrawer) container.setAttribute('inert', '');

      // Assert that on page load before openDialog, closed settings-drawer is NOT reported as top dialog
      if (spec.isDrawer) {
        assert.strictEqual(context.getTopDialog(), null, 'Closed drawer with real class must not be reported as top dialog on load');
      }

      // Close button with its specific ID (no generic modal-close class) to ensure selector teeth
      const closeBtn = createMockElement('button', spec.closeBtnId);
      let closeBtnClicked = false;
      closeBtn.onclick = () => {
        closeBtnClicked = true;
        context.closeDialog(container);
      };
      container.appendChild(closeBtn);
      document.body.appendChild(container);

      context.openDialog(container);
      assert.strictEqual(context.getTopDialog()?.element?.id, spec.id, `${spec.id} must be top dialog when open`);

      const handled = context.handleEscapeKey({ key: 'Escape' });
      assert.strictEqual(handled, true, `Escape should handle closing ${spec.id}`);
      assert.strictEqual(closeBtnClicked, true, `Escape must click specific button #${spec.closeBtnId} for ${spec.id}`);
      assert.strictEqual(context.getTopDialog(), null, `${spec.id} must be closed after Escape`);
    });
  });
});
