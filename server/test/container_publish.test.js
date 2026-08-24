'use strict';

/**
 * Issue #34 — App-store readiness: publish container images to a registry
 *
 * Validates container registry publishing readiness:
 *   1. OCI image metadata labels in Dockerfiles (org.opencontainers.image.*).
 *   2. containerPublish utility helper for generating image tags and publish commands.
 *   3. Registry configuration validation and dry-run execution support.
 *   4. docker-compose.yml image tag configuration.
 *   5. package.json script for container image publishing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '../..');
const {
  getImageNames,
  generateBuildAndPushCommands,
  validateRegistryConfig
} = require('../utils/containerPublish');

test.describe('Issue #34 — App-Store Readiness & Container Registry Publishing', () => {

  test('getImageNames returns full registry tags for all three services', () => {
    const images = getImageNames('ghcr.io/freeshardbase', 'v1.0.0');
    assert.equal(images.webcalendar, 'ghcr.io/freeshardbase/webcalendar:v1.0.0');
    assert.equal(images.radicale, 'ghcr.io/freeshardbase/radicale:v1.0.0');
    assert.equal(images.syncWorker, 'ghcr.io/freeshardbase/sync-worker:v1.0.0');
  });

  test('getImageNames uses default registry and latest tag when omitted', () => {
    const images = getImageNames();
    assert.equal(images.webcalendar, 'ghcr.io/freeshardbase/webcalendar:latest');
    assert.equal(images.radicale, 'ghcr.io/freeshardbase/radicale:latest');
    assert.equal(images.syncWorker, 'ghcr.io/freeshardbase/sync-worker:latest');
  });

  test('generateBuildAndPushCommands produces valid build and push command arrays', () => {
    const cmds = generateBuildAndPushCommands('docker.io/freeshard', '1.0.0');
    assert.ok(Array.isArray(cmds), 'Must return an array of command objects');
    assert.equal(cmds.length, 3);

    const webcal = cmds.find(c => c.service === 'webcalendar');
    assert.ok(webcal, 'Must include webcalendar service command');
    assert.equal(webcal.image, 'docker.io/freeshard/webcalendar:1.0.0');
    assert.ok(webcal.buildCommand.includes('docker build'), 'buildCommand must use docker build');
    assert.ok(webcal.pushCommand.includes('docker push docker.io/freeshard/webcalendar:1.0.0'), 'pushCommand must push full tag');
  });

  test('validateRegistryConfig rejects invalid registry or tag formats', () => {
    assert.equal(validateRegistryConfig({ registry: 'ghcr.io/freeshardbase', tag: 'v1.0.0' }).valid, true);
    assert.equal(validateRegistryConfig({ registry: '', tag: 'v1.0.0' }).valid, false);
    assert.equal(validateRegistryConfig({ registry: 'ghcr.io/freeshardbase', tag: 'invalid tag!' }).valid, false);
  });

  test('Dockerfiles contain OCI metadata labels', () => {
    const dockerfiles = [
      path.join(ROOT_DIR, 'Dockerfile'),
      path.join(ROOT_DIR, 'radicale/Dockerfile'),
      path.join(ROOT_DIR, 'sync-worker/Dockerfile')
    ];

    for (const dfPath of dockerfiles) {
      assert.ok(fs.existsSync(dfPath), `${dfPath} must exist`);
      const content = fs.readFileSync(dfPath, 'utf8');
      assert.ok(
        content.includes('org.opencontainers.image.title') || content.includes('LABEL org.opencontainers.image'),
        `${dfPath} must include OCI label metadata`
      );
    }
  });

  test('docker-compose.yml configures registry-ready image references', () => {
    const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
    assert.ok(fs.existsSync(composePath), 'docker-compose.yml must exist');
    const content = fs.readFileSync(composePath, 'utf8');
    assert.ok(content.includes('image: ${REGISTRY:-ghcr.io/freeshardbase}/webcalendar'), 'docker-compose.yml webcalendar image must support REGISTRY env');
    assert.ok(content.includes('image: ${REGISTRY:-ghcr.io/freeshardbase}/radicale'), 'docker-compose.yml radicale image must support REGISTRY env');
    assert.ok(content.includes('image: ${REGISTRY:-ghcr.io/freeshardbase}/sync-worker'), 'docker-compose.yml sync-worker image must support REGISTRY env');
  });

  test('package.json includes publish:containers script', () => {
    const pkgPath = path.join(ROOT_DIR, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.ok(pkg.scripts['publish:containers'], 'package.json must contain "publish:containers" script');
  });

});
