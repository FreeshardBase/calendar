'use strict';

const test = require('node:test');
const assert = require('node:assert');
const CalDAVClient = require('../caldav/client');

test('Issue #269 — _detectSharingType handles servers supporting neither sharing dialect', async (t) => {
  await t.test('detects "none" when PROPFIND returns 207 with 404 Not Found for invite properties', async () => {
    const client = new CalDAVClient({ url: 'http://localhost:5232', username: 'testuser', password: 'pass' });
    
    const propfind404Body = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:o="http://owncloud.org/ns">
  <d:response>
    <d:href>/cal/</d:href>
    <d:propstat>
      <d:prop>
        <cs:invite/>
        <o:invite/>
      </d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    client._request = async () => ({
      ok: true,
      status: 207,
      text: async () => propfind404Body
    });

    const type = await client._detectSharingType('http://localhost:5232/cal/');
    assert.strictEqual(type, 'none', 'must return "none" when neither sharing dialect is supported');
    assert.strictEqual(client._sharingTypes['http://localhost:5232/cal/'], 'none', 'must cache "none"');
  });

  await t.test('detects "none" when PROPFIND returns non-207/ok error status (e.g. 405 Method Not Allowed)', async () => {
    const client = new CalDAVClient({ url: 'http://localhost:5232', username: 'testuser', password: 'pass' });
    
    client._request = async () => ({
      ok: false,
      status: 405,
      text: async () => 'Method Not Allowed'
    });

    const type = await client._detectSharingType('http://localhost:5232/cal/');
    assert.strictEqual(type, 'none', 'must return "none" on HTTP error status');
    assert.strictEqual(client._sharingTypes['http://localhost:5232/cal/'], 'none', 'must cache "none"');
  });

  await t.test('detects "owncloud" when owncloud invite property is present', async () => {
    const client = new CalDAVClient({ url: 'http://localhost:5232', username: 'testuser', password: 'pass' });
    
    client._request = async () => ({
      ok: true,
      status: 207,
      text: async () => '<d:multistatus xmlns:d="DAV:" xmlns:o="http://owncloud.org/ns"><o:invite/></d:multistatus>'
    });

    const type = await client._detectSharingType('http://localhost:5232/cal/owncloud/');
    assert.strictEqual(type, 'owncloud');
  });

  await t.test('detects "standard" when calendarserver invite property is present without 404', async () => {
    const client = new CalDAVClient({ url: 'http://localhost:5232', username: 'testuser', password: 'pass' });
    
    client._request = async () => ({
      ok: true,
      status: 207,
      text: async () => '<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><cs:invite><cs:user/></cs:invite></d:multistatus>'
    });

    const type = await client._detectSharingType('http://localhost:5232/cal/standard/');
    assert.strictEqual(type, 'standard');
  });

  await t.test('updateCalendarShares throws 501 Not Implemented error when sharing type is "none"', async () => {
    const client = new CalDAVClient({ url: 'http://localhost:5232', username: 'testuser', password: 'pass' });
    client._detectSharingType = async () => 'none';

    await assert.rejects(
      async () => {
        await client.updateCalendarShares('http://localhost:5232/cal/', { href: 'sharee@example.com', readWrite: true });
      },
      (err) => {
        assert.strictEqual(err.status, 501, 'err.status must be 501');
        assert.ok(err.message.includes('not supported') || err.message.includes('Sharing is not supported'),
          'error message must state sharing is not supported');
        return true;
      }
    );
  });

  await t.test('getCalendarShares caches "none" and returns empty array when server returns 404 or unsupported', async () => {
    const client = new CalDAVClient({ url: 'http://localhost:5232', username: 'testuser', password: 'pass' });
    client._request = async () => ({
      ok: false,
      status: 404,
      text: async () => 'Not Found'
    });

    const shares = await client.getCalendarShares('http://localhost:5232/cal/');
    assert.deepStrictEqual(shares, [], 'getCalendarShares must return empty array when sharing unsupported');
    assert.strictEqual(client._sharingTypes['http://localhost:5232/cal/'], 'none', 'must cache "none" in _sharingTypes');
  });
});
