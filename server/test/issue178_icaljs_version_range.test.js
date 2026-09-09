const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Issue #178: ical.js dependency version range reaches maintained major 2 line', async (t) => {
  const rootDir = path.resolve(__dirname, '../..');
  const pkgJsonPath = path.join(rootDir, 'package.json');

  await t.test('package.json specifies ical.js with ^2.x major version range', () => {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    assert.ok(pkgJson.dependencies && pkgJson.dependencies['ical.js'], 'package.json must specify ical.js in dependencies');
    const icaljsSpec = pkgJson.dependencies['ical.js'];
    
    assert.doesNotMatch(
      icaljsSpec,
      /^\^?1\./,
      'ical.js dependency range must not be pinned to unmaintained major 1 line (^1.x)'
    );
    assert.match(
      icaljsSpec,
      /^\^?2\./,
      'ical.js dependency range must reach maintained major 2 line (^2.x)'
    );
  });

  await t.test('ICAL module requires successfully', () => {
    const ICAL = require('ical.js');
    assert.ok(ICAL, 'ical.js module must be loadable');
  });
});
