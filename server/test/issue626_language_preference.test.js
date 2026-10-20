'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3626';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

// Issue #626: the UI language is a per-user setting on the server. null = not chosen: the
// browser decides, then Deutsch (Du) (CONCEPTS.md).

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

test('Issue #626 — UI language preference', async (t) => {
  const run = Date.now().toString(36);
  const alice = `testuser-626-a-${run}`;
  const bob = `testuser-626-b-${run}`;
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

  await t.test('not chosen until the user chooses', async () => {
    assert.strictEqual((await getPrefs(aliceCookie)).language, null);
  });

  await t.test('the choice is stored for that user only and null resets it', async () => {
    const res = await putPrefs(aliceCookie, { language: 'en' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).language, 'en');
    assert.strictEqual((await getPrefs(aliceCookie)).language, 'en');
    assert.strictEqual((await getPrefs(bobCookie)).language, null);

    await putPrefs(aliceCookie, { weekStart: 'sun' });
    assert.strictEqual((await getPrefs(aliceCookie)).language, 'en');

    const de = await putPrefs(aliceCookie, { language: 'de' });
    assert.strictEqual((await de.json()).language, 'de');
    const reset = await putPrefs(aliceCookie, { language: null });
    assert.strictEqual((await reset.json()).language, null);
  });

  await t.test('unsupported languages are refused and nothing changes', async () => {
    await putPrefs(bobCookie, { language: 'en' });
    for (const body of [{ language: 'fr' }, { language: 'EN' }, { language: 'en-US' }, { language: 1 }, { language: '' }]) {
      const res = await putPrefs(bobCookie, body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.strictEqual((await getPrefs(bobCookie)).language, 'en');
  });
});
