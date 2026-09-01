const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('Issue #151 — minimum_portal_size "xs" for Entry Tier Access', () => {
  const rootDir = path.resolve(__dirname, '../../');
  const repoRootDir = path.resolve(rootDir, '../');
  const appMetaPath = path.join(repoRootDir, 'app-repository/apps/webcalendar/app_meta.json');

  it('should specify minimum_portal_size as "xs" to allow entry tier installation', () => {
    assert.strictEqual(fs.existsSync(appMetaPath), true, 'app_meta.json must exist in app-repository');
    const meta = JSON.parse(fs.readFileSync(appMetaPath, 'utf8'));

    assert.strictEqual(meta.minimum_portal_size, 'xs', 'minimum_portal_size must be "xs" to allow entry tier deployment');
  });
});
