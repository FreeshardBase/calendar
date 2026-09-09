'use strict';

const test = require('node:test');
const assert = require('node:assert');
const CalDAVClient = require('../caldav/client');

test('Issue #235 — Outbound CalDAV XML Interpolation Escaping in updateCalendarShares', async (t) => {
  await t.test('escapes XML special characters in owncloud share set and remove', async () => {
    let capturedBody = null;
    const client = new CalDAVClient({ url: 'http://localhost:5232', username: 'user1', password: 'pass1' });

    client._detectSharingType = async () => 'owncloud';
    client.resolveNextcloudPrincipal = async (href) => `principal:principals/users/${href}`;
    client._request = async (method, url, opts) => {
      capturedBody = opts.body;
      return { ok: true, status: 200 };
    };

    const unsafeHref = 'user&<name>\'1"@example.com';

    // Test ownCloud set (add/update share)
    await client.updateCalendarShares('http://localhost:5232/cal/', { href: unsafeHref, readWrite: true, remove: false });
    assert.ok(capturedBody, 'request body must be captured');
    assert.ok(capturedBody.includes('<d:href>principal:principals/users/user&amp;&lt;name&gt;&apos;1&quot;@example.com</d:href>'),
      'ownCloud share set must escape XML special characters in href');
    assert.ok(!capturedBody.includes('user&<name>'), 'ownCloud share set must not contain raw unescaped XML');

    // Test ownCloud remove
    await client.updateCalendarShares('http://localhost:5232/cal/', { href: unsafeHref, remove: true });
    assert.ok(capturedBody.includes('<d:href>principal:principals/users/user&amp;&lt;name&gt;&apos;1&quot;@example.com</d:href>'),
      'ownCloud share remove must escape XML special characters in href');
  });

  await t.test('escapes XML special characters in standard CalDAV share set and remove', async () => {
    let capturedBody = null;
    const client = new CalDAVClient({ url: 'http://localhost:5232', username: 'user1', password: 'pass1' });

    client._detectSharingType = async () => 'standard';
    client._request = async (method, url, opts) => {
      capturedBody = opts.body;
      return { ok: true, status: 200 };
    };

    const unsafeHref = 'mailto:user&<name>\'1"@example.com';

    // Test standard CalDAV set
    await client.updateCalendarShares('http://localhost:5232/cal/', { href: unsafeHref, readWrite: false, remove: false });
    assert.ok(capturedBody, 'request body must be captured');
    assert.ok(capturedBody.includes('<d:href>mailto:user&amp;&lt;name&gt;&apos;1&quot;@example.com</d:href>'),
      'standard share set must escape XML special characters in href');

    // Test standard CalDAV remove
    await client.updateCalendarShares('http://localhost:5232/cal/', { href: unsafeHref, remove: true });
    assert.ok(capturedBody.includes('<d:href>mailto:user&amp;&lt;name&gt;&apos;1&quot;@example.com</d:href>'),
      'standard share remove must escape XML special characters in href');
  });
});
