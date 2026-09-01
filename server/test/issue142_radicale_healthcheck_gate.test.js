'use strict';

/**
 * Issue #142 — MEDIUM: the Radicale image ships no HEALTHCHECK and the store template does not health-gate the entrypoint on it
 *
 * Validates:
 *   1. radicale/Dockerfile installs curl and includes a HEALTHCHECK instruction.
 *   2. docker-compose.yml adds healthcheck to caldav-server and health-gates webcalendar and sync-worker via depends_on condition: service_healthy.
 *   3. app-repository/apps/webcalendar/docker-compose.yml.template includes caldav-server healthcheck and health-gates webcalendar entrypoint via depends_on condition: service_healthy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');
const REPO_ROOT_DIR = path.resolve(ROOT_DIR, '../');
const STORE_TEMPLATE_PATH = path.join(REPO_ROOT_DIR, 'app-repository/apps/webcalendar/docker-compose.yml.template');

test.describe('Issue #142 — Radicale Container HEALTHCHECK & Store Template Health-Gating', () => {

  test('radicale/Dockerfile installs curl and defines HEALTHCHECK instruction', () => {
    const radicaleDockerPath = path.join(ROOT_DIR, 'radicale/Dockerfile');
    assert.ok(fs.existsSync(radicaleDockerPath), 'radicale/Dockerfile must exist');
    const content = fs.readFileSync(radicaleDockerPath, 'utf8');

    assert.ok(content.includes('curl'), 'radicale/Dockerfile must install curl');
    assert.ok(/HEALTHCHECK/i.test(content), 'radicale/Dockerfile must contain HEALTHCHECK instruction');
    assert.ok(/5232/i.test(content), 'radicale/Dockerfile HEALTHCHECK must target port 5232');
  });

  test('docker-compose.yml configures healthcheck on caldav-server and service_healthy dependency condition', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml must exist');
    const content = fs.readFileSync(composePath, 'utf8');

    const caldavStartIndex = content.indexOf('caldav-server:');
    assert.ok(caldavStartIndex > -1, 'caldav-server service must exist in docker-compose.yml');

    assert.ok(content.includes('healthcheck:'), 'docker-compose.yml must include healthcheck for caldav-server');
    assert.ok(content.includes('condition: service_healthy'), 'docker-compose.yml services must depend on service_healthy condition');
  });

  test('store docker-compose.yml.template includes caldav-server healthcheck and health-gates webcalendar', () => {
    assert.ok(fs.existsSync(STORE_TEMPLATE_PATH), 'Store docker-compose.yml.template must exist');
    const content = fs.readFileSync(STORE_TEMPLATE_PATH, 'utf8');

    assert.ok(content.includes('caldav-server'), 'Store template must include caldav-server service');
    assert.ok(content.includes('healthcheck:'), 'Store template must include healthcheck definition for caldav-server');
    assert.ok(content.includes('condition: service_healthy'), 'Store template webcalendar service must health-gate on caldav-server condition: service_healthy');
  });

});
