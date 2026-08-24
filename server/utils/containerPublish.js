'use strict';

/**
 * Container Registry Publishing Utility for FreeShard WebCalendar Suite.
 * (Issue #34 — App-store readiness: publish container images to a registry)
 */

const { execSync } = require('node:child_process');
const path = require('node:path');

const DEFAULT_REGISTRY = 'ghcr.io/freeshardbase';
const DEFAULT_TAG = 'latest';

const SERVICES = [
  { name: 'webcalendar', dir: '.', dockerfile: 'Dockerfile' },
  { name: 'radicale', dir: 'radicale', dockerfile: 'radicale/Dockerfile' },
  { name: 'syncWorker', dir: 'sync-worker', dockerfile: 'sync-worker/Dockerfile', imageSlug: 'sync-worker' }
];

/**
 * Returns full registry image tags for all container services.
 */
function getImageNames(registry = DEFAULT_REGISTRY, tag = DEFAULT_TAG) {
  const reg = (registry || DEFAULT_REGISTRY).replace(/\/+$/, '');
  const t = tag || DEFAULT_TAG;

  return {
    webcalendar: `${reg}/webcalendar:${t}`,
    radicale: `${reg}/radicale:${t}`,
    syncWorker: `${reg}/sync-worker:${t}`
  };
}

/**
 * Validates registry URL and image tag formats.
 */
function validateRegistryConfig(config = {}) {
  const registry = config.registry;
  const tag = config.tag || DEFAULT_TAG;

  if (!registry || typeof registry !== 'string' || registry.trim() === '') {
    return { valid: false, error: 'Registry host/prefix cannot be empty' };
  }

  // Tag must be alphanumeric, dots, hyphens or underscores
  const tagRegex = /^[a-zA-Z0-9_.-]+$/;
  if (!tagRegex.test(tag)) {
    return { valid: false, error: `Invalid tag format: "${tag}"` };
  }

  return { valid: true };
}

/**
 * Generates build and push command objects for container services.
 */
function generateBuildAndPushCommands(registry = DEFAULT_REGISTRY, tag = DEFAULT_TAG) {
  const images = getImageNames(registry, tag);

  return SERVICES.map(service => {
    const serviceName = service.name;
    const imageTag = images[serviceName];
    const buildContext = service.dir;

    return {
      service: serviceName,
      image: imageTag,
      buildCommand: `docker build -t ${imageTag} ${buildContext}`,
      pushCommand: `docker push ${imageTag}`
    };
  });
}

/**
 * Executes or dry-runs build and push operations for container images.
 */
function publishContainerImages(registry = DEFAULT_REGISTRY, tag = DEFAULT_TAG, options = {}) {
  const validation = validateRegistryConfig({ registry, tag });
  if (!validation.valid) {
    throw new Error(`Invalid registry configuration: ${validation.error}`);
  }

  const commands = generateBuildAndPushCommands(registry, tag);
  const dryRun = options.dryRun !== false; // Default to dryRun for safety

  const results = [];
  for (const item of commands) {
    if (dryRun) {
      console.log(`[DRY-RUN] ${item.buildCommand}`);
      console.log(`[DRY-RUN] ${item.pushCommand}`);
      results.push({ service: item.service, image: item.image, status: 'DRY_RUN' });
    } else {
      console.log(`Executing: ${item.buildCommand}`);
      execSync(item.buildCommand, { stdio: 'inherit' });
      console.log(`Executing: ${item.pushCommand}`);
      execSync(item.pushCommand, { stdio: 'inherit' });
      results.push({ service: item.service, image: item.image, status: 'PUBLISHED' });
    }
  }

  return results;
}

module.exports = {
  DEFAULT_REGISTRY,
  DEFAULT_TAG,
  getImageNames,
  validateRegistryConfig,
  generateBuildAndPushCommands,
  publishContainerImages
};
