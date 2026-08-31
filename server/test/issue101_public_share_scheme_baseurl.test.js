const test = require('node:test');
const assert = require('node:assert');
const { getBaseUrl, getPublicShareUrl } = require('../utils/baseUrl');

test('Issue #101 — getBaseUrl unit tests', async (t) => {
  const origBaseUrl = process.env.BASE_URL;

  t.afterEach(() => {
    if (origBaseUrl !== undefined) {
      process.env.BASE_URL = origBaseUrl;
    } else {
      delete process.env.BASE_URL;
    }
  });

  await t.test('uses process.env.BASE_URL when set (stripping trailing slashes)', () => {
    process.env.BASE_URL = 'https://calendar.example.com/';
    const mockReq = {
      protocol: 'http',
      get: (h) => (h === 'host' ? 'localhost:3000' : null)
    };
    assert.strictEqual(getBaseUrl(mockReq), 'https://calendar.example.com');
    assert.strictEqual(
      getPublicShareUrl(mockReq, 'abc123token'),
      'https://calendar.example.com/api/public/calendars/share/abc123token.ics'
    );
  });

  await t.test('supports subpath in process.env.BASE_URL', () => {
    process.env.BASE_URL = 'https://portal.de/webcalendar/';
    const mockReq = {
      protocol: 'http',
      get: (h) => (h === 'host' ? 'localhost:3000' : null)
    };
    assert.strictEqual(getBaseUrl(mockReq), 'https://portal.de/webcalendar');
    assert.strictEqual(
      getPublicShareUrl(mockReq, 'tokenXYZ'),
      'https://portal.de/webcalendar/api/public/calendars/share/tokenXYZ.ics'
    );
  });

  await t.test('respects X-Forwarded-Proto and X-Forwarded-Host when BASE_URL is unset', () => {
    delete process.env.BASE_URL;
    const mockReq = {
      protocol: 'http',
      get: (header) => {
        const h = header.toLowerCase();
        if (h === 'x-forwarded-proto') return 'https, http';
        if (h === 'x-forwarded-host') return 'calendar.shard.internal:8443';
        if (h === 'host') return '127.0.0.1:3000';
        return null;
      }
    };

    assert.strictEqual(getBaseUrl(mockReq), 'https://calendar.shard.internal:8443');
    assert.strictEqual(
      getPublicShareUrl(mockReq, 'mytoken'),
      'https://calendar.shard.internal:8443/api/public/calendars/share/mytoken.ics'
    );
  });

  await t.test('falls back to req.protocol and req.get("host") when no proxy headers or BASE_URL are set', () => {
    delete process.env.BASE_URL;
    const mockReq = {
      protocol: 'http',
      get: (header) => {
        const h = header.toLowerCase();
        if (h === 'host') return 'localhost:3000';
        return null;
      }
    };

    assert.strictEqual(getBaseUrl(mockReq), 'http://localhost:3000');
    assert.strictEqual(
      getPublicShareUrl(mockReq, 'sampletoken'),
      'http://localhost:3000/api/public/calendars/share/sampletoken.ics'
    );
  });
});
