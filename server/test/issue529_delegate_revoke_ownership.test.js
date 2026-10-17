'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

/**
 * Issue #529 — DELETE /api/delegates/:id may only remove a grant the caller is a party to
 * (principal or delegate). Grant ids are listed to both parties, so anyone else who learns one
 * gets 404 and the grant stays.
 *
 * Runs the real server app under NODE_ENV=production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const { createTestCertificate } = require('./helpers/testTls');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue529-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

// #246/#143: in production, env mode serves only requests a paired terminal sends through the platform proxy.
const PROXY = { 'X-Freeshard-Secret': 'issue529-proxy-secret-0123456789abcdef0123', 'X-Ptl-Client-Type': 'terminal' };

test('Issue #529 — delegate grants are revoked only by their principal or delegate (NODE_ENV=production)', async (t) => {
  const origEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.AUTH_METHOD = 'env';
  process.env.DATABASE_PATH = path.join(tmpDir, 'issue529.db');
  process.env.SESSION_SECRET = 'issue529-prod-session-secret-0123456789abcdef';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.SYSTEM_SYNC_SECRET = 'issue529-system-sync-secret-0123456789abcdef';
  // The internal Radicale account makes requireAuth let the session through; the delegate routes
  // never contact it, so the stand-in answers 500 to anything.
  const radicale = https.createServer(createTestCertificate(), (req, res) => {
    res.writeHead(500);
    res.end();
  });
  await new Promise((resolve) => radicale.listen(0, '127.0.0.1', resolve));
  t.after(() => radicale.close());
  process.env.INTERNAL_CALDAV_URL = `https://127.0.0.1:${radicale.address().port}`;
  delete process.env.DISABLE_INTERNAL_CALDAV;
  delete process.env.CALDAVURL;
  delete process.env.CALDAV_USERNAME;
  delete process.env.CALDAV_PASSWORD;
  delete process.env.HTTP_HEADER_AUTH;
  process.env.HTTP_HEADER_AUTH_SECRET = PROXY['X-Freeshard-Secret'];

  const { app } = require('../index.js');
  const Db = require('../db');
  const { loginAs } = require('./helpers/testSession');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    process.env = origEnv;
  });

  const userA = 'testuser';
  const userB = 'testuser-b';
  const userC = 'testuser-c';
  await Db.upsertUser(userA, 'testuser@example.com');
  await Db.upsertUser(userB, 'testuser-b@example.com');
  await Db.upsertUser(userC, 'testuser-c@example.com');
  const cookieA = await loginAs(userA, { email: 'testuser@example.com' });
  const cookieB = await loginAs(userB, { email: 'testuser-b@example.com' });
  const cookieC = await loginAs(userC, { email: 'testuser-c@example.com' });

  async function grantAtoB() {
    const res = await fetch(`${origin}/api/delegates`, {
      method: 'POST',
      headers: { ...PROXY, cookie: cookieA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ delegateUserId: userB, calendarId: 'work-cal' })
    });
    assert.equal(res.status, 200);
    const grant = await res.json();
    assert.ok(grant.id);
    return grant.id;
  }

  function revoke(cookie, id) {
    return fetch(`${origin}/api/delegates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { ...PROXY, cookie }
    });
  }

  async function grantExists(id) {
    const rows = await Db.getDelegatesForPrincipal(userA);
    return rows.some((r) => r.id === id);
  }

  await t.test('a third member cannot revoke a grant between two other members', async () => {
    const id = await grantAtoB();
    const res = await revoke(cookieC, id);
    assert.equal(res.status, 404);
    assert.equal(await grantExists(id), true, 'the grant from A to B must still exist');
    // Clean up through the principal so the next case starts fresh.
    assert.equal((await revoke(cookieA, id)).status, 200);
  });

  await t.test("a delegate of A cannot revoke A's grant to someone else", async () => {
    await grantAtoB();
    const res = await fetch(`${origin}/api/delegates`, {
      method: 'POST',
      headers: { ...PROXY, cookie: cookieA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ delegateUserId: userC, calendarId: 'work-cal' })
    });
    assert.equal(res.status, 200);
    const idAtoC = (await res.json()).id;
    assert.equal((await revoke(cookieB, idAtoC)).status, 404);
    assert.equal(await grantExists(idAtoC), true, 'the grant from A to C must still exist');
    for (const row of await Db.getDelegatesForPrincipal(userA)) {
      assert.equal((await revoke(cookieA, row.id)).status, 200);
    }
  });

  await t.test('the delegate can revoke a grant made to them', async () => {
    const id = await grantAtoB();
    const res = await revoke(cookieB, id);
    assert.equal(res.status, 200);
    assert.equal(await grantExists(id), false);
  });

  await t.test('the principal can revoke their own grant', async () => {
    const id = await grantAtoB();
    const res = await revoke(cookieA, id);
    assert.equal(res.status, 200);
    assert.equal(await grantExists(id), false);
  });

  await t.test('an unknown id answers 404', async () => {
    const res = await revoke(cookieA, 'del-00000000-0000-0000-0000-000000000000');
    assert.equal(res.status, 404);
  });
});
