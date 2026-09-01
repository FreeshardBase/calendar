const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

describe('Issue #119 — Version Scheme, update_check.py & Store Icon Verification', () => {
  const rootDir = path.resolve(__dirname, '../../');
  const repoRootDir = path.resolve(rootDir, '../');
  const appRepoDir = path.join(repoRootDir, 'app-repository/apps/webcalendar');
  const appMetaPath = path.join(appRepoDir, 'app_meta.json');
  const updateCheckPath = path.join(appRepoDir, 'update_check.py');
  const iconPath = path.join(appRepoDir, 'icon.svg');
  const filebrowserIconPath = path.join(repoRootDir, 'app-repository/apps/filebrowser/icon.svg');

  it('should define a valid version scheme in package.json and app_meta.json', () => {
    const pkgJsonPath = path.join(rootDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    assert.ok(pkg.version, 'package.json must contain version');
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json version must follow semver X.Y.Z');

    assert.strictEqual(fs.existsSync(appMetaPath), true, 'app_meta.json must exist in app-repository/apps/webcalendar');
    const meta = JSON.parse(fs.readFileSync(appMetaPath, 'utf8'));
    assert.ok(meta.app_version, 'app_meta.json must contain app_version');
    assert.strictEqual(meta.app_version, pkg.version, 'app_meta.json app_version must match package.json version');
    assert.strictEqual(meta.name, 'webcalendar', 'app_meta.json name must be webcalendar');
  });

  it('should execute update_check.py without errors during update check run', () => {
    assert.strictEqual(fs.existsSync(updateCheckPath), true, 'update_check.py must exist in app-repository/apps/webcalendar');
    const updatePyPath = path.join(repoRootDir, 'app-repository/update/update.py');
    const output = execSync(`python3 ${updatePyPath} check --json`, { cwd: repoRootDir, encoding: 'utf8' });
    const report = JSON.parse(output);
    assert.ok(report.apps, 'Update check output must contain apps dict');
    assert.ok(report.apps.webcalendar, 'Update check output must contain webcalendar');
    assert.notStrictEqual(report.apps.webcalendar.status, 'error', 'webcalendar update check status must not be error');
    assert.ok(['up_to_date', 'outdated', 'opt_out'].includes(report.apps.webcalendar.status), `Unexpected status: ${report.apps.webcalendar.status}`);
  });

  it('should have a store icon that is not the FileBrowser logo', () => {
    assert.strictEqual(fs.existsSync(iconPath), true, 'icon.svg must exist in app-repository/apps/webcalendar');
    const webcalIconContent = fs.readFileSync(iconPath, 'utf8');
    assert.match(webcalIconContent, /<svg/i, 'icon.svg must be a valid SVG document');

    if (fs.existsSync(filebrowserIconPath)) {
      const fbIconContent = fs.readFileSync(filebrowserIconPath, 'utf8');
      assert.notStrictEqual(webcalIconContent.trim(), fbIconContent.trim(), 'webcalendar icon must not be identical to FileBrowser logo');
    }
  });
});
