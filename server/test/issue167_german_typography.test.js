const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');

test('Issue #167 - German typography: no straight closing quote after German opening quote „', () => {
  const jsFiles = [
    'public/js/app.js',
    'public/js/accountModal.js',
    'public/js/eventModal.js',
    'public/js/tasks.js',
    'public/js/calendar.js'
  ];

  const matchedPattern = /„[^”\n]*"/g;

  for (const relPath of jsFiles) {
    const fullPath = path.join(projectRoot, relPath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const matches = content.match(matchedPattern);
    assert.equal(
      matches,
      null,
      `Found straight closing quote following opening German quote in ${relPath}: ${JSON.stringify(matches)}`
    );
  }
});

test('Issue #167 - German typography: overflow text singular vs plural (+1 weiterer vs +N weitere)', () => {
  const calendarJsPath = path.join(projectRoot, 'public/js/calendar.js');
  const content = fs.readFileSync(calendarJsPath, 'utf8');

  // Verify code contains singular check for '+1 weiterer'
  assert.ok(
    content.includes("'+1 weiterer'") || content.includes('"+1 weiterer"') || content.includes('`+1 weiterer`'),
    'calendar.js should format 1 overflow item as +1 weiterer'
  );
});

test('Issue #167 - German typography: toolbar titles use proper German month abbreviations or range titles', () => {
  const calendarJsPath = path.join(projectRoot, 'public/js/calendar.js');
  const content = fs.readFileSync(calendarJsPath, 'utf8');

  // Verify weekTitle uses month abbreviations with dots or full month names
  assert.ok(
    content.includes("MONTHS[ws.getMonth()].slice(0, 3) + '.'") ||
    content.includes("MONTHS[ws.getMonth()].slice(0,3) + '.'") ||
    content.includes("MONTH_ABBR") ||
    content.includes("MONTHS[we.getMonth()]"),
    'calendar.js should format month abbreviations cleanly'
  );
});
