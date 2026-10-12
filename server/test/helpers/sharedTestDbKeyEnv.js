'use strict';

const os = require('node:os');
const path = require('node:path');

// Environment for Python sync-worker children started by tests.
// server/db.js encrypts the shared test database with its fixture key (NODE_ENV=test,
// default test DB path). Since #333 the worker refuses to mint a key next to existing
// ciphertexts, so the child is given that key explicitly, and its key file is kept out
// of the repository root (a key file there would override the fixture key for every
// later test process).
module.exports = {
  ENCRYPTION_KEY: 'freeshard-default-encryption-key-do-not-use-in-prod',
  ENCRYPTION_KEY_FILE: path.join(os.tmpdir(), `webcalendar-test-${process.pid}.encryption_key`),
};
