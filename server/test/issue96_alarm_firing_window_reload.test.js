'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  evaluateUpcomingAlarms
} = require('../utils/webPushNotifications');

const notificationsJsPath = path.resolve(__dirname, '../../public/js/notifications.js');
const eventModalJsPath = path.resolve(__dirname, '../../public/js/eventModal.js');
const appJsPath = path.resolve(__dirname, '../../public/js/app.js');
const swJsPath = path.resolve(__dirname, '../../public/sw.js');

function createNotificationsSandbox(options = {}) {
  const storage = options.storage || new Map();
  const mockLocalStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, val) => storage.set(key, String(val)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  };

  const toasts = [];
  const notificationsCreated = [];
  const permissionRequests = [];

  class MockNotification {
    constructor(title, opts) {
      notificationsCreated.push({ title, opts });
    }
    static permission = options.permission !== undefined ? options.permission : 'default';
    static requestPermission() {
      permissionRequests.push(Date.now());
      return Promise.resolve(options.grantedPermission || 'granted');
    }
  }

  const events = options.events || [];
  const mockStore = {
    get: (key) => (key === 'events' ? events : [])
  };

  const context = {
    console,
    Date,
    String,
    parseInt,
    isNaN,
    Array,
    Set,
    JSON,
    setInterval: () => 12345,
    clearInterval: () => {},
    localStorage: mockLocalStorage,
    Notification: MockNotification,
    store: mockStore,
    showToast: (msg, type) => toasts.push({ msg, type }),
    // locale.js (#625), whose import is stripped below
    formatTime: d => new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d)),
    navigator: {
      serviceWorker: {
        register: () => Promise.resolve()
      }
    },
    exports: {}
  };

  const rawCode = fs.readFileSync(notificationsJsPath, 'utf8');
  const cjsCode = rawCode
    .replace(/^import\s+.*?;/gm, '')
    .replace(/export\s+async\s+function\s+/g, 'async function ')
    .replace(/export\s+function\s+/g, 'function ')
    .replace(/export\s+const\s+/g, 'const ')
    .replace(/export\s+let\s+/g, 'let ') + `
    exports.parseTriggerOffsetMs = parseTriggerOffsetMs;
    exports.requestNotificationPermission = requestNotificationPermission;
    exports.checkAndTriggerAlarms = checkAndTriggerAlarms;
    exports.initNotificationService = initNotificationService;
    exports.resetNotifiedAlarms = resetNotifiedAlarms;
  `;

  vm.createContext(context);
  vm.runInContext(cjsCode, context);

  return {
    context,
    exports: context.exports,
    storage,
    toasts,
    notificationsCreated,
    permissionRequests,
    MockNotification
  };
}

test('Issue #96 — Alarm Firing Window (24h), Reload Persistence & No Permission Prompt on Boot', async (t) => {

  await t.test('initNotificationService() must NOT prompt for notification permission on boot/load without user gesture', () => {
    const sandbox = createNotificationsSandbox({
      permission: 'default'
    });

    // Call initNotificationService (which is called during app boot())
    sandbox.exports.initNotificationService();

    assert.equal(
      sandbox.permissionRequests.length,
      0,
      'initNotificationService() must NOT call requestNotificationPermission() or Notification.requestPermission() on boot'
    );
  });

  await t.test('checkAndTriggerAlarms() persists notified alarms in localStorage and prevents re-firing on reload', () => {
    const sharedStorage = new Map();
    const nowIso = new Date().toISOString();
    const event = {
      uid: 'meeting-1',
      title: 'Sprint Planning',
      start: nowIso,
      alarms: [{ trigger: 'PT0S', action: 'DISPLAY' }]
    };

    // First session: alarm fires
    const session1 = createNotificationsSandbox({
      storage: sharedStorage,
      events: [event],
      permission: 'granted'
    });

    session1.exports.checkAndTriggerAlarms();

    assert.equal(session1.toasts.length, 1, 'Alarm should fire once on first check');
    assert.ok(session1.toasts[0].msg.includes('Sprint Planning'));
    assert.equal(session1.notificationsCreated.length, 1, 'Desktop notification should be created');

    const storedData = sharedStorage.get('webcalendar_notified_alarms');
    assert.ok(storedData, 'localStorage must contain webcalendar_notified_alarms');
    assert.ok(storedData.includes('meeting-1::PT0S'), 'localStorage must persist the triggered alarm key');

    // Simulate page reload: fresh VM context sharing the exact same localStorage
    const session2 = createNotificationsSandbox({
      storage: sharedStorage,
      events: [event],
      permission: 'granted'
    });

    session2.exports.checkAndTriggerAlarms();

    assert.equal(
      session2.toasts.length,
      0,
      'Alarm must NOT re-fire after simulated page reload with populated localStorage'
    );
    assert.equal(
      session2.notificationsCreated.length,
      0,
      'Desktop notification must NOT re-fire after simulated page reload'
    );
  });

  await t.test('checkAndTriggerAlarms() fires alarms within 24-hour catch-up window, but not older than 24h or in future', () => {
    const now = Date.now();

    // 1) Alarm due 30 minutes ago (would fail if 5-minute window defect reinstated as +300000 or 5*60*1000)
    const thirtyMinsAgoIso = new Date(now - 30 * 60 * 1000).toISOString();
    const event30m = {
      uid: 'ev-30m-ago',
      title: 'Missed Call 30m',
      start: thirtyMinsAgoIso,
      alarms: [{ trigger: 'PT0S', action: 'DISPLAY' }]
    };

    // 2) Alarm due 6 hours ago
    const sixHoursAgoIso = new Date(now - 6 * 60 * 60 * 1000).toISOString();
    const event6h = {
      uid: 'ev-6h-ago',
      title: 'Overdue Task 6h',
      start: sixHoursAgoIso,
      alarms: [{ trigger: 'PT0S', action: 'DISPLAY' }]
    };

    // 3) Alarm due 25 hours ago (outside 24h catch-up window)
    const twentyFiveHoursAgoIso = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    const event25h = {
      uid: 'ev-25h-ago',
      title: 'Ancient Event 25h',
      start: twentyFiveHoursAgoIso,
      alarms: [{ trigger: 'PT0S', action: 'DISPLAY' }]
    };

    // 4) Alarm due in 10 minutes in future
    const tenMinsFutureIso = new Date(now + 10 * 60 * 1000).toISOString();
    const eventFuture = {
      uid: 'ev-future-10m',
      title: 'Future Event 10m',
      start: tenMinsFutureIso,
      alarms: [{ trigger: 'PT0S', action: 'DISPLAY' }]
    };

    const sandbox = createNotificationsSandbox({
      events: [event30m, event6h, event25h, eventFuture],
      permission: 'granted'
    });

    sandbox.exports.checkAndTriggerAlarms();

    const firedTitles = sandbox.toasts.map(t => t.msg);

    assert.ok(
      firedTitles.some(t => t.includes('Missed Call 30m')),
      'Alarm due 30 minutes ago MUST fire (fails if defect reinstated as 5-minute window)'
    );
    assert.ok(
      firedTitles.some(t => t.includes('Overdue Task 6h')),
      'Alarm due 6 hours ago MUST fire within 24h catch-up window'
    );
    assert.ok(
      !firedTitles.some(t => t.includes('Ancient Event 25h')),
      'Alarm due 25 hours ago must NOT fire (outside 24h window)'
    );
    assert.ok(
      !firedTitles.some(t => t.includes('Future Event 10m')),
      'Future alarm must NOT fire before scheduled time'
    );
  });

  await t.test('requestNotificationPermission() requests permission on explicit user gesture and updates state', async () => {
    const sandbox = createNotificationsSandbox({
      permission: 'default',
      grantedPermission: 'granted'
    });

    assert.equal(sandbox.permissionRequests.length, 0);

    // Call requestNotificationPermission explicitly (simulating user gesture)
    const result = await sandbox.exports.requestNotificationPermission();

    assert.equal(result, 'granted');
    assert.equal(sandbox.permissionRequests.length, 1, 'Should request permission when explicitly called by user gesture');
  });

  await t.test('eventModal.js requests notification permission on explicit user gesture (alarm select or save with alarm)', () => {
    const modalSrc = fs.readFileSync(eventModalJsPath, 'utf8');
    assert.ok(
      modalSrc.includes("import { requestNotificationPermission } from './notifications.js';"),
      'eventModal.js must import requestNotificationPermission from notifications.js'
    );
    assert.ok(
      modalSrc.includes('requestNotificationPermission()'),
      'eventModal.js must call requestNotificationPermission() upon user alarm interaction'
    );
  });

  await t.test('public/js/app.js exposes settings drawer notification control and never prompts on boot', () => {
    const appSrc = fs.readFileSync(appJsPath, 'utf8');
    assert.ok(
      appSrc.includes('requestNotificationPermission'),
      'app.js must import requestNotificationPermission for user-triggered settings control'
    );
    assert.ok(
      appSrc.includes('renderSettingsNotifications'),
      'app.js must implement renderSettingsNotifications for settings drawer UI'
    );
    assert.ok(
      appSrc.includes('request-notification-btn'),
      'app.js must wire request-notification-btn click handler in settings'
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

  await t.test('public/sw.js implements push event listener and notificationclick handler', () => {
    const content = fs.readFileSync(swJsPath, 'utf8');
    assert.ok(
      content.includes("addEventListener('push'") || content.includes('addEventListener("push"'),
      'public/sw.js must contain a push event listener'
    );
    assert.ok(
      content.includes('showNotification'),
      'public/sw.js must call showNotification in push handler'
    );
    assert.ok(
      content.includes("addEventListener('notificationclick'") || content.includes('addEventListener("notificationclick"'),
      'public/sw.js must contain a notificationclick event listener'
    );
  });
});
