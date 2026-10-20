'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3512';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

// Issue #512: address autocomplete and map preview in the location field. The shard proxies the
// lookups to a third party (Photon / Google Places) and the map tiles (OSM), and only for a user
// who chose a provider: without that opt-in no request leaves the shard. A fake upstream on
// loopback stands in for all three services and records every request it receives.
const UPSTREAM_PORT = 3513;
const UPSTREAM = `http://127.0.0.1:${UPSTREAM_PORT}`;
process.env.GEOCODER_PHOTON_URL = UPSTREAM;
process.env.OSM_TILE_URL = `${UPSTREAM}/tiles`;
process.env.GOOGLE_PLACES_URL = UPSTREAM;
process.env.GOOGLE_PLACES_API_KEY = 'test-google-key';

const test = require('node:test');
const assert = require('assert');
const http = require('http');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');
const { eventToICS, parseICSToEvent } = require('../utils/ical');

const baseUrl = `http://localhost:${process.env.PORT}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

const hits = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, UPSTREAM);
    hits.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body, at: Date.now() });
    if (url.pathname === '/api') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [13.4132, 52.5219] },
          properties: { name: 'Alexanderplatz', street: 'Alexanderplatz', postcode: '10178', city: 'Berlin', country: 'Deutschland' },
        }],
      }));
    } else if (url.pathname === '/v1/places:searchText') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ places: [{
        displayName: { text: 'Testcafé' },
        formattedAddress: 'Teststraße 1, 12345 Teststadt, Deutschland',
        location: { latitude: 48.1, longitude: 11.5 },
      }] }));
    } else if (url.pathname === '/tiles/16/1/1.png') {
      // Oversized and chunked: no Content-Length announces it.
      res.setHeader('Content-Type', 'image/png');
      res.write(Buffer.alloc(200 * 1024));
      res.end(Buffer.alloc(200 * 1024));
    } else if (url.pathname === '/tiles/16/1/2.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.alloc(400 * 1024));
    } else if (url.pathname.startsWith('/tiles/')) {
      res.setHeader('Content-Type', 'image/png');
      res.end(PNG);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
});

async function api(cookie, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

test('Issue #512 — address lookup and map tiles only after a per-user opt-in', async (t) => {
  const run = Date.now().toString(36);
  const alice = `testuser-512-a-${run}`;
  const bob = `testuser-512-b-${run}`;
  let aliceCookie;
  let bobCookie;

  t.before(async () => {
    await new Promise(resolve => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));
    if (!server.listening) await new Promise(resolve => server.listen(process.env.PORT, resolve));
    aliceCookie = await loginAs(alice, { username: 'testuser', email: 'testuser@example.com' });
    bobCookie = await loginAs(bob, { username: 'testuser2', email: 'testuser2@example.com' });
  });

  t.after(async () => {
    await Db.deleteUser(alice);
    await Db.deleteUser(bob);
    server.close();
    upstream.close();
  });

  await t.test('off by default: lookups and tiles are refused and nothing reaches the third party', async () => {
    const settings = await (await api(aliceCookie, 'GET', '/api/geo/settings')).json();
    assert.strictEqual(settings.provider, 'off');
    assert.deepStrictEqual(settings.providers.map(p => p.id), ['osm', 'google']);
    const osm = settings.providers.find(p => p.id === 'osm');
    assert.strictEqual(osm.searchHost, '127.0.0.1');

    const search = await api(aliceCookie, 'GET', '/api/geo/search?q=Alexanderplatz');
    assert.strictEqual(search.status, 403);
    const tile = await api(aliceCookie, 'GET', '/api/geo/tile/15/17605/10746');
    assert.strictEqual(tile.status, 403);
    assert.strictEqual(hits.length, 0);
  });

  await t.test('an unknown provider is refused', async () => {
    const res = await api(aliceCookie, 'PUT', '/api/geo/settings', { provider: 'bing' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await (await api(aliceCookie, 'GET', '/api/geo/settings')).json()).provider, 'off');
  });

  await t.test('with OpenStreetMap chosen, the lookup goes to Photon with an identifying User-Agent', async () => {
    const put = await api(aliceCookie, 'PUT', '/api/geo/settings', { provider: 'osm' });
    assert.strictEqual(put.status, 200);
    assert.strictEqual((await put.json()).provider, 'osm');

    const res = await api(aliceCookie, 'GET', '/api/geo/search?q=Alexanderplatz');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), {
      results: [{ label: 'Alexanderplatz, 10178 Berlin, Deutschland', lat: 52.5219, lon: 13.4132 }],
    });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].path, '/api');
    assert.strictEqual(hits[0].query.get('q'), 'Alexanderplatz');
    assert.match(hits[0].headers['user-agent'], /^FreeShard-WebCalendar\/\S+ \(\+https:\/\/\S+\)$/);
  });

  await t.test('another user who did not opt in still sends nothing', async () => {
    const before = hits.length;
    assert.strictEqual((await api(bobCookie, 'GET', '/api/geo/search?q=Alexanderplatz')).status, 403);
    assert.strictEqual((await api(bobCookie, 'GET', '/api/geo/tile/15/17605/10746')).status, 403);
    assert.strictEqual(hits.length, before);
  });

  await t.test('no bulk use: short queries are refused, repeated queries come from the cache', async () => {
    const before = hits.length;
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/geo/search?q=Al')).status, 400);
    assert.strictEqual((await api(aliceCookie, 'GET', `/api/geo/search?q=${'x'.repeat(201)}`)).status, 400);
    const again = await api(aliceCookie, 'GET', '/api/geo/search?q=Alexanderplatz');
    assert.strictEqual(again.status, 200);
    assert.strictEqual((await again.json()).results.length, 1);
    assert.strictEqual(hits.length, before);
  });

  await t.test('rate limit: upstream lookups are at least one second apart', async () => {
    const before = hits.length;
    const [a, b] = await Promise.all([
      api(aliceCookie, 'GET', '/api/geo/search?q=Hauptstraße'),
      api(aliceCookie, 'GET', '/api/geo/search?q=Bahnhofstraße'),
    ]);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    const fresh = hits.slice(before);
    assert.strictEqual(fresh.length, 2);
    assert.ok(Math.abs(fresh[1].at - fresh[0].at) >= 950, `gap was ${fresh[1].at - fresh[0].at} ms`);
  });

  await t.test('map tiles are proxied from the OSM tile server, with the User-Agent', async () => {
    const before = hits.length;
    const res = await api(aliceCookie, 'GET', '/api/geo/tile/15/17605/10746');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), PNG);
    const hit = hits[before];
    assert.strictEqual(hit.path, '/tiles/15/17605/10746.png');
    assert.match(hit.headers['user-agent'], /^FreeShard-WebCalendar\//);
    // Out-of-range tile coordinates never reach the tile server.
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/geo/tile/15/40000/1')).status, 400);
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/geo/tile/25/1/1')).status, 400);
    assert.strictEqual(hits.length, before + 1);
  });

  await t.test('a tile fetched once is served from the shard cache', async () => {
    const before = hits.length;
    const res = await api(aliceCookie, 'GET', '/api/geo/tile/15/17605/10746');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), PNG);
    assert.strictEqual(hits.length, before);
  });

  await t.test('an oversized tile is refused, announced or not', async () => {
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/geo/tile/16/1/1')).status, 502);
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/geo/tile/16/1/2')).status, 502);
  });

  await t.test('no bulk download: at most 60 upstream tile fetches per minute for the shard', async () => {
    const responses = await Promise.all(Array.from({ length: 70 }, (_, i) =>
      api(aliceCookie, 'GET', `/api/geo/tile/16/${100 + i}/7`)));
    const limited = responses.filter(r => r.status === 429);
    assert.ok(limited.length > 0, 'some tile requests must be refused');
    assert.ok(limited.every(r => r.headers.get('retry-after') === '60'));
    assert.ok(responses.every(r => r.status === 200 || r.status === 429));
    assert.strictEqual(hits.filter(h => h.path.startsWith('/tiles/')).length, 60);
    // Cached tiles still load while the budget is used up.
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/geo/tile/15/17605/10746')).status, 200);
  });

  await t.test('with Google chosen, the lookup goes to Places with the shard key', async () => {
    await new Promise(resolve => setTimeout(resolve, 1000)); // past the rate-limit slot
    assert.strictEqual((await api(aliceCookie, 'PUT', '/api/geo/settings', { provider: 'google' })).status, 200);
    const before = hits.length;
    const res = await api(aliceCookie, 'GET', '/api/geo/search?q=Testcafé');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), {
      results: [{ label: 'Testcafé, Teststraße 1, 12345 Teststadt, Deutschland', lat: 48.1, lon: 11.5 }],
    });
    const hit = hits[before];
    assert.strictEqual(hit.method, 'POST');
    assert.strictEqual(hit.path, '/v1/places:searchText');
    assert.strictEqual(hit.headers['x-goog-api-key'], 'test-google-key');
    assert.strictEqual(JSON.parse(hit.body).textQuery, 'Testcafé');
  });

  await t.test('switched off again, nothing leaves the shard', async () => {
    assert.strictEqual((await api(aliceCookie, 'PUT', '/api/geo/settings', { provider: 'off' })).status, 200);
    const before = hits.length;
    assert.strictEqual((await api(aliceCookie, 'GET', '/api/geo/search?q=Neue Anfrage')).status, 403);
    assert.strictEqual(hits.length, before);
  });
});

test('Issue #512 — the chosen place is stored in LOCATION and GEO', () => {
  const base = {
    uid: 'testuser-512-geo', title: 'Treffen', start: '2037-05-01T10:00:00.000Z', end: '2037-05-01T11:00:00.000Z',
    location: 'Alexanderplatz, 10178 Berlin, Deutschland', geo: { lat: 52.5219, lon: 13.4132 },
  };
  const ics = eventToICS(base);
  assert.match(ics, /\r?\nGEO:52\.5219;13\.4132\r?\n/);
  assert.match(ics, /\r?\nLOCATION:Alexanderplatz\\, 10178 Berlin\\, Deutschland\r?\n/);
  const parsed = parseICSToEvent(ics);
  assert.deepStrictEqual(parsed.geo, { lat: 52.5219, lon: 13.4132 });
  assert.strictEqual(parsed.location, base.location);

  // Editing an existing event moves or removes the point.
  const moved = parseICSToEvent(eventToICS({ ...base, geo: { lat: 48.1, lon: 11.5 } }, ics));
  assert.deepStrictEqual(moved.geo, { lat: 48.1, lon: 11.5 });
  const cleared = eventToICS({ ...base, location: 'Irgendwo', geo: null }, ics);
  assert.doesNotMatch(cleared, /GEO:/);
  assert.strictEqual(parseICSToEvent(cleared).geo, null);
  assert.strictEqual(parseICSToEvent(eventToICS({ ...base, geo: undefined })).geo, null);

  for (const geo of [{ lat: 91, lon: 0 }, { lat: 0, lon: -181 }, { lat: '52', lon: 13 }, [52, 13]]) {
    assert.throws(() => eventToICS({ ...base, geo }), /geo/i, JSON.stringify(geo));
  }
});
