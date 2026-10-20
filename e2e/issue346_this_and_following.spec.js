const { test, expect } = require('./fixtures.js');

// Issue #346: the scope dialog of a recurring event offers "this and all following" next to
// "only this" and "the whole series", for editing and for deleting. The browser runs in Europe/Berlin.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

async function openMonth(page, date) {
  await page.addInitScript(() => {
    if (window.origin === 'null') return;
    window.localStorage.setItem('welcome-popup-closed', 'true');
  });
  await page.goto(`/?date=${date}`);
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  await expect(page.locator('.month-view')).toBeVisible({ timeout: 10000 });
}

// Weekly on Wednesdays 10:00 Berlin, five times: 1, 8, 15, 22 and 29 June 2039.
async function createSeries(page, user, title) {
  const calendarId = `internal-caldav::/${user}/personal/`;
  await expect.poll(async () => (await (await page.request.get('/api/calendars')).json()).calendars.map(c => c.id),
    { timeout: 10000 }).toContain(calendarId);
  const created = await page.request.post('/api/events', { headers: SAME_ORIGIN, data: {
    calendarId, title, start: '2039-06-01T08:00:00.000Z', end: '2039-06-01T09:00:00.000Z',
    startTimeZone: 'Europe/Berlin', endTimeZone: 'Europe/Berlin', recurrence: 'FREQ=WEEKLY;COUNT=5',
  } });
  expect(created.status()).toBe(201);
  await page.reload();
  await expect(page.locator('.month-view')).toBeVisible({ timeout: 10000 });
}

// The chips in the June day cell `n`.
const dayChips = (page, n) => page.locator('.month-day:not(.other-month)')
  .filter({ has: page.locator('.month-day-num', { hasText: new RegExp(`^${n}$`) }) }).locator('.event-chip');

async function seriesUids(page) {
  const res = await page.request.get('/api/events?start=2039-05-01T00:00:00Z&end=2039-08-01T00:00:00Z');
  expect(res.ok()).toBeTruthy();
  return new Set((await res.json()).events.map(e => e.masterUid || e.uid.split('::')[0]));
}

test.describe('Issue #346 — this and following occurrences', () => {
  test('#346 editing "this and following" changes the occurrence and the later ones only', async ({ page, e2eUser }) => {
    await openMonth(page, '2039-06-15');
    const title = 'E2E 346 Weekly';
    await createSeries(page, e2eUser, title);
    const chips = page.locator('.event-chip').filter({ hasText: title });
    await expect(chips).toHaveCount(5, { timeout: 10000 });

    await chips.nth(2).click(); // 15 June
    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await page.fill('#ev-title', 'E2E 346 Renamed');
    await page.click('#event-save-btn');

    const dialog = page.locator('#scope-dialog-backdrop');
    await expect(dialog).not.toHaveClass(/hidden/);
    await expect(dialog.locator('button')).toHaveText([
      'Nur diesen Termin', 'Diesen und alle folgenden Termine', 'Alle Termine der Serie', 'Abbrechen',
    ]);
    await page.click('#scope-following-btn');
    await expect(dialog).toHaveClass(/hidden/);

    const renamed = page.locator('.event-chip').filter({ hasText: 'E2E 346 Renamed' });
    await expect(renamed).toHaveCount(3, { timeout: 10000 });
    await expect(chips).toHaveCount(2);
    await expect(dayChips(page, 8)).toContainText(title);
    await expect(dayChips(page, 15)).toContainText('E2E 346 Renamed');
    expect((await seriesUids(page)).size).toBe(2);
  });

  test('#346 deleting "this and following" ends the series before the occurrence', async ({ page, e2eUser }) => {
    await openMonth(page, '2039-06-15');
    const title = 'E2E 346 Delete';
    await createSeries(page, e2eUser, title);
    const chips = page.locator('.event-chip').filter({ hasText: title });
    await expect(chips).toHaveCount(5, { timeout: 10000 });

    await chips.nth(3).click(); // 22 June
    await page.click('#popover-delete-btn');
    await expect(page.locator('#scope-dialog-backdrop')).not.toHaveClass(/hidden/);
    await page.click('#scope-following-btn');

    await expect(chips).toHaveCount(3, { timeout: 10000 });
    await expect(dayChips(page, 15)).toContainText(title);
    await expect(dayChips(page, 22)).toHaveCount(0);
    await expect(dayChips(page, 29)).toHaveCount(0);
  });
});
