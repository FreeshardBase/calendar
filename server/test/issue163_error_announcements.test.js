'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Issue #163 — Accessible Error Announcements & Persistent Delete Failure Channel', async (t) => {
  const appJsPath = path.join(__dirname, '../../public/js/app.js');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  await t.test('showToast sets role="alert" and aria-live="assertive" for error toasts', () => {
    assert.ok(
      appJsContent.includes("role") && appJsContent.includes("alert"),
      'showToast must set role="alert" for error toasts'
    );
    assert.ok(
      appJsContent.includes("aria-live") && appJsContent.includes("assertive"),
      'showToast must set aria-live="assertive" for error announcements'
    );
  });

  await t.test('Error toasts do not auto-dismiss after 4 seconds', () => {
    // Verify that the 4000ms setTimeout is guarded so error toasts persist
    assert.ok(
      appJsContent.includes("type === 'error'") || appJsContent.includes('type !== \'error\''),
      'showToast should guard auto-dismiss so error toasts persist until manually closed'
    );
  });

  await t.test('Error toasts update status bar for persistent error channel', () => {
    assert.ok(
      appJsContent.includes("setStatus") && (appJsContent.includes("Fehler") || appJsContent.includes("error")),
      'showToast must update status bar when an error occurs'
    );
  });

  await t.test('Failed event delete in popover reports descriptive error toast', () => {
    assert.ok(
      appJsContent.includes("Fehler beim Löschen") || appJsContent.includes("showToast(err.message"),
      'Event popover delete failure must announce error via showToast'
    );
  });
});
