const test = require('node:test');
const assert = require('node:assert/strict');
const CalDAVClient = require('../caldav/client');

test('Issue #169 — Calendar list PROPFIND does not request unused getctag or sync-token', async (t) => {
  await t.test('getCalendars PROPFIND payload excludes getctag and sync-token to prevent massive server-side recalculation overhead', async () => {
    let capturedBody = null;

    const client = new CalDAVClient({ url: 'http://localhost:9999', username: 'testuser', password: 'testpass' });
    client.propfind = async (url, depth, body) => {
      capturedBody = body;
      return '<multistatus></multistatus>';
    };

    await client.getCalendars();

    assert.ok(capturedBody, 'PROPFIND body should be captured');
    assert.ok(!capturedBody.includes('getctag'), 'PROPFIND body must not request getctag');
    assert.ok(!capturedBody.includes('sync-token'), 'PROPFIND body must not request sync-token');
    assert.ok(capturedBody.includes('resourcetype'), 'PROPFIND body should request resourcetype');
    assert.ok(capturedBody.includes('displayname'), 'PROPFIND body should request displayname');
    assert.ok(capturedBody.includes('supported-calendar-component-set'), 'PROPFIND body should request supported-calendar-component-set');
  });
});
