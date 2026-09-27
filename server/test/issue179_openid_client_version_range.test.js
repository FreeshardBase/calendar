const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Issue #179: openid-client stays on the v5 line until oidcClient.js is migrated off Issuer/Client', async (t) => {
  const rootDir = path.resolve(__dirname, '../..');
  const pkgJsonPath = path.join(rootDir, 'package.json');

  await t.test('package.json pins openid-client to ^5.x', () => {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const openidSpec = pkgJson.dependencies && pkgJson.dependencies['openid-client'];
    assert.ok(openidSpec, 'package.json must specify openid-client in dependencies');

    assert.match(
      openidSpec,
      /^\^?5\./,
      'openid-client v6 dropped the Issuer/Client classes that server/utils/oidcClient.js relies on ' +
      '(Issuer.discover(), new issuer.Client(...)). A prior autonomous bump to ^6.0.0 desynced ' +
      'package-lock.json and, once installed, would have thrown at the first OIDC login. Bumping past ' +
      '^5.x requires rewriting oidcClient.js to the v6 discovery()/authorizationCodeGrant() API first — ' +
      'not just a version bump here.'
    );
  });

  await t.test('openid-client exposes the Issuer class oidcClient.js depends on', () => {
    const openidClient = require('openid-client');
    assert.strictEqual(
      typeof openidClient.Issuer,
      'function',
      'Issuer must be present — oidcClient.js calls Issuer.discover() and new issuer.Client(...)'
    );
  });
});
