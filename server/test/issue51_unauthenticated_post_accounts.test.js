const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.PREVENT_AUTO_LISTEN = 'true';

const { app } = require('../index');
const http = require('http');

test('Issue #51: unauthenticated POST /api/accounts must return 401', async (t) => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));

  t.after(() => {
    server.close();
  });
  
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  const res = await fetch(`${baseUrl}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://example.com/caldav', username: 'victim-uuid-0001', password: 'password' })
  });
  assert.strictEqual(res.status, 401, 'Expected 401 Unauthorized for unauthenticated POST /api/accounts');
});
