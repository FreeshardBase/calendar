'use strict';

/**
 * Issue #100 — HIGH: every container runs as root on a shard
 *
 * Validates that all container Dockerfiles configure and switch to non-root users:
 *   1. Dockerfile (webcalendar) specifies non-root USER node.
 *   2. radicale/Dockerfile creates a non-root user (radicale) and specifies USER radicale.
 *   3. sync-worker/Dockerfile creates a non-root user (syncworker) and specifies USER syncworker.
 *   4. All container Dockerfiles end with a non-root USER instruction.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #100 — Non-Root Container Execution', () => {

  test('Dockerfile (webcalendar) configures non-root user', () => {
    const dockerfilePath = path.join(ROOT_DIR, 'Dockerfile');
    assert.ok(fs.existsSync(dockerfilePath), 'Dockerfile must exist');
    const content = fs.readFileSync(dockerfilePath, 'utf8');

    assert.ok(/USER\s+node/i.test(content), 'Dockerfile must specify USER node');

    const lines = content.trim().split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    const lastUserLine = lines.filter(l => /^\s*USER\s+/i.test(l)).pop();
    assert.ok(lastUserLine, 'Dockerfile must contain a USER instruction');
    assert.ok(!/USER\s+root/i.test(lastUserLine), 'Dockerfile must not end as USER root');
  });

  test('radicale/Dockerfile creates and switches to non-root user', () => {
    const dockerfilePath = path.join(ROOT_DIR, 'radicale/Dockerfile');
    assert.ok(fs.existsSync(dockerfilePath), 'radicale/Dockerfile must exist');
    const content = fs.readFileSync(dockerfilePath, 'utf8');

    assert.ok(/useradd|groupadd/i.test(content), 'radicale/Dockerfile must create a non-root user');
    assert.ok(/USER\s+(radicale|[0-9]+)/i.test(content), 'radicale/Dockerfile must specify a non-root USER instruction');

    const lines = content.trim().split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    const lastUserLine = lines.filter(l => /^\s*USER\s+/i.test(l)).pop();
    assert.ok(lastUserLine, 'radicale/Dockerfile must contain a USER instruction');
    assert.ok(!/USER\s+root/i.test(lastUserLine), 'radicale/Dockerfile must not end as USER root');
  });

  test('sync-worker/Dockerfile creates and switches to non-root user', () => {
    const dockerfilePath = path.join(ROOT_DIR, 'sync-worker/Dockerfile');
    assert.ok(fs.existsSync(dockerfilePath), 'sync-worker/Dockerfile must exist');
    const content = fs.readFileSync(dockerfilePath, 'utf8');

    assert.ok(/useradd|groupadd/i.test(content), 'sync-worker/Dockerfile must create a non-root user');
    assert.ok(/USER\s+(syncworker|[0-9]+)/i.test(content), 'sync-worker/Dockerfile must specify a non-root USER instruction');

    const lines = content.trim().split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    const lastUserLine = lines.filter(l => /^\s*USER\s+/i.test(l)).pop();
    assert.ok(lastUserLine, 'sync-worker/Dockerfile must contain a USER instruction');
    assert.ok(!/USER\s+root/i.test(lastUserLine), 'sync-worker/Dockerfile must not end as USER root');
  });

});
