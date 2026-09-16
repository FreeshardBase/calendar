'use strict';

/**
 * Issue #276 — LOW-MEDIUM: Radicale runs at debug level in the shipping image,
 * which buys nothing and costs 6 KB of unrotated container log per calendar view.
 *
 * Validates that:
 *   1. radicale/Dockerfile CMD does not include '--debug' flag.
 *   2. radicale/config defines `level = info` under [logging] (not `debug`).
 *   3. radicale/config does not set `backtrace_on_debug = True`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #276 — Radicale Log Level & Debug Mode Alignment', () => {

  test('radicale/Dockerfile does not pass --debug in CMD', () => {
    const dockerfilePath = path.join(ROOT_DIR, 'radicale/Dockerfile');
    assert.ok(fs.existsSync(dockerfilePath), 'radicale/Dockerfile must exist');
    const content = fs.readFileSync(dockerfilePath, 'utf8');

    // Inspect CMD line for radicale
    const cmdLine = content.split('\n').find(line => line.trim().startsWith('CMD ["radicale') || line.trim().startsWith('CMD ["/app/entrypoint.sh"'));
    assert.ok(cmdLine, 'radicale/Dockerfile must contain a CMD ["radicale"...] instruction');
    assert.strictEqual(
      cmdLine.includes('--debug'),
      false,
      'radicale/Dockerfile CMD must not contain --debug flag'
    );
  });

  test('radicale/config sets log level = info and disables debug backtraces', () => {
    const configPath = path.join(ROOT_DIR, 'radicale/config');
    assert.ok(fs.existsSync(configPath), 'radicale/config must exist');
    const content = fs.readFileSync(configPath, 'utf8');

    assert.ok(
      content.includes('level = info') || content.includes('level = warn') || content.includes('level = warning'),
      'radicale/config must specify a non-debug log level (e.g. info or warn)'
    );

    assert.strictEqual(
      content.includes('level = debug'),
      false,
      'radicale/config must not specify level = debug'
    );

    assert.strictEqual(
      content.includes('backtrace_on_debug = True'),
      false,
      'radicale/config must not set backtrace_on_debug = True'
    );
  });

});
