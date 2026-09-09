const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Issue #179: openid-client dependency version range reaches maintained major 6 line', async (t) => {
  const rootDir = path.resolve(__dirname, '../..');
  const pkgJsonPath = path.join(rootDir, 'package.json');

  await t.test('package.json specifies openid-client with ^6.x major version range', () => {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    assert.ok(pkgJson.dependencies && pkgJson.dependencies['openid-client'], 'package.json must specify openid-client in dependencies');
    const openidSpec = pkgJson.dependencies['openid-client'];
    
    assert.doesNotMatch(
      openidSpec,
      /^\^?5\./,
      'openid-client dependency range must not be pinned to unmaintained major 5 line (^5.x)'
    );
    assert.match(
      openidSpec,
      /^\^?6\./,
      'openid-client dependency range must reach maintained major 6 line (^6.x)'
    );
  });

  await t.test('openid-client module requires successfully', () => {
    const openidClient = require('openid-client');
    assert.ok(openidClient, 'openid-client module must be loadable');
  });
});
