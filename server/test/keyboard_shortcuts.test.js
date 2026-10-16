'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('assert');
const { parseShortcutAction, getShortcutHelpList } = require('../../public/js/shortcuts.js');

// Issue #20 shortcut set, bound behind Alt by the #126 maintainer decision (design guide:
// "plain keys never trigger it").
const ALT_BINDINGS = {
  m: 'NAV_MONTH', 1: 'NAV_MONTH',
  w: 'NAV_WEEK', 2: 'NAV_WEEK',
  d: 'NAV_DAY', 3: 'NAV_DAY',
  a: 'NAV_AGENDA', 4: 'NAV_AGENDA',
  k: 'NAV_KANBAN', 5: 'NAV_KANBAN',
  t: 'NAV_TODAY',
  j: 'NAV_NEXT',
  p: 'NAV_PREV',
  n: 'CREATE_EVENT', c: 'CREATE_EVENT',
  s: 'FOCUS_SEARCH', '/': 'FOCUS_SEARCH',
  h: 'TOGGLE_HELP', '?': 'TOGGLE_HELP',
};

test('Keyboard Shortcuts Engine & Navigation Suite (Issues #20, #126)', async (t) => {
  await t.test('Alt+letter / Alt+digit triggers the bound action on <body>', () => {
    for (const [key, action] of Object.entries(ALT_BINDINGS)) {
      assert.strictEqual(parseShortcutAction({ key, altKey: true, targetTagName: 'BODY' }), action, `Alt+${key}`);
    }
  });

  await t.test('Alt shortcuts use the physical key, so layouts where Alt changes e.key still work', () => {
    // macOS: Option+N is a dead key, Option+T yields '†'
    assert.strictEqual(parseShortcutAction({ key: 'Dead', code: 'KeyN', altKey: true, targetTagName: 'BODY' }), 'CREATE_EVENT');
    assert.strictEqual(parseShortcutAction({ key: '†', code: 'KeyT', altKey: true, targetTagName: 'BODY' }), 'NAV_TODAY');
    assert.strictEqual(parseShortcutAction({ key: '¡', code: 'Digit1', altKey: true, targetTagName: 'BODY' }), 'NAV_MONTH');
    // Shift does not turn Alt+N into something else
    assert.strictEqual(parseShortcutAction({ key: 'N', code: 'KeyN', altKey: true, shiftKey: true, targetTagName: 'BODY' }), 'CREATE_EVENT');
  });

  await t.test('A plain letter or digit never triggers anything, whatever has focus', () => {
    for (const key of Object.keys(ALT_BINDINGS)) {
      for (const targetTagName of ['BODY', 'DIV', 'BUTTON', 'A', 'INPUT']) {
        assert.strictEqual(parseShortcutAction({ key, targetTagName }), null, `plain ${key} on ${targetTagName}`);
      }
    }
  });

  await t.test('Ctrl and Meta combinations stay with the browser', () => {
    assert.strictEqual(parseShortcutAction({ key: 'n', ctrlKey: true, altKey: true, targetTagName: 'BODY' }), null);
    assert.strictEqual(parseShortcutAction({ key: 'n', metaKey: true, altKey: true, targetTagName: 'BODY' }), null);
    assert.strictEqual(parseShortcutAction({ key: 'ArrowRight', ctrlKey: true, targetTagName: 'BODY' }), null);
  });

  await t.test('Alt shortcuts work while a button or link has focus', () => {
    assert.strictEqual(parseShortcutAction({ key: 'n', altKey: true, targetTagName: 'BUTTON', isTargetInteractive: true }), 'CREATE_EVENT');
    assert.strictEqual(parseShortcutAction({ key: 't', altKey: true, targetTagName: 'A', isTargetInteractive: true }), 'NAV_TODAY');
  });

  await t.test('Alt shortcuts are not taken from an editable field (Option types characters on macOS)', () => {
    for (const targetTagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      assert.strictEqual(parseShortcutAction({ key: 'n', altKey: true, targetTagName }), null, targetTagName);
    }
    assert.strictEqual(parseShortcutAction({ key: 'n', altKey: true, targetTagName: 'DIV', isTargetEditable: true }), null);
  });

  await t.test('Arrow keys navigate only when no interactive element has focus', () => {
    assert.strictEqual(parseShortcutAction({ key: 'ArrowRight', targetTagName: 'BODY' }), 'NAV_NEXT');
    assert.strictEqual(parseShortcutAction({ key: 'ArrowLeft', targetTagName: 'BODY' }), 'NAV_PREV');
    for (const targetTagName of ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY']) {
      assert.strictEqual(parseShortcutAction({ key: 'ArrowRight', targetTagName }), null, targetTagName);
      assert.strictEqual(parseShortcutAction({ key: 'ArrowLeft', targetTagName }), null, targetTagName);
    }
    assert.strictEqual(parseShortcutAction({ key: 'ArrowRight', targetTagName: 'DIV', targetRole: 'button' }), null);
    assert.strictEqual(parseShortcutAction({ key: 'ArrowRight', targetTagName: 'SPAN', targetRole: 'link' }), null);
    assert.strictEqual(parseShortcutAction({ key: 'ArrowRight', targetTagName: 'DIV', isTargetEditable: true }), null);
    assert.strictEqual(parseShortcutAction({ key: 'ArrowRight', targetTagName: 'DIV', isTargetInteractive: true }), null);
  });

  await t.test('An open dialog or popover suppresses navigation, Escape still closes it', () => {
    assert.strictEqual(parseShortcutAction({ key: 'n', altKey: true, targetTagName: 'BODY' }, true), null);
    assert.strictEqual(parseShortcutAction({ key: 'ArrowRight', targetTagName: 'BODY' }, true), null);
    assert.strictEqual(parseShortcutAction({ key: 'Escape', targetTagName: 'BODY' }, true), 'CLOSE_MODAL');
    assert.strictEqual(parseShortcutAction({ key: 'Escape', targetTagName: 'INPUT' }), 'CLOSE_MODAL');
    assert.strictEqual(parseShortcutAction({ key: 'Escape', targetTagName: 'BUTTON' }), 'CLOSE_MODAL');
  });

  await t.test('Shortcut help lists the Alt bindings', () => {
    const list = getShortcutHelpList();
    assert.ok(list.some(item => item.key === 'Alt+N / Alt+C' && item.desc.includes('Termin')));
    assert.ok(list.some(item => item.key === 'Alt+M / Alt+1' && item.desc.includes('Monatsansicht')));
    for (const item of list) {
      if (item.key === 'Esc' || item.key === '← / →') continue;
      assert.match(item.key, /^Alt[+ ]/, `help entry "${item.key}" must name the Alt modifier`);
    }
  });
});
