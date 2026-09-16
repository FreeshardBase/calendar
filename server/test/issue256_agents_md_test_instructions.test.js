'use strict';

/**
 * Issue #256 — agents.md Test Instructions Accuracy & Newcomer Information
 *
 * Validates that agents.md:
 * 1. Does NOT claim that unit/integration tests fetch http://localhost:3000 requiring a pre-started server.
 * 2. Documents that npm test is self-contained (starts isolated test servers on dynamic/ephemeral ports).
 * 3. Documents database isolation (webcalendar.test.db default during test runs to protect developer data).
 * 4. Documents full verification tools (npm run lint and npm run test:all / Playwright E2E).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');
const AGENTS_MD_PATH = path.join(ROOT_DIR, 'agents.md');

test.describe('Issue #256 — agents.md Test Instructions & Newcomer Documentation', () => {

  test('agents.md exists in repository root', () => {
    assert.ok(fs.existsSync(AGENTS_MD_PATH), 'agents.md must exist in repository root');
  });

  test('agents.md does not direct user to manually start server first on :3000 for npm test', () => {
    const content = fs.readFileSync(AGENTS_MD_PATH, 'utf8');
    assert.ok(
      !content.includes('start the server first'),
      'agents.md must not instruct developers to start the server first for npm test'
    );
    assert.ok(
      !content.includes('http://localhost:3000'),
      'agents.md must not state that integration tests fetch http://localhost:3000'
    );
  });

  test('agents.md documents self-contained test execution and dynamic port allocation', () => {
    const content = fs.readFileSync(AGENTS_MD_PATH, 'utf8');
    assert.ok(
      content.includes('self-contained') || content.includes('isolated') || content.includes('ephemeral'),
      'agents.md must document that unit/integration tests are self-contained with isolated/ephemeral server ports'
    );
  });

  test('agents.md documents test database isolation (webcalendar.test.db)', () => {
    const content = fs.readFileSync(AGENTS_MD_PATH, 'utf8');
    assert.ok(
      content.includes('webcalendar.test.db') || content.includes('DATABASE_PATH'),
      'agents.md must document that npm test isolates data using webcalendar.test.db to protect developer data'
    );
  });

  test('agents.md documents npm run lint and npm run test:all for full verification', () => {
    const content = fs.readFileSync(AGENTS_MD_PATH, 'utf8');
    assert.ok(
      content.includes('npm run lint') || content.includes('npm run test:all'),
      'agents.md must document npm run lint and/or npm run test:all commands'
    );
  });

  test('agents.md documents python test suite execution', () => {
    const content = fs.readFileSync(AGENTS_MD_PATH, 'utf8');
    assert.ok(
      content.includes('python3 -m unittest') || content.includes('server/test/python'),
      'agents.md must document python test suite execution'
    );
  });

});
