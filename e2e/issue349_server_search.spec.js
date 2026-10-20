const { test, expect } = require('./fixtures.js');

// Issue #349: the toolbar search used to filter only the events loaded for the visible range.
// It now also asks the server, which searches every calendar years back and ahead, lists the
// hits grouped by day under the search field, and a click opens the event at its date.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysFromToday(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}

async function createEvent(page, calendarId, title, day, extra = {}) {
  const start = new Date(day);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 3600000);
  const res = await page.request.post('/api/events', { headers: SAME_ORIGIN, data: {
    calendarId, title, start: start.toISOString(), end: end.toISOString(), ...extra,
  } });
  expect(res.status()).toBe(201);
}

test('Issue #349 — search finds events outside the loaded range, grouped by day, and opens them', async ({ page, e2eUser }) => {
  await page.addInitScript(() => {
    if (window.origin === 'null') return;
    window.localStorage.setItem('welcome-popup-closed', 'true');
  });
  const today = daysFromToday(0);
  await page.goto(`/?date=${isoDay(today)}`);
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  await page.click('#view-month');
  await expect(page.locator('.month-view')).toBeVisible({ timeout: 10000 });

  const calendarId = `internal-caldav::/${e2eUser}/personal/`;
  await expect.poll(async () => (await (await page.request.get('/api/calendars')).json()).calendars.map(c => c.id),
    { timeout: 10000 }).toContain(calendarId);
  const past = daysFromToday(-45);
  const future = daysFromToday(300);
  await createEvent(page, calendarId, 'Zahnarzt E2E349', past, { location: 'Praxis Testuser' });
  await createEvent(page, calendarId, 'Geburtstag E2E349', future, { description: 'Kuchen fuer Test User' });
  await createEvent(page, calendarId, 'Unrelated E2E349', daysFromToday(-44));

  // Description hit, far outside the visible month.
  await page.fill('#search-input', 'kuchen fuer');
  const panel = page.locator('#search-results');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.search-result')).toHaveCount(1, { timeout: 10000 });
  await expect(panel.locator('.search-result')).toContainText('Geburtstag E2E349');

  // Title and location hits: two days, two headings, in date order.
  await page.fill('#search-input', 'e2e349');
  await expect(panel.locator('.search-result')).toHaveCount(3, { timeout: 10000 });
  await expect(panel.locator('.search-results-day')).toHaveCount(3);
  await expect(panel.locator('.search-result')).toHaveText([/Zahnarzt E2E349/, /Unrelated E2E349/, /Geburtstag E2E349/]);
  await page.fill('#search-input', 'praxis testuser');
  await expect(panel.locator('.search-result')).toHaveCount(1, { timeout: 10000 });
  const fmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  await expect(panel.locator('.search-results-day')).toHaveText([fmt.format(past)]);
  await expect(panel.locator('.search-result')).toContainText('Zahnarzt E2E349');
  // The loaded month itself has no match — the hit came from the server.
  await expect(page.locator('.search-empty-banner')).toBeVisible();

  // A click jumps to the event's month and opens it.
  await panel.locator('.search-result').click();
  await expect(panel).toBeHidden();
  const monthTitle = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(past);
  await expect(page.locator('#toolbar-title')).toHaveText(monthTitle);
  await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);
  await expect(page.locator('#event-popover .popover-title')).toHaveText('Zahnarzt E2E349');
  await expect(page.locator('.month-view .event-chip', { hasText: 'Zahnarzt E2E349' })).toBeVisible();

  // No hit anywhere says so in the panel; a one-letter query does not search.
  await page.fill('#search-input', 'zzz-nirgends-349');
  await expect(panel).toContainText('Keine Termine für „zzz-nirgends-349“ in allen Kalendern gefunden.', { timeout: 10000 });
  await page.fill('#search-input', 'z');
  await expect(panel).toBeHidden();
});
