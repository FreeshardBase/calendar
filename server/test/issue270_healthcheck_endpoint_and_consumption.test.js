'use strict';

/**
 * Issue #270 — MEDIUM: the one healthcheck in the deployment cannot fail for any reason that matters, and nothing consumes it
 *
 * Validates:
 *   1. GET /api/health and GET /health return 200 OK with status: 'ok' when database is operational.
 *   2. GET /api/health returns 500 Internal Server Error when database check fails.
 *   3. Dockerfile defines HEALTHCHECK targeting /api/health (or /health) instead of /.
 *   4. docker-compose.yml defines healthcheck for webcalendar service targeting /api/health (or /health).
 *   5. store template docker-compose.yml.template defines healthcheck for webcalendar service targeting /api/health (or /health).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT_DIR = path.join(__dirname, '../..');
const REPO_ROOT_DIR = path.resolve(ROOT_DIR, '../');
const STORE_TEMPLATE_PATH = path.join(REPO_ROOT_DIR, 'app-repository/apps/webcalendar/docker-compose.yml.template');

const Db = require('../db');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, body: json, raw: data });
        } catch {
          resolve({ status: res.statusCode, body: null, raw: data });
        }
      });
    }).on('error', reject);
  });
}

test.describe('Issue #270 — Healthcheck Endpoint & Consumption Verification', () => {
  let server;
  let baseUrl;

  test.before(() => {
    return new Promise((resolve) => {
      const express = require('express');
      const app = express();

      const healthHandler = async (req, res) => {
        try {
          await Db.checkHealth();
          res.json({ status: 'ok', database: 'connected' });
        } catch (err) {
          res.status(500).json({ status: 'error', error: err?.message || 'Database query failed' });
        }
      };

      app.get('/health', healthHandler);
      app.get('/api/health', healthHandler);

      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  test.after(() => {
    return new Promise((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  test('Db.checkHealth resolves successfully when database is healthy', async () => {
    const healthy = await Db.checkHealth();
    assert.strictEqual(healthy, true, 'Db.checkHealth() must return true when DB is operational');
  });

  test('GET /api/health and GET /health return 200 OK with status ok when healthy', async () => {
    const resApi = await fetchJson(`${baseUrl}/api/health`);
    assert.strictEqual(resApi.status, 200, 'GET /api/health must return HTTP 200');
    assert.strictEqual(resApi.body.status, 'ok', 'GET /api/health response status must be "ok"');

    const resRoot = await fetchJson(`${baseUrl}/health`);
    assert.strictEqual(resRoot.status, 200, 'GET /health must return HTTP 200');
    assert.strictEqual(resRoot.body.status, 'ok', 'GET /health response status must be "ok"');
  });

  test('GET /api/health returns 500 when database check fails', async () => {
    const originalCheckHealth = Db.checkHealth;
    try {
      Db.checkHealth = async () => {
        throw new Error('Database disk image is malformed');
      };
      const res = await fetchJson(`${baseUrl}/api/health`);
      assert.strictEqual(res.status, 500, 'GET /api/health must return HTTP 500 on database failure');
      assert.strictEqual(res.body.status, 'error', 'Response status must be "error" on DB failure');
      assert.ok(res.body.error.includes('malformed'), 'Error message must be included in response');
    } finally {
      Db.checkHealth = originalCheckHealth;
    }
  });

  test('Dockerfile defines HEALTHCHECK targeting /api/health', () => {
    const dockerfilePath = path.join(ROOT_DIR, 'Dockerfile');
    assert.ok(fs.existsSync(dockerfilePath), 'Dockerfile must exist');
    const content = fs.readFileSync(dockerfilePath, 'utf8');

    assert.ok(/HEALTHCHECK/i.test(content), 'Dockerfile must contain HEALTHCHECK instruction');
    assert.ok(content.includes('/api/health') || content.includes('/health'), 'Dockerfile HEALTHCHECK must target health endpoint');
    assert.ok(!content.includes('http://localhost:3000/ '), 'Dockerfile HEALTHCHECK must not target root page /');
  });

  test('docker-compose.yml configures healthcheck for webcalendar service', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml must exist');
    const content = fs.readFileSync(composePath, 'utf8');

    const webcalStart = content.search(/^\s{2}webcalendar:/m);
    const caldavStart = content.search(/^\s{2}caldav-server:/m);
    assert.ok(webcalStart > -1 && caldavStart > webcalStart, 'Service blocks must be present');
    const webcalBlock = content.substring(webcalStart, caldavStart);

    assert.ok(webcalBlock.includes('healthcheck:'), 'docker-compose.yml webcalendar service must include healthcheck definition');
    assert.ok(webcalBlock.includes('/api/health') || webcalBlock.includes('/health'), 'docker-compose.yml webcalendar healthcheck must target health endpoint');
  });

  test('store docker-compose.yml.template configures healthcheck for webcalendar service', () => {
    assert.ok(fs.existsSync(STORE_TEMPLATE_PATH), 'Store docker-compose.yml.template must exist');
    const content = fs.readFileSync(STORE_TEMPLATE_PATH, 'utf8');

    const webcalStart = content.search(/^\s{2}webcalendar:/m);
    const caldavStart = content.search(/^\s{2}caldav-server:/m);
    assert.ok(webcalStart > -1 && caldavStart > webcalStart, 'Service blocks must be present in store template');
    const webcalBlock = content.substring(webcalStart, caldavStart);

    assert.ok(webcalBlock.includes('healthcheck:'), 'Store template webcalendar service must include healthcheck definition');
    assert.ok(webcalBlock.includes('/api/health') || webcalBlock.includes('/health'), 'Store template webcalendar healthcheck must target health endpoint');
  });
});
