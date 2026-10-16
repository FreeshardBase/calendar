'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatPushPayload } = require('../utils/webPushNotifications');

test('Issue #166 — Reminder body uses de-DE 24-hour clock locale', async (t) => {
  await t.test('formatPushPayload formats reminder start time using 24-hour German locale', () => {
    const alarm = {
      eventId: 'evt-24h-1',
      title: 'Nachmittags-Meeting',
      start: '2026-08-25T14:30:00.000Z',
      alarmTime: Date.parse('2026-08-25T14:15:00.000Z')
    };

    const payload = formatPushPayload(alarm);
    const expectedTime = new Date('2026-08-25T14:30:00.000Z').toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit'
    });

    assert.ok(payload.body.includes(expectedTime), `Expected payload body "${payload.body}" to include formatted 24h time "${expectedTime}"`);
    assert.ok(!payload.body.includes('PM') && !payload.body.includes('AM'), 'Payload body must not contain 12-hour AM/PM designations');
  });
  // The browser reminder's clock (public/js/notifications.js) is driven in e2e/calendar.spec.js,
  // "Issue #166 — a reminder names the start time on the 24-hour clock".
});
