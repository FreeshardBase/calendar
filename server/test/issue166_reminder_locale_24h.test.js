'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

  await t.test('server/utils/webPushNotifications.js specifies de-DE locale explicitly', () => {
    const filePath = path.join(__dirname, '../utils/webPushNotifications.js');
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes("toLocaleTimeString('de-DE'"), 'webPushNotifications.js must specify de-DE locale explicitly');
    assert.ok(!content.includes("toLocaleTimeString([])"), 'webPushNotifications.js must not pass empty array locale []');
  });

  await t.test('public/js/notifications.js specifies de-DE locale explicitly', () => {
    const filePath = path.join(__dirname, '../../public/js/notifications.js');
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes("toLocaleTimeString('de-DE'"), 'notifications.js must specify de-DE locale explicitly');
    assert.ok(!content.includes("toLocaleTimeString([])"), 'notifications.js must not pass empty array locale []');
  });
});
