const { test, expect } = require('./fixtures.js');

// Issue #521: one-click video conference link. Off by default: the event dialog offers no button.
// The user sets a Jitsi server in the settings, which asks first and says where the link leads.
// "Videokonferenz hinzufügen" then appends a random room name to that server, without any request,
// and the saved event carries it as CONFERENCE (RFC 7986) and as a line in the description.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const JITSI = 'https://meet.example.org';
const ROOM = /^https:\/\/meet\.example\.org\/freeshard-[a-z2-7]{20}$/;

async function savedEvent(page, calendarId, title) {
  const res = await page.request.get(`/api/events?start=2037-04-01T00:00:00Z&end=2037-06-15T00:00:00Z&calendarId=${encodeURIComponent(calendarId)}`);
  return (await res.json()).events.find(e => e.title === title);
}

async function conferencePref(page) {
  return (await (await page.request.get('/api/preferences')).json()).conferenceBaseUrl;
}

test('Issue #521 — "Videokonferenz hinzufügen" only after opt-in; the link is saved as CONFERENCE and in the description', async ({ page, baseURL }) => {
  const shard = new URL(baseURL).host;
  const foreign = [];
  page.on('request', req => {
    const url = new URL(req.url());
    if (/^https?:$/.test(url.protocol) && url.host !== shard) foreign.push(req.url());
  });
  await page.addInitScript(() => {
    if (window.origin === 'null') return;
    window.localStorage.setItem('welcome-popup-closed', 'true');
    window.localStorage.setItem('activeView', 'month');
  });
  const created = await page.request.post('/api/calendars', {
    headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name: `E2E 521 ${Date.now().toString(36)}`, type: 'calendar' },
  });
  expect(created.status()).toBe(201);
  const calendarId = (await created.json()).id;
  await page.goto('/?date=2037-05-04');
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });

  const addBtn = page.locator('#ev-conference-add');
  const link = page.locator('#ev-conference-link');
  const description = page.locator('#ev-description');

  // Off by default: no button in the event dialog.
  await page.click('#new-event-btn');
  await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
  await expect(page.locator('#ev-title')).toBeVisible();
  await expect(addBtn).toBeHidden();
  await page.click('#event-cancel-btn');

  // Settings: off, and saying so; ticking the box only opens the server form.
  await page.click('#sidebar-settings-btn');
  const enabled = page.locator('#conference-enabled');
  const notice = page.locator('#conference-notice');
  const baseUrl = page.locator('#conference-base-url');
  await expect(enabled).not.toBeChecked();
  await expect(notice).toContainText('Aus');
  await expect(page.locator('#conference-form')).toBeHidden();
  await enabled.check();
  await expect(baseUrl).toBeVisible();
  await expect(baseUrl).toBeFocused();
  await expect(baseUrl).toHaveValue('https://meet.jit.si');
  expect(await conferencePref(page)).toBeNull();

  // Not a server address: an error, nothing saved.
  await baseUrl.fill('meet.example.org');
  await page.click('#conference-save-btn');
  await expect(page.locator('#conference-error')).toBeVisible();
  expect(await conferencePref(page)).toBeNull();

  // Saving asks first and names the server; declining keeps it off.
  await baseUrl.fill(`${JITSI}/`);
  await page.click('#conference-save-btn');
  await expect(page.locator('#confirm-dialog-backdrop')).not.toHaveClass(/hidden/);
  await expect(page.locator('#confirm-dialog-text')).toContainText('meet.example.org');
  await page.click('#confirm-dialog-cancel');
  await expect(enabled).not.toBeChecked();
  expect(await conferencePref(page)).toBeNull();

  await enabled.check();
  await baseUrl.fill(`${JITSI}/`);
  await page.click('#conference-save-btn');
  await page.click('#confirm-dialog-ok');
  await expect(notice).toContainText('meet.example.org');
  await expect(enabled).toBeChecked();
  await expect.poll(() => conferencePref(page)).toBe(JITSI);
  await page.click('#close-settings-btn');

  // The button adds a random room on that server, shows it, and writes it into the description.
  await page.click('#new-event-btn');
  await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
  await page.selectOption('#ev-calendar', calendarId);
  await page.fill('#ev-title', 'Abstimmung 521');
  await description.fill('Agenda folgt');
  await expect(addBtn).toBeVisible();
  await expect(addBtn).toHaveText('Videokonferenz hinzufügen');
  await addBtn.click();
  await expect(addBtn).toBeHidden();
  await expect(link).toBeVisible();
  await expect(link).toBeFocused();
  const room = await link.textContent();
  expect(room).toMatch(ROOM);
  await expect(link).toHaveAttribute('href', room);
  await expect(description).toHaveValue(`Agenda folgt\n\nVideokonferenz: ${room}`);

  await page.click('#event-save-btn');
  await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
  await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });

  const saved = await savedEvent(page, calendarId, 'Abstimmung 521');
  expect(saved.conference).toBe(room);
  expect(saved.description).toBe(`Agenda folgt\n\nVideokonferenz: ${room}`);
  const ics = (await (await page.request.get(`/api/calendars/${encodeURIComponent(calendarId)}/export`)).text())
    .replace(/\r?\n[ \t]/g, '');
  const conferenceLine = ics.split(/\r?\n/).find(l => l.startsWith('CONFERENCE;'));
  expect(conferenceLine.endsWith(`:${room}`)).toBe(true);
  expect(conferenceLine.split(':')[0].split(';').slice(1).sort())
    .toEqual(['FEATURE=AUDIO,VIDEO', 'LABEL=Videokonferenz', 'VALUE=URI']);

  // Every event gets its own room.
  await page.click('#new-event-btn');
  await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
  await expect(link).toBeHidden();
  await addBtn.click();
  const otherRoom = await link.textContent();
  expect(otherRoom).toMatch(ROOM);
  expect(otherRoom).not.toBe(room);
  await page.click('#event-cancel-btn');

  // Reopened, the link is there; removing it takes it out of the description too.
  await page.locator(`#calendar-container [data-event-uid="${saved.uid}"]`).first().click();
  const editBtn = page.locator('#popover-edit-btn');
  if (await editBtn.isVisible()) await editBtn.click();
  await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
  await expect(link).toHaveText(room);
  await expect(addBtn).toBeHidden();
  await page.click('#ev-conference-remove');
  await expect(link).toBeHidden();
  await expect(addBtn).toBeFocused();
  await expect(description).toHaveValue('Agenda folgt');
  await page.click('#event-save-btn');
  await expect(page.locator('#event-modal-backdrop')).toHaveClass(/hidden/);
  await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });
  await expect.poll(async () => (await savedEvent(page, calendarId, 'Abstimmung 521')).conference).toBeNull();

  // Switched off again, the button is gone.
  await page.click('#sidebar-settings-btn');
  await enabled.uncheck();
  await expect(notice).toContainText('Aus');
  await expect.poll(() => conferencePref(page)).toBeNull();
  await page.click('#close-settings-btn');
  await page.click('#new-event-btn');
  await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
  await expect(page.locator('#ev-title')).toBeVisible();
  await expect(addBtn).toBeHidden();

  // Creating the links contacted nobody.
  expect(foreign).toEqual([]);
});
