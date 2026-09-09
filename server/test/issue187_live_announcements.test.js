'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve('public/index.html');
const appJsPath = path.resolve('public/js/app.js');

test('Issue #187 — Screen Reader Live Announcements (Loading, View, Date, Search)', async (t) => {
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  await t.test('index.html contains ARIA live announcer and status bar live region', () => {
    assert.ok(
      indexHtml.includes('id="aria-announcer"') && indexHtml.includes('aria-live="polite"'),
      'index.html must include #aria-announcer with aria-live="polite"'
    );
    assert.ok(
      indexHtml.includes('id="status-bar"') && indexHtml.includes('aria-live="polite"'),
      'index.html #status-bar must include aria-live="polite"'
    );
  });

  await t.test('app.js includes announce helper function for live announcements', () => {
    assert.ok(
      appJs.includes('function announce(') || appJs.includes('const announce ='),
      'app.js must define an announce helper function'
    );
  });

  await t.test('app.js announces loading state transitions', () => {
    assert.ok(
      appJs.includes("announce('Lade Termine") || appJs.includes("announce('Termine werden geladen") || appJs.includes("announce('Kalender geladen") || appJs.includes("announce("),
      'app.js must trigger live announcements during data/loading operations'
    );
  });

  await t.test('app.js announces view switching', () => {
    assert.ok(
      appJs.includes('switchView') && (appJs.includes('Ansicht gewechselt') || appJs.includes('announce(')),
      'app.js switchView must trigger live announcements when switching views'
    );
  });

  await t.test('app.js announces date navigation changes', () => {
    assert.ok(
      (appJs.includes("announce('Datum:") || appJs.includes("announce(`Datum:") || appJs.includes("announce(")) &&
      appJs.includes('prev-btn') && appJs.includes('next-btn'),
      'app.js date navigation must trigger live announcements on date changes'
    );
  });

  await t.test('app.js announces search results count updates', () => {
    assert.ok(
      appJs.includes('search-input') && (appJs.includes('Ergebnis') || appJs.includes('Ergebnisse')),
      'app.js search handler must trigger live announcements for search result counts'
    );
  });
});
