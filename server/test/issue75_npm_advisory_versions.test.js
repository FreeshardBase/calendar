const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Issue #75: body-parser, tar and undici were locked inside published advisory
// ranges. undici matters most: server/index.js installs it as the global
// dispatcher, so every outbound fetch() (including user-supplied CalDAV URLs)
// runs through the node_modules copy.
const rootDir = path.resolve(__dirname, '../..');
const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

// First version outside each advisory range.
const MINIMUMS = {
  'body-parser': '1.20.7', // GHSA-v422-hmwv-36x6 (<=1.20.6)
  tar: '7.5.21', // GHSA-r292-9mhp-454m (<=7.5.20)
  undici: '6.29.0', // GHSA-8xcm-r25x-g524, GHSA-m8rv-5g2x-5cg5, GHSA-v3r7-h72x-cjcm, ... (<=6.28.0)
};

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  assert.ok(m, `unparseable version ${v}`);
  return m.slice(1).map(Number);
}

function atLeast(version, minimum) {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function lockedVersions(name) {
  return Object.entries(lock.packages)
    .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
    .map(([key, entry]) => ({ key, version: entry.version }));
}

for (const [name, minimum] of Object.entries(MINIMUMS)) {
  test(`Issue #75: every locked copy of ${name} is >= ${minimum}`, () => {
    const copies = lockedVersions(name);
    assert.ok(copies.length > 0, `${name} must be present in package-lock.json`);
    for (const { key, version } of copies) {
      assert.ok(
        atLeast(version, minimum),
        `${key} is locked at ${version}, inside the advisory range; must be >= ${minimum}`
      );
    }
  });
}

test('Issue #75: package.json declares undici with a floor outside the advisory range', () => {
  // The app requires undici directly (index.js, tlsDispatcher.js, outboundFetch.js),
  // so its floor must be controlled here, not by whatever node-gyp happens to pull in.
  const spec = pkg.dependencies && pkg.dependencies.undici;
  assert.ok(spec, 'undici must be a declared dependency');
  const floor = /^[\^~]?(\d+\.\d+\.\d+)$/.exec(spec);
  assert.ok(floor, `undici spec ${spec} must be a plain caret/tilde/exact range`);
  assert.ok(atLeast(floor[1], MINIMUMS.undici), `undici spec ${spec} allows vulnerable versions`);
});

test('Issue #75: the installed undici is the one the lockfile pins', () => {
  const installed = require('undici/package.json').version;
  assert.strictEqual(installed, lock.packages['node_modules/undici'].version);
});
