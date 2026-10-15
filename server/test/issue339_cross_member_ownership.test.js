'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches

// Issue #339: app-password delete, resource PATCH/DELETE and booking-page creation
// must be scoped to the calling member. Member B gets 404 on member A's ids.
// Runs under NODE_ENV=production against an isolated database.

const os = require('os');
const fs = require('fs');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-issue339-'));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'webcalendar.db');
process.env.ENCRYPTION_KEY_FILE = path.join(tmpDir, '.encryption_key');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const Db = require('../db');
const accountsRouter = require('../routes/accounts');
const resourcesRouter = require('../routes/resources');
const availabilityRouter = require('../routes/availability');

const USER_A = 'testuser-a';
const USER_B = 'testuser-b';

test('Issue #339 — cross-member ownership checks (NODE_ENV=production)', async (t) => {
  let server;
  let baseUrl;

  t.before(async () => {
    await Db.upsertUser(USER_A, USER_A, 'testuser-a@example.com');
    await Db.upsertUser(USER_B, USER_B, 'testuser-b@example.com');

    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'issue339-test-secret', resave: false, saveUninitialized: false }));
    // Harness-only identity injection: stands in for the OIDC login of each member.
    app.use((req, res, next) => {
      const who = req.get('x-harness-user');
      if (who) {
        req.session.userId = who;
        req.session.accounts = [{ id: 'internal-caldav', username: who }];
      }
      next();
    });
    app.use('/api/accounts', accountsRouter);
    app.use('/api/resources', resourcesRouter);
    app.use('/api', availabilityRouter);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const call = (user, method, url, body) => fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'x-harness-user': user, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  await t.test('app passwords: B cannot revoke A\'s device password', async () => {
    const created = await call(USER_A, 'POST', '/api/accounts/app-passwords', { label: 'Test Phone' });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    const del = await call(USER_B, 'DELETE', `/api/accounts/app-passwords/${id}`);
    assert.equal(del.status, 404);

    const listA = await (await call(USER_A, 'GET', '/api/accounts/app-passwords')).json();
    assert.ok(listA.some(p => p.id === id), 'A\'s app password must survive B\'s delete attempt');

    const ownDel = await call(USER_A, 'DELETE', `/api/accounts/app-passwords/${id}`);
    assert.equal(ownDel.status, 200);
    const listAfter = await (await call(USER_A, 'GET', '/api/accounts/app-passwords')).json();
    assert.ok(!listAfter.some(p => p.id === id));

    const again = await call(USER_A, 'DELETE', `/api/accounts/app-passwords/${id}`);
    assert.equal(again.status, 404);
  });

  await t.test('resources: B cannot PATCH or DELETE A\'s resource', async () => {
    const created = await call(USER_A, 'POST', '/api/resources', { name: 'Test Room', capacity: 4 });
    assert.equal(created.status, 201);
    const { resource } = await created.json();
    assert.equal(resource.ownerId, USER_A);

    const patch = await call(USER_B, 'PATCH', `/api/resources/${resource.id}`, { name: 'Hijacked' });
    assert.equal(patch.status, 404);
    const del = await call(USER_B, 'DELETE', `/api/resources/${resource.id}`);
    assert.equal(del.status, 404);

    const stored = await Db.getResourceById(resource.id);
    assert.ok(stored, 'resource must survive B\'s delete attempt');
    assert.equal(stored.name, 'Test Room');

    // Members can still see shared resources for booking.
    const readB = await call(USER_B, 'GET', `/api/resources/${resource.id}`);
    assert.equal(readB.status, 200);

    const ownPatch = await call(USER_A, 'PATCH', `/api/resources/${resource.id}`, { name: 'Renamed Room' });
    assert.equal(ownPatch.status, 200);
    assert.equal((await ownPatch.json()).resource.name, 'Renamed Room');

    const ownDel = await call(USER_A, 'DELETE', `/api/resources/${resource.id}`);
    assert.equal(ownDel.status, 200);
    assert.equal(await Db.getResourceById(resource.id), null);

    const missing = await call(USER_A, 'DELETE', `/api/resources/${resource.id}`);
    assert.equal(missing.status, 404);
  });

  await t.test('booking pages: B cannot create a page on A\'s calendar', async () => {
    const foreign = await call(USER_B, 'POST', '/api/availability-slots', {
      slug: 'testuser-b-steal', title: 'Steal', calendarId: `internal-caldav::/${USER_A}/personal/`
    });
    assert.equal(foreign.status, 404);
    assert.equal(await Db.getAvailabilityPageBySlug('testuser-b-steal'), null);

    const unknownAccount = await call(USER_B, 'POST', '/api/availability-slots', {
      slug: 'testuser-b-ext', title: 'Ext', calendarId: 'acct-of-someone-else::/cal/'
    });
    assert.equal(unknownAccount.status, 404);
    assert.equal(await Db.getAvailabilityPageBySlug('testuser-b-ext'), null);

    const own = await call(USER_B, 'POST', '/api/availability-slots', {
      slug: 'testuser-b-own', title: 'Own', calendarId: `internal-caldav::/${USER_B}/personal/`
    });
    assert.equal(own.status, 201);
  });
});
