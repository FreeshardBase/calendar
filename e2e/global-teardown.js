'use strict';

const fs = require('fs');
const path = require('path');
const { Agent } = require('undici');

/**
 * Issue #217: drops everything one e2e run created — the run's CalDAV principal on Radicale
 * (every collection and event under /<username>/) and the run's database directory.
 * Fails loudly when Radicale refuses, so leaked fixtures are never silent.
 */
async function removeRunFixtures({ caldavUrl, username, secret, databasePath }) {
  if (!caldavUrl || !username || !secret || !databasePath) {
    throw new Error('removeRunFixtures needs caldavUrl, username, secret and databasePath');
  }
  if (!/^e2e-[a-z0-9-]+$/.test(username)) {
    throw new Error(`refusing to delete CalDAV principal "${username}": not an e2e fixture user`);
  }
  const principalUrl = `${caldavUrl.replace(/\/+$/, '')}/${encodeURIComponent(username)}/`;
  // Scoped to this one request: the internal Radicale certificate is self-signed.
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  try {
    const res = await fetch(principalUrl, {
      method: 'DELETE',
      dispatcher,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${username}:${secret}`).toString('base64'),
        'Accept-Encoding': 'identity',
      },
    });
    // 404: the run never touched Radicale, so there is nothing to remove.
    if (!res.ok && res.status !== 404) {
      throw new Error(`DELETE ${principalUrl} failed: ${res.status} ${await res.text()}`);
    }
  } finally {
    await dispatcher.close();
  }
  fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
}

async function globalTeardown() {
  const { webServer } = require('../playwright.config.js');
  await removeRunFixtures({
    caldavUrl: webServer.env.INTERNAL_CALDAV_URL,
    username: webServer.env.CALDAV_USERNAME,
    secret: webServer.env.SYSTEM_SYNC_SECRET,
    databasePath: webServer.env.DATABASE_PATH,
  });
}

module.exports = globalTeardown;
module.exports.removeRunFixtures = removeRunFixtures;
