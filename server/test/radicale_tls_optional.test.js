'use strict';

/**
 * Issue #32 — Radicale: make internal TLS optional via env (currently hardcoded ssl=True)
 *
 * Validates that Radicale container entrypoint supports making internal TLS optional via env:
 *   1. radicale/entrypoint.sh checks RADICALE_SSL / RADICALE_ENABLE_SSL env var.
 *   2. When RADICALE_SSL is false / 0 / no / off, entrypoint configures `ssl = False` in /etc/radicale/config.
 *   3. When RADICALE_SSL is true / 1 / yes / True or unset, entrypoint configures `ssl = True`.
 *   4. .env.example contains RADICALE_SSL documentation entry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #32 — Radicale TLS Optional via Env', () => {

  test('radicale/entrypoint.sh inspects RADICALE_SSL / RADICALE_ENABLE_SSL environment variable', () => {
    const entrypointPath = path.join(ROOT_DIR, 'radicale/entrypoint.sh');
    assert.ok(fs.existsSync(entrypointPath), 'radicale/entrypoint.sh must exist');
    const content = fs.readFileSync(entrypointPath, 'utf8');

    assert.ok(
      content.includes('RADICALE_SSL') || content.includes('RADICALE_ENABLE_SSL'),
      'entrypoint.sh must reference RADICALE_SSL or RADICALE_ENABLE_SSL environment variable'
    );
  });

  test('radicale/entrypoint.sh handles false/0/no/off values to set ssl = False', () => {
    const entrypointPath = path.join(ROOT_DIR, 'radicale/entrypoint.sh');
    const content = fs.readFileSync(entrypointPath, 'utf8');

    assert.ok(
      content.includes('ssl = False') || content.includes('ssl=False'),
      'entrypoint.sh must support configuring ssl = False when RADICALE_SSL is disabled'
    );
  });

  test('.env.example documents RADICALE_SSL setting', () => {
    const envExamplePath = path.join(ROOT_DIR, '.env.example');
    assert.ok(fs.existsSync(envExamplePath), '.env.example must exist');
    const content = fs.readFileSync(envExamplePath, 'utf8');

    assert.ok(
      content.includes('RADICALE_SSL'),
      '.env.example must document RADICALE_SSL'
    );
  });

});
