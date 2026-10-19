const { test, expect } = require('./fixtures.js');
const { Agent } = require('undici');
const { webServer } = require('../playwright.config.js');

// Issue #518: subtasks (RELATED-TO;RELTYPE=PARENT) as a checklist in the task dialog, including
// subtasks another client wrote; priority as high/medium/low, edited, sorted and filtered; and a
// per-task-list toggle for showing due tasks in the calendar views. Results are checked through
// the API and Radicale, not the DOM alone.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

let listId;

async function createList(page, name) {
  const res = await page.request.post('/api/calendars', {
    headers: SAME_ORIGIN, data: { accountId: 'internal-caldav', name, type: 'tasklist' }
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function createTask(page, data) {
  const res = await page.request.post('/api/tasks', { headers: SAME_ORIGIN, data: { calendarId: listId, ...data } });
  expect(res.status()).toBe(201);
  return res.json();
}

async function tasksIn(page) {
  const res = await page.request.get('/api/tasks');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).filter(t => t.calendarId === listId);
}

// Radicale as another CalDAV client (Thunderbird) sees it, with the test user's credentials.
async function caldav(user, method, href, body) {
  const url = webServer.env.INTERNAL_CALDAV_URL.replace(/\/+$/, '') + href;
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  try {
    const res = await fetch(url, {
      method, dispatcher, body,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${user}:${webServer.env.SYSTEM_SYNC_SECRET}`).toString('base64'),
        'Accept-Encoding': 'identity',
        ...(body ? { 'Content-Type': 'text/calendar; charset=utf-8' } : {}),
      },
    });
    expect(res.ok, `${method} ${href}: ${res.status}`).toBeTruthy();
    return res.text();
  } finally {
    await dispatcher.close();
  }
}

async function openApp(page) {
  await page.goto('/?date=2038-05-12');
  await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
}

async function openKanban(page) {
  await page.click('#view-kanban');
  await expect(page.locator('.kanban-board')).toBeVisible();
}

async function openTaskList(page) {
  await page.click('#view-kanban');
  const listBtn = page.locator('.task-view-btn[data-task-view="list"]');
  if (await listBtn.getAttribute('aria-pressed') !== 'true') await listBtn.click();
  await expect(page.locator('.task-list-controls')).toBeVisible();
}

function card(page, title) {
  return page.locator('.kanban-card', { has: page.locator('.kanban-card-title', { hasText: title }) });
}

test.describe('Issue #518 — subtasks, priority and due tasks in the calendar', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (window.origin === 'null') return;
      window.localStorage.setItem('welcome-popup-closed', 'true');
      window.localStorage.setItem('activeView', 'month');
    });
    await openApp(page);
    listId = await createList(page, `E2E 518 Liste ${Date.now().toString(36)}`);
  });

  test('#518 the task dialog lists subtasks as a checklist, including one written by Thunderbird, and keeps them', async ({ page, e2eUser }) => {
    const parent = await createTask(page, { title: 'E2E 518 Umzug' });
    await createTask(page, { title: 'Kartons kaufen', parentUid: parent.uid });
    await createTask(page, { title: 'Unrelated task' });
    // Thunderbird writes RELATED-TO without RELTYPE and properties of its own.
    const listHref = listId.split('::')[1];
    const foreignHref = `${listHref}thunderbird-518.ics`;
    await caldav(e2eUser, 'PUT', foreignHref, [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN',
      'BEGIN:VTODO', 'UID:thunderbird-518', 'DTSTAMP:20380501T000000Z', 'SUMMARY:Umzugswagen mieten',
      `RELATED-TO:${parent.uid}`, 'X-MOZ-GENERATION:3', 'END:VTODO', 'END:VCALENDAR', ''
    ].join('\r\n'));

    await openApp(page);
    await openKanban(page);
    await card(page, 'E2E 518 Umzug').locator('.btn-edit').click();
    await expect(page.locator('#task-modal-title')).toHaveText('Aufgabe bearbeiten');

    const items = page.locator('#task-subtask-list .task-subtask-item');
    await expect(items).toHaveText(['Kartons kaufen', 'Umzugswagen mieten']);
    await expect(items.locator('input[type="checkbox"]')).toHaveCount(2);

    // Ticking the foreign subtask completes it and keeps its parent and Thunderbird's properties.
    const foreignCheck = page.locator('#task-subtask-list').getByLabel('Umzugswagen mieten');
    await foreignCheck.check();
    await expect(items.filter({ hasText: 'Umzugswagen mieten' })).toHaveClass(/is-done/, { timeout: 10000 });
    await expect(foreignCheck).toBeChecked();
    await expect(foreignCheck).toBeFocused();
    const foreign = (await tasksIn(page)).find(t => t.uid === 'thunderbird-518');
    expect(foreign.status).toBe('COMPLETED');
    expect(foreign.parentUid).toBe(parent.uid);
    const stored = await caldav(e2eUser, 'GET', foreignHref);
    expect(stored).toMatch(new RegExp(`RELATED-TO:${parent.uid}`));
    expect(stored).toMatch(/X-MOZ-GENERATION:3/);

    // A new subtask is added with Enter; the dialog stays open and lists it.
    await page.fill('#task-subtask-new', 'Nachsendeauftrag stellen');
    await page.press('#task-subtask-new', 'Enter');
    await expect(items).toHaveText(['Kartons kaufen', 'Nachsendeauftrag stellen', 'Umzugswagen mieten'], { timeout: 10000 });
    await expect(page.locator('#task-modal-backdrop')).toBeVisible();
    await expect(page.locator('#task-subtask-new')).toHaveValue('');
    await expect(page.locator('#task-subtask-new')).toBeFocused();
    const added = (await tasksIn(page)).find(t => t.title === 'Nachsendeauftrag stellen');
    expect(added.parentUid).toBe(parent.uid);
    expect(added.status).toBe('NEEDS-ACTION');

    // Saving the parent itself keeps every subtask's relation.
    await page.fill('#task-title', 'E2E 518 Umzug planen');
    await page.click('#task-form button[type="submit"]');
    await expect(page.locator('#task-modal-backdrop')).toBeHidden();
    const after = await tasksIn(page);
    expect(after.filter(t => t.parentUid === parent.uid).map(t => t.title).sort())
      .toEqual(['Kartons kaufen', 'Nachsendeauftrag stellen', 'Umzugswagen mieten']);
    expect(after.find(t => t.title === 'Unrelated task').parentUid).toBeNull();
  });

  test('#518 a new task has no checklist until it is saved', async ({ page }) => {
    await openKanban(page);
    await page.click('#new-task-btn');
    await expect(page.locator('#task-modal-title')).toHaveText('Neue Aufgabe');
    await expect(page.locator('#task-subtasks-group')).toHaveCount(1);
    await expect(page.locator('#task-subtasks-group')).toBeHidden();
  });

  test('#518 priority is shown as high/medium/low, edited, sorted and filtered', async ({ page }) => {
    // 2 is "high" as another client writes it; the app writes 1, 5 and 9.
    await createTask(page, { title: 'Prio fremd hoch', priority: 2 });
    await createTask(page, { title: 'Prio mittel', priority: 5 });
    await createTask(page, { title: 'Prio niedrig', priority: 7 });
    await createTask(page, { title: 'Prio ohne' });

    await openApp(page);
    await openTaskList(page);
    const rows = page.locator('.task-list-row');
    await page.selectOption('#task-list-sort', 'priority');
    await expect(rows.locator('.task-list-title')).toHaveText(['Prio fremd hoch', 'Prio mittel', 'Prio niedrig', 'Prio ohne']);
    await expect(rows.locator('.task-list-priority')).toHaveText(['Hoch', 'Mittel', 'Niedrig', '']);

    await page.selectOption('#task-list-priority', 'high');
    await expect(rows.locator('.task-list-title')).toHaveText(['Prio fremd hoch']);
    await page.selectOption('#task-list-priority', 'none');
    await expect(rows.locator('.task-list-title')).toHaveText(['Prio ohne']);
    await page.selectOption('#task-list-priority', 'all');
    await expect(rows).toHaveCount(4);

    // Editing another field leaves the foreign value 2 as it is; it is still "high".
    await rows.locator('.task-list-title', { hasText: 'Prio fremd hoch' }).click();
    await expect(page.locator('#task-priority')).toHaveValue('high');
    await page.fill('#task-description', 'Notiz');
    await page.click('#task-form button[type="submit"]');
    await expect(page.locator('#task-modal-backdrop')).toBeHidden();
    await expect.poll(async () => (await tasksIn(page)).find(t => t.title === 'Prio fremd hoch').description).toBe('Notiz');
    expect((await tasksIn(page)).find(t => t.title === 'Prio fremd hoch').priority).toBe(2);

    // Choosing a level stores its RFC 5545 value.
    await rows.locator('.task-list-title', { hasText: 'Prio ohne' }).click();
    await expect(page.locator('#task-priority')).toHaveValue('');
    await page.selectOption('#task-priority', 'low');
    await page.click('#task-form button[type="submit"]');
    await expect(page.locator('#task-modal-backdrop')).toBeHidden();
    await expect.poll(async () => (await tasksIn(page)).find(t => t.title === 'Prio ohne').priority).toBe(9);
    await expect(rows.filter({ hasText: 'Prio ohne' }).locator('.task-list-priority')).toHaveText('Niedrig');

    await page.click('.task-view-btn[data-task-view="kanban"]');
    await expect(card(page, 'Prio fremd hoch').locator('.kanban-prio')).toHaveText('Hoch');
    await expect(card(page, 'Prio niedrig').locator('.kanban-prio')).toHaveText('Niedrig');
  });

  test('#518 due tasks show in the calendar views per task list, and the choice is kept', async ({ page }) => {
    const otherListId = await createList(page, `E2E 518 Andere ${Date.now().toString(36)}`);
    await createTask(page, { title: 'Steuer abgeben', due: '2038-05-12T00:00:00.000Z', dueIsDate: true });
    const other = await page.request.post('/api/tasks', { headers: SAME_ORIGIN, data: {
      calendarId: otherListId, title: 'Rasen mähen', due: '2038-05-13T00:00:00.000Z', dueIsDate: true
    } });
    expect(other.status()).toBe(201);

    await openApp(page);
    const chip = title => page.locator('#calendar-container .calendar-task', { hasText: title });
    await expect(chip('Steuer abgeben')).toHaveCount(1);
    await expect(chip('Rasen mähen')).toHaveCount(1);

    // The task view's sidebar lists the task lists with the toggle.
    await openKanban(page);
    const toggle = page.locator(`#calendar-list [data-tasks-in-cal="${listId}"]`);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toBeFocused();
    // Toggling did not hide the list itself.
    await expect(page.locator(`#calendar-list .calendar-item[data-cal-id="${listId}"]`)).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await (await page.request.get('/api/preferences')).json()).tasksHiddenInCalendar)
      .toEqual([listId]);

    await page.click('#view-month');
    await expect(chip('Rasen mähen')).toHaveCount(1);
    await expect(chip('Steuer abgeben')).toHaveCount(0);

    // The choice is the user's, kept on the server across reloads.
    await openApp(page);
    await expect(chip('Rasen mähen')).toHaveCount(1);
    await expect(chip('Steuer abgeben')).toHaveCount(0);

    await openKanban(page);
    await page.locator(`#calendar-list [data-tasks-in-cal="${listId}"]`).click();
    await expect(page.locator(`#calendar-list [data-tasks-in-cal="${listId}"]`)).toHaveAttribute('aria-pressed', 'true');
    await page.click('#view-month');
    await expect(chip('Steuer abgeben')).toHaveCount(1);
    await expect.poll(async () => (await (await page.request.get('/api/preferences')).json()).tasksHiddenInCalendar)
      .toEqual([]);
  });
});
