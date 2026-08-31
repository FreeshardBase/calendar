'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Issue #102 — README and Architecture Documentation Shipping Topology Accuracy', async (t) => {
  const readmePath = path.join(__dirname, '../../README.md');
  const agentsPath = path.join(__dirname, '../../agents.md');

  assert.strictEqual(fs.existsSync(readmePath), true, 'README.md must exist');
  assert.strictEqual(fs.existsSync(agentsPath), true, 'agents.md must exist');

  const readmeContent = fs.readFileSync(readmePath, 'utf8');
  const agentsContent = fs.readFileSync(agentsPath, 'utf8');

  await t.test('README.md must not promise external CalDAV client access via app-passwords', () => {
    assert.strictEqual(
      readmeContent.includes('app-passwords for external CalDAV clients'),
      false,
      'README.md must NOT claim app-passwords are for external CalDAV clients in the shipping topology'
    );
  });

  await t.test('README.md must accurately document internal CalDAV storage engine role', () => {
    assert.strictEqual(
      readmeContent.includes('Internal CalDAV storage engine') || readmeContent.includes('internal CalDAV storage engine') || readmeContent.includes('Internal CalDAV storage'),
      true,
      'README.md must document Radicale as internal CalDAV storage'
    );
    assert.strictEqual(
      readmeContent.includes('shipping topology'),
      true,
      'README.md must document CalDAV integration topology details regarding shipping topology'
    );
  });

  await t.test('agents.md must accurately document app passwords as internal service credentials', () => {
    assert.strictEqual(
      agentsContent.includes('(sha256, for external CalDAV clients)'),
      false,
      'agents.md must NOT claim app passwords are for external CalDAV clients'
    );
  });
});
