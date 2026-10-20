'use strict';

// Issue #628 (#160): every error the server answers carries a code (and its parameters), so the UI
// shows it in the user's language instead of the server's text.

const { test } = require('node:test');
const assert = require('node:assert');
const { describeError, sendError, userError, codeForStatus, ERROR_CODES, ensureErrorCode } = require('../utils/errorSanitizer');

function fakeRes() {
  const res = { statusCode: 200, body: null, req: { method: 'GET', originalUrl: '/api/x' } };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}

test('#628: describeError names the code of a mapped error', () => {
  assert.strictEqual(describeError(new Error('ETAG_CONFLICT')).code, 'CONFLICT');
  assert.strictEqual(describeError(new Error('PROPFIND 403: Forbidden')).code, 'FORBIDDEN');
  assert.strictEqual(describeError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).code, 'CONNECTION');
  assert.strictEqual(describeError(new Error('something unexpected')).code, 'GENERIC');
});

test('#628: a user error carries its code and parameters', () => {
  const err = userError('INVALID_PREFERENCE', 400, { name: 'weekStart' });
  const described = describeError(err);
  assert.deepStrictEqual([described.status, described.code, described.params], [400, 'INVALID_PREFERENCE', { name: 'weekStart' }]);
  assert.match(described.message, /weekStart/);
  assert.throws(() => userError('NO_SUCH_CODE', 400), /Unknown error code/);
});

test('#628: sendError answers the code and parameters next to the message', () => {
  const res = fakeRes();
  const origError = console.error;
  console.error = () => {};
  try {
    sendError(res, userError('INVALID_PREFERENCE', 400, { name: 'timeZone' }));
  } finally {
    console.error = origError;
  }
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, 'INVALID_PREFERENCE');
  assert.deepStrictEqual(res.body.params, { name: 'timeZone' });
});

test('#628: an error answered without a code gets the code of its status', () => {
  assert.strictEqual(codeForStatus(400), 'BAD_REQUEST');
  assert.strictEqual(codeForStatus(401), 'UNAUTHENTICATED');
  assert.strictEqual(codeForStatus(403), 'ACCESS_DENIED');
  assert.strictEqual(codeForStatus(404), 'RESOURCE_NOT_FOUND');
  assert.strictEqual(codeForStatus(409), 'REQUEST_CONFLICT');
  assert.strictEqual(codeForStatus(413), 'REQUEST_TOO_LARGE');
  assert.strictEqual(codeForStatus(429), 'RATE_LIMITED');
  assert.strictEqual(codeForStatus(422), 'BAD_REQUEST');
  assert.strictEqual(codeForStatus(503), 'GENERIC');
  assert.deepStrictEqual(ensureErrorCode(404, { error: 'Account not found' }), { error: 'Account not found', code: 'RESOURCE_NOT_FOUND' });
  // A body that already names its code, or a success, is left alone.
  const coded = { error: 'x', code: 'INVALID_CONFERENCE_URL' };
  assert.strictEqual(ensureErrorCode(400, coded), coded);
  const ok = { error: null, items: [] };
  assert.strictEqual(ensureErrorCode(200, ok), ok);
});

test('#628: every code has a German server message', () => {
  for (const code of ERROR_CODES) {
    assert.strictEqual(typeof describeError(userError(code, 400, { name: 'n', detail: 'd', weekday: 1, min: 0, max: 9 })).message, 'string', code);
  }
  for (const status of [400, 401, 403, 404, 409, 413, 429, 500]) assert.ok(ERROR_CODES.includes(codeForStatus(status)));
});
