'use strict';
// Issue #534 — the per-user colour override of PATCH /api/calendars/:id is
// rendered into the calendar list and the edit dialog, so the route must only
// store a #rrggbb colour and reject anything else with 400. Production semantics;
// the calendar is shared read-only with the caller, so no CalDAV write happens.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue534-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue534.db');
process.env.ENCRYPTION_KEY = 'issue534-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
delete process.env.CALDAVURL;

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const Db = require('../db');
const { protectedRouter: calendarsRouter } = require('../routes/calendars');

const OWNER = 'testuser-534-owner';
const USER = 'testuser-534';
const CAL_ID = `internal-caldav::/${OWNER}/personal/`;

function startApp() {
  const app = express();
  app.use(express.json());
  // The real app mounts the router behind requireAuth; a logged-in session looks like this.
  app.use((req, _res, next) => {
    req.session = { userId: USER, username: 'testuser', accounts: [] };
    next();
  });
  app.use('/api/calendars', calendarsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('Issue #534 — calendar colour override accepts only #rrggbb', async (t) => {
  await Db.ready;
  await Db.upsertUser(OWNER, 'testuser-owner', 'testuser@example.com');
  await Db.upsertUser(USER, 'testuser', 'testuser@example.com');
  await Db.addUserShare(CAL_ID, USER, 0, 'ACCEPTED', 'READ');

  const server = await startApp();
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/calendars/${encodeURIComponent(CAL_ID)}`;
  const patch = (body) => fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const bad = [
    '#fff"><b>x</b>',
    '#fff',
    '#12345678',
    'red',
    'rgb(255, 0, 0)',
    '#12345g',
    ' #123456',
    '#123456\n',
    '',
    123456,
    ['#123456'],
    {},
    true,
  ];
  for (const color of bad) {
    await t.test(`rejects ${JSON.stringify(color)}`, async () => {
      const res = await patch({ color });
      assert.equal(res.status, 400);
      assert.equal(await Db.getUserCalendarColorOverride(USER, CAL_ID), null,
        'nothing is stored for a rejected colour');
    });
  }

  await t.test('stores a valid #rrggbb colour (any case)', async () => {
    const res = await patch({ color: '#A1b2C3' });
    assert.equal(res.status, 200);
    assert.equal(await Db.getUserCalendarColorOverride(USER, CAL_ID), '#A1b2C3');
  });

  await t.test('an invalid colour does not overwrite the stored override', async () => {
    const res = await patch({ color: '#fff"><b>x</b>' });
    assert.equal(res.status, 400);
    assert.equal(await Db.getUserCalendarColorOverride(USER, CAL_ID), '#A1b2C3');
  });

  await t.test('null still clears the override', async () => {
    const res = await patch({ color: null });
    assert.equal(res.status, 200);
    assert.equal(await Db.getUserCalendarColorOverride(USER, CAL_ID), null);
  });
});
