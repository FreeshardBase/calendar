'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3513';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
// The Bright Sky stand-in below; the shipping default is the public https://api.brightsky.dev.
const BRIGHTSKY_PORT = 3613;
process.env.WEATHER_BRIGHTSKY_URL = `http://127.0.0.1:${BRIGHTSKY_PORT}`;

// Issue #513: a weather forecast from Bright Sky (DWD), off until the user sets a location in the
// settings. The shard fetches it, caches it, backs off when the provider fails or limits, and
// answers an error the web app turns into "no widget".

const test = require('node:test');
const assert = require('assert');
const http = require('http');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const baseUrl = `http://localhost:${process.env.PORT}`;
const DAY = 24 * 60 * 60 * 1000;
const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);

// Per day i from the requested date: hourly records 06–18 UTC, 5+i … 17+i °C;
// even days clear, odd days rain with 0.5 mm per hour.
const upstream = { requests: [], answer: null };
function brightSkyRecords(date) {
  const weather = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(date, i);
    for (let h = 6; h <= 18; h++) {
      weather.push({
        timestamp: `${day}T${String(h).padStart(2, '0')}:00:00+00:00`,
        temperature: 5 + i + (h - 6),
        precipitation: i % 2 ? 0.5 : 0,
        icon: i % 2 ? 'rain' : (h < 8 ? 'clear-night' : 'clear-day'),
      });
    }
  }
  return { weather, sources: [{ id: 1, observation_type: 'forecast' }] };
}

const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  upstream.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
  const answer = upstream.answer ? upstream.answer(url) : null;
  if (answer) {
    res.writeHead(answer.status, answer.headers || {});
    return res.end(answer.body || '');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(brightSkyRecords(url.searchParams.get('date'))));
});

function api(cookie, method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('Issue #513 — weather forecast API', async (t) => {
  const run = Date.now().toString(36);
  const alice = `testuser-513-a-${run}`;
  const bob = `testuser-513-b-${run}`;
  let aliceCookie;
  let bobCookie;

  t.before(async () => {
    await new Promise(resolve => mock.listen(BRIGHTSKY_PORT, '127.0.0.1', resolve));
    if (!server.listening) await new Promise(resolve => server.listen(process.env.PORT, resolve));
    aliceCookie = await loginAs(alice, { username: 'testuser', email: 'testuser@example.com' });
    bobCookie = await loginAs(bob, { username: 'testuser2', email: 'testuser2@example.com' });
  });

  t.after(async () => {
    await Db.deleteUser(alice);
    await Db.deleteUser(bob);
    server.close();
    mock.close();
  });

  t.beforeEach(() => {
    upstream.requests = [];
    upstream.answer = null;
  });

  await t.test('without a session nothing is answered', async () => {
    assert.strictEqual((await fetch(`${baseUrl}/api/weather/settings`)).status, 401);
    assert.strictEqual((await fetch(`${baseUrl}/api/weather/forecast?tz=UTC`)).status, 401);
  });

  await t.test('off by default: no location, no forecast, no request to the provider', async () => {
    const settings = await (await api(aliceCookie, 'GET', '/api/weather/settings')).json();
    assert.strictEqual(settings.location, null);
    assert.strictEqual(settings.provider.host, `127.0.0.1:${BRIGHTSKY_PORT}`);
    const res = await api(aliceCookie, 'GET', '/api/weather/forecast?tz=UTC');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(upstream.requests.length, 0);
  });

  await t.test('an invalid location is refused', async () => {
    for (const location of [
      { latitude: 91, longitude: 10 }, { latitude: 50, longitude: -181 }, { latitude: '50', longitude: 10 },
      { latitude: 50 }, { latitude: Number.NaN, longitude: 10 }, 'Berlin', 42,
    ]) {
      const res = await api(aliceCookie, 'PUT', '/api/weather/settings', { location });
      assert.strictEqual(res.status, 400, JSON.stringify(location));
    }
    assert.strictEqual((await api(aliceCookie, 'PUT', '/api/weather/settings', {})).status, 400);
    assert.strictEqual((await (await api(aliceCookie, 'GET', '/api/weather/settings')).json()).location, null);
  });

  await t.test('a set location is stored rounded to about 1 km, for that user only', async () => {
    const put = await api(aliceCookie, 'PUT', '/api/weather/settings', { location: { latitude: 52.520008, longitude: 13.404954 } });
    assert.strictEqual(put.status, 200);
    assert.deepStrictEqual((await put.json()).location, { latitude: 52.52, longitude: 13.4 });
    assert.deepStrictEqual((await (await api(aliceCookie, 'GET', '/api/weather/settings')).json()).location,
      { latitude: 52.52, longitude: 13.4 });
    assert.strictEqual((await (await api(bobCookie, 'GET', '/api/weather/settings')).json()).location, null);
    assert.strictEqual((await api(bobCookie, 'GET', '/api/weather/forecast?tz=UTC')).status, 404);
  });

  await t.test('the forecast is summarised per day and cached', async () => {
    const res = await api(aliceCookie, 'GET', '/api/weather/forecast?tz=UTC');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const today = new Date().toISOString().slice(0, 10);

    assert.strictEqual(upstream.requests.length, 1);
    const sent = upstream.requests[0];
    assert.strictEqual(sent.path, '/weather');
    assert.deepStrictEqual(
      { lat: sent.query.lat, lon: sent.query.lon, date: sent.query.date, tz: sent.query.tz },
      { lat: '52.52', lon: '13.4', date: today, tz: 'UTC' });

    assert.strictEqual(body.source, 'Bright Sky / Deutscher Wetterdienst');
    assert.strictEqual(body.days.length, 7);
    assert.deepStrictEqual(body.days[0], { date: today, icon: 'clear-day', tempMin: 5, tempMax: 17, precipitation: 0 });
    assert.deepStrictEqual(body.days[1], { date: addDays(today, 1), icon: 'rain', tempMin: 6, tempMax: 18, precipitation: 6.5 });
    assert.deepStrictEqual(body.days.map(d => d.date), Array.from({ length: 7 }, (_, i) => addDays(today, i)));

    // A second view in the same hour is served from the shard's cache.
    const again = await (await api(aliceCookie, 'GET', '/api/weather/forecast?tz=UTC')).json();
    assert.deepStrictEqual(again.days, body.days);
    assert.strictEqual(upstream.requests.length, 1);
  });

  await t.test('an unknown time zone is refused before anything is sent', async () => {
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/weather/forecast?tz=Mars/Olympus')).status, 400);
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/weather/forecast')).status, 400);
    assert.strictEqual(upstream.requests.length, 0);
  });

  await t.test('symbols Bright Sky does not document are not passed on', async () => {
    upstream.answer = url => {
      const records = brightSkyRecords(url.searchParams.get('date'));
      records.weather.forEach((r, i) => { r.icon = ['constructor', '__proto__', 'toString'][i % 3]; });
      records.weather[0].icon = 'rain';
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(records) };
    };
    const res = await api(aliceCookie, 'GET', '/api/weather/forecast?tz=Europe/Berlin');
    upstream.answer = null;
    assert.strictEqual(res.status, 200);
    const days = (await res.json()).days;
    assert.strictEqual(days.length, 7);
    assert.deepStrictEqual(days.map(d => d.icon), ['rain', null, null, null, null, null, null]);
  });

  await t.test('a provider outage answers 502 and is not retried on every view', async () => {
    await api(aliceCookie, 'PUT', '/api/weather/settings', { location: { latitude: 48.14, longitude: 11.58 } });
    upstream.answer = () => ({ status: 500, body: 'boom' });
    const res = await api(aliceCookie, 'GET', '/api/weather/forecast?tz=UTC');
    assert.strictEqual(res.status, 502);
    assert.match((await res.json()).error, /Bright Sky/);
    assert.strictEqual(upstream.requests.length, 1);

    upstream.answer = null;
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/weather/forecast?tz=UTC')).status, 502);
    assert.strictEqual(upstream.requests.length, 1);
  });

  await t.test('a rate limit is honoured: no request before Retry-After has passed', async () => {
    await api(aliceCookie, 'PUT', '/api/weather/settings', { location: { latitude: 50.94, longitude: 6.96 } });
    upstream.answer = () => ({ status: 429, headers: { 'Retry-After': '3600' } });
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/weather/forecast?tz=UTC')).status, 502);
    upstream.answer = null;
    // Another location: the limit is the provider's, not one location's.
    await api(aliceCookie, 'PUT', '/api/weather/settings', { location: { latitude: 53.55, longitude: 9.99 } });
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/weather/forecast?tz=UTC')).status, 502);
    assert.strictEqual(upstream.requests.length, 1);
  });

  await t.test('switching off removes the location', async () => {
    const put = await api(aliceCookie, 'PUT', '/api/weather/settings', { location: null });
    assert.strictEqual(put.status, 200);
    assert.strictEqual((await (await api(aliceCookie, 'GET', '/api/weather/settings')).json()).location, null);
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/weather/forecast?tz=UTC')).status, 404);
  });
});
