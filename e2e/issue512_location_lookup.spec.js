const http = require('http');
const { test, expect } = require('./fixtures.js');

// Issue #512: address autocomplete and map preview in the location field. Off by default: typing
// sends nothing anywhere. Switching a provider on in the settings asks for consent and says what
// goes where. Then typing (debounced) shows suggestions, choosing one fills LOCATION and GEO and
// shows an OSM map preview. The lookup and tile services are a fake on loopback
// (playwright.config.js: GEOCODER_PHOTON_URL / OSM_TILE_URL) that records every request; the
// browser itself must never contact anything but the shard.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const UPSTREAM_PORT = 3514;
// A valid 1×1 PNG, so the preview's tiles really load.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let upstream;
const hits = [];
// The shard caches lookups (1 h) and tiles (24 h); each run asks for its own place at its own
// point, so a reused server or a repeated run still has to reach the upstream.
let place;
let point;

test.beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${UPSTREAM_PORT}`);
    hits.push({ path: url.pathname, q: url.searchParams.get('q'), ua: req.headers['user-agent'] });
    if (url.pathname === '/api') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ type: 'FeatureCollection', features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
        properties: { name: place, postcode: '10178', city: 'Berlin', country: 'Deutschland' },
      }] }));
    } else if (url.pathname.startsWith('/tiles/')) {
      res.setHeader('Content-Type', 'image/png');
      res.end(PNG);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise(resolve => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise(resolve => upstream.close(resolve));
});

test('Issue #512 — location autocomplete and map preview only after opt-in; the place is stored in LOCATION and GEO', async ({ page, baseURL }) => {
  hits.length = 0;
  const run = Date.now().toString(36);
  place = `Platz ${run}`;
  point = { lat: Number((40 + Math.random() * 20).toFixed(4)), lon: Number((Math.random() * 20).toFixed(4)) };
  const LABEL = `${place}, 10178 Berlin, Deutschland`;
  const shard = new URL(baseURL).host;
  const foreign = [];
  page.on('request', req => {
    const url = new URL(req.url());
    if (/^https?:$/.test(url.protocol) && url.host !== shard) foreign.push(req.url());
  });
  await page.addInitScript(() => {
    if (window.origin === 'null') return;
    window.localStorage.setItem('welcome-popup-closed', 'true');
    window.localStorage.setItem('activeView', 'month');
  });
  const created = await page.request.post('/api/calendars', {
    headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name: `E2E 512 ${Date.now().toString(36)}`, type: 'calendar' },
  });
  expect(created.status()).toBe(201);
  const calendarId = (await created.json()).id;
  await page.goto('/?date=2037-05-04');
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

  const location = page.locator('#ev-location');
  const suggestions = page.locator('#ev-location-suggestions [role="option"]');
  const map = page.locator('#ev-location-map');

  // Off by default: typing a place sends nothing, shows nothing.
  await page.click('#new-event-btn');
  await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
  await location.pressSequentially(place, { delay: 20 });
  await page.waitForTimeout(1200);
  await expect(suggestions).toHaveCount(0);
  await expect(map).toBeHidden();
  expect(hits).toEqual([]);
  await page.click('#event-cancel-btn');

  // Settings: off, with the statement that nothing goes to third parties.
  await page.click('#sidebar-settings-btn');
  const provider = page.locator('#geo-provider');
  const notice = page.locator('#geo-provider-notice');
  await expect(provider).toHaveValue('off');
  await expect(notice).toContainText('nichts an Dritte');

  // Choosing OpenStreetMap asks first and names the hosts; declining keeps it off.
  await provider.selectOption('osm');
  const confirmBox = page.locator('#confirm-dialog-backdrop');
  await expect(confirmBox).not.toHaveClass(/hidden/);
  await expect(page.locator('#confirm-dialog-text')).toContainText('127.0.0.1');
  await page.click('#confirm-dialog-cancel');
  await expect(provider).toHaveValue('off');
  expect((await (await page.request.get('/api/geo/settings')).json()).provider).toBe('off');

  await provider.selectOption('osm');
  await page.click('#confirm-dialog-ok');
  await expect(notice).toContainText('127.0.0.1');
  await expect.poll(async () => (await (await page.request.get('/api/geo/settings')).json()).provider).toBe('osm');
  await page.click('#close-settings-btn');

  // Typing now asks once, after a pause (debounced), and lists the suggestion.
  await page.click('#new-event-btn');
  await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
  await page.selectOption('#ev-calendar', calendarId);
  await page.fill('#ev-title', 'Treffen 512');
  await location.pressSequentially(place, { delay: 30 });
  await expect(suggestions).toHaveCount(1);
  await expect(suggestions.first()).toHaveText(LABEL);
  await expect(location).toHaveAttribute('aria-expanded', 'true');
  const lookups = hits.filter(h => h.path === '/api');
  expect(lookups.map(h => h.q)).toEqual([place]);
  expect(lookups[0].ua).toMatch(/^FreeShard-WebCalendar\//);

  // Keyboard choice fills the field and shows the map with the shard-proxied OSM tiles.
  await location.press('ArrowDown');
  await location.press('Enter');
  await expect(location).toHaveValue(LABEL);
  await expect(suggestions).toHaveCount(0);
  await expect(map).toBeVisible();
  await expect(map).toContainText('OpenStreetMap');
  const tiles = map.locator('img');
  await expect(tiles).toHaveCount(4);
  await expect.poll(() => tiles.evaluateAll(imgs => imgs.every(i => i.complete && i.naturalWidth === 1))).toBe(true);
  expect(hits.filter(h => h.path.startsWith('/tiles/16/')).length).toBe(4);

  await page.click('#event-save-btn');
  await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
  await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });

  const evRes = await page.request.get(`/api/events?start=2037-04-01T00:00:00Z&end=2037-06-15T00:00:00Z&calendarId=${encodeURIComponent(calendarId)}`);
  const saved = (await evRes.json()).events.find(e => e.title === 'Treffen 512');
  expect(saved.location).toBe(LABEL);
  expect(saved.geo).toEqual(point);
  const ics = await (await page.request.get(`/api/calendars/${encodeURIComponent(calendarId)}/export`)).text();
  expect(ics).toMatch(new RegExp(`\\r?\\nGEO:${String(point.lat).replace('.', '\\.')};${String(point.lon).replace('.', '\\.')}\\r?\\n`));

  // Reopened, the map is back; editing the text by hand drops the point and the map.
  await page.locator(`#calendar-container [data-event-uid="${saved.uid}"]`).first().click();
  const editBtn = page.locator('#popover-edit-btn');
  if (await editBtn.isVisible()) await editBtn.click();
  await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
  await expect(location).toHaveValue(LABEL);
  await expect(map).toBeVisible();
  await location.press('End');
  await location.pressSequentially(' Nord');
  await expect(map).toBeHidden();

  expect(foreign).toEqual([]);
});
