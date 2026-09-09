'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

test('Issue #199 — Validated PKCS#7 unpadding in sync worker decrypt', async (t) => {
  const repoRoot = path.join(__dirname, '../..');

  await t.test('encrypt and decrypt roundtrip works for valid strings', () => {
    const pyScript = `
import sys, os
sys.path.append(os.path.abspath('sync-worker'))
import sync_worker

key = sync_worker.KEY_BYTES
secret = "MySecretPass123!"
enc_hex, iv_hex = sync_worker.encrypt(secret, key)
decrypted = sync_worker.decrypt(enc_hex, iv_hex, key)
assert decrypted == secret, f"Expected {secret}, got {decrypted}"
print("ROUNDTRIP_SUCCESS")
`;
    const output = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
      cwd: repoRoot,
      encoding: 'utf-8'
    });
    assert.ok(output.includes('ROUNDTRIP_SUCCESS'));
  });

  await t.test('decrypt raises ValueError when padding length is 0 (last byte 0x00)', () => {
    const pyScript = `
import sys, os
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

sys.path.append(os.path.abspath('sync-worker'))
import sync_worker

key = sync_worker.KEY_BYTES
iv = os.urandom(16)
cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
encryptor = cipher.encryptor()

# Craft ciphertext whose last byte after decryption is 0x00
block = b"123456789012345\\x00"
enc_bytes = encryptor.update(block) + encryptor.finalize()

try:
    result = sync_worker.decrypt(enc_bytes.hex(), iv.hex(), key)
    print(f"FAIL_EXPECTED_EXCEPTION_GOT_{repr(result)}")
except ValueError as ve:
    print(f"PASS_VALUE_ERROR: {ve}")
except Exception as e:
    print(f"GOT_OTHER_EXCEPTION: {type(e).__name__} {e}")
`;
    const output = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
      cwd: repoRoot,
      encoding: 'utf-8'
    });
    assert.ok(output.includes('PASS_VALUE_ERROR'), `Expected ValueError, got output:\n${output}`);
  });

  await t.test('decrypt raises ValueError when padding length is > 16 (e.g. 17 or 255)', () => {
    const pyScript = `
import sys, os
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

sys.path.append(os.path.abspath('sync-worker'))
import sync_worker

key = sync_worker.KEY_BYTES
iv = os.urandom(16)
cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
encryptor = cipher.encryptor()

# Craft ciphertext whose last byte is 0x11 (17 > 16)
block = b"123456789012345\\x11"
enc_bytes = encryptor.update(block) + encryptor.finalize()

try:
    result = sync_worker.decrypt(enc_bytes.hex(), iv.hex(), key)
    print(f"FAIL_EXPECTED_EXCEPTION_GOT_{repr(result)}")
except ValueError as ve:
    print(f"PASS_VALUE_ERROR: {ve}")
`;
    const output = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
      cwd: repoRoot,
      encoding: 'utf-8'
    });
    assert.ok(output.includes('PASS_VALUE_ERROR'), `Expected ValueError, got output:\n${output}`);
  });

  await t.test('decrypt raises ValueError when padding bytes are inconsistent with padding length', () => {
    const pyScript = `
import sys, os
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

sys.path.append(os.path.abspath('sync-worker'))
import sync_worker

key = sync_worker.KEY_BYTES
iv = os.urandom(16)
cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
encryptor = cipher.encryptor()

# Craft ciphertext whose last byte is 0x03, but preceding padding byte is 0x02 instead of 0x03
block = b"1234567890123\\x02\\x03\\x03"
enc_bytes = encryptor.update(block) + encryptor.finalize()

try:
    result = sync_worker.decrypt(enc_bytes.hex(), iv.hex(), key)
    print(f"FAIL_EXPECTED_EXCEPTION_GOT_{repr(result)}")
except ValueError as ve:
    print(f"PASS_VALUE_ERROR: {ve}")
`;
    const output = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
      cwd: repoRoot,
      encoding: 'utf-8'
    });
    assert.ok(output.includes('PASS_VALUE_ERROR'), `Expected ValueError, got output:\n${output}`);
  });
});
