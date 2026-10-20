'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3509';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

// Issue #509: the second time zone of the week/day grid is a per-user calendar setting (#355),
// stored on the server, set to any IANA zone or switched off (null).

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

test('Issue #509 — second time zone preference', async (t) => {
  const run = Date.now().toString(36);
  const alice = `testuser-509-a-${run}`;
  const bob = `testuser-509-b-${run}`;
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

  await t.test('a user who never chose has no second time zone', async () => {
    assert.deepStrictEqual(await getPrefs(aliceCookie), { taskView: 'kanban', secondaryTimezone: null, tasksHiddenInCalendar: [], showWeekNumbers: false });
  });

  await t.test('any IANA zone is stored for that user only, beside the task view', async () => {
    for (const zone of ['Asia/Kathmandu', 'America/St_Johns', 'Pacific/Chatham', 'UTC']) {
      const put = await putPrefs(aliceCookie, { secondaryTimezone: zone });
      assert.strictEqual(put.status, 200, zone);
      const stored = (await put.json()).secondaryTimezone;
      // ICU may name an alias canonically (Asia/Kathmandu ↔ Asia/Katmandu); both name the same zone.
      const instant = new Date('2027-07-01T12:00:00Z');
      const local = z => instant.toLocaleString('en-US', { timeZone: z });
      assert.strictEqual(local(stored), local(zone), zone);
      assert.strictEqual((await getPrefs(aliceCookie)).secondaryTimezone, stored);
    }
    assert.deepStrictEqual(await getPrefs(bobCookie), { taskView: 'kanban', secondaryTimezone: null, tasksHiddenInCalendar: [], showWeekNumbers: false });

    await putPrefs(aliceCookie, { secondaryTimezone: 'America/New_York' });
    await putPrefs(aliceCookie, { taskView: 'list' });
    assert.deepStrictEqual(await getPrefs(aliceCookie), { taskView: 'list', secondaryTimezone: 'America/New_York', tasksHiddenInCalendar: [], showWeekNumbers: false });
  });

  await t.test('a zone given in another letter case is stored under its proper name', async () => {
    const put = await putPrefs(bobCookie, { secondaryTimezone: 'europe/berlin' });
    assert.strictEqual(put.status, 200);
    assert.strictEqual((await getPrefs(bobCookie)).secondaryTimezone, 'Europe/Berlin');
  });

  await t.test('null switches the second time zone off', async () => {
    const put = await putPrefs(aliceCookie, { secondaryTimezone: null });
    assert.strictEqual(put.status, 200);
    assert.deepStrictEqual(await getPrefs(aliceCookie), { taskView: 'list', secondaryTimezone: null, tasksHiddenInCalendar: [], showWeekNumbers: false });
  });

  await t.test('a value that is not an IANA zone is refused and nothing changes', async () => {
    await putPrefs(bobCookie, { secondaryTimezone: 'Asia/Tokyo' });
    for (const body of [
      { secondaryTimezone: 'Mars/Olympus_Mons' },
      { secondaryTimezone: '+01:00' },
      { secondaryTimezone: '' },
      { secondaryTimezone: 42 },
      { secondaryTimezone: 'Asia/Tokyo', taskView: 'gantt' },
      { secondaryTimezone: 'x'.repeat(200) },
    ]) {
      const res = await putPrefs(bobCookie, body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(await getPrefs(bobCookie), { taskView: 'kanban', secondaryTimezone: 'Asia/Tokyo', tasksHiddenInCalendar: [], showWeekNumbers: false });
  });

  await t.test('deleting the user deletes the setting', async () => {
    await Db.deleteUser(bob);
    assert.strictEqual(await Db.getSecondaryTimezonePreference(bob), null);
  });
});
