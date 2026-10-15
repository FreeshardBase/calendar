'use strict';

// #144: in AUTH_METHOD=oidc the OIDC `sub` is the storage identity. It becomes the Radicale
// collection root (/<sub>/) and the owner segment of every internal calendar id, so it must be
// a single path segment that Radicale and URL resolution leave unchanged. Anything else is
// refused, never rewritten: a rewritten sub could collide with another member's collections.
const SAFE_STORAGE_ID = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,254}$/;

function isSafeStorageId(id) {
  return typeof id === 'string' && SAFE_STORAGE_ID.test(id);
}

module.exports = { isSafeStorageId };
