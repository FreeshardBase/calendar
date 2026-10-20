const { test, expect } = require('./fixtures.js');

// Issue #625: week start, 12/24 h, default duration/calendar/reminder and time zone are chosen in
// the settings, stored per user on the server and used by the views and the event dialog.
// Dates are formatted with Intl, and all-day dates are local calendar dates, also east of UTC.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const UNCHOSEN = { weekStart: null, timeFormat: null, defaultDuration: 60, defaultCalendarId: null, defaultReminder: null, timeZone: null };

async function resetPrefs(page) {
  const res = await page.request.put('/api/preferences', { headers: SAME_ORIGIN, data: UNCHOSEN });
  expect(res.status()).toBe(200);
}

async function prefs(page) {
  return (await page.request.get('/api/preferences')).json();
}

async function createCalendar(page, name) {
  const res = await page.request.post('/api/calendars', {
    headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name: `${name} ${Date.now().toString(36)}`, type: 'calendar' },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function createEvent(page, data) {
  const res = await page.request.post('/api/events', { headers: SAME_ORIGIN, data });
  expect(res.status()).toBe(201);
}

async function openApp(page, url, view) {
  await page.addInitScript(() => {
    if (window.origin === 'null') return;
    window.localStorage.setItem('welcome-popup-closed', 'true');
  });
  await page.goto(url);
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  await page.click(`#view-${view}`);
}

const minutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

test('Issue #625 — preferences in the settings drive the views and the event dialog', async ({ page }) => {
  await resetPrefs(page);
  try {
    const calendarId = await createCalendar(page, 'E2E 625');
    // Wednesday 6 May 2037, 13:00 in Berlin (the browser's zone).
    await createEvent(page, { calendarId, title: 'Termin 625', start: '2037-05-06T11:00:00.000Z', end: '2037-05-06T12:00:00.000Z' });
    await openApp(page, '/?date=2037-05-06', 'week');

    // Not chosen: the browser's locale (de-DE) decides — Monday first, 24 h.
    await expect(page.locator('#toolbar-title')).toHaveText('4.–10. Mai 2037');
    await expect(page.locator('.week-day-label').first()).toHaveText('Mo');
    await expect(page.locator('.event-block', { hasText: 'Termin 625' }).locator('.event-block-time')).toContainText('13:00');

    await page.click('#sidebar-settings-btn');
    await expect(page.locator('#pref-week-start')).toHaveValue('');
    await page.selectOption('#pref-week-start', 'sun');
    await expect.poll(async () => (await prefs(page)).weekStart).toBe('sun');
    await page.selectOption('#pref-time-format', '12h');
    await expect.poll(async () => (await prefs(page)).timeFormat).toBe('12h');
    await page.selectOption('#pref-default-duration', '30');
    await expect.poll(async () => (await prefs(page)).defaultDuration).toBe(30);
    await page.selectOption('#pref-default-calendar', calendarId);
    await expect.poll(async () => (await prefs(page)).defaultCalendarId).toBe(calendarId);
    await page.selectOption('#pref-default-reminder', '10');
    await expect.poll(async () => (await prefs(page)).defaultReminder).toBe(10);
    await page.selectOption('#pref-time-zone', 'America/New_York');
    await expect.poll(async () => (await prefs(page)).timeZone).toBe('America/New_York');
    await page.click('#close-settings-btn');

    // Week view: Sunday first, 12 h clock.
    await expect(page.locator('#toolbar-title')).toHaveText('3.–9. Mai 2037');
    await expect(page.locator('.week-day-label').first()).toHaveText('So');
    await expect(page.locator('.event-block', { hasText: 'Termin 625' }).locator('.event-block-time')).toContainText('1:00 PM');

    // The choice is the user's, not the browser's: it survives a reload.
    await page.reload();
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await page.click('#view-week');
    await expect(page.locator('#toolbar-title')).toHaveText('3.–9. Mai 2037');

    // Month view and mini month start on Sunday too.
    await page.click('[data-view="month"]');
    await expect(page.locator('.month-dow').first()).toHaveText('So');
    await expect(page.locator('.month-dow').last()).toHaveText('Sa');
    await expect(page.locator('.mini-cal-dow').first()).toHaveText('So');
    await expect(page.locator('.month-day[data-date]').first().locator('.month-day-num')).toHaveText('26');
    await expect(page.locator('.event-chip', { hasText: 'Termin 625' }).locator('.event-chip-time')).toHaveText('1:00 PM');

    // Event dialog: default calendar, duration, reminder and time zone.
    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-calendar')).toHaveValue(calendarId);
    await expect(page.locator('#ev-start-tz')).toHaveValue('America/New_York');
    await expect(page.locator('#ev-end-tz')).toHaveValue('America/New_York');
    const start = await page.locator('#ev-start-time').inputValue();
    const end = await page.locator('#ev-end-time').inputValue();
    expect((minutes(end) - minutes(start) + 24 * 60) % (24 * 60)).toBe(30);
    await expect(page.locator('#ev-reminder-list .reminder-row')).toHaveCount(1);
    await expect(page.locator('#ev-reminder-list .reminder-amount')).toHaveValue('10');
    await page.click('#event-cancel-btn');

    // Back to "not chosen".
    await page.click('#sidebar-settings-btn');
    await page.selectOption('#pref-week-start', '');
    await expect.poll(async () => (await prefs(page)).weekStart).toBeNull();
    await page.selectOption('#pref-default-reminder', '');
    await expect.poll(async () => (await prefs(page)).defaultReminder).toBeNull();
    await page.click('#close-settings-btn');
    await expect(page.locator('.month-dow').first()).toHaveText('Mo');
    await page.click('#new-event-btn');
    await expect(page.locator('#ev-reminder-list .reminder-row')).toHaveCount(0);
    await page.click('#event-cancel-btn');
  } finally {
    await resetPrefs(page);
  }
});

test.describe('Issue #625 — all-day dates east of UTC', () => {
  test.use({ timezoneId: 'Asia/Tokyo' });

  test('Issue #625 — an all-day event in Asia/Tokyo lands on its own day in the agenda and month view', async ({ page }) => {
    await resetPrefs(page);
    const calendarId = await createCalendar(page, 'E2E 625 Tokyo');
    await createEvent(page, { calendarId, title: 'Ganztags 625', allDay: true, start: '2037-05-04T00:00:00.000Z', end: '2037-05-05T00:00:00.000Z' });
    // 00:30 on 4 May in Tokyo is still 3 May in UTC.
    await createEvent(page, { calendarId, title: 'Früh 625', start: '2037-05-03T15:30:00.000Z', end: '2037-05-03T16:00:00.000Z' });
    await openApp(page, '/?date=2037-05-04', 'agenda');

    const day = page.locator('.agenda-day', { hasText: 'Ganztags 625' });
    await expect(day).toHaveCount(1);
    await expect(day.locator('.agenda-day-date')).toHaveText('4. Mai 2037');
    await expect(day.locator('.agenda-day-name')).toHaveText('Mo');
    await expect(day).toContainText('Früh 625');
    await expect(page.locator('.agenda-day-date', { hasText: '4. Mai 2037' })).toHaveCount(1);

    await page.click('[data-view="month"]');
    const cell = page.locator('.month-day[data-date]', { has: page.locator('.event-chip', { hasText: 'Ganztags 625' }) });
    await expect(cell).toHaveCount(1);
    await expect(cell).toHaveAttribute('aria-label', /^Montag, 4\. Mai 2037/);

    // Created in the dialog on 5 May, it is stored as 5 May.
    await page.locator('.month-day[aria-label^="Dienstag, 5. Mai 2037"]').click();
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-start-date')).toHaveValue('2037-05-05');
    await page.selectOption('#ev-calendar', calendarId);
    await page.fill('#ev-title', 'Dialog 625');
    await page.check('#ev-allday');
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
    await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });
    const res = await page.request.get(`/api/events?start=2037-05-01T00:00:00Z&end=2037-05-10T00:00:00Z&calendarId=${encodeURIComponent(calendarId)}`);
    const saved = (await res.json()).events.find(e => e.title === 'Dialog 625');
    expect(saved.allDay).toBe(true);
    expect(saved.start.slice(0, 10)).toBe('2037-05-05');
  });
});
