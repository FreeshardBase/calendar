'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3514';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

// Issue #514: public holidays are a built-in, read-only subscription. The user picks a country and
// region in the settings; the holidays are computed on the shard, no third-party request.

const test = require('node:test');
const assert = require('assert');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');
const { holidaysInRange, HOLIDAY_COUNTRIES } = require('../utils/holidays');

const baseUrl = `http://localhost:${process.env.PORT}`;

const dates = (region, from, to) => holidaysInRange(region, from, to).map(h => `${h.date} ${h.name}`);

test('Issue #514 — holiday rules', async (t) => {
  await t.test('Bavaria 2027: national, Easter-based and state holidays on the right days', () => {
    assert.deepStrictEqual(dates('DE-BY', '2027-01-01', '2027-12-31'), [
      '2027-01-01 Neujahr',
      '2027-01-06 Heilige Drei Könige',
      '2027-03-26 Karfreitag',
      '2027-03-29 Ostermontag',
      '2027-05-01 Tag der Arbeit',
      '2027-05-06 Christi Himmelfahrt',
      '2027-05-17 Pfingstmontag',
      '2027-05-27 Fronleichnam',
      '2027-10-03 Tag der Deutschen Einheit',
      '2027-11-01 Allerheiligen',
      '2027-12-25 1. Weihnachtstag',
      '2027-12-26 2. Weihnachtstag',
    ]);
  });

  await t.test('each state gets only its own holidays', () => {
    const be = dates('DE-BE', '2026-01-01', '2026-12-31');
    assert.ok(be.includes('2026-03-08 Internationaler Frauentag'));
    assert.ok(!be.some(d => d.includes('Fronleichnam')));
    assert.ok(!be.some(d => d.includes('Heilige Drei Könige')));

    const sn = dates('DE-SN', '2027-01-01', '2027-12-31');
    assert.ok(sn.includes('2027-11-17 Buß- und Bettag'));
    assert.ok(sn.includes('2027-10-31 Reformationstag'));
    assert.ok(!sn.some(d => d.includes('Allerheiligen')));

    const bb = dates('DE-BB', '2026-01-01', '2026-12-31');
    assert.ok(bb.includes('2026-04-05 Ostersonntag'));
    assert.ok(bb.includes('2026-05-24 Pfingstsonntag'));

    assert.ok(dates('DE-TH', '2026-09-01', '2026-09-30').includes('2026-09-20 Weltkindertag'));
    assert.ok(dates('DE-SL', '2026-08-01', '2026-08-31').includes('2026-08-15 Mariä Himmelfahrt'));
    assert.ok(dates('DE-HH', '2026-10-31', '2026-10-31').includes('2026-10-31 Reformationstag'));
    assert.deepStrictEqual(dates('DE-NW', '2026-10-31', '2026-10-31'), []);
  });

  await t.test('a range across the year boundary covers both years', () => {
    assert.deepStrictEqual(dates('DE-HE', '2026-12-24', '2027-01-02'), [
      '2026-12-25 1. Weihnachtstag', '2026-12-26 2. Weihnachtstag', '2027-01-01 Neujahr',
    ]);
  });

  await t.test('every listed region has rules; an unknown region is refused', () => {
    const regions = HOLIDAY_COUNTRIES.flatMap(c => c.regions.map(r => r.code));
    assert.strictEqual(regions.length, 16);
    for (const code of regions) assert.ok(holidaysInRange(code, '2026-01-01', '2026-12-31').length >= 9, code);
    assert.throws(() => holidaysInRange('XX-YY', '2026-01-01', '2026-12-31'), /Unknown holiday region/);
  });
});

function api(cookie, method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('Issue #514 — holiday subscription API', async (t) => {
  const run = Date.now().toString(36);
  const alice = `testuser-514-a-${run}`;
  const bob = `testuser-514-b-${run}`;
  let aliceCookie;
  let bobCookie;

  t.before(async () => {
    if (!server.listening) await new Promise(resolve => server.listen(process.env.PORT, resolve));
    aliceCookie = await loginAs(alice, { username: 'testuser', email: 'testuser@example.com' });
    bobCookie = await loginAs(bob, { username: 'testuser2', email: 'testuser2@example.com' });
  });

  t.after(async () => {
    await Db.deleteUser(alice);
    await Db.deleteUser(bob);
    server.close();
  });

  await t.test('without a session nothing is answered', async () => {
    const res = await fetch(`${baseUrl}/api/holidays/settings`);
    assert.strictEqual(res.status, 401);
  });

  await t.test('the countries and regions are offered; nobody has holidays before choosing', async () => {
    const regions = await (await api(aliceCookie, 'GET', '/api/holidays/regions')).json();
    assert.strictEqual(regions.countries[0].code, 'DE');
    assert.ok(regions.countries[0].regions.some(r => r.code === 'DE-BY' && r.name === 'Bayern'));
    assert.deepStrictEqual(await (await api(aliceCookie, 'GET', '/api/holidays/settings')).json(), { region: null });
    const events = await api(aliceCookie, 'GET', '/api/holidays/events?start=2027-01-01T00:00:00Z&end=2027-02-01T00:00:00Z');
    assert.strictEqual(events.status, 404);
  });

  await t.test('an unknown region is refused', async () => {
    for (const region of ['XX-YY', 'de-by', 42, '']) {
      const res = await api(aliceCookie, 'PUT', '/api/holidays/settings', { region });
      assert.strictEqual(res.status, 400, String(region));
    }
    assert.deepStrictEqual(await (await api(aliceCookie, 'GET', '/api/holidays/settings')).json(), { region: null });
  });

  await t.test('a chosen region yields read-only all-day holiday events for that user only', async () => {
    const put = await api(aliceCookie, 'PUT', '/api/holidays/settings', { region: 'DE-BY' });
    assert.strictEqual(put.status, 200);
    assert.deepStrictEqual(await put.json(), { region: 'DE-BY' });

    const res = await api(aliceCookie, 'GET', '/api/holidays/events?start=2027-05-24T00:00:00Z&end=2027-05-31T00:00:00Z');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.name, 'Feiertage (Bayern)');
    assert.deepStrictEqual(body.events.map(e => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay, readOnly: e.readOnly })), [
      { title: 'Fronleichnam', start: '2027-05-27', end: '2027-05-28', allDay: true, readOnly: true },
    ]);
    assert.ok(body.events[0].id);

    assert.deepStrictEqual(await (await api(bobCookie, 'GET', '/api/holidays/settings')).json(), { region: null });
    const bad = await api(aliceCookie, 'GET', '/api/holidays/events?start=nonsense&end=2027-05-31T00:00:00Z');
    assert.strictEqual(bad.status, 400);
  });

  await t.test('switching off removes the subscription', async () => {
    const put = await api(aliceCookie, 'PUT', '/api/holidays/settings', { region: null });
    assert.strictEqual(put.status, 200);
    assert.deepStrictEqual(await (await api(aliceCookie, 'GET', '/api/holidays/settings')).json(), { region: null });
  });
});
