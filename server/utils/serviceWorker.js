'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION_PLACEHOLDER = '__ASSET_VERSION__';

// Every file under `dir`, as paths relative to it, in a fixed order.
function listFiles(dir, prefix = '') {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = path.join(prefix, entry.name);
      return entry.isDirectory() ? listFiles(dir, rel) : [rel];
    });
}

/**
 * The service worker script for the files in `publicDir` (#571). Its cache name carries a hash of
 * all those files, so every deploy that changes one ships a byte-different sw.js: the browser
 * installs it as a new worker, whose `activate` drops the previous version's cache.
 *
 * @param {string} publicDir Directory served as the app shell, containing sw.js
 * @returns {{ version: string, source: string }}
 */
function buildServiceWorker(publicDir) {
  const template = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
  if (!template.includes(VERSION_PLACEHOLDER)) {
    throw new Error(`public/sw.js lacks the ${VERSION_PLACEHOLDER} placeholder for its cache name`);
  }
  const hash = crypto.createHash('sha256');
  for (const rel of listFiles(publicDir)) {
    hash.update(rel).update('\0').update(fs.readFileSync(path.join(publicDir, rel))).update('\0');
  }
  const version = hash.digest('hex').slice(0, 16);
  return { version, source: template.split(VERSION_PLACEHOLDER).join(version) };
}

module.exports = { buildServiceWorker };
