'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getPresets, resolvePreset, resolveCalDAVUrl } = require('../utils/caldavPresets');

// Issue #353: the provider tiles of the first run (iCloud, Fastmail) need no typed server URL.
test('Issue #353 — iCloud and Fastmail are presets with a fixed CalDAV server', () => {
  const byId = Object.fromEntries(getPresets().map(p => [p.id, p]));
  assert.equal(byId.icloud.url, 'https://caldav.icloud.com/');
  assert.equal(byId.fastmail.url, 'https://caldav.fastmail.com/dav/');

  for (const address of ['testuser@icloud.com', 'testuser@me.com', 'testuser@mac.com']) {
    assert.equal(resolvePreset(address).id, 'icloud', address);
  }
  assert.equal(resolvePreset('testuser@fastmail.com').id, 'fastmail');
  assert.equal(resolveCalDAVUrl('icloud'), 'https://caldav.icloud.com/');
  assert.equal(resolvePreset('testuser@example.com'), null);
});
