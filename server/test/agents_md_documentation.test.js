'use strict';

/**
 * Issue #74 — agents.md documentation for newest subsystems
 *
 * Validates that agents.md documents the newest subsystems:
 * - Tasks (VTODO) subsystem (routes, frontend module public/js/tasks.js)
 * - MS Graph / Outlook background sync engine (utils/msgraph.js, sync-worker/msgraph_worker.py, /api/msgraph/accounts)
 * - Central iCalendar utility layer (server/utils/ical.js)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #74 — Documentation of New Subsystems in agents.md', () => {

  const agentsMdPath = path.join(ROOT_DIR, 'agents.md');

  test('agents.md exists in repository root', () => {
    assert.ok(fs.existsSync(agentsMdPath), 'agents.md must exist in repository root');
  });

  test('agents.md documents the VTODO / Tasks subsystem', () => {
    const content = fs.readFileSync(agentsMdPath, 'utf8');
    assert.ok(
      content.includes('/api/tasks') || content.includes('tasks.js') || content.includes('VTODO'),
      'agents.md must document the VTODO task management subsystem (/api/tasks, public/js/tasks.js)'
    );
  });

  test('agents.md documents the MS Graph / Outlook synchronization subsystem', () => {
    const content = fs.readFileSync(agentsMdPath, 'utf8');
    assert.ok(
      content.includes('MS Graph') || content.includes('msgraph') || content.includes('/api/msgraph/accounts'),
      'agents.md must document the MS Graph / Outlook sync subsystem (server/utils/msgraph.js, sync-worker/msgraph_worker.py)'
    );
  });

  test('agents.md documents the central server/utils/ical.js utility layer', () => {
    const content = fs.readFileSync(agentsMdPath, 'utf8');
    assert.ok(
      content.includes('utils/ical.js') || content.includes('server/utils/ical.js'),
      'agents.md must document the central iCalendar utility module server/utils/ical.js'
    );
  });

});
