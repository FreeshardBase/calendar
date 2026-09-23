const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Issue #79 — Editing a series from a later occurrence preserves recurrenceId in frontend payload', () => {
  const modalJsPath = path.resolve(__dirname, '../../public/js/eventModal.js');
  const code = fs.readFileSync(modalJsPath, 'utf8');

  // Verify the fix is present
  assert.ok(
    code.includes("else if (scope === 'series')"),
    "Must handle scope === 'series' explicitly"
  );
  assert.ok(
    code.includes("payload.recurrenceId = _currentEvent.recurrenceId;"),
    "Must assign recurrenceId to payload"
  );
  
  // Verify it handles series scope correctly
  const blockMatch = code.match(/if\s*\(scope\s*===\s*'occurrence'\)[\s\S]*?else\s*if\s*\(scope\s*===\s*'series'\)\s*\{([^}]*)\}/);
  assert.ok(blockMatch, "Must have an else if block for 'series'");
  const seriesBlock = blockMatch[1];
  assert.ok(seriesBlock.includes('payload.scope'), "Must set payload.scope in series block");
  assert.ok(seriesBlock.includes('payload.recurrenceId'), "Must set payload.recurrenceId in series block");
});
