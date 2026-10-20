'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3517';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

// Issue #517: ISO week numbers in the month/week grid and the mini month are a per-user setting
// (the user's calendar setting, #355); off until the user switches them on.

const test = require('node:test');
const assert = require('assert');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const baseUrl = `http://localhost:${process.env.PORT}`;

async function getPrefs(cookie) {
  const res = await fetch(`${baseUrl}/api/preferences`, { headers: { cookie } });
  assert.strictEqual(res.status, 200);
  return res.json();
}

function putPrefs(cookie, body) {
  return fetch(`${baseUrl}/api/preferences`, {
    method: 'PUT',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Issue #517 — week numbers preference', async (t) => {
  const run = Date.now().toString(36);
  const alice = `testuser-517-a-${run}`;
  const bob = `testuser-517-b-${run}`;
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

  await t.test('a user who never chose sees no week numbers', async () => {
    assert.strictEqual((await getPrefs(aliceCookie)).showWeekNumbers, false);
  });

  await t.test('switching them on is stored for that user only, beside the other settings', async () => {
    await putPrefs(aliceCookie, { taskView: 'list' });
    const put = await putPrefs(aliceCookie, { showWeekNumbers: true });
    assert.strictEqual(put.status, 200);
    assert.deepStrictEqual(await put.json(), { taskView: 'list', secondaryTimezone: null, tasksHiddenInCalendar: [], showWeekNumbers: true, conferenceBaseUrl: null, weekStart: null, timeFormat: null, defaultDuration: 60, defaultCalendarId: null, defaultReminder: null, timeZone: null });
    assert.strictEqual((await getPrefs(aliceCookie)).showWeekNumbers, true);
    assert.strictEqual((await getPrefs(bobCookie)).showWeekNumbers, false);

    // Changing another setting leaves the week numbers alone.
    await putPrefs(aliceCookie, { secondaryTimezone: 'Asia/Tokyo' });
    assert.strictEqual((await getPrefs(aliceCookie)).showWeekNumbers, true);

    const off = await putPrefs(aliceCookie, { showWeekNumbers: false });
    assert.strictEqual(off.status, 200);
    assert.deepStrictEqual(await getPrefs(aliceCookie), { taskView: 'list', secondaryTimezone: 'Asia/Tokyo', tasksHiddenInCalendar: [], showWeekNumbers: false, conferenceBaseUrl: null, weekStart: null, timeFormat: null, defaultDuration: 60, defaultCalendarId: null, defaultReminder: null, timeZone: null });
  });

  await t.test('a value that is not a boolean is refused and nothing changes', async () => {
    await putPrefs(bobCookie, { showWeekNumbers: true });
    for (const body of [
      { showWeekNumbers: 'true' },
      { showWeekNumbers: 1 },
      { showWeekNumbers: null },
      { showWeekNumbers: false, taskView: 'gantt' },
    ]) {
      const res = await putPrefs(bobCookie, body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.strictEqual((await getPrefs(bobCookie)).showWeekNumbers, true);
  });

  await t.test('deleting the user deletes the setting', async () => {
    await Db.deleteUser(bob);
    assert.strictEqual(await Db.getWeekNumbersPreference(bob), false);
  });
});
