const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #125 — Sidebar button hierarchy (no side-by-side amber forward actions)', () => {
  const indexPath = path.join(__dirname, '../../public/index.html');
  const indexContent = fs.readFileSync(indexPath, 'utf-8');

  // Verify new-event-btn is primary sidebar action (sidebar-new-btn)
  const eventBtnMatch = indexContent.match(/<button[^>]*id="new-event-btn"[^>]*>/);
  assert.ok(eventBtnMatch, 'new-event-btn should exist');
  assert.ok(eventBtnMatch[0].includes('sidebar-new-btn'), 'new-event-btn should retain sidebar-new-btn primary styling');

  // Verify new-task-btn does NOT use sidebar-new-btn (amber primary forward action)
  const taskBtnMatch = indexContent.match(/<button[^>]*id="new-task-btn"[^>]*>/);
  assert.ok(taskBtnMatch, 'new-task-btn should exist');
  assert.strictEqual(taskBtnMatch[0].includes('sidebar-new-btn'), false, 'new-task-btn must not use amber sidebar-new-btn class side-by-side with new-event-btn');
});

test('Issue #125 — Welcome modal button emphasis', () => {
  const indexPath = path.join(__dirname, '../../public/index.html');
  const indexContent = fs.readFileSync(indexPath, 'utf-8');

  // Verify welcome-btn-close is primary action (btn-primary)
  const welcomeCloseMatch = indexContent.match(/<button[^>]*id="welcome-btn-close"[^>]*>/);
  assert.ok(welcomeCloseMatch, 'welcome-btn-close should exist');
  assert.ok(welcomeCloseMatch[0].includes('btn-primary'), 'welcome-btn-close must be btn-primary to emphasize entering calendar');

  // Verify welcome-btn-add-account is secondary/ghost (not btn-primary)
  const addAccountMatch = indexContent.match(/<button[^>]*id="welcome-btn-add-account"[^>]*>/);
  assert.ok(addAccountMatch, 'welcome-btn-add-account should exist');
  assert.strictEqual(addAccountMatch[0].includes('btn-primary'), false, 'welcome-btn-add-account must not be btn-primary as it is an optional action');
});
