const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #230: OAuth popup postMessage origin validation in server and client', async (t) => {
  // The popup script moved from server/routes/auth.js into an external file (issue #338, strict CSP).
  await t.test('OAuth popup script does not send postMessage to wildcard origin *', () => {
    const popupScriptPath = path.join(__dirname, '../../public/js/oauthLinked.js');
    const content = fs.readFileSync(popupScriptPath, 'utf8');

    assert.ok(
      !content.includes("postMessage('google-account-linked', '*')"),
      'OAuth popup script public/js/oauthLinked.js must not send postMessage to wildcard origin *'
    );
    assert.ok(
      content.includes("postMessage('google-account-linked', window.location.origin)"),
      'OAuth popup script public/js/oauthLinked.js must send postMessage to window.location.origin'
    );
  });

  await t.test('client app.js validates message event origin before processing google-account-linked', () => {
    const appJsPath = path.join(__dirname, '../../public/js/app.js');
    const content = fs.readFileSync(appJsPath, 'utf8');

    const messageHandlerRegex = /window\.addEventListener\s*\(\s*['"]message['"]\s*,\s*(?:async\s*)?\(?e\)?\s*=>\s*\{([\s\S]+?)\}\s*\);/;
    const match = content.match(messageHandlerRegex);
    assert.ok(match, 'public/js/app.js must contain a window message event listener');

    const body = match[1];
    assert.ok(
      body.includes('e.origin !== window.location.origin') || body.includes('e.origin === window.location.origin'),
      'public/js/app.js message event listener must check e.origin against window.location.origin'
    );
  });
});
