const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Issue #177: Production image and CI run Node 22 (LTS)', async (t) => {
  const rootDir = path.resolve(__dirname, '../..');

  await t.test('Dockerfile uses node:22-alpine base image', () => {
    const dockerfileContent = fs.readFileSync(path.join(rootDir, 'Dockerfile'), 'utf8');
    assert.match(
      dockerfileContent,
      /^FROM node:22-alpine/m,
      'Dockerfile must use node:22-alpine base image'
    );
    assert.doesNotMatch(
      dockerfileContent,
      /^FROM node:20-alpine/m,
      'Dockerfile must not use EOL node:20-alpine base image'
    );
  });

  await t.test('package.json engines field specifies node >=22.0.0', () => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    assert.ok(pkgJson.engines && pkgJson.engines.node, 'package.json must contain engines.node');
    assert.strictEqual(
      pkgJson.engines.node,
      '>=22.0.0',
      'package.json engines.node must be >=22.0.0'
    );
  });

  await t.test('CI workflow uses Node.js 22', () => {
    const ciContent = fs.readFileSync(
      path.join(rootDir, '.github/workflows/ci.yml'),
      'utf8'
    );
    assert.match(
      ciContent,
      /node-version:\s*['"]22['"]/,
      '.github/workflows/ci.yml must specify node-version 22'
    );
  });
});
