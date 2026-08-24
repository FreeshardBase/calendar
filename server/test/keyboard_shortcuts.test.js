'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('assert');
const { parseShortcutAction, getShortcutHelpList } = require('../../public/js/shortcuts.js');

test('Keyboard Shortcuts Engine & Navigation Suite (Issue #20)', async (t) => {
  await t.test('View switching shortcuts (m, w, d, a, k, 1-5)', () => {
    assert.strictEqual(parseShortcutAction({ key: 'm', targetTagName: 'BODY' }), 'NAV_MONTH');
    assert.strictEqual(parseShortcutAction({ key: '1', targetTagName: 'DIV' }), 'NAV_MONTH');

    assert.strictEqual(parseShortcutAction({ key: 'w', targetTagName: 'BODY' }), 'NAV_WEEK');
    assert.strictEqual(parseShortcutAction({ key: '2', targetTagName: 'BODY' }), 'NAV_WEEK');

    assert.strictEqual(parseShortcutAction({ key: 'd', targetTagName: 'BODY' }), 'NAV_DAY');
    assert.strictEqual(parseShortcutAction({ key: '3', targetTagName: 'BODY' }), 'NAV_DAY');

    assert.strictEqual(parseShortcutAction({ key: 'a', targetTagName: 'BODY' }), 'NAV_AGENDA');
    assert.strictEqual(parseShortcutAction({ key: '4', targetTagName: 'BODY' }), 'NAV_AGENDA');

    assert.strictEqual(parseShortcutAction({ key: 'k', targetTagName: 'BODY' }), 'NAV_KANBAN');
    assert.strictEqual(parseShortcutAction({ key: '5', targetTagName: 'BODY' }), 'NAV_KANBAN');
  });

  await t.test('Navigation shortcuts (t, j, p, ArrowRight, ArrowLeft)', () => {
    assert.strictEqual(parseShortcutAction({ key: 't', targetTagName: 'BODY' }), 'NAV_TODAY');
    assert.strictEqual(parseShortcutAction({ key: 'j', targetTagName: 'BODY' }), 'NAV_NEXT');
    assert.strictEqual(parseShortcutAction({ key: 'ArrowRight', targetTagName: 'BODY' }), 'NAV_NEXT');
    assert.strictEqual(parseShortcutAction({ key: 'p', targetTagName: 'BODY' }), 'NAV_PREV');
    assert.strictEqual(parseShortcutAction({ key: 'ArrowLeft', targetTagName: 'BODY' }), 'NAV_PREV');
  });

  await t.test('Action shortcuts (n, c, /, s, ?, h, Escape)', () => {
    assert.strictEqual(parseShortcutAction({ key: 'n', targetTagName: 'BODY' }), 'CREATE_EVENT');
    assert.strictEqual(parseShortcutAction({ key: 'c', targetTagName: 'BODY' }), 'CREATE_EVENT');
    assert.strictEqual(parseShortcutAction({ key: '/', targetTagName: 'BODY' }), 'FOCUS_SEARCH');
    assert.strictEqual(parseShortcutAction({ key: 's', targetTagName: 'BODY' }), 'FOCUS_SEARCH');
    assert.strictEqual(parseShortcutAction({ key: '?', targetTagName: 'BODY' }), 'TOGGLE_HELP');
    assert.strictEqual(parseShortcutAction({ key: 'h', targetTagName: 'BODY' }), 'TOGGLE_HELP');
    assert.strictEqual(parseShortcutAction({ key: 'Escape', targetTagName: 'BODY' }), 'CLOSE_MODAL');
  });

  await t.test('Input field protection (Issue #126: input/select/textarea/button/contenteditable focus protection)', () => {
    // Plain-letter shortcuts must return null when focused in input, textarea, select, button, or contenteditable
    const interactiveTargets = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'];
    for (const targetTagName of interactiveTargets) {
      assert.strictEqual(parseShortcutAction({ key: 'm', targetTagName }), null);
      assert.strictEqual(parseShortcutAction({ key: 'n', targetTagName }), null);
      assert.strictEqual(parseShortcutAction({ key: 't', targetTagName }), null);
      assert.strictEqual(parseShortcutAction({ key: 'j', targetTagName }), null);
      assert.strictEqual(parseShortcutAction({ key: 's', targetTagName }), null);
    }

    assert.strictEqual(parseShortcutAction({ key: 'm', isTargetEditable: true }), null);
    assert.strictEqual(parseShortcutAction({ key: 'm', isTargetButton: true }), null);

    // Escape should still return CLOSE_MODAL even when focused on an input/button
    assert.strictEqual(parseShortcutAction({ key: 'Escape', targetTagName: 'INPUT' }), 'CLOSE_MODAL');
    assert.strictEqual(parseShortcutAction({ key: 'Escape', targetTagName: 'BUTTON' }), 'CLOSE_MODAL');
  });

  await t.test('Modifier keys protection (Ctrl, Alt, Meta)', () => {
    assert.strictEqual(parseShortcutAction({ key: 'm', ctrlKey: true }), null);
    assert.strictEqual(parseShortcutAction({ key: 'w', altKey: true }), null);
    assert.strictEqual(parseShortcutAction({ key: 'n', metaKey: true }), null);
  });

  await t.test('Modal active protection', () => {
    // When modal is open, navigation shortcuts are suppressed
    assert.strictEqual(parseShortcutAction({ key: 'm', targetTagName: 'BODY' }, true), null);
    assert.strictEqual(parseShortcutAction({ key: 'n', targetTagName: 'BODY' }, true), null);
    // Escape still closes modal
    assert.strictEqual(parseShortcutAction({ key: 'Escape', targetTagName: 'BODY' }, true), 'CLOSE_MODAL');
  });

  await t.test('Shortcut help dictionary', () => {
    const list = getShortcutHelpList();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 8);
    const hasMonth = list.some(item => item.key === 'm / 1' && item.desc.includes('Monatsansicht'));
    assert.ok(hasMonth, 'Help list must include Monatsansicht shortcut');
  });
});
