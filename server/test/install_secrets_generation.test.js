'use strict';

/**
 * Issue #82 — CRITICAL: ENCRYPTION_KEY and SESSION_SECRET must be generated per install
 *
 * Verifies that SESSION_SECRET and ENCRYPTION_KEY cannot fall back to predictable / world-readable
 * values (such as portal.id, default fallback strings, or empty values) in production and staging environments.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { getSessionConfig } = require('../utils/sessionConfig');
const { validateEncryptionKey } = require('../db');

test.describe('Issue #82 — Per-Install ENCRYPTION_KEY & SESSION_SECRET Generation Guard', () => {

  test('getSessionConfig rejects portal.id and weak secrets in production', () => {
    const renderedPortalId = '8271dd' + 'a'.repeat(97);
    const weakSecrets = [
      'portal.id',
      '{{ portal.id }}',
      '{{portal.id}}',
      renderedPortalId,
      'freeshard-change-this-in-production',
      'freeshard-webcalendar-prod-secret-change-in-env',
      'change-me'
    ];

    for (const secret of weakSecrets) {
      assert.throws(
        () => getSessionConfig({ NODE_ENV: 'production', SESSION_SECRET: secret }),
        /SESSION_SECRET must be explicitly configured/i,
        `Expected getSessionConfig to reject weak SESSION_SECRET: ${secret}`
      );
    }
  });

  test('getSessionConfig accepts valid random SESSION_SECRET in production', () => {
    const config = getSessionConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'd8f9a2b3c4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1'
    });
    assert.equal(config.secret, 'd8f9a2b3c4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1');
  });

  test('validateEncryptionKey rejects portal.id and weak default keys in production', () => {
    const renderedPortalId = '8271dd' + 'a'.repeat(97);
    const weakKeys = [
      'portal.id',
      '{{ portal.id }}',
      '{{portal.id}}',
      renderedPortalId,
      'freeshard-default-encryption-key-do-not-use-in-prod',
      'change-me',
      'change-me-32-chars-or-more'
    ];

    for (const key of weakKeys) {
      assert.throws(
        () => validateEncryptionKey({ NODE_ENV: 'production', ENCRYPTION_KEY: key }),
        /ENCRYPTION_KEY must be explicitly configured/i,
        `Expected validateEncryptionKey to reject weak ENCRYPTION_KEY: ${key}`
      );
    }
  });

  test('validateEncryptionKey accepts valid 32-byte key in production', () => {
    const validKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    assert.doesNotThrow(() => {
      validateEncryptionKey({ NODE_ENV: 'production', ENCRYPTION_KEY: validKey });
    });
  });

  test('validateEncryptionKey allows default key in development/test environments', () => {
    assert.doesNotThrow(() => {
      validateEncryptionKey({ NODE_ENV: 'test', ENCRYPTION_KEY: 'freeshard-default-encryption-key-do-not-use-in-prod' });
    });
  });

});
