'use strict';

/**
 * A throwaway self-signed certificate for 127.0.0.1, trusted for this test process only.
 *
 * openid-client v6 (#179) talks only to https issuers, so mock identity providers in tests serve
 * TLS. trustTestCertificate() makes the process-wide fetch dispatcher accept exactly this
 * certificate; node --test runs every test file in its own process.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agent, setGlobalDispatcher } = require('undici');

function createTestCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-tls-'));
  try {
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'
    ], { stdio: 'pipe' });
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function trustTestCertificate(cert) {
  setGlobalDispatcher(new Agent({ connect: { ca: cert } }));
}

module.exports = { createTestCertificate, trustTestCertificate };
