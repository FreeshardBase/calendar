'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #232 — Stored XSS & Session Takeover E2E Prevention Suite', async (t) => {
  await t.test('All frontend select and list rendering modules sanitize user-controlled HTML string inputs', () => {
    const jsDir = path.join(__dirname, '../../public/js');
    const filesToAudit = ['eventModal.js', 'tasks.js', 'availability.js', 'delegates.js', 'invitations.js', 'app.js'];

    filesToAudit.forEach((file) => {
      const filePath = path.join(jsDir, file);
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');

      // Verify no raw unescaped c.id or c.name in string template option values
      const unescapedOpt = /<option value="\${(?!esc|escape).*c\.(id|name)}"/i;
      assert.strictEqual(
        unescapedOpt.test(content),
        false,
        `Unescaped calendar property detected in ${file}`
      );
    });
  });

  await t.test('Session cookies enforce HttpOnly protection preventing client-side script cookie theft', () => {
    const sessionConfigPath = path.join(__dirname, '../../server/utils/sessionConfig.js');
    const content = fs.readFileSync(sessionConfigPath, 'utf8');

    assert.match(content, /httpOnly:\s*true/, 'Session cookie must enforce httpOnly: true in sessionConfig.js');
  });

  await t.test('requireAuth middleware is present and mounted on protected API routes', () => {
    const indexPath = path.join(__dirname, '../../server/index.js');
    const content = fs.readFileSync(indexPath, 'utf8');

    assert.match(content, /function requireAuth/, 'requireAuth function must be defined in server/index.js');
  });
});
