'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3196';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Issue #84 — Office 365 / MS Graph UI Reachability Suite', async (t) => {

  await t.test('Defect 1: public/js/accountModal.js must import and bind openMSGraphModal to #btn-link-msgraph', () => {
    const accountModalContent = fs.readFileSync(
      path.join(__dirname, '../../public/js/accountModal.js'),
      'utf8'
    );
    assert.ok(
      accountModalContent.includes('btn-link-msgraph'),
      'accountModal.js must reference btn-link-msgraph'
    );
    assert.ok(
      accountModalContent.includes('openMSGraphModal'),
      'accountModal.js must import or call openMSGraphModal'
    );
  });

  await t.test('Defect 2: public/js/msgraph.js must export initMSGraphModal, openMSGraphModal, and closeMSGraphModal', () => {
    const msgraphContent = fs.readFileSync(
      path.join(__dirname, '../../public/js/msgraph.js'),
      'utf8'
    );
    assert.ok(
      msgraphContent.includes('export function initMSGraphModal'),
      'msgraph.js must export initMSGraphModal'
    );
    assert.ok(
      msgraphContent.includes('export function openMSGraphModal'),
      'msgraph.js must export openMSGraphModal'
    );
    assert.ok(
      msgraphContent.includes('export function closeMSGraphModal'),
      'msgraph.js must export closeMSGraphModal'
    );
  });

  await t.test('Defect 3: public/js/app.js must import and call initMSGraphModal in boot sequence', () => {
    const appContent = fs.readFileSync(
      path.join(__dirname, '../../public/js/app.js'),
      'utf8'
    );
    assert.ok(
      appContent.includes('initMSGraphModal'),
      'app.js must reference initMSGraphModal'
    );
  });

  await t.test('MS Graph modal DOM elements must exist in index.html', () => {
    const htmlContent = fs.readFileSync(
      path.join(__dirname, '../../public/index.html'),
      'utf8'
    );
    assert.ok(htmlContent.includes('id="btn-link-msgraph"'), 'index.html must contain #btn-link-msgraph');
    assert.ok(htmlContent.includes('id="msgraph-modal-backdrop"'), 'index.html must contain #msgraph-modal-backdrop');
    assert.ok(htmlContent.includes('id="msgraph-form"'), 'index.html must contain #msgraph-form');
    assert.ok(htmlContent.includes('id="msgraph-accounts-list"'), 'index.html must contain #msgraph-accounts-list');
  });
});
