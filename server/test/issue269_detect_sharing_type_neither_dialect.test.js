'use strict';

const test = require('node:test');
const assert = require('node:assert');
const CalDAVClient = require('../caldav/client');

const NS = 'xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:o="http://owncloud.org/ns"';

function singlePropstat(prop, status) {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus ${NS}>
  <d:response>
    <d:href>/cal/</d:href>
    <d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
}

// RFC 4918 §9.1: a server that has one of the two requested properties answers
// with two propstats — the supported one under 200, the other under 404.
function splitPropstat(foundProp, missingProp) {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus ${NS}>
  <d:response>
    <d:href>/cal/</d:href>
    <d:propstat><d:prop>${foundProp}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    <d:propstat><d:prop>${missingProp}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
  </d:response>
</d:multistatus>`;
}

const OC_INVITE_WITH_SHARE = `<o:invite><o:user>
  <d:href>principal:principals/users/testuser</d:href>
  <o:common-name>Test User</o:common-name>
  <o:invite-accepted/>
  <o:access><o:read-write/></o:access>
</o:user></o:invite>`;

const CS_INVITE_WITH_SHARE = `<cs:invite><cs:user>
  <d:href>mailto:testuser@example.com</d:href>
  <cs:common-name>Test User</cs:common-name>
  <cs:invite-accepted/>
  <cs:access><cs:read-write/></cs:access>
</cs:user></cs:invite>`;

function stubbed(body) {
  const client = new CalDAVClient({ url: 'http://localhost:5232', username: 'testuser', password: 'pass' });
  const requests = [];
  client._request = async (method, url) => {
    requests.push(method);
    if (method === 'PROPFIND') return { ok: true, status: 207, text: async () => body };
    return { ok: true, status: 200, text: async () => '' };
  };
  client.searchUsers = async () => [];
  return { client, requests };
}

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
      text: async () => singlePropstat('<o:invite/>', '200 OK')
    });

    const type = await client._detectSharingType('http://localhost:5232/cal/owncloud/');
    assert.strictEqual(type, 'owncloud');
  });

  await t.test('detects "standard" when calendarserver invite property is present without 404', async () => {
    const client = new CalDAVClient({ url: 'http://localhost:5232', username: 'testuser', password: 'pass' });
    
    client._request = async () => ({
      ok: true,
      status: 207,
      text: async () => singlePropstat('<cs:invite><cs:user/></cs:invite>', '200 OK')
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
  await t.test('detects "owncloud" from a two-propstat body (o:invite 200, cs:invite 404) and sends the share POST', async () => {
    const { client, requests } = stubbed(splitPropstat(OC_INVITE_WITH_SHARE, '<cs:invite/>'));
    assert.strictEqual(await client._detectSharingType('http://localhost:5232/cal/'), 'owncloud');
    await client.updateCalendarShares('http://localhost:5232/cal/', { href: 'testuser', readWrite: true });
    assert.ok(requests.includes('POST'), 'ownCloud share POST must be sent');
  });

  await t.test('detects "standard" from a two-propstat body (cs:invite 200, o:invite 404)', async () => {
    const { client } = stubbed(splitPropstat(CS_INVITE_WITH_SHARE, '<o:invite/>'));
    assert.strictEqual(await client._detectSharingType('http://localhost:5232/cal/'), 'standard');
  });

  await t.test('getCalendarShares classifies a two-propstat body the same way and lists the share', async () => {
    const oc = stubbed(splitPropstat(OC_INVITE_WITH_SHARE, '<cs:invite/>')).client;
    const ocShares = await oc.getCalendarShares('http://localhost:5232/cal/');
    assert.strictEqual(oc._sharingTypes['http://localhost:5232/cal/'], 'owncloud');
    assert.strictEqual(ocShares.length, 1);

    const cs = stubbed(splitPropstat(CS_INVITE_WITH_SHARE, '<o:invite/>')).client;
    const csShares = await cs.getCalendarShares('http://localhost:5232/cal/');
    assert.strictEqual(cs._sharingTypes['http://localhost:5232/cal/'], 'standard');
    assert.deepStrictEqual(csShares.map(s => s.href), ['testuser@example.com']);
  });

  await t.test('a bare ownCloud namespace declaration on a 404 propstat is not ownCloud support', async () => {
    const { client } = stubbed(singlePropstat('<cs:invite/><o:invite/>', '404 Not Found'));
    assert.strictEqual(await client._detectSharingType('http://localhost:5232/cal/'), 'none');
  });

  await t.test('getCalendarShares lists no shares from a 404 propstat even if it carries user elements', async () => {
    const { client } = stubbed(singlePropstat(CS_INVITE_WITH_SHARE, '404 Not Found'));
    assert.deepStrictEqual(await client.getCalendarShares('http://localhost:5232/cal/'), []);
    assert.strictEqual(client._sharingTypes['http://localhost:5232/cal/'], 'none');
  });

  await t.test('_detectSharingType fails loudly on a 5xx instead of caching "none"', async () => {
    const client = new CalDAVClient({ url: 'http://localhost:5232', username: 'testuser', password: 'pass' });
    client._request = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' });
    await assert.rejects(() => client._detectSharingType('http://localhost:5232/cal/'), (err) => err.status === 503);
    assert.strictEqual((client._sharingTypes || {})['http://localhost:5232/cal/'], undefined, 'must cache nothing');
  });
});
