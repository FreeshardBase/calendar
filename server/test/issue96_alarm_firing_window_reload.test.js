'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  evaluateUpcomingAlarms
} = require('../utils/webPushNotifications');

const notificationsJsPath = path.resolve(__dirname, '../../public/js/notifications.js');
const swJsPath = path.resolve(__dirname, '../../public/sw.js');

test('Issue #96 — Alarm Firing Window, Reload Persistence & Background SW Support', async (t) => {

  await t.test('public/js/notifications.js uses localStorage for reload persistence', () => {
    const content = fs.readFileSync(notificationsJsPath, 'utf8');
    assert.ok(
      content.includes('localStorage') || content.includes('storage'),
      'notifications.js must reference localStorage to persist notified alarms across reloads'
    );
    assert.ok(
      content.includes('webcalendar_notified_alarms'),
      'notifications.js must use webcalendar_notified_alarms key in storage'
    );
  });

  await t.test('public/js/notifications.js allows alarms to fire beyond strict 5-minute window', () => {
    const content = fs.readFileSync(notificationsJsPath, 'utf8');
    assert.ok(
      !content.includes('alarmTime + 5 * 60 * 1000'),
      'notifications.js must not restrict alarm triggering to a 5-minute window'
    );
  });

  await t.test('server/utils/webPushNotifications.js evaluateUpcomingAlarms supports lookback/grace window > 5 minutes', () => {
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

  await t.test('public/sw.js implements push event listener for background notifications', () => {
    const content = fs.readFileSync(swJsPath, 'utf8');
    assert.ok(
      content.includes("addEventListener('push'") || content.includes('addEventListener("push"'),
      'public/sw.js must contain a push event listener'
    );
    assert.ok(
      content.includes('showNotification'),
      'public/sw.js must call showNotification in push handler'
    );
  });

  await t.test('public/sw.js implements notificationclick listener for opening/focusing window', () => {
    const content = fs.readFileSync(swJsPath, 'utf8');
    assert.ok(
      content.includes("addEventListener('notificationclick'") || content.includes('addEventListener("notificationclick"'),
      'public/sw.js must contain a notificationclick event listener'
    );
  });
});
