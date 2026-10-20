const http = require('http');
const { test, expect } = require('./fixtures.js');
const { webServer } = require('../playwright.config.js');

// Issue #513: weather from Bright Sky (DWD) in the week and day headers, off by default. The location
// is entered once in the settings next to a notice of what goes where; only saving it sends anything.
// The shard fetches the forecast (from this stand-in, webServer.env.WEATHER_BRIGHTSKY_URL); when the
// provider fails, the badges go and the view stays.

const BRIGHTSKY_PORT = Number(new URL(webServer.env.WEATHER_BRIGHTSKY_URL).port);
const OUTAGE_LATITUDE = '47.01';
const HOSTILE_LATITUDE = '47.02';
const DAY = 24 * 60 * 60 * 1000;
const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);

// Per day i from the requested date: hourly records 06–18 UTC (daytime in Berlin), 5+i … 17+i °C;
// even days clear, odd days rain with 0.5 mm per hour.
const requests = [];
const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  requests.push(Object.fromEntries(url.searchParams));
  if (url.searchParams.get('lat') === OUTAGE_LATITUDE) {
    res.writeHead(500);
    return res.end('down');
  }
  const date = url.searchParams.get('date');
  const hostile = url.searchParams.get('lat') === HOSTILE_LATITUDE;
  const weather = [];
  for (let i = 0; i < 7; i++) {
    for (let h = 6; h <= 18; h++) {
      weather.push({
        timestamp: `${addDays(date, i)}T${String(h).padStart(2, '0')}:00:00+00:00`,
        temperature: 5 + i + (h - 6),
        precipitation: i % 2 ? 0.5 : 0,
        icon: hostile ? (i % 2 ? '__proto__' : 'constructor') : (i % 2 ? 'rain' : 'clear-day'),
      });
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ weather, sources: [] }));
});

test.use({ serviceWorkers: 'block' });

test.beforeAll(async () => {
  await new Promise(resolve => upstream.listen(BRIGHTSKY_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise(resolve => upstream.close(resolve));
});

test('Issue #513 — weather is opt-in in the settings and shows in the week and day headers', async ({ page }, testInfo) => {
  requests.length = 0;
  // The shard caches per location for an hour, so every repeat asks for its own (52.52, 52.53, …).
  const lat = String((5252 + testInfo.repeatEachIndex) / 100);
  await page.addInitScript(() => {
    if (window.origin !== 'null') window.localStorage.setItem('welcome-popup-closed', 'true');
  });
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date()));
  const tomorrow = addDays(today, 1);
  await page.click('#view-week');
  const week = page.locator('#calendar-container .week-view');
  await expect(week).toBeVisible({ timeout: 10000 });
  const badges = page.locator('#calendar-container .weather-badge');
  const todayHeader = page.locator('#calendar-container .week-day-header[aria-current="date"]');

  // Off by default: no badge, nothing sent.
  await expect(todayHeader).toBeVisible();
  await expect(badges).toHaveCount(0);

  // The settings name the provider and what is sent before anything is switched on.
  await page.click('#sidebar-settings-btn');
  await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
  const enabled = page.locator('#weather-enabled');
  const form = page.locator('#weather-location-form');
  await expect(enabled).not.toBeChecked();
  await expect(form).toBeHidden();
  await expect(page.locator('#weather-notice')).toContainText(`Bright Sky (127.0.0.1:${BRIGHTSKY_PORT})`);
  await expect(page.locator('#weather-notice')).toContainText('auf etwa 1 km gerundet');
  await expect(page.locator('#weather-status')).toHaveText('Ausgeschaltet.');

  // Ticking the box only opens the form; an invalid location is refused in place.
  await enabled.check();
  await expect(form).toBeVisible();
  await expect(page.locator('#weather-latitude')).toBeFocused();
  await page.fill('#weather-latitude', 'Berlin');
  await page.fill('#weather-longitude', '13.40');
  await page.click('#weather-save-btn');
  await expect(page.locator('#weather-error')).toBeVisible();
  await expect(page.locator('#weather-latitude')).toBeFocused();
  expect((await (await page.request.get('/api/weather/settings')).json()).location).toBe(null);
  expect(requests).toHaveLength(0);

  // Saving a location switches the forecast on; a comma decimal is accepted.
  await page.fill('#weather-latitude', `${lat.replace('.', ',')}${lat.includes('.') ? '' : ','}0008`);
  await page.click('#weather-save-btn');
  await expect(page.locator('#weather-error')).toBeHidden();
  await expect(page.locator('#weather-status')).toHaveText(`Eingeschaltet für ${lat}, 13.4.`);
  await page.click('#close-settings-btn');

  const todayBadge = todayHeader.locator('.weather-badge');
  await expect(todayBadge).toHaveAttribute('data-weather-date', today);
  await expect(todayBadge.locator('.weather-temp')).toHaveText('17° / 5°');
  await expect(todayBadge).toHaveAttribute('title', 'Sonnig, 5 bis 17 °C');
  await expect(todayHeader).toHaveAttribute('aria-label', /, Wetter: Sonnig, 5 bis 17 °C$/);
  expect(requests[0]).toMatchObject({ lat, lon: '13.4', date: today, tz: 'Europe/Berlin' });

  // The day view shows it too, for the next days of the forecast.
  await page.click('#view-day');
  const dayHeader = page.locator('#calendar-container .day-view .week-day-header');
  await page.click('#next-btn');
  await expect(dayHeader.locator('.weather-badge')).toHaveAttribute('data-weather-date', tomorrow);
  await expect(dayHeader.locator('.weather-temp')).toHaveText('18° / 6°');
  await expect(dayHeader).toHaveAttribute('aria-label', /, Wetter: Regen, 6 bis 18 °C, 6,5 mm Niederschlag$/);
  // Beyond the forecast nothing is shown.
  for (let i = 0; i < 7; i++) await page.click('#next-btn');
  await expect(dayHeader).toBeVisible();
  await expect(badges).toHaveCount(0);

  // The choice survives a reload; the shard's cache answers, the provider is not asked again.
  await page.click('#today-btn');
  await page.reload();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  await page.click('#view-week');
  await expect(todayHeader.locator('.weather-temp')).toHaveText('17° / 5°');
  expect(requests).toHaveLength(1);

  // A provider outage hides the badges and leaves the view working.
  await page.click('#sidebar-settings-btn');
  await expect(enabled).toBeChecked();
  await expect(page.locator('#weather-latitude')).toHaveValue(lat);
  await page.fill('#weather-latitude', OUTAGE_LATITUDE);
  await page.click('#weather-save-btn');
  await expect(page.locator('#weather-status')).toHaveText(`Eingeschaltet für ${OUTAGE_LATITUDE}, 13.4.`);
  await page.click('#close-settings-btn');
  await expect(badges).toHaveCount(0);
  await expect(week.locator('.week-day-header')).toHaveCount(7);
  await expect(todayHeader).not.toHaveAttribute('aria-label', /Wetter/);
  await page.click('#next-btn');
  await expect(week.locator('.week-day-header')).toHaveCount(7);

  // Switching off removes the location on the shard.
  await page.click('#sidebar-settings-btn');
  await enabled.uncheck();
  await expect(page.locator('#weather-status')).toHaveText('Ausgeschaltet.');
  await expect(form).toBeHidden();
  await expect.poll(async () => (await (await page.request.get('/api/weather/settings')).json()).location)
    .toBe(null);
});

test('Issue #513 — symbols the provider does not document leave the week and day views working', async ({ page }) => {
  await page.addInitScript(() => {
    if (window.origin !== 'null') window.localStorage.setItem('welcome-popup-closed', 'true');
  });
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date()));

  // The stand-in answers this location with 'constructor' and '__proto__' as symbols.
  await page.click('#sidebar-settings-btn');
  await page.locator('#weather-enabled').check();
  await page.fill('#weather-latitude', HOSTILE_LATITUDE);
  await page.fill('#weather-longitude', '13.40');
  await page.click('#weather-save-btn');
  await expect(page.locator('#weather-status')).toHaveText(`Eingeschaltet für ${HOSTILE_LATITUDE}, 13.4.`);
  await page.click('#close-settings-btn');

  await page.click('#view-week');
  const todayHeader = page.locator('#calendar-container .week-view .week-day-header[aria-current="date"]');
  await expect(page.locator('#calendar-container .week-view .week-day-header')).toHaveCount(7);
  const badge = todayHeader.locator('.weather-badge');
  await expect(badge).toHaveAttribute('data-weather-date', today);
  await expect(badge.locator('.weather-temp')).toHaveText('17° / 5°');
  await expect(badge.locator('.weather-icon')).toHaveText('');
  await expect(badge).toHaveAttribute('title', 'Vorhersage, 5 bis 17 °C');

  await page.click('#view-day');
  await page.click('#next-btn');
  const dayHeader = page.locator('#calendar-container .day-view .week-day-header');
  await expect(dayHeader.locator('.weather-temp')).toHaveText('18° / 6°');
  await expect(dayHeader).toHaveAttribute('aria-label', /, Wetter: Vorhersage, 6 bis 18 °C, 6,5 mm Niederschlag$/);

  // The browser does not trust the symbol either: such a name reaching it still renders the views.
  await page.route('**/api/weather/forecast?*', async route => {
    const body = await (await route.fetch()).json();
    body.days.forEach((d, i) => { d.icon = i % 2 ? '__proto__' : 'constructor'; });
    await route.fulfill({ json: body });
  });
  await page.reload();
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  await page.click('#view-week');
  await expect(page.locator('#calendar-container .week-view .week-day-header')).toHaveCount(7);
  await expect(badge.locator('.weather-temp')).toHaveText('17° / 5°');
  await expect(badge).toHaveAttribute('title', 'Vorhersage, 5 bis 17 °C');
  await page.click('#view-day');
  await page.click('#next-btn');
  await expect(dayHeader).toHaveAttribute('aria-label', /, Wetter: Vorhersage, 6 bis 18 °C, 6,5 mm Niederschlag$/);
  expect(pageErrors).toEqual([]);
  await page.unroute('**/api/weather/forecast?*');

  await page.click('#sidebar-settings-btn');
  await page.locator('#weather-enabled').uncheck();
  await expect(page.locator('#weather-status')).toHaveText('Ausgeschaltet.');
});
