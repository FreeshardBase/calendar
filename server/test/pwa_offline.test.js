const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Import OfflineCache if running in Node environment
const offlineCachePath = path.join(__dirname, '../../public/js/offlineCache.js');

test('Issue #26 — Web App Manifest file presence and structure', (t) => {
  const manifestPath = path.join(__dirname, '../../public/manifest.json');
  assert.strictEqual(fs.existsSync(manifestPath), true, 'manifest.json must exist in public directory');

  const content = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(content);

  assert.strictEqual(manifest.name, 'FreeShard WebCalendar');
  assert.strictEqual(manifest.short_name, 'WebCalendar');
  assert.strictEqual(manifest.display, 'standalone');
  assert.strictEqual(manifest.start_url, '/');
  assert.ok(manifest.theme_color, 'manifest must specify theme_color');
  assert.ok(manifest.background_color, 'manifest must specify background_color');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest must specify icons array');
});

test('Issue #26 — Service Worker sw.js presence and caching logic', (t) => {
  const swPath = path.join(__dirname, '../../public/sw.js');
  assert.strictEqual(fs.existsSync(swPath), true, 'sw.js must exist in public directory');

  const swContent = fs.readFileSync(swPath, 'utf8');
  assert.ok(swContent.includes('CACHE_NAME'), 'sw.js must define CACHE_NAME');
  assert.ok(swContent.includes('install'), 'sw.js must contain install event listener');
  assert.ok(swContent.includes('activate'), 'sw.js must contain activate event listener');
  assert.ok(swContent.includes('fetch'), 'sw.js must contain fetch event listener');
  assert.ok(swContent.includes('/manifest.json'), 'sw.js pre-cache must include manifest.json');
});

test('Issue #26 — public/index.html PWA tags and Service Worker registration', (t) => {
  const indexPath = path.join(__dirname, '../../public/index.html');
  const indexHtml = fs.readFileSync(indexPath, 'utf8');

  assert.ok(indexHtml.includes('rel="manifest"'), 'index.html must contain link rel="manifest"');
  assert.ok(indexHtml.includes('manifest.json'), 'index.html must link to manifest.json');
  assert.ok(indexHtml.includes('theme-color'), 'index.html must contain theme-color meta tag');
  assert.ok(indexHtml.includes('offlineCache.js'), 'index.html must include offlineCache.js script');
});

test('Issue #26 — OfflineCache module methods', (t) => {
  assert.strictEqual(fs.existsSync(offlineCachePath), true, 'offlineCache.js must exist');
  
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
