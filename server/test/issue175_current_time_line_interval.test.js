'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const calendarJsPath = path.resolve(__dirname, '../../public/js/calendar.js');

test('Issue #175 — Current Time Line Interval Lifecycle & Dynamic Positioning Suite', async (t) => {
  const calendarJs = fs.readFileSync(calendarJsPath, 'utf8');

  await t.test('public/js/calendar.js clears previous timer before creating new interval in appendCurrentTimeLine', () => {
    assert.ok(
      calendarJs.includes('clearCurrentTimeLineTimer') || /clearInterval\s*\(/.test(calendarJs),
      'calendar.js must clear any existing time-line interval timer'
    );
  });

  await t.test('appendCurrentTimeLine instantiates a new Date() inside the setInterval callback', () => {
    // Check that inside setInterval callback in appendCurrentTimeLine, Date is instantiated dynamically
    const appendFnMatch = calendarJs.match(/function\s+appendCurrentTimeLine[\s\S]*?\n\}/);
    assert.ok(appendFnMatch, 'appendCurrentTimeLine function body must exist');
    const appendFnBody = appendFnMatch[0];

    assert.ok(
      /setInterval\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?(new\s+Date\(\)|Date\.now\(\))[\s\S]*?\}/.test(appendFnBody),
      'setInterval callback inside appendCurrentTimeLine must instantiate new Date() dynamically rather than closing over a static outer Date instance'
    );
  });

  await t.test('renderView cleans up active time-line interval', () => {
    const renderViewMatch = calendarJs.match(/export\s+function\s+renderView[\s\S]*?\n\}/);
    assert.ok(renderViewMatch, 'renderView function body must exist');
    const renderViewBody = renderViewMatch[0];

    assert.ok(
      renderViewBody.includes('clearCurrentTimeLineTimer') || renderViewBody.includes('clearInterval'),
      'renderView must invoke time-line interval cleanup'
    );
  });

  await t.test('functional check: time-line update callback calculates updated top position on new Date', () => {
    let mockIntervalCb = null;
    let clearIntervalCalledWith = null;

    const mockWindow = {
      setInterval: (cb, delay) => {
        mockIntervalCb = cb;
        return 12345;
      },
      clearInterval: (id) => {
        clearIntervalCalledWith = id;
      }
    };

    // Evaluator for calendar.js appendCurrentTimeLine logic
    const evalScope = new Function('window', 'document', 'HOUR_H', 'sameDay', `
      const setInterval = window.setInterval.bind(window);
      const clearInterval = window.clearInterval.bind(window);
      let currentTimeLineTimer = null;
      function clearCurrentTimeLineTimer() {
        if (currentTimeLineTimer) {
          clearInterval(currentTimeLineTimer);
          currentTimeLineTimer = null;
        }
      }
      ${calendarJs.match(/function\s+appendCurrentTimeLine[\s\S]*?\n\}/)[0]}
      return { appendCurrentTimeLine, clearCurrentTimeLineTimer, getTimer: () => currentTimeLineTimer };
    `);

    let appendedElement = null;
    const mockContainer = {
      appendChild: (el) => { appendedElement = el; }
    };
    const mockDocument = {
      createElement: () => ({
        style: {},
        className: '',
        innerHTML: ''
      })
    };

    const days = [new Date()];
    const sameDayFn = () => true;

    const scope = evalScope(mockWindow, mockDocument, 60, sameDayFn);
    scope.appendCurrentTimeLine(mockContainer, days);

    assert.equal(scope.getTimer(), 12345, 'Timer ID should be tracked in currentTimeLineTimer');
    assert.ok(appendedElement, 'Current time line element should be created and appended');
    assert.ok(mockIntervalCb, 'setInterval callback should be registered');

    // Trigger mock interval callback and verify it sets style.top based on current time
    mockIntervalCb();
    assert.ok(appendedElement.style.top.endsWith('px'), 'line.style.top must be updated with px unit');

    // Re-run appendCurrentTimeLine and verify previous timer is cleared
    scope.appendCurrentTimeLine(mockContainer, days);
    assert.equal(clearIntervalCalledWith, 12345, 'Previous timer must be cleared with clearInterval');
  });
});
