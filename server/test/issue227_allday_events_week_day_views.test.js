'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const calendarJsPath = path.resolve(__dirname, '../../public/js/calendar.js');

test('Issue #227 — All-day events in week, workweek, and day views', async (t) => {
  const calendarJs = fs.readFileSync(calendarJsPath, 'utf8');

  await t.test('calendar.js renders all-day events in week view header cells', () => {
    assert.ok(
      /renderWeek[\s\S]*?eventsForDay[\s\S]*?allDay/.test(calendarJs),
      'renderWeek must query all-day events for each day in week view'
    );
    assert.ok(
      calendarJs.includes('all-day-events') || (calendarJs.includes('chipHtml') && calendarJs.includes('week-day-header')),
      'renderWeek must render all-day event chips inside week-day-header'
    );
  });

  await t.test('calendar.js renders all-day events in day view header cells', () => {
    assert.ok(
      /renderDay[\s\S]*?eventsForDay[\s\S]*?allDay/.test(calendarJs),
      'renderDay must query all-day events for the current date in day view'
    );
  });

  await t.test('calendar.js delegates click and keydown for all-day chips in week and day views', () => {
    const weekNavSection = calendarJs.slice(calendarJs.indexOf('function renderWeek'), calendarJs.indexOf('function renderDay'));
    const dayNavSection  = calendarJs.slice(calendarJs.indexOf('function renderDay'), calendarJs.indexOf('function createTimeCol'));

    assert.ok(
      weekNavSection.includes('onEventClick') && (weekNavSection.includes('data-event-uid') || weekNavSection.includes('dataset.eventUid')),
      'renderWeek must handle event chip clicks via onEventClick'
    );

    assert.ok(
      dayNavSection.includes('onEventClick') && (dayNavSection.includes('data-event-uid') || dayNavSection.includes('dataset.eventUid')),
      'renderDay must handle event chip clicks via onEventClick'
    );
  });

  await t.test('createTimeCol excludes all-day events from timed hour grid blocks', () => {
    assert.ok(
      /createTimeCol[\s\S]*?eventsForDay[\s\S]*?!\s*e\.allDay/.test(calendarJs),
      'createTimeCol must filter out all-day events so they do not render in the timed hour grid'
    );
  });
});
