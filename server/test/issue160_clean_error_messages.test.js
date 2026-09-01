'use strict';
process.env.NODE_ENV = 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const CalDAVClient = require('../caldav/client');
const { sanitizeErrorMessage } = require('../utils/errorSanitizer');

describe('Issue #160 — Clean Error Messages Below Account Setup', () => {
  test('sanitizeErrorMessage strips HTML/XML bodies and protocol jargon', () => {
    const rawHtmlError = 'PROPFIND 500: Internal Server Error — <html><body><h1>500 Error</h1></body></html>';
    const sanitized = sanitizeErrorMessage(rawHtmlError);
    assert.strictEqual(sanitized.includes('<html>'), false, 'Sanitized error must not contain HTML tags');
    assert.strictEqual(sanitized.includes('PROPFIND 500:'), false, 'Sanitized error must not contain raw protocol jargon');
    assert.ok(sanitized.length > 0, 'Sanitized error must not be empty');
  });

  test('sanitizeErrorMessage handles XML response bodies cleanly', () => {
    const rawXmlError = 'MKCALENDAR 500: <?xml version="1.0"?><error><description>Failed</description></error>';
    const sanitized = sanitizeErrorMessage(rawXmlError);
    assert.strictEqual(sanitized.includes('<?xml'), false, 'Sanitized error must not contain XML declarations');
    assert.strictEqual(sanitized.includes('MKCALENDAR 500:'), false, 'Sanitized error must not contain raw protocol jargon');
  });

  test('CalDAVClient propfind throws clean error without raw body slice on 500 HTML response', async () => {
    const client = new CalDAVClient({ url: 'http://127.0.0.1:59999', username: 'testuser', password: 'testpassword' });
    
    // Mock _request to return 500 with HTML body
    client._request = async () => ({
      status: 500,
      statusText: 'Internal Server Error',
      ok: false,
      text: async () => '<html><body><h1>500 Internal Server Error</h1></body></html>'
    });

    try {
      await client.propfind('http://127.0.0.1:59999/cal/', 0, '');
      assert.fail('propfind should have thrown');
    } catch (err) {
      assert.strictEqual(err.message.includes('<html>'), false, 'Error message must not include raw HTML response body');
      assert.strictEqual(err.message.includes('500 Error'), false, 'Error message must not include raw HTML content');
    }
  });

  test('CalDAVClient report throws clean error without raw body slice on 500 HTML response', async () => {
    const client = new CalDAVClient({ url: 'http://127.0.0.1:59999', username: 'testuser', password: 'testpassword' });
    
    client._request = async () => ({
      status: 500,
      statusText: 'Internal Server Error',
      ok: false,
      text: async () => '<?xml version="1.0"?><d:error>Server Error</d:error>'
    });

    try {
      await client.report('http://127.0.0.1:59999/cal/', '');
      assert.fail('report should have thrown');
    } catch (err) {
      assert.strictEqual(err.message.includes('<?xml'), false, 'Error message must not include raw XML response body');
    }
  });
});
