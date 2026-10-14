'use strict';
process.env.NODE_ENV = 'test';

// Issue #170: loadEvents() serves a cached range only when the delta check
// says no calendar changed. Runs the shipped syncCalendarDelta() and
// calendarsUnchanged() from public/js/app.js against a stubbed delta-sync API.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.resolve(__dirname, '../../public/js/app.js'), 'utf8');
const source = appJs.match(/async function syncCalendarDelta\([\s\S]*?\nasync function calendarsUnchanged\(\)[\s\S]*?\n\}/);

function harness(calendarIds, responses, tokens = {}) {
  assert.ok(source, 'syncCalendarDelta and calendarsUnchanged must exist in app.js');
  const syncCache = new Map(Object.entries(tokens).map(([id, t]) => [id, { ctag: null, syncToken: t }]));
  const calls = [];
  const CalendarsAPI = {
    deltaSync: async (id, syncToken) => {
      calls.push({ id, syncToken });
      const res = responses[id];
      if (res instanceof Error) throw res;
      return res;
    }
  };
  const store = { get: key => (key === 'calendars' ? calendarIds.map(id => ({ id })) : undefined) };
  const run = new Function(
    'store', 'CalendarsAPI', 'getCalendarSyncCache', 'setCalendarSyncCache', 'console',
    `${source[0]}\nreturn calendarsUnchanged();`
  );
  const quiet = { warn: () => {} };
  return {
    calls,
    syncCache,
    run: () => run(
      store, CalendarsAPI,
      id => syncCache.get(id) || null,
      (id, ctag, syncToken) => syncCache.set(id, { ctag, syncToken }),
      quiet
    )
  };
}

const noChange = token => ({ syncToken: token, updated: [], deleted: [], fallbackPerformed: false });

test('every calendar with a token and no change: unchanged, tokens sent and advanced', async () => {
  const h = harness(['a', 'b'], { a: noChange('a2'), b: noChange('b2') }, { a: 'a1', b: 'b1' });
  assert.equal(await h.run(), true);
  assert.deepEqual(h.calls, [{ id: 'a', syncToken: 'a1' }, { id: 'b', syncToken: 'b1' }]);
  assert.equal(h.syncCache.get('a').syncToken, 'a2');
  assert.equal(h.syncCache.get('b').syncToken, 'b2');
});

test('a change in the second calendar only: changed', async () => {
  const h = harness(['a', 'b'], { a: noChange('a2'), b: { ...noChange('b2'), updated: [{ uid: 'x' }] } }, { a: 'a1', b: 'b1' });
  assert.equal(await h.run(), false);
});

test('a deletion: changed', async () => {
  const h = harness(['a'], { a: { ...noChange('a2'), deleted: ['/testuser/a/x.ics'] } }, { a: 'a1' });
  assert.equal(await h.run(), false);
});

test('no prior token (first check primes it): changed, token stored', async () => {
  const h = harness(['a'], { a: noChange('a2') });
  assert.equal(await h.run(), false);
  assert.equal(h.syncCache.get('a').syncToken, 'a2');
});

test('a response without a new token: changed', async () => {
  const h = harness(['a'], { a: noChange(null) }, { a: 'a1' });
  assert.equal(await h.run(), false);
});

test('a fallback to an initial sync: changed', async () => {
  const h = harness(['a'], { a: { ...noChange('a2'), fallbackPerformed: true } }, { a: 'a1' });
  assert.equal(await h.run(), false);
});

test('a failed check: changed', async () => {
  const h = harness(['a'], { a: new Error('HTTP 502') }, { a: 'a1' });
  assert.equal(await h.run(), false);
});

test('no calendars known: changed, nothing to check', async () => {
  const h = harness([], {});
  assert.equal(await h.run(), false);
  assert.equal(h.calls.length, 0);
});
