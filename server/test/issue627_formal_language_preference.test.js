'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3627';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

// Issue #627: Deutsch (Sie) is the third UI language, stored as 'de-formal'.

const test = require('node:test');
const assert = require('assert');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const baseUrl = `http://localhost:${process.env.PORT}`;

function putPrefs(cookie, body) {
  return fetch(`${baseUrl}/api/preferences`, {
    method: 'PUT',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Issue #627 — Deutsch (Sie) as the language preference', async (t) => {
  const user = `testuser-627-${Date.now().toString(36)}`;
  let cookie;

  t.before(async () => {
    if (!server.listening) await new Promise(resolve => server.listen(process.env.PORT, resolve));
    cookie = await loginAs(user, { username: 'testuser', email: 'testuser@example.com' });
  });

  t.after(async () => {
    await Db.deleteUser(user);
    server.close();
  });

  await t.test('is stored and read back', async () => {
    const res = await putPrefs(cookie, { language: 'de-formal' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).language, 'de-formal');
    const get = await fetch(`${baseUrl}/api/preferences`, { headers: { cookie } });
    assert.strictEqual((await get.json()).language, 'de-formal');
  });

  await t.test('other spellings are still refused', async () => {
    for (const language of ['de-sie', 'de-DE', 'formal']) {
      assert.strictEqual((await putPrefs(cookie, { language })).status, 400, language);
    }
  });
});
