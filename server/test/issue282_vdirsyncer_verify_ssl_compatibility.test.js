'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

test('Issue #282 — vdirsyncer SSL verification compatibility without verify_fingerprint', async (t) => {
  const repoRoot = path.join(__dirname, '../..');

  await t.test('sync-worker/sync_worker.py specifies verify instead of unsupported verify_fingerprint', () => {
    const syncWorkerCode = fs.readFileSync(path.join(repoRoot, 'sync-worker/sync_worker.py'), 'utf-8');
    
    assert.strictEqual(
      syncWorkerCode.includes('verify_fingerprint'),
      false,
      'sync_worker.py must not contain verify_fingerprint setting, as it breaks on vdirsyncer < 0.19'
    );

    assert.ok(
      syncWorkerCode.includes('verify =') || syncWorkerCode.includes('verify_line ='),
      'sync_worker.py must declare verify parameter for local CalDAV storage'
    );
  });
});
