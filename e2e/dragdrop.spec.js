const { test, expect } = require('./fixtures.js');
const { mockEvents } = require('./mocks.js');

// Issue #574: drag and drop of events in the day and week view. Runs in the desktop project
// ('chromium', mouse) and in the phone project ('mobile-touch', hasTouch: a drag starts with a
// long press). Every drop is checked through the API: the stored DTSTART/DTEND, not the DOM.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const DAY = '2037-05-14'; // a Thursday; the browser runs in Europe/Berlin (UTC+2 in May)

const isTouch = () => test.info().project.name === 'mobile-touch';

// The app opens in the month view; once the event shows there, the start-up loads are done.
async function openView(page, view, title) {
  await page.goto(`/?date=${DAY}`);
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  await expect(page.locator('.month-view [data-event-uid]', { hasText: title }).first()).toBeVisible({ timeout: 10000 });
  await page.click(`#view-${view}`);
  await expect(page.locator(view === 'day' ? '.day-view' : '.week-view')).toBeVisible();
}

async function ownCalendar(page, user) {
  const calendarId = `internal-caldav::/${user}/personal/`;
  await expect.poll(async () => (await (await page.request.get('/api/calendars')).json()).calendars.map(c => c.id),
    { timeout: 10000 }).toContain(calendarId);
  return calendarId;
}

async function seed(page, data) {
  const res = await page.request.post('/api/events', { headers: SAME_ORIGIN, data });
  expect(res.status()).toBe(201);
  return res.json();
}

// The stored event(s) with this title, start/end as UTC ISO strings.
async function stored(page, title) {
  const res = await page.request.get('/api/events?start=2037-05-01T00:00:00Z&end=2037-06-01T00:00:00Z');
  const { events } = await res.json();
  return events.filter(e => e.title === title)
    .map(e => ({ ...e, start: e.allDay ? String(e.start).slice(0, 10) : new Date(e.start).toISOString(),
      end: e.allDay ? String(e.end).slice(0, 10) : new Date(e.end).toISOString() }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

async function expectStored(page, title, start, end) {
  await expect.poll(async () => (await stored(page, title)).map(e => [e.start, e.end])[0], { timeout: 15000 })
    .toEqual([start, end]);
}

// One CDP session per page: a touch sequence must stay on the session that started it.
const sessions = new WeakMap();
async function cdpOf(page) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  return sessions.get(page);
}

const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

// Press on `from`, move to `to` in steps and (unless `release` is false) let go. Touch holds still
// for the long press first; the mouse just moves past the threshold.
async function drag(page, from, to, { release = true, alt = false } = {}) {
  const steps = 10;
  if (isTouch()) {
    const cdp = await cdpOf(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    await page.waitForTimeout(600);
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
        x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }] });
    }
    if (release) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return;
  }
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(to.x, to.y, { steps });
  if (release) await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}

async function dragBy(page, locator, dx, dy, opts) {
  const box = await locator.boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 12) };
  await drag(page, from, { x: from.x + dx, y: from.y + dy }, opts);
}

test.describe('Issue #574 — move and resize events by drag and drop', () => {
  let calendarId;
  let puts;

  test.beforeEach(async ({ page, e2eUser }) => {
    await page.addInitScript(() => {
      if (window.origin !== 'null') window.localStorage.setItem('welcome-popup-closed', 'true');
    });
    puts = [];
    page.on('request', r => {
      if (r.method() === 'PUT' && new URL(r.url()).pathname.startsWith('/api/events/')) puts.push(r.postDataJSON());
    });
    await page.goto('/');
    calendarId = await ownCalendar(page, e2eUser);
  });

  test('#574 moving a timed event snaps to the 15-minute grid and is stored', async ({ page }) => {
    await seed(page, { calendarId, title: 'E2E 574 Move', start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:00:00.000Z` });
    await openView(page, 'day', 'E2E 574 Move');
    const block = page.locator('.event-block', { hasText: 'E2E 574 Move' });
    await expect(block).toBeVisible({ timeout: 10000 });
    await expect(block.locator('.event-resize-handle')).toHaveCount(2);

    // 60 px per hour: 97 px down from 10:00 is 11:37, which snaps to 11:30 (Berlin).
    await dragBy(page, block, 0, 97);
    await expectStored(page, 'E2E 574 Move', `${DAY}T09:30:00.000Z`, `${DAY}T10:30:00.000Z`);
    // No attendees: no notification question.
    await expect(page.locator('#notify-dialog-backdrop')).toHaveClass(/hidden/);
    await expect(page.locator('#undo-bar')).toBeVisible();
    await expect(page.locator('#undo-bar')).toContainText('Verschoben');
    expect(puts).toHaveLength(1);
  });

  test('#574 the top edge changes the start and the bottom edge the end', async ({ page }) => {
    await seed(page, { calendarId, title: 'E2E 574 Resize', start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:00:00.000Z` });
    await openView(page, 'day', 'E2E 574 Resize');
    const block = page.locator('.event-block', { hasText: 'E2E 574 Resize' });
    await expect(block).toBeVisible({ timeout: 10000 });

    await drag(page, center(await block.locator('.event-resize-handle.bottom').boundingBox()),
      { x: center(await block.boundingBox()).x, y: (await block.boundingBox()).y + 60 + 60 });
    await expectStored(page, 'E2E 574 Resize', `${DAY}T08:00:00.000Z`, `${DAY}T10:00:00.000Z`);
    await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });

    const top = center(await block.locator('.event-resize-handle.top').boundingBox());
    await drag(page, top, { x: top.x, y: top.y - 30 });
    await expectStored(page, 'E2E 574 Resize', `${DAY}T07:30:00.000Z`, `${DAY}T10:00:00.000Z`);
  });

  test('#574 week view: an event moves to another day; Alt drops minute-exact', async ({ page }) => {
    test.skip(isTouch(), 'Alt and the seven-column week are desktop input');
    await seed(page, { calendarId, title: 'E2E 574 Week', start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:00:00.000Z` });
    await openView(page, 'week', 'E2E 574 Week');
    const block = page.locator('.event-block', { hasText: 'E2E 574 Week' });
    await expect(block).toBeVisible({ timeout: 10000 });
    const colW = (await page.locator('.week-day-col').first().boundingBox()).width;

    await dragBy(page, block, colW, 0);
    await expectStored(page, 'E2E 574 Week', '2037-05-15T08:00:00.000Z', '2037-05-15T09:00:00.000Z');
    await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });

    await dragBy(page, block, 0, 7, { alt: true });
    await expectStored(page, 'E2E 574 Week', '2037-05-15T08:07:00.000Z', '2037-05-15T09:07:00.000Z');
  });

  test('#574 all-day events move and stretch by days in the all-day row', async ({ page }) => {
    test.skip(isTouch(), 'the phone shows one day; day changes need the week columns');
    await seed(page, { calendarId, title: 'E2E 574 AllDay', allDay: true, start: DAY, end: '2037-05-15' });
    await openView(page, 'week', 'E2E 574 AllDay');
    const chip = page.locator('.all-day-events .event-chip', { hasText: 'E2E 574 AllDay' });
    await expect(chip).toHaveCount(1, { timeout: 10000 });
    const colW = (await page.locator('.week-day-col').first().boundingBox()).width;

    await dragBy(page, chip, -colW, 0);
    await expectStored(page, 'E2E 574 AllDay', '2037-05-13', '2037-05-14');
    await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });

    const end = center(await chip.locator('.event-resize-handle.end').boundingBox());
    await drag(page, end, { x: end.x + 2 * colW, y: end.y });
    await expectStored(page, 'E2E 574 AllDay', '2037-05-13', '2037-05-16');
  });

  test('#574 an all-day event dropped in the time grid becomes one hour, and back', async ({ page }) => {
    await seed(page, { calendarId, title: 'E2E 574 Convert', allDay: true, start: DAY, end: '2037-05-15' });
    await openView(page, 'day', 'E2E 574 Convert');
    const chip = page.locator('.all-day-events .event-chip', { hasText: 'E2E 574 Convert' });
    await expect(chip).toBeVisible({ timeout: 10000 });
    const body = page.locator('.day-grid-body');
    await body.evaluate(el => { el.scrollTop = 8 * 60 - 30; });
    const col = await page.locator('.week-day-col').first().boundingBox();
    const bodyBox = await body.boundingBox();
    // The grid shows 07:30 at its top edge; 14:00 is 390 px further down.
    const y14 = bodyBox.y + 30 + 6 * 60 + 5;
    await drag(page, center(await chip.boundingBox()), { x: col.x + col.width / 2, y: y14 });
    await expectStored(page, 'E2E 574 Convert', `${DAY}T12:00:00.000Z`, `${DAY}T13:00:00.000Z`);
    await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });

    const block = page.locator('.event-block', { hasText: 'E2E 574 Convert' });
    await expect(block).toBeVisible();
    const header = await page.locator('.week-day-header').first().boundingBox();
    await drag(page, center(await block.boundingBox()), { x: header.x + header.width / 2, y: header.y + header.height / 2 });
    await expectStored(page, 'E2E 574 Convert', DAY, '2037-05-15');
    expect((await stored(page, 'E2E 574 Convert'))[0].allDay).toBe(true);
  });

  test('#574 Esc and the cancel zone abort a drag; Rückgängig restores the drop', async ({ page }) => {
    await seed(page, { calendarId, title: 'E2E 574 Cancel', start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:00:00.000Z` });
    await openView(page, 'day', 'E2E 574 Cancel');
    const block = page.locator('.event-block', { hasText: 'E2E 574 Cancel' });
    await expect(block).toBeVisible({ timeout: 10000 });

    if (!isTouch()) {
      await dragBy(page, block, 0, 120, { release: false });
      await expect(page.locator('#drag-cancel-zone')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await expect(page.locator('#drag-cancel-zone')).toBeHidden();
      await expect(page.locator('#undo-bar')).toBeHidden();
    }

    // The cancel zone appears at the top while dragging; letting go over it changes nothing.
    const from = center(await block.boundingBox());
    await drag(page, from, { x: from.x, y: from.y + 60 }, { release: false });
    const zone = page.locator('#drag-cancel-zone');
    await expect(zone).toBeVisible();
    await expect(zone).toHaveText(/Abbrechen/);
    const z = center(await zone.boundingBox());
    if (isTouch()) {
      const cdp = await cdpOf(page);
      for (let i = 1; i <= 10; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
          x: from.x + (z.x - from.x) * i / 10, y: from.y + 60 + (z.y - from.y - 60) * i / 10 }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.mouse.move(z.x, z.y, { steps: 10 });
      await page.mouse.up();
    }
    await expect(zone).toBeHidden();
    await expect(page.locator('#undo-bar')).toBeHidden();
    expect(puts).toHaveLength(0);
    await expectStored(page, 'E2E 574 Cancel', `${DAY}T08:00:00.000Z`, `${DAY}T09:00:00.000Z`);

    // A real drop, then Rückgängig: the stored event is back where it was.
    await dragBy(page, block, 0, 120);
    await expectStored(page, 'E2E 574 Cancel', `${DAY}T10:00:00.000Z`, `${DAY}T11:00:00.000Z`);
    await page.locator('#undo-bar button', { hasText: 'Rückgängig' }).click();
    await expectStored(page, 'E2E 574 Cancel', `${DAY}T08:00:00.000Z`, `${DAY}T09:00:00.000Z`);
    await expect(page.locator('#undo-bar')).toBeHidden();
  });

  test('#574 a recurring event asks for the scope; cancelling puts it back', async ({ page }) => {
    await seed(page, { calendarId, title: 'E2E 574 Series', start: '2037-05-13T08:00:00.000Z', end: '2037-05-13T09:00:00.000Z',
      recurrence: 'FREQ=DAILY;COUNT=3' });
    await openView(page, 'day', 'E2E 574 Series');
    const block = page.locator('.event-block', { hasText: 'E2E 574 Series' });
    await expect(block).toBeVisible({ timeout: 10000 });

    await dragBy(page, block, 0, 60);
    await expect(page.locator('#scope-dialog-backdrop')).not.toHaveClass(/hidden/);
    await page.click('#scope-cancel-btn');
    await expect(page.locator('#scope-dialog-backdrop')).toHaveClass(/hidden/);
    await expect(block).toContainText('10:00');
    expect(puts).toHaveLength(0);

    await dragBy(page, block, 0, 60);
    await page.click('#scope-occurrence-btn');
    await expect.poll(async () => (await stored(page, 'E2E 574 Series')).map(e => e.start), { timeout: 15000 })
      .toEqual(['2037-05-13T08:00:00.000Z', `${DAY}T09:00:00.000Z`, '2037-05-15T08:00:00.000Z']);
  });

  test('#574 with attendees the drop asks whether to inform them', async ({ page }) => {
    const attendee = { name: 'Test User', email: 'testuser@example.com', status: 'ACCEPTED' };
    await seed(page, { calendarId, title: 'E2E 574 Meeting', start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:00:00.000Z`,
      attendees: [attendee] });
    await openView(page, 'day', 'E2E 574 Meeting');
    const block = page.locator('.event-block', { hasText: 'E2E 574 Meeting' });
    await expect(block).toBeVisible({ timeout: 10000 });

    // "Nein": moved, the attendee's answer stays.
    await dragBy(page, block, 0, 60);
    await expect(page.locator('#notify-dialog-text')).toHaveText('Teilnehmer über die Änderung informieren?');
    await page.click('#notify-no-btn');
    await expectStored(page, 'E2E 574 Meeting', `${DAY}T09:00:00.000Z`, `${DAY}T10:00:00.000Z`);
    expect((await stored(page, 'E2E 574 Meeting'))[0].attendees[0].status).toBe('ACCEPTED');
    await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });

    // "Ja": the attendee is asked again (PARTSTAT back to NEEDS-ACTION, so it is an open invitation).
    await dragBy(page, block, 0, 60);
    await page.click('#notify-yes-btn');
    await expectStored(page, 'E2E 574 Meeting', `${DAY}T10:00:00.000Z`, `${DAY}T11:00:00.000Z`);
    expect((await stored(page, 'E2E 574 Meeting'))[0].attendees[0].status).toBe('NEEDS-ACTION');
  });

  test('#574 touch: a swipe without long press scrolls and does not move the event', async ({ page }) => {
    test.skip(!isTouch(), 'long press is the touch gesture');
    await seed(page, { calendarId, title: 'E2E 574 Swipe', start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:00:00.000Z` });
    await openView(page, 'day', 'E2E 574 Swipe');
    const block = page.locator('.event-block', { hasText: 'E2E 574 Swipe' });
    await expect(block).toBeVisible({ timeout: 10000 });
    const body = page.locator('.day-grid-body');
    const scrollBefore = await body.evaluate(el => el.scrollTop);
    const from = center(await block.boundingBox());
    const cdp = await cdpOf(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y - 12 * i }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('#drag-cancel-zone')).toBeHidden();
    await expect.poll(() => body.evaluate(el => el.scrollTop)).toBeGreaterThan(scrollBefore);
    await page.waitForTimeout(500);
    expect(puts).toHaveLength(0);
    await expectStored(page, 'E2E 574 Swipe', `${DAY}T08:00:00.000Z`, `${DAY}T09:00:00.000Z`);
  });

  test('#574 a read-only event has no handles and does not move', async ({ page }) => {
    await mockEvents(page, [{ uid: 'e2e-574-ro', title: 'E2E 574 Fremd', calendarId, readOnly: true,
      start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:00:00.000Z`, allDay: false,
      organizer: { name: 'Test User', email: 'testuser@example.com' } }]);
    await openView(page, 'day', 'E2E 574 Fremd');
    const block = page.locator('.event-block', { hasText: 'E2E 574 Fremd' });
    await expect(block).toBeVisible({ timeout: 10000 });
    await expect(block.locator('.event-resize-handle')).toHaveCount(0);
    await dragBy(page, block, 0, 120);
    await expect(page.locator('.toast', { hasText: 'Nur lesbar: Termin von Test User' })).toBeVisible();
    await expect(page.locator('#drag-cancel-zone')).toBeHidden();
    await expect(block).toContainText('10:00');
    expect(puts).toHaveLength(0);
  });

  test('#574 a failed save (409) rolls the event back with an error toast', async ({ page }) => {
    await seed(page, { calendarId, title: 'E2E 574 Conflict', start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:00:00.000Z` });
    await page.route(url => url.pathname.startsWith('/api/events/'), route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 409, json: { error: 'Conflict' } }) : route.fallback());
    await openView(page, 'day', 'E2E 574 Conflict');
    const block = page.locator('.event-block', { hasText: 'E2E 574 Conflict' });
    await expect(block).toBeVisible({ timeout: 10000 });
    await dragBy(page, block, 0, 120);
    await expect(page.locator('.toast.error', { hasText: 'Konflikt' })).toBeVisible({ timeout: 10000 });
    await expect(block).toContainText('10:00');
    await expect(page.locator('.event-pending')).toHaveCount(0);
    await expect(page.locator('#undo-bar')).toBeHidden();
    await expectStored(page, 'E2E 574 Conflict', `${DAY}T08:00:00.000Z`, `${DAY}T09:00:00.000Z`);
  });
});
