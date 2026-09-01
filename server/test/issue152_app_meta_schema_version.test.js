const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('Issue #152 — app_meta.json Schema Version "1.2" and Lifecycle Alignment', () => {
  const rootDir = path.resolve(__dirname, '../../');
  const repoRootDir = path.resolve(rootDir, '../');
  const appMetaPath = path.join(repoRootDir, 'app-repository/apps/webcalendar/app_meta.json');

  it('should specify schema version "1.2" matching current shard_core schema', () => {
    assert.strictEqual(fs.existsSync(appMetaPath), true, 'app_meta.json must exist in app-repository');
    const meta = JSON.parse(fs.readFileSync(appMetaPath, 'utf8'));

    assert.strictEqual(meta.v, '1.2', 'app_meta.json schema version "v" must be "1.2" to match current shard_core version');
  });

  it('should configure lifecycle idle_time_for_shutdown and preserve pretty_name', () => {
    assert.strictEqual(fs.existsSync(appMetaPath), true, 'app_meta.json must exist in app-repository');
    const meta = JSON.parse(fs.readFileSync(appMetaPath, 'utf8'));

    assert.ok(meta.lifecycle, 'app_meta.json must contain lifecycle configuration');
    assert.strictEqual(meta.lifecycle.always_on, false, 'always_on must be false for idle_time_for_shutdown to take effect');
    assert.strictEqual(typeof meta.lifecycle.idle_time_for_shutdown, 'number', 'idle_time_for_shutdown must be a number');
    assert.ok(meta.lifecycle.idle_time_for_shutdown >= 5, 'idle_time_for_shutdown must be at least 5 seconds');
    assert.strictEqual(meta.pretty_name, 'FreeShard WebCalendar', 'pretty_name must be preserved as FreeShard WebCalendar');
  });
});
