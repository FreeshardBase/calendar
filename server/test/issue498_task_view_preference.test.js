'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3498';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

// Issue #498: the task area's "Liste | Kanban" choice is remembered per user, on the server,
// so it follows the user to another browser and is never shared with another member.

const test = require('node:test');
const assert = require('assert');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const baseUrl = `http://localhost:${process.env.PORT}`;

function getPrefs(cookie) {
  return fetch(`${baseUrl}/api/preferences`, { headers: { cookie } });
}

function putPrefs(cookie, body) {
  return fetch(`${baseUrl}/api/preferences`, {
    method: 'PUT',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Issue #498 — task view preference', async (t) => {
  const run = Date.now().toString(36);
  const alice = `testuser-498-a-${run}`;
  const bob = `testuser-498-b-${run}`;
  let aliceCookie;
  let bobCookie;

  t.before(async () => {
    if (!server.listening) await new Promise(resolve => server.listen(process.env.PORT, resolve));
    aliceCookie = await loginAs(alice, { username: 'testuser', email: 'testuser@example.com' });
    bobCookie = await loginAs(bob, { username: 'testuser2', email: 'testuser2@example.com' });
  });

  t.after(async () => {
    await Db.deleteUser(alice);
    await Db.deleteUser(bob);
    server.close();
  });

  await t.test('a user who never chose sees the kanban board', async () => {
    const res = await getPrefs(aliceCookie);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { taskView: 'kanban', secondaryTimezone: null, tasksHiddenInCalendar: [], showWeekNumbers: false, conferenceBaseUrl: null, weekStart: null, timeFormat: null, defaultDuration: 60, defaultCalendarId: null, defaultReminder: null, timeZone: null });
  });

  await t.test('the choice is stored for that user only', async () => {
    const put = await putPrefs(aliceCookie, { taskView: 'list' });
    assert.strictEqual(put.status, 200);
    assert.deepStrictEqual(await put.json(), { taskView: 'list', secondaryTimezone: null, tasksHiddenInCalendar: [], showWeekNumbers: false, conferenceBaseUrl: null, weekStart: null, timeFormat: null, defaultDuration: 60, defaultCalendarId: null, defaultReminder: null, timeZone: null });

    assert.deepStrictEqual(await (await getPrefs(aliceCookie)).json(), { taskView: 'list', secondaryTimezone: null, tasksHiddenInCalendar: [], showWeekNumbers: false, conferenceBaseUrl: null, weekStart: null, timeFormat: null, defaultDuration: 60, defaultCalendarId: null, defaultReminder: null, timeZone: null });
    assert.deepStrictEqual(await (await getPrefs(bobCookie)).json(), { taskView: 'kanban', secondaryTimezone: null, tasksHiddenInCalendar: [], showWeekNumbers: false, conferenceBaseUrl: null, weekStart: null, timeFormat: null, defaultDuration: 60, defaultCalendarId: null, defaultReminder: null, timeZone: null });

    await putPrefs(aliceCookie, { taskView: 'kanban' });
    assert.deepStrictEqual(await (await getPrefs(aliceCookie)).json(), { taskView: 'kanban', secondaryTimezone: null, tasksHiddenInCalendar: [], showWeekNumbers: false, conferenceBaseUrl: null, weekStart: null, timeFormat: null, defaultDuration: 60, defaultCalendarId: null, defaultReminder: null, timeZone: null });
  });

  await t.test('an unknown view is refused and nothing changes', async () => {
    await putPrefs(bobCookie, { taskView: 'list' });
    for (const body of [{ taskView: 'gantt' }, { taskView: '' }, {}]) {
      const res = await putPrefs(bobCookie, body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(await (await getPrefs(bobCookie)).json(), { taskView: 'list', secondaryTimezone: null, tasksHiddenInCalendar: [], showWeekNumbers: false, conferenceBaseUrl: null, weekStart: null, timeFormat: null, defaultDuration: 60, defaultCalendarId: null, defaultReminder: null, timeZone: null });
  });

  await t.test('deleting the user deletes the preference', async () => {
    await Db.deleteUser(bob);
    assert.strictEqual(await Db.getTaskViewPreference(bob), 'kanban');
  });

  await t.test('without a session the preference is not reachable', async () => {
    const res = await fetch(`${baseUrl}/api/preferences`);
    assert.strictEqual(res.status, 401);
  });
});
