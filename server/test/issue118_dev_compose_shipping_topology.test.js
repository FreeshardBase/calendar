'use strict';

/**
 * Issue #118 — Dev Compose & Shipping Topology Alignment
 *
 * Validates that docker-compose.yml and documentation match the shipping topology:
 *   1. caldav-server service does NOT expose host ports (e.g. 5232:5232), keeping Radicale unexposed on the host.
 *   2. webcalendar and sync-worker services reference internal container URL http://caldav-server:5232
 *      (plain HTTP on the private network, as on a shard).
 * The other topology axes are checked in server/test/python/test_issue118_dev_compose_shipping_topology.py.
 *   3. README.md accurately reflects that caldav-server is an unexposed backend service on the container network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');

test.describe('Issue #118 — Dev Compose & Shipping Topology Alignment', () => {

  test('docker-compose.yml does not expose caldav-server ports to the host', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml must exist');
    const content = fs.readFileSync(composePath, 'utf8');

    const caldavStartIndex = content.indexOf('caldav-server:');
    assert.ok(caldavStartIndex > -1, 'caldav-server service must be defined in docker-compose.yml');

    const syncWorkerIndex = content.indexOf('sync-worker:');
    const caldavSection = content.substring(
      caldavStartIndex,
      syncWorkerIndex > -1 ? syncWorkerIndex : content.length
    );

    assert.ok(
      !caldavSection.includes('ports:'),
      'caldav-server must NOT expose host ports in docker-compose.yml (must remain unexposed on host)'
    );
    assert.ok(
      !caldavSection.includes('5232:5232'),
      'caldav-server must NOT publish port 5232 to host'
    );
  });

  test('docker-compose.yml configures internal container URL for webcalendar and sync-worker', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    const content = fs.readFileSync(composePath, 'utf8');

    assert.ok(
      content.includes('INTERNAL_CALDAV_URL: http://caldav-server:5232'),
      'webcalendar service must configure INTERNAL_CALDAV_URL pointing to http://caldav-server:5232'
    );
    assert.ok(
      content.includes('LOCAL_CALDAV_URL: http://caldav-server:5232'),
      'sync-worker service must configure LOCAL_CALDAV_URL pointing to http://caldav-server:5232'
    );
  });

  test('README.md documents caldav-server as unexposed backend on container network', () => {
    const readmePath = path.join(ROOT_DIR, 'README.md');
    assert.ok(fs.existsSync(readmePath), 'README.md must exist');
    const content = fs.readFileSync(readmePath, 'utf8');

    assert.ok(
      !content.includes('Radicale on :5232'),
      'README.md quick start must NOT state Radicale is exposed on host :5232'
    );
    assert.ok(
      content.includes('unexposed backend container within the private container network') ||
      content.includes('unexposed backend container') ||
      content.includes('unexposed on the internal container network'),
      'README.md must document Radicale as unexposed backend'
    );
  });

});
