const { test, expect } = require('./fixtures.js');

// Issue #516: an event can start in one time zone and end in another (a flight from Berlin to
// New York). The selects are folded away by default and preset to the user's zone (the browser
// is pinned to Europe/Berlin). Europe and the US change their clocks on different dates, so each
// flight sits where one side's daylight-saving offset decides the result. Every result is checked
// through the API and the stored ICS, not the DOM alone.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

let calendarId;

async function createCalendar(page, name) {
  const res = await page.request.post('/api/calendars', {
    headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name, type: 'calendar' }
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function eventsIn(page, start, end) {
  const res = await page.request.get(`/api/events?start=${start}&end=${end}&calendarId=${encodeURIComponent(calendarId)}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).events;
}

async function storedIcsLines(page) {
  const res = await page.request.get(`/api/calendars/${encodeURIComponent(calendarId)}/export`);
  expect(res.ok()).toBeTruthy();
  return (await res.text()).split(/\r?\n/);
}

async function openApp(page, date) {
  await page.goto(`/?date=${date}`);
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
}

// Event saves are optimistic (#174): wait until the stored event replaced the preview.
async function expectSavesLanded(page) {
  await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });
}

test.describe('Issue #516 — time zone per event, separately for start and end', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (window.origin === 'null') return;
      window.localStorage.setItem('welcome-popup-closed', 'true');
      window.localStorage.setItem('activeView', 'month');
    });
    // Created before the app loads: #app is shown before the calendar list is fetched, so a
    // calendar created afterwards may be missing from the dialog's calendar select.
    calendarId = await createCalendar(page, `E2E 516 Kalender ${Date.now().toString(36)}`);
    await openApp(page, '2038-03-14');
  });

  const FLIGHTS = [
    {
      name: 'Berlin to New York on the day the US switches to summer time',
      from: 'Europe/Berlin', to: 'America/New_York',
      startDate: '2038-03-14', startTime: '10:00', endDate: '2038-03-14', endTime: '13:00',
      start: '2038-03-14T09:00:00.000Z', end: '2038-03-14T17:00:00.000Z',
      dtstart: 'DTSTART;TZID=Europe/Berlin:20380314T100000', dtend: 'DTEND;TZID=America/New_York:20380314T130000',
    },
    {
      name: 'New York to Berlin overnight, landing after Europe switched to summer time',
      from: 'America/New_York', to: 'Europe/Berlin',
      startDate: '2038-03-27', startTime: '18:00', endDate: '2038-03-28', endTime: '08:00',
      start: '2038-03-27T22:00:00.000Z', end: '2038-03-28T06:00:00.000Z',
      dtstart: 'DTSTART;TZID=America/New_York:20380327T180000', dtend: 'DTEND;TZID=Europe/Berlin:20380328T080000',
    },
  ];

  for (const f of FLIGHTS) {
    test(`#516 the dialog sets start and end zones separately: ${f.name}`, async ({ page }) => {
      await page.click('#new-event-btn');
      await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
      await page.selectOption('#ev-calendar', calendarId);

      // Collapsed by default, preset to the user's zone.
      const toggle = page.locator('#ev-tz-toggle');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toHaveText('Zeitzone: Europe/Berlin');
      await expect(page.locator('#ev-start-tz')).toBeHidden();
      await expect(page.locator('#ev-end-tz')).toBeHidden();
      await expect(page.locator('#ev-start-tz')).toHaveValue('Europe/Berlin');
      await expect(page.locator('#ev-end-tz')).toHaveValue('Europe/Berlin');

      const title = `E2E 516 Flug ${f.from} ${Date.now()}`;
      await page.fill('#ev-title', title);
      await page.fill('#ev-start-date', f.startDate);
      await page.dispatchEvent('#ev-start-date', 'change');
      await page.fill('#ev-start-time', f.startTime);
      await page.fill('#ev-end-date', f.endDate);
      await page.fill('#ev-end-time', f.endTime);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#ev-start-tz')).toBeVisible();
      await expect(page.locator('#ev-end-tz')).toBeVisible();
      await page.selectOption('#ev-start-tz', f.from);
      await page.selectOption('#ev-end-tz', f.to);
      await toggle.click();
      await expect(page.locator('#ev-end-tz')).toBeHidden();
      await expect(toggle).toHaveText(`Zeitzonen: ${f.from} → ${f.to}`);

      await page.click('#event-save-btn');
      await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
      await expectSavesLanded(page);

      const stored = (await eventsIn(page, '2038-03-01T00:00:00Z', '2038-04-01T00:00:00Z')).find(e => e.title === title);
      expect(stored).toBeTruthy();
      expect(stored.start).toBe(f.start);
      expect(stored.end).toBe(f.end);
      expect(stored.startTimeZone).toBe(f.from);
      expect(stored.endTimeZone).toBe(f.to);

      const lines = await storedIcsLines(page);
      expect(lines).toContain(f.dtstart);
      expect(lines).toContain(f.dtend);
      expect(lines).toContain('TZID:Europe/Berlin');
      expect(lines).toContain('TZID:America/New_York');
    });
  }

  test('#516 an all-day event hides the time zone control', async ({ page }) => {
    await page.click('#new-event-btn');
    await expect(page.locator('#ev-tz-toggle')).toBeVisible();
    await page.click('#ev-tz-toggle');
    await expect(page.locator('#ev-start-tz')).toBeVisible();
    await page.check('#ev-allday');
    await expect(page.locator('#ev-tz-toggle')).toBeHidden();
    await expect(page.locator('#ev-start-tz')).toBeHidden();
    await expect(page.locator('#ev-end-tz')).toBeHidden();
  });

  test('#516 another client\'s event with different start and end zones is shown in them and kept on save', async ({ page }) => {
    // 2038-11-03: Berlin is back on winter time (+1), New York still on summer time (-4).
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//other client//EN',
      'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
      'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VTIMEZONE', 'TZID:America/New_York',
      'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT', `UID:e2e-516-${Date.now()}@example.com`, 'DTSTAMP:20380101T000000Z', 'SUMMARY:E2E 516 Fremder Flug',
      'DTSTART;TZID=Europe/Berlin:20381103T100000', 'DTEND;TZID=America/New_York:20381103T130000',
      'END:VEVENT', 'END:VCALENDAR', ''
    ].join('\r\n');
    const imported = await page.request.post(`/api/calendars/${encodeURIComponent(calendarId)}/import`, { headers: SAME_ORIGIN, data: { ics } });
    expect(imported.status()).toBe(202);
    const jobId = (await imported.json()).id;
    await expect.poll(async () => (await (await page.request.get(`/api/calendars/import-jobs/${jobId}`)).json()).status,
      { timeout: 15000 }).toBe('done');

    const range = ['2038-11-01T00:00:00Z', '2038-11-06T00:00:00Z'];
    const [before] = await eventsIn(page, ...range);
    expect(before.start).toBe('2038-11-03T09:00:00.000Z');
    expect(before.end).toBe('2038-11-03T17:00:00.000Z');

    await openApp(page, '2038-11-03');
    await page.locator('.event-chip', { hasText: 'E2E 516 Fremder Flug' }).first().click();
    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-title')).toHaveText('Termin bearbeiten');

    // Zones that differ from the user's open the control on their own.
    await expect(page.locator('#ev-tz-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#ev-start-tz')).toBeVisible();
    await expect(page.locator('#ev-start-tz')).toHaveValue('Europe/Berlin');
    await expect(page.locator('#ev-end-tz')).toHaveValue('America/New_York');
    await expect(page.locator('#ev-start-date')).toHaveValue('2038-11-03');
    await expect(page.locator('#ev-start-time')).toHaveValue('10:00');
    await expect(page.locator('#ev-end-date')).toHaveValue('2038-11-03');
    await expect(page.locator('#ev-end-time')).toHaveValue('13:00');

    await page.fill('#ev-title', 'E2E 516 Fremder Flug bearbeitet');
    await page.click('#event-save-btn');
    await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/, { timeout: 15000 });
    await expectSavesLanded(page);

    const [after] = await eventsIn(page, ...range);
    expect(after.title).toBe('E2E 516 Fremder Flug bearbeitet');
    expect(after.start).toBe('2038-11-03T09:00:00.000Z');
    expect(after.end).toBe('2038-11-03T17:00:00.000Z');
    expect(after.startTimeZone).toBe('Europe/Berlin');
    expect(after.endTimeZone).toBe('America/New_York');
    const lines = await storedIcsLines(page);
    expect(lines).toContain('DTSTART;TZID=Europe/Berlin:20381103T100000');
    expect(lines).toContain('DTEND;TZID=America/New_York:20381103T130000');
    expect(lines).toContain('TZID:Europe/Berlin');
    expect(lines).toContain('TZID:America/New_York');
  });
});
