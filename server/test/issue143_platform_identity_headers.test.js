const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('Issue #143 — Platform Identity Headers & App Meta Declaration', () => {
  const rootDir = path.resolve(__dirname, '../../');
  const repoRootDir = path.resolve(rootDir, '../');
  const appMetaPath = path.join(repoRootDir, 'app-repository/apps/webcalendar/app_meta.json');

  it('should declare platform identity headers in app_meta.json under paths', () => {
    assert.strictEqual(fs.existsSync(appMetaPath), true, 'app_meta.json must exist in app-repository');
    const meta = JSON.parse(fs.readFileSync(appMetaPath, 'utf8'));

    assert.ok(meta.paths, 'app_meta.json must contain paths section');
    assert.ok(meta.paths[''], 'app_meta.json paths must specify default private path ""');
    assert.ok(meta.paths[''].headers, 'Default private path must declare headers');
    assert.strictEqual(meta.paths[''].headers['X-Ptl-Client-Id'], '{{ auth.client_id }}');
    assert.strictEqual(meta.paths[''].headers['X-Ptl-Client-Name'], '{{ auth.client_name }}');
    assert.strictEqual(meta.paths[''].headers['X-Ptl-Client-Type'], '{{ auth.client_type }}');

    assert.ok(meta.paths['/api/public/'], 'app_meta.json paths must specify public path "/api/public/"');
    assert.ok(meta.paths['/api/public/'].headers, 'Public path must declare headers');
    assert.strictEqual(meta.paths['/api/public/'].headers['X-Ptl-Client-Type'], '{{ auth.client_type }}');
  });

  it('should recognize x-ptl-client-id as a header identity source when HTTP_HEADER_AUTH=true', () => {
    const indexPath = path.join(rootDir, 'server/index.js');
    const indexContent = fs.readFileSync(indexPath, 'utf8');
    assert.match(indexContent, /x-ptl-client-id/i, 'server/index.js must handle x-ptl-client-id header');
  });
});
