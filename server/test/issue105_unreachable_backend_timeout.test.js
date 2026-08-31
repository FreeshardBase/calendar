'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const CalDAVClient = require('../caldav/client');

test('Issue #105 — Unreachable CalDAV backend fast fail and timeout guard', async (t) => {

  await t.test('CalDAVClient._request throws immediately on ECONNREFUSED without 12-second retries', async () => {
    const client = new CalDAVClient({ url: 'http://127.0.0.1:59998/unreachable-caldav/', username: 'testuser', password: 'testpassword' });
    const startTime = Date.now();

    try {
      await client._request('GET', 'http://127.0.0.1:59998/unreachable-caldav/');
      assert.fail('Should have thrown an error');
    } catch (err) {
      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 2000, `Request took ${elapsed}ms; should fail fast under 2000ms instead of 12000ms`);
      assert.ok(
        err.message.includes('fetch failed') || err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED',
        `Error should indicate connection failure, got: ${err.message}`
      );
    }
  });

  await t.test('CalDAVClient._request respects custom timeout option and fails fast on timeout', async () => {
    const client = new CalDAVClient({ url: 'http://127.0.0.1:59998/unreachable-caldav/', username: 'testuser', password: 'testpassword' });
    const startTime = Date.now();

    try {
      await client._request('GET', 'http://127.0.0.1:59998/unreachable-caldav/', { timeout: 300 });
      assert.fail('Should have thrown an error');
    } catch (err) {
      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 2000, `Request with custom timeout took ${elapsed}ms; should fail under 2000ms`);
    }
  });

  await t.test('CalDAVClient._request defaults to 4000ms timeout on non-responsive host instead of 12000ms (3 retries x 4s)', async () => {
    const client = new CalDAVClient({ url: 'http://192.0.2.1:59998/unreachable-caldav/', username: 'testuser', password: 'testpassword' });
    const startTime = Date.now();

    try {
      await client._request('GET', 'http://192.0.2.1:59998/unreachable-caldav/', { timeout: 500 });
      assert.fail('Should have thrown an error');
    } catch (err) {
      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 2000, `Hanging host took ${elapsed}ms; should fail fast under 2000ms instead of 12000ms`);
    }
  });
});
