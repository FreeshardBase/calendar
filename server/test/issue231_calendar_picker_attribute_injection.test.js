'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const eventModalJsPath = path.resolve('public/js/eventModal.js');
const tasksJsPath = path.resolve('public/js/tasks.js');

test('Issue #231 — Calendar Picker Option Attribute-Injection Prevention (eventModal.js & tasks.js)', async (t) => {
  const eventModalJs = fs.readFileSync(eventModalJsPath, 'utf8');
  const tasksJs = fs.readFileSync(tasksJsPath, 'utf8');

  await t.test('eventModal.js populates calendar select safely using DOM Option elements or escaped attributes', () => {
    assert.ok(
      eventModalJs.includes('createElement(\'option\')') || eventModalJs.includes('createElement("option")'),
      'eventModal.js populateCalendarSelect must construct option elements safely via DOM createElement(\'option\')'
    );
  });

  await t.test('tasks.js populates calendar select safely using DOM Option elements', () => {
    assert.ok(
      tasksJs.includes('createElement(\'option\')') || tasksJs.includes('createElement("option")'),
      'tasks.js openTaskModal must construct option elements safely via DOM createElement(\'option\')'
    );
  });

  await t.test('eventModal.js escHtml escapes single quotes (&#39;)', () => {
    assert.ok(
      eventModalJs.includes('.replace(/\'/g, \'&#39;\')') ||
      eventModalJs.includes(".replace(/'/g, '&#39;')") ||
      eventModalJs.includes(".replace(/'/g,'&#39;')"),
      'eventModal.js escHtml must escape single quotes'
    );
  });

  await t.test('tasks.js escapeHtml escapes single quotes (&#39;)', () => {
    assert.ok(
      tasksJs.includes('.replace(/\'/g, \'&#39;\')') ||
      tasksJs.includes(".replace(/'/g, '&#39;')") ||
      tasksJs.includes(".replace(/'/g, '&#39;')"),
      'tasks.js escapeHtml must escape single quotes'
    );
  });
});
