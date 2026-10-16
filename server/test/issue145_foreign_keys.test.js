'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Db = require('../db');

test('Issue #145 — Foreign Keys Enforcement & Connection Pragma Enabling', async (t) => {
  await t.test('1. Node Db connection has PRAGMA foreign_keys enabled', async () => {
    const row = await new Promise((resolve, reject) => {
      Db.db.get('PRAGMA foreign_keys', (err, r) => {
        if (err) return reject(err);
        resolve(r);
      });
    });
    assert.ok(row, 'PRAGMA foreign_keys query returned result');
    assert.equal(Object.values(row)[0], 1, 'PRAGMA foreign_keys should be 1 (ON) on Node Db connection');
  });

  await t.test('2. Python sync_worker.py enables PRAGMA foreign_keys on connection', async () => {
    const pyPath = path.join(__dirname, '../../sync-worker/sync_worker.py');
    const content = fs.readFileSync(pyPath, 'utf8');
    assert.match(
      content,
      /PRAGMA foreign_keys\s*=\s*ON/i,
      'sync_worker.py must execute PRAGMA foreign_keys = ON on database connections'
    );
  });

  await t.test('3. Python radicale_custom_auth.py enables PRAGMA foreign_keys on connection', async () => {
    const pyPath = path.join(__dirname, '../../radicale/radicale_custom_auth.py');
    const content = fs.readFileSync(pyPath, 'utf8');
    assert.match(
      content,
      /PRAGMA foreign_keys\s*=\s*ON/i,
      'radicale_custom_auth.py must execute PRAGMA foreign_keys = ON on database connections'
    );
  });

  await t.test('4. Python radicale_custom_rights.py enables PRAGMA foreign_keys on connection', async () => {
    const pyPath = path.join(__dirname, '../../radicale/radicale_custom_rights.py');
    const content = fs.readFileSync(pyPath, 'utf8');
    assert.match(
      content,
      /PRAGMA foreign_keys\s*=\s*ON/i,
      'radicale_custom_rights.py must execute PRAGMA foreign_keys = ON on database connections'
    );
  });

  // The real constraints on a freshly booted database are checked in issue206_schema_from_boot.test.js.
});
