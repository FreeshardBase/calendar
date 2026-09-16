'use strict';

/**
 * Issue #271 — agents.md Local Recipe Shared Database Path Alignment
 *
 * Validates that agents.md's local development recipe configures Radicale
 * and the Express Node server to share the exact same SQLite database file path,
 * preventing split-database state and security bypass issues.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');
const AGENTS_MD_PATH = path.join(ROOT_DIR, 'agents.md');

test.describe('Issue #271 — agents.md Local Recipe Shared Database Path Alignment', () => {

  test('agents.md exists in repository root', () => {
    assert.ok(fs.existsSync(AGENTS_MD_PATH), 'agents.md must exist in repository root');
  });

  test('agents.md does not use split /tmp/cal-app.db database path in local recipe', () => {
    const content = fs.readFileSync(AGENTS_MD_PATH, 'utf8');
    assert.ok(
      !content.includes('/tmp/cal-app.db'),
      'agents.md must not use /tmp/cal-app.db which splits database state from Radicale'
    );
  });

  test('agents.md local recipe aligns DATABASE_PATH for Express Node server with Radicale host database mount', () => {
    const content = fs.readFileSync(AGENTS_MD_PATH, 'utf8');
    assert.ok(
      content.includes('DATABASE_PATH=/tmp/cal-data/webcalendar.db'),
      'agents.md local recipe must specify DATABASE_PATH=/tmp/cal-data/webcalendar.db for the Node server'
    );
  });

});
