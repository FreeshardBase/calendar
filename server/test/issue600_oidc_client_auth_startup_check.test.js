'use strict';

/**
 * Issue #600 — with AUTH_METHOD=oidc the server checks its client authentication against the token
 * endpoint before it binds its port: a token request with a deliberately invalid code must be
 * answered with `invalid_grant` (client accepted). Without OIDC_TOKEN_AUTH_METHOD the offered
 * methods are tried in order and the first accepted one is used and logged; if none is accepted,
 * or an explicit OIDC_TOKEN_AUTH_METHOD is rejected, the start fails.
 *
 * The real `node server/index.js` (NODE_ENV=production) boots against a stub issuer that, like
 * Authelia, advertises both methods but accepts only the one the client is registered for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createTestCertificate } = require('./helpers/testTls');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue600-oidc-'));
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const BASE_URL = 'https://calendar.shard.example';
const CLIENT_ID = 'testuser-webcalendar';
const CLIENT_SECRET = 'testuser-client-secret-0123456789abcdef';

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

// `accepted` lists the methods the issuer accepts for this client; discovery advertises both.
async function startStubIssuer(tls) {
  const state = { accepted: [], tokenRequests: [] };
  let issuer;

  function methodUsed(req, form) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ') && !form.has('client_secret')) {
      const [id, secret] = Buffer.from(header.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
      return id === CLIENT_ID && secret === CLIENT_SECRET ? 'client_secret_basic' : null;
    }
    if (!header && form.get('client_id') === CLIENT_ID && form.get('client_secret') === CLIENT_SECRET) {
      return 'client_secret_post';
    }
    return null;
  }

  const server = https.createServer(tls, async (req, res) => {
    const url = new URL(req.url, issuer);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post']
      });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const method = methodUsed(req, form);
      state.tokenRequests.push({ method, grantType: form.get('grant_type'), code: form.get('code') });
      if (!method || !state.accepted.includes(method)) {
        return json(401, { error: 'invalid_client', error_description: 'Client authentication failed' });
      }
      // No code was ever issued by this stub: every code is invalid.
      return json(400, { error: 'invalid_grant', error_description: 'The authorization code is invalid' });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `https://127.0.0.1:${server.address().port}`;
  return { server, issuer, state };
}

function bootServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', (c) => {
      stdout += c;
      if (stdout.includes('running on')) child.kill('SIGTERM');
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ started: stdout.includes('running on'), code, signal, stdout, stderr });
    });
  });
}

test('Issue #600 — the OIDC client authentication is checked at start', async (t) => {
  const tls = createTestCertificate();
  const caPath = path.join(tmpDir, 'issuer-ca.pem');
  fs.writeFileSync(caPath, tls.cert);
  const idp = await startStubIssuer(tls);
  t.after(() => idp.server.close());

  let run = 0;
  async function boot({ accepted, override }) {
    idp.state.accepted = accepted;
    idp.state.tokenRequests = [];
    run += 1;
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      NODE_EXTRA_CA_CERTS: caPath,
      PORT: '0',
      SSL_KEY_PATH: '',
      SSL_CERT_PATH: '',
      DATABASE_PATH: path.join(tmpDir, `issue600-${run}.db`),
      SESSION_SECRET: 'issue600-prod-session-secret-0123456789abcdef',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      SYSTEM_SYNC_SECRET: 'issue600-system-sync-secret-0123456789abcdef',
      INTERNAL_WEBHOOK_SECRET: 'issue600-internal-webhook-secret-0123456789',
      BASE_URL,
      AUTH_METHOD: 'oidc',
      OIDC_ISSUER_URL: idp.issuer,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET: CLIENT_SECRET
    };
    if (override) env.OIDC_TOKEN_AUTH_METHOD = override;
    return bootServer(env);
  }

  await t.test('an issuer accepting only client_secret_post: the app probes and chooses post', async () => {
    const r = await boot({ accepted: ['client_secret_post'] });
    assert.ok(r.started, `server must start; code=${r.code} stderr: ${r.stderr}`);
    assert.match(r.stdout, /client_secret_post/, `the chosen method must be logged; stdout: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /client authentication: client_secret_basic/);
    const probes = idp.state.tokenRequests;
    assert.deepEqual(probes.map((p) => p.method), ['client_secret_basic', 'client_secret_post'],
      'basic is tried first, then post');
    for (const p of probes) {
      assert.equal(p.grantType, 'authorization_code');
      assert.ok(p.code, 'the probe sends a (deliberately invalid) code');
    }
  });

  await t.test('an issuer accepting only client_secret_basic: the app chooses basic', async () => {
    const r = await boot({ accepted: ['client_secret_basic'] });
    assert.ok(r.started, `server must start; code=${r.code} stderr: ${r.stderr}`);
    assert.match(r.stdout, /client_secret_basic/, `the chosen method must be logged; stdout: ${r.stdout}`);
    assert.deepEqual(idp.state.tokenRequests.map((p) => p.method), ['client_secret_basic']);
  });

  await t.test('an issuer accepting neither method: the start is refused, naming client id and methods', async () => {
    const r = await boot({ accepted: [] });
    assert.equal(r.started, false, `server must not start; stdout: ${r.stdout}`);
    assert.equal(r.signal, null, 'server must exit on its own');
    assert.notEqual(r.code, 0);
    assert.ok(r.stderr.includes(CLIENT_ID), `stderr must name the client id: ${r.stderr}`);
    assert.match(r.stderr, /client_secret_basic/);
    assert.match(r.stderr, /client_secret_post/);
  });

  await t.test('an explicit OIDC_TOKEN_AUTH_METHOD the issuer rejects fails the start', async () => {
    const r = await boot({ accepted: ['client_secret_post'], override: 'client_secret_basic' });
    assert.equal(r.started, false, `server must not start; stdout: ${r.stdout}`);
    assert.equal(r.signal, null, 'server must exit on its own');
    assert.notEqual(r.code, 0);
    assert.ok(r.stderr.includes(CLIENT_ID), `stderr must name the client id: ${r.stderr}`);
    assert.match(r.stderr, /client_secret_basic/);
    assert.deepEqual(idp.state.tokenRequests.map((p) => p.method), ['client_secret_basic'],
      'an explicit method is the only one tried');
  });

  await t.test('an explicit OIDC_TOKEN_AUTH_METHOD the issuer accepts starts the app', async () => {
    const r = await boot({ accepted: ['client_secret_post'], override: 'client_secret_post' });
    assert.ok(r.started, `server must start; code=${r.code} stderr: ${r.stderr}`);
    assert.match(r.stdout, /client_secret_post/);
    assert.deepEqual(idp.state.tokenRequests.map((p) => p.method), ['client_secret_post']);
  });
});
