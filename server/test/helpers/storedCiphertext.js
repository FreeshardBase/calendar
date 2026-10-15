'use strict';

const crypto = require('node:crypto');

// #72: builds a stored value in the at-rest format of server/db.js and sync-worker/sync_worker.py,
// written from the format alone so tests can seed databases without going through db.js:
//   iv         = salt (16 bytes) || nonce (12 bytes), hex
//   ciphertext = AES-256-GCM ciphertext || auth tag (16 bytes), hex
// under the key scrypt(secret, salt, 32, N=16384, r=8, p=1).
function encryptForSecret(secret, plaintext) {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key = crypto.scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: ciphertext.toString('hex'), iv: Buffer.concat([salt, nonce]).toString('hex') };
}

module.exports = { encryptForSecret };
