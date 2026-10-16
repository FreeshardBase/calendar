'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('assert');
const { parseShortcutAction } = require('../../public/js/shortcuts.js');

test('Issue #126 — no plain-key shortcut fires on a focused button, link or contenteditable', async (t) => {
  const keys = ['m', 'w', 'd', 'a', 'k', 't', 'j', 'p', 'n', 'c', 's', 'h', '/', '?', '1', '2', '3', '4', '5', 'ArrowLeft', 'ArrowRight'];
  const targets = [
    { targetTagName: 'BUTTON', isTargetInteractive: true },
    { targetTagName: 'DIV', targetRole: 'button', isTargetInteractive: true },
    { targetTagName: 'SUMMARY', isTargetInteractive: true },
    { targetTagName: 'A', isTargetInteractive: true },
    { targetTagName: 'DIV', isTargetEditable: true, isTargetInteractive: true },
  ];

  await t.test('every bound key is suppressed without Alt', () => {
    for (const key of keys) {
      for (const target of targets) {
        assert.strictEqual(parseShortcutAction({ key, ...target }), null, `${key} on ${JSON.stringify(target)}`);
      }
    }
  });

  await t.test('Escape still closes', () => {
    for (const target of targets) {
      assert.strictEqual(parseShortcutAction({ key: 'Escape', ...target }), 'CLOSE_MODAL');
    }
  });
});
