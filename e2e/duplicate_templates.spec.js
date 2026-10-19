const { test, expect } = require('./fixtures.js');

// Issue #515: "Duplizieren" in the event and task dialogs and in the context menu opens an unsaved
// copy; "Als Vorlage speichern" keeps the fields without date and time, per user, and "Neu aus
// Vorlage" offers them when creating. Every result is checked through the API, not the DOM alone.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const RANGE = 'start=2038-05-01T00:00:00Z&end=2038-06-01T00:00:00Z';

let calendarId;
let listId;

async function createCollection(page, name, type) {
  const res = await page.request.post('/api/calendars', {
    headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name, type }
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function eventsIn(page) {
  const res = await page.request.get(`/api/events?${RANGE}&calendarId=${encodeURIComponent(calendarId)}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).events;
}

async function tasksIn(page) {
  const res = await page.request.get('/api/tasks');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).filter(t => t.calendarId === listId);
}

async function templates(page, kind) {
  const res = await page.request.get(`/api/templates?kind=${kind}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).templates;
}

// Records the app's writes of events and tasks, so a test can show that nothing was stored early.
function recordWrites(page) {
  const writes = [];
  page.on('request', r => {
    const path = new URL(r.url()).pathname;
    if (r.method() !== 'GET' && /^\/api\/(events|tasks)\b/.test(path)) writes.push(`${r.method()} ${path}`);
  });
  return writes;
}

async function openApp(page) {
  await page.goto('/?date=2038-05-12');
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
}

async function openKanban(page) {
  await page.click('#view-kanban');
  await expect(page.locator('.kanban-board')).toBeVisible();
}

// Event saves are optimistic (#174): wait until the stored event replaced the preview.
async function expectSavesLanded(page) {
  await expect(page.locator('.event-pending')).toHaveCount(0, { timeout: 15000 });
}

async function openEventSection(page, name) {
  const section = page.locator(`#ev-section-${name}`);
  if (await section.getAttribute('open') === null) await section.locator('> summary').click();
}

test.describe('Issue #515 — duplicate an event or task, and templates', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (window.origin === 'null') return;
      window.localStorage.setItem('welcome-popup-closed', 'true');
      window.localStorage.setItem('activeView', 'month');
    });
    await openApp(page);
    const run = Date.now().toString(36);
    calendarId = await createCollection(page, `E2E 515 Kalender ${run}`, 'calendar');
    listId = await createCollection(page, `E2E 515 Liste ${run}`, 'tasklist');
  });

  test('"Duplizieren" in the event dialog opens an unsaved copy; saving it stores a second event with its own UID', async ({ page }) => {
    const created = await page.request.post('/api/events', { headers: SAME_ORIGIN, data: {
      calendarId, title: 'E2E 515 Planung', start: '2038-05-12T10:00:00.000Z', end: '2038-05-12T11:00:00.000Z',
      location: 'Raum 1', attendees: [{ name: 'Test User', email: 'testuser@example.com', status: 'ACCEPTED' }]
    } });
    expect(created.status()).toBe(201);
    await openApp(page);
    const writes = recordWrites(page);

    await page.locator('.event-chip', { hasText: 'E2E 515 Planung' }).first().click();
    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-title')).toHaveText('Termin bearbeiten');
    await page.click('#event-duplicate-btn');

    await expect(page.locator('#event-modal-title')).toHaveText('Termin duplizieren');
    await expect(page.locator('#ev-title')).toHaveValue('E2E 515 Planung');
    await expect(page.locator('#ev-title')).toBeFocused();
    await expect(page.locator('#ev-location')).toHaveValue('Raum 1');
    await expect(page.locator('#delete-event-btn')).toBeHidden();
    await expect(page.locator('#event-duplicate-btn')).toBeHidden();
    // The copy's attendee has not answered it, and nothing was stored or sent yet.
    await expect(page.locator('#ev-attendee-list .attendee-status')).toHaveText('Ausstehend');
    expect(writes).toEqual([]);
    expect((await eventsIn(page)).length).toBe(1);

    await page.fill('#ev-start-date', '2038-05-14');
    await page.fill('#ev-end-date', '2038-05-14');
    await page.click('#event-save-btn');
    await expect(page.locator('#toast-container .toast.success', { hasText: 'Termin erstellt.' })).toBeVisible({ timeout: 10000 });
    await expectSavesLanded(page);

    const events = await eventsIn(page);
    expect(events.map(e => e.title)).toEqual(['E2E 515 Planung', 'E2E 515 Planung']);
    expect(new Set(events.map(e => e.uid)).size).toBe(2);
    const copy = events.find(e => e.start.startsWith('2038-05-14'));
    const original = events.find(e => e.start.startsWith('2038-05-12'));
    expect(copy.location).toBe('Raum 1');
    expect(copy.attendees.map(a => [a.email, a.status])).toEqual([['testuser@example.com', 'NEEDS-ACTION']]);
    expect(original.attendees.map(a => a.status)).toEqual(['ACCEPTED']);
    expect(writes).toEqual(['POST /api/events']);
  });

  test('the context menu of an event offers "Duplizieren", by mouse and by keyboard', async ({ page }) => {
    const created = await page.request.post('/api/events', { headers: SAME_ORIGIN, data: {
      calendarId, title: 'E2E 515 Menü', start: '2038-05-12T10:00:00.000Z', end: '2038-05-12T11:00:00.000Z'
    } });
    expect(created.status()).toBe(201);
    await openApp(page);
    const writes = recordWrites(page);
    const chip = page.locator('.event-chip', { hasText: 'E2E 515 Menü' }).first();
    const item = page.getByRole('menuitem', { name: 'Duplizieren' });

    // The menu key / Shift+F10 sends the focused event a contextmenu event without a pointer
    // position (headless Chromium does not turn the key press into one, so it is sent directly).
    // The menu opens at the event with its item focused; Escape closes it and gives the focus back.
    await chip.focus();
    await chip.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
    await expect(item).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.context-menu')).toHaveCount(0);
    await expect(chip).toBeFocused();

    await chip.click({ button: 'right' });
    await expect(item).toBeVisible();
    await item.click();
    await expect(page.locator('.context-menu')).toHaveCount(0);
    await expect(page.locator('#event-modal-backdrop')).not.toHaveClass(/hidden/);
    await expect(page.locator('#event-modal-title')).toHaveText('Termin duplizieren');
    await expect(page.locator('#ev-title')).toHaveValue('E2E 515 Menü');
    expect(writes).toEqual([]);

    await page.click('#event-save-btn');
    await expect(page.locator('#toast-container .toast.success', { hasText: 'Termin erstellt.' })).toBeVisible({ timeout: 10000 });
    await expectSavesLanded(page);
    const events = await eventsIn(page);
    expect(events.map(e => e.title)).toEqual(['E2E 515 Menü', 'E2E 515 Menü']);
    expect(new Set(events.map(e => e.uid)).size).toBe(2);
  });

  test('a task is duplicated from its dialog and from the context menu of its card', async ({ page }) => {
    const created = await page.request.post('/api/tasks', { headers: SAME_ORIGIN, data: {
      calendarId: listId, title: 'E2E 515 Bericht', description: 'Zahlen', priority: 1,
      due: '2038-05-20T00:00:00.000Z', dueIsDate: true
    } });
    expect(created.status()).toBe(201);
    await openApp(page);
    await openKanban(page);
    const writes = recordWrites(page);

    const card = page.locator('.kanban-card', { hasText: 'E2E 515 Bericht' });
    await card.first().locator('.btn-edit').click();
    await expect(page.locator('#task-modal-title')).toHaveText('Aufgabe bearbeiten');
    await page.click('#task-duplicate-btn');
    await expect(page.locator('#task-modal-title')).toHaveText('Aufgabe duplizieren');
    await expect(page.locator('#task-description')).toHaveValue('Zahlen');
    await expect(page.locator('#task-duplicate-btn')).toBeHidden();
    expect(writes).toEqual([]);
    await page.click('#task-save-btn');
    await expect(page.locator('#toast-container .toast.success', { hasText: 'Aufgabe erstellt.' })).toBeVisible({ timeout: 10000 });
    await expect(card).toHaveCount(2, { timeout: 10000 });

    await card.first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplizieren' }).click();
    await expect(page.locator('#task-modal-title')).toHaveText('Aufgabe duplizieren');
    await page.fill('#task-title', 'E2E 515 Bericht Kopie');
    await page.click('#task-save-btn');
    await expect.poll(async () => (await tasksIn(page)).length, { timeout: 10000 }).toBe(3);

    const tasks = await tasksIn(page);
    expect(new Set(tasks.map(t => t.uid)).size).toBe(3);
    expect(tasks.map(t => t.title).sort()).toEqual(['E2E 515 Bericht', 'E2E 515 Bericht', 'E2E 515 Bericht Kopie']);
    for (const t of tasks) {
      expect(t.description).toBe('Zahlen');
      expect(t.priority).toBe(1);
      expect(t.due.slice(0, 10)).toBe('2038-05-20');
    }
    expect(writes.filter(w => w.startsWith('POST'))).toEqual(['POST /api/tasks', 'POST /api/tasks']);
  });

  test('"Als Vorlage speichern" keeps an event without date and time; "Neu aus Vorlage" fills a new event', async ({ page }) => {
    await openApp(page);
    await page.click('#new-event-btn');
    // Without templates there is nothing to choose from.
    await expect(page.locator('#ev-template-row')).toBeHidden();
    await page.fill('#ev-title', 'E2E 515 Teamrunde');
    await page.selectOption('#ev-calendar', calendarId);
    await page.fill('#ev-location', 'Raum 2');
    await page.fill('#ev-start-date', '2038-05-13');
    await page.fill('#ev-end-date', '2038-05-13');
    await page.fill('#ev-start-time', '09:00');
    await page.fill('#ev-end-time', '09:30');
    await openEventSection(page, 'attendees');
    await page.fill('#ev-attendee-email', 'testuser@example.com');
    await page.click('#add-attendee-btn');
    await openEventSection(page, 'alarm');
    await page.click('#ev-add-reminder');
    const reminder = page.locator('#ev-reminder-list .reminder-row').last();
    await reminder.locator('.reminder-amount').fill('10');
    await reminder.locator('.reminder-unit').selectOption('M');
    await reminder.locator('.reminder-direction').selectOption('-');
    await page.click('#event-template-btn');
    await expect(page.locator('#toast-container .toast.success', { hasText: 'Vorlage „E2E 515 Teamrunde“ gespeichert.' })).toBeVisible();
    // Saving the template stored no event.
    expect(await eventsIn(page)).toEqual([]);
    await page.click('#event-cancel-btn');

    const [stored] = await templates(page, 'event');
    expect(stored.name).toBe('E2E 515 Teamrunde');
    expect(stored.fields).toMatchObject({
      title: 'E2E 515 Teamrunde', calendarId, location: 'Raum 2', allDay: false,
      attendees: [{ name: '', email: 'testuser@example.com' }],
      alarms: [{ action: 'DISPLAY', trigger: '-PT10M', description: 'E2E 515 Teamrunde' }]
    });
    for (const key of ['start', 'end', 'startTimeZone', 'endTimeZone', 'recurrence']) expect(stored.fields).not.toHaveProperty(key);

    // The template is the user's, on the server: another visit offers it.
    await openApp(page);
    await page.click('#new-event-btn');
    await expect(page.locator('#ev-template-row')).toBeVisible();
    await expect(page.locator('#ev-title')).toHaveValue('');
    await page.selectOption('#ev-template', { label: 'E2E 515 Teamrunde' });
    await expect(page.locator('#ev-title')).toHaveValue('E2E 515 Teamrunde');
    await expect(page.locator('#ev-location')).toHaveValue('Raum 2');
    await expect(page.locator('#ev-calendar')).toHaveValue(calendarId);
    await expect(page.locator('#ev-attendee-list .attendee-email')).toHaveText('testuser@example.com');
    await expect(page.locator('#ev-reminder-list .reminder-row')).toHaveCount(1);
    // Date and time stay those of the new event.
    await expect(page.locator('#ev-start-date')).toHaveValue('2038-05-12');
    await page.click('#event-save-btn');
    await expect(page.locator('#toast-container .toast.success', { hasText: 'Termin erstellt.' })).toBeVisible({ timeout: 10000 });
    await expectSavesLanded(page);
    const [made] = await eventsIn(page);
    expect(made.title).toBe('E2E 515 Teamrunde');
    expect(made.location).toBe('Raum 2');
    // The default start time is near "now"; late in the evening it is past midnight in Berlin while the
    // stored UTC instant is still the day before, so compare the day in the browser's zone.
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(made.start))).toBe('2038-05-12');

    // Editing an event offers no templates; a template can be deleted.
    await page.locator('.event-chip', { hasText: 'E2E 515 Teamrunde' }).first().click();
    await page.click('#popover-edit-btn');
    await expect(page.locator('#event-modal-title')).toHaveText('Termin bearbeiten');
    await expect(page.locator('#ev-template-row')).toBeHidden();
    await page.click('#event-cancel-btn');
    await page.click('#new-event-btn');
    await page.selectOption('#ev-template', { label: 'E2E 515 Teamrunde' });
    await page.click('#ev-template-delete');
    await page.click('#confirm-dialog-ok');
    await expect(page.locator('#ev-template-row')).toBeHidden();
    expect(await templates(page, 'event')).toEqual([]);
  });

  test('a task template keeps the task without its dates and fills a new task', async ({ page }) => {
    await openApp(page);
    await openKanban(page);
    await page.click('#new-task-btn');
    await expect(page.locator('#task-template-row')).toBeHidden();
    await page.fill('#task-title', 'E2E 515 Wochenbericht');
    await page.fill('#task-description', 'Zahlen eintragen');
    await page.selectOption('#task-calendar-id', listId);
    await page.selectOption('#task-priority', 'high');
    await page.fill('#task-due', '2038-05-20T12:00');
    await page.click('#task-template-btn');
    await expect(page.locator('#toast-container .toast.success', { hasText: 'Vorlage „E2E 515 Wochenbericht“ gespeichert.' })).toBeVisible();
    await page.click('#task-cancel-btn');
    expect(await tasksIn(page)).toEqual([]);

    const [stored] = await templates(page, 'task');
    expect(stored.fields).toEqual({
      title: 'E2E 515 Wochenbericht', calendarId: listId, description: 'Zahlen eintragen', priority: 1, duration: null, alarms: []
    });

    await page.click('#new-task-btn');
    await expect(page.locator('#task-template-row')).toBeVisible();
    await page.selectOption('#task-template', { label: 'E2E 515 Wochenbericht' });
    await expect(page.locator('#task-title')).toHaveValue('E2E 515 Wochenbericht');
    await expect(page.locator('#task-description')).toHaveValue('Zahlen eintragen');
    await expect(page.locator('#task-calendar-id')).toHaveValue(listId);
    await expect(page.locator('#task-priority')).toHaveValue('high');
    await expect(page.locator('#task-due')).toHaveValue('');
    await page.click('#task-save-btn');
    await expect(page.locator('#toast-container .toast.success', { hasText: 'Aufgabe erstellt.' })).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => (await tasksIn(page)).map(t => t.title), { timeout: 10000 }).toEqual(['E2E 515 Wochenbericht']);
  });
});
