'use strict';

// Issue #96: the server-side alarm evaluation catches up on missed alarms. The browser half
// (no permission prompt on boot, the 24-hour catch-up window, no repeat after a reload, the
// settings and event-dialog permission requests, the service worker's push and click handlers)
// is covered in e2e/calendar.spec.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateUpcomingAlarms
} = require('../utils/webPushNotifications');

test('evaluateUpcomingAlarms catches an alarm missed by more than 5 minutes within its window', () => {
  const now = new Date('2026-08-25T10:00:00.000Z');
  // Alarm scheduled at 09:30:00 (30 minutes ago)
  const events = [
    {
      id: 'event-missed-1',
      title: 'Overdue Meeting',
      start: '2026-08-25T09:45:00.000Z',
      alarms: [{ trigger: '-PT15M', action: 'DISPLAY' }]
    }
  ];

  const triggered = evaluateUpcomingAlarms(events, { now, windowMinutes: 15 });
  assert.equal(triggered.length, 1, 'evaluateUpcomingAlarms should capture missed alarm 30m ago');
  assert.equal(triggered[0].eventId, 'event-missed-1');
});
