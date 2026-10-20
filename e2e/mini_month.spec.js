const { test, expect } = require('./fixtures.js');

// Issue #517: the sidebar's mini month jumps to any date, marks the days with events (also those
// outside the main view's range), highlights the range the main view shows and is driven by the
// keyboard like a date-picker grid. ISO week numbers are a per-user setting shown in the month
// grid, the week grid and the mini month. The browser runs in Europe/Berlin.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

// The app opens in the month view.
async function openApp(page, date, view) {
  await page.addInitScript(() => {
    if (window.origin === 'null') return;
    window.localStorage.setItem('welcome-popup-closed', 'true');
  });
  await page.goto(`/?date=${date}`);
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  await expect(page.locator('.month-view')).toBeVisible({ timeout: 10000 });
  if (view !== 'month') await page.click(`#view-${view}`);
}

async function ownCalendar(page, user) {
  const calendarId = `internal-caldav::/${user}/personal/`;
  await expect.poll(async () => (await (await page.request.get('/api/calendars')).json()).calendars.map(c => c.id),
    { timeout: 10000 }).toContain(calendarId);
  return calendarId;
}

const miniDay = (page, n) => page.locator('#mini-calendar [data-mini-day]', { hasText: new RegExp(`^${n}$`) });

test.describe('Issue #517 — mini month navigator', () => {
  test('marks days with events outside the visible week and highlights the week shown', async ({ page, e2eUser }) => {
    await openApp(page, '2039-05-11', 'week'); // a Wednesday; the week runs Mon 9 – Sun 15 May
    const calendarId = await ownCalendar(page, e2eUser);
    const created = await page.request.post('/api/events', { headers: SAME_ORIGIN, data: {
      calendarId, title: 'E2E 517 Termin', start: '2039-05-25T08:00:00.000Z', end: '2039-05-25T09:00:00.000Z',
    } });
    expect(created.status()).toBe(201);
    await page.reload();
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await page.click('#view-week');
    await expect(page.locator('.week-view')).toBeVisible({ timeout: 10000 });

    // The event lies two weeks after the visible week, still in the mini month's May.
    await expect(miniDay(page, 25)).toHaveClass(/\bhas-events\b/, { timeout: 10000 });
    await expect(miniDay(page, 24)).not.toHaveClass(/\bhas-events\b/);

    const inRange = page.locator('#mini-calendar .mini-cal-day.in-range');
    await expect(inRange).toHaveText(['9', '10', '11', '12', '13', '14', '15']);
    await expect(miniDay(page, 16)).not.toHaveClass(/\bin-range\b/);

    // In the month view the whole month is the range.
    await page.click('#view-month');
    await expect(page.locator('.month-view')).toBeVisible();
    await expect(inRange).toHaveCount(31);
  });

  test('arrow keys, Home/End and Page keys move through the days; Enter jumps there', async ({ page }) => {
    await openApp(page, '2039-05-11', 'week');
    await expect(page.locator('.week-view')).toBeVisible({ timeout: 10000 });

    // One tab stop for the whole grid: the selected day.
    await expect(page.locator('#mini-calendar [data-mini-day][tabindex="0"]')).toHaveCount(1);
    await expect(miniDay(page, 11)).toHaveAttribute('tabindex', '0');
    await miniDay(page, 11).focus();

    await page.keyboard.press('ArrowRight');
    await expect(miniDay(page, 12)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(miniDay(page, 19)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(miniDay(page, 18)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(miniDay(page, 11)).toBeFocused();
    await page.keyboard.press('End');
    await expect(miniDay(page, 15)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(miniDay(page, 9)).toBeFocused();
    // Moving focus does not navigate yet.
    await expect(page.locator('#toolbar-title')).toContainText('15. Mai 2039');

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('#toolbar-title')).toContainText('22. Mai 2039');
    await expect(page.locator('#mini-calendar .mini-cal-day.selected')).toHaveText('16');
    await expect(page.locator('#mini-calendar .mini-cal-day.selected')).toBeFocused();

    // Leaving the month: the mini month and the main view follow, focus stays on the day.
    await page.keyboard.press('PageDown');
    await expect(page.locator('#mini-calendar .mini-cal-title')).toHaveText('Juni 2039');
    await expect(miniDay(page, 16)).toBeFocused();
    await expect(page.locator('#toolbar-title')).toContainText('Juni 2039');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(miniDay(page, 30)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#mini-calendar .mini-cal-title')).toHaveText('Juli 2039');
    await expect(miniDay(page, 1)).toBeFocused();
    await page.keyboard.press('PageUp');
    await expect(page.locator('#mini-calendar .mini-cal-title')).toHaveText('Juni 2039');
    await expect(miniDay(page, 1)).toBeFocused();
  });
});

test.describe('Issue #517 — ISO week numbers', () => {
  test('switched on in the settings, shown in month, week and mini month, kept on reload', async ({ page }) => {
    // January 2038: the first row starts Mon 28 Dec 2037, which is ISO week 53 of 2037.
    await openApp(page, '2038-01-14', 'month');
    await expect(page.locator('.month-view')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.month-week-num')).toHaveCount(0);
    await expect(page.locator('#mini-calendar .mini-cal-week')).toHaveCount(0);

    await page.click('#sidebar-settings-btn');
    await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
    const toggle = page.locator('#show-week-numbers-toggle');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.click('#close-settings-btn');

    await expect(page.locator('.month-week-num')).toHaveText(['KW 53', 'KW 1', 'KW 2', 'KW 3', 'KW 4', 'KW 5']);
    // Each label sits in the row's first day, the week start (Monday).
    const firstCell = page.locator('.month-day').first();
    await expect(firstCell.locator('.month-week-num')).toHaveText('KW 53');
    await expect(firstCell).toHaveAttribute('data-date', new Date(2037, 11, 28).toISOString());
    await expect(page.locator('#mini-calendar .mini-cal-week')).toHaveText(['53', '1', '2', '3', '4', '5']);
    await expect(page.locator('#mini-calendar .mini-cal-week').first()).toHaveAttribute('aria-label', 'Kalenderwoche 53');
    await expect.poll(async () => (await (await page.request.get('/api/preferences')).json()).showWeekNumbers).toBe(true);

    // Stored on the server: survives a reload with empty local storage.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await page.click('#view-week');
    await expect(page.locator('.week-view')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.week-view .week-num')).toHaveText('KW 2');
    await page.click('#prev-btn');
    await page.click('#prev-btn');
    await expect(page.locator('.week-view .week-num')).toHaveText('KW 53');

    await page.click('#sidebar-settings-btn');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await page.click('#close-settings-btn');
    await expect(page.locator('.week-view .week-num')).toHaveCount(0);
    await expect(page.locator('#mini-calendar .mini-cal-week')).toHaveCount(0);
    await expect.poll(async () => (await (await page.request.get('/api/preferences')).json()).showWeekNumbers).toBe(false);
  });
});
