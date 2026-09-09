'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve('public/index.html');
const appJsPath = path.resolve('public/js/app.js');

test('Issue #186 — Dialogs Accessible Names (aria-labelledby / aria-label)', async (t) => {
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  await t.test('index.html static dialogs have accessible names', () => {
    // 1. #account-modal
    assert.ok(
      indexHtml.includes('id="account-modal"') &&
      (indexHtml.includes('aria-labelledby="account-modal-title"') || indexHtml.includes('aria-label=')),
      '#account-modal must declare aria-labelledby or aria-label'
    );
    assert.ok(
      indexHtml.includes('id="account-modal-title"'),
      '#account-modal header must have id="account-modal-title"'
    );

    // 2. #welcome-modal
    assert.ok(
      indexHtml.includes('id="welcome-modal"') &&
      (indexHtml.includes('aria-labelledby="welcome-modal-title"') || indexHtml.includes('aria-label=')),
      '#welcome-modal must declare aria-labelledby or aria-label'
    );
    assert.ok(
      indexHtml.includes('id="welcome-modal-title"'),
      '#welcome-modal header must have id="welcome-modal-title"'
    );

    // 3. #scope-dialog
    assert.ok(
      indexHtml.includes('id="scope-dialog"') &&
      (indexHtml.includes('aria-labelledby="scope-dialog-title"') || indexHtml.includes('aria-label=')),
      '#scope-dialog must declare aria-labelledby or aria-label'
    );
    assert.ok(
      indexHtml.includes('id="scope-dialog-title"'),
      '#scope-dialog header must have id="scope-dialog-title"'
    );

    // 4. #msgraph-modal
    assert.ok(
      indexHtml.includes('id="msgraph-modal"') &&
      (indexHtml.includes('aria-labelledby="msgraph-modal-title"') || indexHtml.includes('aria-label=')),
      '#msgraph-modal must declare aria-labelledby or aria-label'
    );
    assert.ok(
      indexHtml.includes('id="msgraph-modal-title"'),
      '#msgraph-modal header must have id="msgraph-modal-title"'
    );
  });

  await t.test('app.js dynamic JS dialogs have accessible names', () => {
    // 5. showImportDialog (ICS import modal)
    assert.ok(
      appJs.includes('id="import-dialog-title"') && appJs.includes('aria-labelledby="import-dialog-title"'),
      'showImportDialog template must declare aria-labelledby="import-dialog-title" and matching title id'
    );

    // 6. openEditCalendarDialog
    assert.ok(
      appJs.includes('id="edit-cal-dialog-title"') && appJs.includes('aria-labelledby="edit-cal-dialog-title"'),
      'openEditCalendarDialog template must declare aria-labelledby="edit-cal-dialog-title" and matching title id'
    );

    // 7. openShareDialog
    assert.ok(
      appJs.includes('id="share-cal-dialog-title"') && appJs.includes('aria-labelledby="share-cal-dialog-title"'),
      'openShareDialog template must declare aria-labelledby="share-cal-dialog-title" and matching title id'
    );

    // 8. openAddCalendarDialog
    assert.ok(
      appJs.includes('id="add-cal-dialog-title"') && appJs.includes('aria-labelledby="add-cal-dialog-title"'),
      'openAddCalendarDialog template must declare aria-labelledby="add-cal-dialog-title" and matching title id'
    );
  });
});
