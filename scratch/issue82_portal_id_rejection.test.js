const { test } = require('node:test');
const assert = require('node:assert');
const { getSessionConfig } = require('../utils/sessionConfig');
const { validateEncryptionKey } = require('../db');

test('Issue 82 - Reject 103-character rendered portal.id as SESSION_SECRET', () => {
  const renderedPortalId = 'a'.repeat(103);
  assert.throws(() => {
    getSessionConfig({ NODE_ENV: 'production', SESSION_SECRET: renderedPortalId });
  }, /SESSION_SECRET must be explicitly configured/);
});

test('Issue 82 - Reject 103-character rendered portal.id as ENCRYPTION_KEY', () => {
  const renderedPortalId = 'b'.repeat(103);
  assert.throws(() => {
    validateEncryptionKey({ NODE_ENV: 'production', ENCRYPTION_KEY: renderedPortalId });
  }, /ENCRYPTION_KEY must be explicitly configured/);
});
