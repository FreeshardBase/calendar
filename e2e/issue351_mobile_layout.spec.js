const { test, expect } = require('./fixtures.js');

// Issue #351: a real phone layout. Runs in the phone projects 'mobile-iphone' (375×667) and
// 'mobile-touch' (Pixel 7, 412×915): the app opens in a three-day view, the view tabs become a
// bottom navigation, a floating button creates an event in a full-screen sheet, a horizontal swipe
// changes the period, and every control in the toolbar and bottom bar is at least 44 px. In the
// desktop project only the last test runs: the desktop layout keeps none of it.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const DAY = '2037-05-14'; // a Thursday; the browser runs in Europe/Berlin (UTC+2 in May)

const sessions = new WeakMap();
async function cdpOf(page) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  return sessions.get(page);
}

// A quick finger stroke across the calendar from (x0, y) to (x1, y + dy).
async function swipe(page, x0, x1, dy = 0) {
  const box = await page.locator('#calendar-container').boundingBox();
  const y = box.y + box.height / 2;
  const cdp = await cdpOf(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 6, y: y + dy * i / 6 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function open(page) {
  await page.addInitScript(() => {
    if (window.origin === 'null') return;
    window.localStorage.setItem('welcome-popup-closed', 'true');
  });
  await page.goto(`/?date=${DAY}`);
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 10000 });
}

test.describe('Issue #351 — phone layout', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone projects only');

  test('#351 opens in three days with a bottom navigation and 44 px touch targets', async ({ page }) => {
    await open(page);
    const viewport = page.viewportSize();
    await expect(page.locator('#view-3day')).toHaveClass(/active/);
    await expect(page.locator('.week-view .week-day-header')).toHaveCount(3);
    await expect(page.locator('.week-view .week-day-num')).toHaveText(['14', '15', '16']);
    await expect(page.locator('#toolbar-title')).toHaveText('14.–16. Mai 2037');

    // The views a phone can use, at the bottom of the screen; the seven-column weeks and the list are not offered.
    const tabs = page.locator('.view-tabs');
    const tabsBox = await tabs.boundingBox();
    expect(Math.abs(tabsBox.y + tabsBox.height - viewport.height)).toBeLessThan(1);
    expect(tabsBox.width).toBeGreaterThan(viewport.width - 1);
    await expect(page.locator('.view-tab:visible')).toHaveText(['Monat', '3 Tage', 'Tag', 'Agenda', 'Aufgaben']);
    // The calendar is not covered by the bar.
    const calBox = await page.locator('#calendar-container').boundingBox();
    expect(calBox.y + calBox.height).toBeLessThanOrEqual(tabsBox.y + 1);

    // The floating button sits above the bar, inside the screen.
    const fab = page.locator('#fab-new-event');
    await expect(fab).toBeVisible();
    const fabBox = await fab.boundingBox();
    expect(fabBox.y + fabBox.height).toBeLessThanOrEqual(tabsBox.y);
    expect(fabBox.x + fabBox.width).toBeLessThanOrEqual(viewport.width);

    const small = await page.evaluate(() => Array.from(document.querySelectorAll(
      '.toolbar button, .toolbar input, .view-tab, #fab-new-event'))
      .filter(el => el.offsetParent !== null)
      .map(el => ({ id: el.id || el.className, ...el.getBoundingClientRect().toJSON() }))
      .filter(r => r.width < 44 || r.height < 44)
      .map(r => `${r.id} ${Math.round(r.width)}×${Math.round(r.height)}`));
    expect(small).toEqual([]);

    // Tapping a tab in the bar switches the view.
    await page.locator('#view-day').tap();
    await expect(page.locator('.day-view')).toBeVisible();
    await page.locator('#view-agenda').tap();
    await expect(page.locator('.agenda-view')).toBeVisible();
  });

  test('#351 a horizontal swipe changes the period, a vertical one does not', async ({ page }) => {
    await open(page);
    const width = page.viewportSize().width;
    const title = page.locator('#toolbar-title');
    await expect(title).toHaveText('14.–16. Mai 2037');

    await swipe(page, width - 40, 40);
    await expect(title).toHaveText('17.–19. Mai 2037');
    await expect(page.locator('.week-view .week-day-num')).toHaveText(['17', '18', '19']);
    await swipe(page, 40, width - 40);
    await expect(title).toHaveText('14.–16. Mai 2037');
    await swipe(page, 40, width - 40);
    await expect(title).toHaveText('11.–13. Mai 2037');

    // In the day view one swipe is one day.
    await page.locator('#view-day').tap();
    await expect(title).toHaveText('Mo, 11. Mai 2037');
    await swipe(page, width - 40, 40);
    await expect(title).toHaveText('Di, 12. Mai 2037');

    // Scrolling the hours is no swipe.
    await swipe(page, width / 2, width / 2 + 30, -200);
    await page.waitForTimeout(500);
    await expect(title).toHaveText('Di, 12. Mai 2037');
  });

  test('#351 the floating button creates an event in a full-screen sheet, and a tap opens it', async ({ page, e2eUser }) => {
    await open(page);
    const viewport = page.viewportSize();
    const calendarId = `internal-caldav::/${e2eUser}/personal/`;
    await expect.poll(async () => (await (await page.request.get('/api/calendars')).json()).calendars.map(c => c.id),
      { timeout: 10000 }).toContain(calendarId);

    await page.locator('#fab-new-event').tap();
    const modal = page.locator('#event-modal');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(modal).toBeVisible();
    // Wait for the open animation before measuring the sheet.
    await expect.poll(async () => {
      const b = await modal.boundingBox();
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
    }).toEqual([0, 0, viewport.width, viewport.height]);
    const save = page.locator('#event-save-btn');
    await expect(save).toBeInViewport();
    expect((await save.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect((await page.locator('#event-modal-close').boundingBox()).height).toBeGreaterThanOrEqual(44);

    await page.fill('#ev-title', 'E2E 351 Phone');
    await page.selectOption('#ev-calendar', calendarId);
    await save.tap();
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);

    const res = await page.request.get('/api/events?start=2037-05-01T00:00:00Z&end=2037-06-01T00:00:00Z', { headers: SAME_ORIGIN });
    const created = (await res.json()).events.filter(e => e.title === 'E2E 351 Phone');
    expect(created).toHaveLength(1);

    // The new event shows in the three days and opens as a sheet along the bottom edge.
    const block = page.locator('.week-view [data-event-uid]', { hasText: 'E2E 351 Phone' });
    await expect(block).toBeVisible({ timeout: 10000 });
    await block.tap();
    const popover = page.locator('#event-popover');
    await expect(popover).not.toHaveClass(/hidden/);
    await expect(popover.locator('.popover-title')).toHaveText('E2E 351 Phone');
    const pop = await popover.boundingBox();
    expect(Math.round(pop.x)).toBe(0);
    expect(Math.round(pop.width)).toBe(viewport.width);
    expect(Math.abs(pop.y + pop.height - viewport.height)).toBeLessThan(1);
  });
});

test('#351 the desktop keeps the month view, the toolbar tabs and no floating button', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop project only');
  await open(page);
  await expect(page.locator('#view-month')).toHaveClass(/active/);
  await expect(page.locator('.month-view')).toBeVisible();
  await expect(page.locator('#fab-new-event')).toBeHidden();
  const tabs = await page.locator('.view-tabs').boundingBox();
  const toolbar = await page.locator('.toolbar').boundingBox();
  expect(tabs.y + tabs.height).toBeLessThanOrEqual(toolbar.y + toolbar.height);
  await expect(page.locator('.view-tab:visible')).toHaveCount(8);
});
