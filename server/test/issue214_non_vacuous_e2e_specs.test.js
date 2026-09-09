'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #214 — E2E specs must be non-vacuous and observe real application behavior', async (t) => {
  const specPath = path.join(__dirname, '../../e2e/calendar.spec.js');
  const specContent = fs.readFileSync(specPath, 'utf8');

  await t.test('Public ICS share feed spec must assert VEVENT content, not just empty VCALENDAR wrapper', () => {
    assert.strictEqual(
      specContent.includes("expect(icsText).toContain('BEGIN:VEVENT');"),
      true,
      'e2e/calendar.spec.js public share link spec must assert BEGIN:VEVENT in exported ICS feed'
    );
  });

  await t.test('Invitations inbox spec must observe endpoint HTTP 200 response and check for error state absence', () => {
    assert.strictEqual(
      specContent.includes("/api/events/invitations"),
      true,
      'e2e/calendar.spec.js invitations spec must reference /api/events/invitations endpoint'
    );
    assert.strictEqual(
      specContent.includes("invitations-error-state"),
      true,
      'e2e/calendar.spec.js invitations spec must verify invitations-error-state is not visible'
    );
  });

  await t.test('Desktop push notification spec must create event via UI instead of hand-building store object', () => {
    assert.strictEqual(
      specContent.includes("events.push({"),
      false,
      'e2e/calendar.spec.js push notification spec must not manually push hand-built event objects into store'
    );
    assert.strictEqual(
      specContent.includes("#ev-alarm"),
      true,
      'e2e/calendar.spec.js push notification spec must configure alarm via #ev-alarm UI element'
    );
  });

  await t.test('View switching specs must assert view container visibility in layout, not just tab button class or hidden containers', () => {
    assert.strictEqual(
      specContent.includes("expect(page.locator('.day-view')).toBeVisible()"),
      true,
      'e2e/calendar.spec.js view switching spec must assert .day-view is visible'
    );
    assert.strictEqual(
      specContent.includes("expect(page.locator('.agenda-view')).toBeVisible()"),
      true,
      'e2e/calendar.spec.js view switching spec must assert .agenda-view is visible'
    );
  });
});
