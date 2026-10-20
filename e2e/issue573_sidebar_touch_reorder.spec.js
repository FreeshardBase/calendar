const { devices } = require('@playwright/test');
const { test, expect } = require('./fixtures.js');

// Issue #573: the sidebar reorder of #504 on a phone. A touch only drags on an entry's grip
// (touch-action: none there), so a swipe elsewhere keeps scrolling the sidebar; tapping the grip
// opens a menu with "Nach oben" / "Nach unten", which needs no dragging at all. Every order is
// checked again after a reload, i.e. as the server stored it.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

// A phone with touch in every project this file runs in.
const { defaultBrowserType, ...pixel7 } = devices['Pixel 7']; // eslint-disable-line no-unused-vars
test.use(pixel7);

const sessions = new WeakMap();
async function cdpOf(page) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  return sessions.get(page);
}

const item = (page, id) => page.locator(`#calendar-list [data-cal-id="${id}"]`);
const handle = (page, id) => item(page, id).locator('.sidebar-order-handle');
const sidebarOrder = (page, ids) => page.locator('#calendar-list [data-cal-id]')
  .evaluateAll((els, wanted) => els.map(el => el.dataset.calId).filter(id => wanted.includes(id)), ids);

async function openSidebar(page) {
  await page.addInitScript(() => {
    if (window.origin === 'null') return;
    window.localStorage.setItem('welcome-popup-closed', 'true');
  });
  await page.goto('/');
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 10000 });
  await expect(page.locator('#calendar-list')).toContainText('E2E 573 C', { timeout: 10000 });
  await page.locator('#menu-btn').tap();
  await expect(page.locator('.sidebar')).toHaveClass(/\bopen\b/);
  // The sidebar slides in; the touch coordinates are measured once it rests.
  await expect.poll(async () => (await page.locator('.sidebar').boundingBox()).x).toBe(0);
}

// Three own calendars A, B, C in this order (the test's user is fresh, #592).
async function seedCalendars(page) {
  const ids = [];
  for (const letter of ['A', 'B', 'C']) {
    const res = await page.request.post('/api/calendars', {
      headers: SAME_ORIGIN,
      data: { accountId: 'internal-caldav', name: `E2E 573 ${letter}`, color: '#3366cc', type: 'calendar' },
    });
    expect(res.status()).toBe(201);
    ids.push((await res.json()).id);
  }
  const listed = await page.request.get('/api/calendars');
  expect(listed.status()).toBe(200);
  const others = (await listed.json()).calendars.map(cal => cal.id).filter(id => !ids.includes(id));
  const order = await page.request.put('/api/calendars/order', { headers: SAME_ORIGIN, data: { calendarIds: [...ids, ...others] } });
  expect(order.status()).toBe(200);
  return ids;
}

const orderSaved = page => page.waitForResponse(r => r.url().endsWith('/api/calendars/order') && r.request().method() === 'PUT');

test.describe('Issue #573 — the sidebar is reordered by touch and by the entry\'s menu', () => {
  test('#573 a finger drags an entry by its grip, the rest of the entry keeps scrolling; the order survives a reload', async ({ page }) => {
    const [a, b, c] = await seedCalendars(page);
    await openSidebar(page);
    await expect.poll(() => sidebarOrder(page, [a, b, c])).toEqual([a, b, c]);

    // The grip is a 44 px touch target and the only place a touch drags.
    const grip = await handle(page, c).boundingBox();
    expect(grip.width).toBeGreaterThanOrEqual(44);
    expect(grip.height).toBeGreaterThanOrEqual(44);
    expect(await handle(page, c).evaluate(el => getComputedStyle(el).touchAction)).toBe('none');
    expect(await item(page, c).evaluate(el => getComputedStyle(el).touchAction)).not.toBe('none');

    const cdp = await cdpOf(page);
    // A finger stroke from the middle of `start` (left edge + dx) up to the top edge of A.
    const stroke = async (start, dx) => {
      const box = await start.boundingBox();
      const to = await item(page, a).boundingBox();
      const from = { x: dx === undefined ? box.x + box.width / 2 : box.x + dx, y: box.y + box.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
          x: from.x, y: from.y + (to.y + 3 - from.y) * i / steps }] });
      }
    };

    // The same stroke on the entry's name is a swipe: nothing is dragged, nothing saved.
    const puts = [];
    page.on('request', r => { if (r.url().endsWith('/api/calendars/order') && r.method() === 'PUT') puts.push(r); });
    await stroke(item(page, c).locator('.calendar-name'), 10);
    await expect(item(page, c)).not.toHaveClass(/\bdragging\b/);
    await expect(page.locator('#calendar-list .drop-before, #calendar-list .drop-after')).toHaveCount(0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
    expect(puts).toEqual([]);
    expect(await sidebarOrder(page, [a, b, c])).toEqual([a, b, c]);

    const saved = orderSaved(page);
    await stroke(handle(page, c));
    await expect(item(page, c)).toHaveClass(/\bdragging\b/);
    await expect(item(page, a)).toHaveClass(/\bdrop-before\b/);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect((await saved).status()).toBe(200);
    await expect.poll(() => sidebarOrder(page, [a, b, c])).toEqual([c, a, b]);
    // The drop toggled no calendar.
    await expect(item(page, c)).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#sidebar-order-menu')).toBeHidden();

    await page.reload();
    await openSidebar(page);
    await expect.poll(() => sidebarOrder(page, [a, b, c])).toEqual([c, a, b]);
  });

  test('#573 "Nach oben" / "Nach unten" in the entry\'s menu reorder within the group; the order survives a reload', async ({ page }) => {
    const [a, b, c] = await seedCalendars(page);
    await openSidebar(page);
    await expect.poll(() => sidebarOrder(page, [a, b, c])).toEqual([a, b, c]);

    // The grip is a menu button named after its calendar.
    await expect(handle(page, c)).toHaveAttribute('aria-haspopup', 'menu');
    await expect(handle(page, c)).toHaveAccessibleName('„E2E 573 C“ verschieben');

    let saved = orderSaved(page);
    await handle(page, c).tap();
    const menu = page.getByRole('menu', { name: '„E2E 573 C“ verschieben' });
    await expect(menu).toBeVisible();
    await expect(handle(page, c)).toHaveAttribute('aria-expanded', 'true');
    await menu.getByRole('menuitem', { name: 'Nach oben' }).tap();
    expect((await saved).status()).toBe(200);
    await expect.poll(() => sidebarOrder(page, [a, b, c])).toEqual([a, c, b]);
    await expect(menu).toBeHidden();
    // Opening the menu toggled no calendar; focus is back on the moved entry's grip.
    await expect(item(page, c)).toHaveAttribute('aria-checked', 'true');
    await expect(handle(page, c)).toBeFocused();

    // A from the top down, by keyboard: Enter opens the menu on its first item.
    saved = orderSaved(page);
    await handle(page, a).focus();
    await page.keyboard.press('Enter');
    const menuA = page.getByRole('menu', { name: '„E2E 573 A“ verschieben' });
    await expect(menuA.getByRole('menuitem', { name: 'Nach oben' })).toBeDisabled();
    await menuA.getByRole('menuitem', { name: 'Nach unten' }).focus();
    await page.keyboard.press('Enter');
    expect((await saved).status()).toBe(200);
    await expect.poll(() => sidebarOrder(page, [a, b, c])).toEqual([c, a, b]);

    // Escape closes the menu without a move.
    await handle(page, b).tap();
    await expect(page.getByRole('menu', { name: '„E2E 573 B“ verschieben' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#sidebar-order-menu')).toBeHidden();
    await expect(handle(page, b)).toBeFocused();

    await page.reload();
    await openSidebar(page);
    await expect.poll(() => sidebarOrder(page, [a, b, c])).toEqual([c, a, b]);
  });
});
