'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

/**
 * Issue #121 — the shipping model is a single owner (AUTH_METHOD=env); multi-user sharing waits
 * for the shard's embedded OIDC provider. Until then:
 *  - AUTH_METHOD=oidc without its OIDC_* configuration stops the server at start-up, in English,
 *    instead of failing on the first login;
 *  - a fresh database contains no users nobody signed in as (no seeded 'test'/'testuser');
 *  - a calendar can only be shared with a user that exists; an unknown sharee is 404, not a
 *    PENDING share against a principal in no table.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const express = require('express');
const session = require('express-session');
const Db = require('../db');
const { protectedRouter: calendarsRouter } = require('../routes/calendars');
const { getOidcClient, resetOidcClient } = require('../utils/oidcClient');

const repoRoot = path.join(__dirname, '../..');

function productionEnv(tmpDir, overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('OIDC_')) delete env[key];
  }
  return {
    ...env,
    NODE_ENV: 'production',
    DATABASE_PATH: path.join(tmpDir, 'webcalendar.db'),
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    ENCRYPTION_KEY_FILE: path.join(tmpDir, '.encryption_key'),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    SYSTEM_SYNC_SECRET: crypto.randomBytes(32).toString('hex'),
    INTERNAL_WEBHOOK_SECRET: crypto.randomBytes(32).toString('hex'),
    HTTP_HEADER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
    BASE_URL: 'https://calendar.example.com',
    PORT: '0',
    ...overrides,
  };
}

test('Issue #121 — single-owner shipping model, OIDC fails at boot, no phantom sharees', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue121-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  await t.test('AUTH_METHOD=oidc without OIDC_* stops the server at start-up with an English error', () => {
    const result = spawnSync(process.execPath, ['server/index.js'], {
      cwd: repoRoot,
      env: productionEnv(tmpDir, { AUTH_METHOD: 'oidc' }),
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.notEqual(result.status, 0, `server must not boot; stdout: ${result.stdout}`);
    assert.equal(result.signal, null, 'server must exit on its own, not keep running until killed');
    assert.match(result.stderr, /AUTH_METHOD=oidc requires OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET/);
    assert.doesNotMatch(result.stderr, /Konfiguration|fehlt/);
  });

  await t.test('getOidcClient names the missing OIDC_* variables in English', async () => {
    const saved = {};
    for (const key of ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetOidcClient();
    try {
      await assert.rejects(getOidcClient(), /AUTH_METHOD=oidc requires OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  await t.test('a fresh production database offers no sharee besides the users who signed in', () => {
    const script = `
      const Db = require('./server/db');
      Db.ready
        .then(() => Db.upsertUser('owner', 'owner'))
        .then(() => Promise.all([Db.searchUsers('test'), Db.searchUsers('o')]))
        .then(([test, o]) => { console.log(JSON.stringify({ test, o })); process.exit(0); })
        .catch((err) => { console.error(err); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      env: productionEnv(tmpDir, { AUTH_METHOD: 'env', CALDAV_USERNAME: 'owner' }),
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    const { test: testMatches, o } = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.deepEqual(testMatches, [], 'no seeded test/testuser rows on a shard');
    assert.deepEqual(o.map(u => u.href), ['owner']);
  });

  await t.test('sharing an internal calendar with an unknown user is 404 and stores nothing', async () => {
    const owner = 'owner_121';
    const member = 'member_121';
    await Db.upsertUser(owner, owner, 'testuser@example.com');
    await Db.upsertUser(member, member);
    const calendarId = `internal-caldav::/${owner}/personal/`;
    for (const stale of await Db.getUserShares(calendarId)) {
      await Db.removeUserShare(calendarId, stale.shareeUserId);
    }

    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-secret-121', resave: false, saveUninitialized: true }));
    // Harness-only identity, set by the test, never from the request (#50/#245).
    app.use((req, res, next) => {
      req.session.userId = owner;
      req.session.accounts = [{ id: 'internal-caldav', url: `https://localhost:5232/${owner}/`, username: owner, password: 'x' }];
      next();
    });
    app.use('/api/calendars', calendarsRouter);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const share = (sharee) => fetch(`${base}/api/calendars/${encodeURIComponent(calendarId)}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharee, readWrite: true }),
    });

    for (const sharee of ['nobody_121', '0b6f1a52-7c1d-4c8e-9f39-2d1c5e8a7b10']) {
      const res = await share(sharee);
      assert.equal(res.status, 404, `unknown sharee ${sharee} must be rejected`);
    }
    const afterUnknown = await Db.getUserShares(calendarId);
    assert.deepEqual(afterUnknown.map(s => s.shareeUserId), [], 'no share row for an unknown principal');

    const ok = await share(member);
    assert.equal(ok.status, 200);
    const rows = await Db.getUserShares(calendarId);
    assert.deepEqual(rows.map(s => [s.shareeUserId, s.status]), [[member, 'PENDING']]);

    const del = await fetch(`${base}/api/calendars/${encodeURIComponent(calendarId)}/shares`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharee: 'nobody_121' }),
    });
    assert.equal(del.status, 404, 'removing a share of an unknown user is 404');
  });
});
