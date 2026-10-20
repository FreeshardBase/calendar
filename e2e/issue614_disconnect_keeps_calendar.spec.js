const { test, expect } = require('./fixtures.js');
const sqlite3 = require('sqlite3');
const crypto = require('crypto');
const { Agent } = require('undici');
const { webServer } = require('../playwright.config.js');

// Issue #614: disconnecting a Microsoft 365 account keeps its mirror as a normal, editable shard
// calendar labelled "früher Microsoft 365"; linking the same account again offers to re-attach it,
// and accepting pairs the new account with the same calendar instead of mirroring it a second time.
// The mirror and the account are seeded as msgraph_worker.py and the OAuth callback leave them.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const DATABASE_PATH = webServer.env.DATABASE_PATH;

function sql(method, statement, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DATABASE_PATH);
    db.configure('busyTimeout', 5000); // the webServer writes the same file concurrently
    db[method](statement, params, (err, rows) => db.close(() => (err ? reject(err) : resolve(rows))));
  });
}

async function davRequest(user, method, path, body) {
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  try {
    const res = await fetch(`${webServer.env.INTERNAL_CALDAV_URL}${path}`, {
      method, dispatcher, body,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${user}:${webServer.env.SYSTEM_SYNC_SECRET}`).toString('base64'),
        'Accept-Encoding': 'identity',
        'Content-Type': 'application/xml; charset=utf-8',
      },
    });
    return res.status;
  } finally {
    await dispatcher.close();
  }
}

async function linkMicrosoft(user) {
  const id = `e2e-issue614-${crypto.randomBytes(6).toString('hex')}`;
  await sql('run',
    `INSERT INTO msgraph_accounts (id, user_id, account_email, access_token, refresh_token, expires_at,
       reconnect_required, created_at, updated_at) VALUES (?, ?, 'testuser@example.com', '', '', 0, 0, ?, ?)`,
    [id, user, Date.now(), Date.now()]);
  return id;
}

test('Issue #614 — disconnect keeps the calendar editable, relinking re-attaches it without duplicates', async ({ page, e2eUser }) => {
  await page.addInitScript(() => {
    if (window.origin !== 'null') window.localStorage.setItem('welcome-popup-closed', 'true');
  });
  const collection = `msgraph-${crypto.randomBytes(16).toString('hex')}`;
  const calendarId = `internal-caldav::/${e2eUser}/${collection}/`;
  expect(await davRequest(e2eUser, 'MKCALENDAR', `/${e2eUser}/${collection}/`, `<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>
<d:displayname>Outlook Arbeit</d:displayname>
<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
</d:prop></d:set></c:mkcalendar>`)).toBe(201);
  const firstAccount = await linkMicrosoft(e2eUser);
  await sql('run',
    `INSERT INTO msgraph_calendar_collections (account_id, user_id, graph_calendar_id, local_collection, created_at)
     VALUES (?, ?, 'graph-cal-work', ?, ?)`, [firstAccount, e2eUser, collection, Date.now()]);
  let secondAccount;
  try {
    await page.goto('/');
    await expect(page.locator('#app')).not.toHaveClass(/hidden/, { timeout: 10000 });
    const item = page.locator(`#calendar-list .calendar-item[data-cal-id="${calendarId}"]`);
    await expect(item).toBeVisible({ timeout: 10000 });
    await expect(item.locator('.calendar-former-link')).toHaveCount(0);

    // Disconnect the account in the Microsoft 365 dialog.
    await page.click('#sidebar-settings-btn');
    await page.click('#settings-add-account-btn');
    await page.click('#btn-link-msgraph');
    await expect(page.locator('#msgraph-modal-backdrop')).not.toHaveClass(/hidden/);
    await page.locator('#msgraph-accounts-list .btn-delete-msgraph').click();
    await expect(page.locator('#confirm-dialog-text')).toContainText('bleiben als eigene Kalender erhalten');
    await page.click('#confirm-dialog-ok');
    await expect(page.locator('#msgraph-accounts-list .btn-delete-msgraph')).toHaveCount(0);

    // The calendar is still there, as the shard's own, and says where it came from.
    await expect(item.locator('.calendar-former-link')).toHaveText('früher Microsoft 365');
    await expect(page.locator('#calendar-list .calendar-group-label')).toHaveCount(0);
    const created = await page.request.post('/api/events', { headers: SAME_ORIGIN, data: {
      calendarId, title: 'E2E 614 Termin', start: '2038-05-12T10:00:00.000Z', end: '2038-05-12T11:00:00.000Z'
    } });
    expect(created.status()).toBe(201);

    // Linking the same account again offers the kept calendar back.
    secondAccount = await linkMicrosoft(e2eUser);
    await page.reload();
    await expect(page.locator('#confirm-dialog-title')).toHaveText('Kalender wieder verbinden', { timeout: 10000 });
    await expect(page.locator('#confirm-dialog-text')).toContainText('„Outlook Arbeit“');
    await page.click('#confirm-dialog-ok');
    await expect(item.locator('.calendar-former-link')).toHaveCount(0);
    await expect(page.locator('#calendar-list .calendar-group-label')).toHaveText(['testuser@example.com']);

    // The new account syncs into the same calendar; there is no second mirror.
    expect(await sql('all', 'SELECT account_id, local_collection FROM msgraph_calendar_collections WHERE user_id = ?', [e2eUser]))
      .toEqual([{ account_id: secondAccount, local_collection: collection }]);
    const events = await (await page.request.get(
      `/api/events?start=2038-05-01T00:00:00Z&end=2038-06-01T00:00:00Z&calendarId=${encodeURIComponent(calendarId)}`)).json();
    expect(events.events.map(e => e.title)).toEqual(['E2E 614 Termin']);

    // No second offer on the next load.
    await page.reload();
    await expect(item).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#confirm-dialog-backdrop')).toHaveClass(/hidden/);
  } finally {
    await sql('run', 'DELETE FROM msgraph_calendar_collections WHERE user_id = ?', [e2eUser]);
    await sql('run', 'DELETE FROM detached_mirrors WHERE user_id = ?', [e2eUser]);
    await sql('run', 'DELETE FROM msgraph_accounts WHERE user_id = ?', [e2eUser]);
  }
});
