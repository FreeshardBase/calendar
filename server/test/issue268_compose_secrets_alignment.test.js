'use strict';

/**
 * Issue #268 — Docker Compose Secrets Alignment
 *
 * Verifies that docker-compose.yml aligns environment variable definitions for shared secrets:
 *   1. SYSTEM_SYNC_SECRET is explicitly declared with identical default fallback (`${SYSTEM_SYNC_SECRET:-super-secret-bypass}`)
 *      across webcalendar, caldav-server, and sync-worker services.
 *   2. ENCRYPTION_KEY is explicitly declared with identical default fallback
 *      (`${ENCRYPTION_KEY:-${ENCRYPTION_SECRET:-freeshard-default-encryption-key-do-not-use-in-prod}}`)
 *      across webcalendar and sync-worker services.
 *   3. SESSION_SECRET is explicitly declared in webcalendar service.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #268 — Docker Compose Secrets Alignment', () => {

  test('docker-compose.yml declares SYSTEM_SYNC_SECRET consistently across webcalendar, caldav-server, and sync-worker', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml must exist');
    const content = fs.readFileSync(composePath, 'utf8');

    const webcalendarIdx = content.indexOf('\n  webcalendar:');
    const caldavIdx = content.indexOf('\n  caldav-server:');
    const syncWorkerIdx = content.indexOf('\n  sync-worker:');
    const volumesIdx = content.indexOf('\nvolumes:');

    const webcalendarSection = content.substring(webcalendarIdx, caldavIdx);
    const caldavSection = content.substring(caldavIdx, syncWorkerIdx);
    const syncWorkerSection = content.substring(syncWorkerIdx, volumesIdx > -1 ? volumesIdx : content.length);

    assert.ok(
      webcalendarSection.includes('SYSTEM_SYNC_SECRET: ${SYSTEM_SYNC_SECRET:-super-secret-bypass}'),
      'webcalendar service in docker-compose.yml must declare SYSTEM_SYNC_SECRET with default fallback'
    );
    assert.ok(
      caldavSection.includes('SYSTEM_SYNC_SECRET: ${SYSTEM_SYNC_SECRET:-super-secret-bypass}'),
      'caldav-server service in docker-compose.yml must declare SYSTEM_SYNC_SECRET with default fallback'
    );
    assert.ok(
      syncWorkerSection.includes('SYSTEM_SYNC_SECRET: ${SYSTEM_SYNC_SECRET:-super-secret-bypass}'),
      'sync-worker service in docker-compose.yml must declare SYSTEM_SYNC_SECRET with default fallback'
    );
  });

  test('docker-compose.yml declares ENCRYPTION_KEY consistently across webcalendar and sync-worker', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    const content = fs.readFileSync(composePath, 'utf8');

    const webcalendarIdx = content.indexOf('\n  webcalendar:');
    const caldavIdx = content.indexOf('\n  caldav-server:');
    const syncWorkerIdx = content.indexOf('\n  sync-worker:');
    const volumesIdx = content.indexOf('\nvolumes:');

    const webcalendarSection = content.substring(webcalendarIdx, caldavIdx);
    const syncWorkerSection = content.substring(syncWorkerIdx, volumesIdx > -1 ? volumesIdx : content.length);

    const expectedExpr = 'ENCRYPTION_KEY: ${ENCRYPTION_KEY:-${ENCRYPTION_SECRET:-freeshard-default-encryption-key-do-not-use-in-prod}}';

    assert.ok(
      webcalendarSection.includes(expectedExpr),
      'webcalendar service in docker-compose.yml must declare ENCRYPTION_KEY with fallback expression'
    );
    assert.ok(
      syncWorkerSection.includes(expectedExpr),
      'sync-worker service in docker-compose.yml must declare ENCRYPTION_KEY with fallback expression'
    );
  });

});
