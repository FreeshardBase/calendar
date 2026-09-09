'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const calendarJsPath = path.resolve(__dirname, '../../public/js/calendar.js');

test('Issue #229 — Calendar Container Listener Accumulation Guard', async (t) => {
  const calendarJs = fs.readFileSync(calendarJsPath, 'utf8');

  await t.test('public/js/calendar.js does not attach click/keydown listeners directly to container inside render functions', () => {
    assert.equal(
      /container\.addEventListener\(\s*['"]click['"]/.test(calendarJs),
      false,
      'calendar.js must not call container.addEventListener("click")'
    );
    assert.equal(
      /container\.addEventListener\(\s*['"]keydown['"]/.test(calendarJs),
      false,
      'calendar.js must not call container.addEventListener("keydown")'
    );
  });

  await t.test('renderMonth attaches click and keydown listeners to month view element div', () => {
    const monthFunc = calendarJs.match(/function\s+renderMonth\s*\([^)]*\)\s*\{([\s\S]*?\n\})/);
    assert.ok(monthFunc, 'renderMonth function must exist');
    const monthBody = monthFunc[1];

    assert.ok(
      /div\.addEventListener\(\s*['"]click['"]/.test(monthBody),
      'renderMonth must attach click listener to view element div'
    );
    assert.ok(
      /div\.addEventListener\(\s*['"]keydown['"]/.test(monthBody),
      'renderMonth must attach keydown listener to view element div'
    );
  });

  await t.test('renderAgenda attaches click and keydown listeners to agenda view element div', () => {
    const agendaFunc = calendarJs.match(/function\s+renderAgenda\s*\([^)]*\)\s*\{([\s\S]*?\n\})/);
    assert.ok(agendaFunc, 'renderAgenda function must exist');
    const agendaBody = agendaFunc[1];

    assert.ok(
      /div\.addEventListener\(\s*['"]click['"]/.test(agendaBody),
      'renderAgenda must attach click listener to view element div'
    );
    assert.ok(
      /div\.addEventListener\(\s*['"]keydown['"]/.test(agendaBody),
      'renderAgenda must attach keydown listener to view element div'
    );
  });
});
