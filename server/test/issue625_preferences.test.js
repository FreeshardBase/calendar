'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3625';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

// Issue #625: week start, 12/24 h, default event duration, default calendar, default reminder and
// time zone are per-user settings on the server. null means "not chosen": the browser decides
// (week start, 12/24 h, time zone), no calendar or reminder is preset.

const test = require('node:test');
const assert = require('assert');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const baseUrl = `http://localhost:${process.env.PORT}`;

const UNCHOSEN = { weekStart: null, timeFormat: null, defaultDuration: 60, defaultCalendarId: null, defaultReminder: null, timeZone: null };

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

const pick = (prefs) => Object.fromEntries(Object.keys(UNCHOSEN).map(k => [k, prefs[k]]));

test('Issue #625 — calendar preferences', async (t) => {
  const run = Date.now().toString(36);
  const alice = `testuser-625-a-${run}`;
  const bob = `testuser-625-b-${run}`;
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

  await t.test('a user who never chose gets the defaults', async () => {
    assert.deepStrictEqual(pick(await getPrefs(aliceCookie)), UNCHOSEN);
  });

  await t.test('each setting is stored for that user only and leaves the others alone', async () => {
    const chosen = {
      weekStart: 'sun', timeFormat: '12h', defaultDuration: 30,
      defaultCalendarId: '/caldav/testuser/work/', defaultReminder: 15, timeZone: 'asia/tokyo',
    };
    for (const [key, value] of Object.entries(chosen)) {
      const res = await putPrefs(aliceCookie, { [key]: value });
      assert.strictEqual(res.status, 200, key);
    }
    await putPrefs(aliceCookie, { showWeekNumbers: true });
    const prefs = await getPrefs(aliceCookie);
    assert.deepStrictEqual(pick(prefs), { ...chosen, timeZone: 'Asia/Tokyo' });
    assert.strictEqual(prefs.showWeekNumbers, true);
    assert.deepStrictEqual(pick(await getPrefs(bobCookie)), UNCHOSEN);

    const res = await putPrefs(aliceCookie, { weekStart: 'sat', timeFormat: '24h', defaultReminder: 0 });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(pick(await res.json()), { ...chosen, timeZone: 'Asia/Tokyo', weekStart: 'sat', timeFormat: '24h', defaultReminder: 0 });

    // null goes back to "not chosen".
    const reset = await putPrefs(aliceCookie, { weekStart: null, timeFormat: null, defaultCalendarId: null, defaultReminder: null, timeZone: null });
    assert.strictEqual(reset.status, 200);
    assert.deepStrictEqual(pick(await reset.json()), { ...UNCHOSEN, defaultDuration: 30 });
  });

  await t.test('invalid values are refused and nothing changes', async () => {
    await putPrefs(bobCookie, { weekStart: 'mon', defaultDuration: 45 });
    for (const body of [
      { weekStart: 'tue' },
      { weekStart: 1 },
      { timeFormat: '12' },
      { defaultDuration: 0 },
      { defaultDuration: 2.5 },
      { defaultDuration: 24 * 60 + 1 },
      { defaultDuration: null },
      { defaultDuration: '30' },
      { defaultCalendarId: '' },
      { defaultCalendarId: 42 },
      { defaultReminder: -5 },
      { defaultReminder: 'PT15M' },
      { timeZone: '+09:00' },
      { timeZone: 'Mars/Olympus' },
      { weekStart: 'sun', defaultDuration: -1 },
    ]) {
      const res = await putPrefs(bobCookie, body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(pick(await getPrefs(bobCookie)), { ...UNCHOSEN, weekStart: 'mon', defaultDuration: 45 });
  });

  await t.test('deleting the user deletes the settings', async () => {
    await Db.deleteUser(bob);
    bobCookie = await loginAs(bob, { username: 'testuser2', email: 'testuser2@example.com' });
    assert.deepStrictEqual(pick(await getPrefs(bobCookie)), UNCHOSEN);
  });
});
