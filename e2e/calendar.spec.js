const { test, expect } = require('./fixtures.js');
const { mockCalendars, mockEvents } = require('./mocks.js');
const sqlite3 = require('sqlite3');
const { webServer } = require('../playwright.config.js');

// The webServer's own database (#211), never the developer's webcalendar.db.
const E2E_DATABASE_PATH = webServer.env.DATABASE_PATH;
// The proxy header signs each test in as its own fixture user (#592, e2e/fixtures.js), whose
// collections live under /<E2E_USER>/. Set before every test by the suite's beforeEach.
let E2E_USER;
// Direct API calls are not browser requests; they declare themselves same-origin to pass the
// server's CSRF guard (#340), as the browser does for the app's own fetches.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
// The platform proxy's headers for a caller it has not identified (no X-Forwarded-User, #592).
const PROXY_WITHOUT_USER = { 'X-Freeshard-Secret': webServer.env.HTTP_HEADER_AUTH_SECRET, 'X-Ptl-Client-Type': 'terminal' };

// YYYY-MM-DD of the first Monday at least `weeks` weeks from now (UTC).
function mondayWeeksAhead(weeks) {
  const d = new Date(Date.now() + weeks * 7 * 24 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}

// Event saves are optimistic (#174): the dialog closes before the server answered. A pending
// preview is drawn until the reload after the save brings the stored event (or series).
async function expectSavesLanded(page) {
  await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });
}

// Rarely used event fields sit in collapsed sections of the event dialog (#506).
async function openEventSection(page, name) {
  const section = page.locator(`#ev-section-${name}`);
  if (await section.getAttribute('open') === null) await section.locator('> summary').click();
}

// #508: appends a reminder row in the event ('ev') or task ('task') dialog and fills it in.
async function addReminder(page, prefix, { amount, unit = 'M', direction = '-', at } = {}) {
  if (prefix === 'ev') await openEventSection(page, 'alarm');
  await page.click(`#${prefix}-add-reminder`);
  const row = page.locator(`#${prefix}-reminder-list .reminder-row`).last();
  if (at !== undefined) {
    await row.locator('.reminder-kind').selectOption('absolute');
    await row.locator('.reminder-at').fill(at);
  } else {
    await row.locator('.reminder-amount').fill(String(amount));
    await row.locator('.reminder-unit').selectOption(unit);
    await row.locator('.reminder-direction').selectOption(direction);
  }
  return row;
}

// Computed value of a design token, as an rgb() string comparable to getComputedStyle colours.
async function tokenColor(page, token) {
  return page.evaluate(t => {
    const probe = document.createElement('span');
    probe.style.color = `var(${t})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, token);
}

// #592: a test's user is new, so its default collections exist only once the app has created them
// on its first calendar-list load; a test that writes into one straight away waits for it.
async function expectOwnCalendar(page, calendarId) {
  await expect.poll(async () => (await (await page.request.get('/api/calendars')).json()).calendars.map(c => c.id),
    { timeout: 10000 }).toContain(calendarId);
}

function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(E2E_DATABASE_PATH);
    db.configure('busyTimeout', 5000); // the webServer writes the same file concurrently
    db.run(sql, params, err => db.close(() => (err ? reject(err) : resolve())));
  });
}

test.describe('FreeShard WebCalendar E2E Suite', () => {

  test.beforeEach(async ({ page, e2eUser }) => {
    E2E_USER = e2eUser;
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err));
    // The one-time welcome modal (shown when only the internal calendar account
    // exists) would intercept clicks — mark it as already dismissed.
    await page.addInitScript(() => {
      // Also runs in opaque-origin frames (about:blank), which have no localStorage.
      if (window.origin === 'null') return;
      window.localStorage.setItem('welcome-popup-closed', 'true');
      window.localStorage.setItem('activeView', 'month');
    });
  });

  test.afterEach(async ({ page }) => {
    // Pages that never navigated to the app (API-only tests) have nothing to reset.
    if (page.isClosed() || !page.url().startsWith('http')) return;
    await page.evaluate(() => {
      const modalBackdrops = document.querySelectorAll('.modal-backdrop, [id$="-backdrop"]');
      modalBackdrops.forEach(el => el.classList.add('hidden'));
      window.localStorage.removeItem('activeView');
    });
  });

  test('Issue #71 / E2E-1 — protected API endpoints strictly reject unauthenticated requests with 401 and Authentication required', async ({ browser }) => {
    const endpoints = [
      { method: 'get', path: '/api/calendars' },
      { method: 'get', path: '/api/events' },
      { method: 'get', path: '/api/tasks' },
      { method: 'get', path: '/api/resources' },
      { method: 'get', path: '/api/delegates' },
      { method: 'get', path: '/api/working-hours' },
      { method: 'get', path: '/api/attachments/filebrowser/files' },
      { method: 'post', path: '/api/quick-add/parse', data: { text: 'Meeting tomorrow at 3pm' } }
    ];

    // A proxied caller with no session cookie and no identity header (#211, #592).
    const anonymous = await browser.newContext({ extraHTTPHeaders: PROXY_WITHOUT_USER });
    try {
      for (const ep of endpoints) {
        const response = await anonymous.request[ep.method](ep.path, { data: ep.data, headers: SAME_ORIGIN });
        expect(response.status()).toBe(401);
        const body = await response.json();
        expect(body.error).toBe('Authentication required');
      }
    } finally {
      await anonymous.close();
    }
  });

  test('Issue #246 — production env mode answers 401 to requests that bypass the platform proxy', async ({ browser }) => {
    // A browser context without the proxy secret header is a caller that skipped the FreeShard proxy.
    const direct = await browser.newContext({ extraHTTPHeaders: {} });
    try {
      const page = await direct.newPage();
      const pageRes = await page.goto('/');
      expect(pageRes.status()).toBe(401);
      for (const p of ['/api/auth/session', '/api/calendars', '/api/accounts']) {
        const res = await direct.request.get(p);
        expect(res.status()).toBe(401);
      }
      expect(await direct.cookies()).toHaveLength(0);
      const wrong = await direct.request.get('/api/auth/session', { headers: { 'X-Freeshard-Secret': 'wrong' } });
      expect(wrong.status()).toBe(401);
    } finally {
      await direct.close();
    }
    // The same request through the proxy (the configured header) yields the env user.
    const proxied = await browser.newContext();
    try {
      const res = await proxied.request.get('/api/auth/session');
      expect(res.status()).toBe(200);
      expect((await res.json()).userId).toBe(E2E_USER);
    } finally {
      await proxied.close();
    }
  });

  test('Issue #71 / E2E-1 — browser asks to sign in again when the session is lost', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    const reauth = page.locator('#reauth-screen');
    await expect(page.locator('#calendar-list')).toContainText('Persönlich');
    await expect(reauth).toBeHidden();
    // The session is lost (expired / cleared); the next data fetch must surface the 401 (#224: as a sign-in prompt).
    // A boot request still in flight may already get the 401 and hide the shell, so navigate through the DOM.
    // #592: the identity header goes too, or the proxy's next request would sign the user in again.
    await context.setExtraHTTPHeaders(PROXY_WITHOUT_USER);
    await context.clearCookies();
    await page.evaluate(() => document.getElementById('next-btn').click());
    await expect(reauth).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#app')).toBeHidden();
  });

  // #592: every test is its own fixture (e2e/fixtures.js). The first test leaves an event and a
  // calendar behind; the second, a later test of the same run, must see neither, and must be signed
  // in as a user of its own. Serial, so the second runs after the first even when it is shuffled.
  test.describe.serial('Issue #592 — no test sees what another test left behind', () => {
    const leftover = { calendar: 'E2E 592 Rest-Kalender', event: 'E2E 592 Rest-Termin' };
    const users = [];

    async function signedIn(page) {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-item').first()).toBeVisible({ timeout: 10000 });
      return (await (await page.request.get('/api/auth/session')).json()).userId;
    }

    test('a test leaves a calendar and an event behind', async ({ page }) => {
      users.push(await signedIn(page));
      const calendars = (await (await page.request.get('/api/calendars')).json()).calendars;
      const personal = calendars.find(c => c.supportsVEVENT && !c.readOnly);
      const created = await page.request.post('/api/calendars', {
        headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name: leftover.calendar, color: '#336699', type: 'calendar' },
      });
      expect(created.ok()).toBe(true);
      const event = await page.request.post('/api/events', {
        headers: SAME_ORIGIN,
        data: { calendarId: personal.id, title: leftover.event, start: '2037-06-10T09:00:00.000Z', end: '2037-06-10T10:00:00.000Z' },
      });
      expect(event.status()).toBe(201);
      await page.goto('/?date=2037-06-10');
      await expect(page.locator('#calendar-list')).toContainText(leftover.calendar, { timeout: 10000 });
      await expect(page.locator('.event-chip', { hasText: leftover.event })).toBeVisible({ timeout: 10000 });
    });

    test('the next test starts with a fresh user, calendar list and events', async ({ page, e2eUser }) => {
      const user = await signedIn(page);
      expect(user).toBe(e2eUser);
      expect(users).toHaveLength(1);
      expect(user).not.toBe(users[0]);
      await page.goto('/?date=2037-06-10');
      await expect(page.locator('#calendar-list .calendar-item').first()).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#calendar-list')).not.toContainText(leftover.calendar);
      const calendars = (await (await page.request.get('/api/calendars')).json()).calendars;
      expect(calendars.map(c => c.name)).not.toContain(leftover.calendar);
      const events = (await (await page.request.get('/api/events?start=2037-06-01T00:00:00.000Z&end=2037-07-01T00:00:00.000Z')).json()).events;
      expect(events.map(e => e.title)).not.toContain(leftover.event);
      await expect(page.locator('.event-chip', { hasText: leftover.event })).toHaveCount(0);
    });
  });

  test('should load the page, bypass onboarding, and display calendar', async ({ page }) => {
    // Go to homepage
    await page.goto('/');

    // Loading screen should become hidden
    await expect(page.locator('#loading-screen')).toHaveClass(/hidden/, { timeout: 10000 });

    // Onboarding should be hidden (since the test account is auto-configured in session)
    await expect(page.locator('#onboarding')).toHaveClass(/hidden/);

    // App layout should be visible
    await expect(page.locator('#app')).not.toHaveClass(/hidden/);

    // Sidebar should have the calendar list
    await expect(page.locator('#calendar-list')).toBeVisible();

    // Verify calendar list contains the default "Persönlich" calendar
    await expect(page.locator('#calendar-list')).toContainText('Persönlich');
  });

  test('should open event modal, create an event, view popover, and delete it', async ({ page }) => {
    await page.goto('/?date=2028-12-28');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

    // Click "Neuer Termin" button
    await page.click('#new-event-btn');

    // Modal should be visible
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);

    // Fill title
    const uniqueTitle = `E2E Playwright Event - ${Date.now()}`;
    await page.fill('#ev-title', uniqueTitle);
    await page.fill('#ev-start-date', '2028-12-28');
    await page.fill('#ev-end-date', '2028-12-28');
    await page.check('#ev-allday');

    // Save event
    await page.click('#event-save-btn');

    // Modal should close
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 10000 });

    // Check that event chip with title is visible in calendar view
    const eventChip = page.locator('.event-chip').filter({ hasText: uniqueTitle }).first();
    await expect(eventChip).toBeVisible({ timeout: 15000 });

    // Click on event chip to show popover
    await eventChip.click();

    // Popover should be visible
    await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);
    await expect(page.locator('#event-popover .popover-title')).toHaveText(uniqueTitle);

    // Click "Löschen" in popover
    await page.click('#popover-delete-btn');
    await expect(page.locator('#confirm-dialog-text')).toContainText(uniqueTitle);
    await page.click('#confirm-dialog-ok');

    // Event chip should disappear
    await expect(eventChip).not.toBeVisible();
  });

  // Issue #266: the popover is a dialog — focus goes in on open, Escape closes it, focus goes
  // back to the chip, and a reopened popover is operable (no stale `inert` from the last close).
  test('Issue #266 — event popover takes focus, closes on Escape and returns focus to its chip', async ({ page }) => {
    await page.goto('/?date=2028-11-15');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    const title = `E2E Popover Focus ${Date.now()}`;
    await page.fill('#ev-title', title);
    await page.fill('#ev-start-date', '2028-11-15');
    await page.fill('#ev-end-date', '2028-11-15');
    await page.check('#ev-allday');
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 10000 });
    await expectSavesLanded(page);

    const chip = page.locator('.event-chip').filter({ hasText: title }).first();
    await expect(chip).toBeVisible({ timeout: 15000 });
    const popover = page.locator('#event-popover');

    // Keyboard open: focus moves into the dialog.
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(popover).not.toHaveClass(/hidden/);
    await expect(popover).toHaveAttribute('role', 'dialog');
    await expect(popover).toHaveAccessibleName(title);
    await expect(page.locator('#popover-edit-btn')).toBeFocused();

    // Escape closes it and focus returns to the chip.
    await page.keyboard.press('Escape');
    await expect(popover).toHaveClass(/hidden/);
    await expect(chip).toBeFocused();

    // Reopened after an Escape close: interactive, Tab stays inside, Escape works again.
    await page.keyboard.press('Enter');
    await expect(popover).not.toHaveClass(/hidden/);
    await expect(popover).not.toHaveAttribute('inert', /.*/);
    await expect(page.locator('#popover-edit-btn')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#popover-delete-btn')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#popover-edit-btn')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(popover).toHaveClass(/hidden/);
    await expect(chip).toBeFocused();

    // Closing through an action button also hands focus back: the cancelled delete returns to the chip.
    await page.keyboard.press('Enter');
    await expect(page.locator('#popover-delete-btn')).toBeVisible();
    await page.click('#popover-delete-btn');
    await expect(page.locator('#confirm-dialog-text')).toContainText(title);
    await page.click('#confirm-dialog-cancel');
    await expect(popover).toHaveClass(/hidden/);
    await expect(chip).toBeFocused();

    // An outside click on another control keeps the focus the click gave it.
    await chip.click();
    await expect(popover).not.toHaveClass(/hidden/);
    await page.click('#search-input');
    await expect(popover).toHaveClass(/hidden/);
    await expect(page.locator('#search-input')).toBeFocused();

    await chip.click();
    await page.click('#popover-delete-btn');
    await page.click('#confirm-dialog-ok');
    await expect(chip).not.toBeVisible({ timeout: 10000 });
  });

  test('should create recurring event, delete and edit single occurrences via scope dialog', async ({ page }) => {
    await page.goto('/?date=2026-12-28');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

    // Create a weekly recurring event
    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    const calVal = await page.locator('#ev-calendar option:not([value=""])').first().getAttribute('value');
    if (calVal) await page.selectOption('#ev-calendar', calVal);
    const title = `Recurring E2E ${Date.now()}`;
    await page.fill('#ev-title', title);
    await page.fill('#ev-start-date', '2026-12-01');
    await page.fill('#ev-end-date', '2026-12-01');
    await openEventSection(page, 'recurrence');
    await page.selectOption('#ev-recurrence', 'WEEKLY');
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
    // The optimistic preview is the first occurrence only; the series shows once the save has landed (#174).
    await expectSavesLanded(page);

    const chips = page.locator(`.event-chip:has-text("${title}")`);
    await expect(chips.first()).toBeVisible({ timeout: 10000 });
    const countBefore = await chips.count();
    expect(countBefore).toBeGreaterThan(1);

    // Delete only the second occurrence
    await chips.nth(1).click();
    await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);
    await page.click('#popover-delete-btn');
    await expect(page.locator('#scope-dialog-backdrop')).not.toHaveClass(/hidden/);
    await page.click('#scope-occurrence-btn');
    await expect(chips).toHaveCount(countBefore - 1, { timeout: 10000 });

    // Edit only the first occurrence (retitle)
    const movedTitle = `Moved E2E ${Date.now()}`;
    await chips.first().click();
    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await page.fill('#ev-title', movedTitle);
    await page.click('#event-save-btn');
    await expect(page.locator('#scope-dialog-backdrop')).not.toHaveClass(/hidden/);
    await page.click('#scope-occurrence-btn');

    const movedChip = page.locator(`.event-chip:has-text("${movedTitle}")`);
    await expect(movedChip).toHaveCount(1, { timeout: 10000 });
    await expect(chips).toHaveCount(countBefore - 2, { timeout: 10000 });

    // Clean up: delete the whole series (also removes the detached exception)
    if (await chips.count() > 0) {
      await chips.first().click();
    } else {
      await movedChip.first().click();
    }
    await page.click('#popover-delete-btn');
    await expect(page.locator('#scope-dialog-backdrop')).not.toHaveClass(/hidden/);
    await page.click('#scope-series-btn');
    await expect(chips).toHaveCount(0, { timeout: 10000 });
    await expect(movedChip).toHaveCount(0, { timeout: 10000 });
  });

  // Issue #91: the weekday must be resolved in the event's time zone. Monday
  // 00:30 in Berlin is Sunday 22:30 UTC, so a UTC-based server rewrote BYDAY=MO to SU.
  const berlinWeekday = iso => new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(new Date(iso));

  async function seriesInstances(page, title) {
    const res = await page.request.get('/api/events?start=2036-08-01T00:00:00Z&end=2036-10-01T00:00:00Z');
    expect(res.ok()).toBeTruthy();
    return (await res.json()).events.filter(e => e.title === title).sort((a, b) => a.start.localeCompare(b.start));
  }

  async function deleteSeries(page, title) {
    const chips = page.locator('.event-chip').filter({ hasText: title });
    await chips.first().click();
    await page.click('#popover-delete-btn');
    await expect(page.locator('#scope-dialog-backdrop')).not.toHaveClass(/hidden/);
    await page.click('#scope-series-btn');
    await expect(chips).toHaveCount(0, { timeout: 10000 });
  }

  test('Issue #91 — new weekly series at Monday 00:30 Berlin recurs on Mondays', async ({ page }) => {
    await page.goto('/?date=2036-08-11');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    const calVal = await page.locator('#ev-calendar option:not([value=""])').first().getAttribute('value');
    await page.selectOption('#ev-calendar', calVal);
    const title = `E2E Issue91 TZ ${Date.now()}`;
    await page.fill('#ev-title', title);
    await page.fill('#ev-start-date', '2036-08-11');
    await page.dispatchEvent('#ev-start-date', 'change');
    await page.fill('#ev-start-time', '00:30');
    await page.fill('#ev-end-date', '2036-08-11');
    await page.fill('#ev-end-time', '01:30');
    await page.selectOption('#ev-start-tz', 'Europe/Berlin');
    await openEventSection(page, 'recurrence');
    await page.selectOption('#ev-recurrence', 'WEEKLY');
    await expect(page.locator('.recur-byday:checked')).toHaveCount(1);
    await expect(page.locator('.recur-byday:checked')).toHaveValue('MO');
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
    await expectSavesLanded(page);

    const instances = await seriesInstances(page, title);
    expect(instances.length).toBeGreaterThanOrEqual(3);
    expect(instances[0].recurrence).toMatch(/BYDAY=MO/);
    expect(instances[0].start).toBe('2036-08-10T22:30:00.000Z');
    expect([...new Set(instances.map(e => berlinWeekday(e.start)))]).toEqual(['Mon']);

    await deleteSeries(page, title);
  });

  test('Issue #91 — moving a bi-weekly series to Monday via the edit dialog keeps INTERVAL and lands on Mondays', async ({ page }) => {
    await page.goto('/?date=2036-08-13');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });
    const title = `E2E Issue91 Biweekly ${Date.now()}`;
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Issue91//EN',
      'BEGIN:VEVENT',
      `UID:e2e-issue91-${Date.now()}`,
      'DTSTART;TZID=Europe/Berlin:20360813T003000',
      'DTEND;TZID=Europe/Berlin:20360813T013000',
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE',
      `SUMMARY:${title}`,
      'END:VEVENT', 'END:VCALENDAR'
    ].join('\r\n');
    await page.evaluate((icsText) => {
      const dt = new DataTransfer();
      dt.items.add(new File([icsText], 'invite.ics', { type: 'text/calendar' }));
      document.querySelector('.sidebar').dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      );
    }, ics);
    await expect(page.locator('#import-dialog-backdrop')).toBeVisible();
    await page.click('#import-confirm');
    await expect(page.locator('#import-dialog-backdrop')).toBeHidden({ timeout: 20000 });

    const chip = page.locator('.event-chip').filter({ hasText: title }).first();
    await expect(chip).toBeVisible({ timeout: 15000 });
    await chip.click();
    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('.recur-byday:checked')).toHaveValue('WE');
    await page.fill('#ev-start-date', '2036-08-11');
    await page.dispatchEvent('#ev-start-date', 'change');
    await page.fill('#ev-end-date', '2036-08-11');
    await expect(page.locator('.recur-byday:checked')).toHaveCount(1);
    await expect(page.locator('.recur-byday:checked')).toHaveValue('MO');
    await page.click('#event-save-btn');
    await expect(page.locator('#scope-dialog-backdrop')).not.toHaveClass(/hidden/);
    await page.click('#scope-series-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
    await expectSavesLanded(page);

    const instances = await seriesInstances(page, title);
    expect(instances.length).toBeGreaterThanOrEqual(3);
    expect(instances[0].recurrence).toMatch(/BYDAY=MO/);
    expect(instances[0].recurrence).toMatch(/INTERVAL=2/);
    expect(instances[0].start).toBe('2036-08-10T22:30:00.000Z');
    expect([...new Set(instances.map(e => berlinWeekday(e.start)))]).toEqual(['Mon']);
    const gapsDays = instances.slice(1).map((e, i) => (new Date(e.start) - new Date(instances[i].start)) / 86400000);
    expect([...new Set(gapsDays)]).toEqual([14]);

    await deleteSeries(page, title);
  });

  // #507: Berlin switches to summer time on 2037-03-29. A series every 3 weeks from Monday
  // 2037-03-02 09:00 stays at 09:00 wall clock: 08:00Z before the change, 07:00Z after it.
  test('Issue #507 — a series created "every 3 weeks" expands every 21 days at 09:00 Berlin across the DST change', async ({ page }) => {
    await page.goto('/?date=2037-03-02');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    await page.selectOption('#ev-calendar', await page.locator('#ev-calendar option:not([value=""])').first().getAttribute('value'));
    const title = `E2E Issue507 Interval ${Date.now()}`;
    await page.fill('#ev-title', title);
    await page.fill('#ev-start-date', '2037-03-02');
    await page.dispatchEvent('#ev-start-date', 'change');
    await page.fill('#ev-start-time', '09:00');
    await page.fill('#ev-end-date', '2037-03-02');
    await page.fill('#ev-end-time', '10:00');
    await page.selectOption('#ev-start-tz', 'Europe/Berlin');
    await openEventSection(page, 'recurrence');
    await page.selectOption('#ev-recurrence', 'WEEKLY');
    await page.fill('#recur-interval', '3');
    await page.check('input[name="recur-end-type"][value="COUNT"]');
    await page.fill('#recur-end-count', '4');
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
    await expectSavesLanded(page);

    const res = await page.request.get('/api/events?start=2037-02-01T00:00:00Z&end=2037-06-01T00:00:00Z');
    expect(res.ok()).toBeTruthy();
    const instances = (await res.json()).events.filter(e => e.title === title).sort((a, b) => a.start.localeCompare(b.start));
    expect(instances.map(e => new Date(e.start).toISOString())).toEqual([
      '2037-03-02T08:00:00.000Z',
      '2037-03-23T08:00:00.000Z',
      '2037-04-13T07:00:00.000Z',
      '2037-05-04T07:00:00.000Z',
    ]);
    expect(instances[0].recurrence).toMatch(/(^|;)INTERVAL=3(;|$)/);

    // The month view draws them on those days at 09:00. The March grid runs 23 Feb – 5 Apr, the
    // April grid 30 Mar – 10 May (local midnights; summer time from 29 Mar).
    const chips = page.locator('.event-chip').filter({ hasText: title });
    const chipDays = () => page.locator('.month-grid .month-day').filter({ has: chips })
      .evaluateAll(cells => cells.map(c => c.dataset.date));
    await expect(chips).toHaveCount(2, { timeout: 10000 });
    expect(await chipDays()).toEqual(['2037-03-01T23:00:00.000Z', '2037-03-22T23:00:00.000Z']);
    await page.goto('/?date=2037-04-13');
    await expect(chips).toHaveCount(2, { timeout: 10000 });
    expect(await chipDays()).toEqual(['2037-04-12T22:00:00.000Z', '2037-05-03T22:00:00.000Z']);
    for (const chip of await chips.all()) await expect(chip).toContainText('09:00');

    await deleteSeries(page, title);
  });

  // #403: what the event dialog sends when a recurring event is saved. The events are routed and
  // every save is captured instead of stored, so each test reads the exact payload of one save.
  test.describe('Issue #403 — the event dialog saves recurrence and series edits as the user left them', () => {
    let calendarId;
    // #592: the ids name the test's own user, known only once its fixture is set up.
    test.beforeEach(() => {
      calendarId = `internal-caldav::/${E2E_USER}/personal/`;
    });
    const series = (masterUid, title, recurrence, instances) => instances.map(([start, end, recurrenceId]) => ({
      uid: `${masterUid}::${recurrenceId}`, masterUid, recurrenceId, title, calendarId, start, end, allDay: false,
      recurrence, startTimeZone: 'Europe/Berlin', endTimeZone: 'Europe/Berlin',
      href: `/${E2E_USER}/personal/${masterUid}.ics`, etag: '"e2e-403"',
    }));

    async function serve(page, events) {
      const saves = [];
      await mockEvents(page, events);
      const capture = route => {
        const method = route.request().method();
        if (method !== 'PUT' && method !== 'POST') return route.fallback();
        const body = route.request().postDataJSON();
        saves.push({ method, body });
        return route.fulfill({ json: { ...body, uid: body.uid || 'e2e-403-new' } });
      };
      await page.route('**/api/events', capture);
      await page.route('**/api/events/*', capture);
      return saves;
    }

    async function openAt(page, date) {
      await page.goto(`/?date=${date}`);
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-item').first()).toBeVisible({ timeout: 10000 });
    }

    async function openEdit(page, title, nth = 0) {
      await page.locator('.event-chip').filter({ hasText: title }).nth(nth).click();
      await page.click('#popover-edit-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    }

    async function saveSeries(page, saves) {
      const before = saves.length;
      await page.click('#event-save-btn');
      await expect(page.locator('#scope-dialog-backdrop')).not.toHaveClass(/hidden/);
      await page.click('#scope-series-btn');
      await expect.poll(() => saves.length).toBe(before + 1);
      return saves[before].body;
    }

    async function openCreate(page) {
      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    }

    async function setStartDate(page, date) {
      await page.fill('#ev-start-date', date);
      await page.dispatchEvent('#ev-start-date', 'change');
    }

    const checkedDays = page => page.locator('.recur-byday:checked').evaluateAll(cbs => cbs.map(cb => cb.value));

    // A rule the dialog's controls would write back in another order (and #79: a series edit opened
    // from a later occurrence names that occurrence, so the server keeps the master DTSTART).
    const weeklyRule = 'FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=MO,WE;COUNT=6';
    const weekly = title => series('e2e-403-weekly', title, weeklyRule, [
      ['2037-06-01T09:00:00+02:00', '2037-06-01T10:00:00+02:00', '2037-06-01T09:00:00'],
      ['2037-06-03T09:00:00+02:00', '2037-06-03T10:00:00+02:00', '2037-06-03T09:00:00'],
    ]);

    test('Issues #222 / #79 — a zero-edit series save from a later occurrence sends the rule verbatim and names the occurrence', async ({ page }) => {
      const title = 'E2E 403 Zero Edit';
      const saves = await serve(page, weekly(title));
      await openAt(page, '2037-06-03');
      await openEdit(page, title, 1);
      expect(await checkedDays(page)).toEqual(['MO', 'WE']);

      const payload = await saveSeries(page, saves);
      expect(saves[0].method).toBe('PUT');
      expect(payload.recurrence).toBe(weeklyRule);
      expect(payload.scope).toBe('series');
      expect(payload.recurrenceId).toBe('2037-06-03T09:00:00');
      expect(payload.uid).toBe('e2e-403-weekly');
    });

    test('Issue #222 — ticking another weekday counts as a recurrence edit and keeps the parts the controls do not show', async ({ page }) => {
      const title = 'E2E 403 Touched';
      const saves = await serve(page, weekly(title));
      await openAt(page, '2037-06-03');
      await openEdit(page, title);
      await page.check('.recur-byday[value="FR"]');

      const parts = (await saveSeries(page, saves)).recurrence.split(';');
      expect(parts).toContain('BYDAY=MO,WE,FR');
      expect(parts).toEqual(expect.arrayContaining(['FREQ=WEEKLY', 'WKST=SU', 'INTERVAL=2', 'COUNT=6']));
      expect(parts).toHaveLength(5);
    });

    test('Issue #91 — opening a monthly "last Friday" series keeps its week and weekday selects', async ({ page }) => {
      const title = 'E2E 403 Last Friday';
      const rule = 'FREQ=MONTHLY;BYDAY=-1FR';
      const saves = await serve(page, series('e2e-403-monthly', title, rule, [
        ['2037-06-26T09:00:00+02:00', '2037-06-26T10:00:00+02:00', '2037-06-26T09:00:00'],
      ]));
      await openAt(page, '2037-06-26');
      await openEdit(page, title);
      await expect(page.locator('input[name="recur-monthly-type"][value="BYDAY"]')).toBeChecked();
      await expect(page.locator('#recur-monthly-week-idx')).toHaveValue('-1');
      await expect(page.locator('#recur-monthly-weekday')).toHaveValue('FR');
      expect((await saveSeries(page, saves)).recurrence).toBe(rule);
    });

    test('Issue #299 — a timed UNTIL survives a recurrence edit that keeps its date; a new date ends that day', async ({ page }) => {
      const title = 'E2E 403 Until';
      const saves = await serve(page, series('e2e-403-until', title, 'FREQ=DAILY;UNTIL=20370615T120000Z', [
        ['2037-06-10T09:00:00+02:00', '2037-06-10T10:00:00+02:00', '2037-06-10T09:00:00'],
      ]));
      await openAt(page, '2037-06-10');
      const untilRadio = page.locator('input[name="recur-end-type"][value="UNTIL"]');

      await openEdit(page, title);
      await expect(page.locator('#recur-end-date')).toHaveValue('2037-06-15');
      await expect(untilRadio).toBeChecked();
      // Switching the end type away and back is a recurrence edit, the UNTIL date stays the same.
      await page.check('input[name="recur-end-type"][value="COUNT"]');
      await page.check('input[name="recur-end-type"][value="UNTIL"]');
      expect((await saveSeries(page, saves)).recurrence).toBe('FREQ=DAILY;UNTIL=20370615T120000Z');

      await openEdit(page, title);
      await page.fill('#recur-end-date', '2037-06-20');
      expect((await saveSeries(page, saves)).recurrence).toBe('FREQ=DAILY;UNTIL=20370620T235959Z');
    });

    test('Issue #91 — in a new event the single weekday follows the start date, a multi-day choice stays', async ({ page }) => {
      await serve(page, []);
      await openAt(page, '2037-06-03');
      await openCreate(page);
      await setStartDate(page, '2037-06-03');
      await openEventSection(page, 'recurrence');
      await page.selectOption('#ev-recurrence', 'WEEKLY');
      expect(await checkedDays(page)).toEqual(['WE']);
      await setStartDate(page, '2037-06-01');
      expect(await checkedDays(page)).toEqual(['MO']);
      await page.check('.recur-byday[value="FR"]');
      await setStartDate(page, '2037-06-02');
      expect(await checkedDays(page)).toEqual(['MO', 'FR']);
    });

    test.describe('west of UTC', () => {
      test.use({ timezoneId: 'America/Los_Angeles' });

      test('Issue #291 — a start date reads as the same day of month and weekday in Los Angeles', async ({ page }) => {
        const saves = await serve(page, []);
        await openAt(page, '2037-06-15');
        await openCreate(page);
        await page.fill('#ev-title', 'E2E 403 West of UTC');
        await setStartDate(page, '2037-06-15'); // a Monday
        await page.fill('#ev-end-date', '2037-06-15');
        await openEventSection(page, 'recurrence');
        await page.selectOption('#ev-recurrence', 'WEEKLY');
        expect(await checkedDays(page)).toEqual(['MO']);
        await openEventSection(page, 'recurrence');
        await page.selectOption('#ev-recurrence', 'MONTHLY');
        await expect(page.locator('#recur-monthly-day-lbl')).toHaveText('Jeden Monat am 15. Tag');
        await expect(page.locator('#recur-monthly-week-idx')).toHaveValue('3');
        await expect(page.locator('#recur-monthly-weekday')).toHaveValue('MO');

        await page.click('#event-save-btn');
        await expect.poll(() => saves.length).toBe(1);
        expect(saves[0].method).toBe('POST');
        expect(saves[0].body.recurrence).toBe('FREQ=MONTHLY;BYMONTHDAY=15');
      });
    });

    test('Issue #507 — daily, weekly, monthly and yearly series offer "every N" and write INTERVAL=N', async ({ page }) => {
      const saves = await serve(page, []);
      await openAt(page, '2037-06-15');
      const expected = {
        DAILY: ['Alle', 'Tage', 'FREQ=DAILY;INTERVAL=3'],
        WEEKLY: ['Alle', 'Wochen', 'FREQ=WEEKLY;INTERVAL=3;BYDAY=MO'],
        MONTHLY: ['Alle', 'Monate', 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15'],
        YEARLY: ['Alle', 'Jahre', 'FREQ=YEARLY;INTERVAL=3'],
      };
      for (const [freq, [prefix, unit, rule]] of Object.entries(expected)) {
        await openCreate(page);
        await page.fill('#ev-title', `E2E 507 ${freq}`);
        await setStartDate(page, '2037-06-15'); // a Monday
        await page.fill('#ev-end-date', '2037-06-15');
        await openEventSection(page, 'recurrence');
        const interval = page.getByRole('spinbutton', { name: /Jede|Jeden|Jedes|Alle/ });
        await expect(interval).toBeHidden();
        await page.selectOption('#ev-recurrence', freq);
        await expect(interval).toBeVisible();
        await expect(interval).toHaveValue('1');
        await interval.fill('3');
        await expect(page.locator('#recur-interval-prefix')).toHaveText(prefix);
        await expect(page.locator('#recur-interval-unit')).toHaveText(unit);
        const before = saves.length;
        await page.click('#event-save-btn');
        await expect.poll(() => saves.length).toBe(before + 1);
        expect(saves[before].body.recurrence).toBe(rule);
        await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
      }
    });

    test('Issue #507 — "every 1 week" reads "Jede Woche" and writes no INTERVAL; an invalid interval is refused', async ({ page }) => {
      const saves = await serve(page, []);
      await openAt(page, '2037-06-15');
      await openCreate(page);
      await page.fill('#ev-title', 'E2E 507 Single');
      await setStartDate(page, '2037-06-15');
      await page.fill('#ev-end-date', '2037-06-15');
      await openEventSection(page, 'recurrence');
      await page.selectOption('#ev-recurrence', 'WEEKLY');
      await expect(page.locator('#recur-interval-prefix')).toHaveText('Jede');
      await expect(page.locator('#recur-interval-unit')).toHaveText('Woche');

      await page.fill('#recur-interval', '0');
      await page.click('#event-save-btn');
      await expect(page.locator('#event-form-error')).toBeVisible();
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      expect(saves).toHaveLength(0);

      await page.fill('#recur-interval', '1');
      await page.click('#event-save-btn');
      await expect.poll(() => saves.length).toBe(1);
      expect(saves[0].body.recurrence).toBe('FREQ=WEEKLY;BYDAY=MO');
    });

    test('Issue #507 — an INTERVAL from another client is shown, kept on save, and can be changed or reset to 1', async ({ page }) => {
      const title = 'E2E 507 Foreign Interval';
      const saves = await serve(page, weekly(title));
      await openAt(page, '2037-06-03');
      const interval = page.locator('#recur-interval');

      await openEdit(page, title);
      await expect(interval).toBeVisible();
      await expect(interval).toHaveValue('2');
      await expect(page.locator('#recur-interval-prefix')).toHaveText('Alle');
      await expect(page.locator('#recur-interval-unit')).toHaveText('Wochen');
      // Another recurrence edit keeps the interval.
      await page.check('.recur-byday[value="FR"]');
      let parts = (await saveSeries(page, saves)).recurrence.split(';');
      expect(parts).toEqual(expect.arrayContaining(['FREQ=WEEKLY', 'INTERVAL=2', 'BYDAY=MO,WE,FR', 'WKST=SU', 'COUNT=6']));
      expect(parts).toHaveLength(5);

      await openEdit(page, title);
      await interval.fill('4');
      parts = (await saveSeries(page, saves)).recurrence.split(';');
      expect(parts).toContain('INTERVAL=4');
      expect(parts.filter(p => p.startsWith('INTERVAL='))).toHaveLength(1);

      await openEdit(page, title);
      await interval.fill('1');
      parts = (await saveSeries(page, saves)).recurrence.split(';');
      expect(parts.filter(p => p.startsWith('INTERVAL='))).toHaveLength(0);
      expect(parts).toEqual(expect.arrayContaining(['FREQ=WEEKLY', 'BYDAY=MO,WE', 'WKST=SU', 'COUNT=6']));
    });

    test('Issue #231 — calendar names and attendee names are shown as text in the event and task dialogs', async ({ page }) => {
      const evil = `Team"><img src=x onerror="document.body.dataset.xss403='cal'"> 'Kalender'`;
      const calendars = [
        { id: calendarId, accountId: 'internal-caldav', name: evil, color: '#6366f1', href: `/${E2E_USER}/personal/`,
          isShared: false, readOnly: false, supportsVEVENT: true, supportsVTODO: true },
        { id: `internal-caldav::/${E2E_USER}/e2e-403'x/`, accountId: 'internal-caldav', name: 'Zweiter Kalender', color: '#123456',
          href: `/${E2E_USER}/e2e-403'x/`, isShared: false, readOnly: false, supportsVEVENT: true, supportsVTODO: true },
      ];
      await mockCalendars(page, calendars);
      const evilAttendee = `<img src=x onerror="document.body.dataset.xss403='att'"> O'Neil`;
      const [event] = series('e2e-403-xss', 'E2E 403 Escaping', 'FREQ=DAILY;COUNT=1', [
        ['2037-06-10T09:00:00+02:00', '2037-06-10T10:00:00+02:00', '2037-06-10T09:00:00'],
      ]);
      event.attendees = [{ name: evilAttendee, email: 'testuser@example.com', partstat: 'NEEDS-ACTION' }];
      await serve(page, [event]);
      await openAt(page, '2037-06-10');

      const optionsOf = sel => page.locator(`${sel} option`).evaluateAll(os => os.map(o => [o.value, o.textContent]));
      const expected = calendars.map(c => [c.id, c.name]);

      await openEdit(page, 'E2E 403 Escaping');
      expect(await optionsOf('#ev-calendar')).toEqual(expected);
      await expect(page.locator('#ev-calendar')).toHaveValue(calendarId);
      await expect(page.locator('#ev-attendee-list .attendee-name')).toHaveText(evilAttendee);
      await openEventSection(page, 'attendees');
      await page.fill('#ev-attendee-name', evilAttendee);
      await page.fill('#ev-attendee-email', 'testuser@example.com');
      await page.click('#add-attendee-btn');
      await expect(page.locator('#ev-attendee-list .attendee-name')).toHaveText([evilAttendee, evilAttendee]);
      await page.click('#event-cancel-btn');

      await page.click('#new-task-btn');
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expect(await optionsOf('#task-calendar-id')).toEqual(expected);

      await expect(page.locator('#event-modal img, #task-modal-backdrop img')).toHaveCount(0);
      expect(await page.evaluate(() => document.body.dataset.xss403)).toBeUndefined();
    });
  });

  test('should import a dropped ICS file and export a calendar as download', async ({ page }) => {
    await page.goto('/?date=2027-07-15');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });
    await page.click('#view-month');

    // Build an ICS with one event on 2027-07-15 and simulate dropping it on the sidebar
    const title = `Imported E2E ${Date.now()}`;
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT',
      `UID:e2e-import-${Date.now()}`,
      `DTSTART;VALUE=DATE:20270715`,
      `SUMMARY:${title}`,
      'END:VEVENT', 'END:VCALENDAR'
    ].join('\r\n');

    await page.evaluate((icsText) => {
      const dt = new DataTransfer();
      dt.items.add(new File([icsText], 'drop.ics', { type: 'text/calendar' }));
      document.querySelector('.sidebar').dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      );
    }, ics);

    await expect(page.locator('#import-dialog-backdrop')).toBeVisible();
    await page.click('#import-confirm');
    await expect(page.locator('#import-dialog-backdrop')).toBeHidden({ timeout: 20000 });

    const chip = page.locator(`.event-chip, .event-block, [data-event-uid]`).filter({ hasText: title }).first();
    await expect(chip).toBeVisible({ timeout: 15000 });

    // Export button triggers a .ics download
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#calendar-list [data-export-cal]').first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.ics$/);

    // Clean up the imported event
    await chip.click();
    await page.click('#popover-delete-btn');
    await page.click('#confirm-dialog-ok');
    await expect(chip).not.toBeVisible({ timeout: 10000 });
  });

  test('should switch views between month, week, workweek, day, and agenda on desktop', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

    // 1. Switch to Week View
    await page.click('#view-week');
    await expect(page.locator('.week-view')).toBeVisible({ timeout: 10000 });

    // 2. Switch to Workweek View
    await page.click('#view-workweek');
    await expect(page.locator('.week-view')).toBeVisible();
    const headerRow = page.locator('.week-header-row');
    await expect(headerRow).toHaveAttribute('style', /repeat\(5,\s*1fr\)/);

    // 3. Switch to Day View
    await page.click('#view-day');
    await expect(page.locator('.day-view')).toBeVisible();
    await expect(page.locator('.day-view .day-grid-body')).toBeVisible();
    await expect(page.locator('.week-view')).not.toBeVisible();

    // 4. Switch to Agenda View
    await page.click('#view-agenda');
    await expect(page.locator('.agenda-view')).toBeVisible();
    await expect(page.locator('.day-view')).not.toBeVisible();

    // 5. Switch back to Month View
    await page.click('#view-month');
    await expect(page.locator('.month-grid')).toBeVisible();
    await expect(page.locator('.agenda-view')).not.toBeVisible();
  });

  test('should layout toolbar responsively and switch views on mobile viewport', async ({ page }) => {
    // Set viewport to mobile size
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/?date=2026-08-25');
    await expect(page.locator('#loading-screen')).toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

    // Verify mobile menu hamburger button is visible
    const menuBtn = page.locator('#menu-btn');
    await expect(menuBtn).toBeVisible();

    // Verify toolbar title shows full text without truncating to "A…"
    const titleEl = page.locator('#toolbar-title');
    await expect(titleEl).toBeVisible();
    const titleText = await titleEl.textContent();
    expect(titleText).toContain('August 2026');
    expect(titleText).not.toBe('A…');

    // All 6 view tabs must be clickable via standard browser clicks on mobile viewport and render target container
    await page.click('#view-week');
    await expect(page.locator('#view-week')).toHaveClass(/active/);
    await expect(page.locator('.week-view')).toBeVisible({ timeout: 10000 });

    await page.click('#view-workweek');
    await expect(page.locator('#view-workweek')).toHaveClass(/active/);
    await expect(page.locator('.week-view')).toBeVisible({ timeout: 10000 });

    await page.click('#view-day');
    await expect(page.locator('#view-day')).toHaveClass(/active/);
    await expect(page.locator('.day-view')).toBeVisible({ timeout: 10000 });

    await page.click('#view-agenda');
    await expect(page.locator('#view-agenda')).toHaveClass(/active/);
    await expect(page.locator('.agenda-view')).toBeVisible({ timeout: 10000 });

    await page.click('#view-kanban');
    await expect(page.locator('#view-kanban')).toHaveClass(/active/);
    await expect(page.locator('.kanban-board')).toBeVisible({ timeout: 10000 });

    await page.click('#view-month');
    await expect(page.locator('#view-month')).toHaveClass(/active/);
    await expect(page.locator('.month-grid')).toBeVisible({ timeout: 10000 });
  });

  // Issue #85: on a short window the task dialog's footer stays on screen and the form scrolls.
  test('should allow saving and cancelling a task on a short viewport', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 400 });
    await page.goto('/');
    await expect(page.locator('#loading-screen')).toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

    await page.click('#new-task-btn');
    await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/);

    const cancelBtn = page.locator('#task-cancel-btn');
    const saveBtn = page.locator('#task-save-btn');
    // Wholly on screen and not covered or clipped: the topmost element at each button's centre.
    for (const btn of [cancelBtn, saveBtn]) {
      await expect(btn).toBeInViewport({ ratio: 1 });
      expect(await btn.evaluate(el => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })).toBe(true);
    }
    // The fields that do not fit are reached by scrolling the dialog body, not cut off.
    const body = page.locator('#task-modal .modal-body');
    expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const lastField = page.locator('#task-modal .modal-body :is(input, select, textarea):visible').last();
    await lastField.scrollIntoViewIfNeeded();
    await expect(lastField).toBeInViewport();
    await expect(saveBtn).toBeInViewport({ ratio: 1 });

    await cancelBtn.click();
    await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/);
  });

  test('Issue #168 — attendee fields and the share invitation are announced in gender-neutral German', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await openEventSection(page, 'attendees');
    const attendees = page.getByRole('group', { name: 'Teilnehmende' });
    await expect(attendees.getByRole('textbox', { name: 'Name der teilnehmenden Person', exact: true })).toBeVisible();
    await expect(attendees.getByRole('textbox', { name: 'E-Mail der teilnehmenden Person', exact: true })).toBeVisible();
    await expect(page.locator('#event-modal-backdrop')).not.toContainText(/Teilnehmer\b|Teilnehmers/);
    await page.click('#event-cancel-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);

    await page.locator('#calendar-list .calendar-item').first().locator('[data-share-cal]').click();
    const dialog = page.locator('#share-cal-dialog-backdrop');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.share-section-desc').first()).toContainText('den Namen einer Person');
    await expect(dialog.locator('.share-section-desc').first()).toContainText('um sie einzuladen.');
    await expect(dialog).not.toContainText(/\bihn\b|eines Benutzers|Benutzern\b/);
  });

  test('Issue #229 — renders and share-dialog cycles leave no click or keydown listener behind', async ({ page }) => {
    // Tally live click and keydown listeners per target: add/remove pairs cancel, so a count that grows is a leak.
    await page.addInitScript(() => {
      const live = { click: new Map(), keydown: new Map() };
      const add = EventTarget.prototype.addEventListener;
      const remove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (live[type] && listener) {
          if (!live[type].has(this)) live[type].set(this, new Set());
          live[type].get(this).add(listener);
        }
        return add.call(this, type, listener, options);
      };
      EventTarget.prototype.removeEventListener = function (type, listener, options) {
        if (live[type]) live[type].get(this)?.delete(listener);
        return remove.call(this, type, listener, options);
      };
      window.__clickListenerCount = target => live.click.get(target)?.size || 0;
      window.__keydownListenerCount = target => live.keydown.get(target)?.size || 0;
    });

    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });
    const counts = () => page.evaluate(() => ({
      document: window.__clickListenerCount(document),
      container: window.__clickListenerCount(document.getElementById('calendar-container')),
      containerKeydown: window.__keydownListenerCount(document.getElementById('calendar-container')),
      prevBtn: window.__clickListenerCount(document.getElementById('prev-btn')),
    }));

    // Renders: navigating re-renders into the stable #calendar-container.
    const afterBoot = await counts();
    expect(afterBoot.prevBtn).toBe(1);
    for (const view of ['#view-month', '#view-agenda']) {
      await page.click(view);
      for (let i = 0; i < 5; i++) await page.click('#next-btn');
    }
    const afterRenders = await counts();
    expect(afterRenders.container).toBe(afterBoot.container);
    expect(afterRenders.containerKeydown).toBe(afterBoot.containerKeydown);
    expect(afterRenders.prevBtn).toBe(1);

    // Share dialog: each open/close cycle must give back the document handler it added.
    const shareBtn = page.locator('#calendar-list .calendar-item').first().locator('[data-share-cal]');
    const backdrop = page.locator('#share-cal-dialog-backdrop');
    for (let i = 0; i < 4; i++) {
      await shareBtn.click();
      await expect(backdrop).toBeVisible();
      await expect(page.locator('#share-search-input')).toBeVisible();
      if (i % 2) await page.keyboard.press('Escape');
      else await page.click('#share-cal-close');
      await expect(backdrop).not.toBeAttached();
    }
    expect((await counts()).document).toBe(afterRenders.document);

    // While the dialog is open the outside-click handler still closes the autocomplete.
    await runSql(
      "INSERT OR IGNORE INTO users (user_id, username, email) VALUES ('testuser-id', 'testuser@example.com', 'testuser@example.com')"
    );
    await shareBtn.click();
    await page.locator('#share-search-input').fill('testuser');
    const dropdown = page.locator('#share-autocomplete-dropdown');
    await expect(dropdown).not.toHaveClass(/hidden/, { timeout: 10000 });
    await page.click('#share-cal-dialog-title');
    await expect(dropdown).toHaveClass(/hidden/);
    await page.click('#share-cal-close');
    await expect(backdrop).not.toBeAttached();
    expect((await counts()).document).toBe(afterRenders.document);
  });

  test('should open share dialog, autocomplete user, add share, and revoke share', async ({ page }) => {
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.error('PAGE ERROR:', err.message));

    // The share target is a second shard member; the server seeds no users itself (#211).
    await runSql(
      "INSERT OR IGNORE INTO users (user_id, username, email) VALUES ('testuser-id', 'testuser@example.com', 'testuser@example.com')"
    );

    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

    // Wait for calendar list items
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible();

    // Click on the share button of the first calendar item
    const shareBtn = page.locator('#calendar-list .calendar-item').first().locator('[data-share-cal]');
    await shareBtn.click();

    // Verify share dialog is open
    await expect(page.locator('#share-cal-dialog-backdrop')).toBeVisible();

    // Fill "testuser" in the search input
    const searchInput = page.locator('#share-search-input');
    await searchInput.fill('testuser');

    // Wait for autocomplete dropdown to become visible
    const dropdown = page.locator('#share-autocomplete-dropdown');
    await expect(dropdown).not.toHaveClass(/hidden/, { timeout: 10000 });

    // Verify it contains testuser@example.com
    await expect(dropdown).toContainText('testuser@example.com');

    // Click the autocomplete item for testuser@example.com
    await dropdown.locator('.autocomplete-item', { hasText: 'testuser@example.com' }).click();

    // Verify input value has updated to the email address
    await expect(searchInput).toHaveValue('testuser@example.com');

    // 1. Click "Hinzufügen" to add the share
    const addBtn = page.locator('#share-add-btn');
    await addBtn.click();

    // 2. Verify share shows up in the list
    const listContainer = page.locator('#share-list-container');
    await expect(listContainer).toContainText('testuser@example.com', { timeout: 10000 });

    // 3. Change role/permission of existing share to read-only ("false")
    const roleToggle = listContainer.locator('.share-role-toggle').first();
    await roleToggle.selectOption('false');
    await roleToggle.evaluate(el => el.dispatchEvent(new Event('change')));

    // Wait for the dropdown to be re-enabled (means update finished and reload occurred)
    await expect(roleToggle).not.toBeDisabled({ timeout: 10000 });
    await expect(roleToggle).toHaveValue('false');

    // 4. Click delete / revoke button
    const revokeBtn = listContainer.locator('.btn-revoke-share').first();
    await revokeBtn.click();
    await expect(page.locator('#confirm-dialog-text')).toContainText('entziehen');
    await page.click('#confirm-dialog-ok'); // Confirm revocation

    // 5. Verify share is removed from list
    await expect(listContainer).not.toContainText('testuser@example.com', { timeout: 10000 });
  });

  test('should enable public share link, export valid ICS feed, regenerate link, and revoke public link', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

    // Create an event to ensure the exported ICS feed contains VEVENT content
    const firstCalItem = page.locator('#calendar-list .calendar-item').first();
    const firstCalId = await firstCalItem.getAttribute('data-cal-id');

    const shareEventTitle = `Public ICS Event ${Date.now()}`;
    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    if (firstCalId) {
      await page.selectOption('#ev-calendar', firstCalId);
    }
    await page.fill('#ev-title', shareEventTitle);
    await page.fill('#ev-start-date', '2028-06-15');
    await page.fill('#ev-end-date', '2028-06-15');
    await page.check('#ev-allday');
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });

    // Open share dialog for the first calendar
    const shareBtn = firstCalItem.locator('[data-share-cal]');
    const linkLoaded = page.waitForResponse(r => r.url().includes('/public-link') && r.request().method() === 'GET');
    await shareBtn.click();
    await expect(page.locator('#share-cal-dialog-backdrop')).toBeVisible();
    const initialLink = await (await linkLoaded).json();

    const publicEnableCheckbox = page.locator('#public-link-enable');
    const publicArea = page.locator('#public-link-area');
    const publicInput = page.locator('#public-link-input');

    // 1. Enable a fresh public link (a leftover link from an earlier run is disabled first).
    // Wait until the dialog shows the loaded state, otherwise the leftover URL is read before its DELETE lands.
    await expect(publicEnableCheckbox).toBeChecked({ checked: initialLink.enabled, timeout: 10000 });
    if (initialLink.enabled) {
      const disabled = page.waitForResponse(r => r.url().includes('/public-link') && r.request().method() === 'DELETE');
      await publicEnableCheckbox.click();
      expect((await disabled).status()).toBe(200);
      await expect(publicArea).toHaveClass(/hidden/, { timeout: 10000 });
    }
    const enabled = page.waitForResponse(r => r.url().includes('/public-link') && r.request().method() === 'POST');
    await publicEnableCheckbox.click();
    const enabledLink = await (await enabled).json();
    await expect(publicArea).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(publicInput).toHaveValue(enabledLink.url);

    // 2. Extract public ICS share URL
    const publicUrl = await publicInput.inputValue();
    expect(publicUrl).toContain('/api/public/calendars/share/');
    expect(publicUrl).toContain('.ics');

    // 3. Issue #341: the feed defaults to free/busy — the event blocks its slot but its title stays private
    const publicDetail = page.locator('#public-link-detail');
    await expect(publicDetail).toBeVisible();
    await expect(publicDetail).toHaveValue('busy');
    const busyResponse = await request.get(publicUrl);
    expect(busyResponse.status()).toBe(200);
    expect(busyResponse.headers()['content-type']).toContain('text/calendar');
    const busyText = await busyResponse.text();
    expect(busyText).toContain('BEGIN:VCALENDAR');
    expect(busyText).toContain('DTSTART;VALUE=DATE:20280615');
    expect(busyText).not.toContain(shareEventTitle);

    // Switching the dialog to "full details" publishes titles on the same link
    const detailSaved = page.waitForResponse(r => r.url().includes('/public-link') && r.request().method() === 'PUT');
    await publicDetail.selectOption('full');
    expect((await detailSaved).status()).toBe(200);
    const icsResponse = await request.get(publicUrl);
    expect(icsResponse.status()).toBe(200);
    const icsText = await icsResponse.text();
    expect(icsText).toContain('BEGIN:VEVENT');
    expect(icsText).toContain(shareEventTitle);
    expect(icsText).toContain('END:VCALENDAR');

    // Reopening the dialog shows the stored level
    await page.click('#share-cal-close');
    const linkReloaded = page.waitForResponse(r => r.url().includes('/public-link') && r.request().method() === 'GET');
    await shareBtn.click();
    await expect(page.locator('#share-cal-dialog-backdrop')).toBeVisible();
    await linkReloaded;
    await expect(publicDetail).toHaveValue('full');
    // Each status load re-encrypts the token, so the reopened URL is the baseline for regeneration
    const reopenedUrl = await publicInput.inputValue();
    expect((await request.get(reopenedUrl)).status()).toBe(200);

    // 4. Regenerate link
    const regenerated = page.waitForResponse(r => r.url().includes('/public-link') && r.request().method() === 'POST');
    await page.click('#public-link-regen-btn');
    await page.click('#confirm-dialog-ok');
    expect((await regenerated).status()).toBe(200);

    // Wait for public input to update to new URL
    await page.waitForFunction(
      (oldUrl) => {
        const input = document.querySelector('#public-link-input');
        return input && input.value && input.value !== oldUrl;
      },
      reopenedUrl,
      { timeout: 10000 }
    );

    const newPublicUrl = await publicInput.inputValue();
    expect(newPublicUrl).not.toBe(publicUrl);
    expect(newPublicUrl).toContain('/api/public/calendars/share/');

    // 5. Verify regenerated link fetches valid ICS (and keeps the chosen detail level); the old one is dead
    const newIcsRes = await request.get(newPublicUrl);
    expect(newIcsRes.status()).toBe(200);
    expect(await newIcsRes.text()).toContain(shareEventTitle);
    expect((await request.get(reopenedUrl)).status()).toBe(404);

    // 6. Disable/revoke public link
    await publicEnableCheckbox.click();
    await expect(publicArea).toHaveClass(/hidden/);

    // 7. Verify old and new public links return 404
    const deadRes1 = await request.get(publicUrl);
    expect(deadRes1.status()).toBe(404);
    const deadRes2 = await request.get(newPublicUrl);
    expect(deadRes2.status()).toBe(404);

    // Close share modal cleanly
    await page.click('#share-cal-close');
    await expect(page.locator('#share-cal-dialog-backdrop')).not.toBeAttached();
  });

  test('should create an event with a VALARM reminder and edit alarm setting', async ({ page }) => {
    await page.goto('/?date=2027-12-15');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });
    await page.click('#view-month');

    // Open create modal
    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    const calVal = await page.locator('#ev-calendar option:not([value=""])').first().getAttribute('value');
    if (calVal) await page.selectOption('#ev-calendar', calVal);
    const title = `VALARM Reminder Event ${Date.now()}`;
    await page.fill('#ev-title', title);
    await page.fill('#ev-start-date', '2027-12-15');
    await page.fill('#ev-end-date', '2027-12-15');
    await page.check('#ev-allday');

    // Add a reminder 15 minutes before the start
    await addReminder(page, 'ev', { amount: 15 });
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });

    // Verify event chip appears
    const chip = page.locator(`.event-chip:has-text("${title}"), .event-block:has-text("${title}")`).first();
    await expect(chip).toBeVisible({ timeout: 10000 });

    // Click popover and edit
    await chip.click();
    await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);
    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);

    // The reminder is loaded as 15 minutes before the start
    const row = page.locator('#ev-reminder-list .reminder-row');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.reminder-amount')).toHaveValue('15');
    await expect(row.locator('.reminder-unit')).toHaveValue('M');
    await expect(row.locator('.reminder-direction')).toHaveValue('-');

    // Update the reminder to 1 hour before
    await row.locator('.reminder-amount').fill('1');
    await row.locator('.reminder-unit').selectOption('H');
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);

    // Clean up test 9 event
    await chip.click();
    await page.click('#popover-delete-btn');
    await page.click('#confirm-dialog-ok');
    await expect(chip).not.toBeVisible({ timeout: 10000 });
  });

  test('should create timed event asserting clock times, stored DESCRIPTION and LOCATION fields, and special character escIcal preservation', async ({ page }) => {
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    await page.goto('/?date=2038-11-20');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });
    await page.click('#view-month');
    await expect(page.locator('.month-grid')).toBeVisible({ timeout: 10000 });

    // Issue #216: `;`, `,` and `\` must be escaped on write, or the title read back differs.
    const title = `Special & Critical; Meeting, Q3 C:\\new ${Date.now()}`;
    const location = 'Room #101 (Bldg B; Floor 2, Zone 3)';
    const description = 'Notes:\n- Feature A; test\n- Feature B, ok';
    const startTime = '09:30';
    const endTime = '10:30';

    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    const calVal = await page.locator('#ev-calendar option:not([value=""])').first().getAttribute('value');
    if (calVal) {
      await page.selectOption('#ev-calendar', calVal);
    }

    await page.fill('#ev-title', title);
    await page.fill('#ev-location', location);
    await page.fill('#ev-description', description);
    await page.fill('#ev-start-date', '2038-11-20');
    await page.fill('#ev-end-date', '2038-11-20');
    if (await page.isChecked('#ev-allday')) {
      await page.uncheck('#ev-allday');
      await page.dispatchEvent('#ev-allday', 'change');
    }
    await page.fill('#ev-start-time', startTime);
    await page.fill('#ev-end-time', endTime);

    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
    await expectSavesLanded(page);

    const eventChip = page.locator('.event-chip, [data-event-uid]').filter({ hasText: title }).first();

    // Everything below is read back from the server after a reload, never from what was typed.
    // The second pass saves the loaded event unchanged (issue #216, assertion 4): a write path that
    // shifts DTSTART or drops a field on every save shows up only there.
    for (const pass of ['after create', 'after a second, unchanged save']) {
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(eventChip, pass).toBeVisible({ timeout: 15000 });

      await eventChip.click();
      await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);
      await expect(page.locator('#popover-title'), pass).toHaveText(title);
      await expect(page.locator('#event-popover'), pass).toContainText(`${startTime}`);
      await expect(page.locator('#event-popover'), pass).toContainText(`${endTime}`);
      await expect(page.locator('.popover-location'), pass).toContainText(location);
      await expect(page.locator('.popover-description'), pass).toContainText('Feature A; test');

      await page.click('#popover-edit-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#ev-title'), pass).toHaveValue(title);
      await expect(page.locator('#ev-start-date'), pass).toHaveValue('2038-11-20');
      await expect(page.locator('#ev-start-time'), pass).toHaveValue(startTime);
      await expect(page.locator('#ev-end-time'), pass).toHaveValue(endTime);
      await expect(page.locator('#ev-location'), pass).toHaveValue(location);
      await expect(page.locator('#ev-description'), pass).toHaveValue(description);

      if (pass === 'after create') {
        await page.click('#event-save-btn');
        await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
        await expectSavesLanded(page);
      } else {
        await page.click('#event-cancel-btn');
        await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
      }
    }

    // Clean up created test event — wait for the DELETE API response
    const deleteResponsePromise = page.waitForResponse(
      resp => resp.request().method() === 'DELETE' && resp.url().includes('/api/events'),
      { timeout: 10000 }
    );
    await eventChip.click();
    await page.click('#popover-delete-btn');
    await page.click('#confirm-dialog-ok');
    await deleteResponsePromise;
    // Give the UI a moment to re-render after delete
    await page.waitForTimeout(1000);
  });

  test('should trigger desktop push notification and UI toast displaying event title, time, and location when VALARM is due', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

    // Mock HTML5 Notification API in page context
    await page.evaluate(() => {
      window.desktopNotifications = [];
      window.Notification = class {
        constructor(title, options) {
          window.desktopNotifications.push({ title, options });
        }
        static permission = 'granted';
        static requestPermission() {
          return Promise.resolve('granted');
        }
      };
    });

    const title = `Push Reminder ${Date.now()}`;
    const location = 'Conference Room B';
    const today = new Date().toISOString().split('T')[0];

    // Create event via real UI form with VALARM
    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    const calVal = await page.locator('#ev-calendar option:not([value=""])').first().getAttribute('value');
    if (calVal) await page.selectOption('#ev-calendar', calVal);
    await page.fill('#ev-title', title);
    await page.fill('#ev-location', location);
    await page.fill('#ev-start-date', today);
    await page.fill('#ev-end-date', today);
    await page.check('#ev-allday');
    await addReminder(page, 'ev', { amount: 0 });

    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
    // The stored event reminds, not the optimistic preview of the save (#357).
    await expectSavesLanded(page);

    // Trigger alarm check in application
    await page.evaluate(() => {
      if (typeof window.__checkAndTriggerAlarms === 'function') {
        window.__checkAndTriggerAlarms();
      }
    });

    // Verify UI Toast appears displaying title, time, and location
    const alarmToast = page.locator('#toast-container .toast', { hasText: title });
    await expect(alarmToast).toBeVisible({ timeout: 5000 });
    await expect(alarmToast).toContainText('Ort: Conference Room B');

    // Verify mock Notification API received desktop push notification
    const notifications = await page.evaluate(() => window.desktopNotifications);
    const targetNotif = notifications.find(n => n.title && n.title.includes(title));
    expect(targetNotif).toBeTruthy();
    expect(targetNotif.options.body).toContain('Ort: Conference Room B');
  });

  test('Issue #357 — a due reminder fires once, for the stored event, not for the preview of a save still in flight', async ({ page }) => {
    // Hold the create request, so the dialog has closed and the optimistic preview (#174) is drawn
    // while the save is still running.
    let releaseSave;
    const saveHeld = new Promise(resolve => { releaseSave = resolve; });
    await page.route('**/api/events', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await saveHeld;
      return route.fallback();
    });
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });
    await page.evaluate(() => {
      window.desktopNotifications = [];
      window.Notification = class {
        constructor(title, options) { window.desktopNotifications.push({ title, options }); }
        static permission = 'granted';
        static requestPermission() { return Promise.resolve('granted'); }
      };
    });

    const title = `Once Reminder ${Date.now()}`;
    const today = new Date().toISOString().split('T')[0];
    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    await page.selectOption('#ev-calendar', await page.locator('#ev-calendar option:not([value=""])').first().getAttribute('value'));
    await page.fill('#ev-title', title);
    await page.fill('#ev-start-date', today);
    await page.fill('#ev-end-date', today);
    await page.check('#ev-allday');
    await addReminder(page, 'ev', { amount: 0 });
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });

    const reminderToasts = page.locator('#toast-container .toast', { hasText: `Erinnerung: ${title}` });
    const desktopReminders = () => page.evaluate(t => window.desktopNotifications.filter(n => n.title === `Erinnerung: ${t}`).length, title);

    // The preview is due, but a save in flight reminds of nothing.
    await expect(page.locator('.event-pending', { hasText: title })).toHaveCount(1);
    await page.evaluate(() => window.__checkAndTriggerAlarms());
    // Counted once, not polled: a retrying toHaveCount(0) would pass as soon as a toast faded.
    expect(await reminderToasts.count()).toBe(0);
    expect(await desktopReminders()).toBe(0);

    // Once the stored event has landed it reminds, exactly once, also across the 5 s check interval
    // (toasts fade after 4 s, the desktop notifications are counted instead).
    releaseSave();
    await expectSavesLanded(page);
    await page.evaluate(() => window.__checkAndTriggerAlarms());
    await expect(reminderToasts).toHaveCount(1);
    expect(await desktopReminders()).toBe(1);
    await page.waitForTimeout(5500);
    expect(await desktopReminders()).toBe(1);
  });


  test('should create a VTODO task with RRULE, view in sidebar and Kanban board, and complete it', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });

    // Open task create modal
    await page.click('#new-task-btn');
    await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#task-calendar-id option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    const calVal = await page.locator('#task-calendar-id option:not([value=""])').first().getAttribute('value');
    if (calVal) await page.selectOption('#task-calendar-id', calVal);

    const taskTitle = `E2E VTODO Task ${Date.now()}`;
    await page.fill('#task-title', taskTitle);
    await page.fill('#task-description', 'Testing VTODO Kanban and RRULE advancement');
    await page.selectOption('#task-priority', '1');
    await page.selectOption('#task-recurrence', 'FREQ=WEEKLY');
    await page.fill('#task-due', '2036-08-11T09:00');

    // Save task
    await page.click('#task-save-btn');
    await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });

    // Verify task is listed in sidebar tasks section
    const sidebarList = page.locator('#sidebar-task-list');
    await expect(sidebarList).toContainText(taskTitle, { timeout: 10000 });

    // Switch to Kanban View
    await page.click('#view-kanban');
    await expect(page.locator('.kanban-board')).toBeVisible();

    // Verify task card appears in 'Zu erledigen' column
    const card = page.locator(`.kanban-card:has-text("${taskTitle}")`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText('Hoch');
    await expect(card).toContainText('Wöchentlich');

    // Move task to 'In Bearbeitung' via ➡️
    await card.locator('.btn-status-next').click();
    const cardInProcess = page.locator('#kanban-cards-in-process .kanban-card', { hasText: taskTitle });
    await expect(cardInProcess).toBeVisible({ timeout: 10000 });

    // Complete recurring task via ✓ -> should advance next due date and reset to 'Zu erledigen'
    await cardInProcess.locator('.btn-complete').click();
    const cardResetted = page.locator('#kanban-cards-todo .kanban-card', { hasText: taskTitle });
    await expect(cardResetted).toBeVisible({ timeout: 10000 });

    // Issue #95: the server rolls the master forward one week and stores the
    // finished occurrence as its own RECURRENCE-ID + STATUS:COMPLETED VTODO.
    const stored = await page.evaluate(async (title) => {
      const res = await fetch('/api/tasks');
      const body = await res.json();
      const list = Array.isArray(body) ? body : body.tasks;
      const t = list.find(x => x.title === title);
      return t ? { due: t.due, status: t.status, rawIcs: t.rawIcs } : null;
    }, taskTitle);
    expect(stored).not.toBeNull();
    expect(stored.status).toBe('NEEDS-ACTION');
    expect(stored.due).toBe(new Date(2036, 7, 18, 9, 0).toISOString());
    const unfolded = stored.rawIcs.replace(/\r?\n[ \t]/g, '');
    expect(unfolded.match(/BEGIN:VTODO/g)).toHaveLength(2);
    const instance = unfolded.split('BEGIN:VTODO').find(c => /RECURRENCE-ID/.test(c));
    expect(instance).toMatch(new RegExp(`RECURRENCE-ID:${new Date(2036, 7, 11, 9, 0).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`));
    expect(instance).toMatch(/STATUS:COMPLETED/);

    // Clean up: delete task
    await cardResetted.locator('.btn-delete').click();
    await page.click('#confirm-dialog-ok');
    // The finished occurrence (#264) lives in the same resource and goes with it.
    await expect(page.locator('.kanban-card', { hasText: taskTitle })).toHaveCount(0, { timeout: 10000 });
  });

  test('Issue #264 — completing a recurring task on the board puts the finished occurrence into Erledigt', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });

    await page.click('#new-task-btn');
    await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#task-calendar-id option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    const taskTitle = `E2E Recur Done ${Date.now()}`;
    await page.fill('#task-title', taskTitle);
    await page.selectOption('#task-recurrence', 'FREQ=WEEKLY');
    await page.fill('#task-due', '2036-08-11T09:00');
    await page.click('#task-save-btn');
    await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });

    await page.click('#view-kanban');
    await expect(page.locator('.kanban-board')).toBeVisible();
    const todo = page.locator('#kanban-cards-todo .kanban-card', { hasText: taskTitle });
    const done = page.locator('#kanban-cards-completed .kanban-card', { hasText: taskTitle });
    await expect(todo).toHaveCount(1, { timeout: 10000 });
    await expect(done).toHaveCount(0);
    const completedCount = Number(await page.locator('.count-completed').textContent());

    // Two presses of "Als erledigt markieren": each finished occurrence lands in Erledigt,
    // the series itself moves on and stays in "Zu erledigen".
    await todo.locator('.btn-complete').click();
    await expect(done).toHaveCount(1, { timeout: 10000 });
    await expect(todo).toContainText('18.08.2036');
    await todo.locator('.btn-complete').click();
    await expect(done).toHaveCount(2, { timeout: 10000 });
    await expect(todo).toHaveCount(1);
    await expect(todo).toContainText('25.08.2036');
    await expect(page.locator('.count-completed')).toHaveText(String(completedCount + 2));
    await expect(done.filter({ hasText: '11.08.2036' })).toHaveCount(1);
    await expect(done.filter({ hasText: '18.08.2036' })).toHaveCount(1);

    // An occurrence shares the series' resource: no button on it may touch the series.
    await expect(done.locator('button')).toHaveCount(0);

    // The board is fed by stored data, not by client state: a reload shows the same columns.
    await page.reload();
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await page.click('#view-kanban');
    await expect(done).toHaveCount(2, { timeout: 10000 });
    await expect(todo).toHaveCount(1);

    // Deleting the series removes its finished occurrences with it.
    await todo.locator('.btn-delete').click();
    await page.click('#confirm-dialog-ok');
    await expect(page.locator('.kanban-card', { hasText: taskTitle })).toHaveCount(0, { timeout: 10000 });
  });

  test('Issue #309 — the task create modal authors DTSTART, DURATION, PERCENT-COMPLETE and a rule outside the preset list', async ({ page }) => {
    const rule = 'FREQ=MONTHLY;INTERVAL=2;BYDAY=1MO,-1FR;BYMONTHDAY=15;COUNT=10';
    const storedTask = (title) => page.evaluate(async (t) => {
      const res = await fetch('/api/tasks');
      const body = await res.json();
      const list = Array.isArray(body) ? body : body.tasks;
      const found = list.find(x => x.title === t);
      return found ? { recurrence: found.recurrence, rawIcs: found.rawIcs.replace(/\r?\n[ \t]/g, '') } : null;
    }, title);

    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });

    await page.click('#new-task-btn');
    await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#task-calendar-id option').first()).toBeAttached({ timeout: 10000 });

    // The rule field only appears once the custom option is chosen.
    await expect(page.locator('#task-recurrence-custom')).toBeHidden();
    const taskTitle = `E2E Custom RRULE Task ${Date.now()}`;
    await page.fill('#task-title', taskTitle);
    await page.fill('#task-dtstart', '2036-09-01T09:00');
    await page.fill('#task-duration', 'PT2H');
    await page.fill('#task-percent-complete', '40');
    await page.selectOption('#task-recurrence', 'CUSTOM');
    await expect(page.locator('#task-recurrence-custom')).toBeVisible();
    await page.fill('#task-recurrence-custom', rule);
    await page.click('#task-save-btn');
    await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });

    await expect.poll(() => storedTask(taskTitle), { timeout: 10000 }).not.toBeNull();
    const created = await storedTask(taskTitle);
    expect(created.rawIcs).toMatch(new RegExp(`^RRULE:${rule}\\r?$`, 'm'));
    expect(created.rawIcs).toContain(`DTSTART:${new Date(2036, 8, 1, 9, 0).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
    expect(created.rawIcs).toContain('DURATION:PT2H');
    expect(created.rawIcs).toContain('PERCENT-COMPLETE:40');

    // Reopening shows the stored rule in the custom field, and saving without edits keeps it.
    await page.click('#view-kanban');
    const card = page.locator('.kanban-card', { hasText: taskTitle });
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.locator('.btn-edit').click();
    await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#task-recurrence')).toHaveValue('CUSTOM');
    await expect(page.locator('#task-recurrence-custom')).toBeVisible();
    await expect(page.locator('#task-recurrence-custom')).toHaveValue(created.recurrence);
    await page.click('#task-save-btn');
    await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
    const saved = await storedTask(taskTitle);
    expect(saved.recurrence).toBe(created.recurrence);

    // The next create starts without a rule and with the field hidden again.
    await page.click('#new-task-btn');
    await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#task-recurrence')).toHaveValue('');
    await expect(page.locator('#task-recurrence-custom')).toBeHidden();
    await expect(page.locator('#task-recurrence-custom')).toHaveValue('');
    await page.click('#task-cancel-btn');

    await card.locator('.btn-delete').click();
    await page.click('#confirm-dialog-ok');
    await expect(page.locator('.kanban-card', { hasText: taskTitle })).toHaveCount(0, { timeout: 10000 });
  });

  test('Issue #261 — a zero-edit save of a task keeps a rule the preset options cannot hold', async ({ page }) => {
    const calendarId = `internal-caldav::/${E2E_USER}/tasks/`;
    const rules = ['FREQ=WEEKLY;COUNT=6;BYDAY=MO', 'FREQ=DAILY;INTERVAL=2', 'FREQ=MONTHLY;UNTIL=20370101T000000Z'];
    const stamp = Date.now();
    const storedRule = (title) => page.evaluate(async (t) => {
      const res = await fetch('/api/tasks');
      const body = await res.json();
      const list = Array.isArray(body) ? body : body.tasks;
      const found = list.find(x => x.title === t);
      if (!found) return null;
      const line = found.rawIcs.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).find(l => l.startsWith('RRULE:'));
      return { recurrence: found.recurrence, rrule: line || null };
    }, title);

    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expectOwnCalendar(page, calendarId);
    const titles = [];
    for (const [i, rule] of rules.entries()) {
      const title = `E2E Issue261 Task ${i} ${stamp}`;
      const created = await page.request.post('/api/tasks', {
        headers: SAME_ORIGIN,
        data: { calendarId, title, due: '2036-08-24T15:00:00.000Z', recurrence: rule },
      });
      expect(created.status()).toBe(201);
      expect(await storedRule(title)).toEqual({ recurrence: rule, rrule: `RRULE:${rule}` });
      titles.push(title);
    }

    await page.reload();
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await page.click('#view-kanban');
    for (const [i, rule] of rules.entries()) {
      const card = page.locator('.kanban-card', { hasText: titles[i] });
      await expect(card).toBeVisible({ timeout: 10000 });
      await card.locator('.btn-edit').click();
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      // Nothing is touched: the modal must hold the rule exactly as loaded and send it back.
      await expect(page.locator('#task-recurrence')).toHaveValue('CUSTOM');
      await expect(page.locator('#task-recurrence-custom')).toHaveValue(rule);
      const put = page.waitForRequest(r => r.method() === 'PUT' && r.url().includes('/api/tasks/'));
      await page.click('#task-save-btn');
      expect((await put).postDataJSON().recurrence).toBe(rule);
      await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
      expect(await storedRule(titles[i])).toEqual({ recurrence: rule, rrule: `RRULE:${rule}` });
    }

    for (const title of titles) {
      await page.locator('.kanban-card', { hasText: title }).locator('.btn-delete').click();
      await page.click('#confirm-dialog-ok');
      await expect(page.locator('.kanban-card', { hasText: title })).toHaveCount(0, { timeout: 10000 });
    }
  });

  test.describe('Issue #499 — the status changes by moving a card to another lane', () => {
    const LANES = { 'NEEDS-ACTION': '#kanban-cards-todo', 'IN-PROCESS': '#kanban-cards-in-process',
      COMPLETED: '#kanban-cards-completed', CANCELLED: '#kanban-cards-cancelled' };

    // A mouse drag in small steps, as a person would do it, from the card's title into a lane.
    async function mouseDrag(page, card, status) {
      const from = await card.locator('.kanban-card-title').boundingBox();
      const to = await page.locator(LANES[status]).boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
      await page.mouse.up();
    }

    test('dragging stores each RFC 5545 status, with COMPLETED and PERCENT-COMPLETE on completion', async ({ page }) => {
      const title = `E2E Issue499 Drag ${Date.now()}`;
      const stored = () => page.evaluate(async (t) => {
        const res = await fetch('/api/tasks');
        const body = await res.json();
        const list = Array.isArray(body) ? body : body.tasks;
        const found = list.find(x => x.title === t);
        return found ? { status: found.status, ics: found.rawIcs.replace(/\r?\n[ \t]/g, '') } : null;
      }, title);

      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      // The first calendar listing creates the default collections, the task list among them.
      await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });
      const listed = await (await page.request.get('/api/calendars')).json();
      const taskList = listed.calendars.find(c => c.accountId === 'internal-caldav' && c.supportsVTODO && !c.supportsVEVENT && !c.readOnly);
      expect(taskList).toBeTruthy();
      const created = await page.request.post('/api/tasks', { headers: SAME_ORIGIN, data: { calendarId: taskList.id, title } });
      expect(created.status()).toBe(201);
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#view-kanban');
      const card = page.locator('.kanban-card', { hasText: title });
      await expect(page.locator(LANES['NEEDS-ACTION']).locator('.kanban-card', { hasText: title })).toHaveCount(1, { timeout: 10000 });

      for (const status of ['IN-PROCESS', 'COMPLETED', 'CANCELLED', 'NEEDS-ACTION']) {
        const put = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/api/tasks/'));
        await mouseDrag(page, card, status);
        expect((await put).status()).toBe(200);
        await expect(page.locator(LANES[status]).locator('.kanban-card', { hasText: title })).toHaveCount(1, { timeout: 10000 });
        await expect(page.locator('.kanban-card-pending')).toHaveCount(0, { timeout: 10000 });
        const s = await stored();
        expect(s.status).toBe(status);
        expect(s.ics).toMatch(new RegExp(`^STATUS:${status}\\r?$`, 'm'));
        if (status === 'COMPLETED') {
          expect(s.ics).toMatch(/^COMPLETED:\d{8}T\d{6}Z\r?$/m);
          expect(s.ics).toMatch(/^PERCENT-COMPLETE:100\r?$/m);
        } else {
          expect(s.ics).not.toMatch(/^COMPLETED:/m);
          expect(s.ics).not.toMatch(/^PERCENT-COMPLETE:100\r?$/m);
        }
      }

      await card.locator('.btn-delete').click();
      await page.click('#confirm-dialog-ok');
      await expect(card).toHaveCount(0, { timeout: 10000 });
    });

    test.describe('against a served task list', () => {
      test.use({ serviceWorkers: 'block' });
      let writableCal;
      let sharedCal;
      // #592: the ids name the test's own user, known only once its fixture is set up.
      test.beforeEach(() => {
        writableCal = `internal-caldav::/${E2E_USER}/personal/`;
        sharedCal = `internal-caldav::/${E2E_USER}/e2e-499-shared/`;
      });
      let tasks;
      let failPut;
      let releasePut;
      let puts;

      test.beforeEach(async ({ page }) => {
        tasks = [
          { uid: 'e2e-499-own', title: 'E2E 499 Eigene', status: 'NEEDS-ACTION', percentComplete: 0,
            calendarId: writableCal, href: `/${E2E_USER}/personal/e2e-499-own.ics`, etag: '"1"' },
          { uid: 'e2e-499-shared', title: 'E2E 499 Geteilt', status: 'NEEDS-ACTION', percentComplete: 0,
            calendarId: sharedCal, href: `/${E2E_USER}/e2e-499-shared/e2e-499-shared.ics`, etag: '"1"' },
        ];
        failPut = false;
        releasePut = null;
        puts = [];
        const calendars = [
          { id: writableCal, accountId: 'internal-caldav', name: 'Persönlich', color: '#6366f1', href: `/${E2E_USER}/personal/`,
            isShared: false, readOnly: false, supportsVEVENT: true, supportsVTODO: true },
          { id: sharedCal, accountId: 'internal-caldav', name: 'Geteilt', color: '#123456', href: `/${E2E_USER}/e2e-499-shared/`,
            isShared: true, readOnly: true, supportsVEVENT: false, supportsVTODO: true },
        ];
        await mockCalendars(page, calendars);
        await page.route(/\/api\/tasks(\?.*)?$/, route => (route.request().method() === 'GET'
          ? route.fulfill({ json: tasks })
          : route.fallback()));
        await page.route(/\/api\/tasks\/[^/?]+$/, async route => {
          if (route.request().method() !== 'PUT') return route.fallback();
          const body = route.request().postDataJSON();
          puts.push(body);
          if (releasePut) await releasePut;
          if (failPut) return route.fulfill({ status: 500, json: { error: 'CalDAV nicht erreichbar' } });
          tasks = tasks.map(t => (t.uid === body.uid ? { ...t, status: body.status } : t));
          return route.fulfill({ json: { ...body } });
        });
        await page.goto('/');
        await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
        await page.click('#view-kanban');
        await expect(page.locator('.kanban-card', { hasText: 'E2E 499 Eigene' })).toBeVisible({ timeout: 10000 });
      });

      test('the move is shown at once and rolled back visibly when the save fails', async ({ page }) => {
        failPut = true;
        let release;
        releasePut = new Promise(r => { release = r; });
        const card = page.locator('.kanban-card', { hasText: 'E2E 499 Eigene' });
        await mouseDrag(page, card, 'IN-PROCESS');

        // Optimistic: while the server has not answered, the card already sits in the new lane.
        const inProcess = page.locator(LANES['IN-PROCESS']).locator('.kanban-card', { hasText: 'E2E 499 Eigene' });
        await expect(inProcess).toHaveCount(1);
        await expect(inProcess).toHaveClass(/kanban-card-pending/);
        await expect(page.locator('.count-in-process')).toHaveText('1');
        expect(puts).toHaveLength(1);
        expect(puts[0]).toMatchObject({ uid: 'e2e-499-own', status: 'IN-PROCESS', calendarId: writableCal });

        release();
        const back = page.locator(LANES['NEEDS-ACTION']).locator('.kanban-card', { hasText: 'E2E 499 Eigene' });
        await expect(back).toHaveCount(1, { timeout: 10000 });
        await expect(back).toHaveClass(/kanban-card-rolled-back/);
        await expect(page.locator('.count-in-process')).toHaveText('0');
        await expect(page.locator('#toast-container .toast.error', { hasText: 'CalDAV nicht erreichbar' })).toBeVisible();
      });

      test('the status menu on a card moves it with the keyboard alone', async ({ page }) => {
        const card = page.locator('.kanban-card', { hasText: 'E2E 499 Eigene' });
        const menu = card.locator('.kanban-status-select');
        await expect(menu).toHaveAccessibleName('Status von „E2E 499 Eigene“');
        await expect(menu).toHaveValue('NEEDS-ACTION');
        await expect(menu.locator('option')).toHaveText(['Zu erledigen', 'In Bearbeitung', 'Erledigt', 'Abgebrochen']);

        // A native select: arrow keys pick the next status, as does a tap on a phone.
        await menu.focus();
        await page.keyboard.press('ArrowDown');
        await expect(page.locator(LANES['IN-PROCESS']).locator('.kanban-card', { hasText: 'E2E 499 Eigene' })).toHaveCount(1, { timeout: 10000 });
        expect(puts.at(-1)).toMatchObject({ status: 'IN-PROCESS' });
        // Focus follows the card into its new lane.
        await expect(page.locator(LANES['IN-PROCESS']).locator('.kanban-status-select')).toBeFocused();

        // A card waits for its save before it moves again.
        await expect(page.locator('.kanban-card-pending')).toHaveCount(0, { timeout: 10000 });
        await page.keyboard.press('ArrowDown');
        await expect(page.locator(LANES.COMPLETED).locator('.kanban-status-select')).toBeFocused({ timeout: 10000 });
        await expect(page.locator('.kanban-card-pending')).toHaveCount(0, { timeout: 10000 });
        await page.keyboard.press('ArrowDown');
        await expect(page.locator(LANES.CANCELLED).locator('.kanban-card', { hasText: 'E2E 499 Eigene' })).toHaveCount(1, { timeout: 10000 });
        expect(puts.map(p => p.status)).toEqual(['IN-PROCESS', 'COMPLETED', 'CANCELLED']);
        expect(puts[1]).toMatchObject({ percentComplete: 100 });
      });

      test('a card is dragged by touch on its grip', async ({ page }) => {
        const card = page.locator('.kanban-card', { hasText: 'E2E 499 Eigene' });
        const grip = await card.locator('.kanban-drag-handle').boundingBox();
        const to = await page.locator(LANES.COMPLETED).boundingBox();
        const cdp = await page.context().newCDPSession(page);
        const x0 = grip.x + grip.width / 2;
        const y0 = grip.y + grip.height / 2;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
        for (let i = 1; i <= 12; i++) {
          const x = x0 + ((to.x + to.width / 2) - x0) * i / 12;
          const y = y0 + ((to.y + to.height / 2) - y0) * i / 12;
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect(page.locator(LANES.COMPLETED).locator('.kanban-card', { hasText: 'E2E 499 Eigene' })).toHaveCount(1, { timeout: 10000 });
        expect(puts).toHaveLength(1);
        expect(puts[0]).toMatchObject({ status: 'COMPLETED', percentComplete: 100 });
      });

      test('a card of a read-only collection cannot be dragged and has no status menu', async ({ page }) => {
        const card = page.locator('.kanban-card', { hasText: 'E2E 499 Geteilt' });
        await expect(card).toBeVisible();
        await expect(card.locator('.kanban-status-select')).toHaveCount(0);
        await expect(card.locator('.kanban-drag-handle')).toHaveCount(0);
        await expect(card.locator('.btn-status-next, .btn-complete, .btn-reopen')).toHaveCount(0);
        await mouseDrag(page, card, 'COMPLETED');
        await expect(page.locator(LANES.COMPLETED).locator('.kanban-card')).toHaveCount(0);
        await expect(page.locator(LANES['NEEDS-ACTION']).locator('.kanban-card', { hasText: 'E2E 499 Geteilt' })).toHaveCount(1);
        expect(puts).toHaveLength(0);
        // The writable card next to it still has both.
        const own = page.locator('.kanban-card', { hasText: 'E2E 499 Eigene' });
        await expect(own.locator('.kanban-status-select')).toHaveCount(1);
        await expect(own.locator('.kanban-drag-handle')).toHaveCount(1);
      });
    });
  });

  test.describe('Issue #182 — sidebar controls are keyboard operable', () => {
    // The sidebar shows only the first 10 pending tasks, so a task created on
    // the shared Radicale could be pushed out by leftovers from other runs.
    // Serve a fixed task list instead; page.route needs the service worker off.
    test.use({ serviceWorkers: 'block' });
    const taskTitle = 'E2E Keyboard Task';

    test.beforeEach(async ({ page }) => {
      await page.route(/\/api\/tasks(\?.*)?$/, route => {
        if (route.request().method() !== 'GET') return route.continue();
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify([{
            uid: 'e2e-issue182-task',
            title: taskTitle,
            status: 'NEEDS-ACTION',
            calendarId: `internal-caldav::/${E2E_USER}/personal/`,
            href: `/${E2E_USER}/personal/e2e-issue182-task.ics`,
            etag: '"1"',
          }]),
        });
      });
      await page.goto('/?date=2027-03-10');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });
      await expect(page.locator('#sidebar-task-list')).toContainText(taskTitle, { timeout: 10000 });
    });

    test('Tab reaches the calendar row, ICS dropzone, mini-calendar days and sidebar task', async ({ page }) => {
      await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
      const stops = [];
      const found = () => [
        stops.some(s => /\bcalendar-item\b/.test(s.cls) && s.calId),
        stops.some(s => s.id === 'ics-dropzone'),
        stops.some(s => /\bmini-cal-day\b/.test(s.cls) && s.miniDay),
        stops.some(s => /\bsidebar-task-info\b/.test(s.cls) && s.text.includes(taskTitle)),
      ].every(Boolean);
      for (let i = 0; i < 1000 && !found(); i++) {
        await page.keyboard.press('Tab');
        const stop = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          return {
            cls: el.className && typeof el.className === 'string' ? el.className : '',
            id: el.id,
            calId: el.dataset.calId || null,
            miniDay: el.dataset.miniDay || null,
            text: (el.textContent || '').trim().slice(0, 120),
          };
        });
        if (stop) stops.push(stop);
      }

      // The focused element must be the control itself, not a decorative child.
      expect(stops.some(s => /\bcalendar-item\b/.test(s.cls) && s.calId)).toBe(true);
      expect(stops.some(s => s.id === 'ics-dropzone')).toBe(true);
      expect(stops.some(s => /\bmini-cal-day\b/.test(s.cls) && s.miniDay)).toBe(true);
      expect(stops.some(s => /\bsidebar-task-info\b/.test(s.cls) && s.text.includes(taskTitle))).toBe(true);
    });

    test('Enter and Space on a mini-calendar day select that date', async ({ page }) => {
      const day20 = page.locator('#mini-calendar [data-mini-day]', { hasText: /^20$/ });
      await day20.focus();
      await expect(day20).toBeFocused();
      await expect(day20).toHaveAttribute('role', 'button');
      await expect(day20).toHaveAttribute('aria-label', /20\. März 2027/);
      await page.keyboard.press('Enter');
      await expect(page.locator('#mini-calendar .mini-cal-day.selected')).toHaveText('20');
      // The grid re-renders; focus must stay on the chosen day, not fall to <body>.
      await expect(page.locator('#mini-calendar .mini-cal-day.selected')).toBeFocused();

      const day5 = page.locator('#mini-calendar [data-mini-day]', { hasText: /^5$/ });
      await day5.focus();
      await expect(day5).toBeFocused();
      await page.keyboard.press(' ');
      await expect(page.locator('#mini-calendar .mini-cal-day.selected')).toHaveText('5');
      await expect(page.locator('#mini-calendar .mini-cal-day.selected')).toBeFocused();

      // Re-renders not started from a day cell must leave focus where it is.
      await page.locator('#next-btn').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#mini-calendar .mini-cal-title')).toContainText('Apr');
      await expect(page.locator('#next-btn')).toBeFocused();
    });

    test('Enter and Space on a sidebar task open the task editor', async ({ page }) => {
      const info = page.locator('#sidebar-task-list .sidebar-task-info', { hasText: taskTitle });
      await info.focus();
      await expect(info).toBeFocused();
      await expect(info).toHaveAttribute('role', 'button');
      await page.keyboard.press('Enter');
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#task-title')).toHaveValue(taskTitle);
      await page.click('#task-cancel-btn');
      await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/, { timeout: 10000 });

      await info.focus();
      await expect(info).toBeFocused();
      await page.keyboard.press(' ');
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#task-title')).toHaveValue(taskTitle);
      await page.click('#task-cancel-btn');
    });

    test('Enter and Space on the focused ICS dropzone open the file picker', async ({ page }) => {
      const zone = page.locator('#ics-dropzone');
      await zone.focus();
      await expect(zone).toBeFocused();
      let chooser = page.waitForEvent('filechooser', { timeout: 5000 });
      await page.keyboard.press('Enter');
      await chooser;
      chooser = page.waitForEvent('filechooser', { timeout: 5000 });
      await page.keyboard.press(' ');
      await chooser;
    });

    test('Space on the focused calendar row toggles its visibility and aria-checked', async ({ page }) => {
      const row = page.locator('#calendar-list .calendar-item[data-cal-id]').first();
      const calId = await row.getAttribute('data-cal-id');
      await row.focus();
      await expect(row).toBeFocused();
      await expect(row).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press(' ');
      const toggled = page.locator(`#calendar-list .calendar-item[data-cal-id="${calId}"]`);
      await expect(toggled).toHaveAttribute('aria-checked', 'false');
      await toggled.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator(`#calendar-list .calendar-item[data-cal-id="${calId}"]`)).toHaveAttribute('aria-checked', 'true');
    });
  });

  test.describe('Issue #225 — mini-calendar paging from the 31st does not skip a month', () => {
    async function openAt(page, date) {
      await page.goto(`/?date=${date}`);
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#mini-calendar [data-mini-next]')).toBeVisible({ timeout: 10000 });
    }

    test('› from 31 January shows February, then March, and ‹ returns to January', async ({ page }) => {
      await openAt(page, '2026-01-31');
      await expect(page.locator('#mini-calendar .mini-cal-title')).toHaveText('Jan 2026');
      await expect(page.locator('#mini-calendar .mini-cal-day.selected')).toHaveText('31');

      await page.locator('#mini-calendar [data-mini-next]').click();
      await expect(page.locator('#mini-calendar .mini-cal-title')).toHaveText('Feb 2026');
      await expect(page.locator('#toolbar-title')).toHaveText('Februar 2026');
      await expect(page.locator('#mini-calendar .mini-cal-day.selected')).toHaveText('28');

      await page.locator('#mini-calendar [data-mini-next]').click();
      await expect(page.locator('#mini-calendar .mini-cal-title')).toHaveText('Mär 2026');
      await expect(page.locator('#toolbar-title')).toHaveText('März 2026');

      await page.locator('#mini-calendar [data-mini-prev]').click();
      await page.locator('#mini-calendar [data-mini-prev]').click();
      await expect(page.locator('#mini-calendar .mini-cal-title')).toHaveText('Jan 2026');
      await expect(page.locator('#toolbar-title')).toHaveText('Januar 2026');
    });

    test('‹ from 31 March shows February, not March again', async ({ page }) => {
      await openAt(page, '2026-03-31');
      await expect(page.locator('#mini-calendar .mini-cal-title')).toHaveText('Mär 2026');

      await page.locator('#mini-calendar [data-mini-prev]').click();
      await expect(page.locator('#mini-calendar .mini-cal-title')).toHaveText('Feb 2026');
      await expect(page.locator('#toolbar-title')).toHaveText('Februar 2026');
      await expect(page.locator('#mini-calendar .mini-cal-day.selected')).toHaveText('28');
    });

    test('the toolbar arrows page month and agenda view from the 31st without skipping', async ({ page }) => {
      const title = page.locator('#toolbar-title');
      const selected = page.locator('#mini-calendar .mini-cal-day.selected');
      await openAt(page, '2026-01-31');
      await expect(title).toHaveText('Januar 2026');
      await page.click('#next-btn');
      await expect(title).toHaveText('Februar 2026');
      await expect(selected).toHaveText('28');
      // From the clamped 28 February the day is kept, not clamped again.
      await page.click('#next-btn');
      await expect(title).toHaveText('März 2026');
      await expect(selected).toHaveText('28');

      await openAt(page, '2026-03-31');
      await page.click('#view-agenda');
      await expect(title).toHaveText('März 2026');
      await page.click('#prev-btn');
      await expect(title).toHaveText('Februar 2026');
      await expect(selected).toHaveText('28');

      // Leap year: 31 January lands on 29 February.
      await openAt(page, '2028-01-31');
      await page.click('#view-month');
      await page.click('#next-btn');
      await expect(title).toHaveText('Februar 2028');
      await expect(selected).toHaveText('29');
    });
  });

  // Issue #401: these replace the source-grep tests that once guarded public/js/calendar.js.
  test.describe('Issue #401 — calendar views render, order and lay out events', () => {
    test.use({ serviceWorkers: 'block' });
    let calendarId;
    // #592: the ids name the test's own user, known only once its fixture is set up.
    test.beforeEach(() => {
      calendarId = `internal-caldav::/${E2E_USER}/personal/`;
    });
    const ev = (uid, title, start, end, allDay = false) => ({ uid, title, calendarId, start, end, allDay });

    function routeEvents(page, events) {
      return mockEvents(page, events);
    }

    async function openAt(page, date) {
      await page.goto(date ? `/?date=${date}` : '/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-container [role="grid"], #calendar-container .agenda-view').first())
        .toBeVisible({ timeout: 10000 });
    }

    test('Issue #107 — a day lists all-day events first, then by start, end and title', async ({ page }) => {
      // Served shuffled, so only sorting can produce the expected order.
      await routeEvents(page, [
        ev('e2e-107-late', 'Late Meeting', '2037-05-14T18:00:00+02:00', '2037-05-14T19:00:00+02:00'),
        ev('e2e-107-ad2', 'All Day Event 2', '2037-05-14', '2037-05-15', true),
        ev('e2e-107-standup', 'Morning Standup', '2037-05-14T09:00:00+02:00', '2037-05-14T09:30:00+02:00'),
        ev('e2e-107-ad1', 'All Day Event 1', '2037-05-14', '2037-05-15', true),
        ev('e2e-107-noon', 'Noon Workshop', '2037-05-14T12:00:00+02:00', '2037-05-14T13:00:00+02:00'),
        ev('e2e-107-quick', 'Quick Sync', '2037-05-14T09:00:00+02:00', '2037-05-14T09:15:00+02:00'),
        ev('e2e-107-breakfast', 'Breakfast', '2037-05-14T09:00:00+02:00', '2037-05-14T09:30:00+02:00'),
      ]);
      await openAt(page, '2037-05-14');
      const cell = page.locator('.month-grid .month-day[aria-selected="true"]');
      await expect(cell.locator('.event-chip-title')).toHaveText([
        'All Day Event 1', 'All Day Event 2',
        'Quick Sync', // same start, earlier end
        'Breakfast', 'Morning Standup', // same start and end, by title
        'Noon Workshop', 'Late Meeting',
      ], { timeout: 10000 });
    });

    test('Issue #76 — event UIDs and calendar colours cannot break out of chip attributes', async ({ page }) => {
      const fallback = 'rgb(99, 102, 241)'; // #6366f1
      const colours = [
        ['red; xss: expression(alert(1))', fallback],
        ['#ff0000" onclick="document.body.dataset.xss401=\'color\'"', fallback],
        ['url("javascript:alert(1)")', fallback],
        ['#123456; background-image: url(https://attacker.example/leak)', fallback],
        ['<script>alert(1)</script>', fallback],
        ['/* comment */ #000', fallback],
        ['#ff0000', 'rgb(255, 0, 0)'],
        ['#123', 'rgb(17, 34, 51)'],
        ['rgb(255, 0, 0)', 'rgb(255, 0, 0)'],
        ['blue', 'rgb(0, 0, 255)'],
      ];
      const calendars = colours.map(([color], i) => ({
        id: `internal-caldav::/testuser/e2e-401-c${i}/`, accountId: 'internal-caldav', name: `E2E 401 Kalender ${i}`,
        color, href: `/testuser/e2e-401-c${i}/`, isShared: false, readOnly: false, supportsVEVENT: true, supportsVTODO: false,
      }));
      await mockCalendars(page, calendars);
      const evilUid = 'e2e-401-uid" onmouseover="document.body.dataset.xss401=\'uid\'" data-x="';
      const day = i => `2037-05-${String(10 + i).padStart(2, '0')}`;
      const events = calendars.map((cal, i) => ({
        uid: i === 0 ? evilUid : `e2e-401-ev${i}`, title: `E2E 401 Termin ${i}`, calendarId: cal.id,
        start: `${day(i)}T09:00:00+02:00`, end: `${day(i)}T10:00:00+02:00`, allDay: false,
      }));
      await routeEvents(page, events);
      await openAt(page, '2037-05-14');

      for (let i = 0; i < colours.length; i++) {
        const chip = page.locator('.month-grid .event-chip', { hasText: `E2E 401 Termin ${i}` });
        await expect(chip).toHaveCount(1, { timeout: 10000 });
        const color = await chip.evaluate(el => {
          const probe = document.createElement('div');
          probe.style.color = el.style.getPropertyValue('--event-color');
          document.body.appendChild(probe);
          const rgb = getComputedStyle(probe).color;
          probe.remove();
          return rgb;
        });
        expect(color, `chip colour for ${colours[i][0]}`).toBe(colours[i][1]);
      }
      const evilChip = page.locator('.month-grid .event-chip', { hasText: 'E2E 401 Termin 0' });
      expect(await evilChip.getAttribute('data-event-uid')).toBe(evilUid);
      await expect(evilChip).not.toHaveAttribute('onmouseover');
      await expect(evilChip).not.toHaveAttribute('data-x');
      // The escaped UID still finds its event.
      await evilChip.click();
      await expect(page.locator('#event-popover .popover-title')).toHaveText('E2E 401 Termin 0');
      await page.keyboard.press('Escape');

      await page.click('#view-agenda');
      for (let i = 0; i < colours.length; i++) {
        const item = page.locator('.agenda-event', { hasText: `E2E 401 Termin ${i}` });
        await expect(item.locator('.agenda-event-color')).toHaveCSS('background-color', colours[i][1]);
      }
      const evilItem = page.locator('.agenda-event', { hasText: 'E2E 401 Termin 0' });
      expect(await evilItem.getAttribute('data-event-uid')).toBe(evilUid);
      await expect(evilItem).not.toHaveAttribute('onmouseover');
      await evilItem.hover();
      expect(await page.evaluate(() => document.body.dataset.xss401)).toBeUndefined();
    });

    test('Issue #593 — a calendar reload answered before a colour edit does not bring the old colour back', async ({ page }) => {
      const calId = 'internal-caldav::/testuser/e2e-593/';
      const calendars = [{ id: calId, accountId: 'internal-caldav', name: 'E2E 593 Kalender', color: '#3366cc',
        href: '/testuser/e2e-593/', isShared: false, readOnly: false, supportsVEVENT: true, supportsVTODO: false }];
      // A GET is answered with the list as it is when the request arrives; `holdNext` delays
      // delivering that answer until the test releases it.
      let holdNext = false;
      let release = null;
      let gets = 0;
      await page.route('**/api/calendars', route => {
        if (route.request().method() !== 'GET') return route.fallback();
        gets++;
        const json = { calendars: JSON.parse(JSON.stringify(calendars)), errors: [] };
        if (holdNext) {
          holdNext = false;
          release = () => route.fulfill({ json });
          return undefined;
        }
        return route.fulfill({ json });
      });
      await page.route('**/api/calendars/*', route => {
        if (route.request().method() !== 'PATCH') return route.fallback();
        calendars[0].color = route.request().postDataJSON().color;
        return route.fulfill({ json: { message: 'Calendar updated', calendarId: calId } });
      });
      // From the next page on, the range holds an event of a calendar the list does not know yet,
      // which makes the app reload the calendar list in the background.
      let foreign = false;
      await page.route('**/api/events?**', route => route.fulfill({ json: { errors: [], events: foreign
        ? [{ uid: 'e2e-593-foreign', title: 'E2E 593 Fremd', calendarId: 'internal-caldav::/testuser/e2e-593-other/',
          start: '2037-06-10T09:00:00+02:00', end: '2037-06-10T10:00:00+02:00', allDay: false }]
        : [] } }));
      await openAt(page, '2037-05-14');
      const dot = page.locator(`#calendar-list [data-cal-id="${calId}"] .calendar-dot`);
      await expect(dot).toHaveCSS('background-color', 'rgb(51, 102, 204)');

      holdNext = true;
      foreign = true;
      await page.click('#next-btn');
      await expect.poll(() => release !== null, { timeout: 10000 }).toBe(true);

      await page.locator(`#calendar-list [data-cal-id="${calId}"] [data-edit-cal]`).click();
      const dialog = page.locator('#edit-cal-dialog-backdrop');
      await dialog.locator('#edit-cal-color').fill('#ab12cd');
      await dialog.locator('#edit-cal-submit').click();
      await expect(dialog).toHaveCount(0);
      await expect(dot).toHaveCSS('background-color', 'rgb(171, 18, 205)');

      // The held answer predates the edit: the app asks again instead of showing the old colour.
      const getsBefore = gets;
      await release();
      await page.waitForTimeout(300);
      await expect(dot).toHaveCSS('background-color', 'rgb(171, 18, 205)');
      await expect.poll(() => gets, { timeout: 10000 }).toBeGreaterThan(getsBefore);
      await expect(dot).toHaveCSS('background-color', 'rgb(171, 18, 205)');
    });

    test('Issue #534 — a calendar colour cannot break out of the edit dialog colour input', async ({ page }) => {
      const evil = '#fff" data-xss534="1"><b id="e2e-534-injected">x</b><input value="';
      const calendars = [
        { id: 'internal-caldav::/testuser/e2e-534-evil/', name: 'E2E 534 Böse', color: evil },
        { id: 'internal-caldav::/testuser/e2e-534-good/', name: 'E2E 534 Gut', color: '#a1b2c3' },
      ].map(c => ({ ...c, accountId: 'internal-caldav', href: c.id.split('::')[1],
        isShared: false, readOnly: false, supportsVEVENT: true, supportsVTODO: false }));
      await mockCalendars(page, calendars);
      await routeEvents(page, []);
      await openAt(page, '2037-05-14');

      const editFor = name => page.locator('#calendar-list .calendar-item', { hasText: name }).locator('[data-edit-cal]');
      await editFor('E2E 534 Böse').click();
      const dialog = page.locator('#edit-cal-dialog-backdrop');
      await expect(dialog.locator('#edit-cal-name')).toHaveValue('E2E 534 Böse');
      await expect(page.locator('#e2e-534-injected')).toHaveCount(0);
      await expect(page.locator('[data-xss534]')).toHaveCount(0);
      await expect(dialog.locator('input')).toHaveCount(2);
      await expect(dialog.locator('#edit-cal-color')).toHaveValue('#007080');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      await editFor('E2E 534 Gut').click();
      await expect(page.locator('#edit-cal-dialog-backdrop #edit-cal-color')).toHaveValue('#a1b2c3');
    });

    test('Issue #161 — the month view loads exactly the six weeks its grid shows', async ({ page }) => {
      const ranges = [];
      await page.route('**/api/events?**', route => {
        const params = new URL(route.request().url()).searchParams;
        ranges.push({ start: params.get('start'), end: params.get('end') });
        return route.fulfill({ json: { events: [], errors: [] } });
      });
      // October 2026 starts on a Thursday, November 2026 on a Sunday (Europe/Berlin).
      const cases = [
        ['2026-10-15', '28', '8', '2026-09-27T22:00:00.000Z', '2026-11-08T22:59:59.999Z'],
        ['2026-11-15', '26', '6', '2026-10-25T23:00:00.000Z', '2026-12-06T22:59:59.999Z'],
      ];
      for (const [date, firstDay, lastDay, start, end] of cases) {
        ranges.length = 0;
        await openAt(page, date);
        const cells = page.locator('.month-grid .month-day');
        await expect(cells).toHaveCount(42);
        await expect(cells.first().locator('.month-day-num')).toHaveText(firstDay);
        await expect(cells.last().locator('.month-day-num')).toHaveText(lastDay);
        expect(await cells.first().getAttribute('data-date')).toBe(start);
        await expect.poll(() => ranges.length).toBeGreaterThan(0);
        expect(ranges[0]).toEqual({ start, end });
      }
    });

    test('Issue #175 — the current-time line follows the clock and re-renders keep one timer', async ({ page }) => {
      await page.clock.install({ time: new Date('2037-05-14T10:00:00+02:00') });
      // Installed after the clock, so it counts the app's minute intervals on the clock's timers.
      await page.addInitScript(() => {
        const live = new Set();
        const set = window.setInterval;
        const clear = window.clearInterval;
        window.setInterval = function (fn, delay, ...args) {
          const id = set.call(this, fn, delay, ...args);
          if (delay === 60_000) live.add(id);
          return id;
        };
        window.clearInterval = function (id) {
          live.delete(id);
          return clear.call(this, id);
        };
        window.__minuteIntervals = () => live.size;
      });
      await routeEvents(page, []);
      await openAt(page);
      await page.click('#view-day');
      const line = page.locator('.day-view .current-time-line');
      await expect(line).toHaveCount(1);

      // The minute timer must move this very element; the app's 5-minute event reload would
      // re-render a fresh line, so stay below that and pin the element.
      await line.evaluate(el => { el.dataset.e2eProbe = '175'; });
      const probed = page.locator('.current-time-line[data-e2e-probe="175"]');
      const topPx = () => probed.evaluate(el => parseFloat(el.style.top));
      const nowPx = () => page.evaluate(() => { const n = new Date(); return (n.getHours() + n.getMinutes() / 60) * 60; });
      const before = await topPx();
      expect(Math.abs(before - await nowPx())).toBeLessThanOrEqual(1);
      await page.clock.runFor('03:00');
      await expect.poll(async () => Math.abs(await topPx() - await nowPx())).toBeLessThanOrEqual(1);
      expect(await topPx() - before).toBeGreaterThanOrEqual(2);

      // Re-rendering the view replaces the line's timer instead of adding one.
      const withLine = await page.evaluate(() => window.__minuteIntervals());
      for (const view of ['#view-week', '#view-day', '#view-week', '#view-day']) {
        await page.click(view);
        await expect(page.locator('.current-time-line')).toHaveCount(1);
      }
      expect(await page.evaluate(() => window.__minuteIntervals())).toBe(withLine);
      // A view without the line stops its timer.
      await page.click('#view-month');
      await expect(page.locator('.current-time-line')).toHaveCount(0);
      expect(await page.evaluate(() => window.__minuteIntervals())).toBe(withLine - 1);
    });

    test('Issue #228 — overlapping events share columns only within their own cluster', async ({ page }) => {
      await routeEvents(page, [
        ev('e2e-228-a', 'Cluster A', '2037-05-14T09:00:00+02:00', '2037-05-14T10:00:00+02:00'),
        ev('e2e-228-b', 'Cluster B', '2037-05-14T09:15:00+02:00', '2037-05-14T09:45:00+02:00'),
        ev('e2e-228-c', 'Cluster C', '2037-05-14T09:30:00+02:00', '2037-05-14T10:15:00+02:00'),
        ev('e2e-228-solo', 'Solo', '2037-05-14T14:00:00+02:00', '2037-05-14T15:00:00+02:00'),
        ev('e2e-228-ca', 'Chain A', '2037-05-14T16:00:00+02:00', '2037-05-14T17:00:00+02:00'),
        ev('e2e-228-cb', 'Chain B', '2037-05-14T16:30:00+02:00', '2037-05-14T17:30:00+02:00'),
        ev('e2e-228-cc', 'Chain C', '2037-05-14T17:00:00+02:00', '2037-05-14T18:00:00+02:00'),
      ]);
      await openAt(page, '2037-05-14');
      await page.click('#view-day');
      const col = page.locator('.day-view .week-day-col');
      await expect(col.locator('.event-block')).toHaveCount(7, { timeout: 10000 });
      const colBox = await col.boundingBox();
      const place = async title => {
        const box = await col.locator('.event-block', { hasText: title }).boundingBox();
        return { left: (box.x - colBox.x) / colBox.width, width: box.width / colBox.width };
      };
      // Each block is 100/cols % wide minus a 2 % gap, offset by 1 %.
      const third = 1 / 3 - 0.02;
      for (const [title, left] of [['Cluster A', 0.01], ['Cluster B', 1 / 3 + 0.01], ['Cluster C', 2 / 3 + 0.01]]) {
        const p = await place(title);
        expect(p.width, title).toBeCloseTo(third, 2);
        expect(p.left, title).toBeCloseTo(left, 2);
      }
      // An unrelated event later that day keeps the full width.
      const solo = await place('Solo');
      expect(solo.width).toBeCloseTo(0.98, 2);
      expect(solo.left).toBeCloseTo(0.01, 2);
      // A chain is one cluster of two columns; C reuses A's column once A has ended.
      for (const [title, left] of [['Chain A', 0.01], ['Chain B', 0.51], ['Chain C', 0.01]]) {
        const p = await place(title);
        expect(p.width, title).toBeCloseTo(0.48, 2);
        expect(p.left, title).toBeCloseTo(left, 2);
      }
    });

    test('Issue #267 — only days of the shown month create events; leading and trailing days are disabled', async ({ page }) => {
      await routeEvents(page, []);
      await openAt(page, '2026-10-15');
      const other = page.locator('.month-grid .month-day.other-month');
      // 28–30 September and 1–8 November.
      await expect(other).toHaveCount(11);
      for (let i = 0; i < 11; i++) await expect(other.nth(i)).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('.month-grid .month-day:not(.other-month)[aria-disabled]')).toHaveCount(0);

      // The 28 September cell is inert; Playwright treats aria-disabled as not clickable, so force the click.
      await other.first().click({ force: true });
      await other.last().click({ force: true });
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
      await page.locator('.month-grid .month-day:not(.other-month)', { hasText: /^20$/ }).click();
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#ev-start-date')).toHaveValue('2026-10-20');
    });

    test('Issue #274 — event chips announce time and title once, without a duplicate title tooltip', async ({ page }) => {
      await routeEvents(page, [
        ev('e2e-274-standup', 'Project Standup', '2037-05-14T10:00:00+02:00', '2037-05-14T10:30:00+02:00'),
        ev('e2e-274-holiday', 'Company Holiday', '2037-05-14', '2037-05-15', true),
        ev('e2e-274-review', 'Architecture Review', '2037-05-14T14:00:00+02:00', '2037-05-14T15:00:00+02:00'),
        ev('e2e-274-sync', '1-on-1 Sync', '2037-05-14T16:00:00+02:00', '2037-05-14T16:30:00+02:00'),
      ]);
      await openAt(page, '2037-05-14');
      const standup = page.locator('.month-grid .event-chip', { hasText: 'Project Standup' });
      await expect(standup).toHaveAccessibleName('10:00 Project Standup', { timeout: 10000 });
      await expect(standup).not.toHaveAttribute('title');
      const holiday = page.locator('.month-grid .event-chip', { hasText: 'Company Holiday' });
      await expect(holiday).toHaveAccessibleName('Company Holiday');
      await expect(holiday).not.toHaveAttribute('title');

      await page.click('#view-week');
      await expect(page.locator('.week-view .event-block', { hasText: 'Architecture Review' }))
        .toHaveAccessibleName('14:00 – 15:00 Architecture Review');

      await page.click('#view-agenda');
      await expect(page.locator('.agenda-event', { hasText: '1-on-1 Sync' }))
        .toHaveAccessibleName('16:00 – 16:30 1-on-1 Sync');
      await expect(page.locator('.agenda-event', { hasText: 'Company Holiday' }))
        .toHaveAccessibleName('Ganztägig Company Holiday');
    });

    test('Issue #275 — the mini-calendar month arrows are buttons named by what they do', async ({ page }) => {
      await routeEvents(page, []);
      await openAt(page, '2026-10-15');
      const mini = page.locator('#mini-calendar');
      const prev = mini.getByRole('button', { name: 'Vorheriger Monat', exact: true });
      const next = mini.getByRole('button', { name: 'Nächster Monat', exact: true });
      await expect(prev).toHaveText('‹');
      await expect(next).toHaveText('›');
      await next.click();
      await expect(mini.locator('.mini-cal-title')).toHaveText('Nov 2026');
      await prev.click();
      await prev.click();
      await expect(mini.locator('.mini-cal-title')).toHaveText('Sep 2026');
    });
  });

  test.describe('Issue #183 — calendar grids reach the accessibility tree as grids', () => {
    // Fixed events so the counts in the accessible names are known; page.route
    // needs the service worker off.
    test.use({ serviceWorkers: 'block' });
    let calendarId;
    let fixedEvents;
    // #592: the ids name the test's own user, known only once its fixture is set up.
    test.beforeEach(() => {
      calendarId = `internal-caldav::/${E2E_USER}/personal/`;
      fixedEvents = [
        { uid: 'e2e-issue183-a', title: 'Standup', calendarId, start: '2037-05-14T09:00:00+02:00', end: '2037-05-14T09:30:00+02:00', allDay: false },
        { uid: 'e2e-issue183-b', title: 'Review', calendarId, start: '2037-05-14T14:00:00+02:00', end: '2037-05-14T15:00:00+02:00', allDay: false },
        { uid: 'e2e-issue183-c', title: 'Feiertag', calendarId, start: '2037-05-14', end: '2037-05-15', allDay: true },
      ];
    });

    test.beforeEach(async ({ page }) => {
      await mockEvents(page, fixedEvents);
      await page.goto('/?date=2037-05-14');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('.month-grid .event-chip', { hasText: 'Standup' })).toBeVisible({ timeout: 10000 });
    });

    // Chromium's own accessibility tree, the layer a screen reader reads.
    // Ignored nodes (plain divs, display: contents wrappers that Chromium
    // drops) are skipped, so `parent` is the nearest node a screen reader sees.
    async function axTree(page) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Accessibility.enable');
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      await cdp.detach();
      const byId = new Map(nodes.map(n => [n.nodeId, n]));
      const visibleParent = n => {
        let p = byId.get(n.parentId);
        while (p && p.ignored) p = byId.get(p.parentId);
        return p;
      };
      const simple = n => ({
        role: n.role && n.role.value,
        name: n.name ? n.name.value : '',
        props: Object.fromEntries((n.properties || []).map(p => [p.name, p.value && p.value.value])),
        node: n,
      });
      const all = nodes.filter(n => !n.ignored).map(simple);
      const parentOf = s => { const p = visibleParent(s.node); return p ? simple(p) : null; };
      const within = (s, ancestor) => {
        for (let p = visibleParent(s.node); p; p = visibleParent(p)) if (p === ancestor.node) return true;
        return false;
      };
      const childrenOf = s => all.filter(c => visibleParent(c.node) === s.node);
      return { all, parentOf, within, childrenOf };
    }

    async function expectGrid(page, { name, headers, cells }) {
      const tree = await axTree(page);
      const grids = tree.all.filter(n => n.role === 'grid' && n.name === name);
      expect(grids).toHaveLength(1);
      const grid = grids[0];
      const inGrid = role => tree.all.filter(n => n.role === role && tree.within(n, grid));

      expect(inGrid('columnheader').map(n => n.name)).toEqual(headers);
      const gridcells = inGrid('gridcell');
      expect(gridcells.map(n => n.name)).toEqual(cells);
      // Every header and cell sits in a row of this grid, so a screen reader
      // can announce "row N, column <weekday>".
      for (const n of [...inGrid('columnheader'), ...gridcells]) {
        expect(tree.parentOf(n).role).toBe('row');
      }
      // ...and a row holds nothing else, e.g. no run of hour-axis labels.
      for (const row of inGrid('row')) {
        for (const c of tree.childrenOf(row)) expect(['columnheader', 'gridcell']).toContain(c.role);
      }
      return { tree, grid, gridcells };
    }

    const fullDate = (weekday, day) => `${weekday}, ${day}. Mai 2037`;

    test('month view: 7 weekday column headers, 6 rows of 7 named gridcells, selected day marked', async ({ page }) => {
      const weekdays = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
      const { tree, grid, gridcells } = await expectGrid(page, {
        name: 'Monatsansicht',
        headers: weekdays,
        cells: Array.from({ length: 42 }, (_, i) => {
          const d = new Date(2037, 3, 27 + i); // grid starts Monday 27 April 2037
          const label = d.toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
          return d.getDate() === 14 && d.getMonth() === 4 ? `${label}, 3 Termine` : label;
        }),
      });
      const rows = tree.all.filter(n => n.role === 'row' && tree.within(n, grid));
      expect(rows).toHaveLength(7);

      const selected = gridcells.filter(n => n.props.selected === true);
      expect(selected.map(n => n.name)).toEqual([fullDate('Donnerstag', 14) + ', 3 Termine']);

      const chip = tree.all.find(n => n.role === 'button' && n.name === '09:00 Standup');
      expect(chip && tree.within(chip, selected[0])).toBe(true);
    });

    test('today is marked with aria-current="date" in month, week and day view, not by colour alone', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('.month-grid')).toBeVisible({ timeout: 10000 });
      // "Today" in the browser's time zone, which is what the app renders.
      const today = await page.evaluate(() => new Date().toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
      const current = page.locator('.month-grid [role="gridcell"][aria-current="date"]');
      await expect(current).toHaveCount(1);
      await expect(current).toHaveAttribute('aria-label', new RegExp(`^${today}`));
      await expect(current).toHaveClass(/\btoday\b/);

      for (const [button, view] of [['#view-week', '.week-view'], ['#view-day', '.day-view']]) {
        await page.click(button);
        await expect(page.locator(view)).toBeVisible({ timeout: 10000 });
        // Both the column header and the cell a screen reader moves through.
        for (const role of ['columnheader', 'gridcell']) {
          const marked = page.locator(`${view} [role="${role}"][aria-current="date"]`);
          await expect(marked).toHaveCount(1);
          await expect(marked).toHaveAttribute('aria-label', new RegExp(`^${today}`));
        }
      }
    });

    test('week view: full-date column headers and one named gridcell per day holding its events', async ({ page }) => {
      await page.click('#view-week');
      await expect(page.locator('.week-view .event-block', { hasText: 'Review' })).toBeVisible({ timeout: 10000 });
      const weekdays = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
      const dates = weekdays.map((w, i) => fullDate(w, 11 + i));
      const { tree, gridcells } = await expectGrid(page, {
        name: 'Wochenansicht',
        // The all-day event sits in the column header, the timed ones in the cell.
        headers: dates.map(h => h.startsWith('Donnerstag') ? `${h}, 1 ganztägiger Termin` : h),
        cells: dates.map(h => h.startsWith('Donnerstag') ? `${h}, 2 Termine` : h),
      });
      const thursday = gridcells[3];
      const blocks = tree.all.filter(n => n.role === 'button' && /Standup|Review/.test(n.name));
      expect(blocks.map(n => n.name)).toEqual(['09:00 Standup', '14:00 – 15:00 Review']);
      for (const b of blocks) expect(tree.within(b, thursday)).toBe(true);
    });

    test('workweek view: five full-date column headers and gridcells', async ({ page }) => {
      await page.click('#view-workweek');
      await expect(page.locator('.week-view .event-block', { hasText: 'Review' })).toBeVisible({ timeout: 10000 });
      const dates = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'].map((w, i) => fullDate(w, 11 + i));
      await expectGrid(page, {
        name: 'Arbeitswochenansicht',
        headers: dates.map(h => h.startsWith('Donnerstag') ? `${h}, 1 ganztägiger Termin` : h),
        cells: dates.map(h => h.startsWith('Donnerstag') ? `${h}, 2 Termine` : h),
      });
    });

    test('day view: a full-date column header and one gridcell holding the events', async ({ page }) => {
      await page.click('#view-day');
      await expect(page.locator('.day-view .event-block', { hasText: 'Review' })).toBeVisible({ timeout: 10000 });
      const { tree, gridcells } = await expectGrid(page, {
        name: 'Tagesansicht',
        headers: [`${fullDate('Donnerstag', 14)}, 1 ganztägiger Termin`],
        cells: [`${fullDate('Donnerstag', 14)}, 2 Termine`],
      });
      const blocks = tree.all.filter(n => n.role === 'button' && /Standup|Review/.test(n.name));
      expect(blocks).toHaveLength(2);
      for (const b of blocks) expect(tree.within(b, gridcells[0])).toBe(true);
    });
  });

  test('should open invitations modal and inspect iTIP/RSVP inbox', async ({ page }) => {
    const invRespPromise = page.waitForResponse(resp => resp.url().includes('/api/events/invitations'));
    await page.goto('/');
    const invResp = await invRespPromise;
    expect(invResp.status()).toBe(200);

    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#invitations-btn')).toBeVisible({ timeout: 10000 });

    // Open invitations modal
    await page.click('#invitations-btn');
    await expect(page.locator('#invitations-modal-backdrop')).not.toHaveClass(/hidden/);

    // Verify modal header title and absence of error state
    await expect(page.locator('#invitations-modal .modal-title')).toContainText('Einladungen');
    await expect(page.locator('#invitations-modal .invitations-error-state')).not.toBeVisible();
    await expect(page.locator('#invitations-list-body')).toBeVisible();

    // Close invitations modal
    await page.click('#invitations-modal-close');
    await expect(page.locator('#invitations-modal-backdrop')).toHaveClass(/hidden/);
  });

  test('Issue #216 / #76 — markup in a stored invitation is shown as text, never parsed into the inbox', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await page.click('#new-event-btn');
    await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    const calendarId = await page.locator('#ev-calendar option:not([value=""])').first().getAttribute('value');
    await page.keyboard.press('Escape');

    const stamp = Date.now();
    const title = `<img src=x onerror="document.body.dataset.xss216='title'"> Invite ${stamp}`;
    const organizerName = `<img src=x onerror="document.body.dataset.xss216='organizer'">Test User`;
    const description = `<svg onload="document.body.dataset.xss216='description'"></svg><b>bold</b>`;
    const start = new Date(stamp + 2 * 24 * 3600 * 1000);
    start.setUTCHours(9, 0, 0, 0);
    // The env-auth session identifies as E2E_USER, so this attendee row is "us" and the event
    // lands in the inbox as an open invitation from testuser@example.com.
    const created = await page.request.post('/api/events', {
      headers: SAME_ORIGIN,
      data: {
        calendarId, title, description,
        start: start.toISOString(),
        end: new Date(start.getTime() + 3600 * 1000).toISOString(),
        organizer: { name: organizerName, email: 'testuser@example.com' },
        attendees: [{ name: 'Test User', email: E2E_USER, status: 'NEEDS-ACTION', rsvp: true }]
      }
    });
    expect(created.status()).toBe(201);
    const ev = await created.json();

    try {
      const invitationsLoaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events/invitations');
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await invitationsLoaded;
      await page.click('#invitations-btn');
      await expect(page.locator('#invitations-modal-backdrop')).not.toHaveClass(/hidden/);

      const card = page.locator('#invitations-list-body .invitation-card').filter({ hasText: `Invite ${stamp}` });
      await expect(card).toHaveCount(1, { timeout: 10000 });
      await expect(card.locator('.invitation-title')).toHaveText(title);
      await expect(card.locator('.invitation-organizer')).toHaveText(`Organisator*in: ${organizerName}`);
      // #168: the attendee caption is gender-neutral.
      await expect(card.locator('.invitation-attendees small')).toHaveText('Teilnehmende:');
      await expect(card.locator('.invitation-desc')).toHaveText(description);
      await expect(card.locator('img, svg, b')).toHaveCount(0);
      expect(await page.evaluate(() => document.body.dataset.xss216)).toBeUndefined();

      await page.click('#invitations-modal-close');
      await expect(page.locator('#invitations-modal-backdrop')).toHaveClass(/hidden/);
    } finally {
      const del = await page.request.delete(`/api/events/${encodeURIComponent(ev.uid)}`, {
        headers: SAME_ORIGIN,
        data: { calendarId, href: ev.href, etag: ev.etag }
      });
      expect(del.ok()).toBeTruthy();
    }
  });

  test('should trigger PDF vector export download via export-pdf-btn', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#export-pdf-btn')).toBeVisible({ timeout: 10000 });

    // #497: remember the blob URL the app hands to the browser's download manager and when it is
    // revoked. (The page's CSP, connect-src 'self', forbids reading a blob: URL back with fetch.)
    await page.evaluate(() => {
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      window.__pdfBlobUrls = [];
      window.__revokedBlobUrls = [];
      URL.createObjectURL = (obj) => { const u = create(obj); window.__pdfBlobUrls.push(u); return u; };
      URL.revokeObjectURL = (u) => { window.__revokedBlobUrls.push(u); revoke(u); };
    });

    const downloadPromise = page.waitForEvent('download');
    await page.click('#export-pdf-btn');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    expect(await download.failure()).toBeNull();
    const fs = require('fs');
    const pdf = fs.readFileSync(await download.path()).toString('latin1');
    expect(pdf.startsWith('%PDF-1.')).toBe(true);
    expect(pdf).toMatch(/%%EOF\s*$/);

    // The browser's download manager may read the file well after click() has returned: the blob
    // URL must still be registered then, or Chromium fails the download it has just announced.
    await page.waitForTimeout(2000);
    const blobState = await page.evaluate(() => ({
      created: window.__pdfBlobUrls.length,
      revoked: window.__revokedBlobUrls.includes(window.__pdfBlobUrls.at(-1)),
    }));
    expect(blobState).toEqual({ created: 1, revoked: false });
  });

  // #497: a failed export is reported before any download starts, never as a broken file or a
  // silent switch to the print dialog.
  for (const failure of [
    { name: 'a server error', status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'PDF-Erzeugung fehlgeschlagen (Test)' }), shown: 'PDF-Erzeugung fehlgeschlagen (Test)' },
    { name: 'a non-PDF 200 answer from the proxy', status: 200, contentType: 'text/html', body: '<html><body>Login</body></html>', shown: 'keine PDF-Datei' },
    { name: 'a PDF content type with a broken body', status: 200, contentType: 'application/pdf', body: '<html>gateway</html>', shown: 'keine PDF-Datei' },
  ]) {
    test(`#497: PDF export shows ${failure.name} as an error and starts no download`, async ({ page }) => {
      await page.addInitScript(() => {
        window.__printCalls = 0;
        window.print = () => { window.__printCalls++; };
      });
      await page.route('**/api/calendars/export/pdf', route => route.fulfill({
        status: failure.status, contentType: failure.contentType, body: failure.body,
      }));
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      let downloads = 0;
      page.on('download', () => { downloads++; });
      const exportAnswered = page.waitForResponse(r => new URL(r.url()).pathname === '/api/calendars/export/pdf');
      await page.click('#export-pdf-btn');
      await exportAnswered;

      await expect(page.locator('#toast-container .toast.error', { hasText: failure.shown })).toBeVisible({ timeout: 5000 });
      await expect(page.locator('#toast-container .toast.error', { hasText: 'PDF-Export fehlgeschlagen' })).toHaveAttribute('role', 'alert');
      expect(downloads).toBe(0);
      expect(await page.evaluate(() => window.__printCalls)).toBe(0);
    });
  }

  test.describe('Issue #509 — second time zone freely selectable', () => {
    const setSecondZone = (page, zone) =>
      page.request.put('/api/preferences', { headers: SAME_ORIGIN, data: { secondaryTimezone: zone } });

    // The setting is stored per user on the server, so no other test may inherit a second column.
    test.afterEach(async ({ page }) => {
      expect((await setSecondZone(page, null)).status()).toBe(200);
    });

    test('any IANA zone is found by the settings search, shown with abbreviation and offset, kept on reload and switched off', async ({ page }) => {
      await page.clock.install({ time: new Date('2037-07-15T12:00:00+02:00') });
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expect((await setSecondZone(page, null)).status()).toBe(200);
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#view-day');
      await expect(page.locator('.day-view')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('.dual-tz-gutter')).toHaveCount(0);

      await page.click('#sidebar-settings-btn');
      await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
      const toggle = page.locator('#show-secondary-tz-toggle');
      const search = page.locator('#secondary-tz-search');
      await expect(toggle).not.toBeChecked();
      await expect(search).toBeHidden();
      await toggle.check();
      await expect(search).toBeFocused();

      // A zone from no shortlist: St. John's, Newfoundland, half an hour off the full hour.
      await search.fill('st johns');
      const hit = page.locator('#secondary-tz-results [data-tz="America/St_Johns"]');
      await expect(hit).toBeVisible();
      await expect(hit).toContainText('UTC-2:30');
      await expect(page.locator('#secondary-tz-results [data-tz="Asia/Tokyo"]')).toHaveCount(0);
      await search.fill('tokyo');
      await expect(page.locator('#secondary-tz-results [data-tz="Asia/Tokyo"]')).toBeVisible();
      await expect(page.locator('#secondary-tz-results [data-tz="America/St_Johns"]')).toHaveCount(0);
      await search.fill('st johns');
      await hit.click();
      await expect(page.locator('#secondary-tz-current')).toContainText('America/St_Johns');

      await page.click('#close-settings-btn');
      const pri = page.locator('.day-time-gutter.dual-tz-gutter .tz-badge.pri');
      const sec = page.locator('.day-time-gutter.dual-tz-gutter .tz-badge.sec');
      await expect(sec).toContainText('UTC-2:30');
      await expect(pri).toContainText('MESZ');
      await expect(pri).toContainText('UTC+2');
      // 12:00 in Berlin (UTC+2) is 07:30 in St. John's (UTC-2:30).
      await expect(page.locator('.day-hour-label.dual-tz[data-hour="12"] .pri-time')).toHaveText('12:00');
      await expect(page.locator('.day-hour-label.dual-tz[data-hour="12"] .sec-time')).toHaveText('07:30');
      await expect.poll(async () => (await (await page.request.get('/api/preferences')).json()).secondaryTimezone)
        .toBe('America/St_Johns');

      // The setting lives on the server, so it survives a reload with empty local storage.
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#view-week');
      await expect(page.locator('.week-time-gutter.dual-tz-gutter .tz-badge.sec')).toContainText('UTC-2:30');
      await expect(page.locator('.week-hour-label.dual-tz[data-hour="12"] .sec-time')).toHaveText('07:30');

      await page.click('#sidebar-settings-btn');
      await expect(toggle).toBeChecked();
      await toggle.uncheck();
      await expect(search).toBeHidden();
      await page.click('#close-settings-btn');
      await expect(page.locator('.dual-tz-gutter')).toHaveCount(0);
      await expect(page.locator('.week-hour-label.dual-tz')).toHaveCount(0);
      await expect.poll(async () => (await (await page.request.get('/api/preferences')).json()).secondaryTimezone)
        .toBe(null);
    });

    test('hour labels follow both zones across their DST changes', async ({ page }) => {
      // 2027: the USA switch to summer time on 14 March, Germany on 28 March at 02:00 local time.
      await page.clock.install({ time: new Date('2027-03-27T12:00:00+01:00') });
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expect((await setSecondZone(page, 'America/New_York')).status()).toBe(200);
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#view-day');
      const label = h => page.locator(`.day-hour-label.dual-tz[data-hour="${h}"] .sec-time`);
      const pri = page.locator('.day-time-gutter.dual-tz-gutter .tz-badge.pri');
      const sec = page.locator('.day-time-gutter.dual-tz-gutter .tz-badge.sec');

      // Saturday: Berlin still on CET (UTC+1), New York already on EDT (UTC-4) — five hours apart.
      await expect(sec).toContainText('EDT');
      await expect(sec).toContainText('UTC-4');
      await expect(pri).toContainText('UTC+1');
      await expect(label(9)).toHaveText('04:00');

      // Sunday, the German switch day: before 02:00 five hours apart, from 03:00 on six.
      await page.click('#next-btn');
      await expect(page.locator('.day-view .week-day-num')).toHaveText('28');
      await expect(label(1)).toHaveText('20:00');
      await expect(label(4)).toHaveText('22:00');
      await expect(label(9)).toHaveText('03:00');

      // Monday: both on summer time, six hours apart; the week view agrees.
      await page.click('#next-btn');
      await expect(page.locator('.day-view .week-day-num')).toHaveText('29');
      await expect(pri).toContainText('UTC+2');
      await expect(label(9)).toHaveText('03:00');
      await page.click('#view-week');
      await expect(page.locator('.week-hour-label.dual-tz[data-hour="9"] .sec-time')).toHaveText('03:00');

      // In February, both on winter time: New York on EST (UTC-5), six hours apart.
      await page.click('#view-day');
      for (let i = 0; i < 45; i++) await page.click('#prev-btn');
      await expect(page.locator('.day-view .week-day-num')).toHaveText('12');
      await expect(sec).toContainText('EST');
      await expect(sec).toContainText('UTC-5');
      await expect(label(9)).toHaveText('03:00');
      await expect(label(1)).toHaveText('19:00');
    });
  });

  test('should open availability booking modal, create a booking page, and let an anonymous visitor book a free slot through its public link', async ({ page, browser }) => {
    await page.goto('/');
    await expect(page.locator('#loading-screen')).toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });

    // Open availability booking modal
    await page.click('#availability-btn');
    await expect(page.locator('#availability-modal-backdrop')).not.toHaveClass(/hidden/);

    const slug = `e2e-slot-${Date.now()}`;
    await page.fill('#ap-title', 'E2E Public Consultation');
    await page.fill('#ap-slug', slug);
    await expect(page.locator('#ap-calendar option')).not.toHaveCount(0, { timeout: 10000 });
    const savePromise = page.waitForResponse(resp => resp.url().includes('/api/availability') && (resp.status() === 200 || resp.status() === 201));
    await page.click('#ap-save-btn');
    await savePromise;
    const pageCard = page.locator(`.availability-page-card:has-text("${slug}")`);
    await expect(pageCard).toBeVisible({ timeout: 10000 });
    const publicUrl = await pageCard.locator(`a[href*="${slug}"]`).getAttribute('href');

    // #480: the visitor is outside the shard. The platform proxy forwards the secret but no
    // X-Ptl-Client-Type: terminal, so the SPA itself is closed to this context.
    const visitor = await browser.newContext({ extraHTTPHeaders: { 'X-Freeshard-Secret': webServer.env.HTTP_HEADER_AUTH_SECRET } });
    try {
      expect((await visitor.request.get('/')).status()).toBe(401);
      const guest = await visitor.newPage();
      const failed = [];
      guest.on('response', resp => { if (resp.status() >= 400) failed.push(`${resp.status()} ${resp.url()}`); });
      await guest.goto(publicUrl);
      await expect(guest.locator('#page-title')).toHaveText('E2E Public Consultation', { timeout: 10000 });
      // The stylesheet applies: the card gets its border radius from app.css variables.
      await expect(guest.locator('#public-booking-form .btn-primary')).toHaveCSS('cursor', 'pointer');
      // Calendar events block slots (#345); earlier specs put events on today, so book a free future Monday.
      await guest.fill('#booking-date', mondayWeeksAhead(6));
      await guest.locator('#booking-date').dispatchEvent('change');

      // Select first slot
      const slotBtn = guest.locator('.slot-btn').first();
      await expect(slotBtn).toBeVisible({ timeout: 10000 });
      await slotBtn.click();

      // Fill guest booking form
      await expect(guest.locator('#booking-form-wrapper')).not.toHaveClass(/hidden/);
      await guest.fill('#guest-name', 'Test User Guest');
      await guest.fill('#guest-email', 'testuser@example.com');
      await guest.fill('#guest-notes', 'E2E public booking test notes');

      // Submit booking
      await guest.click('#confirm-booking-btn');

      // Confirmation box should appear
      await expect(guest.locator('#booking-success')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expect(failed).toEqual([]);
    } finally {
      await visitor.close();
    }
  });

  test('should create an event with attachment drive link and display attachment link in popover', async ({ page }) => {
    const testDate = '2035-09-15';
    await page.goto(`/?date=${testDate}`);
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

    const title = `E2E Drive Attachment Event ${Date.now()}`;
    const driveUrl = 'https://files.freeshard.local/d/e2e-project-brief.pdf';
    const driveFileName = 'e2e-project-brief.pdf';

    // Open new event modal
    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-calendar option')).not.toHaveCount(0, { timeout: 10000 });

    await page.fill('#ev-title', title);
    await page.fill('#ev-start-date', testDate);
    await page.fill('#ev-end-date', testDate);
    await page.check('#ev-allday');
    await openEventSection(page, 'link');
    await page.fill('#ev-attachment-url', driveUrl);
    await page.fill('#ev-attachment-name', driveFileName);

    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 10000 });

    // Switch to week view so event chip is always visible (month view has MAX_VISIBLE=12 overflow)
    await page.click('#view-week');
    await expect(page.locator('.week-grid, .week-view')).toBeVisible({ timeout: 10000 });

    // Click the newly created event block
    const eventBlock = page.locator('.event-chip').filter({ hasText: title }).first();
    await expect(eventBlock).toBeVisible({ timeout: 15000 });
    await eventBlock.click();

    // Verify popover displays attachment link
    const attachmentLink = page.locator('.attachment-drive-link');
    await expect(attachmentLink).toBeVisible({ timeout: 5000 });
    await expect(attachmentLink).toHaveAttribute('href', driveUrl);
    await expect(attachmentLink).toHaveText(driveFileName);
  });

  // Issue #338 — imports an ICS with `javascript:`/`data:` ATTACH values and asserts that
  // no clickable script link reaches the popover.
  async function importIcsAndOpenPopover(page, testDate, title, attachLines) {
    await page.goto(`/?date=${testDate}`);
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item').first()).toBeVisible({ timeout: 10000 });
    await page.click('#view-week');
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Issue338//EN',
      'BEGIN:VEVENT',
      `UID:e2e-issue338-${Date.now()}`,
      `DTSTART;VALUE=DATE:${testDate.replace(/-/g, '')}`,
      `SUMMARY:${title}`,
      ...attachLines,
      'END:VEVENT', 'END:VCALENDAR'
    ].join('\r\n');
    await page.evaluate((icsText) => {
      const dt = new DataTransfer();
      dt.items.add(new File([icsText], 'invite.ics', { type: 'text/calendar' }));
      document.querySelector('.sidebar').dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      );
    }, ics);
    await expect(page.locator('#import-dialog-backdrop')).toBeVisible();
    await page.click('#import-confirm');
    await expect(page.locator('#import-dialog-backdrop')).toBeHidden({ timeout: 20000 });
    const chip = page.locator('.event-chip').filter({ hasText: title }).first();
    await expect(chip).toBeVisible({ timeout: 15000 });
    await chip.click();
    await expect(page.locator('#popover-delete-btn')).toBeVisible({ timeout: 5000 });
    return chip;
  }

  async function deleteViaPopover(page, chip) {
    await page.click('#popover-delete-btn');
    await page.click('#confirm-dialog-ok');
    await expect(chip).not.toBeVisible({ timeout: 10000 });
  }

  async function scriptSchemeLinks(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(href => /^\s*(javascript|data|vbscript):/i.test(href.replace(/[\t\n\r]/g, ''))));
  }

  async function storedTriggers(page, calendarId, title) {
    const res = await page.request.get(`/api/calendars/${encodeURIComponent(calendarId)}/export`);
    expect(res.status()).toBe(200);
    const ics = (await res.text()).replace(/\r?\n[ \t]/g, '');
    const block = ics.split('BEGIN:VEVENT').find(b => b.includes(`SUMMARY:${title}`));
    expect(block, 'event is stored in the calendar').toBeTruthy();
    return block.split(/\r?\n/).filter(l => l.startsWith('TRIGGER'));
  }

  test('Issue #128 — open and save keeps RELATED=END, an absolute trigger and every further alarm', async ({ page }) => {
    const testDate = '2036-04-16';
    const title = `E2E Issue128 Alarms ${Date.now()}`;
    const alarm = (trigger) => ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', trigger, 'END:VALARM'];
    const chip = await importIcsAndOpenPopover(page, testDate, title, [
      ...alarm('TRIGGER;RELATED=END:-PT15M'),
      ...alarm('TRIGGER;VALUE=DATE-TIME:20360415T180000Z'),
      ...alarm('TRIGGER:-PT1H')
    ]);

    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    // RELATED=END is not editable relative to the start: it is listed as it is (#508).
    const rows = page.locator('#ev-reminder-list .reminder-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator('.reminder-fixed')).toHaveText('15 Minuten vor Ende');
    await expect(rows.nth(1).locator('.reminder-kind')).toHaveValue('absolute');
    await expect(rows.nth(2).locator('.reminder-amount')).toHaveValue('1');
    await expect(rows.nth(2).locator('.reminder-unit')).toHaveValue('H');

    const firstSave = page.waitForRequest(r => r.method() === 'PUT' && r.url().includes('/api/events/'));
    await page.click('#event-save-btn');
    const sent = (await firstSave).postDataJSON();
    expect(sent.alarms.map(a => [a.trigger, a.related || null])).toEqual([
      ['-PT15M', 'END'],
      ['2036-04-15T18:00:00Z', null],
      ['-PT1H', null]
    ]);
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
    expect(await storedTriggers(page, sent.calendarId, title)).toEqual([
      'TRIGGER;RELATED=END:-PT15M',
      'TRIGGER;VALUE=DATE-TIME:20360415T180000Z',
      'TRIGGER:-PT1H'
    ]);

    // Removing the first and editing the last changes only those; the absolute one stays.
    await chip.click();
    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await rows.nth(0).locator('.reminder-remove').click();
    await expect(rows).toHaveCount(2);
    await rows.nth(1).locator('.reminder-amount').fill('5');
    await rows.nth(1).locator('.reminder-unit').selectOption('M');
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
    await expect.poll(() => storedTriggers(page, sent.calendarId, title)).toEqual([
      'TRIGGER;VALUE=DATE-TIME:20360415T180000Z',
      'TRIGGER:-PT5M'
    ]);

    await chip.click();
    await expect(page.locator('#popover-delete-btn')).toBeVisible({ timeout: 5000 });
    await deleteViaPopover(page, chip);
  });

  test('Issue #128 — an absolute first alarm is shown as its date and saved without a server error', async ({ page }) => {
    const testDate = '2036-04-23';
    const title = `E2E Issue128 Absolute ${Date.now()}`;
    const chip = await importIcsAndOpenPopover(page, testDate, title, [
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER;VALUE=DATE-TIME:20360422T180000Z', 'END:VALARM'
    ]);

    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    const row = page.locator('#ev-reminder-list .reminder-row');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.reminder-kind')).toHaveValue('absolute');
    await expect(row.locator('.reminder-at')).toHaveValue(/^2036-04-2[23]T/);

    const save = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/api/events/'));
    await page.click('#event-save-btn');
    const res = await save;
    expect(res.status()).toBe(200);
    const calendarId = res.request().postDataJSON().calendarId;
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
    expect(await storedTriggers(page, calendarId, title)).toEqual(['TRIGGER;VALUE=DATE-TIME:20360422T180000Z']);

    await chip.click();
    await expect(page.locator('#popover-delete-btn')).toBeVisible({ timeout: 5000 });
    await deleteViaPopover(page, chip);
  });

  test('Issue #128 — an AUDIO alarm with REPEAT keeps its action and properties across open and save', async ({ page }) => {
    const testDate = '2036-04-30';
    const title = `E2E Issue128 Audio ${Date.now()}`;
    const chip = await importIcsAndOpenPopover(page, testDate, title, [
      'BEGIN:VALARM', 'ACTION:AUDIO', 'TRIGGER:-PT15M', 'REPEAT:2', 'DURATION:PT5M', 'END:VALARM'
    ]);

    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ev-reminder-list .reminder-fixed')).toHaveText('15 Minuten vorher (Ton)');
    const save = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/api/events/'));
    await page.click('#event-save-btn');
    const res = await save;
    expect(res.status()).toBe(200);
    // Read the request now: the response handle can be released once the page refetches.
    const calendarId = res.request().postDataJSON().calendarId;
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });

    const exported = await page.request.get(`/api/calendars/${encodeURIComponent(calendarId)}/export`);
    const block = (await exported.text()).split('BEGIN:VEVENT').find(b => b.includes(`SUMMARY:${title}`));
    const valarm = block.slice(block.indexOf('BEGIN:VALARM'), block.indexOf('END:VALARM'));
    expect(valarm).toContain('ACTION:AUDIO');
    expect(valarm).toContain('REPEAT:2');
    expect(valarm).toContain('DURATION:PT5M');

    await chip.click();
    await expect(page.locator('#popover-delete-btn')).toBeVisible({ timeout: 5000 });
    await deleteViaPopover(page, chip);
  });

  test('Issue #128 — a RELATED=END reminder fires relative to the event end in the browser', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });
    await page.click('#new-event-btn');
    await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
    const calendarId = await page.locator('#ev-calendar option:not([value=""])').first().getAttribute('value');
    await page.keyboard.press('Escape');

    // Ends in 5 minutes, started 26 hours ago: "15 minutes before the end" is
    // due now, "15 minutes before the start" lies outside the 24 h lookback.
    const now = Date.now();
    const title = `E2E Issue128 End Reminder ${now}`;
    const created = await page.request.post('/api/events', {
      headers: SAME_ORIGIN,
      data: {
        calendarId, title,
        start: new Date(now - 26 * 3600 * 1000).toISOString(),
        end: new Date(now + 5 * 60 * 1000).toISOString(),
        alarms: [{ action: 'DISPLAY', trigger: '-PT15M', related: 'END', description: 'Reminder' }]
      }
    });
    expect(created.status()).toBe(201);
    const ev = await created.json();

    try {
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.evaluate(() => window.__checkAndTriggerAlarms && window.__checkAndTriggerAlarms());
      await expect(page.locator('#toast-container .toast', { hasText: title })).toBeVisible({ timeout: 10000 });
    } finally {
      const del = await page.request.delete(`/api/events/${encodeURIComponent(ev.uid)}`, {
        headers: SAME_ORIGIN,
        data: { calendarId, href: ev.href, etag: ev.etag }
      });
      expect(del.ok()).toBeTruthy();
    }
  });

  test.describe('Issue #508 — any number of reminders per event and task', () => {
    test('an event gets reminders before and after the start and at a time, added and removed in the dialog', async ({ page }) => {
      const testDate = '2036-06-10';
      const title = `E2E Issue508 Event ${Date.now()}`;
      await page.goto(`/?date=${testDate}`);
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-item').first()).toBeVisible({ timeout: 10000 });
      await page.click('#view-week');
      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
      await page.fill('#ev-title', title);
      await page.fill('#ev-start-date', testDate);
      await page.fill('#ev-end-date', testDate);
      await page.fill('#ev-start-time', '10:00');
      await page.fill('#ev-end-time', '11:00');

      // The reminders are their own section, not part of the recurrence section.
      await expect(page.locator('#ev-section-recurrence #ev-reminder-list')).toHaveCount(0);
      await addReminder(page, 'ev', { amount: 15 });
      await addReminder(page, 'ev', { amount: 2, unit: 'H', direction: '+' });
      await addReminder(page, 'ev', { amount: 1, unit: 'D' });
      await addReminder(page, 'ev', { at: '2036-06-09T18:30' });
      const rows = page.locator('#ev-reminder-list .reminder-row');
      await expect(rows).toHaveCount(4);
      // Removing a row takes exactly that reminder out of the list.
      await rows.nth(2).locator('.reminder-remove').click();
      await expect(rows).toHaveCount(3);

      const create = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/api/events');
      await page.click('#event-save-btn');
      const sent = (await create).postDataJSON();
      const absolute = new Date(2036, 5, 9, 18, 30).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      expect(sent.alarms.map(a => [a.action, a.trigger, a.related || null])).toEqual([
        ['DISPLAY', '-PT15M', null],
        ['DISPLAY', 'PT2H', null],
        ['DISPLAY', absolute, null]
      ]);
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
      await expectSavesLanded(page);
      expect(await storedTriggers(page, sent.calendarId, title)).toEqual([
        'TRIGGER:-PT15M', 'TRIGGER:PT2H', `TRIGGER;VALUE=DATE-TIME:${absolute}`
      ]);

      // Opened again, each reminder is shown as stored and can be removed.
      const chip = page.locator('.event-block, .event-chip').filter({ hasText: title }).first();
      await chip.click();
      await page.click('#popover-edit-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#ev-section-alarm')).toHaveAttribute('open', '');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(1).locator('.reminder-amount')).toHaveValue('2');
      await expect(rows.nth(1).locator('.reminder-unit')).toHaveValue('H');
      await expect(rows.nth(1).locator('.reminder-direction')).toHaveValue('+');
      await expect(rows.nth(2).locator('.reminder-kind')).toHaveValue('absolute');
      await expect(rows.nth(2).locator('.reminder-at')).toHaveValue('2036-06-09T18:30');
      await rows.nth(0).locator('.reminder-remove').click();
      await page.click('#event-save-btn');
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
      await expect.poll(() => storedTriggers(page, sent.calendarId, title)).toEqual([
        'TRIGGER:PT2H', `TRIGGER;VALUE=DATE-TIME:${absolute}`
      ]);

      await chip.click();
      await expect(page.locator('#popover-delete-btn')).toBeVisible({ timeout: 5000 });
      await deleteViaPopover(page, chip);
    });

    test('DISPLAY, AUDIO and EMAIL reminders from another client survive adding one in the dialog', async ({ page }) => {
      const testDate = '2036-06-17';
      const title = `E2E Issue508 Foreign ${Date.now()}`;
      const chip = await importIcsAndOpenPopover(page, testDate, title, [
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT1H', 'X-TEST-MARK:keep', 'END:VALARM',
        'BEGIN:VALARM', 'ACTION:AUDIO', 'TRIGGER:-PT30M', 'REPEAT:2', 'DURATION:PT5M', 'END:VALARM',
        'BEGIN:VALARM', 'ACTION:EMAIL', 'SUMMARY:Soon', 'DESCRIPTION:Mail reminder',
        'ATTENDEE:mailto:testuser@example.com', 'TRIGGER:-P1D', 'END:VALARM'
      ]);
      await page.click('#popover-edit-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      const rows = page.locator('#ev-reminder-list .reminder-row');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(1).locator('.reminder-fixed')).toHaveText('30 Minuten vorher (Ton)');
      await expect(rows.nth(2).locator('.reminder-fixed')).toHaveText('1 Tag vorher (E-Mail)');
      await addReminder(page, 'ev', { amount: 1, unit: 'W' });

      const save = page.waitForRequest(r => r.method() === 'PUT' && r.url().includes('/api/events/'));
      await page.click('#event-save-btn');
      const sent = (await save).postDataJSON();
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
      await expectSavesLanded(page);
      const res = await page.request.get(`/api/calendars/${encodeURIComponent(sent.calendarId)}/export`);
      const block = (await res.text()).replace(/\r?\n[ \t]/g, '').split('BEGIN:VEVENT').find(b => b.includes(`SUMMARY:${title}`));
      const valarms = block.split('BEGIN:VALARM').slice(1).map(v => v.slice(0, v.indexOf('END:VALARM')));
      expect(valarms).toHaveLength(4);
      expect(valarms[0]).toMatch(/X-TEST-MARK:keep/);
      expect(valarms[1]).toMatch(/ACTION:AUDIO[\s\S]*REPEAT:2/);
      expect(valarms[2]).toMatch(/ACTION:EMAIL/);
      expect(valarms[2]).toMatch(/ATTENDEE:mailto:testuser@example\.com/);
      expect(valarms[2]).toMatch(/SUMMARY:Soon/);
      // ical.js writes a week back as seven days; both mean the same trigger.
      expect(valarms[3]).toMatch(/TRIGGER:-P(1W|7D)\r?\n/);

      await chip.click();
      await expect(page.locator('#popover-delete-btn')).toBeVisible({ timeout: 5000 });
      await deleteViaPopover(page, chip);
    });

    test('two due reminders of one event each fire exactly once', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#new-event-btn');
      await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
      const calendarId = await page.locator('#ev-calendar option:not([value=""])').first().getAttribute('value');
      await page.keyboard.press('Escape');
      const now = Date.now();
      const title = `E2E Issue508 Twice ${now}`;
      const created = await page.request.post('/api/events', {
        headers: SAME_ORIGIN,
        data: {
          calendarId, title,
          start: new Date(now - 10 * 60 * 1000).toISOString(),
          end: new Date(now + 50 * 60 * 1000).toISOString(),
          alarms: [
            { action: 'DISPLAY', trigger: '-PT5M', description: 'first' },
            { action: 'DISPLAY', trigger: 'PT5M', description: 'second' },
            { action: 'DISPLAY', trigger: 'PT1H', description: 'later' }
          ]
        }
      });
      expect(created.status()).toBe(201);
      const ev = await created.json();
      try {
        await page.reload();
        await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
        await page.evaluate(() => {
          window.desktopNotifications = [];
          window.Notification = class {
            constructor(t, options) { window.desktopNotifications.push({ title: t, options }); }
            static permission = 'granted';
            static requestPermission() { return Promise.resolve('granted'); }
          };
        });
        const fired = () => page.evaluate(t => window.desktopNotifications
          .filter(n => n.title === `Erinnerung: ${t}`).map(n => n.options.body.match(/\((\w+)\)$/)[1]).sort(), title);
        await expect.poll(async () => {
          await page.evaluate(() => window.__checkAndTriggerAlarms());
          return fired();
        }, { timeout: 10000 }).toEqual(['first', 'second']);
        await page.evaluate(() => window.__checkAndTriggerAlarms());
        expect(await fired()).toEqual(['first', 'second']);
      } finally {
        const del = await page.request.delete(`/api/events/${encodeURIComponent(ev.uid)}`, {
          headers: SAME_ORIGIN,
          data: { calendarId, href: ev.href, etag: ev.etag }
        });
        expect(del.ok()).toBeTruthy();
      }
    });

    test('a task gets reminders before its due date and at a time, removable in the dialog, and they fire', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });
      const listed = await (await page.request.get('/api/calendars')).json();
      const taskList = listed.calendars.find(c => c.accountId === 'internal-caldav' && c.supportsVTODO && !c.supportsVEVENT && !c.readOnly);
      const storedTask = (t) => page.evaluate(async (wanted) => {
        const body = await (await fetch('/api/tasks')).json();
        return (Array.isArray(body) ? body : body.tasks).find(x => x.title === wanted) || null;
      }, t);

      // A malformed trigger is refused, not written.
      const bad = await page.request.post('/api/tasks', {
        headers: SAME_ORIGIN, data: { calendarId: taskList.id, title: 'E2E Issue508 Bad', alarms: [{ trigger: 'soon' }] }
      });
      expect(bad.status()).toBe(400);

      const title = `E2E Issue508 Task ${Date.now()}`;
      await page.click('#new-task-btn');
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.selectOption('#task-calendar-id', taskList.id);
      await page.fill('#task-title', title);
      await page.fill('#task-due', '2036-08-11T09:00');
      await addReminder(page, 'task', { amount: 1, unit: 'D' });
      await addReminder(page, 'task', { amount: 3, unit: 'H' });
      await addReminder(page, 'task', { at: '2036-08-10T20:00' });
      await expect(page.locator('#task-reminder-list .reminder-direction').first().locator('option:checked')).toHaveText('vor Fälligkeit');
      await page.click('#task-save-btn');
      await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
      const absolute = new Date(2036, 7, 10, 20, 0).toISOString().replace(/\.\d+Z$/, 'Z');
      await expect.poll(async () => ((await storedTask(title)) || {}).alarms, { timeout: 10000 }).toEqual([
        { action: 'DISPLAY', trigger: '-P1D', related: 'END', description: title },
        { action: 'DISPLAY', trigger: '-PT3H', related: 'END', description: title },
        { action: 'DISPLAY', trigger: absolute, description: title }
      ]);

      await page.click('#view-kanban');
      const card = page.locator('.kanban-card', { hasText: title });
      await card.locator('.btn-edit').click();
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const rows = page.locator('#task-reminder-list .reminder-row');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0).locator('.reminder-amount')).toHaveValue('1');
      await expect(rows.nth(0).locator('.reminder-unit')).toHaveValue('D');
      await expect(rows.nth(2).locator('.reminder-at')).toHaveValue('2036-08-10T20:00');
      await rows.nth(1).locator('.reminder-remove').click();
      await page.click('#task-save-btn');
      await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
      await expect.poll(async () => (await storedTask(title)).alarms.map(a => a.trigger), { timeout: 10000 })
        .toEqual(['-P1D', absolute]);

      // A due task reminder fires in the browser.
      const now = Date.now();
      const dueTitle = `E2E Issue508 Due Task ${now}`;
      const created = await page.request.post('/api/tasks', {
        headers: SAME_ORIGIN,
        data: {
          calendarId: taskList.id, title: dueTitle, due: new Date(now + 10 * 60 * 1000).toISOString(),
          alarms: [{ action: 'DISPLAY', trigger: '-PT15M', related: 'END', description: dueTitle }]
        }
      });
      expect(created.status()).toBe(201);
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#sidebar-task-list')).toContainText(dueTitle, { timeout: 10000 });
      await page.evaluate(() => window.__checkAndTriggerAlarms());
      await expect(page.locator('#toast-container .toast', { hasText: `Erinnerung: ${dueTitle}` })).toBeVisible({ timeout: 5000 });

      await page.click('#view-kanban');
      for (const t of [title, dueTitle]) {
        await page.locator('.kanban-card', { hasText: t }).locator('.btn-delete').click();
        await page.click('#confirm-dialog-ok');
        await expect(page.locator('.kanban-card', { hasText: t })).toHaveCount(0, { timeout: 10000 });
      }
    });
  });

  // These tests observe and stub /api requests on the page; once the service
  // worker has claimed the page it would answer them out of Playwright's sight.
  test.describe('with the service worker blocked', () => {
    test.use({ serviceWorkers: 'block' });

    test('Issue #128 — events the server could not parse are reported in a toast, not silently missing', async ({ page }) => {
      const report = encodeURIComponent(JSON.stringify({
        count: 2,
        resources: [{ calendarId: 'internal-caldav::/testuser/cal/', href: '/testuser/cal/broken.ics' }]
      }));
      await page.route('**/api/events?*', async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, headers: { ...response.headers(), 'x-caldav-unparseable': report } });
      });
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#toast-container .toast.error', {
        hasText: '2 gespeicherte Termine konnten nicht gelesen werden und werden nicht angezeigt.'
      })).toBeVisible({ timeout: 10000 });
      // The rest of the calendar still renders.
      await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });
    });

    test('Issue #208 — tasks the server could not parse are reported in a toast, not silently missing', async ({ page }) => {
      const report = encodeURIComponent(JSON.stringify({
        count: 3,
        resources: [{ calendarId: 'internal-caldav::/testuser/tasks/', href: '/testuser/tasks/broken.ics' }]
      }));
      await page.route('**/api/tasks', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        await route.fulfill({ response, headers: { ...response.headers(), 'x-caldav-unparseable': report } });
      });
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#toast-container .toast.error', {
        hasText: '3 gespeicherte Aufgaben konnten nicht gelesen werden und werden nicht angezeigt.'
      })).toBeVisible({ timeout: 10000 });
    });

    test('Issue #65 — a calendar that could not be loaded gets a warning badge and a toast, not an empty week', async ({ page }) => {
      const okId = 'internal-caldav::/testuser/issue65-ok/';
      const badId = 'internal-caldav::/testuser/issue65-bad/';
      const calendar = (id, name) => ({
        id, accountId: 'internal-caldav', name, color: '#3366cc', href: id.split('::')[1],
        isShared: false, readOnly: false, supportsVEVENT: true, supportsVTODO: false
      });
      await mockCalendars(page, [calendar(okId, 'E2E 65 Working'), calendar(badId, 'E2E 65 Broken')]);
      let failing = true;
      await page.route('**/api/events?*', route => route.fulfill({ json: {
        events: [{ uid: 'e2e-issue65-a', title: 'E2E 65 Visible', calendarId: okId, accountId: 'internal-caldav',
          start: '2037-05-14T09:00:00+02:00', end: '2037-05-14T10:00:00+02:00', allDay: false }],
        errors: failing
          ? [{ accountId: 'internal-caldav', calendarId: badId, status: 502, error: 'Der Kalenderserver ist gerade nicht erreichbar.' }]
          : []
      } }));

      await page.goto('/?date=2037-05-14');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      // The calendar that did load still shows its event.
      await expect(page.locator('.month-grid .event-chip', { hasText: 'E2E 65 Visible' })).toBeVisible({ timeout: 10000 });
      // The broken one is badged in the sidebar, the working one is not.
      const badItem = page.locator(`#calendar-list .calendar-item[data-cal-id="${badId}"]`);
      const okItem = page.locator(`#calendar-list .calendar-item[data-cal-id="${okId}"]`);
      await expect(badItem.locator('.calendar-load-error')).toBeVisible({ timeout: 10000 });
      await expect(badItem.locator('.calendar-load-error')).toHaveAttribute('title', 'Der Kalenderserver ist gerade nicht erreichbar.');
      await expect(badItem).toHaveAttribute('aria-label', /E2E 65 Broken \(Termine konnten nicht geladen werden/);
      await expect(okItem).toBeVisible();
      await expect(okItem.locator('.calendar-load-error')).toHaveCount(0);
      await expect(page.locator('#toast-container .toast.error', {
        hasText: 'Termine konnten nicht vollständig geladen werden (E2E 65 Broken)'
      })).toBeVisible({ timeout: 10000 });

      // Once the calendar answers again, the badge is gone.
      failing = false;
      await page.click('#next-btn');
      await expect(badItem).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-load-error')).toHaveCount(0, { timeout: 10000 });
    });

    test('Issue #170 — revisiting a month is served from the cache after a delta-sync check; a change made elsewhere forces a refetch', async ({ page }) => {
      const listRequests = [];
      const deltaRequests = [];
      let pending = 0;
      const isTracked = r => {
        const { pathname } = new URL(r.url());
        return (r.method() === 'GET' && pathname === '/api/events') || (r.method() === 'POST' && pathname.endsWith('/delta-sync'));
      };
      page.on('request', r => {
        if (!isTracked(r)) return;
        pending++;
        if (r.method() === 'GET') listRequests.push(r.url());
        else deltaRequests.push(r.url());
      });
      const settle = r => { if (isTracked(r)) pending--; };
      page.on('requestfinished', settle);
      page.on('requestfailed', settle);

      // Navigate and wait until that loadEvents() is done: its delta checks have
      // answered and, if it refetches, the event list has arrived.
      const navigate = async (button) => {
        const deltaBefore = deltaRequests.length;
        await page.click(button);
        await expect.poll(() => deltaRequests.length > deltaBefore && pending === 0, { timeout: 15000 }).toBe(true);
        // A refetch, if any, is issued right after the delta checks answer.
        await page.waitForTimeout(500);
        await expect.poll(() => pending, { timeout: 15000 }).toBe(0);
      };

      const firstList = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events');
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });
      expect((await firstList).ok()).toBeTruthy();
      const calendarId = await page.locator('#calendar-list .calendar-item').first().getAttribute('data-cal-id');

      // Cold month: fetched in full.
      await navigate('#next-btn');
      const listsAfterNext = listRequests.length;
      expect(listsAfterNext).toBeGreaterThanOrEqual(2);

      // Back to the month just visited: nothing changed on the server, so the
      // delta check runs and no full event list is requested.
      await navigate('#prev-btn');
      expect(listRequests.length).toBe(listsAfterNext);

      // A change made outside this tab (another device) is detected by the delta
      // check: the cache is dropped and the month is fetched again.
      const now = new Date();
      const day = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 15, 10, 0, 0));
      const title = `E2E Issue170 Delta ${Date.now()}`;
      const created = await page.request.post('/api/events', {
        headers: SAME_ORIGIN,
        data: { calendarId, title, start: day.toISOString(), end: new Date(day.getTime() + 3600 * 1000).toISOString() }
      });
      expect(created.status()).toBe(201);
      const ev = await created.json();
      try {
        await navigate('#next-btn');
        const listsBeforeBack = listRequests.length;
        await navigate('#prev-btn');
        expect(listRequests.length).toBeGreaterThan(listsBeforeBack);
        await expect(page.locator('#calendar-container', { hasText: title })).toBeVisible({ timeout: 10000 });
      } finally {
        const del = await page.request.delete(`/api/events/${encodeURIComponent(ev.uid)}`, {
          headers: SAME_ORIGIN,
          data: { calendarId, href: ev.href, etag: ev.etag }
        });
        expect(del.ok()).toBeTruthy();
      }

      // A deletion made elsewhere is a change as well: the event disappears.
      await navigate('#next-btn');
      const listsBeforeReturn = listRequests.length;
      await navigate('#prev-btn');
      expect(listRequests.length).toBeGreaterThan(listsBeforeReturn);
      await expect(page.locator('#calendar-container', { hasText: title })).toHaveCount(0);
    });

    test('Issue #170 — with no known calendars nothing is delta-checked, so a revisited month is fetched again', async ({ page }) => {
      // The calendar list failed to load: events still arrive through
      // /api/events, but no calendar can be checked for changes. The first
      // month holds one event of that unknown calendar, every other month none.
      let calendarListLoads = 0;
      await page.route('**/api/calendars', async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        calendarListLoads++;
        await route.fulfill({ json: { calendars: [], errors: [] } });
      });
      let firstStart = null;
      await page.route('**/api/events?*', async (route) => {
        const params = new URL(route.request().url()).searchParams;
        const start = new Date(params.get('start'));
        const end = new Date(params.get('end'));
        if (firstStart === null) firstStart = params.get('start');
        if (params.get('start') !== firstStart) return route.fulfill({ json: { events: [], errors: [] } });
        const evStart = new Date((start.getTime() + end.getTime()) / 2);
        await route.fulfill({ json: { errors: [], events: [{
          uid: 'e2e-issue170-unknown', title: 'E2E Issue170 Unknown Calendar',
          calendarId: 'internal-caldav::/testuser/issue170-unknown/', accountId: 'internal-caldav',
          start: evStart.toISOString(), end: new Date(evStart.getTime() + 3600 * 1000).toISOString(), allDay: false
        }] } });
      });
      const isList = r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'GET';
      const firstList = page.waitForResponse(isList);
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expect((await firstList).ok()).toBeTruthy();
      // The event belongs to a calendar the client does not know, so the
      // calendar list is loaded again to bring it under the delta check.
      await expect.poll(() => calendarListLoads, { timeout: 10000 }).toBeGreaterThanOrEqual(2);

      const nextList = page.waitForResponse(isList);
      await page.click('#next-btn');
      expect((await nextList).ok()).toBeTruthy();

      // The first month's cache entry is still there, but with no calendar
      // to check it cannot be trusted.
      const backList = page.waitForResponse(isList, { timeout: 10000 });
      await page.click('#prev-btn');
      expect((await backList).ok()).toBeTruthy();
    });
  });

  test('Issue #338 — imported ICS with ATTACH:javascript: renders no script link, safe attachment stays clickable', async ({ page }) => {
    const testDate = '2036-03-12';
    const title = `E2E Issue338 Import ${Date.now()}`;
    const chip = await importIcsAndOpenPopover(page, testDate, title, [
      'ATTACH;X-FILENAME=Agenda.pdf:javascript:document.title="pwned"',
      'ATTACH;X-FILENAME=Payload.html:data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'ATTACH;X-FILENAME=Brief.pdf:https://files.example.com/d/brief.pdf'
    ]);

    const links = page.locator('#popover-attachments a');
    await expect(links).toHaveCount(1);
    await expect(links.first()).toHaveAttribute('href', 'https://files.example.com/d/brief.pdf');
    await expect(links.first()).toHaveText('Brief.pdf');
    expect(await scriptSchemeLinks(page)).toEqual([]);

    await deleteViaPopover(page, chip);
  });

  test('Issue #338 — popover refuses to render javascript: attachment URLs even if the API returns them', async ({ page }) => {
    const testDate = '2036-03-19';
    const title = `E2E Issue338 Client Guard ${Date.now()}`;
    await importIcsAndOpenPopover(page, testDate, title, [
      'ATTACH;X-FILENAME=Brief.pdf:https://files.example.com/d/brief.pdf'
    ]);
    await page.keyboard.press('Escape');

    // Simulate a payload that bypassed server-side filtering (e.g. an older cached response).
    await page.route('**/api/events?**', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const ev of body.events) {
        if (ev.title === title) {
          ev.attachments = [
            { url: 'javascript:document.title="pwned"', name: 'Agenda.pdf' },
            { url: 'JaVaScRiPt:alert(1)', name: 'Mixed.pdf' },
            { url: 'https://files.example.com/d/brief.pdf', name: 'Brief.pdf' }
          ];
        }
      }
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    const reloadedChip = page.locator('.event-chip').filter({ hasText: title }).first();
    await expect(reloadedChip).toBeVisible({ timeout: 15000 });
    await reloadedChip.click();

    const links = page.locator('#popover-attachments a');
    await expect(links).toHaveCount(1);
    await expect(links.first()).toHaveAttribute('href', 'https://files.example.com/d/brief.pdf');
    expect(await scriptSchemeLinks(page)).toEqual([]);

    await page.unroute('**/api/events?**');
    await deleteViaPopover(page, reloadedChip);
  });

  // #528: PARTSTAT comes verbatim from remote calendars and lands in the event dialog's markup.
  const PARTSTAT_INJECTION = '"><b id=inj>x</b><span class="';
  const RFC_PARTSTATS = ['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE', 'DELEGATED'];

  async function expectStatusPillsClean(page, expectedStatus) {
    const pills = page.locator('#ev-attendee-list .attendee-status');
    await expect(pills.first()).toBeVisible();
    await expect(page.locator('#inj')).toHaveCount(0);
    await expect(page.locator('#ev-attendee-list b')).toHaveCount(0);
    const classNames = await pills.evaluateAll(els => els.map(el => el.className));
    for (const cls of classNames) {
      expect(cls).not.toContain('<');
      expect(cls.split(' ')).toHaveLength(2);
      expect(RFC_PARTSTATS).toContain(cls.split(' ')[1]);
    }
    expect(classNames[0]).toBe(`attendee-status ${expectedStatus}`);
  }

  test('Issue #528 — imported ATTENDEE PARTSTAT markup does not reach the event dialog', async ({ page }) => {
    const testDate = '2036-03-26';
    const title = `E2E Issue528 Import ${Date.now()}`;
    const chip = await importIcsAndOpenPopover(page, testDate, title, [
      `ATTENDEE;CN=Test User;PARTSTAT=${PARTSTAT_INJECTION}:mailto:testuser@example.com`,
      'ATTENDEE;CN=Test User 2;PARTSTAT=accepted:mailto:testuser2@example.com'
    ]);
    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);

    // An unrecognised PARTSTAT is treated as NEEDS-ACTION (RFC 5545 §3.2.12); case is normalised.
    await expectStatusPillsClean(page, 'NEEDS-ACTION');
    await expect(page.locator('#ev-attendee-list .attendee-status')).toHaveText(['Ausstehend', 'Zugesagt']);
    await page.click('#event-cancel-btn');

    await chip.click();
    await deleteViaPopover(page, chip);
  });

  test('Issue #528 — the event dialog neutralises a hostile attendee status even if the API returns it', async ({ page }) => {
    const testDate = '2036-03-27';
    const title = `E2E Issue528 Client Guard ${Date.now()}`;
    const calendarId = `internal-caldav::/${E2E_USER}/personal/`;
    const event = {
      uid: 'e2e-issue528-client', title, calendarId, start: `${testDate}T09:00:00+01:00`, end: `${testDate}T10:00:00+01:00`,
      allDay: false, href: `/${E2E_USER}/personal/e2e-issue528-client.ics`, etag: '"e2e-528"',
      attendees: [{ name: 'Test User', email: 'testuser@example.com', status: PARTSTAT_INJECTION }]
    };
    const saves = [];
    await mockEvents(page, [event]);
    await page.route('**/api/events/*', route => {
      if (route.request().method() !== 'PUT') return route.fallback();
      saves.push(route.request().postDataJSON());
      return route.fulfill({ json: { ...event, ...saves.at(-1) } });
    });
    await page.goto(`/?date=${testDate}`);
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await page.locator('.event-chip').filter({ hasText: title }).first().click();
    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);

    await expectStatusPillsClean(page, 'NEEDS-ACTION');
    await expect(page.locator('#ev-attendee-list .attendee-status')).toHaveText('Ausstehend');

    // Saving must not round-trip the injected value back to the server.
    await page.click('#event-save-btn');
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0].attendees.map(a => a.status)).toEqual(['NEEDS-ACTION']);
  });

  test('Issue #338 — CSP blocks injected inline scripts and the app still works without unsafe-inline', async ({ page }) => {
    const violations = [];
    page.on('console', msg => {
      if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
    });
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });
    expect(violations).toEqual([]);

    const result = await page.evaluate(async () => {
      window.__issue338Inline = false;
      window.__issue338Handler = false;
      const s = document.createElement('script');
      s.textContent = 'window.__issue338Inline = true;';
      document.body.appendChild(s);
      const img = document.createElement('img');
      img.setAttribute('onerror', 'window.__issue338Handler = true');
      img.src = 'data:image/png;base64,invalid';
      document.body.appendChild(img);
      await new Promise(r => setTimeout(r, 300));
      return { inline: window.__issue338Inline, handler: window.__issue338Handler };
    });
    // 'unsafe-eval' is asserted on the header in server/test (page.evaluate itself bypasses eval CSP).
    expect(result).toEqual({ inline: false, handler: false });
  });

  test('Issue #338 — OAuth popup script is external and still notifies the opener under the strict CSP', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    const message = await page.evaluate(() => new Promise((resolve) => {
      window.addEventListener('message', (e) => resolve(e.data), { once: true });
      const popup = window.open('', 'issue338-popup');
      popup.document.write('<script src="/js/oauthLinked.js"></' + 'script>');
      popup.document.close();
    }));
    expect(message).toBe('google-account-linked');
  });

  test('should configure working hours policy and ooo auto-decline rules in settings drawer', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

    // Open settings drawer
    await page.click('#sidebar-settings-btn');
    await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);

    // Update working hours select options
    await page.selectOption('#wh-start-hour', '8');
    await page.selectOption('#wh-end-hour', '16');

    // Enable auto-decline and OOO
    await page.check('#wh-auto-decline');
    await page.check('#wh-ooo-enabled');

    // Fill OOO dates & message
    await page.fill('#wh-ooo-start', '2026-10-01');
    await page.fill('#wh-ooo-end', '2026-10-15');
    await page.fill('#wh-ooo-message', 'Urlaub / Out of Office');

    // Save rules
    await page.click('#wh-save-btn');
    await expect(page.locator('#wh-save-status')).toHaveText('Gespeichert!', { timeout: 5000 });

    // Close settings drawer
    await page.click('#close-settings-btn');
    await expect(page.locator('#settings-drawer')).toHaveClass(/hidden/);
  });

  // Issue #254: the browser clock is pinned to a daylight-saving changeover and to an ordinary
  // control day. The modal fills in its own default date and time, and the test asserts that
  // the wall clock the form showed is the wall clock Radicale stored. Expected defaults are
  // literals: a Date built here in the test process would not see the browser's pinned clock.
  test.describe('Issue #254 — the wall clock the create form showed is the wall clock that got stored', () => {
    async function createWithFormDefaults(page, pinnedNow) {
      await page.clock.install({ time: new Date(pinnedNow) });
      await page.goto('/');
      await page.clock.resume();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
      const shown = {
        date: await page.locator('#ev-start-date').inputValue(),
        time: await page.locator('#ev-start-time').inputValue(),
        tz: await page.locator('#ev-start-tz').inputValue(),
      };
      const title = `Issue 254 default ${pinnedNow}`;
      await page.fill('#ev-title', title);
      await page.click('#event-save-btn');
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
      await expect(page.locator('.event-chip').filter({ hasText: title }).first()).toBeVisible({ timeout: 15000 });
      await expectSavesLanded(page);

      const stored = await page.evaluate(async ({ title, date }) => {
        const day = Date.parse(`${date}T00:00:00Z`);
        const range = `start=${new Date(day - 2 * 86400000).toISOString()}&end=${new Date(day + 3 * 86400000).toISOString()}`;
        const res = await fetch(`/api/events?${range}`);
        const ev = (await res.json()).events.find(e => e.title === title);
        if (!ev) return null;
        // The calendar export is Radicale's own copy of the collection, not the app's parse of it.
        const exported = await (await fetch(`/api/calendars/${encodeURIComponent(ev.calendarId)}/export`)).text();
        const vevent = exported.replace(/\r?\n[ \t]/g, '').split('BEGIN:VEVENT').find(c => c.includes(`\nUID:${ev.uid}`));
        await fetch(`/api/events/${encodeURIComponent(ev.uid)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarId: ev.calendarId, etag: ev.etag, href: ev.href }),
        });
        return vevent || null;
      }, { title, date: shown.date });
      expect(stored).not.toBeNull();
      const storedDtstart = stored.match(/^DTSTART[;:].*$/m)[0].trim();
      return { shown, storedDtstart };
    }

    function expectStoredAsShown({ shown, storedDtstart }) {
      expect(storedDtstart).toBe(
        `DTSTART;TZID=${shown.tz}:${shown.date.replace(/-/g, '')}T${shown.time.replace(':', '')}00`);
    }

    test('Europe/Berlin changeover day 2026-10-25, 00:10 CEST', async ({ page }) => {
      const r = await createWithFormDefaults(page, '2026-10-24T22:10:00Z');
      expect(r.shown).toEqual({ date: '2026-10-25', time: '01:00', tz: 'Europe/Berlin' });
      expectStoredAsShown(r);
    });

    test('Europe/Berlin control day 2026-10-19, 00:10 CEST', async ({ page }) => {
      const r = await createWithFormDefaults(page, '2026-10-18T22:10:00Z');
      expect(r.shown).toEqual({ date: '2026-10-19', time: '01:00', tz: 'Europe/Berlin' });
      expectStoredAsShown(r);
    });

    test.describe('in America/New_York', () => {
      test.use({ timezoneId: 'America/New_York' });

      test('changeover day 2026-11-01, 02:10 EST', async ({ page }) => {
        const r = await createWithFormDefaults(page, '2026-11-01T07:10:00Z');
        expect(r.shown).toEqual({ date: '2026-11-01', time: '03:00', tz: 'America/New_York' });
        expectStoredAsShown(r);
      });

      test('control day 2026-10-25, 03:10 EDT', async ({ page }) => {
        const r = await createWithFormDefaults(page, '2026-10-25T07:10:00Z');
        expect(r.shown).toEqual({ date: '2026-10-25', time: '04:00', tz: 'America/New_York' });
        expectStoredAsShown(r);
      });

      test('evening 2026-10-30, 20:30 EDT, when UTC is already on the next day', async ({ page }) => {
        const r = await createWithFormDefaults(page, '2026-10-31T00:30:00Z');
        expect(r.shown).toEqual({ date: '2026-10-30', time: '21:00', tz: 'America/New_York' });
        expectStoredAsShown(r);
      });
    });
  });

  test.describe('Issue #106 — the status bar says loading, free, failed or a count in every view', () => {
    // page.route needs the service worker off.
    test.use({ serviceWorkers: 'block' });

    test('every view states its own empty range, and the loading state precedes it', async ({ page }) => {
      let releaseEvents;
      const eventsHeld = new Promise(resolve => { releaseEvents = resolve; });
      await page.route('**/api/events?*', async route => {
        await eventsHeld;
        await route.fulfill({ json: { events: [], errors: [] } });
      });
      await page.route('**/api/tasks', route => {
        if (route.request().method() !== 'GET') return route.continue();
        return route.fulfill({ json: [] });
      });
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const bar = page.locator('#status-bar');
      await expect(bar).toHaveText('Lade Termine…', { timeout: 10000 });
      releaseEvents();
      await expect(bar).toHaveText('Keine Termine in diesem Monat.', { timeout: 10000 });

      const expected = [
        ['week', 'Keine Termine in dieser Woche.'],
        ['workweek', 'Keine Termine in dieser Arbeitswoche.'],
        ['day', 'Keine Termine an diesem Tag.'],
        ['agenda', 'Keine Termine im gewählten Zeitraum.'],
        ['kanban', 'Keine Aufgaben vorhanden.'],
        ['month', 'Keine Termine in diesem Monat.']
      ];
      for (const [view, text] of expected) {
        // Blank the bar first: a view that never writes it must not pass on the previous view's text.
        await bar.evaluate(el => { el.textContent = ''; });
        await page.click(`#view-${view}`);
        await expect(bar, `${view} view`).toHaveText(text, { timeout: 10000 });
      }
    });

    test('a failed load keeps the error in the bar, also after switching views', async ({ page }) => {
      await page.route('**/api/events?*', route =>
        route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Datenbankfehler' }) }));
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const bar = page.locator('#status-bar');
      await expect(page.locator('#toast-container .toast.error', { hasText: 'Fehler beim Laden der Termine' })).toBeVisible({ timeout: 10000 });
      await expect(bar).toHaveText(/^Fehler: Fehler beim Laden der Termine: .*Datenbankfehler/);

      await bar.evaluate(el => { el.textContent = ''; });
      await page.click('#view-day');
      await expect(bar).toHaveText(/Fehler beim Laden der Termine: .*Datenbankfehler/, { timeout: 10000 });
      await expect(bar).not.toHaveText(/Keine Termine/);
    });
  });

  test.describe('Issue #343 — load failures are shown, not swallowed', () => {
    // page.route needs the service worker off.
    test.use({ serviceWorkers: 'block' });

    test('working hours that fail to load show an error and cannot be overwritten with the defaults', async ({ page }) => {
      await page.route('**/api/working-hours', route => {
        if (route.request().method() !== 'GET') return route.continue();
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Datenbankfehler' }) });
      });
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      await page.click('#sidebar-settings-btn');
      await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
      await expect(page.locator('#wh-save-status')).toHaveText('Arbeitszeiten konnten nicht geladen werden.');
      await expect(page.locator('#wh-save-btn')).toBeDisabled();
    });

    test('webcal subscriptions that fail to load raise an error toast', async ({ page }) => {
      await page.route('**/api/webcal/subscriptions', route => {
        if (route.request().method() !== 'GET') return route.continue();
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Datenbankfehler' }) });
      });
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      await expect(page.locator('#toast-container .toast.error', { hasText: 'Abonnements konnten nicht geladen werden' })).toBeVisible({ timeout: 10000 });
    });

    test('a subscription whose events fail to load raises an error toast naming it', async ({ page }) => {
      await page.route('**/api/webcal/subscriptions', route => {
        if (route.request().method() !== 'GET') return route.continue();
        return route.fulfill({ json: { subscriptions: [{ id: 'e2e-343-sub', name: 'E2E Feed 343', color: '#3b82f6' }] } });
      });
      await page.route('**/api/webcal/subscriptions/e2e-343-sub/events?**', route =>
        route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Feed nicht erreichbar' }) }));
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      const feedToast = page.locator('#toast-container .toast.error', { hasText: 'E2E Feed 343' });
      await expect(feedToast).toBeVisible({ timeout: 10000 });

      // Paging reloads the feed and fails again; the unchanged failure is not reported once per page turn.
      // The toast decision follows the logged failure within the same task (promise microtasks);
      // after the log line and one macrotask, a second toast would already be in the DOM.
      const reloadFailed = page.waitForEvent('console', msg => msg.text().includes('[webcal] Failed to load events for subscription'));
      await page.click('#next-btn');
      await reloadFailed;
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      await expect(feedToast).toHaveCount(1);
    });
  });

  test.describe('Issue #224 — a failed first request is neither "no accounts" nor "no calendars"', () => {
    // page.route needs the service worker off.
    test.use({ serviceWorkers: 'block' });

    const failWith = (status, error) => route => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error }) });
    };

    test('a 401 on the account list asks the user to sign in again instead of onboarding', async ({ page }) => {
      await page.route('**/api/accounts', failWith(401, 'Authentication required'));
      await page.goto('/');

      const reauth = page.locator('#reauth-screen');
      await expect(reauth).toBeVisible({ timeout: 10000 });
      await expect(reauth.getByRole('heading', { name: 'Sitzung abgelaufen' })).toBeVisible();
      await expect(reauth.getByRole('link', { name: 'Erneut anmelden' })).toHaveAttribute('href', '/api/auth/login');
      await expect(page.locator('#onboarding')).toBeHidden();
      await expect(page.locator('#app')).toBeHidden();
      await expect(page.locator('#loading-screen')).toBeHidden();
    });

    test('a 401 on the calendar list asks the user to sign in again', async ({ page }) => {
      await page.route('**/api/calendars', failWith(401, 'Authentication required'));
      await page.goto('/');

      await expect(page.locator('#reauth-screen')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#app')).toBeHidden();
      await expect(page.locator('#onboarding')).toBeHidden();
    });

    test('a 500 on the account list keeps the app shell, shows the error once and claims no empty sidebar', async ({ page }) => {
      await page.route('**/api/accounts', failWith(500, 'Fehler beim Laden der Kontodaten.'));
      await page.goto('/');

      await expect(page.locator('#app')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#onboarding')).toBeHidden();
      await expect(page.locator('#reauth-screen')).toBeHidden();
      await expect(page.locator('#toast-container .toast.error .toast-msg')).toHaveText('Fehler beim Laden der Kontodaten.');
      const list = page.locator('#calendar-list');
      await expect(list).toHaveText('Kalender konnten nicht geladen werden.');
      await expect(list).not.toContainText('Keine Kalender gefunden.');
    });

    test('a 500 on the calendar list shows the failure in the sidebar, not an empty list', async ({ page }) => {
      await page.route('**/api/calendars', failWith(500, 'CalDAV-Server nicht erreichbar'));
      await page.goto('/');

      await expect(page.locator('#app')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#toast-container .toast.error', { hasText: 'CalDAV-Server nicht erreichbar' })).toBeVisible({ timeout: 10000 });
      const list = page.locator('#calendar-list');
      await expect(list).toHaveText('Kalender konnten nicht geladen werden.');
      await expect(list).not.toContainText('Keine Kalender gefunden.');
    });

    test('only a successful empty account list leads to onboarding', async ({ page }) => {
      await page.route('**/api/accounts', route => {
        if (route.request().method() !== 'GET') return route.continue();
        return route.fulfill({ json: [] });
      });
      await page.goto('/');

      await expect(page.locator('#onboarding')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#reauth-screen')).toBeHidden();
      await expect(page.locator('#app')).toBeHidden();
    });
  });

  test.describe('Issue #496 — linked accounts are named by their custom name', () => {
    let personalId;
    let primaryId;
    let teamId;
    let workId;
    // #592: the ids name the test's own user, known only once its fixture is set up.
    test.beforeEach(() => {
      personalId = `internal-caldav::/${E2E_USER}/personal/`;
      primaryId = `internal-caldav::/${E2E_USER}/google-0123456789abcdef/`;
      teamId = `internal-caldav::/${E2E_USER}/caldav-fedcba9876543210/`;
      workId = `internal-caldav::/${E2E_USER}/caldav-00112233445566778899/`;
    });
    const calendar = (id, name, linkedAccountId, supportsVTODO) => ({
      id, accountId: 'internal-caldav', linkedAccountId, name, color: '#3366cc', href: id.split('::')[1],
      isShared: false, readOnly: false, supportsVEVENT: true, supportsVTODO
    });

    async function serveAccounts(page) {
      const accounts = [
        { id: 'internal-caldav', url: 'https://caldav.example.com/', username: E2E_USER, displayName: 'Shard' },
        { id: 'acc-496', url: 'https://caldav.example.com/testuser/', username: 'testuser@example.com', displayName: 'Privat' },
        { id: 'acc-496-plain', url: 'https://caldav.example.com/testuser2/', username: 'testuser2@example.com', displayName: null },
      ];
      const renames = [];
      await page.route('**/api/accounts', route => (route.request().method() === 'GET'
        ? route.fulfill({ json: accounts })
        : route.fallback()));
      await page.route('**/api/accounts/acc-496', route => {
        if (route.request().method() !== 'PATCH') return route.fallback();
        renames.push(route.request().postDataJSON());
        return route.fulfill({ json: { message: 'Updated.' } });
      });
      await mockCalendars(page, [
        calendar(primaryId, 'testuser@example.com', 'acc-496', false),
        calendar(personalId, 'Persönlich', null, true),
        calendar(teamId, 'Team', 'acc-496', true),
        calendar(workId, 'Arbeit', 'acc-496-plain', true),
      ]);
      return renames;
    }

    // [[group label or null, [option texts]]] of a <select>, in display order.
    const pickerGroups = (page, sel) => page.locator(sel).evaluate(select => [...select.children].map(el =>
      el.tagName === 'OPTGROUP'
        ? [el.label, [...el.children].map(o => o.textContent)]
        : [null, [el.textContent]]));

    test('pickers and the sidebar label a linked account\'s calendars with its name and follow a rename', async ({ page }) => {
      const renames = await serveAccounts(page);
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      const groupLabels = page.locator('#calendar-list .calendar-group-label');
      await expect(groupLabels).toHaveText(['Privat', 'testuser2@example.com'], { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-name'))
        .toHaveText(['Persönlich', 'Privat', 'Team', 'Arbeit']);

      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expect(await pickerGroups(page, '#ev-calendar')).toEqual([
        [null, ['Persönlich']],
        ['Privat', ['Privat', 'Team']],
        ['testuser2@example.com', ['Arbeit']],
      ]);
      await page.click('#event-cancel-btn');

      await page.click('#new-task-btn');
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expect(await pickerGroups(page, '#task-calendar-id')).toEqual([
        [null, ['Persönlich']],
        ['Privat', ['Team']],
        ['testuser2@example.com', ['Arbeit']],
      ]);
      await page.click('#task-cancel-btn');
      await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/);

      // Renaming the account relabels the sidebar and every picker without a reload.
      await page.click('#sidebar-settings-btn');
      await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
      page.once('dialog', dialog => dialog.accept('Familie'));
      await page.click('[data-edit-acc="acc-496"]');
      await expect(page.locator('#toast-container .toast', { hasText: 'Account umbenannt.' })).toBeVisible({ timeout: 10000 });
      expect(renames).toEqual([{ displayName: 'Familie' }]);
      await page.click('#close-settings-btn');
      await expect(page.locator('#settings-drawer')).toHaveClass(/hidden/);

      await expect(groupLabels).toHaveText(['Familie', 'testuser2@example.com']);
      await expect(page.locator('#calendar-list .calendar-name'))
        .toHaveText(['Persönlich', 'Familie', 'Team', 'Arbeit']);

      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expect(await pickerGroups(page, '#ev-calendar')).toEqual([
        [null, ['Persönlich']],
        ['Familie', ['Familie', 'Team']],
        ['testuser2@example.com', ['Arbeit']],
      ]);
      await page.click('#event-cancel-btn');

      await page.click('#new-task-btn');
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expect(await pickerGroups(page, '#task-calendar-id')).toEqual([
        [null, ['Persönlich']],
        ['Familie', ['Team']],
        ['testuser2@example.com', ['Arbeit']],
      ]);
    });
  });

  test('should manage focus inside modal dialog and close modal on Escape key press', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

    // Open Event Modal
    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });

    // Verify focus is set within event modal title field
    await expect(page.locator('#ev-title')).toBeFocused();

    // Press Escape key -> modal must close
    await page.keyboard.press('Escape');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 5000 });
  });

  test.describe('Issue #185 — group captions name their control groups', () => {
    // A <label> must label a control; one that labels nothing is a caption with no programmatic tie.
    async function orphanLabels(page, rootSelector) {
      return page.locator(rootSelector).evaluate(root =>
        Array.from(root.querySelectorAll('label')).filter(l => l.control === null).map(l => l.textContent.trim()));
    }

    test('recurrence and attendee captions are group names in the event dialog', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#new-event-btn');
      const dialog = page.locator('#event-modal-backdrop');
      await expect(dialog).not.toHaveClass(/hidden/);

      expect(await orphanLabels(page, '#event-modal-backdrop')).toEqual([]);

      await openEventSection(page, 'recurrence');
      await page.selectOption('#ev-recurrence', 'WEEKLY');
      const weekly = dialog.getByRole('group', { name: 'Wiederholen am', exact: true });
      await expect(weekly).toHaveCount(1);
      await expect(weekly.getByRole('checkbox')).toHaveCount(7);
      await expect(weekly.getByRole('checkbox', { name: 'Mo' })).toBeVisible();

      const end = dialog.getByRole('group', { name: 'Ende der Wiederholung', exact: true });
      await expect(end.getByRole('radio')).toHaveCount(3);
      await expect(end.getByRole('spinbutton', { name: 'Anzahl Wiederholungen' })).toBeVisible();

      await openEventSection(page, 'recurrence');
      await page.selectOption('#ev-recurrence', 'MONTHLY');
      const monthly = dialog.getByRole('group', { name: 'Wiederholen am', exact: true });
      await expect(monthly).toHaveCount(1);
      await expect(monthly.getByRole('radio')).toHaveCount(2);
      await expect(monthly.getByRole('combobox', { name: 'Wochentag' })).toBeVisible();

      await openEventSection(page, 'attendees');
      const attendees = dialog.getByRole('group', { name: 'Teilnehmende', exact: true });
      await expect(attendees.getByRole('textbox', { name: 'Name der teilnehmenden Person' })).toBeVisible();
      await expect(attendees.getByRole('textbox', { name: 'E-Mail der teilnehmenden Person' })).toBeVisible();
    });

    test('the working-days caption names the weekday checkboxes in settings', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#sidebar-settings-btn');
      const drawer = page.locator('#settings-drawer');
      await expect(drawer).not.toHaveClass(/hidden/);

      expect(await orphanLabels(page, '#settings-drawer')).toEqual([]);
      const days = drawer.getByRole('group', { name: 'Arbeitstage', exact: true });
      await expect(days.getByRole('checkbox')).toHaveCount(7);
      await expect(days.getByRole('checkbox', { name: 'Sa' })).toBeVisible();
    });
  });

  test('Issue #254 — a view opened on the changeover date 2026-10-25 creates events on that date', async ({ page }) => {
    await page.goto('/?date=2026-10-25');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

    // Verify toolbar title reflects October 2026 changeover date
    // The element is #toolbar-title (an h3 in the calendar toolbar), not #current-view-title
    await expect(page.locator('#toolbar-title')).toContainText('Oktober 2026', { timeout: 5000 });

    // Open new event modal on changeover date
    await page.click('#new-event-btn');
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });

    // The view stands at local midnight Berlin, 2026-10-24T22:00Z; the form shows the local date.
    await expect(page.locator('#ev-start-date')).toHaveValue('2026-10-25');
    await expect(page.locator('#ev-end-date')).toHaveValue('2026-10-25');

    await page.keyboard.press('Escape');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 5000 });
  });

  test('Issue #136 — an account with unreadable credentials is shown in settings and can be deleted from the UI', async ({ page }) => {
    const { randomUUID } = require('crypto');
    // Rows go into the webServer's DATABASE_PATH, owned by the user env auth signs the browser in as.
    const userId = E2E_USER;
    const brokenId = randomUUID();
    const brokenName = `Nextcloud kaputt ${Date.now()}`;

    const removeSeededRows = () => runSql(
      "DELETE FROM linked_accounts WHERE user_id = ? AND display_name LIKE 'Nextcloud kaputt %'", [userId]
    );
    await removeSeededRows(); // leftovers of an aborted earlier run

    // Ciphertext that does not decrypt under the server's key — a restore onto a shard with a different ENCRYPTION_KEY.
    await runSql(
      `INSERT INTO linked_accounts (id, user_id, url, username, password_encrypted, iv, display_name)
       VALUES (?,?,?,?,?,?,?)`,
      [brokenId, userId, 'https://caldav.example.com/remote.php/dav/', 'testuser', 'deadbeef',
       '00000000000000000000000000000000', brokenName]
    );

    try {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      // The broken account must not be offered as a target for new calendars.
      await page.click('#add-calendar-btn');
      await expect(page.locator('#add-cal-account option')).not.toHaveCount(0);
      await expect(page.locator('#add-cal-account option', { hasText: brokenName })).toHaveCount(0);
      await page.click('#add-cal-cancel');
      await expect(page.locator('#add-cal-dialog-backdrop')).toHaveCount(0);

      await page.click('#sidebar-settings-btn');
      await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);

      const row = page.locator('#settings-account-list .settings-item', { hasText: brokenName });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Zugangsdaten nicht lesbar — Konto neu verbinden');
      const deleteBtn = row.locator(`[data-delete-acc="${brokenId}"]`);
      await expect(deleteBtn).toBeEnabled();

      await deleteBtn.click();
      await page.click('#confirm-dialog-ok');
      await expect(row).toHaveCount(0, { timeout: 10000 });

      const res = await page.request.get('/api/accounts');
      expect(res.status()).toBe(200);
      const accounts = await res.json();
      expect(accounts.find(a => a.id === brokenId)).toBeUndefined();
    } finally {
      // Remove the seeded row even if an assertion failed, so it cannot leak into later tests.
      await removeSeededRows();
    }
  });

  test('should subscribe to a webcal feed, display overlay events, toggle visibility, and show read-only details (Issue #24)', async ({ page }) => {
    const http = require('http');
    const timestamp = Date.now();
    const eventTitle = `E2E Webcal Event ${timestamp}`;
    const feedName = `E2E Webcal Feed ${timestamp}`;
    const mockIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test User Feed//EN',
      'BEGIN:VEVENT',
      `UID:e2e-webcal-event-${timestamp}@example.com`,
      `SUMMARY:${eventTitle}`,
      'DTSTART:20281228T100000Z',
      'DTEND:20281228T110000Z',
      'LOCATION:Virtual Conference Room',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const feedServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
      res.end(mockIcs);
    });

    await new Promise(resolve => feedServer.listen(0, resolve));
    const port = feedServer.address().port;
    const feedUrl = `http://127.0.0.1:${port}/test-feed.ics`;

    try {
      await page.goto('/?date=2028-12-28');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

      // Click "Webcal-Abonnement hinzufügen" button
      await page.click('#add-webcal-btn');
      await expect(page.locator('#webcal-modal-backdrop')).not.toHaveClass(/hidden/);

      // Fill subscription form
      await page.fill('#webcal-url', feedUrl);
      await page.fill('#webcal-name', feedName);
      await page.click('#webcal-save-btn');

      // Modal closes and subscription appears in sidebar
      await expect(page.locator('#webcal-modal-backdrop')).toHaveClass(/hidden/, { timeout: 5000 });
      await expect(page.locator('#webcal-list')).toContainText(feedName, { timeout: 5000 });

      // The subscription event should be rendered on the calendar grid
      const eventItem = page.locator('.event-chip, .event-block, [data-event-uid]').filter({ hasText: eventTitle }).first();
      await expect(eventItem).toBeVisible({ timeout: 5000 });

      // Clicking event shows read-only popover
      await eventItem.click();
      await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);
      await expect(page.locator('#event-popover')).toContainText('Abonnement (schreibgeschützt)');

      // Close popover
      await page.keyboard.press('Escape');

      // Toggle subscription off in sidebar
      const subItem = page.locator('#webcal-list .calendar-item', { hasText: feedName }).first();
      await subItem.click();

      // Event should now be hidden from the calendar grid
      await expect(page.locator('.event-chip, .event-block, [data-event-uid]').filter({ hasText: eventTitle })).toHaveCount(0);

      // Toggle subscription back on
      await subItem.click();
      await expect(page.locator('.event-chip, .event-block, [data-event-uid]').filter({ hasText: eventTitle }).first()).toBeVisible({ timeout: 5000 });
    } finally {
      try {
        const delBtn = page.locator('#webcal-list .calendar-item', { hasText: feedName }).locator('[data-delete-webcal]').first();
        if (await delBtn.isVisible()) {
          await delBtn.click();
          await page.click('#confirm-dialog-ok');
        }
      } finally {
        await new Promise(resolve => feedServer.close(resolve));
      }
    }
  });

  test('webcal: recurring feed events show every occurrence, and a broken feed keeps them with an error in the sidebar (Issue #342)', async ({ page }) => {
    const http = require('http');
    const timestamp = Date.now();
    const eventTitle = `E2E Weekly Lesson ${timestamp}`;
    const feedName = `E2E Timetable ${timestamp}`;
    // Mondays 10:00 UTC from 6 Nov 2028; 11 Dec cancelled. December month view
    // (27 Nov – 7 Jan) shows 27 Nov, 4/18/25 Dec, 1 Jan.
    let feedBody = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test User Feed//EN',
      'BEGIN:VEVENT',
      `UID:e2e-weekly-${timestamp}@example.com`,
      `SUMMARY:${eventTitle}`,
      'DTSTART:20281106T100000Z',
      'DTEND:20281106T110000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'EXDATE:20281211T100000Z',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const feedServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
      res.end(feedBody);
    });
    await new Promise(resolve => feedServer.listen(0, resolve));
    const feedUrl = `http://127.0.0.1:${feedServer.address().port}/timetable.ics`;
    const chips = page.locator('.event-chip, .event-block, [data-event-uid]').filter({ hasText: eventTitle });
    const subItem = page.locator('#webcal-list .calendar-item', { hasText: feedName }).first();
    // Subscriptions left by earlier runs repeat on the same Mondays and push this
    // feed's chips into the month cell's overflow, so remove them via the API.
    const deleteTimetableSubscriptions = async (onlyName) => {
      const list = await page.request.get('/api/webcal/subscriptions');
      expect(list.ok()).toBeTruthy();
      const { subscriptions } = await list.json();
      for (const sub of subscriptions || []) {
        if (onlyName ? sub.name !== onlyName : !String(sub.name || '').startsWith('E2E Timetable ')) continue;
        const del = await page.request.delete(`/api/webcal/subscriptions/${encodeURIComponent(sub.id)}`, { headers: SAME_ORIGIN });
        expect(del.ok()).toBeTruthy();
      }
    };

    try {
      await page.goto('/?date=2028-12-14');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await deleteTimetableSubscriptions();
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-item')).toBeVisible({ timeout: 10000 });

      await page.click('#add-webcal-btn');
      await page.fill('#webcal-url', feedUrl);
      await page.fill('#webcal-name', feedName);
      await page.click('#webcal-save-btn');
      await expect(page.locator('#webcal-modal-backdrop')).toHaveClass(/hidden/, { timeout: 5000 });
      await expect(subItem).toBeVisible({ timeout: 5000 });

      await expect(chips).toHaveCount(5, { timeout: 5000 });
      await expect(subItem.locator('.webcal-sync-error')).toHaveCount(0);

      // The feed starts returning an HTML error page with status 200.
      feedBody = '<html><body>Service temporarily unavailable</body></html>';
      await subItem.locator('[data-sync-webcal]').click();
      await expect(page.locator('#toast-container, .toast').filter({ hasText: 'Sync fehlgeschlagen' }).first()).toBeVisible({ timeout: 5000 });

      const errorLabel = page.locator('#webcal-list .calendar-item', { hasText: feedName }).locator('.webcal-sync-error');
      await expect(errorLabel).toBeVisible({ timeout: 5000 });
      await expect(errorLabel).toHaveAttribute('title', /not valid iCalendar/);
      await expect(chips).toHaveCount(5);

      // After a reload the cached occurrences and the error are still there.
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(errorLabel).toBeVisible({ timeout: 10000 });
      await expect(chips).toHaveCount(5, { timeout: 5000 });

      // Navigating to the next month expands the series for the new window.
      await page.click('#next-btn');
      await expect(page.locator('#toolbar-title')).toContainText('Januar 2029', { timeout: 5000 });
      // January view: 1 Jan – 11 Feb 2029 → 1/8/15/22/29 Jan, 5 Feb.
      await expect(chips).toHaveCount(6, { timeout: 5000 });
    } finally {
      try {
        await deleteTimetableSubscriptions(feedName);
      } finally {
        await new Promise(resolve => feedServer.close(resolve));
      }
    }
  });

  test.describe('Issue #198 — the accounts panel shows the sync status of the Google account', () => {
    // page.route needs the service worker off.
    test.use({ serviceWorkers: 'block' });

    const GOOGLE_ACCOUNT = {
      id: 'acc-google-198',
      url: 'https://apidata.googleusercontent.com/caldav/v2/',
      username: 'testuser@example.com',
      displayName: 'Google testuser',
    };
    // 14 Oct 2026 08:30 UTC / 15 Oct 2026 06:05 UTC, shown in Europe/Berlin (CEST).
    const SUCCESS_AT = Date.UTC(2026, 9, 14, 8, 30);
    const ERROR_AT = Date.UTC(2026, 9, 15, 6, 5);

    // The real accounts plus one linked Google account; `state.jobs` is served on every poll.
    async function serveAccountsAndJobs(page, state) {
      await page.route('**/api/accounts', async route => {
        if (route.request().method() !== 'GET') return route.continue();
        const res = await route.fetch();
        const accounts = await res.json();
        return route.fulfill({ response: res, json: [...accounts, GOOGLE_ACCOUNT] });
      });
      await page.route('**/api/accounts/sync-status', route =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobs: state.jobs }) }));
    }

    async function googleAccountItem(page) {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#sidebar-settings-btn');
      await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
      return page.locator('#settings-account-list .settings-item', { hasText: 'Google testuser' });
    }

    test('a failed sync shows its message and time next to the Google account, with the last success', async ({ page }) => {
      await serveAccountsAndJobs(page, { jobs: [
        { id: 'job-2', status: 'ERROR', errorMessage: 'invalid_grant: <b>Token</b> has been expired or revoked.', createdAt: ERROR_AT - 1000, updatedAt: ERROR_AT },
        { id: 'job-1', status: 'SUCCESS', errorMessage: null, createdAt: SUCCESS_AT - 1000, updatedAt: SUCCESS_AT },
      ] });
      const item = await googleAccountItem(page);
      const status = item.locator('.account-sync-status');
      await expect(status).toContainText('Synchronisation fehlgeschlagen am 15.10.2026, 08:05: invalid_grant: <b>Token</b> has been expired or revoked.', { timeout: 10000 });
      await expect(status.locator('b')).toHaveCount(0);
      await expect(status).toContainText('Zuletzt erfolgreich synchronisiert: 14.10.2026, 10:30');
    });

    test('a successful sync shows when the Google account was last synced', async ({ page }) => {
      await serveAccountsAndJobs(page, { jobs: [
        { id: 'job-1', status: 'SUCCESS', errorMessage: null, createdAt: SUCCESS_AT - 1000, updatedAt: SUCCESS_AT },
      ] });
      const item = await googleAccountItem(page);
      const status = item.locator('.account-sync-status');
      await expect(status).toHaveText('Zuletzt erfolgreich synchronisiert: 14.10.2026, 10:30', { timeout: 10000 });
    });

    test('a sync stuck in RUNNING without any success says no sync has succeeded yet', async ({ page }) => {
      await serveAccountsAndJobs(page, { jobs: [
        { id: 'job-1', status: 'RUNNING', itemsDone: 0, errorMessage: null, createdAt: SUCCESS_AT, updatedAt: SUCCESS_AT },
      ] });
      const item = await googleAccountItem(page);
      await expect(item.locator('.account-sync-status')).toHaveText('Noch keine erfolgreiche Synchronisation', { timeout: 10000 });
    });
  });

  test.describe('Issue #167 — every numeric date in the UI is DIN 5008 dd.mm.yyyy', () => {
    // page.route needs the service worker off.
    test.use({ serviceWorkers: 'block' });

    test('task due dates, app-password creation and invitations show zero-padded day and month', async ({ page }) => {
      const calendarId = `internal-caldav::/${E2E_USER}/personal/`;
      await page.route(/\/api\/tasks(\?.*)?$/, route => {
        if (route.request().method() !== 'GET') return route.continue();
        return route.fulfill({ json: [
          // A date-only due is a calendar date, shown as stored.
          { uid: 'e2e-167-date', title: 'E2E 167 Datum', status: 'NEEDS-ACTION', due: '2027-03-05T00:00:00.000Z', dueIsDate: true,
            calendarId, href: `/${E2E_USER}/personal/e2e-167-date.ics`, etag: '"1"' },
          // A timed due at 23:30 UTC is already 6 March in Europe/Berlin.
          { uid: 'e2e-167-timed', title: 'E2E 167 Zeit', status: 'NEEDS-ACTION', due: '2027-03-05T23:30:00.000Z',
            calendarId, href: `/${E2E_USER}/personal/e2e-167-timed.ics`, etag: '"1"' },
        ] });
      });
      await page.route('**/api/accounts/app-passwords', route => {
        if (route.request().method() !== 'GET') return route.continue();
        return route.fulfill({ json: [{ id: 'asp-167', label: 'Thunderbird', createdAt: '2027-03-04T10:00:00.000Z' }] });
      });
      await page.route('**/api/events/invitations', route => route.fulfill({ json: [
        { uid: 'inv-167', title: 'E2E 167 Einladung', start: '2027-03-07T08:00:00.000Z', calendarId, href: `/${E2E_USER}/personal/inv-167.ics`,
          organizer: { name: 'Test User', email: 'testuser@example.com' }, attendees: [] },
      ] }));

      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      const sidebarTasks = page.locator('#sidebar-task-list');
      await expect(sidebarTasks.locator('.sidebar-task-item', { hasText: 'E2E 167 Datum' }).locator('.sidebar-task-meta')).toHaveText('05.03.2027', { timeout: 10000 });
      await expect(sidebarTasks.locator('.sidebar-task-item', { hasText: 'E2E 167 Zeit' }).locator('.sidebar-task-meta')).toHaveText('06.03.2027');

      await page.click('#view-kanban');
      await expect(page.locator('.kanban-card[data-task-id="e2e-167-date"] .kanban-due-date')).toHaveText('05.03.2027', { timeout: 10000 });
      await expect(page.locator('.kanban-card[data-task-id="e2e-167-timed"] .kanban-due-date')).toHaveText('06.03.2027');

      await page.click('#invitations-btn');
      await expect(page.locator('#invitations-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('.invitation-card[data-uid="inv-167"] .invitation-date')).toHaveText('07.03.2027, 09:00');
      await page.click('#invitations-modal-close');

      await page.click('#sidebar-settings-btn');
      await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
      await expect(page.locator('#settings-asp-list .settings-item', { hasText: 'Thunderbird' })).toContainText('Erstellt am 04.03.2027', { timeout: 10000 });
    });
  });

  test.describe('Issue #203 — background sync failures reach the user', () => {
    // page.route needs the service worker off.
    test.use({ serviceWorkers: 'block' });

    // Serves `state.jobs` on every poll so a test can change it between polls.
    async function serveJobs(page, state) {
      await page.route('**/api/accounts/sync-status', route =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobs: state.jobs }) }));
    }

    // Fire the 60 s status poll and wait until its response has arrived.
    async function nextPoll(page) {
      const polled = page.waitForResponse('**/api/accounts/sync-status');
      await page.clock.fastForward(61 * 1000);
      await polled;
    }

    test('latest sync job in ERROR shows an alert banner with the worker error message', async ({ page }) => {
      const state = { jobs: [
        // A queued job does not hide the last finished run's failure.
        { id: 'job-3', status: 'PENDING', errorMessage: null, createdAt: 3000, updatedAt: 3000 },
        { id: 'job-2', status: 'ERROR', errorMessage: 'vdirsyncer: <b>conflict</b> on testuser/privat', createdAt: 2000, updatedAt: 2100 },
        { id: 'job-1', status: 'SUCCESS', errorMessage: null, createdAt: 1000, updatedAt: 1100 },
      ] };
      await serveJobs(page, state);
      await page.clock.install();
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const banner = page.locator('#sync-error-banner');
      await expect(banner).toBeVisible({ timeout: 10000 });
      await expect(banner).toHaveAttribute('role', 'alert');
      // The worker's message is rendered as text, never as HTML.
      await expect(page.locator('#sync-error-text')).toContainText('vdirsyncer: <b>conflict</b> on testuser/privat');
      await expect(banner.locator('b')).toHaveCount(0);

      await page.locator('#sync-error-dismiss').click();
      await expect(banner).toBeHidden();

      // A dismissed failure stays dismissed on the next poll ...
      await nextPoll(page);
      await expect(banner).toBeHidden();

      // ... but a new failure is shown again.
      state.jobs = [
        { id: 'job-4', status: 'ERROR', errorMessage: 'discovery failed for testuser', createdAt: 4000, updatedAt: 4100 },
        ...state.jobs,
      ];
      await nextPoll(page);
      await expect(banner).toBeVisible();
      await expect(page.locator('#sync-error-text')).toContainText('discovery failed for testuser');
    });

    test('a later successful sync supersedes an older ERROR — banner is cleared', async ({ page }) => {
      const failed = { id: 'job-1', status: 'ERROR', errorMessage: 'old failure', createdAt: 1000, updatedAt: 1100 };
      const state = { jobs: [failed] };
      await serveJobs(page, state);
      await page.clock.install();
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const banner = page.locator('#sync-error-banner');
      await expect(banner).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#sync-error-text')).toContainText('old failure');

      state.jobs = [{ id: 'job-2', status: 'SUCCESS', errorMessage: null, createdAt: 2000, updatedAt: 2100 }, failed];
      await nextPoll(page);
      await expect(banner).toBeHidden();
    });
  });

  test.describe('Issue #97 — Microsoft 365 connection', () => {
    test.use({ serviceWorkers: 'block' });

    async function openMSGraphModal(page) {
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#sidebar-settings-btn');
      await page.click('#settings-add-account-btn');
      await page.click('#btn-link-msgraph');
      await expect(page.locator('#msgraph-modal-backdrop')).not.toHaveClass(/hidden/);
    }

    test('connect starts the PKCE flow at Microsoft and an expired account asks to reconnect', async ({ page }) => {
      const accountId = `e2e-issue97-${Date.now()}`;
      await runSql("DELETE FROM msgraph_accounts WHERE user_id = ? AND id LIKE 'e2e-issue97-%'", [E2E_USER]);
      await runSql(
        `INSERT INTO msgraph_accounts (id, user_id, account_email, access_token, refresh_token, expires_at,
           reconnect_required, created_at, updated_at) VALUES (?, ?, 'testuser@example.com', '', '', 0, 1, ?, ?)`,
        [accountId, E2E_USER, Date.now(), Date.now()]
      );
      try {
        await page.goto('/');
        await openMSGraphModal(page);

        await expect(page.locator('#msgraph-unavailable')).toBeHidden();
        const connect = page.locator('#btn-connect-msgraph');
        await expect(connect).toBeVisible();
        await expect(connect).toHaveAttribute('href', '/api/msgraph/authorize');
        // There is no form to type an address or tokens into.
        await expect(page.locator('#msgraph-modal input')).toHaveCount(0);

        const row = page.locator('#msgraph-accounts-list .msgraph-account', { hasText: 'testuser@example.com' });
        await expect(row.locator('.msgraph-reconnect-required')).toHaveText('Autorisierung abgelaufen – bitte neu verbinden.');
        await expect(row.locator('a.btn-reconnect-msgraph')).toHaveAttribute('href', '/api/msgraph/authorize');
        await expect(row.locator('.btn-sync-msgraph')).toHaveCount(0);

        // The link's target redirects to Microsoft with PKCE; the redirect is inspected, not followed.
        const start = await page.request.get('/api/msgraph/authorize', { maxRedirects: 0 });
        expect(start.status()).toBe(302);
        const location = new URL(start.headers()['location']);
        expect(`${location.origin}${location.pathname}`).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
        expect(location.searchParams.get('code_challenge_method')).toBe('S256');
        expect(location.searchParams.get('redirect_uri')).toBe(`${webServer.env.BASE_URL}/api/msgraph/callback`);
      } finally {
        await runSql('DELETE FROM msgraph_accounts WHERE id = ?', [accountId]);
      }
    });

    test('without a Microsoft app registration the modal explains that the integration is unavailable', async ({ page }) => {
      await page.route('**/api/msgraph/accounts', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, available: false, accounts: [] }),
      }));
      await page.goto('/');
      await openMSGraphModal(page);

      await expect(page.locator('#msgraph-unavailable')).toBeVisible();
      await expect(page.locator('#msgraph-unavailable')).toContainText('MSGRAPH_CLIENT_ID');
      await expect(page.locator('#btn-connect-msgraph')).toBeHidden();
    });

    test('the cross-site return from Microsoft reaches the session', async ({ page }) => {
      // page.route plays Microsoft's login page: it answers the authorize request by sending the browser
      // back to the callback, cross-site, as Microsoft does. The user declines, so no code is exchanged.
      await page.route('https://login.microsoftonline.com/**', route => {
        const state = new URL(route.request().url()).searchParams.get('state');
        return route.fulfill({
          status: 302,
          headers: { location: `${webServer.env.BASE_URL}/api/msgraph/callback?error=access_denied&state=${encodeURIComponent(state)}` },
        });
      });
      const unrouted = [];
      page.on('response', r => {
        if (/microsoftonline\.com|msauth\.net/.test(r.url()) && !r.request().redirectedFrom() && r.status() !== 302) unrouted.push(r.url());
      });
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      // page.route does not see requests that follow a redirect, so the redirect to Microsoft is read
      // (same browser session, not followed) and then navigated to directly, where the route answers it.
      const start = await page.request.get('/api/msgraph/authorize', { maxRedirects: 0 });
      expect(start.status()).toBe(302);
      await page.goto(start.headers()['location']);

      // Only with the session's own state does the callback reach this outcome; without it, it answers 400.
      await expect(page.locator('#toast-container .toast.error', { hasText: 'Verbindung mit Microsoft 365 fehlgeschlagen' })).toBeVisible({ timeout: 10000 });
      expect(unrouted, 'no page from Microsoft was loaded').toEqual([]);
    });

    test('returning from Microsoft reports the outcome once', async ({ page }) => {
      await page.goto('/?msgraph=connected');
      await expect(page.locator('#toast-container .toast.success', { hasText: 'Microsoft 365 Konto verbunden' })).toBeVisible({ timeout: 10000 });
      await expect(page).toHaveURL(url => !url.searchParams.has('msgraph'));

      await page.goto('/?msgraph=error');
      await expect(page.locator('#toast-container .toast.error', { hasText: 'Verbindung mit Microsoft 365 fehlgeschlagen' })).toBeVisible({ timeout: 10000 });
    });
  });

  // #402 (#358 part 4): what the markup and ARIA source greps of public/index.html were meant to protect.
  test.describe('Issue #402 — markup and ARIA behave as the app shell promises', () => {
    test.use({ serviceWorkers: 'block' });

    async function boot(page, url = '/') {
      await page.goto(url);
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-item').first()).toBeVisible({ timeout: 10000 });
    }

    // Re-enables the one-time welcome dialog; registered after the suite's init script, so it runs later.
    async function showWelcome(page) {
      await page.addInitScript(() => {
        if (window.origin !== 'null') window.localStorage.removeItem('welcome-popup-closed');
      });
    }

    async function expectNamedModal(page, name) {
      const dialog = page.getByRole('dialog', { name, exact: typeof name === 'string' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
    }

    // Every resource the document loaded: elements, imported stylesheets and @font-face sources.
    async function loadedUrls(page) {
      return page.evaluate(() => {
        const urls = Array.from(document.querySelectorAll('link[href], script[src], img[src], iframe[src]'))
          .map(el => el.href || el.src);
        for (const sheet of document.styleSheets) {
          if (sheet.href && new URL(sheet.href).origin !== location.origin) { urls.push(sheet.href); continue; }
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSImportRule) urls.push(new URL(rule.href, sheet.href || location.href).href);
            if (rule instanceof CSSFontFaceRule) {
              for (const m of rule.style.getPropertyValue('src').matchAll(/url\(\s*["']?([^"')]+)/g)) {
                urls.push(new URL(m[1], sheet.href || location.href).href);
              }
            }
          }
        }
        return urls;
      });
    }

    test('Issue #115 — app and booking page load nothing from another origin and fall back to system fonts', async ({ page, baseURL }) => {
      const origin = new URL(baseURL).origin;
      const foreignRequests = [];
      page.on('request', r => {
        const u = new URL(r.url());
        if (/^https?:$/.test(u.protocol) && u.origin !== origin) foreignRequests.push(r.url());
      });

      await boot(page);
      expect((await loadedUrls(page)).filter(u => new URL(u).origin !== origin)).toEqual([]);
      const fonts = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        return {
          ui: root.getPropertyValue('--font-ui'),
          mono: root.getPropertyValue('--font-mono'),
          body: getComputedStyle(document.body).fontFamily,
        };
      });
      expect(fonts.ui).toMatch(/system-ui|-apple-system/);
      expect(fonts.mono).toMatch(/\bmonospace\b/);
      expect(fonts.body).toMatch(/system-ui|-apple-system/);

      await page.goto('/public/booking/?slug=e2e-issue402-none');
      await expect(page.locator('body')).toBeVisible();
      expect((await loadedUrls(page)).filter(u => new URL(u).origin !== origin)).toEqual([]);
      expect(foreignRequests).toEqual([]);
    });

    test('Issue #124 — an uncaught error or rejection renders no debug overlay and no stack', async ({ page }) => {
      await boot(page);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.evaluate(() => {
        setTimeout(() => { throw new Error('E2E-124 <b>boom</b>'); }, 0);
        Promise.reject(new Error('E2E-124 rejected'));
      });
      await expect.poll(() => errors.some(m => m.includes('E2E-124 <b>boom</b>')), { timeout: 5000 }).toBe(true);

      expect(await page.evaluate(() => window.onerror)).toBeNull();
      const text = await page.locator('body').innerText();
      expect(text).not.toContain('E2E-124');
      expect(text).not.toContain('Laufzeitfehler');
      expect(text).not.toMatch(/\bat .+:\d+:\d+/); // no stack frame on screen
      await expect(page.locator('b', { hasText: 'boom' })).toHaveCount(0);
    });

    test('Issue #125 — one amber forward action: new event over new task, enter calendar over add account', async ({ page }) => {
      await showWelcome(page);
      await page.goto('/');
      await expect(page.locator('#welcome-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const accent = await tokenColor(page, '--accent');
      const look = sel => page.locator(sel).evaluate(el => {
        const s = getComputedStyle(el);
        return { color: s.color, border: s.borderTopColor };
      });

      expect(await look('#welcome-btn-close')).toEqual({ color: accent, border: accent });
      const addAccount = await look('#welcome-btn-add-account');
      expect(addAccount.color).not.toBe(accent);
      expect(addAccount.border).not.toBe(accent);
      await page.click('#welcome-btn-close');
      await expect(page.locator('#welcome-modal-backdrop')).toHaveClass(/hidden/);

      expect(await look('#new-event-btn')).toEqual({ color: accent, border: accent });
      const newTask = await look('#new-task-btn');
      expect(newTask.color).not.toBe(accent);
      expect(newTask.border).not.toBe(accent);
    });

    test('Issue #168 — the share search and the delegation list speak gender-neutral German', async ({ page }) => {
      await boot(page);
      await page.locator('#calendar-list .calendar-item').first().locator('[data-share-cal]').click();
      const dialog = page.locator('#share-cal-dialog-backdrop');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('#share-search-input')).not.toHaveAttribute('placeholder', /Benutzer/);
      await dialog.locator('#share-add-btn').click();
      await expect(page.locator('#toast-container .toast', { hasText: 'Bitte wähle eine/n Nutzer*in oder eine E-Mail-Adresse.' }))
        .toBeVisible();
      await expect(page.locator('#toast-container')).not.toContainText(/Benutzer/);

      await page.addScriptTag({ url: '/js/delegates.js' });
      const empty = await page.evaluate(() => {
        const el = document.createElement('div');
        window.DelegatesModule.renderDelegatesList([], el, () => {});
        return el.textContent.trim();
      });
      expect(empty).toBe('Keine Stellvertretung eingerichtet.');
    });

    test('Issue #184 — exactly the active view tab is selected and pressed, at boot and after each switch', async ({ page }) => {
      const views = ['month', 'week', 'workweek', 'day', 'agenda', 'kanban'];
      async function expectActive(active) {
        for (const v of views) {
          const tab = page.locator(`#view-${v}`);
          await expect(tab, `${v} while ${active} is active`).toHaveAttribute('aria-selected', String(v === active));
          await expect(tab, `${v} while ${active} is active`).toHaveAttribute('aria-pressed', String(v === active));
        }
      }
      await boot(page);
      await expectActive('month');
      for (const v of ['week', 'workweek', 'day', 'agenda', 'kanban', 'month']) {
        await page.click(`#view-${v}`);
        await expectActive(v);
      }
    });

    test('Issue #185 — controls are named and the password toggle says what it will do', async ({ page }) => {
      await boot(page);
      await expect(page.locator('#search-input')).toHaveAccessibleName('Kalender durchsuchen');

      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#ev-title')).toHaveAccessibleName('Titel des Termins');
      await openEventSection(page, 'recurrence');
      await page.selectOption('#ev-recurrence', 'MONTHLY');
      await expect(page.locator('#recur-monthly-week-idx')).toHaveAccessibleName('Woche des Monats');
      await expect(page.locator('#recur-monthly-weekday')).toHaveAccessibleName('Wochentag');
      await expect(page.locator('#recur-end-date')).toHaveAccessibleName('Enddatum der Wiederholung');
      await expect(page.locator('#recur-end-count')).toHaveAccessibleName('Anzahl Wiederholungen');
      await page.keyboard.press('Escape');
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);

      await page.click('#sidebar-settings-btn');
      await page.click('#settings-add-account-btn');
      await expect(page.locator('#account-modal-backdrop')).not.toHaveClass(/hidden/);
      const password = page.locator('#acc-password');
      const toggle = page.locator('#account-modal .toggle-password[data-target="acc-password"]');
      await expect(toggle).toHaveAccessibleName('Passwort anzeigen');
      await expect(password).toHaveAttribute('type', 'password');
      await toggle.click();
      await expect(password).toHaveAttribute('type', 'text');
      await expect(toggle).toHaveAccessibleName('Passwort verbergen');
      await toggle.click();
      await expect(password).toHaveAttribute('type', 'password');
      await expect(toggle).toHaveAccessibleName('Passwort anzeigen');
    });

    test('Issue #186 — the welcome dialog is announced by its title', async ({ page }) => {
      await showWelcome(page);
      await page.goto('/');
      await expect(page.locator('#welcome-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expectNamedModal(page, 'Willkommen beim WebCalendar');
      await page.click('#welcome-btn-close');
    });

    test('Issue #186 — scope, Microsoft 365, calendar and import dialogs are announced by their titles', async ({ page }) => {
      await boot(page);
      await page.evaluate(async () => {
        // Not awaited: it resolves only once the user picks a scope.
        (await import('/js/eventModal.js')).chooseRecurrenceScope('E2E 186?');
      });
      await expectNamedModal(page, 'Wiederkehrender Termin');
      await page.click('#scope-cancel-btn');
      await expect(page.locator('#scope-dialog-backdrop')).toHaveClass(/hidden/);

      await page.click('#sidebar-settings-btn');
      await page.click('#settings-add-account-btn');
      await page.click('#btn-link-msgraph');
      await expectNamedModal(page, 'Microsoft Office 365 / Outlook Sync');

      await boot(page);
      await page.locator('#calendar-list [data-edit-cal]').first().click();
      await expectNamedModal(page, 'Kalender bearbeiten');

      await boot(page);
      const calName = (await page.locator('#calendar-list .calendar-item').first().locator('.calendar-name').textContent()).trim();
      await page.locator('#calendar-list .calendar-item').first().locator('[data-share-cal]').click();
      await expectNamedModal(page, `Freigabe & Sharing: ${calName}`);

      await boot(page);
      await page.click('#add-calendar-btn');
      await expectNamedModal(page, 'Neuer Kalender');

      await boot(page);
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e2e-402-import\r\nDTSTART;VALUE=DATE:20370514\r\nSUMMARY:E2E 402\r\nEND:VEVENT\r\nEND:VCALENDAR'],
          'drop.ics', { type: 'text/calendar' }));
        document.querySelector('.sidebar').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      });
      await expectNamedModal(page, 'ICS importieren');
    });

    test('Issue #266 — opening the event popover announces its details', async ({ page }) => {
      const title = 'E2E 266 Termin';
      await page.route('**/api/events?**', route => route.fulfill({
        json: {
          events: [{
            uid: 'e2e-402-popover', title, calendarId: `internal-caldav::/${E2E_USER}/personal/`,
            start: '2037-05-14T09:00:00+02:00', end: '2037-05-14T10:00:00+02:00', allDay: false,
          }],
          errors: [],
        },
      }));
      await boot(page, '/?date=2037-05-14');
      const chip = page.locator('.event-chip').filter({ hasText: title }).first();
      await expect(chip).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#status-bar')).toHaveText(/Termin/, { timeout: 10000 });
      // Record every text the live region carries; a later announcement would overwrite it.
      await page.evaluate(() => {
        window.__announced266 = [];
        const region = document.getElementById('aria-announcer');
        new MutationObserver(() => {
          if (region.textContent) window.__announced266.push(region.textContent);
        }).observe(region, { childList: true, characterData: true, subtree: true });
      });
      await chip.click();
      await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.__announced266), { timeout: 5000 })
        .toContain(`Termindetails: ${title}`);
    });

    test('Issue #26 — the linked manifest describes an installable standalone app', async ({ page, request }) => {
      await boot(page);
      const href = await page.locator('link[rel="manifest"]').evaluate(l => l.href);
      const res = await request.get(href);
      expect(res.status()).toBe(200);
      const manifest = await res.json();
      expect(manifest).toMatchObject({
        name: 'FreeShard WebCalendar', short_name: 'WebCalendar', display: 'standalone', start_url: '/',
      });
      expect(manifest.theme_color).toBe(await page.locator('meta[name="theme-color"]').getAttribute('content'));
      expect(manifest.background_color).toBeTruthy();
      expect(manifest.icons.length).toBeGreaterThan(0);
    });

    test('Issue #26 — going offline shows the banner and the loaded calendars are still listed', async ({ page, context }) => {
      await boot(page);
      const banner = page.locator('#offline-status-banner');
      await expect(banner).toBeHidden();
      const calId = await page.locator('#calendar-list .calendar-item').first().getAttribute('data-cal-id');

      await context.setOffline(true);
      try {
        await expect(banner).toBeVisible();
        expect(await page.evaluate(() => window.OfflineCache.isOffline())).toBe(true);
        // The request fails, so the list comes from what the boot cached, in the shape the app reads.
        const offline = await page.evaluate(async () => (await import('/js/api.js')).CalendarsAPI.list());
        expect(offline.errors).toEqual([]);
        expect(offline.calendars.map(c => c.id)).toContain(calId);
      } finally {
        await context.setOffline(false);
      }
      await expect(banner).toBeHidden();
    });

    test('Issue #26 — the service worker precaches a shell that exists, drops stale caches and answers API calls offline', async ({ request, baseURL }) => {
      const vm = require('vm');
      const res = await request.get('/sw.js');
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toMatch(/javascript/);

      // The worker runs against stand-ins for its global scope, with the network down.
      const listeners = {};
      const stores = new Map([['webcalendar-v0-e2e-stale', new Map()]]);
      const precached = [];
      const caches = {
        open: async name => {
          if (!stores.has(name)) stores.set(name, new Map());
          return {
            addAll: async urls => { precached.push(...urls); },
            put: async () => {},
          };
        },
        keys: async () => [...stores.keys()],
        delete: async name => stores.delete(name),
        match: async () => undefined,
      };
      const self = {
        addEventListener: (type, fn) => { listeners[type] = fn; },
        skipWaiting: async () => {},
        clients: { claim: async () => {} },
      };
      const fetch = async () => { throw new TypeError('Failed to fetch'); };
      vm.runInNewContext(await res.text(), { self, caches, fetch, URL, Response, console });
      const dispatch = (type, extra = {}) => {
        let pending;
        listeners[type]({ ...extra, waitUntil: p => { pending = p; }, respondWith: p => { pending = p; } });
        return pending;
      };

      await dispatch('install');
      expect(precached).toEqual(expect.arrayContaining(['/', '/manifest.json', '/js/offlineCache.js', '/js/app.js']));
      for (const url of precached) {
        expect((await request.get(url)).status(), url).toBe(200);
      }

      await dispatch('activate');
      expect([...stores.keys()]).toHaveLength(1);
      expect([...stores.keys()][0]).not.toBe('webcalendar-v0-e2e-stale');

      const offline = await dispatch('fetch', { request: { method: 'GET', url: `${baseURL}/api/events` } });
      expect(offline.status).toBe(503);
      expect(await offline.json()).toEqual({ error: 'Offline mode active', offline: true });
    });
  });


  // Must stay the last spec: it adds a second calendar, and Radicale refuses to delete a
  // collection during the run (DELETE 403), while earlier specs expect exactly one calendar.
  // global-teardown.js removes the run's whole principal, this calendar included.
  test('Issue #345 — a booking page hides slots taken by events in the ticked calendars and a booking appears in the calendar', async ({ page }) => {
    const date = mondayWeeksAhead(5); // bookings are open for one year ahead only
    const range = `start=${date}T00:00:00Z&end=${date}T23:59:59Z`;
    const slot = (hhmm) => page.locator(`.slot-btn[data-time="${date}T${hhmm}:00.000Z"]`);
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });

    await page.click('#availability-btn');
    await expect(page.locator('#availability-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#ap-calendar option')).not.toHaveCount(0, { timeout: 10000 });
    const calendarId = await page.locator('#ap-calendar').inputValue();
    await page.click('#availability-modal-close');

    // A second calendar whose events only count when the owner ticks it.
    const createdCal = await page.request.post('/api/calendars', {
      headers: SAME_ORIGIN,
      data: { accountId: calendarId.split('::')[0], name: 'E2E 345 Work', type: 'calendar' }
    });
    expect(createdCal.status()).toBe(201);
    const workId = (await createdCal.json()).id;

    const slug = `e2e-345-${Date.now()}`;
    try {
      for (const [calId, title, start, end] of [
        [calendarId, 'E2E 345 Target Meeting', '10:00', '11:00'],
        [workId, 'E2E 345 Work Meeting', '11:00', '12:00']
      ]) {
        const ev = await page.request.post('/api/events', {
          headers: SAME_ORIGIN,
          data: { calendarId: calId, title, start: `${date}T${start}:00.000Z`, end: `${date}T${end}:00.000Z` }
        });
        expect(ev.status()).toBe(201);
      }

      // The dialog lists the calendars whose events block slots; the target always counts.
      await page.click('#availability-btn');
      await expect(page.locator('#availability-modal-backdrop')).not.toHaveClass(/hidden/);
      const targetBox = page.locator(`#ap-busy-calendars input[type="checkbox"][value="${calendarId}"]`);
      const workBox = page.locator(`#ap-busy-calendars input[type="checkbox"][value="${workId}"]`);
      await expect(workBox).toBeAttached({ timeout: 10000 });
      await page.selectOption('#ap-calendar', calendarId);
      await expect(targetBox).toBeChecked();
      await expect(targetBox).toBeDisabled();
      await expect(workBox).not.toBeChecked();
      await expect(workBox).toBeEnabled();
      // Switching the target moves the locked box along.
      await page.selectOption('#ap-calendar', workId);
      await expect(workBox).toBeDisabled();
      await expect(workBox).toBeChecked();
      await expect(targetBox).toBeEnabled();
      await page.selectOption('#ap-calendar', calendarId);
      await expect(targetBox).toBeDisabled();
      await expect(workBox).toBeEnabled();
      await workBox.check();

      await page.fill('#ap-title', 'E2E 345 Busy Page');
      await page.fill('#ap-slug', slug);
      const savePromise = page.waitForResponse(resp => resp.url().includes('/api/availability-slots') && resp.request().method() === 'POST');
      await page.click('#ap-save-btn');
      expect((await savePromise).status()).toBe(201);
      const card = page.locator(`.availability-page-card:has-text("${slug}")`);
      await expect(card).toBeVisible({ timeout: 10000 });
      await expect(card.locator('.availability-page-busy')).toContainText('Persönlich');
      await expect(card.locator('.availability-page-busy')).toContainText('E2E 345 Work');

      await page.goto(`/public/booking/?slug=${slug}`);
      await expect(page.locator('#page-title')).toHaveText('E2E 345 Busy Page', { timeout: 10000 });
      await page.fill('#booking-date', date);
      await page.locator('#booking-date').dispatchEvent('change');
      await expect(slot('09:00')).toBeVisible({ timeout: 10000 });
      for (const taken of ['10:00', '10:30', '11:00', '11:30']) await expect(slot(taken)).toHaveCount(0);
      await expect(slot('12:00')).toBeVisible();

      await slot('09:00').click();
      await page.fill('#guest-name', 'Test Guest');
      await page.fill('#guest-email', 'testuser@example.com');
      await page.click('#confirm-booking-btn');
      await expect(page.locator('#booking-success')).not.toHaveClass(/hidden/, { timeout: 10000 });

      // The booked slot is gone for the next visitor.
      await page.reload();
      await page.fill('#booking-date', date);
      await page.locator('#booking-date').dispatchEvent('change');
      await expect(slot('12:00')).toBeVisible({ timeout: 10000 });
      await expect(slot('09:00')).toHaveCount(0);

      // The owner sees the booking in their calendar.
      await page.goto(`/?date=${date}`);
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.getByText('E2E 345 Busy Page: Test Guest').first()).toBeVisible({ timeout: 10000 });
    } finally {
      const list = await page.request.get(`/api/events?${range}&calendarId=${encodeURIComponent(calendarId)}`);
      expect(list.ok()).toBeTruthy();
      for (const ev of (await list.json()).events.filter(e => e.title.startsWith('E2E 345'))) {
        const del = await page.request.delete(`/api/events/${encodeURIComponent(ev.uid)}`, {
          headers: SAME_ORIGIN,
          data: { calendarId, href: ev.href, etag: ev.etag }
        });
        expect(del.ok()).toBeTruthy();
      }
    }
  });

  test.describe('Issue #110 — stylesheet and markup agree', () => {
    test('a warning toast carries its own glyph and the warning border colour', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.locator('#calendar-list .calendar-item').first().locator('[data-share-cal]').click();
      await expect(page.locator('#share-cal-dialog-backdrop')).toBeVisible();

      // Adding a share with nothing entered is the share flow's warning.
      await page.click('#share-add-btn');
      const toast = page.locator('#toast-container .toast.warning');
      await expect(toast).toBeVisible();
      // The warning triangle, not the info circle (#114: inline SVG, hidden from assistive technology).
      await expect(toast.locator('svg.toast-icon[aria-hidden="true"] path[d^="M10.29 3.86"]')).toHaveCount(1);
      await expect(toast.locator('.toast-icon circle')).toHaveCount(0);
      const border = await toast.evaluate(el => {
        const s = getComputedStyle(el);
        return { width: s.borderLeftWidth, color: s.borderLeftColor };
      });
      expect(border).toEqual({ width: '3px', color: await tokenColor(page, '--warning') });

      // The user-search suggestions sit over the dialog's content on an opaque surface.
      await page.locator('#share-search-input').fill('testuser');
      const dropdown = page.locator('#share-autocomplete-dropdown');
      await expect(dropdown).not.toHaveClass(/hidden/, { timeout: 10000 });
      expect(await dropdown.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await tokenColor(page, '--surface'));
    });

    test('an attendee\'s participation status renders as a muted pill', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#new-event-btn');
      await openEventSection(page, 'attendees');
      await page.fill('#ev-attendee-name', 'Test User');
      await page.fill('#ev-attendee-email', 'testuser@example.com');
      await page.click('#add-attendee-btn');

      const status = page.locator('#ev-attendee-list .attendee-status').first();
      await expect(status).toHaveText('Ausstehend');
      const style = await status.evaluate(el => {
        const s = getComputedStyle(el);
        return { color: s.color, paddingLeft: s.paddingLeft, borderRadius: s.borderTopLeftRadius };
      });
      expect(style.color).toBe(await tokenColor(page, '--ink-muted'));
      expect(parseFloat(style.paddingLeft)).toBeGreaterThan(0);
      expect(parseFloat(style.borderRadius)).toBeGreaterThan(0);
    });

    test('empty lists use the muted empty-state text', async ({ page }) => {
      await page.route('**/api/msgraph/accounts', route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, available: true, accounts: [] }),
      }));
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#sidebar-settings-btn');
      await page.click('#settings-add-account-btn');
      await page.click('#btn-link-msgraph');
      await expect(page.locator('#msgraph-modal-backdrop')).not.toHaveClass(/hidden/);

      const empty = page.locator('#msgraph-accounts-list .empty-state');
      await expect(empty).toHaveText('Keine Office 365 Konten verbunden.');
      expect(await empty.evaluate(el => getComputedStyle(el).color)).toBe(await tokenColor(page, '--ink-muted'));
    });

    test('the welcome dialog\'s calendar glyph is drawn in the accent line colour', async ({ page }) => {
      // Registered after the suite's init script, so it runs later and re-enables the welcome dialog.
      await page.addInitScript(() => {
        if (window.origin !== 'null') window.localStorage.removeItem('welcome-popup-closed');
      });
      await page.goto('/');
      await expect(page.locator('#welcome-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const glyph = page.locator('#welcome-modal .modal-body svg').first();
      expect(await glyph.evaluate(el => getComputedStyle(el).stroke)).toBe(await tokenColor(page, '--line'));
      await page.click('#welcome-btn-close');
    });
  });

  // Issue #111: the task, RSVP and share badges are small bold text (10–11 px), so WCAG's 4.5:1 floor
  // applies, measured against what is really painted behind them — the card they sit in, at rest and
  // under the pointer, in both themes. Kanban cards show elevation by border and tone, never by lift.
  test.describe('Issue #111 — badges meet the contrast floor and kanban cards stay flat', () => {
    // The markup tasks.js, invitations.js and app.js render for each badge, inside its real container.
    const BADGE_MARKUP = `
      <div class="kanban-card" id="e2e111-card"><div class="kanban-card-meta">
        <span class="kanban-due-date">15.10.</span>
        <span class="kanban-prio prio-high">Hoch</span>
        <span class="kanban-prio prio-med">Mittel</span>
        <span class="kanban-prio prio-low">Niedrig</span>
        <span class="kanban-recurrence-badge">Wöchentlich</span>
      </div></div>
      <div class="invitation-card"><div class="invitation-attendees"><div class="inv-attendee-row">
        <span class="status-badge status-accepted">Zugesagt</span>
        <span class="status-badge status-declined">Abgesagt</span>
        <span class="status-badge status-tentative">Vorläufig</span>
        <span class="status-badge status-pending">Offen</span>
        <span class="status-badge">Offen</span>
      </div></div></div>
      <div class="share-user-item"><div class="share-user-actions">
        <span class="share-badge accepted">aktiv</span>
        <span class="share-badge pending">ausstehend</span>
        <span class="share-badge declined">abgelehnt</span>
      </div></div>`;

    // Paints each badge's backdrop (every ancestor background, composited bottom-up) and its text
    // colour onto a canvas, so the browser itself resolves color-mix(), alpha and the theme tokens.
    function measureBadges() {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      const paint = (colors) => {
        ctx.clearRect(0, 0, 1, 1);
        for (const c of colors) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); }
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
      };
      const lum = rgb => {
        const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const root = document.getElementById('e2e111-root');
      return Array.from(root.querySelectorAll('[class*="badge"], .kanban-due-date, .kanban-prio')).map(el => {
        const layers = [];
        for (let n = el; n; n = n.parentElement) layers.unshift(getComputedStyle(n).backgroundColor);
        const bg = paint(layers);
        const fg = paint([...layers, getComputedStyle(el).color]);
        const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        return {
          badge: el.className,
          fontSize: parseFloat(getComputedStyle(el).fontSize),
          ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
        };
      });
    }

    for (const theme of ['light', 'dark']) {
      test(`${theme} theme: every badge reaches 4.5:1 on its card, at rest and on hover`, async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
        await page.evaluate(({ theme, markup }) => {
          document.documentElement.setAttribute('data-theme', theme);
          const root = document.createElement('div');
          root.id = 'e2e111-root';
          root.style.cssText = 'position:fixed;top:0;left:0;z-index:100000;width:420px;';
          root.innerHTML = markup;
          document.body.appendChild(root);
        }, { theme, markup: BADGE_MARKUP });

        const atRest = await page.evaluate(measureBadges);
        expect(atRest).toHaveLength(13);
        for (const b of atRest) expect(b.fontSize).toBeLessThan(14); // below the large-text exemption
        expect(atRest.filter(b => b.ratio < 4.5)).toEqual([]);

        await page.hover('#e2e111-card');
        const hovered = await page.evaluate(measureBadges);
        expect(hovered.filter(b => b.ratio < 4.5)).toEqual([]);
      });
    }

    test('a hovered kanban card neither lifts nor casts a shadow', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.evaluate(markup => {
        const root = document.createElement('div');
        root.id = 'e2e111-root';
        root.style.cssText = 'position:fixed;top:0;left:0;z-index:100000;width:420px;';
        root.innerHTML = markup;
        document.body.appendChild(root);
      }, BADGE_MARKUP);
      const card = page.locator('#e2e111-card');
      const flat = el => { const s = getComputedStyle(el); return { shadow: s.boxShadow, transform: s.transform }; };
      expect(await card.evaluate(flat)).toEqual({ shadow: 'none', transform: 'none' });
      await card.hover();
      expect(await card.evaluate(flat)).toEqual({ shadow: 'none', transform: 'none' });
    });

    test('the key badges in the shortcut help are flat', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.keyboard.press('Alt+KeyH');
      await expect(page.locator('#shortcuts-modal-backdrop')).not.toHaveClass(/hidden/);
      const badges = page.locator('#shortcuts-modal .shortcut-badge');
      await expect(badges.first()).toBeVisible();
      const shadows = await badges.evaluateAll(els => els.map(el => getComputedStyle(el).boxShadow));
      expect(shadows.length).toBeGreaterThan(5);
      expect(shadows.filter(s => s !== 'none')).toEqual([]);
    });
  });

  // Issue #112: event text in month chips and week/day blocks, and the day numbers of adjacent-month
  // cells, are 10–13 px text, so WCAG's 4.5:1 floor applies whatever colour the user picked for the
  // calendar. Measured against what is really painted: every ancestor background and every group
  // opacity on the way down, in both themes, at rest and under the pointer.
  test.describe('Issue #112 — event text and adjacent-month day numbers meet the contrast floor', () => {
    // The issue's table (token teal, add-dialog default, code fallback, Google red/green/yellow)
    // plus the extremes an unconstrained <input type="color"> or a CalDAV calendar-color allows.
    const COLOURS = ['#007080', '#7c3aed', '#6366f1', '#ea4335', '#34a853', '#fbbc05',
      '#ffffff', '#000000', '#ffff00', '#e0e0e0'];

    // Composites the element's text over its backdrop the way the browser paints a single pixel:
    // each ancestor's background over what lies beneath, each ancestor's opacity as a group alpha.
    function measureText(selector) {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      const rgba = c => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      };
      const over = (top, below) => [0, 1, 2].map(i => top[i] * top[3] + below[i] * (1 - top[3]));
      const lum = rgb => {
        const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const paint = (chain, withText) => {
        const go = (i, backdrop) => {
          const s = getComputedStyle(chain[i]);
          let px = over(rgba(s.backgroundColor), backdrop);
          px = i < chain.length - 1 ? go(i + 1, px) : (withText ? over(rgba(s.color), px) : px);
          const o = parseFloat(s.opacity);
          return [0, 1, 2].map(k => px[k] * o + backdrop[k] * (1 - o));
        };
        return go(0, [255, 255, 255]);
      };
      return Array.from(document.querySelectorAll(selector)).map(el => {
        const chain = [];
        for (let n = el; n; n = n.parentElement) chain.unshift(n);
        const [hi, lo] = [lum(paint(chain, true)), lum(paint(chain, false))].sort((a, b) => b - a);
        return {
          el: `${el.className} in ${el.closest('[data-event-uid], .month-day')?.className}`,
          text: el.textContent.trim(),
          fontSize: parseFloat(getComputedStyle(el).fontSize),
          ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
        };
      });
    }

    for (const theme of ['light', 'dark']) {
      test(`${theme} theme: month chips, week blocks and adjacent-month days reach 4.5:1 for any calendar colour`, async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
        // #app is shown before boot loads calendars and events; a late store.set({ calendars })
        // would drop the calendars registered below, so wait until boot has gone quiet.
        await page.waitForLoadState('networkidle');
        const uids = await page.evaluate(async ({ theme, colours }) => {
          document.documentElement.setAttribute('data-theme', theme);
          // Hover states are measured in their end state, not mid-transition.
          const still = document.createElement('style');
          still.textContent = '[id^="e2e112-"] * { transition: none !important; }';
          document.head.appendChild(still);
          const { store } = await import('/js/store.js');
          const { renderView } = await import('/js/calendar.js');
          // Registered in place so the app does not react to them (no fetch, no re-render).
          store.get('calendars').push(...colours.map((color, i) => ({ id: `e2e112-cal-${i}`, name: `E2E 112 ${i}`, color })));
          const day = new Date(2026, 2, 11);
          const events = colours.map((color, i) => ({
            uid: `e2e112-ev-${i}`,
            calendarId: `e2e112-cal-${i}`,
            title: `E2E 112 ${color}`,
            location: 'Testraum',
            allDay: false,
            start: new Date(2026, 2, 11, 8 + i).toISOString(),
            end: new Date(2026, 2, 11, 9 + i).toISOString(),
          }));
          const noop = new Proxy({}, { get: () => () => {} });
          for (const view of ['month', 'week']) {
            const host = document.createElement('div');
            host.id = `e2e112-${view}`;
            host.style.cssText = 'position:fixed;inset:0;z-index:100000;overflow:auto;background:var(--bg);display:flex;flex-direction:column;';
            document.body.appendChild(host);
            renderView(host, events, view, day, noop);
            if (view === 'month') host.style.display = 'none';
          }
          return events.map(e => e.uid);
        }, { theme, colours: COLOURS });

        // Week/day blocks first (the month host is hidden while they are measured), then the month grid.
        const WEEK = '#e2e112-week .event-block-title, #e2e112-week .event-block-time, #e2e112-week .event-block-loc';
        const weekAtRest = await page.evaluate(measureText, WEEK);
        expect(weekAtRest).toHaveLength(COLOURS.length * 3);
        for (const t of weekAtRest) expect(t.fontSize).toBeLessThan(14); // below the large-text exemption
        expect(weekAtRest.filter(t => t.ratio < 4.5)).toEqual([]);
        for (const uid of uids) {
          await page.hover(`#e2e112-week [data-event-uid="${uid}"]`);
          const hovered = await page.evaluate(measureText, `#e2e112-week [data-event-uid="${uid}"] *:not(svg, svg *)`);
          expect(hovered.filter(t => t.text && t.ratio < 4.5)).toEqual([]);
        }

        // The calendar colour stays visible as the 4 px left edge, as in the agenda view.
        const rail = sel => page.evaluate(sel => Array.from(document.querySelectorAll(sel)).map(el => {
          const s = getComputedStyle(el);
          const ctx = document.createElement('canvas').getContext('2d');
          ctx.fillStyle = s.borderLeftColor;
          return `${s.borderLeftWidth} ${s.borderLeftStyle} ${ctx.fillStyle}`;
        }), sel);
        expect(await rail('#e2e112-week .event-block')).toEqual(COLOURS.map(c => `4px solid ${c}`));

        await page.evaluate(() => {
          document.getElementById('e2e112-week').remove();
          document.getElementById('e2e112-month').style.display = 'flex';
        });
        const MONTH = '#e2e112-month .event-chip-title, #e2e112-month .event-chip-time';
        const chipsAtRest = await page.evaluate(measureText, MONTH);
        expect(chipsAtRest).toHaveLength(COLOURS.length * 2);
        for (const t of chipsAtRest) expect(t.fontSize).toBeLessThan(14);
        expect(chipsAtRest.filter(t => t.ratio < 4.5)).toEqual([]);
        for (const uid of uids) {
          await page.hover(`#e2e112-month [data-event-uid="${uid}"]`);
          const hovered = await page.evaluate(measureText, `#e2e112-month [data-event-uid="${uid}"] .event-chip-title, #e2e112-month [data-event-uid="${uid}"] .event-chip-time`);
          expect(hovered.filter(t => t.ratio < 4.5)).toEqual([]);
        }

        expect(await rail('#e2e112-month .event-chip')).toEqual(COLOURS.map(c => `4px solid ${c}`));

        const adjacent = await page.evaluate(measureText, '#e2e112-month .month-day.other-month .month-day-num');
        expect(adjacent.length).toBeGreaterThan(0);
        expect(adjacent.filter(t => t.ratio < 4.5)).toEqual([]);
        await page.hover('#e2e112-month .month-day.other-month >> nth=0');
        const adjacentHovered = await page.evaluate(measureText, '#e2e112-month .month-day.other-month .month-day-num');
        expect(adjacentHovered.filter(t => t.ratio < 4.5)).toEqual([]);
      });
    }
  });

  test.describe('Issue #114 — interaction conventions: app confirm dialog, no emoji, labelled icons', () => {
    async function firstCalendarId(page) {
      await page.click('#new-event-btn');
      await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
      const calendarId = await page.locator('#ev-calendar option:not([value=""])').first().getAttribute('value');
      await page.keyboard.press('Escape');
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
      return calendarId;
    }

    // Every native browser dialog is recorded and dismissed, so a native confirm() cannot decide anything unseen.
    function recordNativeDialogs(page) {
      const native = [];
      page.on('dialog', dialog => { native.push(dialog.message()); return dialog.dismiss(); });
      return native;
    }

    // Decorative SVG is hidden from assistive technology; icon-only buttons carry an aria-label.
    function unlabelledIcons() {
      const svgs = Array.from(document.querySelectorAll('svg'))
        .filter(svg => svg.getAttribute('aria-hidden') !== 'true' && !(svg.getAttribute('role') === 'img' && svg.getAttribute('aria-label')))
        .map(svg => (svg.closest('[id]') || {}).id || svg.outerHTML.slice(0, 80));
      const buttons = Array.from(document.querySelectorAll('button'))
        .filter(b => b.textContent.trim() === '' && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby'))
        .map(b => b.id || b.className);
      return { svgs, buttons };
    }

    test('deleting an event asks in the app dialog naming it, and Abbrechen keeps it', async ({ page }) => {
      const native = recordNativeDialogs(page);
      await page.goto('/?date=2036-05-14');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const calendarId = await firstCalendarId(page);
      const title = `E2E Issue114 Event ${Date.now()}`;
      const created = await page.request.post('/api/events', {
        headers: SAME_ORIGIN,
        data: { calendarId, title, start: '2036-05-14T10:00:00.000Z', end: '2036-05-14T11:00:00.000Z' }
      });
      expect(created.status()).toBe(201);
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      const chip = page.locator('.event-chip').filter({ hasText: title }).first();
      await expect(chip).toBeVisible({ timeout: 15000 });
      await chip.click();
      await page.click('#popover-delete-btn');
      await expect(page.locator('#confirm-dialog-backdrop')).toBeVisible();
      await expect(page.locator('#confirm-dialog-text')).toContainText(title);
      await page.click('#confirm-dialog-cancel');
      await expect(page.locator('#confirm-dialog-backdrop')).toBeHidden();
      await expect(chip).toBeVisible();

      await chip.click();
      await page.click('#popover-delete-btn');
      await expect(page.locator('#confirm-dialog-backdrop')).toBeVisible();
      await page.click('#confirm-dialog-ok');
      await expect(chip).not.toBeVisible({ timeout: 10000 });
      expect(native).toEqual([]);
    });

    test('deleting a kanban task asks in the app dialog naming the task; buttons and icons are labelled', async ({ page }) => {
      const native = recordNativeDialogs(page);
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      // #500: tasks go into the default Aufgabenliste.
      const calendarId = `internal-caldav::/${E2E_USER}/tasks/`;
      await expectOwnCalendar(page, calendarId);
      const title = `E2E Issue114 Task ${Date.now()}`;
      const created = await page.request.post('/api/tasks', { headers: SAME_ORIGIN, data: { calendarId, title } });
      expect(created.status()).toBe(201);
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-item').first()).toBeVisible({ timeout: 10000 });

      expect(await page.evaluate(unlabelledIcons)).toEqual({ svgs: [], buttons: [] });
      await page.click('#sidebar-settings-btn');
      await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
      await expect(page.locator('#settings-account-list .settings-item').first()).toBeVisible({ timeout: 10000 });
      expect(await page.evaluate(unlabelledIcons)).toEqual({ svgs: [], buttons: [] });
      await page.keyboard.press('Escape');

      await page.click('#view-kanban');
      const card = page.locator('.kanban-card', { hasText: title });
      await expect(card).toBeVisible({ timeout: 10000 });
      expect(await page.evaluate(unlabelledIcons)).toEqual({ svgs: [], buttons: [] });

      await card.locator('.btn-delete').click();
      await expect(page.locator('#confirm-dialog-backdrop')).toBeVisible();
      await expect(page.locator('#confirm-dialog-text')).toContainText(title);
      await page.click('#confirm-dialog-ok');
      await expect(card).not.toBeVisible({ timeout: 10000 });
      expect(native).toEqual([]);
    });

    test('a due reminder toast and desktop notification carry no emoji', async ({ page }) => {
      await page.addInitScript(() => {
        window.desktopNotifications = [];
        window.Notification = class {
          constructor(title, options) { window.desktopNotifications.push({ title, body: options.body }); }
          static permission = 'granted';
          static requestPermission() { return Promise.resolve('granted'); }
        };
      });
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const calendarId = await firstCalendarId(page);
      const now = Date.now();
      const title = `E2E Issue114 Reminder ${now}`;
      const created = await page.request.post('/api/events', {
        headers: SAME_ORIGIN,
        data: {
          calendarId, title, location: 'Room B',
          start: new Date(now - 60 * 1000).toISOString(),
          end: new Date(now + 30 * 60 * 1000).toISOString(),
          alarms: [{ action: 'DISPLAY', trigger: 'PT0S', description: 'Reminder' }]
        }
      });
      expect(created.status()).toBe(201);
      const ev = await created.json();
      try {
        await page.reload();
        await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
        await page.evaluate(() => window.__checkAndTriggerAlarms && window.__checkAndTriggerAlarms());
        const toast = page.locator('#toast-container .toast', { hasText: title });
        await expect(toast).toBeVisible({ timeout: 10000 });
        await expect(toast).toContainText('Ort: Room B');
        expect(await toast.textContent()).not.toMatch(/\p{Extended_Pictographic}/u);
        const notif = (await page.evaluate(() => window.desktopNotifications)).find(n => n.title.includes(title));
        expect(notif).toBeTruthy();
        expect(`${notif.title} ${notif.body}`).not.toMatch(/\p{Extended_Pictographic}/u);
      } finally {
        const del = await page.request.delete(`/api/events/${encodeURIComponent(ev.uid)}`, {
          headers: SAME_ORIGIN,
          data: { calendarId, href: ev.href, etag: ev.etag }
        });
        expect(del.ok()).toBeTruthy();
      }
    });
  });

  test.describe('Issue #189 — the exposed heading outline is a tree', () => {
    // Headings as Chromium's accessibility tree exposes them, in document order.
    async function exposedHeadings(page) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Accessibility.enable');
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      await cdp.detach();
      return nodes
        .filter(n => !n.ignored && n.role && n.role.value === 'heading')
        .map(n => ({
          level: (n.properties || []).find(p => p.name === 'level').value.value,
          name: n.name ? n.name.value : '',
        }));
    }

    function expectTree(headings) {
      expect(headings[0].level).toBe(1);
      for (let i = 1; i < headings.length; i++) {
        expect(headings[i].level, `${headings[i - 1].name} -> ${headings[i].name}`)
          .toBeLessThanOrEqual(headings[i - 1].level + 1);
      }
    }

    test('resting view exposes the h1 and then the toolbar title as h2', async ({ page }) => {
      await page.goto('/?date=2037-05-14');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#toolbar-title')).toHaveText('Mai 2037');
      expect(await exposedHeadings(page)).toEqual([
        { level: 1, name: 'FreeShard Calendar' },
        { level: 2, name: 'Mai 2037' },
      ]);
    });

    test('the open settings drawer nests under the h1 without skipping levels', async ({ page }) => {
      await page.goto('/?date=2037-05-14');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#sidebar-settings-btn');
      await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
      const headings = await exposedHeadings(page);
      expect(headings.find(h => h.name === 'Einstellungen').level).toBe(2);
      expect(headings.find(h => h.name === 'Mai 2037').level).toBe(2);
      expectTree(headings);
    });
  });

  test.describe('Issue #187 — loading and date changes reach the screen reader', () => {
    // page.route needs the service worker off.
    test.use({ serviceWorkers: 'block' });

    test('the boot splash is a status region that says the calendar is loading', async ({ page }) => {
      let releaseAccounts;
      const accountsHeld = new Promise(resolve => { releaseAccounts = resolve; });
      await page.route('**/api/accounts', async route => {
        if (route.request().method() !== 'GET') return route.continue();
        await accountsHeld;
        return route.continue();
      });
      await page.goto('/');
      const splash = page.getByRole('status').filter({ hasText: 'Kalender wird geladen…' });
      await expect(splash).toBeVisible({ timeout: 10000 });
      await expect(splash).toHaveId('loading-screen');
      releaseAccounts();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#loading-screen')).toBeHidden();
    });

    test('picking a day in the mini calendar announces that date', async ({ page }) => {
      await page.goto('/?date=2029-03-04');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#status-bar')).toHaveText(/Termin/, { timeout: 10000 });
      // Record every text the live region carries; later announcements (the event count) overwrite it.
      await page.evaluate(() => {
        window.__announced187 = [];
        const region = document.getElementById('aria-announcer');
        new MutationObserver(() => {
          if (region.textContent) window.__announced187.push(region.textContent);
        }).observe(region, { childList: true, characterData: true, subtree: true });
      });

      await page.locator('#mini-calendar [data-mini-day]', { hasText: /^20$/ }).click();
      await expect(page.locator('#mini-calendar .mini-cal-day.selected')).toHaveText('20');
      await expect.poll(() => page.evaluate(() => window.__announced187), { timeout: 5000 })
        .toContain('Datum: Dienstag, 20. März 2029');

      await page.locator('#mini-calendar [data-mini-day]', { hasText: /^7$/ }).focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => window.__announced187), { timeout: 5000 })
        .toContain('Datum: Mittwoch, 7. März 2029');
    });
  });

  test.describe('Issue #163 — errors are announced and a failed delete stays on screen', () => {
    // page.route needs the service worker off.
    test.use({ serviceWorkers: 'block' });

    const failWith = (message, status = 500) => route =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: message }) });

    test('a failed event save is announced as an alert in the event dialog', async ({ page }) => {
      await page.route('**/api/events', route =>
        route.request().method() === 'POST' ? failWith('Speichern auf dem Server fehlgeschlagen')(route) : route.continue());
      await page.goto('/?date=2028-12-28');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await page.fill('#ev-title', `E2E 163 ${Date.now()}`);
      await page.fill('#ev-start-date', '2028-12-28');
      await page.fill('#ev-end-date', '2028-12-28');
      await page.check('#ev-allday');
      await page.click('#event-save-btn');

      const alert = page.locator('#event-modal').getByRole('alert');
      await expect(alert).toHaveText('Speichern auf dem Server fehlgeschlagen');
      await expect(alert).toHaveAttribute('id', 'event-form-error');
    });

    test('a failed account add is announced as an alert in the account dialog', async ({ page }) => {
      await page.route('**/api/accounts', route =>
        route.request().method() === 'POST' ? failWith('Server nicht erreichbar', 502)(route) : route.continue());
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      await page.click('#sidebar-settings-btn');
      await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
      await page.click('#settings-add-account-btn');
      await expect(page.locator('#account-modal-backdrop')).not.toHaveClass(/hidden/);
      await page.fill('#acc-url', 'https://caldav.example.com/');
      await page.fill('#acc-username', 'testuser');
      await page.fill('#acc-password', 'not-a-real-password');
      await page.click('#account-save-btn');

      const alert = page.locator('#account-modal').getByRole('alert');
      await expect(alert).toHaveText('Server nicht erreichbar');
      await expect(alert).toHaveAttribute('id', 'account-form-error');
    });

    test('a failed calendar create is announced as an alert in the add-calendar dialog', async ({ page }) => {
      await page.route('**/api/calendars', route =>
        route.request().method() === 'POST' ? failWith('Kalender konnte nicht angelegt werden')(route) : route.continue());
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      await page.click('#add-calendar-btn');
      await page.fill('#add-cal-name', `E2E 163 ${Date.now()}`);
      await page.click('#add-cal-submit');

      const alert = page.locator('#add-cal-dialog-backdrop').getByRole('alert');
      await expect(alert).toHaveText(/Kalender konnte nicht angelegt werden/);
      await expect(alert).toHaveAttribute('id', 'add-cal-error');
    });

    test('every inline form error box is an alert region', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      for (const id of ['onboarding-error', 'event-form-error', 'account-form-error', 'webcal-form-error']) {
        await expect(page.locator(`#${id}`), id).toHaveAttribute('role', 'alert');
      }
      await page.locator('#calendar-list [data-edit-cal]').first().click();
      await expect(page.locator('#edit-cal-error')).toHaveAttribute('role', 'alert');
    });

    test('a failed delete from the popover leaves an assertive error that outlives four seconds and closes from the keyboard', async ({ page }) => {
      await page.goto('/?date=2028-12-28');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      const title = `E2E 163 Löschfehler ${Date.now()}`;
      await page.click('#new-event-btn');
      await page.fill('#ev-title', title);
      await page.fill('#ev-start-date', '2028-12-28');
      await page.fill('#ev-end-date', '2028-12-28');
      await page.check('#ev-allday');
      await page.click('#event-save-btn');
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 10000 });
      const chip = page.locator('.event-chip').filter({ hasText: title }).first();
      await expect(chip).toBeVisible({ timeout: 15000 });

      const failDelete = route =>
        route.request().method() === 'DELETE' ? failWith('Termin ist gesperrt')(route) : route.continue();
      await page.route('**/api/events/**', failDelete);
      try {
        await chip.click();
        await page.click('#popover-delete-btn');
        await page.click('#confirm-dialog-ok');

        const toast = page.locator('#toast-container').getByRole('alert').filter({ hasText: 'Termin ist gesperrt' });
        await expect(toast).toBeVisible();
        await expect(toast).toHaveAttribute('aria-live', 'assertive');
        await page.waitForTimeout(4600);
        await expect(toast).toBeVisible();
        await expect(chip).toBeVisible();

        const close = toast.getByRole('button', { name: 'Meldung schließen' });
        await close.focus();
        await expect(close).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(toast).toHaveCount(0);
      } finally {
        await page.unroute('**/api/events/**', failDelete);
        await page.keyboard.press('Escape');
        await chip.click();
        await page.click('#popover-delete-btn');
        await page.click('#confirm-dialog-ok');
        await expect(chip).not.toBeVisible();
      }
    });

    test('a failed calendar delete in settings names the failure once', async ({ page }) => {
      await page.route('**/api/calendars/**', route =>
        route.request().method() === 'DELETE' ? failWith('Kalender ist gesperrt')(route) : route.continue());
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      await page.click('#sidebar-settings-btn');
      await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
      await page.locator('[data-delete-cal-settings]').first().click();
      // #348: a calendar delete is confirmed by typing its name.
      const typed = page.locator('#typed-confirm-input');
      await typed.fill(await typed.getAttribute('placeholder'));
      await page.click('#typed-confirm-ok');

      const toast = page.locator('#toast-container').getByRole('alert');
      await expect(toast).toHaveText(/Kalender ist gesperrt/);
      await expect(page.locator('#status-bar')).toHaveText('Fehler: Kalender ist gesperrt');
    });
  });

  test.describe('Issue #164 — an HTML page on a JSON endpoint is reported, not used as data', () => {
    // page.route needs the service worker off.
    test.use({ serviceWorkers: 'block' });

    test('a calendar list answered with the SPA page raises an error toast naming the endpoint', async ({ page }) => {
      await page.route('**/api/calendars', route => {
        if (route.request().method() !== 'GET') return route.continue();
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!DOCTYPE html>\n<html lang="de"></html>' });
      });
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      // Boot may load the calendar list more than once (e.g. after a sync), each failure toasting.
      const toast = page.locator('#toast-container .toast.error', { hasText: 'Kalender konnten nicht geladen werden' }).first();
      await expect(toast).toBeVisible({ timeout: 10000 });
      await expect(toast).toContainText('/api/calendars');
      await expect(toast).toContainText('text/html');
    });
  });

  test.describe('Issue #174 — optimistic save and real progress for long imports and syncs', () => {
    // page.route needs the service worker off.
    test.use({ serviceWorkers: 'block' });

    const DAY = '2029-03-14';

    async function openApp(page) {
      await page.goto(`/?date=${DAY}`);
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      // Other specs of the run may have added calendars.
      await expect(page.locator('#calendar-list .calendar-item').first()).toBeVisible({ timeout: 10000 });
    }

    async function fillNewAllDayEvent(page, title) {
      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
      await page.fill('#ev-title', title);
      await page.fill('#ev-start-date', DAY);
      await page.fill('#ev-end-date', DAY);
      await page.check('#ev-allday');
    }

    async function deleteByTitle(page, title) {
      const res = await page.request.get(`/api/events?start=${DAY}T00:00:00Z&end=2029-03-16T00:00:00Z`);
      expect(res.ok()).toBeTruthy();
      for (const ev of (await res.json()).events.filter(e => e.title === title)) {
        const del = await page.request.delete(`/api/events/${encodeURIComponent(ev.uid)}`, {
          headers: SAME_ORIGIN, data: { calendarId: ev.calendarId, href: ev.href, etag: ev.etag }
        });
        expect(del.ok()).toBeTruthy();
      }
    }

    // Holds every request of `method` on `pattern` until release() — a slow Radicale.
    async function holdRequests(page, pattern, method) {
      let release;
      const released = new Promise(resolve => { release = resolve; });
      await page.route(pattern, async route => {
        if (route.request().method() !== method) return route.continue();
        await released;
        return route.continue();
      });
      return release;
    }

    // Answers `method` on `pattern` with a 500 after a delay — a slow, then failing Radicale.
    async function failRequests(page, pattern, method, message) {
      await page.route(pattern, async route => {
        if (route.request().method() !== method) return route.continue();
        await new Promise(resolve => setTimeout(resolve, 1500));
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: message }) });
      });
    }

    test('a new event shows at once while its save is still running', async ({ page }) => {
      const title = `E2E 174 Optimistic ${Date.now()}`;
      await openApp(page);
      const release = await holdRequests(page, '**/api/events', 'POST');
      try {
        await fillNewAllDayEvent(page, title);
        await page.click('#event-save-btn');

        // The dialog closes and the event is drawn while the POST is still held.
        await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 2000 });
        const pending = page.locator('.event-chip.event-pending', { hasText: title });
        await expect(pending).toBeVisible({ timeout: 2000 });
        await expect(pending).toHaveAttribute('aria-label', /wird gespeichert/);
        // Clicked while saving, it opens the stored event's popover once the save has landed.
        await pending.click();
        await expect(page.locator('#event-popover')).toHaveClass(/hidden/);

        release();
        await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/, { timeout: 15000 });
        await expect(page.locator('#event-popover .popover-title')).toHaveText(title);
        await page.keyboard.press('Escape');
        await expect(page.locator('.event-chip:not(.event-pending)', { hasText: title })).toBeVisible({ timeout: 15000 });
        await expect(pending).toHaveCount(0);
        await expect(page.locator('#toast-container .toast', { hasText: 'Termin erstellt.' })).toBeVisible();
      } finally {
        release();
        await deleteByTitle(page, title);
      }
    });

    test('a failed create removes the shown event, says so in German and reopens the dialog with the entries', async ({ page }) => {
      const title = `E2E 174 Failing ${Date.now()}`;
      await openApp(page);
      await failRequests(page, '**/api/events', 'POST', 'Radicale nicht erreichbar');
      await fillNewAllDayEvent(page, title);
      await page.click('#event-save-btn');

      const chip = page.locator('.event-chip', { hasText: title });
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 1000 });
      await expect(chip).toBeVisible({ timeout: 1000 });

      const toast = page.locator('#toast-container .toast.error', { hasText: title });
      await expect(toast).toBeVisible({ timeout: 10000 });
      await expect(toast).toContainText('wurde nicht gespeichert und ist wieder entfernt');
      await expect(toast).toContainText('Radicale nicht erreichbar');
      await expect(toast).toHaveAttribute('role', 'alert');
      await expect(chip).toHaveCount(0);
      // Nothing typed is lost: the dialog is back with the title and the server's reason.
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#ev-title')).toHaveValue(title);
      await expect(page.locator('#event-form-error')).toHaveText('Radicale nicht erreichbar');
    });

    test('a failed edit rolls the event back to its saved state', async ({ page }) => {
      const oldTitle = `E2E 174 Saved ${Date.now()}`;
      const newTitle = `${oldTitle} geändert`;
      await openApp(page);
      await page.click('#new-event-btn');
      await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
      const calendarId = await page.locator('#ev-calendar option:not([value=""])').first().getAttribute('value');
      await page.keyboard.press('Escape');
      const created = await page.request.post('/api/events', {
        headers: SAME_ORIGIN,
        data: { calendarId, title: oldTitle, start: `${DAY}T00:00:00.000Z`, end: '2029-03-15T00:00:00.000Z', allDay: true }
      });
      expect(created.status()).toBe(201);

      try {
        await openApp(page);
        await failRequests(page, '**/api/events/*', 'PUT', 'Radicale nicht erreichbar');
        await page.locator('.event-chip', { hasText: oldTitle }).first().click();
        await page.click('#popover-edit-btn');
        await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
        await page.fill('#ev-title', newTitle);
        await page.click('#event-save-btn');

        const edited = page.locator('.event-chip.event-pending', { hasText: newTitle });
        await expect(edited).toBeVisible({ timeout: 1000 });
        await expect(page.locator('.event-chip', { hasText: oldTitle }).filter({ hasNotText: 'geändert' })).toHaveCount(0);

        const toast = page.locator('#toast-container .toast.error', { hasText: newTitle });
        await expect(toast).toBeVisible({ timeout: 10000 });
        await expect(toast).toContainText('wurde nicht gespeichert und ist zurückgenommen');
        await expect(edited).toHaveCount(0);
        await expect(page.locator('.event-chip', { hasText: oldTitle }).first()).toBeVisible();
        await expect(page.locator('#event-form-error')).toHaveText('Radicale nicht erreichbar');
      } finally {
        await page.unroute('**/api/events/*');
        await deleteByTitle(page, oldTitle);
      }
    });

    async function dropIcs(page) {
      const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:e2e-174-${Date.now()}`,
        'DTSTART;VALUE=DATE:20290314', 'SUMMARY:Test User import', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
      await page.evaluate((icsText) => {
        const dt = new DataTransfer();
        dt.items.add(new File([icsText], 'export.ics', { type: 'text/calendar' }));
        document.querySelector('.sidebar').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      }, ics);
      await expect(page.locator('#import-dialog-backdrop')).toBeVisible();
      await page.click('#import-confirm');
      await expect(page.locator('#import-dialog-backdrop')).toBeHidden({ timeout: 5000 });
    }

    // The import job as the server reports it; the test moves it along.
    async function serveImportJob(page, state) {
      await page.route('**/api/calendars/*/import', route =>
        route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(state.job) }));
      await page.route('**/api/calendars/import-jobs/job-174', route =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.job) }));
    }

    const importJob = fields => ({ id: 'job-174', status: 'running', total: 5000, processed: 0, imported: 0, skipped: 0, failed: 0, error: null, ...fields });

    test('a long ICS import shows the job\'s real progress and that the calendar is usable', async ({ page }) => {
      const state = { job: importJob({}) };
      await openApp(page);
      await serveImportJob(page, state);
      await dropIcs(page);

      const banner = page.locator('#import-progress');
      await expect(banner).toBeVisible();
      await expect(banner).toHaveAttribute('role', 'status');
      await expect(page.locator('#import-progress-text')).toHaveText('Import läuft: 0 von 5.000 Terminen. Der Kalender ist schon nutzbar.');

      state.job = importJob({ processed: 1200, imported: 1200 });
      await expect(page.locator('#import-progress-text')).toHaveText('Import läuft: 1.200 von 5.000 Terminen. Der Kalender ist schon nutzbar.');
      await expect(page.locator('#import-progress-bar')).toHaveJSProperty('value', 1200);
      // Usable meanwhile: a new event can be started.
      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await page.keyboard.press('Escape');

      state.job = importJob({ status: 'done', processed: 5000, imported: 4990, skipped: 10 });
      await expect(banner).toBeHidden({ timeout: 5000 });
      await expect(page.locator('#toast-container .toast.success', { hasText: 'Import abgeschlossen: 4990 importiert, 10 übersprungen.' })).toBeVisible();
    });

    test('an aborted ICS import hides the progress and reports how far it got', async ({ page }) => {
      const state = { job: importJob({ processed: 1200, imported: 1200 }) };
      await openApp(page);
      await serveImportJob(page, state);
      await dropIcs(page);
      await expect(page.locator('#import-progress-text')).toContainText('1.200 von 5.000');

      state.job = importJob({ status: 'error', processed: 1200, imported: 1200, error: 'Der Import wurde abgebrochen.' });
      await expect(page.locator('#import-progress')).toBeHidden({ timeout: 5000 });
      const toast = page.locator('#toast-container .toast.error', { hasText: 'Import abgebrochen nach 1.200 von 5.000 Terminen' });
      await expect(toast).toBeVisible();
      await expect(toast).toContainText('Der Import wurde abgebrochen.');
    });

    async function serveSyncJobs(page, state) {
      await page.route('**/api/accounts/sync-status', route =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobs: state.jobs }) }));
    }

    test('a running account sync shows how many events the worker has written', async ({ page }) => {
      const state = { jobs: [{ id: 'sync-174', status: 'RUNNING', itemsDone: 1200, errorMessage: null, createdAt: 1, updatedAt: 1 }] };
      await serveSyncJobs(page, state);
      await openApp(page);

      const banner = page.locator('#sync-progress');
      await expect(banner).toBeVisible({ timeout: 10000 });
      await expect(banner).toHaveAttribute('role', 'status');
      await expect(page.locator('#sync-progress-text')).toHaveText('Synchronisierung läuft: 1.200 Termine übertragen. Der Kalender ist schon nutzbar.');

      // Polled again while the job runs, without waiting for the minute poll.
      state.jobs = [{ ...state.jobs[0], itemsDone: 2500 }];
      await expect(page.locator('#sync-progress-text')).toContainText('2.500 Termine übertragen', { timeout: 6000 });

      state.jobs = [{ ...state.jobs[0], status: 'SUCCESS' }];
      await expect(banner).toBeHidden({ timeout: 6000 });
      await expect(page.locator('#sync-error-banner')).toBeHidden();
    });

    test('a sync that fails while running replaces the progress with the error banner', async ({ page }) => {
      const state = { jobs: [{ id: 'sync-174', status: 'RUNNING', itemsDone: 300, errorMessage: null, createdAt: 1, updatedAt: 1 }] };
      await serveSyncJobs(page, state);
      await openApp(page);
      await expect(page.locator('#sync-progress')).toBeVisible({ timeout: 10000 });

      state.jobs = [{ ...state.jobs[0], status: 'ERROR', errorMessage: 'vdirsyncer sync failed: Test User' }];
      await expect(page.locator('#sync-progress')).toBeHidden({ timeout: 6000 });
      await expect(page.locator('#sync-error-banner')).toBeVisible();
      await expect(page.locator('#sync-error-text')).toContainText('vdirsyncer sync failed: Test User');
    });
  });

  test.describe('Issue #227 — all-day events appear in week, work-week and day views', () => {
    // Fixed events in the week Mon 11 – Sun 17 May 2037; page.route needs the
    // service worker off.
    test.use({ serviceWorkers: 'block' });
    let calendarId;
    let fixedEvents;
    // #592: the ids name the test's own user, known only once its fixture is set up.
    test.beforeEach(() => {
      calendarId = `internal-caldav::/${E2E_USER}/personal/`;
      fixedEvents = [
        { uid: 'e2e-issue227-holiday', title: 'Feiertag', calendarId, start: '2037-05-14', end: '2037-05-15', allDay: true },
        { uid: 'e2e-issue227-leave', title: 'Urlaub', calendarId, start: '2037-05-11', end: '2037-05-16', allDay: true },
        { uid: 'e2e-issue227-timed', title: 'Standup', calendarId, start: '2037-05-14T09:00:00+02:00', end: '2037-05-14T09:30:00+02:00', allDay: false },
      ];
    });

    test.beforeEach(async ({ page }) => {
      await mockEvents(page, fixedEvents);
      await page.goto('/?date=2037-05-14');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('.month-grid .event-chip', { hasText: 'Standup' })).toBeVisible({ timeout: 10000 });
    });

    const headerColumn = (page, container, dayNum) =>
      container.locator('.week-day-header').filter({ has: page.locator('.week-day-num', { hasText: new RegExp(`^${dayNum}$`) }) });

    for (const [view, viewClass, gridBody, leaveDays] of [
      ['week', '.week-view', '.week-grid-body', [11, 12, 13, 14, 15]],
      ['workweek', '.week-view', '.week-grid-body', [11, 12, 13, 14, 15]],
      ['day', '.day-view', '.day-grid-body', [14]],
    ]) {
      test(`${view} view: all-day chips sit in the header strip of their days, not in the hour grid`, async ({ page }) => {
        await page.click(`#view-${view}`);
        const container = page.locator(`#calendar-container ${viewClass}`);
        await expect(container).toBeVisible();

        const strip = container.locator('.all-day-events');
        const holiday = strip.locator('[data-event-uid="e2e-issue227-holiday"]');
        const leave = strip.locator('[data-event-uid="e2e-issue227-leave"]');
        await expect(holiday).toHaveCount(1);
        await expect(holiday).toBeVisible();
        await expect(holiday).toHaveText('Feiertag');
        await expect(leave).toHaveCount(leaveDays.length);

        // Each chip is in the column of its own day.
        await expect(headerColumn(page, container, 14).locator('[data-event-uid="e2e-issue227-holiday"]')).toHaveCount(1);
        for (const d of leaveDays) {
          await expect(headerColumn(page, container, d).locator('[data-event-uid="e2e-issue227-leave"]')).toBeVisible();
        }
        if (view !== 'day') {
          await expect(headerColumn(page, container, 16).locator('.all-day-events')).toHaveCount(0);
        }

        // All-day events stay out of the hour grid; timed events stay out of the strip.
        const grid = container.locator(gridBody);
        await expect(grid.locator('[data-event-uid^="e2e-issue227-"]', { hasText: 'Standup' })).toHaveCount(1);
        await expect(grid.locator('[data-event-uid="e2e-issue227-holiday"], [data-event-uid="e2e-issue227-leave"]')).toHaveCount(0);
        await expect(strip.locator('[data-event-uid="e2e-issue227-timed"]')).toHaveCount(0);

        // The header chip is interactive: clicking opens the event popover.
        await holiday.click();
        await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);
        await expect(page.locator('#event-popover .popover-title')).toHaveText('Feiertag');
      });
    }

    test('the all-day event is in the DOM of all five views', async ({ page }) => {
      for (const view of ['month', 'week', 'workweek', 'day', 'agenda']) {
        await page.click(`#view-${view}`);
        await expect(page.locator(`#view-${view}`)).toHaveAttribute('aria-pressed', 'true');
        await expect(
          page.locator('#calendar-container [data-event-uid="e2e-issue227-holiday"]').first(),
          `${view} view must show the all-day event`,
        ).toBeVisible();
      }
    });
  });

  test.describe('Issue #126 — letter shortcuts need Alt, arrows stay off interactive elements', () => {
    // Fixed events so the popover with an attachment link is known; page.route needs the service worker off.
    test.use({ serviceWorkers: 'block' });
    let calendarId;
    let fixedEvents;
    // #592: the ids name the test's own user, known only once its fixture is set up.
    test.beforeEach(() => {
      calendarId = `internal-caldav::/${E2E_USER}/personal/`;
      fixedEvents = [{
        uid: 'e2e-issue126-a', title: 'Shortcut Probe', calendarId,
        start: '2037-06-10', end: '2037-06-11', allDay: true,
        attachments: [{ name: 'Agenda.pdf', url: 'https://example.com/agenda.pdf' }],
      }];
    });
    const createModal = '#event-modal-backdrop';

    test.beforeEach(async ({ page }) => {
      await mockEvents(page, fixedEvents);
      await page.goto('/?date=2037-06-10');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('.month-grid .event-chip', { hasText: 'Shortcut Probe' })).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#toolbar-title')).toHaveText('Juni 2037');
    });

    async function blurToBody(page) {
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    }

    test('plain n / t / m do nothing on a focused button or on the page body', async ({ page }) => {
      await page.locator('#today-btn').focus();
      for (const key of ['n', 't', 'w', 'c']) await page.keyboard.press(key);
      await blurToBody(page);
      for (const key of ['n', 't', 'w', 'c']) await page.keyboard.press(key);

      await expect(page.locator(createModal)).toHaveClass(/hidden/);
      await expect(page.locator('#toolbar-title')).toHaveText('Juni 2037');
      await expect(page.locator('#view-month')).toHaveAttribute('aria-pressed', 'true');
    });

    test('Alt+W, Alt+T and Alt+N trigger their actions, also from a focused button', async ({ page }) => {
      await page.locator('#view-month').focus();
      await page.keyboard.press('Alt+KeyW');
      await expect(page.locator('#view-week')).toHaveAttribute('aria-pressed', 'true');

      await page.keyboard.press('Alt+KeyT');
      await expect(page.locator('#toolbar-title')).not.toContainText('2037');

      await page.keyboard.press('Alt+KeyN');
      await expect(page.locator(createModal)).not.toHaveClass(/hidden/);
    });

    test('typing into a contenteditable never opens a dialog', async ({ page }) => {
      await page.evaluate(() => {
        const el = document.createElement('div');
        el.id = 'e2e-issue126-editable';
        el.contentEditable = 'true';
        document.querySelector('.toolbar').appendChild(el);
      });
      await page.locator('#e2e-issue126-editable').focus();
      await page.keyboard.type('nt');
      await expect(page.locator('#e2e-issue126-editable')).toHaveText('nt');
      await expect(page.locator(createModal)).toHaveClass(/hidden/);
      await expect(page.locator('#toolbar-title')).toHaveText('Juni 2037');
    });

    test('arrow keys page only while nothing interactive has focus', async ({ page }) => {
      await page.locator('#today-btn').focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#toolbar-title')).toHaveText('Juni 2037');

      await blurToBody(page);
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#toolbar-title')).toHaveText('Juli 2037');
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('#toolbar-title')).toHaveText('Juni 2037');
    });

    test('with the event popover open, its link and the body swallow arrows and Alt+N', async ({ page }) => {
      await page.locator('.month-grid .event-chip', { hasText: 'Shortcut Probe' }).click();
      await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);

      const link = page.locator('#event-popover .attachment-drive-link');
      await link.focus();
      await expect(link).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Alt+KeyN');
      await page.keyboard.press('n');

      await blurToBody(page);
      await page.keyboard.press('ArrowRight');

      await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);
      await expect(page.locator(createModal)).toHaveClass(/hidden/);
      await expect(page.locator('#toolbar-title')).toHaveText('Juni 2037');
    });

    test('holding Alt shows the key-hint layer, releasing it hides the layer', async ({ page }) => {
      const hint = id => page.evaluate(sel => getComputedStyle(document.querySelector(sel), '::after').content, id);
      expect(await hint('#today-btn')).toBe('none');

      await page.keyboard.down('Alt');
      expect(await hint('#today-btn')).toBe('"T"');
      expect(await hint('#new-event-btn')).toBe('"N"');
      expect(await hint('#view-week')).toBe('"W"');
      await expect(page.locator('#today-btn')).toHaveAttribute('aria-keyshortcuts', 'Alt+T');

      await page.keyboard.up('Alt');
      expect(await hint('#today-btn')).toBe('none');
    });
  });

  // Issue #86: destructive and confirming buttons are outlined — a plain button whose border and
  // label take the status colour — never a solid fill.
  test.describe('Issue #86 — danger and success buttons are outlined in their status colour', () => {
    for (const theme of ['light', 'dark']) {
      test(`${theme} theme: the confirm dialog's OK button and an RSVP accept button`, async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
        await page.evaluate(async theme => {
          document.documentElement.setAttribute('data-theme', theme);
          // The plain button and the accept button invitations.js renders, as reference and subject.
          const host = document.createElement('div');
          host.innerHTML = '<button class="btn btn-sm" id="e2e86-plain">Vorläufig</button>'
            + '<button class="btn btn-sm btn-success" id="e2e86-success">Zusagen</button>';
          document.body.appendChild(host);
          const { confirmDialog } = await import('/js/dialogFocus.js');
          confirmDialog('E2E 86 löschen?');
        }, theme);
        await expect(page.locator('#confirm-dialog-backdrop')).toBeVisible();

        const look = sel => page.locator(sel).evaluate(el => {
          const s = getComputedStyle(el);
          return { border: s.borderTopColor, borderStyle: s.borderTopStyle, color: s.color, background: s.backgroundColor };
        });
        const plain = await look('#e2e86-plain');
        const danger = await tokenColor(page, '--danger');
        const success = await tokenColor(page, '--success');
        expect(await look('#confirm-dialog-ok')).toEqual({ border: danger, borderStyle: 'solid', color: danger, background: plain.background });
        expect(await look('#e2e86-success')).toEqual({ border: success, borderStyle: 'solid', color: success, background: plain.background });
        await page.keyboard.press('Escape');
        await expect(page.locator('#confirm-dialog-backdrop')).toBeHidden();
      });
    }
  });

  // Issue #104: the theme select in the settings drawer switches the painted palette at runtime,
  // the choice survives a reload, and "system" follows the operating system's colour scheme.
  test.describe('Issue #104 — the theme setting repaints the app and is remembered', () => {
    // Relative luminance (WCAG) of the painted page background, sidebar surface and body text.
    async function painted(page) {
      return page.evaluate(() => {
        const luminance = color => {
          const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const html = getComputedStyle(document.documentElement);
        const body = getComputedStyle(document.body);
        return {
          theme: document.documentElement.getAttribute('data-theme'),
          scheme: html.colorScheme,
          bg: luminance(body.backgroundColor),
          ink: luminance(body.color),
          surface: luminance(getComputedStyle(document.querySelector('.sidebar')).backgroundColor),
        };
      });
    }
    function expectDark(p) {
      expect(p.theme).toBe('dark');
      expect(p.scheme).toBe('dark');
      expect(p.bg).toBeLessThan(0.05);
      expect(p.surface).toBeLessThan(0.05);
      expect(p.ink).toBeGreaterThan(0.6);
    }
    function expectLight(p) {
      expect(p.theme).toBe('light');
      expect(p.scheme).not.toBe('dark');
      expect(p.bg).toBeGreaterThan(0.8);
      expect(p.surface).toBeGreaterThan(0.8);
      expect(p.ink).toBeLessThan(0.1);
    }
    async function chooseTheme(page, value) {
      if (!(await page.locator('#settings-drawer').evaluate(el => el.classList.contains('open')))) {
        await page.click('#sidebar-settings-btn');
      }
      const select = page.locator('#settings-drawer #theme-select');
      await expect(select).toBeVisible();
      await select.selectOption(value);
    }

    test('dark and light are applied at once and survive a reload', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expectLight(await painted(page));

      await page.click('#sidebar-settings-btn');
      expect(await page.locator('#theme-select option').evaluateAll(os => os.map(o => o.value)))
        .toEqual(['system', 'light', 'dark']);
      await chooseTheme(page, 'dark');
      expectDark(await painted(page));

      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expectDark(await painted(page));
      await expect(page.locator('#theme-select')).toHaveValue('dark');

      await chooseTheme(page, 'light');
      expectLight(await painted(page));
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expectLight(await painted(page));
    });

    test('system follows the operating system, also when it changes while the app is open', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await chooseTheme(page, 'system');
      expectDark(await painted(page));
      await page.emulateMedia({ colorScheme: 'light' });
      await expect.poll(async () => (await painted(page)).theme).toBe('light');
      expectLight(await painted(page));
    });
  });

  // Issue #90: a 30-minute event is about 30 px tall in the week grid; its start time and title
  // must both be drawn inside the block, not pushed below its clipped edge.
  test('Issue #90 — a 30-minute event in the week grid shows its time and title inside the block', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    // As in Issue #112: wait until boot has gone quiet, then render into a host of our own.
    await page.waitForLoadState('networkidle');
    await page.evaluate(async () => {
      const { store } = await import('/js/store.js');
      const { renderView } = await import('/js/calendar.js');
      store.get('calendars').push({ id: 'e2e90-cal', name: 'E2E 90', color: '#007080' });
      const host = document.createElement('div');
      host.id = 'e2e90-week';
      host.style.cssText = 'position:fixed;inset:0;z-index:100000;overflow:auto;background:var(--bg);display:flex;flex-direction:column;';
      document.body.appendChild(host);
      const events = [{
        uid: 'e2e90-ev', calendarId: 'e2e90-cal', title: 'Kurz', allDay: false,
        start: new Date(2026, 2, 11, 10, 0).toISOString(), end: new Date(2026, 2, 11, 10, 30).toISOString(),
      }];
      renderView(host, events, 'week', new Date(2026, 2, 11), new Proxy({}, { get: () => () => {} }));
    });

    const block = page.locator('#e2e90-week [data-event-uid="e2e90-ev"]');
    await expect(block.locator('.event-block-title')).toHaveText('Kurz');
    const parts = await block.evaluate(el => {
      const b = el.getBoundingClientRect();
      const inner = sel => {
        const r = el.querySelector(sel).getBoundingClientRect();
        return { height: r.height, inside: r.top >= b.top && r.bottom <= b.bottom, width: r.width, scrollWidth: el.querySelector(sel).scrollWidth };
      };
      return { blockHeight: b.height, time: inner('.event-block-time'), title: inner('.event-block-title') };
    });
    expect(parts.blockHeight).toBeLessThanOrEqual(36);
    for (const part of [parts.time, parts.title]) {
      expect(part.height).toBeGreaterThan(8);
      expect(part.inside).toBe(true);
    }
    // "Kurz" is short enough to be shown whole, not ellipsised away.
    expect(parts.title.scrollWidth).toBeLessThanOrEqual(Math.ceil(parts.title.width));
  });

  // Issue #113: with "reduce motion" asked for by the system nothing in the app animates.
  test.describe('Issue #113 — prefers-reduced-motion stops transitions and animations', () => {
    // Every element (and its ::before/::after) whose transition or animation lasts longer than 1 ms.
    function moving() {
      const seconds = list => Math.max(...list.split(',').map(v => {
        v = v.trim();
        return v.endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v);
      }));
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        for (const pseudo of [null, '::before', '::after']) {
          const s = getComputedStyle(el, pseudo);
          const t = seconds(s.transitionDuration);
          const a = s.animationName !== 'none' ? seconds(s.animationDuration) : 0;
          if (t > 0.001 || a > 0.001) out.push(`${el.id || el.className}${pseudo || ''}: ${s.transitionDuration} / ${s.animationName} ${s.animationDuration}`);
        }
      }
      return out;
    }

    async function openEverything(page) {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      // The drawer and a modal are on screen, so their own transitions and animations are measured too.
      await page.click('#sidebar-settings-btn');
      await expect(page.locator('#settings-drawer')).toHaveClass(/open/);
    }

    test('without the preference the app does animate (the measurement can see motion)', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await openEverything(page);
      expect((await page.evaluate(moving)).length).toBeGreaterThan(10);
    });

    test('with the preference no element transitions or animates and the time tokens are zero', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openEverything(page);
      expect(await page.evaluate(moving)).toEqual([]);
      const tokens = await page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        return { t: s.getPropertyValue('--t').trim(), tSlow: s.getPropertyValue('--t-slow').trim(), scroll: s.scrollBehavior };
      });
      expect(tokens).toEqual({ t: '0s', tSlow: '0s', scroll: 'auto' });
    });
  });

  // Issues #114 and #188: kanban cards and the popover carry no emoji glyphs, and their buttons,
  // the calendar row actions and the event chips are big enough to hit (44 px for touch-first
  // controls, WCAG 2.5.8's 24 px floor for the dense ones).
  test.describe('Issues #114 / #188 — no emoji glyphs, and targets large enough to hit', () => {
    test.use({ serviceWorkers: 'block' });
    let calendarId;
    // #592: the ids name the test's own user, known only once its fixture is set up.
    test.beforeEach(() => {
      calendarId = `internal-caldav::/${E2E_USER}/personal/`;
    });
    const EMOJI = /\p{Extended_Pictographic}/u;
    const boxes = locator => locator.evaluateAll(els => els.map(el => {
      const r = el.getBoundingClientRect();
      return { name: el.getAttribute('aria-label') || el.id || el.className, width: r.width, height: r.height };
    }));

    test.beforeEach(async ({ page }) => {
      await page.route('**/api/events?**', route => route.fulfill({ json: { events: [{
        uid: 'e2e-issue188-ev', title: 'Target Probe', calendarId,
        start: '2037-06-10T10:00:00.000Z', end: '2037-06-10T11:00:00.000Z', allDay: false,
      }], errors: [] } }));
      await page.route('**/api/tasks', route => {
        if (route.request().method() !== 'GET') return route.continue();
        return route.fulfill({ json: [
          { uid: 'e2e-issue114-todo', calendarId, title: 'Kanban Probe', status: 'NEEDS-ACTION', priority: 1,
            due: '2037-06-12T15:00:00.000Z', recurrence: 'FREQ=WEEKLY' },
          { uid: 'e2e-issue114-done', calendarId, title: 'Kanban Done', status: 'COMPLETED', due: '2037-06-11T15:00:00.000Z' },
        ] });
      });
      await page.goto('/?date=2037-06-10');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    });

    test('event chips and the calendar row actions are at least 24 px square', async ({ page }) => {
      const chip = page.locator('.month-grid .event-chip', { hasText: 'Target Probe' });
      await expect(chip).toBeVisible({ timeout: 10000 });
      const [chipBox] = await boxes(chip);
      expect(chipBox.height).toBeGreaterThanOrEqual(24);

      const row = page.locator('#calendar-list .calendar-item').first();
      await row.hover();
      const actions = await boxes(row.locator('.cal-action-btn'));
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.filter(a => a.width < 24 || a.height < 24)).toEqual([]);
    });

    test('the popover\'s small buttons are 44 px touch targets', async ({ page }) => {
      await page.locator('.month-grid .event-chip', { hasText: 'Target Probe' }).click();
      await expect(page.locator('#event-popover')).not.toHaveClass(/hidden/);
      const buttons = await boxes(page.locator('#event-popover .btn-sm'));
      expect(buttons.length).toBeGreaterThanOrEqual(2);
      expect(buttons.filter(b => b.width < 44 || b.height < 44)).toEqual([]);
      expect(await page.locator('#event-popover').textContent()).not.toMatch(EMOJI);
    });

    test('kanban cards show due date and recurrence without emoji, with 44 px action buttons', async ({ page }) => {
      await page.click('#view-kanban');
      const card = page.locator('.kanban-card', { hasText: 'Kanban Probe' });
      await expect(card).toBeVisible({ timeout: 10000 });
      await expect(card.locator('.kanban-due-date')).toContainText('12.06.');
      await expect(card.locator('.kanban-recurrence-badge')).toBeVisible();
      await expect(page.locator('.kanban-card', { hasText: 'Kanban Done' }).locator('.btn-reopen')).toBeVisible();

      expect(await page.locator('.kanban-board').textContent()).not.toMatch(EMOJI);
      const buttons = await boxes(page.locator('.kanban-board .kanban-btn'));
      // Status, complete, edit, delete on the open task; reopen, edit, delete on the finished one.
      expect(buttons.length).toBeGreaterThanOrEqual(7);
      expect(buttons.filter(b => b.width < 44 || b.height < 44)).toEqual([]);
    });

    test('the welcome dialog carries no emoji', async ({ page }) => {
      await page.addInitScript(() => {
        if (window.origin !== 'null') window.localStorage.removeItem('welcome-popup-closed');
      });
      await page.reload();
      await expect(page.locator('#welcome-modal-backdrop')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const text = await page.locator('#welcome-modal').textContent();
      expect(text).toContain('Willkommen');
      expect(text).not.toMatch(EMOJI);
      await page.click('#welcome-btn-close');
    });
  });

  // Issue #190: the share dialog's person search is an ARIA 1.2 combobox with a listbox popup,
  // operated with the arrow keys, Enter and Escape.
  test('Issue #190 — the share search is a combobox driven by arrow keys, Enter and Escape', async ({ page }) => {
    await runSql(
      "INSERT OR IGNORE INTO users (user_id, username, email) VALUES ('testuser-id', 'testuser@example.com', 'testuser@example.com')"
    );
    await runSql(
      "INSERT OR IGNORE INTO users (user_id, username, email) VALUES ('testuser2-id', 'testuser2@example.com', 'testuser2@example.com')"
    );
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await page.locator('#calendar-list .calendar-item').first().locator('[data-share-cal]').click();
    const dialog = page.locator('#share-cal-dialog-backdrop');
    await expect(dialog).toBeVisible();

    const input = dialog.getByRole('combobox', { name: /suchen/ });
    await expect(input).toHaveAttribute('aria-autocomplete', 'list');
    await expect(input).toHaveAttribute('aria-haspopup', 'listbox');
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    const listboxId = await input.getAttribute('aria-controls');
    const listbox = page.locator(`#${listboxId}`);
    await expect(listbox).toHaveAttribute('role', 'listbox');

    await input.fill('testuser');
    await expect(listbox).toBeVisible({ timeout: 10000 });
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    const options = listbox.getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
    const restingBg = await options.nth(0).evaluate(el => getComputedStyle(el).backgroundColor);

    const active = async () => {
      const id = await input.getAttribute('aria-activedescendant');
      return id && page.locator(`#${id}`).textContent();
    };
    await input.press('ArrowDown');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    expect(await active()).toContain('testuser@example.com');
    // The active option is shown, not only announced.
    expect(await options.nth(0).evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(restingBg);
    await input.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
    expect(await active()).toContain('testuser2@example.com');
    await input.press('ArrowDown');
    expect(await active()).toContain('testuser@example.com');
    await input.press('ArrowUp');
    expect(await active()).toContain('testuser2@example.com');

    await input.press('Enter');
    await expect(input).toHaveValue('testuser2@example.com');
    await expect(listbox).toBeHidden();
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await expect(input).not.toHaveAttribute('aria-activedescendant', /.*/);
    await expect(dialog).toBeVisible();

    // Escape first closes the popup only; a second Escape closes the dialog.
    await input.fill('testuser');
    await expect(listbox).toBeVisible({ timeout: 10000 });
    await input.press('Escape');
    await expect(listbox).toBeHidden();
    await expect(dialog).toBeVisible();
    await input.press('Escape');
    await expect(dialog).not.toBeAttached();
  });

  // Issue #87: every dialog is a named modal dialog, Escape closes the topmost one, and the
  // settings drawer — off screen while closed — is out of the tab order until it is opened.
  test.describe('Issue #87 — dialogs: names, focus trap, Escape and the inert settings drawer', () => {
    async function boot(page) {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-item').first()).toBeVisible({ timeout: 10000 });
    }
    const focusIn = (page, sel) => page.evaluate(s => document.querySelector(s).contains(document.activeElement), sel);
    // The text of the element the dialog's aria-labelledby points at.
    const dialogName = (page, sel) => page.evaluate(s => {
      const id = document.querySelector(s).getAttribute('aria-labelledby');
      return ((id && document.getElementById(id)?.textContent) || '').trim();
    }, sel);

    test('the closed settings drawer is inert, out of view and never reached by Tab', async ({ page }) => {
      await boot(page);
      const drawer = page.locator('#settings-drawer');
      await expect(drawer).toHaveAttribute('inert', '');
      await expect(drawer).toBeHidden();
      await page.locator('#new-event-btn').focus();
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press('Tab');
        expect(await focusIn(page, '#settings-drawer'), `Tab stop ${i}`).toBe(false);
      }
      // With nothing open, Escape changes nothing and keeps focus where it is.
      await page.locator('#new-event-btn').focus();
      await page.keyboard.press('Escape');
      await expect(page.locator('#new-event-btn')).toBeFocused();
      await expect(drawer).toHaveAttribute('inert', '');
    });

    test('the open settings drawer is a named modal dialog that traps Tab and gives focus back on Escape', async ({ page }) => {
      await boot(page);
      await page.click('#sidebar-settings-btn');
      const drawer = page.getByRole('dialog', { name: await dialogName(page, '#settings-drawer'), exact: true });
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveAttribute('aria-modal', 'true');
      await expect(drawer).not.toHaveAttribute('inert', /.*/);
      expect(await focusIn(page, '#settings-drawer')).toBe(true);

      const stops = await drawer.evaluate(el => el.querySelectorAll('button, select, input, a[href], [tabindex="0"]').length);
      for (let i = 0; i < stops + 3; i++) {
        await page.keyboard.press('Tab');
        expect(await focusIn(page, '#settings-drawer'), `Tab ${i}`).toBe(true);
      }
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Shift+Tab');
        expect(await focusIn(page, '#settings-drawer'), `Shift+Tab ${i}`).toBe(true);
      }

      await page.keyboard.press('Escape');
      await expect(page.locator('#settings-drawer')).toBeHidden();
      await expect(page.locator('#settings-drawer')).toHaveAttribute('inert', '');
      await expect(page.locator('#sidebar-settings-btn')).toBeFocused();
    });

    test('every dialog is a named modal that takes focus and closes on Escape', async ({ page }) => {
      await boot(page);
      const dialogs = [
        { open: () => page.click('#new-task-btn'), backdrop: '#task-modal-backdrop', dialog: '#task-modal' },
        { open: () => page.click('#invitations-btn'), backdrop: '#invitations-modal-backdrop', dialog: '#invitations-modal' },
        { open: () => page.click('#availability-btn'), backdrop: '#availability-modal-backdrop', dialog: '#availability-modal' },
        { open: () => page.keyboard.press('Alt+KeyH'), backdrop: '#shortcuts-modal-backdrop', dialog: '#shortcuts-modal' },
        { open: () => page.click('#add-webcal-btn'), backdrop: '#webcal-modal-backdrop', dialog: '#webcal-modal' },
        {
          open: () => page.evaluate(async () => { (await import('/js/dialogFocus.js')).confirmDialog('E2E 87?'); }),
          backdrop: '#confirm-dialog-backdrop', dialog: '#confirm-dialog',
        },
      ];
      for (const d of dialogs) {
        await d.open();
        const backdrop = page.locator(d.backdrop);
        await expect(backdrop, d.dialog).not.toHaveClass(/hidden/);
        const name = await dialogName(page, d.dialog);
        expect(name, `${d.dialog} is named`).not.toBe('');
        await expect(page.getByRole('dialog', { name, exact: true }), d.dialog).toHaveAttribute('aria-modal', 'true');
        expect(await focusIn(page, d.dialog), `${d.dialog} takes focus`).toBe(true);
        await page.keyboard.press('Escape');
        await expect(backdrop, `${d.dialog} closes on Escape`).toHaveClass(/hidden/);
      }

    });

    // One Escape closes one dialog: the one on top, never the one beneath it as well.
    test('stacked dialogs close one per Escape, topmost first', async ({ page }) => {
      await boot(page);
      const drawer = page.locator('#settings-drawer');

      // The account dialog over the settings drawer.
      await page.click('#sidebar-settings-btn');
      await expect(drawer).toBeVisible();
      await page.click('#settings-add-account-btn');
      await expect(page.locator('#account-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.getByRole('dialog', { name: await dialogName(page, '#account-modal'), exact: true }))
        .toHaveAttribute('aria-modal', 'true');
      await page.keyboard.press('Escape');
      await expect(page.locator('#account-modal-backdrop')).toHaveClass(/hidden/);
      await expect(drawer).toBeVisible();

      // The Microsoft 365 dialog over the settings drawer.
      await page.click('#settings-add-account-btn');
      await page.click('#btn-link-msgraph');
      await expect(page.locator('#msgraph-modal-backdrop')).not.toHaveClass(/hidden/);
      await page.keyboard.press('Escape');
      await expect(page.locator('#msgraph-modal-backdrop')).toHaveClass(/hidden/);
      await expect(drawer).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();

      // The confirm dialog over the event dialog.
      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await page.evaluate(async () => { (await import('/js/dialogFocus.js')).confirmDialog('E2E 87?'); });
      await expect(page.locator('#confirm-dialog-backdrop')).not.toHaveClass(/hidden/);
      await page.keyboard.press('Escape');
      await expect(page.locator('#confirm-dialog-backdrop')).toHaveClass(/hidden/);
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await page.keyboard.press('Escape');
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
    });
  });

  // Issue #83: on a phone the toolbar is three rows — title and navigation, the view tabs across the
  // full width, the search — and the desktop-only buttons leave the title room.
  test('Issue #83 — the mobile toolbar keeps the title whole and spans the view tabs across a row', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/?date=2026-09-25');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    await expect(page.locator('#toolbar-title')).toHaveText('September 2026');

    const layout = await page.evaluate(() => {
      const box = sel => document.querySelector(sel).getBoundingClientRect();
      const title = document.getElementById('toolbar-title');
      return {
        toolbar: box('.toolbar'),
        title: box('#toolbar-title'),
        titleClipped: title.scrollWidth > title.clientWidth,
        tabs: box('.toolbar .view-tabs'),
        tab: Array.from(document.querySelectorAll('.toolbar .view-tab')).map(el => el.getBoundingClientRect()),
        search: box('.toolbar .search-wrapper'),
      };
    });
    expect(layout.titleClipped).toBe(false);
    // Row 2: the tabs sit below the title and take the toolbar's whole content width.
    expect(layout.tabs.top).toBeGreaterThanOrEqual(layout.title.bottom);
    expect(layout.tabs.width).toBeGreaterThan(layout.toolbar.width - 40);
    expect(layout.tab).toHaveLength(7);
    for (const t of layout.tab) {
      expect(t.left).toBeGreaterThanOrEqual(0);
      expect(t.right).toBeLessThanOrEqual(375);
      expect(Math.abs(t.top - layout.tab[0].top)).toBeLessThan(1);
    }
    // Row 3: the search below the tabs.
    expect(layout.search.top).toBeGreaterThanOrEqual(layout.tabs.bottom);
    for (const sel of ['#export-pdf-btn', '#invitations-btn', '#availability-btn']) {
      await expect(page.locator(sel), sel).toBeHidden();
    }
  });

  // Issue #22: printing shows the calendar alone — black on white, nothing scrolled away, no
  // navigation, buttons or open dialogs, and day cells and events kept whole across pages.
  test.describe('Issue #22 — print', () => {
    test.use({ serviceWorkers: 'block' });
    test('the print stylesheet prints the calendar alone, black on white and unclipped', async ({ page }) => {
      await page.route('**/api/events?**', route => route.fulfill({ json: { events: [{
        uid: 'e2e-issue22-ev', title: 'Print Probe', calendarId: `internal-caldav::/${E2E_USER}/personal/`,
        start: '2026-09-25T10:00:00.000Z', end: '2026-09-25T11:00:00.000Z', allDay: false,
      }], errors: [] } }));
      await page.goto('/?date=2026-09-25');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('.month-grid .event-chip', { hasText: 'Print Probe' })).toBeVisible({ timeout: 10000 });
      // A dialog left open must not end up on paper either.
      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);

      const HIDDEN = ['.sidebar', '.toolbar-nav', '.view-tabs', '.search-wrapper', '#export-pdf-btn', '#invitations-btn',
        '#availability-btn', '#sidebar-settings-btn', '.status-bar', '#event-modal-backdrop'];
      const shown = () => page.evaluate(sels => sels.map(sel => {
        const els = Array.from(document.querySelectorAll(sel));
        return `${sel}: ${els.length ? els.some(el => el.checkVisibility()) : 'missing'}`;
      }), HIDDEN);
      // On screen they are there and visible, so hiding them in print is the stylesheet's doing.
      expect(await shown()).toEqual(HIDDEN.map(sel => `${sel}: true`));

      await page.emulateMedia({ media: 'print' });
      expect(await shown()).toEqual(HIDDEN.map(sel => `${sel}: false`));
      await expect(page.locator('#toolbar-title')).toBeVisible();
      await expect(page.locator('.month-grid')).toBeVisible();

      const print = await page.evaluate(() => {
        const s = sel => getComputedStyle(document.querySelector(sel));
        return {
          bg: s('body').backgroundColor,
          ink: s('body').color,
          overflow: ['.app', '.main', '.calendar-container', '.month-grid'].map(sel => `${sel} ${s(sel).overflowY}`),
          unbroken: ['.month-day', '.event-chip'].map(sel => `${sel} ${s(sel).breakInside}`),
        };
      });
      expect(print).toEqual({
        bg: 'rgb(255, 255, 255)',
        ink: 'rgb(0, 0, 0)',
        overflow: ['.app visible', '.main visible', '.calendar-container visible', '.month-grid visible'],
        unbroken: ['.month-day avoid', '.event-chip avoid'],
      });
    });
  });

  // #404: what the source-grep tests of the smaller frontend modules (tasks, invitations,
  // notifications, account dialog, availability, delegates, dialog focus) were meant to protect,
  // driven in the browser. Server answers are routed where a test needs a failure or a fixed record.
  test.describe('Issue #404 — tasks, invitations, reminders, typography, escaping and dialog focus in the browser', () => {
    let calendarId;
    // #592: the ids name the test's own user, known only once its fixture is set up.
    test.beforeEach(() => {
      calendarId = `internal-caldav::/${E2E_USER}/personal/`;
    });
    const task = fields => ({
      calendarId, href: `/${E2E_USER}/personal/${fields.uid}.ics`, etag: '"e2e-404"', status: 'NEEDS-ACTION', ...fields,
    });
    const timedEvent = (uid, title, start, extra = {}) => ({
      uid, title, calendarId, start, end: new Date(Date.parse(start) + 30 * 60 * 1000).toISOString(), allDay: false,
      href: `/${E2E_USER}/personal/${uid}.ics`, etag: '"e2e-404"', ...extra,
    });

    async function openApp(page, path = '/') {
      await page.goto(path);
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-item').first()).toBeVisible({ timeout: 10000 });
    }

    // A native alert()/confirm() opens a browser dialog; the app must report through toasts and its own dialog.
    function nativeDialogs(page) {
      const seen = [];
      page.on('dialog', d => { seen.push(d.message()); d.dismiss(); });
      return seen;
    }

    // Exactly one toast of `type` says `text`; it is closed so the next one is counted alone.
    async function takeToast(page, type, text) {
      const t = page.locator(`#toast-container .toast.${type}`, { hasText: text });
      await expect(t).toHaveCount(1);
      await expect(t.locator('.toast-msg')).toHaveText(text);
      await t.locator('.toast-close').click();
      await expect(t).toHaveCount(0);
    }

    // `tasks` is the stored list; every create or update is captured and answered with `answer(body)`.
    async function serveTasks(page, tasks, answer = body => body) {
      const saves = [];
      await page.route('**/api/tasks', route => {
        if (route.request().method() === 'GET') return route.fulfill({ json: tasks });
        const body = route.request().postDataJSON();
        saves.push({ method: route.request().method(), body });
        return route.fulfill({ status: 201, json: { ...body, uid: 'e2e-404-new' } });
      });
      await page.route('**/api/tasks/*', route => {
        if (route.request().method() !== 'PUT') return route.fallback();
        const body = route.request().postDataJSON();
        saves.push({ method: 'PUT', body });
        return route.fulfill({ json: answer(body) });
      });
      return saves;
    }

    async function serveEvents(page, events) {
      await mockEvents(page, events);
    }

    test('Issue #165 — failed task and invitation loads show an error, never an empty list', async ({ page }) => {
      const failure = route => route.fulfill({ status: 500, json: { error: 'Server error 500' } });
      await page.route('**/api/tasks', failure);
      await page.route('**/api/events/invitations', failure);
      await openApp(page);

      const taskCount = page.locator('#sidebar-task-count');
      await expect(taskCount).toHaveText('!');
      await expect(taskCount).toHaveAttribute('title', 'Fehler beim Laden der Aufgaben');
      await expect(page.locator('#sidebar-task-list')).toHaveText('Fehler beim Laden der Aufgaben.');

      const inviteBadge = page.locator('#invitations-badge');
      await expect(inviteBadge).toBeVisible();
      await expect(inviteBadge).toHaveText('!');
      await expect(inviteBadge).toHaveAttribute('title', 'Fehler beim Laden der Einladungen');
      await page.click('#invitations-btn');
      await expect(page.locator('#invitations-list-body')).toHaveText('Fehler beim Laden der Einladungen.');
      await page.click('#invitations-modal-close');

      await page.click('#view-kanban');
      await expect(page.locator('.kanban-error-state')).toBeVisible();
      await expect(page.locator('.kanban-error-state .kanban-empty-title')).toHaveText('Fehler beim Laden der Aufgaben');
      await expect(page.getByText('Keine Aufgaben vorhanden')).toHaveCount(0);
    });

    test('Issues #89 / #167 — the board names rules in German and every task action answers with a toast, never alert()', async ({ page }) => {
      const dialogs = nativeDialogs(page);
      const tasks = [
        task({ uid: 'e2e-404-standup', title: 'E2E 404 Standup', due: '2037-08-14T00:00:00.000Z', dueIsDate: true, recurrence: 'FREQ=WEEKLY' }),
        task({ uid: 'e2e-404-review', title: 'E2E 404 Review', status: 'IN-PROCESS', due: '2037-08-13T00:00:00.000Z', dueIsDate: true, recurrence: 'FREQ=WEEKLY' }),
        task({ uid: 'e2e-404-prep', title: 'E2E 404 Prep', due: '2037-08-12T00:00:00.000Z', dueIsDate: true, recurrence: 'RRULE:FREQ=DAILY' }),
        task({ uid: 'e2e-404-report', title: 'E2E 404 Report', recurrence: 'FREQ=MONTHLY' }),
        task({ uid: 'e2e-404-audit', title: 'E2E 404 Audit', recurrence: 'FREQ=YEARLY' }),
        task({ uid: 'e2e-404-single', title: 'E2E 404 Single', due: '2037-08-14T00:00:00.000Z' }),
        task({ uid: 'e2e-404-last', title: 'E2E 404 Last', due: '2037-08-14T00:00:00.000Z', dueIsDate: true, recurrence: 'FREQ=WEEKLY;UNTIL=20370814T000000Z' }),
      ];
      // Stand-in for PUT /api/tasks/:uid, which owns the roll-forward (#95): a series with a next
      // occurrence moves on one week, a one-off task or the last occurrence is completed.
      const saves = await serveTasks(page, tasks, body => (body.recurrence && !body.recurrence.includes('UNTIL'))
        ? { ...body, status: 'NEEDS-ACTION', percentComplete: 0, due: new Date(Date.parse(body.due) + 7 * 864e5).toISOString() }
        : { ...body, status: 'COMPLETED' });
      await page.route('**/api/tasks/*', route => route.request().method() === 'DELETE'
        ? route.fulfill({ status: 500, json: { error: 'API delete failed' } })
        : route.fallback());
      await openApp(page);

      const lastSave = () => saves[saves.length - 1].body;
      await page.locator('#sidebar-task-list .sidebar-task-item', { hasText: 'E2E 404 Standup' }).locator('.sidebar-task-checkbox').click();
      await takeToast(page, 'success', 'Aufgabe auf 21.08.2037 verschoben.');
      // The client hands completion to the server instead of advancing the series itself.
      expect(lastSave()).toMatchObject({ uid: 'e2e-404-standup', status: 'COMPLETED', percentComplete: 100, due: '2037-08-14T00:00:00.000Z' });

      await page.click('#view-kanban');
      const card = title => page.locator('.kanban-card', { hasText: title });
      await expect(card('E2E 404 Standup').locator('.kanban-recurrence-badge')).toHaveText('Wöchentlich');
      await expect(card('E2E 404 Prep').locator('.kanban-recurrence-badge')).toHaveText('Täglich');
      await expect(card('E2E 404 Report').locator('.kanban-recurrence-badge')).toHaveText('Monatlich');
      await expect(card('E2E 404 Audit').locator('.kanban-recurrence-badge')).toHaveText('Jährlich');
      await expect(page.locator('.kanban-board')).not.toContainText('FREQ=');

      await card('E2E 404 Review').locator('.btn-status-next').click();
      await takeToast(page, 'success', 'Aufgabe auf 20.08.2037 verschoben.');
      expect(lastSave()).toMatchObject({ uid: 'e2e-404-review', status: 'COMPLETED', percentComplete: 100 });

      await card('E2E 404 Prep').locator('.btn-complete').click();
      await takeToast(page, 'success', 'Aufgabe auf 19.08.2037 verschoben.');
      expect(lastSave()).toMatchObject({ uid: 'e2e-404-prep', status: 'COMPLETED', percentComplete: 100 });

      await card('E2E 404 Single').locator('.btn-complete').click();
      await takeToast(page, 'success', 'Aufgabe als erledigt markiert.');
      await card('E2E 404 Last').locator('.btn-complete').click();
      await takeToast(page, 'success', 'Aufgabe als erledigt markiert.');
      expect(saves.map(s => s.body.uid)).toEqual(['e2e-404-standup', 'e2e-404-review', 'e2e-404-prep', 'e2e-404-single', 'e2e-404-last']);

      // #167: the title in the confirmation is quoted with „…“.
      await card('E2E 404 Single').locator('.btn-delete').click();
      await expect(page.locator('#confirm-dialog-text')).toHaveText('Aufgabe „E2E 404 Single“ wirklich löschen?');
      await page.click('#confirm-dialog-ok');
      await takeToast(page, 'error', 'Fehler beim Löschen: API delete failed');
      expect(dialogs).toEqual([]);
    });

    test('Issue #273 — editing a task keeps DTSTART, PERCENT-COMPLETE and its completions; a new task starts empty', async ({ page }) => {
      const stored = task({
        uid: 'e2e-404-progress', title: 'E2E 404 Fortgang', description: 'Testbeschreibung', status: 'IN-PROCESS',
        due: '2037-09-15T18:00:00.000Z', dtstart: '2037-09-01T09:00:00.000Z', priority: 2, percentComplete: 65,
        completed: null, completedHistory: ['2037-08-15T10:00:00.000Z'], recurrence: 'FREQ=MONTHLY',
      });
      const saves = await serveTasks(page, [stored]);
      await openApp(page);

      await page.locator('#sidebar-task-list .sidebar-task-info', { hasText: stored.title }).click();
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#task-title')).toHaveValue(stored.title);
      await expect(page.locator('#task-status')).toHaveValue('IN-PROCESS');
      await expect(page.locator('#task-dtstart')).toHaveValue('2037-09-01T11:00');
      await expect(page.locator('#task-percent-complete')).toHaveValue('65');
      await page.fill('#task-title', `${stored.title} (Aktualisiert)`);
      await page.click('#task-save-btn');
      await expect.poll(() => saves.length).toBe(1);
      expect(saves[0].method).toBe('PUT');
      expect(saves[0].body).toMatchObject({
        title: `${stored.title} (Aktualisiert)`, dtstart: stored.dtstart, percentComplete: 65,
        completed: null, completedHistory: stored.completedHistory,
      });
      await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/);

      await page.click('#new-task-btn');
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#task-title')).toHaveValue('');
      await expect(page.locator('#task-dtstart')).toHaveValue('');
      await expect(page.locator('#task-percent-complete')).toHaveValue('');
      await page.fill('#task-title', 'E2E 404 Neu');
      await page.click('#task-save-btn');
      await expect.poll(() => saves.length).toBe(2);
      expect(saves[1].method).toBe('POST');
      const created = saves[1].body;
      expect(created.title).toBe('E2E 404 Neu');
      expect(created).not.toHaveProperty('completed');
      expect(created).not.toHaveProperty('completedHistory');
      expect(created.dtstart ?? null).toBeNull();
      expect(created.percentComplete ?? null).toBeNull();
    });

    test('Issues #77 / #89 — an RSVP sends the address the server named for the user; a failed one is an error toast', async ({ page }) => {
      const dialogs = nativeDialogs(page);
      // Not the address the client once hard-coded (testuser@example.com), so only the server's value can reach the request.
      const invitation = {
        uid: 'e2e-404-invite', title: 'E2E 404 Team Sync', calendarId, href: `/${E2E_USER}/personal/e2e-404-invite.ics`,
        start: '2037-06-10T07:00:00.000Z', userEmail: 'testuser2@example.com',
        organizer: { name: 'Test User', email: 'testuser@example.com' },
        attendees: [{ name: 'Test User', email: 'testuser2@example.com', status: 'NEEDS-ACTION' }],
      };
      await page.route('**/api/events/invitations', route => route.fulfill({ json: [invitation] }));
      const rsvps = [];
      let failRsvp = false;
      await page.route('**/api/events/*/rsvp', route => {
        rsvps.push(route.request().postDataJSON());
        return failRsvp
          ? route.fulfill({ status: 500, json: { error: 'CalDAV 500 Internal Server Error' } })
          : route.fulfill({ json: { success: true, status: 'ACCEPTED' } });
      });
      await openApp(page);
      await expect(page.locator('#invitations-badge')).toHaveText('1');
      await page.click('#invitations-btn');
      const card = page.locator('#invitations-list-body .invitation-card', { hasText: invitation.title });

      await card.getByRole('button', { name: 'Zusagen' }).click();
      await expect.poll(() => rsvps.length).toBe(1);
      expect(rsvps[0]).toEqual({ calendarId, href: invitation.href, email: 'testuser2@example.com', status: 'ACCEPTED' });

      failRsvp = true;
      await card.getByRole('button', { name: 'Absagen' }).click();
      await takeToast(page, 'error', 'RSVP konnte nicht gespeichert werden: CalDAV 500 Internal Server Error');
      expect(rsvps[1].status).toBe('DECLINED');
      expect(dialogs).toEqual([]);
    });

    test('Issue #202 — calendar, booking page and delegate fields from the server render as text and keep their values', async ({ page }) => {
      const markup = sink => `<img src=x onerror="document.body.dataset.xss404='${sink}'">`;
      const calendar = { id: 'e2e-404-cal" data-pwn="calendar', name: `${markup('calendar')}Test User`, color: '#3b82f6', supportsVEVENT: true, supportsVTODO: false };
      const bookingPage = {
        id: 'e2e-404-page" data-pwn="page', slug: 'e2e-404"slug', title: `${markup('page')}Sprechstunde`,
        calendarId: calendar.id, busyCalendarIds: [], durationMinutes: 30, weeklyHours: [[], [{ start: '09:00', end: '17:00' }], [], [], [], [], []], bufferMinutes: 0, maxBookingsPerDay: null, minNoticeMinutes: 0,
      };
      await openApp(page);
      await mockCalendars(page, [calendar]);
      await page.route('**/api/availability-slots', route => route.fulfill({ json: [bookingPage] }));
      const deleted = [];
      await page.route('**/api/availability-slots/*', route => {
        deleted.push(new URL(route.request().url()).pathname);
        return route.fulfill({ json: { success: true } });
      });

      await page.click('#availability-btn');
      const modal = page.locator('#availability-modal-backdrop');
      const option = page.locator('#ap-calendar option');
      await expect(option).toHaveCount(1);
      expect(await option.evaluate(o => [o.value, o.textContent.trim()])).toEqual([calendar.id, calendar.name]);
      await expect(page.locator('#ap-busy-calendars input[type="checkbox"]')).toHaveAttribute('value', calendar.id);
      const card = page.locator('#availability-pages-list .availability-page-card');
      await expect(card.locator('strong')).toHaveText(bookingPage.title);
      const origin = new URL(page.url()).origin;
      await expect(card.locator('.copy-link-btn')).toHaveAttribute('data-url', `${origin}/public/booking/?slug=${encodeURIComponent(bookingPage.slug)}`);
      await expect(card.locator('.delete-page-btn')).toHaveAttribute('data-id', bookingPage.id);
      await expect(modal.locator('img, [data-pwn]')).toHaveCount(0);

      await card.locator('.delete-page-btn').click();
      await page.click('#confirm-dialog-ok');
      await expect.poll(() => deleted).toEqual([`/api/availability-slots/${encodeURIComponent(bookingPage.id)}`]);

      // The delegate list module is served but no page loads it yet; its renderer is exercised directly.
      await page.addScriptTag({ url: '/js/delegates.js' });
      const delegate = {
        id: 'e2e-404-delegate" data-pwn="delegate', delegate_user_id: `${markup('delegate')}testuser`,
        role: '<b>DELEGATE_WRITE</b>', can_manage_invitations: 1, can_view_private: 0,
      };
      const revokedId = await page.evaluate(d => {
        const box = document.createElement('div');
        box.id = 'e2e-404-delegates';
        document.body.appendChild(box);
        let revoked = null;
        window.DelegatesModule.renderDelegatesList([d], box, async id => { revoked = id; });
        box.querySelector('.revoke-delegate-btn').click();
        return revoked;
      }, delegate);
      expect(revokedId).toBe(delegate.id);
      const item = page.locator('#e2e-404-delegates .delegate-item');
      await expect(item).toHaveAttribute('data-id', delegate.id);
      await expect(item.locator('.font-semibold')).toHaveText(delegate.delegate_user_id);
      await expect(item).toContainText(`Rolle: ${delegate.role}`);
      await expect(page.locator('#e2e-404-delegates').locator('img, b, [data-pwn]')).toHaveCount(0);
      expect(await page.evaluate(() => document.body.dataset.xss404)).toBeUndefined();
    });

    test.describe('in an English-speaking browser', () => {
      test.use({ locale: 'en-US' });

      test('Issue #166 — a reminder names the start time on the 24-hour clock', async ({ page }) => {
        const start = new Date(Date.now() + 10 * 60 * 1000);
        const title = `E2E 404 Reminder ${start.getTime()}`;
        await serveEvents(page, [timedEvent(`e2e-404-reminder-${start.getTime()}`, title, start.toISOString(), {
          alarms: [{ action: 'DISPLAY', trigger: '-PT30M' }],
        })]);
        await openApp(page);
        await page.evaluate(() => window.__checkAndTriggerAlarms());

        const clock = start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
        expect(clock).toMatch(/^\d{2}:\d{2}$/);
        const reminder = page.locator('#toast-container .toast.info', { hasText: title });
        await expect(reminder).toHaveCount(1);
        await expect(reminder.locator('.toast-msg')).toHaveText(`Erinnerung: ${title} — Zeit: ${clock}`);
      });
    });

    test('Issue #167 — German counts, range titles and „…“ quotes in the views, search and account dialog', async ({ page }) => {
      const day = (date, n) => Array.from({ length: n }, (_, i) =>
        timedEvent(`e2e-404-busy-${date}-${i}`, `E2E 404 Busy ${i}`, new Date(`${date}T09:00:00+02:00`).toISOString()));
      await serveEvents(page, [...day('2037-06-10', 13), ...day('2037-06-11', 14)]);
      await openApp(page, '/?date=2037-06-10');
      await expect(page.locator('.month-more')).toHaveText(['+1 weiterer', '+2 weitere']);

      await page.click('#view-week');
      await expect(page.locator('#toolbar-title')).toHaveText('8. – 14. Juni 2037');
      await openApp(page, '/?date=2037-06-30');
      await page.click('#view-week');
      await expect(page.locator('#toolbar-title')).toHaveText(/^29\. Jun\.? – 5\. Jul\.? 2037$/);

      await page.click('#view-month');
      await page.fill('#search-input', 'zzz-e2e-404');
      await expect(page.locator('.search-empty-banner')).toContainText('Keine Termine für „zzz-e2e-404“ gefunden.');
      await page.fill('#search-input', '');

      await page.route('**/api/accounts', route => route.request().method() === 'POST'
        ? route.fulfill({ status: 201, json: { id: 'e2e-404-account', ...route.request().postDataJSON() } })
        : route.fallback());
      await page.click('#sidebar-settings-btn');
      await page.click('#settings-add-account-btn');
      await expect(page.locator('#account-modal-backdrop')).not.toHaveClass(/hidden/);
      await page.fill('#acc-url', 'https://dav.example.com/calendars/testuser/');
      await page.fill('#acc-username', 'testuser');
      await page.fill('#acc-password', 'e2e-404-password');
      await page.fill('#acc-displayname', 'Test User');
      await page.click('#account-save-btn');
      await takeToast(page, 'success', 'Account „Test User“ hinzugefügt.');
    });

    test('Issue #87 — Tab stays inside the dialog on visible controls, wraps both ways, and Escape closes each dialog back to its opener', async ({ page }) => {
      await openApp(page);
      await page.click('#new-event-btn');
      await expect(page.locator('#ev-title')).toBeFocused();

      // Walk the Tab order until it comes back to the first stop.
      const step = () => page.evaluate(() => {
        const el = document.activeElement;
        const stops = (window.__e2e404Stops ||= []);
        const wrapped = stops.length > 0 && el === stops[0];
        if (!wrapped) stops.push(el);
        return {
          wrapped, id: el.id, inside: document.getElementById('event-modal-backdrop').contains(el),
          visible: el.checkVisibility(), enabled: !el.disabled, tabindex: el.getAttribute('tabindex'), type: el.getAttribute('type'),
        };
      });
      const stops = [];
      for (let stop = await step(); !stop.wrapped; stop = await step()) {
        stops.push(stop);
        expect(stops.length).toBeLessThan(100);
        await page.keyboard.press('Tab');
      }
      expect(stops.length).toBeGreaterThan(3);
      for (const s of stops) {
        expect(s, `Tab stop ${s.id}`).toMatchObject({ inside: true, visible: true, enabled: true });
        expect(s.tabindex).not.toBe('-1');
        expect(s.type).not.toBe('hidden');
      }
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => document.activeElement === window.__e2e404Stops.at(-1))).toBe(true);
      await page.keyboard.press('Tab');
      await expect(page.locator('#ev-title')).toBeFocused();

      // Controls the user cannot reach (hidden group, hidden input, disabled, tabindex=-1) after the
      // last visible one must not count as the dialog's edge: Tab still wraps from the last visible control.
      await page.evaluate(() => {
        const tail = document.createElement('div');
        tail.id = 'e2e-404-unreachable';
        tail.innerHTML = '<div class="form-group hidden"><input id="e2e-404-in-hidden-group"></div>'
          + '<input type="hidden" id="e2e-404-hidden-input"><button disabled>x</button><button tabindex="-1">y</button>';
        document.getElementById('event-modal').appendChild(tail);
      });
      // The dialog's edges: the close button comes first, the save button last.
      await page.locator('#event-save-btn').focus();
      await page.keyboard.press('Tab');
      await expect(page.locator('#event-modal-close')).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator('#event-save-btn')).toBeFocused();
      await page.evaluate(() => document.getElementById('e2e-404-unreachable').remove());
      await page.locator('#ev-title').focus();
      await page.keyboard.press('Escape');
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
      await expect(page.locator('#new-event-btn')).toBeFocused();

      for (const [opener, dialog] of [
        ['#new-task-btn', '#task-modal-backdrop'],
        ['#invitations-btn', '#invitations-modal-backdrop'],
        ['#availability-btn', '#availability-modal-backdrop'],
        ['#add-webcal-btn', '#webcal-modal-backdrop'],
      ]) {
        await page.click(opener);
        await expect(page.locator(dialog)).not.toHaveClass(/hidden/);
        await expect(page.locator(`${dialog} :focus`)).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator(dialog), dialog).toHaveClass(/hidden/);
        await expect(page.locator(opener), opener).toBeFocused();
      }

      // A dialog opened from the settings drawer closes first; the next Escape closes the drawer.
      await page.click('#sidebar-settings-btn');
      const drawer = page.locator('#settings-drawer');
      await expect(drawer).toHaveClass(/\bopen\b/);
      await page.click('#settings-add-account-btn');
      await expect(page.locator('#account-modal-backdrop')).not.toHaveClass(/hidden/);
      await page.keyboard.press('Escape');
      await expect(page.locator('#account-modal-backdrop')).toHaveClass(/hidden/);
      await expect(drawer).toHaveClass(/\bopen\b/);
      await page.keyboard.press('Escape');
      await expect(drawer).not.toHaveClass(/\bopen\b/);
      await expect(page.locator('#sidebar-settings-btn')).toBeFocused();

      // Shortcuts are not taken from a focused button, so the key goes to the page itself.
      await page.evaluate(() => document.activeElement.blur());
      await page.keyboard.press('Alt+h');
      await expect(page.locator('#shortcuts-modal-backdrop')).not.toHaveClass(/hidden/);
      await page.keyboard.press('Escape');
      await expect(page.locator('#shortcuts-modal-backdrop')).toHaveClass(/hidden/);
    });

    test('Issue #87 — Escape on a confirmation cancels it, so a later confirmation does not also run the cancelled action', async ({ page }) => {
      await serveTasks(page, [task({ uid: 'e2e-404-keep', title: 'E2E 404 Keep' }), task({ uid: 'e2e-404-drop', title: 'E2E 404 Drop' })]);
      const deleted = [];
      await page.route('**/api/tasks/*', route => {
        if (route.request().method() !== 'DELETE') return route.fallback();
        deleted.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()));
        return route.fulfill({ json: { success: true } });
      });
      await openApp(page);
      await page.click('#view-kanban');
      const confirm = page.locator('#confirm-dialog-backdrop');

      await page.locator('.kanban-card', { hasText: 'E2E 404 Keep' }).locator('.btn-delete').click();
      await expect(confirm).not.toHaveClass(/hidden/);
      await page.keyboard.press('Escape');
      await expect(confirm).toHaveClass(/hidden/);

      await page.locator('.kanban-card', { hasText: 'E2E 404 Drop' }).locator('.btn-delete').click();
      await expect(page.locator('#confirm-dialog-text')).toHaveText('Aufgabe „E2E 404 Drop“ wirklich löschen?');
      await page.click('#confirm-dialog-ok');
      await takeToast(page, 'info', 'Aufgabe gelöscht.');
      expect(deleted).toEqual(['e2e-404-drop']);
    });
  });

  test.describe('Issue #494 — changing the calendar in the edit dialog moves the event', () => {
    const RANGE = 'start=2038-03-01T00:00:00Z&end=2038-04-01T00:00:00Z';
    let sourceId;
    let targetId;

    async function createCalendar(page, name) {
      const res = await page.request.post('/api/calendars', {
        headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name, type: 'calendar' }
      });
      expect(res.status()).toBe(201);
      return (await res.json()).id;
    }

    async function titlesIn(page, calendarId) {
      const res = await page.request.get(`/api/events?${RANGE}&calendarId=${encodeURIComponent(calendarId)}`);
      expect(res.ok()).toBeTruthy();
      return (await res.json()).events.map(e => e.title).sort();
    }

    async function createEvent(page, data) {
      const res = await page.request.post('/api/events', { headers: SAME_ORIGIN, data: { calendarId: sourceId, ...data } });
      expect(res.status()).toBe(201);
    }

    async function editAt(page, date, title) {
      await page.goto(`/?date=${date}`);
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.locator('.event-chip').filter({ hasText: title }).first().click();
      await page.click('#popover-edit-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#ev-calendar')).toHaveValue(sourceId);
    }

    test.beforeEach(async ({ page }) => {
      // Loading the app signs the browser in; the API calls below share its session.
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const run = Date.now().toString(36);
      sourceId = await createCalendar(page, `E2E 494 test2 ${run}`);
      targetId = await createCalendar(page, `E2E 494 Ziel ${run}`);
      // No per-test cleanup: e2e/global-teardown.js drops the run's whole principal.
    });

    test('an event saved with another calendar is stored there and no longer in the old one', async ({ page }) => {
      await createEvent(page, { title: 'safdsaf', start: '2038-03-10T10:00:00.000Z', end: '2038-03-10T11:00:00.000Z' });
      await editAt(page, '2038-03-10', 'safdsaf');

      await page.selectOption('#ev-calendar', targetId);
      await page.click('#event-save-btn');
      await expect(page.locator('#toast-container .toast.success', { hasText: 'Termin gespeichert.' })).toBeVisible({ timeout: 10000 });
      await expectSavesLanded(page);

      expect(await titlesIn(page, targetId)).toEqual(['safdsaf']);
      expect(await titlesIn(page, sourceId)).toEqual([]);
      // #571: after a reload the stored state, not the optimistic preview, is shown; reopened,
      // the dialog shows the new calendar.
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expect(await titlesIn(page, targetId)).toEqual(['safdsaf']);
      expect(await titlesIn(page, sourceId)).toEqual([]);
      await page.locator('.event-chip').filter({ hasText: 'safdsaf' }).first().click();
      await page.click('#popover-edit-btn');
      await expect(page.locator('#ev-calendar')).toHaveValue(targetId);
    });

    test('an occurrence moved to another calendar takes the whole series with it, without asking for a scope', async ({ page }) => {
      await createEvent(page, {
        title: 'E2E 494 Serie', start: '2038-03-15T10:00:00.000Z', end: '2038-03-15T11:00:00.000Z', recurrence: 'FREQ=DAILY;COUNT=3'
      });
      await editAt(page, '2038-03-16', 'E2E 494 Serie');

      await page.selectOption('#ev-calendar', targetId);
      await page.click('#event-save-btn');
      await expect(page.locator('#scope-dialog-backdrop')).toHaveClass(/hidden/);
      await expect(page.locator('#toast-container .toast.success', { hasText: 'Termin gespeichert.' })).toBeVisible({ timeout: 10000 });
      await expectSavesLanded(page);

      expect(await titlesIn(page, targetId)).toEqual(['E2E 494 Serie', 'E2E 494 Serie', 'E2E 494 Serie']);
      expect(await titlesIn(page, sourceId)).toEqual([]);
    });

    test('a failed move says so, reopens the dialog and leaves the event in its calendar', async ({ page }) => {
      await createEvent(page, { title: 'E2E 494 bleibt', start: '2038-03-11T10:00:00.000Z', end: '2038-03-11T11:00:00.000Z' });
      await editAt(page, '2038-03-11', 'E2E 494 bleibt');
      await page.route('**/api/events/*', route => (route.request().method() === 'PUT'
        ? route.fulfill({ status: 502, json: { error: 'Zielkalender nicht erreichbar' } })
        : route.fallback()));

      await page.selectOption('#ev-calendar', targetId);
      await page.click('#event-save-btn');
      await expect(page.locator('#toast-container .toast.error', { hasText: 'Zielkalender nicht erreichbar' })).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#event-form-error')).toHaveText('Zielkalender nicht erreichbar');

      expect(await titlesIn(page, sourceId)).toEqual(['E2E 494 bleibt']);
      expect(await titlesIn(page, targetId)).toEqual([]);
    });
  });

  test.describe('Issue #571 — with the service worker running, a deployed version takes effect on the next load', () => {
    const http = require('http');
    // #357: the worker's own requests (its script and update checks, the precache, its fetches)
    // carry no extraHTTPHeaders, and Playwright does not even route the browser's update check.
    // So the browser goes through a forward proxy that adds the platform proxy's headers to every
    // request, as the real one does. It also serves the "deployed" variant of the files in `deployed`.
    let proxy;
    let deployed;
    // #583: requests to HELD_PATH stay unanswered until the test ends them, a slow request in flight.
    const HELD_PATH = '/api/e2e-held';
    const held = [];

    test.beforeAll(async () => {
      const upstream = new URL(webServer.url);
      proxy = http.createServer((req, res) => {
        const { pathname, search } = new URL(req.url);
        if (pathname === HELD_PATH) {
          held.push(res);
          return;
        }
        const variant = deployed[pathname];
        const headers = {
          ...req.headers,
          'x-freeshard-secret': webServer.env.HTTP_HEADER_AUTH_SECRET,
          'x-forwarded-user': E2E_USER,
          'x-ptl-client-type': 'terminal',
          ...(variant ? { 'accept-encoding': 'identity' } : {}),
        };
        const forward = http.request({
          host: upstream.hostname, port: upstream.port, path: pathname + search, method: req.method, headers,
        }, (answer) => {
          if (!variant) {
            res.writeHead(answer.statusCode, answer.headers);
            answer.pipe(res);
            return;
          }
          let body = '';
          answer.setEncoding('utf8');
          answer.on('data', (chunk) => { body += chunk; });
          answer.on('end', () => {
            const { 'content-length': _length, etag: _etag, 'last-modified': _modified, ...rest } = answer.headers;
            res.writeHead(answer.statusCode, rest);
            res.end(`${body}\n;self.__e2eDeployed = ${JSON.stringify(variant)};\n`);
          });
        });
        forward.on('error', (err) => res.destroy(err));
        req.pipe(forward);
      });
      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    });

    test.afterAll(async () => {
      await new Promise((resolve) => proxy.close(resolve));
    });

    async function controlledPage(browser) {
      const context = await browser.newContext({
        serviceWorkers: 'allow',
        // Chromium sends loopback requests past a proxy unless told otherwise.
        proxy: { server: `http://127.0.0.1:${proxy.address().port}`, bypass: '<-loopback>' },
      });
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 10000 }).toBe(true);
      return { context, page };
    }

    test('a changed app asset is used after one reload, not the copy the worker cached', async ({ browser }) => {
      deployed = { '/js/safeUrl.js': 'v1' };
      const { context, page } = await controlledPage(browser);
      // The worker precached the asset on install, so a stale copy is in its cache.
      expect(await page.evaluate(() => window.__e2eDeployed)).toBe('v1');

      deployed = { '/js/safeUrl.js': 'v2' };
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
      expect(await page.evaluate(() => window.__e2eDeployed)).toBe('v2');
      await context.close();
    });

    test('a new worker taking over offers to reload, and the reload runs the new version', async ({ browser }) => {
      deployed = { '/js/safeUrl.js': 'v1', '/sw.js': 'sw1' };
      const { context, page } = await controlledPage(browser);
      const banner = page.locator('#update-banner');
      await expect(banner).toBeHidden();

      // A deploy while the page is open: the worker checks for an update and installs it.
      deployed = { '/js/safeUrl.js': 'v2', '/sw.js': 'sw2' };
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then(reg => reg.update()));

      await expect(banner).toBeVisible({ timeout: 10000 });
      await expect(banner).toContainText('Neue Version');
      expect(await page.evaluate(() => window.__e2eDeployed)).toBe('v1');
      // The page reloads once the new worker leaves `installed` (#583), not on the click itself.
      const reloaded = page.waitForEvent('load');
      await banner.getByRole('button', { name: 'Neu laden' }).click();
      await reloaded;
      expect(await page.evaluate(() => window.__e2eDeployed)).toBe('v2');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(banner).toBeHidden();
      await context.close();
    });

    // #583: a new worker only takes over once the old one has no fetch in flight, and Chromium may
    // keep it waiting long after that. The banner must not depend on the takeover: the app shell is
    // network-first, so a reload runs the new version whichever worker controls the page.
    test('a deploy while a request is still in flight offers to reload, and the reload runs the new version', async ({ browser }) => {
      deployed = { '/js/safeUrl.js': 'v1', '/sw.js': 'sw1' };
      const { context, page } = await controlledPage(browser);
      const banner = page.locator('#update-banner');
      await expect(banner).toBeHidden();

      // A slow request goes through the current worker and stays open across the deploy.
      await page.evaluate((path) => { window.__e2eHeld = fetch(path).then(res => res.status); }, HELD_PATH);
      await expect.poll(() => held.length, { timeout: 10000 }).toBe(1);

      deployed = { '/js/safeUrl.js': 'v2', '/sw.js': 'sw2' };
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then(reg => reg.update()));

      await expect(banner).toBeVisible({ timeout: 10000 });
      await expect(banner).toContainText('Neue Version');
      expect(await page.evaluate(() => window.__e2eDeployed)).toBe('v1');

      held.splice(0).forEach(res => res.writeHead(204).end());
      expect(await page.evaluate(() => window.__e2eHeld)).toBe(204);
      // The page reloads once the new worker leaves `installed` (#583), not on the click itself.
      const reloaded = page.waitForEvent('load');
      await banner.getByRole('button', { name: 'Neu laden' }).click();
      await reloaded;
      expect(await page.evaluate(() => window.__e2eDeployed)).toBe('v2');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(banner).toBeHidden();
      await context.close();
    });
  });

  test.describe('Issue #495 — tasks only go into task lists; a task stranded in a Google calendar moves out', () => {
    const { Agent } = require('undici');
    const crypto = require('crypto');
    let listId;
    let googleId;
    let title;

    // Straight to Radicale, as the sync worker does: the run's principal, the system sync secret.
    async function radicale(method, path, body, headers = {}) {
      const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
      try {
        const res = await fetch(`${webServer.env.INTERNAL_CALDAV_URL}${path}`, {
          method, body, dispatcher,
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${E2E_USER}:${webServer.env.SYSTEM_SYNC_SECRET}`).toString('base64'),
            'Accept-Encoding': 'identity',
            ...headers,
          },
        });
        expect(res.status, `${method} ${path}`).toBe(201);
      } finally {
        await dispatcher.close();
      }
    }

    async function titlesIn(page, calendarId) {
      const res = await page.request.get(`/api/tasks?calendarId=${encodeURIComponent(calendarId)}`);
      expect(res.ok()).toBeTruthy();
      return (await res.json()).map(t => t.title).sort();
    }

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const run = Date.now().toString(36);
      const res = await page.request.post('/api/calendars', {
        headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name: `E2E 495 Liste ${run}`, type: 'tasklist' }
      });
      expect(res.status()).toBe(201);
      listId = (await res.json()).id;

      // The local mirror of a Google calendar, created VEVENT-only like the sync worker does, holding
      // a task from before: Radicale stores a VTODO in any collection.
      title = `E2E 495 test1 ${run}`;
      const google = `/${E2E_USER}/google-${crypto.randomBytes(16).toString('hex')}/`;
      googleId = `internal-caldav::${google}`;
      await radicale('MKCALENDAR', google, `<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>
<d:displayname>E2E 495 Google ${run}</d:displayname>
<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
</d:prop></d:set></c:mkcalendar>`);
      await radicale('PUT', `${google}e2e-495-test1.ics`,
        'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//e2e//EN\r\nBEGIN:VTODO\r\nUID:e2e-495-test1\r\n'
        + `DTSTAMP:20261001T000000Z\r\nSUMMARY:${title}\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`,
        { 'Content-Type': 'text/calendar; charset=utf-8' });
      // No per-test cleanup: e2e/global-teardown.js drops the run's whole principal.

      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator(`#calendar-list .calendar-item[data-cal-id="${googleId}"]`)).toBeVisible({ timeout: 10000 });
    });

    test('the new-task dialog offers task lists only, not the Google calendar', async ({ page }) => {
      await page.click('#new-task-btn');
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/);
      const options = await page.locator('#task-calendar-id option').evaluateAll(os => os.map(o => o.value));
      expect(options).toContain(listId);
      expect(options).not.toContain(googleId);
    });

    test('a task stranded in the Google calendar is moved to a task list from its dialog', async ({ page }) => {
      const item = page.locator('#sidebar-task-list .sidebar-task-info', { hasText: title });
      await item.click();
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/);
      // Its current place is shown but cannot be chosen again.
      await expect(page.locator('#task-calendar-id')).toHaveValue(googleId);
      await expect(page.locator(`#task-calendar-id option[value="${googleId}"]`)).toBeDisabled();

      await page.selectOption('#task-calendar-id', listId);
      await page.click('#task-save-btn');
      await expect(page.locator('#toast-container .toast.success', { hasText: 'Aufgabe gespeichert.' })).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/);

      expect(await titlesIn(page, listId)).toEqual([title]);
      expect(await titlesIn(page, googleId)).toEqual([]);
      // Reopened after a reload, the dialog shows the new list.
      await page.reload();
      await item.click();
      await expect(page.locator('#task-calendar-id')).toHaveValue(listId);
    });

    test('saving a stranded task into its Google calendar is refused with a clear error', async ({ page }) => {
      await page.locator('#sidebar-task-list .sidebar-task-info', { hasText: title }).click();
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/);
      await page.fill('#task-title', 'E2E 495 renamed');
      await page.click('#task-save-btn');
      await expect(page.locator('#toast-container .toast.error', { hasText: 'does not accept tasks' })).toBeVisible({ timeout: 10000 });
      expect(await titlesIn(page, googleId)).toEqual([title]);
    });

    test('#572: a stranded task says Google takes no tasks; a task in a list has no such hint', async ({ page }) => {
      const hint = page.locator('#task-stranded-hint');
      await page.locator('#sidebar-task-list .sidebar-task-info', { hasText: title }).click();
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(hint).toBeVisible();
      await expect(hint).toHaveText('Google nimmt keine Aufgaben an, bitte in eine Aufgabenliste verschieben');

      // Moved out, the same task opens without the hint.
      await page.selectOption('#task-calendar-id', listId);
      await page.click('#task-save-btn');
      await expect(page.locator('#task-modal-backdrop')).toHaveClass(/hidden/, { timeout: 10000 });
      expect(await titlesIn(page, listId)).toEqual([title]);
      await page.reload();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.locator('#sidebar-task-list .sidebar-task-info', { hasText: title }).click();
      await expect(page.locator('#task-calendar-id')).toHaveValue(listId);
      await expect(hint).toBeHidden();
    });
  });
  test.describe('Issue #500 — a collection is a Kalender, an Aufgabenliste or explicitly both', () => {
    const { Agent } = require('undici');

    // The collection's supported-calendar-component-set, read straight from Radicale.
    async function componentsInRadicale(path) {
      const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
      try {
        const res = await fetch(`${webServer.env.INTERNAL_CALDAV_URL}${path}`, {
          method: 'PROPFIND', dispatcher,
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${E2E_USER}:${webServer.env.SYSTEM_SYNC_SECRET}`).toString('base64'),
            'Accept-Encoding': 'identity',
            'Content-Type': 'application/xml; charset=utf-8',
            Depth: '0',
          },
          body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            + '<d:prop><c:supported-calendar-component-set/></d:prop></d:propfind>',
        });
        expect(res.status, `PROPFIND ${path}`).toBe(207);
        const xml = await res.text();
        const set = xml.match(/supported-calendar-component-set[^>]*>([\s\S]*?)<\/[^>]*supported-calendar-component-set>/);
        expect(set, xml).not.toBeNull();
        return [...set[1].matchAll(/name="([A-Z]+)"/g)].map(m => m[1]).sort();
      } finally {
        await dispatcher.close();
      }
    }

    const slugOf = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const sidebarItem = (page, id) => page.locator(`#calendar-list .calendar-item[data-cal-id="${id}"]`);

    async function createInDialog(page, name, type) {
      await page.click('#add-calendar-btn');
      await expect(page.locator('#add-cal-dialog-backdrop')).toBeVisible();
      if (type) await page.selectOption('#add-cal-type', type);
      await page.fill('#add-cal-name', name);
      await page.click('#add-cal-submit');
      await expect(page.locator('#add-cal-dialog-backdrop')).toHaveCount(0, { timeout: 10000 });
      return `internal-caldav::/${E2E_USER}/${slugOf(name)}/`;
    }

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });
    });

    test('a new user gets a Kalender and a separate Aufgabenliste; each view lists its own', async ({ page }) => {
      expect(await componentsInRadicale(`/${E2E_USER}/personal/`)).toEqual(['VEVENT']);
      expect(await componentsInRadicale(`/${E2E_USER}/tasks/`)).toEqual(['VTODO']);
      const personalId = `internal-caldav::/${E2E_USER}/personal/`;
      const tasksId = `internal-caldav::/${E2E_USER}/tasks/`;

      await expect(page.locator('#calendar-list-title')).toHaveText('Kalender');
      await expect(sidebarItem(page, personalId)).toBeVisible();
      await expect(sidebarItem(page, tasksId)).toHaveCount(0);

      await page.click('#view-kanban');
      await expect(page.locator('#calendar-list-title')).toHaveText('Aufgabenlisten');
      await expect(page.locator('#add-calendar-btn')).toHaveAttribute('aria-label', 'Aufgabenliste hinzufügen');
      await expect(sidebarItem(page, tasksId)).toBeVisible();
      await expect(sidebarItem(page, personalId)).toHaveCount(0);

      // The pickers follow the same split, and the task dialog names the field accordingly.
      await page.click('#new-task-btn');
      await expect(page.locator('label[for="task-calendar-id"]')).toHaveText('Aufgabenliste');
      const taskOptions = await page.locator('#task-calendar-id option').evaluateAll(os => os.map(o => o.value));
      expect(taskOptions).toContain(tasksId);
      expect(taskOptions).not.toContain(personalId);
      await page.click('#task-cancel-btn');

      await page.click('#view-month');
      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      const eventOptions = await page.locator('#ev-calendar option').evaluateAll(os => os.map(o => o.value));
      expect(eventOptions).toContain(personalId);
      expect(eventOptions).not.toContain(tasksId);
    });

    test('created in the task view, the new collection is an Aufgabenliste', async ({ page }) => {
      await page.click('#view-kanban');
      await page.click('#add-calendar-btn');
      await expect(page.locator('#add-cal-dialog-title')).toHaveText('Neue Aufgabenliste');
      await expect(page.locator('#add-cal-type')).toHaveValue('tasklist');
      await page.click('#add-cal-cancel');

      const name = `E2E 500 Einkauf ${Date.now().toString(36)}`;
      const id = await createInDialog(page, name);
      await expect(page.locator('#toast-container .toast.success', { hasText: `Aufgabenliste „${name}“ erstellt.` })).toBeVisible();
      expect(await componentsInRadicale(`/${E2E_USER}/${slugOf(name)}/`)).toEqual(['VTODO']);
      await expect(sidebarItem(page, id)).toBeVisible();

      await page.click('#view-month');
      await expect(sidebarItem(page, id)).toHaveCount(0);

      // Settings name it by its type.
      await page.click('#sidebar-settings-btn');
      const row = page.locator('#settings-calendar-list .settings-item', { hasText: name });
      await expect(row.locator('.settings-item-type')).toHaveText('Aufgabenliste');
      await expect(row.locator('[data-delete-cal-settings]')).toHaveAttribute('aria-label', 'Aufgabenliste löschen');
    });

    test('created in a calendar view, the new collection is a Kalender', async ({ page }) => {
      await page.click('#add-calendar-btn');
      await expect(page.locator('#add-cal-dialog-title')).toHaveText('Neuer Kalender');
      await expect(page.locator('#add-cal-type')).toHaveValue('calendar');
      await page.click('#add-cal-cancel');

      const name = `E2E 500 Termine ${Date.now().toString(36)}`;
      const id = await createInDialog(page, name);
      await expect(page.locator('#toast-container .toast.success', { hasText: `Kalender „${name}“ erstellt.` })).toBeVisible();
      expect(await componentsInRadicale(`/${E2E_USER}/${slugOf(name)}/`)).toEqual(['VEVENT']);
      await expect(sidebarItem(page, id)).toBeVisible();

      await page.click('#view-kanban');
      await expect(sidebarItem(page, id)).toHaveCount(0);
    });

    test('a mixed collection is an explicit choice and shows in both views', async ({ page }) => {
      const name = `E2E 500 Gemischt ${Date.now().toString(36)}`;
      const id = await createInDialog(page, name, 'mixed');
      expect(await componentsInRadicale(`/${E2E_USER}/${slugOf(name)}/`)).toEqual(['VEVENT', 'VTODO']);
      await expect(sidebarItem(page, id)).toBeVisible();
      await page.click('#view-kanban');
      await expect(sidebarItem(page, id)).toBeVisible();
    });
  });

  test.describe('Issue #502 — the booking feature is called "Buchbare Zeiten"', () => {
    test('menu item, dialog, empty state, toasts and delete confirmation say "Buchbare Zeiten"', async ({ page }) => {
      const calendar = { id: 'e2e-502-cal', name: 'Persönlich', color: '#3b82f6', supportsVEVENT: true, supportsVTODO: false };
      let pages = [];
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await mockCalendars(page, [calendar]);
      await page.route('**/api/availability-slots', route => {
        if (route.request().method() === 'POST') {
          pages = [{ id: 'e2e-502-page', slug: 'e2e-502', title: 'Sprechstunde', calendarId: calendar.id, busyCalendarIds: [], durationMinutes: 30, weeklyHours: [[], [{ start: '09:00', end: '17:00' }], [], [], [], [], []], bufferMinutes: 0, maxBookingsPerDay: null, minNoticeMinutes: 0 }];
          return route.fulfill({ status: 201, json: pages[0] });
        }
        return route.fulfill({ json: pages });
      });
      await page.route('**/api/availability-slots/*', route => { pages = []; return route.fulfill({ json: { success: true } }); });

      const btn = page.locator('#availability-btn');
      await expect(btn).toHaveText('Buchbare Zeiten');
      await expect(btn).toHaveAttribute('title', 'Buchbare Zeiten');
      await btn.click();
      const dialog = page.getByRole('dialog', { name: 'Buchbare Zeiten', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAccessibleDescription('Öffentliche Seite, auf der andere einen freien Termin bei dir wählen');
      await expect(page.locator('#availability-pages-list')).toHaveText('Noch keine buchbaren Zeiten veröffentlicht.');
      await expect(dialog).not.toContainText(/Termin-Buchung|Buchungsseite/);

      await page.fill('#ap-title', 'Sprechstunde');
      await page.fill('#ap-slug', 'e2e-502');
      await expect(page.locator('#ap-calendar option')).toHaveCount(1);
      await expect(page.locator('#ap-save-btn')).toHaveText('Buchbare Zeiten veröffentlichen');
      await page.click('#ap-save-btn');
      await expect(page.locator('#toast-container .toast.success', { hasText: 'Buchbare Zeiten veröffentlicht' })).toBeVisible();
      await expect(page.locator('#availability-pages-list .availability-page-card')).toHaveCount(1);
      await expect(dialog).not.toContainText(/Termin-Buchung|Buchungsseite/);

      await page.locator('#availability-pages-list .delete-page-btn').click();
      await expect(page.locator('#confirm-dialog-text')).toHaveText('Möchtest du diese buchbaren Zeiten wirklich löschen?');
      await page.click('#confirm-dialog-ok');
      await expect(page.locator('#toast-container .toast.success', { hasText: 'Buchbare Zeiten gelöscht' })).toBeVisible();
      await expect(page.locator('#availability-pages-list')).toHaveText('Noch keine buchbaren Zeiten veröffentlicht.');
      await expect(page.locator('body')).not.toContainText(/Termin-Buchung|Buchungsseite/);
    });
  });

  test.describe('Issue #503 — Buchbare Zeiten: weekdays, time windows and limits', () => {
    test('the owner sets weekdays and several windows per day, overlaps are refused, and the public page offers only those slots up to the daily maximum', async ({ page }) => {
      const monday = mondayWeeksAhead(9);
      const plusDays = (n) => new Date(Date.parse(`${monday}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
      const tuesday = plusDays(1);
      const saturday = plusDays(5);
      const day = (d) => page.locator(`#ap-weekdays .ap-day[data-day="${d}"]`);
      const windowsOf = (d) => day(d).locator('.ap-window');
      const slotTimes = async (date) => {
        await page.fill('#booking-date', date);
        await page.locator('#booking-date').dispatchEvent('change');
        await expect(page.locator('#slots-container')).not.toContainText('werden geladen', { timeout: 10000 });
        return page.locator('.slot-btn').allTextContents();
      };

      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });
      await page.click('#availability-btn');
      await expect(page.locator('#availability-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#ap-calendar option')).not.toHaveCount(0, { timeout: 10000 });
      const calendarId = await page.locator('#ap-calendar').inputValue();

      // A new page starts as before: Monday to Friday 09:00–17:00, weekend off.
      await expect(page.locator('#ap-weekdays .ap-day')).toHaveCount(7);
      await expect(page.locator('#ap-weekdays .ap-day').first()).toContainText('Montag');
      for (const d of [1, 2, 3, 4, 5]) {
        await expect(day(d).locator('.ap-day-toggle')).toBeChecked();
        await expect(windowsOf(d)).toHaveCount(1);
        await expect(windowsOf(d).locator('.ap-window-start')).toHaveValue('09:00');
        await expect(windowsOf(d).locator('.ap-window-end')).toHaveValue('17:00');
      }
      for (const d of [6, 0]) {
        await expect(day(d).locator('.ap-day-toggle')).not.toBeChecked();
        await expect(day(d).locator('.ap-day-windows')).toBeHidden();
      }

      const slug = `e2e-503-${Date.now()}`;
      await page.fill('#ap-title', 'E2E 503 Sprechstunde');
      await page.fill('#ap-slug', slug);
      // Monday 09:00–12:00 plus 11:00–13:00 overlaps: the server refuses and nothing is published.
      await windowsOf(1).nth(0).locator('.ap-window-end').fill('12:00');
      await day(1).getByRole('button', { name: 'Zeitfenster am Montag hinzufügen' }).click();
      await expect(windowsOf(1)).toHaveCount(2);
      await expect(windowsOf(1).nth(1).locator('.ap-window-start')).toBeFocused();
      await windowsOf(1).nth(1).locator('.ap-window-start').fill('11:00');
      await windowsOf(1).nth(1).locator('.ap-window-end').fill('13:00');
      const refused = page.waitForResponse(resp => resp.url().includes('/api/availability-slots') && resp.request().method() === 'POST');
      await page.click('#ap-save-btn');
      expect((await refused).status()).toBe(400);
      await expect(page.locator('#toast-container .toast.error', { hasText: 'Montag: Zeitfenster dürfen sich nicht überschneiden' })).toBeVisible();
      await expect(page.locator(`.availability-page-card:has-text("${slug}")`)).toHaveCount(0);

      // Monday 09:00–10:00 and 14:00–15:00, Tuesday to Friday off, Saturday 10:00–11:00, one booking per day.
      await windowsOf(1).nth(0).locator('.ap-window-end').fill('10:00');
      await windowsOf(1).nth(1).locator('.ap-window-start').fill('14:00');
      await windowsOf(1).nth(1).locator('.ap-window-end').fill('15:00');
      for (const d of [2, 3, 4]) await day(d).locator('.ap-day-toggle').uncheck();
      await expect(day(2).locator('.ap-day-windows')).toBeHidden();
      // Removing a day's last window switches the day off.
      await day(5).getByRole('button', { name: 'Zeitfenster am Freitag entfernen' }).click();
      await expect(day(5).locator('.ap-day-toggle')).not.toBeChecked();
      await expect(day(5).locator('.ap-day-windows')).toBeHidden();
      await day(6).locator('.ap-day-toggle').check();
      await expect(day(6).locator('.ap-day-windows')).toBeVisible();
      await windowsOf(6).locator('.ap-window-start').fill('10:00');
      await windowsOf(6).locator('.ap-window-end').fill('11:00');
      await page.fill('#ap-max-per-day', '1');
      await page.fill('#ap-buffer', '0');
      await page.fill('#ap-min-notice', '0');
      const saved = page.waitForResponse(resp => resp.url().includes('/api/availability-slots') && resp.request().method() === 'POST');
      await page.click('#ap-save-btn');
      expect((await saved).status()).toBe(201);
      const card = page.locator(`.availability-page-card:has-text("${slug}")`);
      await expect(card.locator('.availability-page-hours')).toHaveText('Mo 09:00–10:00, 14:00–15:00 · Sa 10:00–11:00 | höchstens 1 pro Tag', { timeout: 10000 });
      // The form is back at the default week for the next page.
      await expect(day(3).locator('.ap-day-toggle')).toBeChecked();
      await expect(windowsOf(1)).toHaveCount(1);
      await expect(day(6).locator('.ap-day-toggle')).not.toBeChecked();

      const range = `start=${monday}T00:00:00Z&end=${monday}T23:59:59Z`;
      try {
        await page.goto(`/public/booking/?slug=${slug}`);
        await expect(page.locator('#page-title')).toHaveText('E2E 503 Sprechstunde', { timeout: 10000 });
        expect(await slotTimes(monday)).toEqual(['09:00 Uhr', '09:30 Uhr', '14:00 Uhr', '14:30 Uhr']);
        expect(await slotTimes(tuesday)).toEqual([]);
        await expect(page.locator('#slots-container')).toContainText('keine freien Zeitslots');
        expect(await slotTimes(saturday)).toEqual(['10:00 Uhr', '10:30 Uhr']);

        expect(await slotTimes(monday)).toHaveLength(4);
        await page.locator('.slot-btn', { hasText: '14:00 Uhr' }).click();
        await page.fill('#guest-name', 'Test User');
        await page.fill('#guest-email', 'testuser@example.com');
        await page.click('#confirm-booking-btn');
        await expect(page.locator('#booking-success')).not.toHaveClass(/hidden/, { timeout: 10000 });

        // One booking per day: Monday is full, Saturday is still open.
        await page.reload();
        expect(await slotTimes(monday)).toEqual([]);
        expect(await slotTimes(saturday)).toEqual(['10:00 Uhr', '10:30 Uhr']);
      } finally {
        const list = await page.request.get(`/api/events?${range}&calendarId=${encodeURIComponent(calendarId)}`);
        expect(list.ok()).toBeTruthy();
        for (const ev of (await list.json()).events.filter(e => e.title.startsWith('E2E 503'))) {
          const del = await page.request.delete(`/api/events/${encodeURIComponent(ev.uid)}`, {
            headers: SAME_ORIGIN,
            data: { calendarId, href: ev.href, etag: ev.etag }
          });
          expect(del.ok()).toBeTruthy();
        }
      }
    });
  });

  test.describe('Issue #504 — the sidebar is reordered by drag and drop or Alt+↑/↓, per group', () => {
    const { Agent } = require('undici');

    // The collection's apple:calendar-order, read straight from Radicale.
    async function calendarOrderInRadicale(id) {
      const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
      try {
        const res = await fetch(`${webServer.env.INTERNAL_CALDAV_URL}${id.split('::')[1]}`, {
          method: 'PROPFIND', dispatcher,
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${E2E_USER}:${webServer.env.SYSTEM_SYNC_SECRET}`).toString('base64'),
            'Accept-Encoding': 'identity',
            'Content-Type': 'application/xml; charset=utf-8',
            Depth: '0',
          },
          body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/">'
            + '<d:prop><a:calendar-order/></d:prop></d:propfind>',
        });
        expect(res.status, `PROPFIND ${id}`).toBe(207);
        const match = (await res.text()).match(/calendar-order[^>]*>(\d+)</);
        return match ? Number(match[1]) : null;
      } finally {
        await dispatcher.close();
      }
    }

    // The ids among `ids` in the order the sidebar shows them.
    const sidebarOrder = (page, ids) => page.locator('#calendar-list [data-cal-id]')
      .evaluateAll((els, wanted) => els.map(el => el.dataset.calId).filter(id => wanted.includes(id)), ids);
    const item = (page, id) => page.locator(`#calendar-list [data-cal-id="${id}"]`);

    // A mouse drag in small steps, as a person would do it, onto the upper edge of `target`.
    // The sidebar scrolls, so both entries are brought into view first.
    // #569: content above the list can still change height mid-drag (a late event load badges a
    // calendar "Nicht erreichbar"), which moves the entries away from coordinates measured once.
    // The drop lands on the entry the UI marks, so the pointer follows `target` until it rests on
    // it, and the release waits for its drop-before mark (or, across groups, for no mark at all).
    async function dragOntoTop(page, source, target, { dropsThere = true } = {}) {
      let from;
      await expect(async () => {
        await target.scrollIntoViewIfNeeded({ timeout: 1000 });
        await source.scrollIntoViewIfNeeded({ timeout: 1000 });
        await expect(target).toBeInViewport({ timeout: 1000 });
        from = await source.boundingBox();
        expect(from).toBeTruthy();
      }).toPass({ timeout: 10000 });
      await page.mouse.move(from.x + 20, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 20, from.y + from.height / 2 - 10, { steps: 4 });
      await expect(source, 'the pointer grabbed the dragged entry').toHaveClass(/\bdragging\b/);
      await expect(async () => {
        const to = await target.boundingBox();
        expect(to).toBeTruthy();
        await page.mouse.move(to.x + 20, to.y + 3, { steps: 8 });
        expect((await target.boundingBox()).y, 'the target stayed under the pointer').toBe(to.y);
        if (dropsThere) await expect(target).toHaveClass(/\bdrop-before\b/, { timeout: 500 });
      }).toPass({ timeout: 10000 });
      if (!dropsThere) await expect(page.locator('.drop-before, .drop-after')).toHaveCount(0);
      await page.mouse.up();
    }

    // The fading loading screen would catch the pointer, so the drag waits until it is gone.
    async function appReady(page) {
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#loading-screen')).toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list')).toContainText('Persönlich', { timeout: 10000 });
    }

    async function openApp(page) {
      await page.goto('/');
      await appReady(page);
    }

    test('dragging and Alt+↑ reorder the user\'s calendars; the order survives a reload and reaches Radicale', async ({ page }) => {
      const ids = [];
      await openApp(page);
      // #569: Radicale refuses to delete collections, so a run reuses the three of an earlier one
      // (--repeat-each) instead of piling up calendars until loading the sidebar outlasts appReady.
      const existing = await page.request.get('/api/calendars');
      expect(existing.status()).toBe(200);
      const byName = new Map((await existing.json()).calendars.map(cal => [cal.name, cal.id]));
      for (const letter of ['A', 'B', 'C']) {
        const name = `E2E 504 ${letter}`;
        if (byName.has(name)) { ids.push(byName.get(name)); continue; }
        const res = await page.request.post('/api/calendars', {
          headers: SAME_ORIGIN,
          data: { accountId: 'internal-caldav', name, color: '#3366cc', type: 'calendar' },
        });
        expect(res.status()).toBe(201);
        ids.push((await res.json()).id);
      }
      // Earlier tests leave many collections with this user; these go first and stay adjacent,
      // so dragging does not have to scroll the sidebar.
      const listed = await page.request.get('/api/calendars');
      expect(listed.status()).toBe(200);
      const others = (await listed.json()).calendars.map(cal => cal.id).filter(id => !ids.includes(id));
      const first = await page.request.put('/api/calendars/order', { headers: SAME_ORIGIN, data: { calendarIds: [...ids, ...others] } });
      expect(first.status()).toBe(200);
      const [a, b, c] = ids;
      await page.reload();
      await appReady(page);
      await expect.poll(() => sidebarOrder(page, ids)).toEqual([a, b, c]);

      // Drop C onto the upper half of A: C goes before A.
      const saved = page.waitForResponse(r => r.url().endsWith('/api/calendars/order') && r.request().method() === 'PUT');
      await dragOntoTop(page, item(page, c), item(page, a));
      expect((await saved).status()).toBe(200);
      await expect.poll(() => sidebarOrder(page, ids)).toEqual([c, a, b]);

      // Alt+↑ on B moves it above A; focus stays on B.
      await item(page, b).focus();
      const savedKey = page.waitForResponse(r => r.url().endsWith('/api/calendars/order') && r.request().method() === 'PUT');
      await page.keyboard.press('Alt+ArrowUp');
      expect((await savedKey).status()).toBe(200);
      await expect.poll(() => sidebarOrder(page, ids)).toEqual([c, b, a]);
      await expect(item(page, b)).toBeFocused();

      await page.reload();
      await appReady(page);
      await expect.poll(() => sidebarOrder(page, ids)).toEqual([c, b, a]);

      // The pickers follow the sidebar.
      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      const options = await page.locator('#ev-calendar option').evaluateAll(os => os.map(o => o.value));
      expect(options.filter(v => ids.includes(v))).toEqual([c, b, a]);

      // Native clients read apple:calendar-order from Radicale.
      const orders = await Promise.all([c, b, a].map(calendarOrderInRadicale));
      expect(orders.every(Number.isInteger), JSON.stringify(orders)).toBe(true);
      expect([...orders].sort((x, y) => x - y)).toEqual(orders);

    });

    test('calendars move only inside their group: own calendars and each linked account', async ({ page }) => {
      const own1 = `internal-caldav::/${E2E_USER}/personal/`;
      const own2 = `internal-caldav::/${E2E_USER}/e2e-504-own/`;
      const linked1 = `internal-caldav::/${E2E_USER}/caldav-504aaaaaaaaaaaaa/`;
      const linked2 = `internal-caldav::/${E2E_USER}/caldav-504bbbbbbbbbbbbb/`;
      const calendar = (id, name, linkedAccountId) => ({
        id, accountId: 'internal-caldav', linkedAccountId, name, color: '#3366cc', href: id.split('::')[1],
        isShared: false, readOnly: false, supportsVEVENT: true, supportsVTODO: false
      });
      await page.route('**/api/accounts', route => (route.request().method() === 'GET'
        ? route.fulfill({ json: [
          { id: 'internal-caldav', url: 'https://caldav.example.com/', username: E2E_USER, displayName: 'Shard' },
          { id: 'acc-504', url: 'https://caldav.example.com/testuser/', username: 'testuser@example.com', displayName: 'Privat' },
        ] })
        : route.fallback()));
      await mockCalendars(page, [
        calendar(own1, 'Persönlich', null),
        calendar(own2, 'Zweiter', null),
        calendar(linked1, 'Team', 'acc-504'),
        calendar(linked2, 'Verein', 'acc-504'),
      ]);
      const puts = [];
      await page.route('**/api/calendars/order', route => {
        puts.push(route.request().postDataJSON().calendarIds);
        return route.fulfill({ json: { calendarIds: route.request().postDataJSON().calendarIds } });
      });
      const all = [own1, own2, linked1, linked2];

      await openApp(page);
      await expect(page.locator('#calendar-list .calendar-group-label')).toHaveText(['Privat']);

      // Across groups nothing moves: dragging a linked calendar onto an own one, Alt+↑ at a group's top.
      await dragOntoTop(page, item(page, linked1), item(page, own1), { dropsThere: false });
      await item(page, linked1).focus();
      await page.keyboard.press('Alt+ArrowUp');
      await item(page, own2).focus();
      await page.keyboard.press('Alt+ArrowDown');
      expect(await sidebarOrder(page, all)).toEqual(all);
      expect(puts).toEqual([]);

      // Inside the linked group, the order changes and only that group's ids are saved.
      await item(page, linked1).focus();
      await page.keyboard.press('Alt+ArrowDown');
      await expect.poll(() => sidebarOrder(page, all)).toEqual([own1, own2, linked2, linked1]);
      expect(puts).toEqual([[linked2, linked1]]);
      await expect(page.locator('#calendar-list .calendar-group-label')).toHaveText(['Privat']);

      // Dragging the second own calendar above the first.
      await dragOntoTop(page, item(page, own2), item(page, own1));
      await expect.poll(() => sidebarOrder(page, all)).toEqual([own2, own1, linked2, linked1]);
      expect(puts).toEqual([[linked2, linked1], [own2, own1]]);
    });

    // Three subscriptions sub-504-a…c; returns the order saves the page sends.
    async function mockSubscriptions(page) {
      const subs = ['sub-504-a', 'sub-504-b', 'sub-504-c'].map((id, i) => ({
        id, user_id: E2E_USER, name: `Abo ${i + 1}`, url: `https://example.com/${id}.ics`, color: '#3366cc', last_error: null
      }));
      await page.route('**/api/webcal/subscriptions', route => (route.request().method() === 'GET'
        ? route.fulfill({ json: { subscriptions: subs } })
        : route.fallback()));
      await page.route('**/api/webcal/subscriptions/*/events*', route => route.fulfill({ json: { events: [] } }));
      const puts = [];
      await page.route('**/api/calendars/order', route => {
        puts.push(route.request().postDataJSON().calendarIds);
        return route.fulfill({ json: { calendarIds: route.request().postDataJSON().calendarIds } });
      });
      return puts;
    }
    const subOrder = page => page.locator('#webcal-list [data-webcal-id]').evaluateAll(els => els.map(el => el.dataset.webcalId));
    const sub = (page, id) => page.locator(`#webcal-list [data-webcal-id="${id}"]`);

    // #569: in CI the event load finished while the drag ran; its "Nicht erreichbar" badge made the
    // calendar list taller and pushed the subscriptions below the pointer, so the drop was lost.
    test('a drag still lands when the calendar list above grows during it', async ({ page }) => {
      const puts = await mockSubscriptions(page);
      const personal = `internal-caldav::/${E2E_USER}/personal/`;
      let releaseEvents;
      const eventsHeld = new Promise(resolve => { releaseEvents = resolve; });
      await page.route(url => url.pathname === '/api/events', async route => {
        await eventsHeld;
        await route.fulfill({ json: { events: [], errors: [{ calendarId: personal, accountId: 'internal-caldav', error: 'Testfehler' }] } });
      });
      // The held event load answers the moment the pointer goes down on an entry.
      await page.exposeFunction('e2ePointerDown', () => releaseEvents());
      const eventsRequested = page.waitForRequest(r => new URL(r.url()).pathname === '/api/events', { timeout: 30000 });

      await page.goto('/');
      await appReady(page);
      await expect.poll(() => subOrder(page)).toEqual(['sub-504-a', 'sub-504-b', 'sub-504-c']);
      await eventsRequested;
      await expect(page.locator('#calendar-list .calendar-load-error')).toHaveCount(0);
      // Layout position, independent of how far the sidebar is scrolled.
      const listTop = () => page.locator('#webcal-list').evaluate(list => list.offsetTop);
      const before = await listTop();
      await page.locator('#webcal-list').evaluate(list => {
        list.addEventListener('pointerdown', () => window.e2ePointerDown(), { capture: true, once: true });
      });

      await dragOntoTop(page, sub(page, 'sub-504-c'), sub(page, 'sub-504-a'));
      await expect.poll(() => subOrder(page)).toEqual(['sub-504-c', 'sub-504-a', 'sub-504-b']);
      expect(puts).toEqual([['webcal::sub-504-c', 'webcal::sub-504-a', 'webcal::sub-504-b']]);
      // The list really moved during the drag.
      await expect(page.locator(`#calendar-list [data-cal-id="${personal}"] .calendar-load-error`)).toBeVisible();
      expect(await listTop()).toBeGreaterThan(before);
    });

    test('subscriptions are their own group and are reordered the same way', async ({ page }) => {
      const puts = await mockSubscriptions(page);
      const webcalOrder = () => page.locator('#webcal-list [data-webcal-id]').evaluateAll(els => els.map(el => el.dataset.webcalId));

      await openApp(page);
      await expect.poll(webcalOrder).toEqual(['sub-504-a', 'sub-504-b', 'sub-504-c']);

      await page.locator('#webcal-list [data-webcal-id="sub-504-a"]').focus();
      await page.keyboard.press('Alt+ArrowDown');
      await expect.poll(webcalOrder).toEqual(['sub-504-b', 'sub-504-a', 'sub-504-c']);
      await expect(page.locator('#webcal-list [data-webcal-id="sub-504-a"]')).toBeFocused();

      await dragOntoTop(page, page.locator('#webcal-list [data-webcal-id="sub-504-c"]'),
        page.locator('#webcal-list [data-webcal-id="sub-504-b"]'));
      await expect.poll(webcalOrder).toEqual(['sub-504-c', 'sub-504-b', 'sub-504-a']);
      expect(puts).toEqual([
        ['webcal::sub-504-b', 'webcal::sub-504-a', 'webcal::sub-504-c'],
        ['webcal::sub-504-c', 'webcal::sub-504-b', 'webcal::sub-504-a'],
      ]);
    });
  });

  test.describe('Issue #498 — the task area offers a list next to the kanban board', () => {
    let run;
    let homeName;
    let otherName;

    async function createList(page, name) {
      const res = await page.request.post('/api/calendars', {
        headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name, type: 'tasklist' }
      });
      expect(res.status()).toBe(201);
      return (await res.json()).id;
    }

    async function createTask(page, data) {
      const res = await page.request.post('/api/tasks', { headers: SAME_ORIGIN, data });
      expect(res.status(), JSON.stringify(data)).toBe(201);
    }

    async function storedTask(page, title) {
      const res = await page.request.get('/api/tasks');
      expect(res.ok()).toBeTruthy();
      return (await res.json()).find(t => t.title === title && !t.recurrenceId);
    }

    // This run's rows only: earlier specs leave their own tasks in the shared principal.
    const rows = (page) => page.locator('.task-list-row', { hasText: run });
    const titles = (page) => rows(page).locator('.task-list-title').allTextContents();
    const row = (page, title) => page.locator('.task-list-row', { hasText: `${title} ${run}` });

    // The app's next GET /api/tasks (the boot load, or the reload after a change). The list renders
    // from it, so waiting on it replaces waiting on a timeout. A complete read carries no
    // X-CalDAV-Error: in CI (PR #563) the reads of some lists failed and their tasks were missing.
    function tasksLoaded(page) {
      return page.waitForResponse(r => new URL(r.url()).pathname === '/api/tasks' && r.request().method() === 'GET')
        .then(res => {
          expect(res.status()).toBe(200);
          expect(res.headers()['x-caldav-error']).toBeUndefined();
          return res;
        });
    }

    async function reloadApp(page) {
      const loaded = tasksLoaded(page);
      await page.reload();
      await loaded;
      await expect(page.locator('#app')).not.toHaveClass(/hidden/);
    }

    async function openTaskArea(page) {
      await page.click('#view-kanban');
      await expect(page.locator('.task-view-switch')).toBeVisible();
    }

    // The run's four open tasks; Done is hidden by default.
    async function openList(page) {
      await openTaskArea(page);
      await page.locator('.task-view-switch button', { hasText: 'Liste' }).click();
      await expect(rows(page)).toHaveCount(4);
    }

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      run = `r${Date.now().toString(36)}`;
      homeName = `E2E 498 Haushalt ${run}`;
      otherName = `E2E 498 Arbeit ${run}`;
      const home = await createList(page, homeName);
      const other = await createList(page, otherName);
      const day = (d) => ({ due: `2036-03-${d}T00:00:00.000Z`, dueIsDate: true });
      await createTask(page, { calendarId: home, title: `Beta ${run}`, priority: 3, ...day('02') });
      await createTask(page, { calendarId: home, title: `Alpha ${run}`, priority: 1, ...day('05') });
      await createTask(page, { calendarId: other, title: `Gamma ${run}`, priority: 2 });
      await createTask(page, { calendarId: other, title: `Weekly ${run}`, recurrence: 'FREQ=WEEKLY', ...day('01') });
      await createTask(page, {
        calendarId: home, title: `Done ${run}`, status: 'COMPLETED', percentComplete: 100, ...day('03')
      });
      await reloadApp(page);
    });

    // The choice is stored for the run's one user; later specs expect the board.
    test.afterEach(async ({ page }) => {
      const res = await page.request.put('/api/preferences', { headers: SAME_ORIGIN, data: { taskView: 'kanban' } });
      expect(res.ok()).toBeTruthy();
    });

    test('the switch "Liste | Kanban" changes the view and the choice is remembered', async ({ page }) => {
      await openTaskArea(page);
      const listBtn = page.locator('.task-view-switch button', { hasText: 'Liste' });
      const boardBtn = page.locator('.task-view-switch button', { hasText: 'Kanban' });
      await expect(boardBtn).toHaveAttribute('aria-pressed', 'true');
      await expect(listBtn).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.kanban-board')).toBeVisible();
      await expect(page.locator('.task-list-table')).toHaveCount(0);

      await listBtn.click();
      await expect(listBtn).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.task-list-table')).toBeVisible();
      await expect(page.locator('.kanban-board')).toHaveCount(0);
      await expect.poll(async () => (await (await page.request.get('/api/preferences')).json()).taskView).toBe('list');

      // Another visit (a fresh page) opens the task area in the list.
      await reloadApp(page);
      await openTaskArea(page);
      await expect(page.locator('.task-list-table')).toBeVisible();
      await expect(page.locator('.kanban-board')).toHaveCount(0);

      await boardBtn.click();
      await expect(page.locator('.kanban-board')).toBeVisible();
      await expect.poll(async () => (await (await page.request.get('/api/preferences')).json()).taskView).toBe('kanban');
    });

    test('the list shows title, list, due date, priority and status and sorts by due date, priority and title', async ({ page }) => {
      await openList(page);
      const alpha = row(page, 'Alpha');
      await expect(alpha.locator('.task-list-title')).toHaveText(`Alpha ${run}`);
      await expect(alpha.locator('.task-list-calendar')).toHaveText(homeName);
      await expect(alpha.locator('.task-list-due')).toHaveText('05.03.2036');
      await expect(alpha.locator('.task-list-priority')).toHaveText('Hoch');
      await expect(alpha.locator('.task-list-status')).toHaveText('Zu erledigen');
      await expect(row(page, 'Gamma').locator('.task-list-due')).toHaveText('');

      // Due date first by default; a task without one comes last.
      await expect(page.locator('#task-list-sort')).toHaveValue('due');
      expect(await titles(page)).toEqual([`Weekly ${run}`, `Beta ${run}`, `Alpha ${run}`, `Gamma ${run}`]);

      await page.selectOption('#task-list-sort', 'priority');
      await expect.poll(() => titles(page)).toEqual([`Alpha ${run}`, `Gamma ${run}`, `Beta ${run}`, `Weekly ${run}`]);

      await page.selectOption('#task-list-sort', 'title');
      await expect.poll(() => titles(page)).toEqual([`Alpha ${run}`, `Beta ${run}`, `Gamma ${run}`, `Weekly ${run}`]);
    });

    test('completed tasks are hidden until shown, and the list can be grouped by list', async ({ page }) => {
      await openList(page);
      await expect(page.locator('#task-list-show-completed')).not.toBeChecked();
      await expect(row(page, 'Done')).toHaveCount(0);

      await page.check('#task-list-show-completed');
      await expect(row(page, 'Done')).toHaveCount(1);
      await expect(row(page, 'Done').locator('.task-list-status')).toHaveText('Erledigt');
      await expect(row(page, 'Done').locator('.task-list-check')).toBeChecked();
      await page.uncheck('#task-list-show-completed');
      await expect(row(page, 'Done')).toHaveCount(0);

      await expect(page.locator('.task-list-group-header', { hasText: run })).toHaveCount(0);
      await page.check('#task-list-group');
      const home = page.locator('tbody.task-list-group', { has: page.locator('.task-list-group-header', { hasText: homeName }) });
      const other = page.locator('tbody.task-list-group', { has: page.locator('.task-list-group-header', { hasText: otherName }) });
      await expect(home.locator('.task-list-title')).toHaveText([`Beta ${run}`, `Alpha ${run}`]);
      await expect(other.locator('.task-list-title')).toHaveText([`Weekly ${run}`, `Gamma ${run}`]);
    });

    test('the checkbox completes a task; a recurring one moves on to its next due date (#95)', async ({ page }) => {
      await openList(page);

      // Each change is saved, then the list is reloaded; the assertions follow that reload.
      let reloaded = tasksLoaded(page);
      await row(page, 'Beta').locator('.task-list-check').check();
      await reloaded;
      await expect(page.locator('#toast-container .toast.success', { hasText: 'Aufgabe als erledigt markiert.' })).toBeVisible();
      await expect(row(page, 'Beta')).toHaveCount(0);
      expect((await storedTask(page, `Beta ${run}`)).status).toBe('COMPLETED');

      reloaded = tasksLoaded(page);
      await row(page, 'Weekly').locator('.task-list-check').check();
      await reloaded;
      await expect(page.locator('#toast-container .toast.success', { hasText: 'Aufgabe auf 08.03.2036 verschoben.' })).toBeVisible();
      await expect(row(page, 'Weekly').locator('.task-list-due')).toHaveText('08.03.2036');
      await expect(row(page, 'Weekly').locator('.task-list-check')).not.toBeChecked();
      const weekly = await storedTask(page, `Weekly ${run}`);
      expect(weekly.status).toBe('NEEDS-ACTION');
      expect(weekly.due).toBe('2036-03-08T00:00:00.000Z');

      // Shown again, a completed task is reopened with its checkbox.
      await page.check('#task-list-show-completed');
      reloaded = tasksLoaded(page);
      await row(page, 'Beta').locator('.task-list-check').uncheck();
      await reloaded;
      await expect(row(page, 'Beta').locator('.task-list-status')).toHaveText('Zu erledigen');
      expect((await storedTask(page, `Beta ${run}`)).status).toBe('NEEDS-ACTION');
    });

    test('the list is used with the keyboard alone', async ({ page }) => {
      await openTaskArea(page);
      const listBtn = page.locator('.task-view-switch button', { hasText: 'Liste' });
      await listBtn.focus();
      await page.keyboard.press('Enter');
      await expect(rows(page)).toHaveCount(4);
      // Re-rendering keeps the focus where it was.
      await expect(listBtn).toBeFocused();

      // Tab walks the controls, then into the rows: checkbox, then title.
      await page.keyboard.press('Tab');
      await expect(page.locator('.task-view-switch button', { hasText: 'Kanban' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('#task-list-sort')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('#task-list-group')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('#task-list-show-completed')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('.task-list-check').first()).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('.task-list-title').first()).toBeFocused();

      // Space on a row's checkbox completes it; the focus stays in the list.
      const beta = row(page, 'Beta').locator('.task-list-check');
      await beta.focus();
      await expect(beta).toHaveAttribute('aria-label', `„Beta ${run}“ als erledigt markieren`);
      const reloaded = tasksLoaded(page);
      await page.keyboard.press('Space');
      await reloaded;
      await expect(row(page, 'Beta')).toHaveCount(0);
      await expect(page.locator('.task-list-check:focus')).toHaveCount(1);

      // Enter on a title opens the task.
      await row(page, 'Alpha').locator('.task-list-title').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#task-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#task-title')).toHaveValue(`Alpha ${run}`);
    });

    // PR #563 failed in CI because, by the time these specs ran, the run's user had many
    // collections: the server read them all at once, Radicale dropped some of those reads and the
    // list silently lacked their tasks. A user with many lists sees the tasks of every one.
    test('with many lists, the list shows the tasks of every list', async ({ page }) => {
      const LISTS = 100;
      // Budget for creating 100 lists, not a wait for the UI. Radicale's rights forbid deleting a
      // collection; the global teardown drops the run's principal with them.
      test.setTimeout(180000);
      for (let i = 0; i < LISTS; i++) {
        const id = await createList(page, `E2E 498 Viele ${run} ${i}`);
        await createTask(page, { calendarId: id, title: `Viele ${run} ${i}` });
      }
      await reloadApp(page);
      await openTaskArea(page);
      await page.locator('.task-view-switch button', { hasText: 'Liste' }).click();
      await expect(page.locator('.task-list-row', { hasText: `Viele ${run} ` })).toHaveCount(LISTS);
      await expect(rows(page)).toHaveCount(LISTS + 4);
    });
  });

  test.describe('Issue #506 — event dialog: core fields up front, rarely used fields collapsible', () => {
    const SECTIONS = {
      'ev-section-recurrence': ['#ev-recurrence'],
      'ev-section-alarm':      ['#ev-add-reminder'],
      'ev-section-attendees':  ['#ev-attendee-name', '#ev-attendee-email', '#add-attendee-btn'],
      'ev-section-link':       ['#ev-attachment-url', '#ev-attachment-name'],
      'ev-section-more':       ['#ev-transp', '#ev-class', '#ev-categories'],
    };

    async function openNewEventDialog(page, testDate) {
      await page.goto(`/?date=${testDate}`);
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await expect(page.locator('#calendar-list .calendar-item').first()).toBeVisible({ timeout: 10000 });
      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await expect(page.locator('#ev-calendar option')).not.toHaveCount(0, { timeout: 10000 });
    }

    async function exportedEvent(page, calendarId, title) {
      const res = await page.request.get(`/api/calendars/${encodeURIComponent(calendarId)}/export`);
      expect(res.status()).toBe(200);
      const ics = (await res.text()).replace(/\r?\n[ \t]/g, '');
      return ics.split('BEGIN:VEVENT').find(b => b.includes(`SUMMARY:${title}`)) || '';
    }

    // PR #570 failed in CI: the chip was never drawn because the run's user had many collections
    // by then and Radicale dropped some of the event reads (fixed for events by #498's bounded
    // fan-out). The dialog opens from a fresh load whose events arrived complete.
    async function openEditDialog(page, testDate, title) {
      const loaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'GET');
      await page.goto(`/?date=${testDate}`);
      const res = await loaded;
      expect(res.status()).toBe(200);
      expect(res.headers()['x-caldav-error']).toBeUndefined();
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#view-week');
      const chip = page.locator('.event-block').filter({ hasText: title }).first();
      await expect(chip).toBeVisible({ timeout: 15000 });
      // The view may still redraw after a load; retry until the popover holds.
      await expect(async () => {
        await chip.click({ timeout: 2000 });
        await page.click('#popover-edit-btn', { timeout: 2000 });
      }).toPass({ timeout: 15000 });
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    }

    test('a new event shows only title, time, calendar, location and description; the rest is collapsed', async ({ page }) => {
      await openNewEventDialog(page, '2036-05-12');
      const dialog = page.locator('#event-modal');

      for (const id of ['#ev-title', '#ev-calendar', '#ev-allday', '#ev-start-date', '#ev-start-time',
        '#ev-end-date', '#ev-end-time', '#ev-location', '#ev-description']) {
        await expect(dialog.locator(id), `${id} is in the default view`).toBeVisible();
      }
      for (const [section, fields] of Object.entries(SECTIONS)) {
        await expect(dialog.locator(`#${section}`)).not.toHaveAttribute('open', /.*/);
        await expect(dialog.locator(`#${section} > summary`)).toBeVisible();
        for (const id of fields) await expect(dialog.locator(id), `${id} is collapsed`).toBeHidden();
      }
      await expect(dialog.locator('details.form-section > summary')).toHaveText([
        'Wiederholung', 'Erinnerungen', 'Teilnehmende', 'Link', 'Weitere Angaben'
      ]);

      // The URL field is a link, not a file attachment (#12).
      await expect(dialog).not.toContainText('Dateianhang');
      await dialog.locator('#ev-section-link > summary').click();
      await expect(page.getByLabel('Link', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Name des Links (optional)')).toBeVisible();

      await dialog.locator('#ev-section-more > summary').click();
      await expect(page.getByLabel('Verfügbarkeit')).toHaveValue('OPAQUE');
      await expect(page.getByLabel('Sichtbarkeit')).toHaveValue('PUBLIC');
      await expect(page.getByLabel('Kategorien')).toBeVisible();
    });

    test('sections open by keyboard, closed ones are skipped, and the focus trap still wraps', async ({ page }) => {
      await openNewEventDialog(page, '2036-05-13');
      await expect(page.locator('#ev-title')).toBeFocused();

      await page.focus('#ev-description');
      await page.keyboard.press('Tab');
      const recurrenceSummary = page.locator('#ev-section-recurrence > summary');
      await expect(recurrenceSummary).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('#ev-section-alarm > summary')).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(recurrenceSummary).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(page.locator('#ev-section-recurrence')).toHaveAttribute('open', '');
      await page.keyboard.press('Tab');
      await expect(page.locator('#ev-recurrence')).toBeFocused();

      await page.focus('#ev-section-more > summary');
      await page.keyboard.press('Space');
      await page.keyboard.press('Tab');
      await expect(page.locator('#ev-transp')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('#ev-class')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('#ev-categories')).toBeFocused();

      // The trap wraps from the last control to the first and back.
      await page.focus('#event-save-btn');
      await page.keyboard.press('Tab');
      await expect(page.locator('#event-modal-close')).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator('#event-save-btn')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
    });

    test('availability and visibility are saved, and only sections with content open again', async ({ page }) => {
      const testDate = '2036-05-14';
      const title = `E2E Issue506 Flags ${Date.now()}`;
      await openNewEventDialog(page, testDate);
      await page.fill('#ev-title', title);
      await page.fill('#ev-start-date', testDate);
      await page.fill('#ev-end-date', testDate);
      await page.click('#ev-section-more > summary');
      await page.selectOption('#ev-transp', 'TRANSPARENT');
      await page.selectOption('#ev-class', 'PRIVATE');

      const save = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/events'));
      await page.click('#event-save-btn');
      const sent = (await save).postDataJSON();
      expect([sent.transp, sent.classification]).toEqual(['TRANSPARENT', 'PRIVATE']);
      await expectSavesLanded(page);
      const stored = await exportedEvent(page, sent.calendarId, title);
      expect(stored).toMatch(/^TRANSP:TRANSPARENT\r?$/m);
      expect(stored).toMatch(/^CLASS:PRIVATE\r?$/m);

      await openEditDialog(page, testDate, title);
      await expect(page.locator('#ev-section-more')).toHaveAttribute('open', '');
      await expect(page.locator('#ev-transp')).toHaveValue('TRANSPARENT');
      await expect(page.locator('#ev-class')).toHaveValue('PRIVATE');
      for (const section of ['ev-section-recurrence', 'ev-section-alarm', 'ev-section-attendees', 'ev-section-link']) {
        await expect(page.locator(`#${section}`), `${section} has no content`).not.toHaveAttribute('open', /.*/);
      }

      // Back to the defaults: stored as such, and the section stays closed next time.
      await page.selectOption('#ev-transp', 'OPAQUE');
      await page.selectOption('#ev-class', 'PUBLIC');
      await page.click('#event-save-btn');
      await expectSavesLanded(page);
      await expect.poll(async () => {
        const block = await exportedEvent(page, sent.calendarId, title);
        return [/^TRANSP:OPAQUE\r?$/m.test(block), /^CLASS:PUBLIC\r?$/m.test(block)];
      }, { timeout: 15000 }).toEqual([true, true]);
      await openEditDialog(page, testDate, title);
      await expect(page.locator('#ev-section-more')).not.toHaveAttribute('open', /.*/);
    });

    test('an imported event opens every section it has content in', async ({ page }) => {
      const testDate = '2036-05-19';
      const title = `E2E Issue506 Full ${Date.now()}`;
      await importIcsAndOpenPopover(page, testDate, title, [
        'RRULE:FREQ=WEEKLY;COUNT=2',
        'ATTENDEE;CN=Test User;PARTSTAT=ACCEPTED:mailto:testuser@example.com',
        'ATTACH;X-FILENAME=Protokoll:https://example.com/protokoll',
        'CATEGORIES:Arbeit',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM'
      ]);
      await page.click('#popover-edit-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);

      for (const section of Object.keys(SECTIONS)) {
        await expect(page.locator(`#${section}`), `${section} has content`).toHaveAttribute('open', '');
      }
      await expect(page.locator('#ev-recurrence')).toHaveValue('WEEKLY');
      await expect(page.locator('#ev-reminder-list .reminder-amount')).toHaveValue('15');
      await expect(page.locator('#ev-attendee-list .attendee-email')).toHaveText('testuser@example.com');
      await expect(page.locator('#ev-attachment-url')).toHaveValue('https://example.com/protokoll');
      await expect(page.locator('#ev-attachment-name')).toHaveValue('Protokoll');
      await expect(page.locator('#ev-categories')).toHaveValue('Arbeit');
      await expect(page.locator('#ev-transp')).toHaveValue('OPAQUE');

      // The same dialog opened for a new event starts collapsed again.
      await page.keyboard.press('Escape');
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      for (const section of Object.keys(SECTIONS)) {
        await expect(page.locator(`#${section}`)).not.toHaveAttribute('open', /.*/);
      }
    });
  });

  test.describe('Issue #505 — calendar colours live in the collection, where the sync worker picks them up', () => {
    const { Agent } = require('undici');

    // PROPFIND/PROPPATCH of the collection's apple:calendar-color, straight on Radicale.
    async function radicale(id, method, prop) {
      const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
      try {
        const body = method === 'PROPFIND'
          ? '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/">'
            + '<d:prop><a:calendar-color/></d:prop></d:propfind>'
          : '<?xml version="1.0" encoding="utf-8"?><d:propertyupdate xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/">'
            + `<d:set><d:prop><a:calendar-color>${prop}</a:calendar-color></d:prop></d:set></d:propertyupdate>`;
        const res = await fetch(`${webServer.env.INTERNAL_CALDAV_URL}${id.split('::')[1]}`, {
          method, dispatcher, body,
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${E2E_USER}:${webServer.env.SYSTEM_SYNC_SECRET}`).toString('base64'),
            'Accept-Encoding': 'identity',
            'Content-Type': 'application/xml; charset=utf-8',
            Depth: '0',
          },
        });
        expect(res.status, `${method} ${id}`).toBe(207);
        const match = (await res.text()).match(/calendar-color[^>]*>([^<]+)</);
        return match ? match[1] : null;
      } finally {
        await dispatcher.close();
      }
    }

    const dot = (page, id) => page.locator(`#calendar-list [data-cal-id="${id}"] .calendar-dot`);

    test('a colour picked in the dialog is stored in Radicale, and a colour synced into Radicale shows after reload', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      const name = `E2E 505 ${Date.now().toString(36)}`;
      const created = await page.request.post('/api/calendars', {
        headers: SAME_ORIGIN,
        data: { accountId: 'internal-caldav', name, color: '#3366cc', type: 'calendar' },
      });
      expect(created.status()).toBe(201);
      // The run's teardown removes the collection with the run's principal (#217).
      const id = (await created.json()).id;
      await page.reload();
      await expect(dot(page, id)).toBeVisible({ timeout: 10000 });
      await page.locator(`#calendar-list [data-cal-id="${id}"] [data-edit-cal]`).click();
      const dialog = page.locator('#edit-cal-dialog-backdrop');
      await expect(dialog.locator('#edit-cal-name')).toHaveValue(name);
      await dialog.locator('#edit-cal-color').fill('#ab12cd');
      const saved = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes('/api/calendars/'));
      await dialog.locator('#edit-cal-submit').click();
      expect((await saved).status()).toBe(200);
      await expect(dialog).toHaveCount(0);
      await expect(dot(page, id)).toHaveCSS('background-color', 'rgb(171, 18, 205)');
      expect((await radicale(id, 'PROPFIND')).toLowerCase()).toMatch(/^#ab12cd/);

      // The sync worker writes the provider's colour into the collection; nothing in the app hides it.
      await radicale(id, 'PROPPATCH', '#00aa11');
      await page.reload();
      await expect(dot(page, id)).toHaveCSS('background-color', 'rgb(0, 170, 17)', { timeout: 10000 });
    });

    test('a read-only shared calendar gets a colour-only dialog that stores a local colour', async ({ page }) => {
      const sharedCal = 'internal-caldav::/testuser-owner/e2e-505-shared/';
      const calendars = [
        { id: sharedCal, accountId: 'internal-caldav', name: 'E2E 505 Geteilt', color: '#123456',
          href: '/testuser-owner/e2e-505-shared/', owner: 'testuser-owner',
          isShared: true, readOnly: true, supportsVEVENT: true, supportsVTODO: false },
      ];
      // #592: like the server, a later calendar reload returns the stored local colour.
      const mocked = await mockCalendars(page, calendars);
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

      const edit = page.locator(`#calendar-list [data-cal-id="${sharedCal}"] [data-edit-cal]`);
      await expect(edit).toHaveAccessibleName('Farbe ändern');
      await edit.click();
      const dialog = page.locator('#edit-cal-dialog-backdrop');
      await expect(dialog.locator('#edit-cal-dialog-title')).toHaveText('Farbe von „E2E 505 Geteilt“');
      await expect(dialog.locator('#edit-cal-name')).toHaveCount(0);
      await expect(dialog.locator('#edit-cal-color')).toHaveAccessibleDescription('Nur für dich. Die Farbe wird nicht synchronisiert.');
      await expect(dialog.locator('#edit-cal-color')).toBeFocused();
      await dialog.locator('#edit-cal-color').fill('#ec4899');
      await dialog.locator('#edit-cal-submit').click();
      await expect(dialog).toHaveCount(0);
      expect(mocked.writes).toEqual([{ method: 'PATCH', id: sharedCal, body: { color: '#ec4899' } }]);
      await expect(dot(page, sharedCal)).toHaveCSS('background-color', 'rgb(236, 72, 153)');
    });
  });
  test.describe('Issue #510 — list view: sortable, filterable table with paging and bulk actions', () => {
    // YYYY-MM-DD `days` days from today (local), inside the list's default range.
    const dayAhead = (days) => {
      const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      return d.toISOString().slice(0, 10);
    };
    const titles = (page) => page.locator('#list-table tbody .list-title').allTextContents();

    test('pages through the range, sorts and filters on the server, moves and deletes the selection', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#new-event-btn');
      await expect(page.locator('#ev-calendar option:not([value=""])').first()).toBeAttached({ timeout: 10000 });
      const sourceOption = page.locator('#ev-calendar option:not([value=""])').first();
      const calendarId = await sourceOption.getAttribute('value');
      // Other tests may have added calendars, so the first writable one is not always "Persönlich".
      const sourceName = await sourceOption.textContent();
      await page.keyboard.press('Escape');

      const slug = `e2e510x${Date.now()}`;
      // Unique per run: the collection path follows the name, and a repeated run must not collide.
      const targetName = `E2E 510 Ziel ${slug}`;
      const createdCal = await page.request.post('/api/calendars', {
        headers: SAME_ORIGIN,
        data: { accountId: calendarId.split('::')[0], name: targetName, type: 'calendar' }
      });
      expect(createdCal.status()).toBe(201);
      const targetId = (await createdCal.json()).id;
      const created = [];
      try {
        for (const [name, days, location] of [['Gamma', 20, 'Raum 1'], ['Alpha', 21, 'Raum 2'], ['Beta', 22, '']]) {
          const res = await page.request.post('/api/events', {
            headers: SAME_ORIGIN,
            data: { calendarId, title: `${slug} ${name}`, location,
              start: `${dayAhead(days)}T09:00:00.000Z`, end: `${dayAhead(days)}T10:00:00.000Z` }
          });
          expect(res.status()).toBe(201);
          created.push(await res.json());
        }

        // Pages of two, so three events need a second page: the server cuts them, not the browser.
        const listRequests = [];
        await page.route('**/api/events?**', route => {
          const url = new URL(route.request().url());
          if (!url.searchParams.has('limit')) return route.continue();
          listRequests.push(url);
          url.searchParams.set('limit', '2');
          return route.continue({ url: url.toString() });
        });

        await page.reload();
        await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
        await page.click('#view-list');
        await expect(page.locator('#view-list')).toHaveClass(/active/);
        await expect(page.locator('#list-table')).toBeVisible({ timeout: 10000 });
        // The agenda is not drawn instead.
        await expect(page.locator('.agenda-view')).toHaveCount(0);

        await page.fill('#list-filter', slug);
        await expect.poll(() => listRequests.at(-1).searchParams.get('q'), { timeout: 10000 }).toBe(slug);
        await expect.poll(() => titles(page), { timeout: 10000 }).toEqual([`${slug} Gamma`, `${slug} Alpha`]);
        await expect(page.locator('#list-status')).toContainText('2 von 3');
        await page.click('#list-more');
        await expect.poll(() => titles(page)).toEqual([`${slug} Gamma`, `${slug} Alpha`, `${slug} Beta`]);
        expect(listRequests.at(-1).searchParams.get('offset')).toBe('2');
        await expect(page.locator('#list-more')).toBeHidden();

        // Columns: date, time, title, calendar, location.
        const gammaRow = page.locator('#list-table tbody tr', { hasText: `${slug} Gamma` });
        await expect(gammaRow.locator('.list-location')).toHaveText('Raum 1');
        await expect(gammaRow.locator('.list-calendar')).toHaveText(sourceName);
        await expect(gammaRow.locator('.list-time')).not.toBeEmpty();

        // Sorting by title asks the server again from the first page.
        await page.click('#list-table th[data-sort="title"] button');
        await expect.poll(() => titles(page)).toEqual([`${slug} Alpha`, `${slug} Beta`]);
        expect(listRequests.at(-1).searchParams.get('sort')).toBe('title');
        expect(listRequests.at(-1).searchParams.get('offset')).toBe('0');
        await expect(page.locator('#list-table th[data-sort="title"]')).toHaveAttribute('aria-sort', 'ascending');
        await page.click('#list-table th[data-sort="title"] button');
        await expect.poll(() => titles(page)).toEqual([`${slug} Gamma`, `${slug} Beta`]);
        await expect(page.locator('#list-table th[data-sort="title"]')).toHaveAttribute('aria-sort', 'descending');
        await page.click('#list-more');
        await expect.poll(() => titles(page)).toEqual([`${slug} Gamma`, `${slug} Beta`, `${slug} Alpha`]);

        // Bulk move: the bar appears with the selection.
        await expect(page.locator('#list-bulk')).toBeHidden();
        await page.locator('#list-table tbody tr', { hasText: `${slug} Gamma` }).locator('input[type="checkbox"]').check();
        await page.locator('#list-table tbody tr', { hasText: `${slug} Alpha` }).locator('input[type="checkbox"]').check();
        await expect(page.locator('#list-bulk')).toBeVisible();
        await expect(page.locator('#list-bulk-count')).toHaveText('2 ausgewählt');
        await page.selectOption('#list-move-target', targetId);
        await page.click('#list-move-btn');
        await expect(page.locator('#list-table tbody tr', { hasText: `${slug} Gamma` }).locator('.list-calendar'))
          .toHaveText(targetName, { timeout: 15000 });
        // The reload after the action starts again at the first page.
        await expect.poll(() => titles(page)).toEqual([`${slug} Gamma`, `${slug} Beta`]);
        await page.click('#list-more');
        await expect(page.locator('#list-table tbody tr', { hasText: `${slug} Alpha` }).locator('.list-calendar'))
          .toHaveText(targetName);
        await expect(page.locator('#list-table tbody tr', { hasText: `${slug} Beta` }).locator('.list-calendar'))
          .toHaveText(sourceName);
        await expect(page.locator('#list-bulk')).toBeHidden();
        const inTarget = await page.request.get(`/api/events?start=${dayAhead(19)}T00:00:00Z&end=${dayAhead(23)}T00:00:00Z&calendarId=${encodeURIComponent(targetId)}`);
        expect((await inTarget.json()).events.map(e => e.title).sort()).toEqual([`${slug} Alpha`, `${slug} Gamma`]);

        // Bulk delete of everything shown, after a confirmation.
        await page.check('#list-select-all');
        await expect(page.locator('#list-bulk-count')).toHaveText('3 ausgewählt');
        await page.click('#list-delete-btn');
        await expect(page.locator('#confirm-dialog-text')).toContainText('3 Termine');
        await page.click('#confirm-dialog-ok');
        await expect(page.locator('#list-table tbody tr')).toHaveCount(0, { timeout: 15000 });
        await expect(page.locator('#list-status')).toContainText('Keine Termine');
        const left = await page.request.get(`/api/events?start=${dayAhead(19)}T00:00:00Z&end=${dayAhead(23)}T00:00:00Z`);
        expect((await left.json()).events.filter(e => e.title.startsWith(slug))).toEqual([]);
        created.length = 0;
      } finally {
        for (const ev of created) {
          await page.request.delete(`/api/events/${encodeURIComponent(ev.uid)}`, {
            headers: SAME_ORIGIN, data: { calendarId, href: ev.href, etag: ev.etag }
          });
        }
        await page.request.delete(`/api/calendars/${encodeURIComponent(targetId)}`, { headers: SAME_ORIGIN });
      }
    });
  });

  // Issue #348: every delete goes to the shard's trash; the toast offers "Rückgängig" for 8 s,
  // a calendar is deleted only after typing its name, and the settings' trash restores it.
  test.describe('Issue #348 — trash and undo', () => {
    test('#348 a deleted event comes back with "Rückgängig" in the toast', async ({ page }) => {
      await page.goto('/');
      const calendars = (await (await page.request.get('/api/calendars')).json()).calendars;
      const personal = calendars.find(c => c.supportsVEVENT && !c.readOnly);
      const title = `E2E 348 Undo ${Date.now()}`;
      const created = await page.request.post('/api/events', {
        headers: SAME_ORIGIN,
        data: { calendarId: personal.id, title, start: '2037-07-14T09:00:00.000Z', end: '2037-07-14T10:00:00.000Z' },
      });
      expect(created.status()).toBe(201);

      await page.goto('/?date=2037-07-14');
      const chip = page.locator('.event-chip', { hasText: title }).first();
      await expect(chip).toBeVisible({ timeout: 15000 });
      await chip.click();
      await page.click('#popover-delete-btn');
      await page.click('#confirm-dialog-ok');
      await expect(chip).toHaveCount(0);

      const toast = page.locator('#toast-container .toast', { hasText: 'Termin gelöscht.' });
      const undo = toast.getByRole('button', { name: 'Rückgängig' });
      await expect(undo).toBeVisible();
      // Still offered after the 4 s of a plain toast.
      await page.waitForTimeout(4600);
      await expect(undo).toBeVisible();
      await undo.click();
      await expect(page.locator('#toast-container .toast.success', { hasText: 'Wiederhergestellt.' })).toBeVisible();
      await expect(chip).toBeVisible({ timeout: 15000 });

      const trash = await (await page.request.get('/api/trash')).json();
      expect(trash.items.some(i => i.title === title)).toBe(false);
    });

    test('#348 a calendar is deleted only after typing its name and restored from the trash', async ({ page }) => {
      await page.goto('/');
      const name = `E2E 348 Cal ${Date.now()}`;
      const createdCal = await page.request.post('/api/calendars', {
        headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name, color: '#336699', type: 'calendar' },
      });
      expect(createdCal.status()).toBe(201);
      const calId = (await createdCal.json()).id;
      const ev = await page.request.post('/api/events', {
        headers: SAME_ORIGIN,
        data: { calendarId: calId, title: 'E2E 348 Inside', start: '2037-08-11T09:00:00.000Z', end: '2037-08-11T10:00:00.000Z' },
      });
      expect(ev.status()).toBe(201);

      await page.goto('/?date=2037-08-11');
      await expect(page.locator('#calendar-list')).toContainText(name, { timeout: 10000 });
      await page.click('#sidebar-settings-btn');
      await expect(page.locator('#settings-drawer')).not.toHaveClass(/hidden/);
      await page.locator('#settings-calendar-list .settings-item', { hasText: name }).locator('[data-delete-cal-settings]').click();

      const dialog = page.locator('#typed-confirm-backdrop');
      const ok = page.locator('#typed-confirm-ok');
      await expect(dialog).not.toHaveClass(/hidden/);
      await expect(page.locator('#typed-confirm-text')).toContainText(name);
      await expect(page.locator('#typed-confirm-input')).toBeFocused();
      await expect(ok).toBeDisabled();
      await page.fill('#typed-confirm-input', 'E2E 348');
      await expect(ok).toBeDisabled();
      await page.fill('#typed-confirm-input', name);
      await expect(ok).toBeEnabled();
      await ok.click();
      await expect(dialog).toHaveClass(/hidden/);
      await expect(page.locator('#calendar-list')).not.toContainText(name, { timeout: 10000 });

      const entry = page.locator('#settings-trash-list .trash-item', { hasText: name });
      await expect(entry).toBeVisible({ timeout: 10000 });
      await expect(entry).toContainText('Kalender · 1 Einträge');
      await entry.getByRole('button', { name: 'Wiederherstellen' }).click();
      await expect(page.locator('#calendar-list')).toContainText(name, { timeout: 10000 });
      await expect(entry).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('.event-chip', { hasText: 'E2E 348 Inside' }).first()).toBeVisible({ timeout: 15000 });
    });

    test('#348 cancelling the typed confirmation keeps the calendar', async ({ page }) => {
      await page.goto('/');
      const name = `E2E 348 Keep ${Date.now()}`;
      const createdCal = await page.request.post('/api/calendars', {
        headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name, type: 'calendar' },
      });
      expect(createdCal.status()).toBe(201);
      await page.goto('/');
      await expect(page.locator('#calendar-list')).toContainText(name, { timeout: 10000 });
      await page.click('#sidebar-settings-btn');
      const deleteBtn = page.locator('#settings-calendar-list .settings-item', { hasText: name }).locator('[data-delete-cal-settings]');
      await deleteBtn.click();
      // A wrong name keeps "Löschen" disabled.
      await page.fill('#typed-confirm-input', 'E2E 348');
      await expect(page.locator('#typed-confirm-ok')).toBeDisabled();
      await page.click('#typed-confirm-cancel');
      await expect(page.locator('#typed-confirm-backdrop')).toHaveClass(/hidden/);
      // Escape cancels too, and the dialog opens again afterwards.
      await deleteBtn.click();
      await expect(page.locator('#typed-confirm-backdrop')).not.toHaveClass(/hidden/);
      await page.keyboard.press('Escape');
      await expect(page.locator('#typed-confirm-backdrop')).toHaveClass(/hidden/);
      await expect(page.locator('#settings-calendar-list')).toContainText(name);
      const trash = await (await page.request.get('/api/trash')).json();
      expect(trash.items.some(i => i.title === name)).toBe(false);
    });

    test('#348 a deleted task list is listed as "Aufgabenliste" in the trash and can be purged', async ({ page }) => {
      await page.goto('/');
      const name = `E2E 348 Liste ${Date.now()}`;
      const created = await page.request.post('/api/calendars', {
        headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name, type: 'tasklist' },
      });
      expect(created.status()).toBe(201);
      const { id: listId } = await created.json();
      const del = await page.request.delete(`/api/calendars/${encodeURIComponent(listId)}`, { headers: SAME_ORIGIN });
      expect(del.ok()).toBe(true);

      await page.goto('/');
      await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
      await page.click('#sidebar-settings-btn');
      const entry = page.locator('#settings-trash-list .trash-item', { hasText: name });
      await expect(entry).toContainText('Aufgabenliste');
      await entry.locator('[data-trash-purge]').click();
      await page.click('#confirm-dialog-ok');
      await expect(entry).toHaveCount(0);
      const trash = await (await page.request.get('/api/trash')).json();
      expect(trash.items.some(i => i.title === name)).toBe(false);
    });
  });
});
