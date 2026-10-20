const { test, expect } = require('./fixtures.js');
const { mockEvents } = require('./mocks.js');

// Issue #574: drag and drop of events in the day and week view. Runs in the desktop project
// ('chromium', mouse) and in the phone project ('mobile-touch', hasTouch: a drag starts with a
// long press). Every drop is checked through the API: the stored DTSTART/DTEND, not the DOM.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const DAY = '2037-05-14'; // a Thursday; the browser runs in Europe/Berlin (UTC+2 in May)

const isTouch = () => test.info().project.name === 'mobile-touch';

// Opens the app on DAY in the month view; once the event shows there, the start-up loads are done.
// A phone opens in three days (#351) and is switched to the month first.
async function openMonthView(page, title) {
  await page.goto(`/?date=${DAY}`);
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
  if (isTouch()) {
    await expect(page.locator('.week-view')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 10000 });
    await page.click('#view-month');
  }
  await expect(page.locator('.month-view [data-event-uid]', { hasText: title }).first()).toBeVisible({ timeout: 10000 });
}

async function openView(page, view, title) {
  await openMonthView(page, title);
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

// Issue #575: the month view moves events by whole days and keeps the time of day; the first and
// last chip of a multi-day event carry the start and end edge. Same engine and cancel paths as #574.
test.describe('Issue #575 — month view: move events and change multi-day spans', () => {
  let calendarId;
  let puts;

  // The cell of a day of May 2037 in the month view.
  const cell = (page, day) => page.locator('.month-day:not(.other-month)').nth(day - 1);
  const chipIn = (page, day, title) => cell(page, day).locator('.event-chip', { hasText: title });

  async function openMonth(page, title) {
    await openMonthView(page, title);
    // The loading screen fades out over the month view; until it is gone it takes the pointer.
    await expect(page.locator('#loading-screen')).toBeHidden();
  }

  // Grab `from` (a locator or a point) and let go near the bottom of the cell of `day`.
  async function dropOnDay(page, from, day, opts) {
    const start = typeof from.boundingBox === 'function' ? center(await from.boundingBox()) : from;
    const box = await cell(page, day).boundingBox();
    await drag(page, start, { x: box.x + box.width / 2, y: box.y + box.height - 8 }, opts);
  }

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

  test('#575 an event dropped on another day keeps its time of day', async ({ page }) => {
    await seed(page, { calendarId, title: 'E2E 575 Move', start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:30:00.000Z` });
    await openMonth(page, 'E2E 575 Move');
    // A one-day event has no edges in the month view.
    await expect(chipIn(page, 14, 'E2E 575 Move').locator('.event-resize-handle')).toHaveCount(0);

    await dropOnDay(page, chipIn(page, 14, 'E2E 575 Move'), 19);
    await expectStored(page, 'E2E 575 Move', '2037-05-19T08:00:00.000Z', '2037-05-19T09:30:00.000Z');
    await expect(page.locator('#undo-bar')).toBeVisible();
    await expect(chipIn(page, 19, 'E2E 575 Move')).toBeVisible();
    // The drop opens neither the event nor the create dialog.
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
    expect(puts).toHaveLength(1);
  });

  test('#575 the edges of a multi-day timed event change its first and last day, times stay', async ({ page }) => {
    await seed(page, { calendarId, title: 'E2E 575 Span', start: `${DAY}T08:00:00.000Z`, end: '2037-05-16T10:00:00.000Z' });
    await openMonth(page, 'E2E 575 Span');
    await expect(chipIn(page, 14, 'E2E 575 Span').locator('.event-resize-handle')).toHaveCount(1);
    await expect(chipIn(page, 14, 'E2E 575 Span').locator('.event-resize-handle.start')).toHaveCount(1);
    await expect(chipIn(page, 15, 'E2E 575 Span').locator('.event-resize-handle')).toHaveCount(0);
    await expect(chipIn(page, 16, 'E2E 575 Span').locator('.event-resize-handle.end')).toHaveCount(1);

    await dropOnDay(page, center(await chipIn(page, 16, 'E2E 575 Span').locator('.event-resize-handle.end').boundingBox()), 20);
    await expectStored(page, 'E2E 575 Span', `${DAY}T08:00:00.000Z`, '2037-05-20T10:00:00.000Z');
    await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });

    await dropOnDay(page, center(await chipIn(page, 14, 'E2E 575 Span').locator('.event-resize-handle.start').boundingBox()), 11);
    await expectStored(page, 'E2E 575 Span', '2037-05-11T08:00:00.000Z', '2037-05-20T10:00:00.000Z');
  });

  test('#575 a multi-day all-day event moves as a whole and its end edge stretches it', async ({ page }) => {
    await seed(page, { calendarId, title: 'E2E 575 Trip', allDay: true, start: DAY, end: '2037-05-17' });
    await openMonth(page, 'E2E 575 Trip');

    // Grabbed on its middle day and dropped two days later: every day shifts by two.
    await dropOnDay(page, chipIn(page, 15, 'E2E 575 Trip'), 17);
    await expectStored(page, 'E2E 575 Trip', '2037-05-16', '2037-05-19');
    expect((await stored(page, 'E2E 575 Trip'))[0].allDay).toBe(true);
    await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });

    await dropOnDay(page, center(await chipIn(page, 18, 'E2E 575 Trip').locator('.event-resize-handle.end').boundingBox()), 21);
    await expectStored(page, 'E2E 575 Trip', '2037-05-16', '2037-05-22');
  });

  test('#575 Esc and the cancel zone abort a month drag; Rückgängig restores the drop', async ({ page }) => {
    await seed(page, { calendarId, title: 'E2E 575 Cancel', start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:00:00.000Z` });
    await openMonth(page, 'E2E 575 Cancel');
    const zone = page.locator('#drag-cancel-zone');

    if (!isTouch()) {
      await dropOnDay(page, chipIn(page, 14, 'E2E 575 Cancel'), 20, { release: false });
      await expect(zone).toBeVisible();
      await expect(cell(page, 20)).toHaveClass(/drop-target/);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await expect(zone).toBeHidden();
      await expect(page.locator('#undo-bar')).toBeHidden();
    }

    const from = center(await chipIn(page, 14, 'E2E 575 Cancel').boundingBox());
    await drag(page, from, { x: from.x, y: from.y + 40 }, { release: false });
    await expect(zone).toBeVisible();
    const z = center(await zone.boundingBox());
    if (isTouch()) {
      const cdp = await cdpOf(page);
      for (let i = 1; i <= 10; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
          x: from.x + (z.x - from.x) * i / 10, y: from.y + 40 + (z.y - from.y - 40) * i / 10 }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.mouse.move(z.x, z.y, { steps: 10 });
      await page.mouse.up();
    }
    await expect(zone).toBeHidden();
    await expect(page.locator('#undo-bar')).toBeHidden();
    expect(puts).toHaveLength(0);
    await expectStored(page, 'E2E 575 Cancel', `${DAY}T08:00:00.000Z`, `${DAY}T09:00:00.000Z`);

    await dropOnDay(page, chipIn(page, 14, 'E2E 575 Cancel'), 21);
    await expectStored(page, 'E2E 575 Cancel', '2037-05-21T08:00:00.000Z', '2037-05-21T09:00:00.000Z');
    await page.locator('#undo-bar button', { hasText: 'Rückgängig' }).click();
    await expectStored(page, 'E2E 575 Cancel', `${DAY}T08:00:00.000Z`, `${DAY}T09:00:00.000Z`);
    await expect(page.locator('#undo-bar')).toBeHidden();
  });

  test('#575 a recurring event in the month view asks for the scope', async ({ page }) => {
    await seed(page, { calendarId, title: 'E2E 575 Series', start: '2037-05-13T08:00:00.000Z', end: '2037-05-13T09:00:00.000Z',
      recurrence: 'FREQ=DAILY;COUNT=2' });
    await openMonth(page, 'E2E 575 Series');

    await dropOnDay(page, chipIn(page, 14, 'E2E 575 Series'), 20);
    await expect(page.locator('#scope-dialog-backdrop')).not.toHaveClass(/hidden/);
    await page.click('#scope-cancel-btn');
    await expect(chipIn(page, 14, 'E2E 575 Series')).toBeVisible();
    expect(puts).toHaveLength(0);

    await dropOnDay(page, chipIn(page, 14, 'E2E 575 Series'), 20);
    await page.click('#scope-occurrence-btn');
    await expect.poll(async () => (await stored(page, 'E2E 575 Series')).map(e => e.start), { timeout: 15000 })
      .toEqual(['2037-05-13T08:00:00.000Z', '2037-05-20T08:00:00.000Z']);
  });

  test('#575 a read-only event in the month view has no edges and does not move', async ({ page }) => {
    await mockEvents(page, [{ uid: 'e2e-575-ro', title: 'E2E 575 Fremd', calendarId, readOnly: true,
      start: `${DAY}T08:00:00.000Z`, end: '2037-05-16T09:00:00.000Z', allDay: false,
      organizer: { name: 'Test User', email: 'testuser@example.com' } }]);
    await openMonth(page, 'E2E 575 Fremd');
    await expect(page.locator('.month-view .event-resize-handle')).toHaveCount(0);
    await dropOnDay(page, chipIn(page, 14, 'E2E 575 Fremd'), 20);
    await expect(page.locator('.toast', { hasText: 'Nur lesbar: Termin von Test User' })).toBeVisible();
    await expect(page.locator('#drag-cancel-zone')).toBeHidden();
    await expect(chipIn(page, 20, 'E2E 575 Fremd')).toHaveCount(0);
    expect(puts).toHaveLength(0);
  });
});

// Issue #576: dragging on empty space draws a range and opens the new-event dialog with it. Day and
// week view: a timed range in the 15-minute grid of the column it starts in. Month view: an all-day
// event from the first to the last day dragged across. A plain click opens the dialog on its
// 15-minute slot. Esc, the cancel zone and closing the dialog create nothing.
test.describe('Issue #576 — create events by dragging on empty space', () => {
  let calendarId;
  let posts;

  const cell = (page, day) => page.locator('.month-day:not(.other-month)').nth(day - 1);

  // The point `min` minutes after midnight in the day view's column (60 px per hour).
  async function at(page, min) {
    const box = await page.locator('.day-view .week-day-col').boundingBox();
    return { x: box.x + box.width / 2, y: box.y + min };
  }

  async function openDay(page) {
    await seed(page, { calendarId, title: 'E2E 576 Anchor', start: `${DAY}T03:00:00.000Z`, end: `${DAY}T03:30:00.000Z` });
    await openView(page, 'day', 'E2E 576 Anchor');
    await expect(page.locator('#loading-screen')).toBeHidden();
  }

  async function release(page) {
    if (isTouch()) await (await cdpOf(page)).send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else await page.mouse.up();
  }

  async function saveAs(page, title) {
    await page.fill('#ev-title', title);
    await page.selectOption('#ev-calendar', calendarId);
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
  }

  test.beforeEach(async ({ page, e2eUser }) => {
    await page.addInitScript(() => {
      if (window.origin !== 'null') window.localStorage.setItem('welcome-popup-closed', 'true');
    });
    posts = 0;
    page.on('request', r => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/events') posts++;
    });
    await page.goto('/');
    calendarId = await ownCalendar(page, e2eUser);
  });

  test('#576 dragging in the day view opens the dialog with the 15-minute range and stores it', async ({ page }) => {
    await openDay(page);
    const before = posts;
    // 10:05 to 11:20 covers the slots 10:00 to 11:30 (Berlin, UTC+2).
    await drag(page, await at(page, 10 * 60 + 5), await at(page, 11 * 60 + 20));
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#event-modal-title')).toHaveText('Neuer Termin');
    await expect(page.locator('#ev-allday')).not.toBeChecked();
    await expect(page.locator('#ev-start-date')).toHaveValue(DAY);
    await expect(page.locator('#ev-start-time')).toHaveValue('10:00');
    await expect(page.locator('#ev-end-date')).toHaveValue(DAY);
    await expect(page.locator('#ev-end-time')).toHaveValue('11:30');
    expect(posts).toBe(before);

    await saveAs(page, 'E2E 576 Range');
    await expectStored(page, 'E2E 576 Range', `${DAY}T08:00:00.000Z`, `${DAY}T09:30:00.000Z`);
  });

  test('#576 dragging upwards gives the same kind of range', async ({ page }) => {
    await openDay(page);
    await drag(page, await at(page, 12 * 60 + 40), await at(page, 11 * 60 + 50));
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-start-time')).toHaveValue('11:45');
    await expect(page.locator('#ev-end-time')).toHaveValue('12:45');
  });

  test('#576 a plain click opens the dialog on its 15-minute slot', async ({ page }) => {
    await openDay(page);
    const point = await at(page, 10 * 60 + 40);
    if (isTouch()) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-start-time')).toHaveValue('10:30');
    await expect(page.locator('#ev-end-time')).toHaveValue('11:30');
  });

  test('#576 Esc, the cancel zone and closing the dialog create nothing', async ({ page }) => {
    await openDay(page);
    const before = posts;
    const zone = page.locator('#drag-cancel-zone');

    // Esc during the drag: the range is gone and no dialog opens.
    await drag(page, await at(page, 9 * 60), await at(page, 10 * 60), { release: false });
    await expect(zone).toBeVisible();
    await expect(page.locator('.day-view .drag-ghost')).toHaveText('09:00 – 10:00');
    await page.keyboard.press('Escape');
    await expect(page.locator('.day-view .drag-ghost')).toHaveCount(0);
    await release(page);
    await expect(zone).toBeHidden();
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);

    // Released over the cancel zone.
    await drag(page, await at(page, 9 * 60), await at(page, 10 * 60), { release: false });
    await expect(zone).toBeVisible();
    const z = center(await zone.boundingBox());
    if (isTouch()) {
      await (await cdpOf(page)).send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [z] });
    } else {
      await page.mouse.move(z.x, z.y, { steps: 5 });
    }
    await release(page);
    await expect(zone).toBeHidden();
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);

    // A drawn range whose dialog is closed.
    await drag(page, await at(page, 9 * 60), await at(page, 10 * 60));
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await page.click('#event-cancel-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
    await page.waitForTimeout(300);
    expect(posts).toBe(before);
  });

  test('#576 dragging across days in the month view opens the dialog for a multi-day event', async ({ page }) => {
    await seed(page, { calendarId, title: 'E2E 576 Month Anchor', start: `${DAY}T03:00:00.000Z`, end: `${DAY}T03:30:00.000Z` });
    await openMonthView(page, 'E2E 576 Month Anchor');
    await expect(page.locator('#loading-screen')).toBeHidden();
    const bottomOf = async day => {
      const box = await cell(page, day).boundingBox();
      return { x: box.x + box.width / 2, y: box.y + box.height - 8 };
    };
    // Dragged backwards from the 20th to the 18th.
    await drag(page, await bottomOf(20), await bottomOf(18), { release: false });
    await expect(page.locator('.month-day.drop-target')).toHaveCount(3);
    await release(page);

    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-allday')).toBeChecked();
    await expect(page.locator('#ev-start-date')).toHaveValue('2037-05-18');
    await expect(page.locator('#ev-end-date')).toHaveValue('2037-05-20');
    await saveAs(page, 'E2E 576 Days');
    await expectStored(page, 'E2E 576 Days', '2037-05-18', '2037-05-21');
    expect((await stored(page, 'E2E 576 Days'))[0].allDay).toBe(true);
  });
});

// Issue #577: the keyboard alternative and tasks with a due date. A focused event moves with the
// arrow keys (day/week: ↑/↓ 15 minutes, ←/→ one day; month: ←/→ one day, ↑/↓ one week),
// Shift+arrow changes the end, Alt+Shift+arrow the start; Enter applies, Esc cancels, and the
// aria-live region says what would happen. Open tasks with a due date show in the calendar and
// move like events (no edges); DTSTART moves along with DUE. Checked through the stored data.
test.describe('Issue #577 — keyboard moves and tasks with a due date', () => {
  let calendarId;
  let taskListId;
  let puts;

  const cell = (page, day) => page.locator('.month-day:not(.other-month)').nth(day - 1);
  const announcer = page => page.locator('#aria-announcer');

  async function openMonth(page, title) {
    await openMonthView(page, title);
    await expect(page.locator('#loading-screen')).toBeHidden();
  }

  async function seedTask(page, data) {
    const res = await page.request.post('/api/tasks', { headers: SAME_ORIGIN, data: { calendarId: taskListId, ...data } });
    expect(res.status()).toBe(201);
    return res.json();
  }

  async function storedTask(page, title) {
    const body = await (await page.request.get('/api/tasks')).json();
    const list = Array.isArray(body) ? body : body.tasks;
    const t = list.find(x => x.title === title);
    const iso = v => (v ? new Date(v).toISOString() : null);
    return t && { due: iso(t.due), dueIsDate: Boolean(t.dueIsDate), dtstart: iso(t.dtstart), dtstartIsDate: Boolean(t.dtstartIsDate) };
  }

  async function expectTask(page, title, expected) {
    await expect.poll(() => storedTask(page, title), { timeout: 15000 }).toMatchObject(expected);
  }

  test.beforeEach(async ({ page, e2eUser }) => {
    await page.addInitScript(() => {
      if (window.origin !== 'null') window.localStorage.setItem('welcome-popup-closed', 'true');
    });
    puts = [];
    page.on('request', r => {
      const path = new URL(r.url()).pathname;
      if (r.method() === 'PUT' && (path.startsWith('/api/events/') || path.startsWith('/api/tasks/'))) puts.push(r.postDataJSON());
    });
    await page.goto('/');
    calendarId = await ownCalendar(page, e2eUser);
    taskListId = `internal-caldav::/${e2eUser}/tasks/`;
  });

  test('#577 arrow keys move a focused event in the week view, Enter applies and it is announced', async ({ page }) => {
    test.skip(isTouch(), 'keyboard input');
    await seed(page, { calendarId, title: 'E2E 577 Keys', start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:00:00.000Z` });
    await openView(page, 'week', 'E2E 577 Keys');
    const block = page.locator('.event-block', { hasText: 'E2E 577 Keys' });
    await expect(block).toBeVisible({ timeout: 10000 });
    await block.focus();

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await expect(announcer(page)).toContainText('Fr., 15.05. 10:30 – 11:30');
    await expect(announcer(page)).toContainText('Eingabetaste');
    await expect(page.locator('.week-view .drag-ghost')).toHaveText('10:30 – 11:30');
    // Nothing is saved before Enter, and the global arrow shortcut did not change the week.
    expect(puts).toHaveLength(0);
    await expect(block).toBeVisible();

    await page.keyboard.press('Enter');
    await expectStored(page, 'E2E 577 Keys', '2037-05-15T08:30:00.000Z', '2037-05-15T09:30:00.000Z');
    await expect(announcer(page)).toContainText('verschoben');
    // Enter applied the move instead of opening the event.
    await expect(page.locator('#event-popover')).toBeHidden();
    await expect(page.locator('#undo-bar')).toBeVisible();
    expect(puts).toHaveLength(1);
    // Focus stays on the moved event, so the next move needs no mouse.
    await expect(page.locator('.event-block:focus', { hasText: 'E2E 577 Keys' })).toHaveCount(1, { timeout: 15000 });
  });

  test('#577 Shift+arrow changes the end, Alt+Shift+arrow the start, Esc cancels', async ({ page }) => {
    test.skip(isTouch(), 'keyboard input');
    await seed(page, { calendarId, title: 'E2E 577 Edges', start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:00:00.000Z` });
    await openView(page, 'day', 'E2E 577 Edges');
    const block = page.locator('.event-block', { hasText: 'E2E 577 Edges' });
    await expect(block).toBeVisible({ timeout: 10000 });

    await block.focus();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');
    await expectStored(page, 'E2E 577 Edges', `${DAY}T08:00:00.000Z`, `${DAY}T09:30:00.000Z`);
    await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });

    await block.focus();
    await page.keyboard.press('Alt+Shift+ArrowUp');
    await page.keyboard.press('Enter');
    await expectStored(page, 'E2E 577 Edges', `${DAY}T07:45:00.000Z`, `${DAY}T09:30:00.000Z`);
    await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });

    // Esc drops the pending move: nothing is saved and the event stays.
    const before = puts.length;
    await block.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.day-view .drag-ghost')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.day-view .drag-ghost')).toHaveCount(0);
    await expect(announcer(page)).toContainText('abgebrochen');
    await page.waitForTimeout(300);
    expect(puts).toHaveLength(before);
    await expectStored(page, 'E2E 577 Edges', `${DAY}T07:45:00.000Z`, `${DAY}T09:30:00.000Z`);
  });

  test('#577 month view: ←/→ move by a day, ↑/↓ by a week, the time stays', async ({ page }) => {
    test.skip(isTouch(), 'keyboard input');
    await seed(page, { calendarId, title: 'E2E 577 Month', start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:30:00.000Z` });
    await openMonth(page, 'E2E 577 Month');
    await cell(page, 14).locator('.event-chip', { hasText: 'E2E 577 Month' }).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await expect(cell(page, 22)).toHaveClass(/drop-target/);
    await page.keyboard.press('Enter');
    await expectStored(page, 'E2E 577 Month', '2037-05-22T08:00:00.000Z', '2037-05-22T09:30:00.000Z');
  });

  test('#577 the keyboard does not move a read-only event', async ({ page }) => {
    test.skip(isTouch(), 'keyboard input');
    await mockEvents(page, [{ uid: 'e2e-577-ro', title: 'E2E 577 Fremd', calendarId, readOnly: true,
      start: `${DAY}T08:00:00.000Z`, end: `${DAY}T09:00:00.000Z`, allDay: false,
      organizer: { name: 'Test User', email: 'testuser@example.com' } }]);
    await openView(page, 'day', 'E2E 577 Fremd');
    const block = page.locator('.event-block', { hasText: 'E2E 577 Fremd' });
    await block.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.toast', { hasText: 'Nur lesbar: Termin von Test User' })).toBeVisible();
    await expect(page.locator('.day-view .drag-ghost')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(puts).toHaveLength(0);
  });

  test('#577 a task is shown at its due time and dragged in the day view; DTSTART moves along; Rückgängig', async ({ page }) => {
    await seedTask(page, { title: 'E2E 577 Task', due: `${DAY}T10:00:00.000Z`, dtstart: `${DAY}T08:00:00.000Z` });
    await openView(page, 'day', 'E2E 577 Task');
    const block = page.locator('.event-block.calendar-task', { hasText: 'E2E 577 Task' });
    await expect(block).toBeVisible({ timeout: 10000 });
    await expect(block).toContainText('12:00');
    // A task has a due time, not a length: no edges.
    await expect(block.locator('.event-resize-handle')).toHaveCount(0);

    await dragBy(page, block, 0, 60);
    await expectTask(page, 'E2E 577 Task', { due: `${DAY}T11:00:00.000Z`, dtstart: `${DAY}T09:00:00.000Z` });
    await expect(page.locator('#undo-bar')).toBeVisible();
    await expect(block).toContainText('13:00', { timeout: 15000 });

    await page.locator('#undo-bar button', { hasText: 'Rückgängig' }).click();
    await expectTask(page, 'E2E 577 Task', { due: `${DAY}T10:00:00.000Z`, dtstart: `${DAY}T08:00:00.000Z` });

    if (!isTouch()) {
      // The keyboard moves a task the same way.
      await expect(block).toContainText('12:00', { timeout: 15000 });
      await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });
      await block.focus();
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Enter');
      await expectTask(page, 'E2E 577 Task', { due: `${DAY}T09:45:00.000Z`, dtstart: `${DAY}T07:45:00.000Z` });
    }
  });

  test('#577 month view: a task moves by days and keeps its time; a date-only task stays date-only', async ({ page }) => {
    await seedTask(page, { title: 'E2E 577 Timed Task', due: `${DAY}T10:00:00.000Z` });
    await seedTask(page, { title: 'E2E 577 Date Task', due: `${DAY}T00:00:00.000Z`, dueIsDate: true,
      dtstart: '2037-05-12T00:00:00.000Z', dtstartIsDate: true });
    await openMonth(page, 'E2E 577 Timed Task');
    const drop = async (title, day) => {
      const from = center(await cell(page, 14).locator('.event-chip.calendar-task', { hasText: title }).boundingBox());
      const box = await cell(page, day).boundingBox();
      await drag(page, from, { x: box.x + box.width / 2, y: box.y + box.height - 8 });
    };

    await drop('E2E 577 Timed Task', 19);
    await expectTask(page, 'E2E 577 Timed Task', { due: '2037-05-19T10:00:00.000Z', dtstart: null });
    await expect(cell(page, 19).locator('.calendar-task', { hasText: 'E2E 577 Timed Task' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });

    await drop('E2E 577 Date Task', 16);
    await expectTask(page, 'E2E 577 Date Task', { due: '2037-05-16T00:00:00.000Z', dueIsDate: true,
      dtstart: '2037-05-14T00:00:00.000Z', dtstartIsDate: true });
  });

  test('#577 a completed task is not shown, and a failed task save rolls back with an error toast', async ({ page }) => {
    await seedTask(page, { title: 'E2E 577 Done', due: `${DAY}T09:00:00.000Z`, status: 'COMPLETED' });
    await seedTask(page, { title: 'E2E 577 Conflict', due: `${DAY}T10:00:00.000Z` });
    await page.route(url => url.pathname.startsWith('/api/tasks/'), route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 409, json: { error: 'Conflict' } }) : route.fallback());
    await openView(page, 'day', 'E2E 577 Conflict');
    const block = page.locator('.event-block.calendar-task', { hasText: 'E2E 577 Conflict' });
    await expect(block).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.calendar-task', { hasText: 'E2E 577 Done' })).toHaveCount(0);

    await dragBy(page, block, 0, 120);
    await expect(page.locator('.toast.error', { hasText: 'Konflikt' })).toBeVisible({ timeout: 10000 });
    await expect(block).toContainText('12:00');
    await expect(page.locator('.event-pending')).toHaveCount(0);
    await expect(page.locator('#undo-bar')).toBeHidden();
    await expectTask(page, 'E2E 577 Conflict', { due: `${DAY}T10:00:00.000Z` });
  });
});
