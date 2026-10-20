'use strict';
const log = require('../utils/logger');

// Issue #512: address autocomplete and map preview for the location field.
// Both send shard data to a third party, so they are off until a user picks a provider
// (CONCEPTS.md: "Nothing leaves the shard without consent"). The browser never talks to the
// provider: the shard proxies every lookup and tile, which keeps the CSP at 'self', lets the shard
// send an identifying User-Agent and enforce the providers' usage policies for all its users:
// at most one lookup per second (Photon / Nominatim policy), short queries refused, repeats cached.
//
// Operator settings (one per shard; a hosted FreeShard may point them at a shared instance):
//   GEOCODER_PHOTON_URL   Photon server, default https://photon.komoot.io
//   OSM_TILE_URL          tile server ({z}/{x}/{y}.png below it), default https://tile.openstreetmap.org
//   GOOGLE_PLACES_API_KEY enables Google Places as a provider; GOOGLE_PLACES_URL overrides its base URL

const express = require('express');
const router = express.Router();
const Db = require('../db');
const { version } = require('../../package.json');

function configuredUrl(name, fallback) {
  const raw = process.env[name] || fallback;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be an http(s) URL: ${raw}`);
  return url.href.replace(/\/+$/, '');
}

const PHOTON_URL = configuredUrl('GEOCODER_PHOTON_URL', 'https://photon.komoot.io');
const TILE_URL = configuredUrl('OSM_TILE_URL', 'https://tile.openstreetmap.org');
const GOOGLE_URL = configuredUrl('GOOGLE_PLACES_URL', 'https://places.googleapis.com');
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY || null;

const USER_AGENT = `FreeShard-WebCalendar/${version} (+https://github.com/FreeshardBase/calendar)`;
const MIN_QUERY = 3;
const MAX_QUERY = 200;
const RESULT_LIMIT = 5;
const MIN_INTERVAL_MS = 1000;
const MAX_WAIT_MS = 3000;
const UPSTREAM_TIMEOUT_MS = 10000;
const CACHE_MAX = 500;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_ZOOM = 19;
// Tiles (OSM tile usage policy: no bulk downloads, cache locally): at most TILE_BUDGET upstream
// fetches per TILE_WINDOW_MS for the whole shard, a tile larger than TILE_MAX_BYTES is refused while
// it streams in, and fetched tiles are served from a bounded in-memory cache.
const TILE_BUDGET = 60;
const TILE_WINDOW_MS = 60 * 1000;
const TILE_MAX_BYTES = 256 * 1024;
const TILE_CACHE_MAX = 200;
const TILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const host = url => new URL(url).hostname;

function availableProviders() {
  const providers = [{ id: 'osm', searchHost: host(PHOTON_URL), tileHost: host(TILE_URL) }];
  if (GOOGLE_KEY) providers.push({ id: 'google', searchHost: host(GOOGLE_URL), tileHost: host(TILE_URL) });
  return providers;
}

// The provider a user opted into, or 'off' (also when the operator has since removed it).
async function activeProvider(userId) {
  const chosen = await Db.getGeoProviderPreference(userId);
  return availableProviders().some(p => p.id === chosen) ? chosen : 'off';
}

// One upstream lookup per MIN_INTERVAL_MS for the whole shard; a request that would wait longer
// than MAX_WAIT_MS is refused instead of queued.
let nextSlot = 0;
async function takeSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  if (at - now > MAX_WAIT_MS) return false;
  nextSlot = at + MIN_INTERVAL_MS;
  if (at > now) await new Promise(resolve => setTimeout(resolve, at - now));
  return true;
}

const cache = new Map();
function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.results;
}
function remember(key, results) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), results });
}

let tileFetches = [];
function takeTileFetch() {
  const now = Date.now();
  tileFetches = tileFetches.filter(at => now - at < TILE_WINDOW_MS);
  if (tileFetches.length >= TILE_BUDGET) return false;
  tileFetches.push(now);
  return true;
}

const tileCache = new Map();
function cachedTile(key) {
  const hit = tileCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TILE_CACHE_TTL_MS) {
    tileCache.delete(key);
    return null;
  }
  return hit.png;
}
function rememberTile(key, png) {
  if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  tileCache.set(key, { at: Date.now(), png });
}

class UpstreamError extends Error {}

// The body of a tile response, or an UpstreamError once it grows past TILE_MAX_BYTES.
async function readTile(upstream, url) {
  const declared = Number(upstream.headers.get('content-length'));
  if (declared > TILE_MAX_BYTES) {
    await upstream.body.cancel();
    throw new UpstreamError(`${host(url)} sent a ${declared} byte tile`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream.body) {
    size += chunk.length;
    if (size > TILE_MAX_BYTES) throw new UpstreamError(`${host(url)} sent a tile over ${TILE_MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function upstreamJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init && init.headers) },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new UpstreamError(`${host(url)} answered ${res.status}`);
  return res.json();
}

function joinParts(parts) {
  return parts.filter(Boolean).filter((p, i, all) => all.indexOf(p) === i).join(', ');
}

async function searchPhoton(q) {
  const data = await upstreamJson(`${PHOTON_URL}/api?${new URLSearchParams({ q, limit: String(RESULT_LIMIT) })}`);
  return (data.features || []).map(f => {
    const p = f.properties || {};
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const place = [p.postcode, p.city || p.town || p.village].filter(Boolean).join(' ');
    const [lon, lat] = f.geometry.coordinates;
    return { label: joinParts([p.name, street, place, p.country]), lat, lon };
  });
}

async function searchGoogle(q) {
  const data = await upstreamJson(`${GOOGLE_URL}/v1/places:searchText`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify({ textQuery: q, pageSize: RESULT_LIMIT }),
  });
  return (data.places || []).map(p => {
    const name = p.displayName && p.displayName.text;
    const address = p.formattedAddress || '';
    return {
      label: name && !address.startsWith(name) ? joinParts([name, address]) : address,
      lat: p.location.latitude,
      lon: p.location.longitude,
    };
  });
}

// GET /api/geo/settings
router.get('/settings', async (req, res, next) => {
  try {
    res.json({ provider: await activeProvider(req.session.userId), providers: availableProviders() });
  } catch (err) {
    next(err);
  }
});

// PUT /api/geo/settings — { provider: 'off' | 'osm' | 'google' }
router.put('/settings', async (req, res, next) => {
  const provider = req.body && req.body.provider;
  const allowed = ['off', ...availableProviders().map(p => p.id)];
  if (!allowed.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${allowed.join(', ')}` });
  }
  try {
    await Db.setGeoProviderPreference(req.session.userId, provider);
    res.json({ provider, providers: availableProviders() });
  } catch (err) {
    next(err);
  }
});

// GET /api/geo/search?q= — { results: [{ label, lat, lon }] }
router.get('/search', async (req, res, next) => {
  try {
    const provider = await activeProvider(req.session.userId);
    if (provider === 'off') return res.status(403).json({ error: 'Address lookup is switched off' });
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < MIN_QUERY || q.length > MAX_QUERY) {
      return res.status(400).json({ error: `q must be ${MIN_QUERY} to ${MAX_QUERY} characters` });
    }
    const key = `${provider}\n${q.toLowerCase()}`;
    const hit = cached(key);
    if (hit) return res.json({ results: hit });
    if (!(await takeSlot())) {
      res.setHeader('Retry-After', String(Math.ceil(MAX_WAIT_MS / 1000)));
      return res.status(429).json({ error: 'Too many address lookups, try again shortly' });
    }
    const results = provider === 'google' ? await searchGoogle(q) : await searchPhoton(q);
    remember(key, results);
    res.json({ results });
  } catch (err) {
    if (err instanceof UpstreamError || err.name === 'TimeoutError') {
      log.error('[geo search]', err.message);
      return res.status(502).json({ error: 'The address service is not reachable' });
    }
    next(err);
  }
});

// GET /api/geo/tile/:z/:x/:y — one OSM map tile (PNG) for the preview
router.get('/tile/:z/:x/:y', async (req, res, next) => {
  try {
    if (await activeProvider(req.session.userId) === 'off') {
      return res.status(403).json({ error: 'The map preview is switched off' });
    }
    const [z, x, y] = [req.params.z, req.params.x, req.params.y].map(v => (/^\d{1,7}$/.test(v) ? Number(v) : -1));
    const size = 2 ** z;
    if (z < 0 || z > MAX_ZOOM || x < 0 || y < 0 || x >= size || y >= size) {
      return res.status(400).json({ error: 'Invalid tile coordinates' });
    }
    const key = `${z}/${x}/${y}`;
    let png = cachedTile(key);
    if (!png) {
      if (!takeTileFetch()) {
        res.setHeader('Retry-After', String(Math.ceil(TILE_WINDOW_MS / 1000)));
        return res.status(429).json({ error: 'Too many map tiles, try again shortly' });
      }
      const url = `${TILE_URL}/${key}.png`;
      const upstream = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!upstream.ok || upstream.headers.get('content-type') !== 'image/png') {
        await upstream.body?.cancel();
        throw new UpstreamError(`${host(url)} answered ${upstream.status} ${upstream.headers.get('content-type')}`);
      }
      png = await readTile(upstream, url);
      rememberTile(key, png);
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(png);
  } catch (err) {
    if (err instanceof UpstreamError || err.name === 'TimeoutError') {
      log.error('[geo tile]', err.message);
      return res.status(502).json({ error: 'The map service is not reachable' });
    }
    next(err);
  }
});

module.exports = router;
