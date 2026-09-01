'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('assert');
const { parseShortcutAction } = require('../../public/js/shortcuts.js');

test('Issue #126 — Plain-letter shortcuts suppression on focused buttons', async (t) => {
  await t.test('Suppresses all single-letter & digit navigation shortcuts when button or role="button" is focused', () => {
    const shortcuts = ['m', 'w', 'd', 'a', 'k', 't', 'j', 'p', 'n', 'c', 's', 'h', '/', '?', '1', '2', '3', '4', '5'];
    
    for (const key of shortcuts) {
      // Direct BUTTON element
      assert.strictEqual(
        parseShortcutAction({ key, targetTagName: 'BUTTON', isTargetButton: true }),
        null,
        `Key '${key}' must return null when BUTTON is focused`
      );

      // Element with role="button"
      assert.strictEqual(
        parseShortcutAction({ key, targetTagName: 'DIV', targetRole: 'button', isTargetButton: true }),
        null,
        `Key '${key}' must return null when role="button" is focused`
      );

      // SUMMARY element
      assert.strictEqual(
        parseShortcutAction({ key, targetTagName: 'SUMMARY', isTargetButton: true }),
        null,
        `Key '${key}' must return null when SUMMARY is focused`
      );
    }
  });

  await t.test('Allows Escape key to close modal/dialog even when a button is focused', () => {
    assert.strictEqual(
      parseShortcutAction({ key: 'Escape', targetTagName: 'BUTTON', isTargetButton: true }),
      'CLOSE_MODAL'
    );
    assert.strictEqual(
      parseShortcutAction({ key: 'Escape', targetTagName: 'DIV', targetRole: 'button', isTargetButton: true }),
      'CLOSE_MODAL'
    );
  });
});
