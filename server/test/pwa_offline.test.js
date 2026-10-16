const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// The manifest, the service worker and the page wiring are exercised in e2e/calendar.spec.js (#402).
const offlineCachePath = path.join(__dirname, '../../public/js/offlineCache.js');

test('Issue #26 — OfflineCache module methods', (t) => {
  // Mock localStorage for Node test environment
  const storage = {};
  global.localStorage = {
    getItem: (key) => storage[key] || null,
    setItem: (key, val) => { storage[key] = String(val); },
    removeItem: (key) => { delete storage[key]; },
    clear: () => { Object.keys(storage).forEach(k => delete storage[k]); }
  };
  global.window = global;
  global.navigator = { onLine: true };

  const OfflineCache = require(offlineCachePath);

  assert.ok(typeof OfflineCache.saveEvents === 'function');
  assert.ok(typeof OfflineCache.getEvents === 'function');
  assert.ok(typeof OfflineCache.saveCalendars === 'function');
  assert.ok(typeof OfflineCache.getCalendars === 'function');

  // Test caching calendars
  const mockCalendars = [{ id: 'cal1', name: 'Persönlich', color: '#2563eb' }];
  OfflineCache.saveCalendars(mockCalendars);
  const cachedCals = OfflineCache.getCalendars();
  assert.deepStrictEqual(cachedCals, mockCalendars);

  // Test caching events
  const mockEvents = [{ uid: 'evt-101', title: 'Offline Meeting', start: '2026-08-25T10:00:00Z' }];
  OfflineCache.saveEvents('cal1', mockEvents);
  const cachedEvts = OfflineCache.getEvents('cal1');
  assert.deepStrictEqual(cachedEvts, mockEvents);

  // Test online/offline state switching
  assert.strictEqual(OfflineCache.isOffline(), false);
  OfflineCache.setOfflineStatus(true);
  assert.strictEqual(OfflineCache.isOffline(), true);
  OfflineCache.setOfflineStatus(false);
  assert.strictEqual(OfflineCache.isOffline(), false);
});
