'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

// Issue #537: requireInternal is checked under every NODE_ENV, and the dead act-as and
// free/busy surfaces are gone. Runs under NODE_ENV=test on purpose: that is the mode the
// old code exempted.
process.env.NODE_ENV = 'test';
process.env.PORT = '3537';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
const INTERNAL_SECRET = 'testuser-internal-secret-537';
process.env.INTERNAL_WEBHOOK_SECRET = INTERNAL_SECRET;

const test = require('node:test');
const assert = require('node:assert');
const { createRequireInternalMiddleware } = require('../utils/internalAuth');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const baseUrl = `http://127.0.0.1:${process.env.PORT}`;

function runGuard(env, headers) {
  const guard = createRequireInternalMiddleware(env);
  const outcome = { next: false, status: null };
  const res = {
    status(code) { outcome.status = code; return this; },
    json() { return this; }
  };
  guard({ headers }, res, () => { outcome.next = true; });
  return outcome;
}

for (const NODE_ENV of ['test', 'development', 'production', undefined]) {
  test(`Issue #537 — requireInternal under NODE_ENV=${NODE_ENV}`, async (t) => {
    await t.test('no secret header is refused', () => {
      const out = runGuard({ NODE_ENV, INTERNAL_WEBHOOK_SECRET: INTERNAL_SECRET }, {});
      assert.strictEqual(out.next, false);
      assert.strictEqual(out.status, 403);
    });

    await t.test('a wrong secret is refused', () => {
      const out = runGuard({ NODE_ENV, INTERNAL_WEBHOOK_SECRET: INTERNAL_SECRET }, { 'x-freeshard-secret': 'wrong' });
      assert.strictEqual(out.next, false);
      assert.strictEqual(out.status, 403);
    });

    await t.test('no configured secret closes the routes, whatever header is sent', () => {
      for (const headers of [{}, { 'x-freeshard-secret': INTERNAL_SECRET }, { 'x-internal-secret': 'anything' }]) {
        const out = runGuard({ NODE_ENV }, headers);
        assert.strictEqual(out.next, false);
        assert.strictEqual(out.status, 403);
      }
    });

    await t.test('the real secret passes', () => {
      const out = runGuard({ NODE_ENV, INTERNAL_WEBHOOK_SECRET: INTERNAL_SECRET }, { 'x-freeshard-secret': INTERNAL_SECRET });
      assert.strictEqual(out.next, true);
      assert.strictEqual(out.status, null);
    });
  });
}

test('Issue #537 — app routes', async (t) => {
  await new Promise(resolve => server.listen(process.env.PORT, resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  await t.test('/internal/* without the secret answers 403 under NODE_ENV=test', async () => {
    for (const path of ['/internal/db/quiesce', '/internal/webhooks/user-deleted']) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: 'testuser-537-nobody' })
      });
      assert.strictEqual(res.status, 403, `${path} must refuse a caller without the secret`);
    }
  });

  await t.test('/internal/db/quiesce with the secret answers 200', async () => {
    const res = await fetch(`${baseUrl}/internal/db/quiesce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-freeshard-secret': INTERNAL_SECRET }
    });
    assert.strictEqual(res.status, 200);
  });

  await t.test('act-as and free/busy do not exist for a signed-in user', async () => {
    const cookie = await loginAs('testuser-537');
    const probes = [
      ['POST', '/api/delegates/act-as', { principalUserId: 'testuser-537' }],
      ['POST', '/api/freebusy/query', { participants: ['testuser@example.com'], startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-02T00:00:00Z' }],
      ['POST', '/api/freebusy/find-slots', { participants: ['testuser@example.com'], startDate: '2026-01-01', endDate: '2026-01-01' }],
      ['GET', '/api/freebusy/vfreebusy']
    ];
    for (const [method, path, body] of probes) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      assert.strictEqual(res.status, 404, `${method} ${path} must be gone, got ${res.status}`);
    }
  });

  await t.test('the delegate list itself still answers', async () => {
    const cookie = await loginAs('testuser-537');
    const res = await fetch(`${baseUrl}/api/delegates`, { headers: { cookie } });
    assert.strictEqual(res.status, 200);
  });
});
