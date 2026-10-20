'use strict';

// Issue #513: a daily weather forecast from Bright Sky (https://brightsky.dev/), which serves the
// open data of the Deutscher Wetterdienst without an API key (CONCEPTS.md "Weather"). The shard asks
// on the user's behalf, so the browser never talks to the provider; answers are cached, failures
// and rate limits back off, and the caller turns any failure into "no forecast".

const BRIGHTSKY_URL = new URL(process.env.WEATHER_BRIGHTSKY_URL || 'https://api.brightsky.dev');
const SOURCE = 'Bright Sky / Deutscher Wetterdienst';

const FORECAST_DAYS = 7;
// DWD's MOSMIX forecast is refreshed a few times a day; an hour is fresh enough and keeps a shard to
// at most one request per location and zone per hour.
const CACHE_MS = 60 * 60 * 1000;
// After a failure the provider is not asked again for this long, so an outage is not hammered by
// every page turn. A 429/503 with Retry-After waits as long as the provider asks.
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// Daytime hours decide a day's symbol; the night ones only when no daytime hour is left (late today).
const DAY_HOURS = { from: 7, to: 19 };
// Ties between equally frequent symbols go to the more notable weather.
const SEVERITY = ['clear-day', 'partly-cloudy-day', 'cloudy', 'wind', 'fog', 'rain', 'sleet', 'snow', 'hail', 'thunderstorm'];

const cache = new Map(); // key → { until, days } | { until, error }
const inFlight = new Map(); // key → Promise<days>
let providerBlockedUntil = 0;
let providerBlockedReason = '';

function isTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (err) {
    if (err instanceof RangeError) return false;
    throw err;
  }
}

const roundCoordinate = value => Math.round(value * 100) / 100;

function isLocation(location) {
  return location !== null && typeof location === 'object'
    && Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90
    && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180;
}

const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);

function localParts(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const daySymbol = icon => icon.replace(/-night$/, '-day');

function mostFrequent(icons) {
  const counts = new Map();
  for (const icon of icons) counts.set(icon, (counts.get(icon) || 0) + 1);
  let best = null;
  for (const [icon, count] of counts) {
    const better = !best || count > best.count
      || (count === best.count && SEVERITY.indexOf(icon) > SEVERITY.indexOf(best.icon));
    if (better) best = { icon, count };
  }
  return best ? best.icon : null;
}

/** Bright Sky's hourly records → one summary per local date, for the given dates only. */
function summarizeDays(records, tz, dates) {
  const byDate = new Map(dates.map(d => [d, { temps: [], precipitation: 0, dayIcons: [], allIcons: [] }]));
  for (const r of records) {
    const ms = Date.parse(r.timestamp);
    if (Number.isNaN(ms)) throw new Error(`Bright Sky sent a record without a valid timestamp: ${r.timestamp}`);
    const { date, hour } = localParts(ms, tz);
    const day = byDate.get(date);
    if (!day) continue;
    if (typeof r.temperature === 'number') day.temps.push(r.temperature);
    if (typeof r.precipitation === 'number') day.precipitation += r.precipitation;
    // Only the symbols Bright Sky documents are passed on; anything else leaves the hour without one.
    const icon = typeof r.icon === 'string' ? daySymbol(r.icon) : null;
    if (SEVERITY.includes(icon)) {
      day.allIcons.push(icon);
      if (hour >= DAY_HOURS.from && hour <= DAY_HOURS.to) day.dayIcons.push(icon);
    }
  }
  const days = [];
  for (const [date, day] of byDate) {
    if (day.temps.length === 0) continue;
    days.push({
      date,
      icon: mostFrequent(day.dayIcons.length ? day.dayIcons : day.allIcons),
      tempMin: Math.round(Math.min(...day.temps)),
      tempMax: Math.round(Math.max(...day.temps)),
      precipitation: Math.round(day.precipitation * 10) / 10,
    });
  }
  return days;
}

function retryAfterMs(res) {
  const header = res.headers.get('retry-after');
  if (!header) return FAILURE_BACKOFF_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(seconds * 1000, FAILURE_BACKOFF_MS);
  const at = Date.parse(header);
  return Number.isNaN(at) ? FAILURE_BACKOFF_MS : Math.max(at - Date.now(), FAILURE_BACKOFF_MS);
}

async function fetchForecast(location, tz) {
  const today = localParts(Date.now(), tz).date;
  const dates = Array.from({ length: FORECAST_DAYS }, (_, i) => addDays(today, i));
  const url = new URL('/weather', BRIGHTSKY_URL);
  url.search = new URLSearchParams({
    lat: String(location.latitude),
    lon: String(location.longitude),
    date: today,
    last_date: addDays(today, FORECAST_DAYS),
    tz,
  }).toString();
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'FreeShard-WebCalendar (+https://freeshard.net)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429 || res.status === 503) {
    providerBlockedUntil = Date.now() + retryAfterMs(res);
    providerBlockedReason = `Bright Sky limits requests (HTTP ${res.status})`;
    throw new Error(providerBlockedReason);
  }
  if (!res.ok) throw new Error(`Bright Sky answered HTTP ${res.status}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.weather)) throw new Error('Bright Sky answered without weather records');
  return summarizeDays(body.weather, tz, dates);
}

/**
 * The daily forecast for `location` ({ latitude, longitude }) in the zone `tz`, from the cache when
 * fresh. Throws when the provider fails, limits or was failing a moment ago.
 * @returns {Promise<{ date: string, icon: string|null, tempMin: number, tempMax: number, precipitation: number }[]>}
 */
async function getForecast(location, tz) {
  const key = `${location.latitude},${location.longitude},${tz}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.until > now) {
    if (cached.error) throw new Error(cached.error);
    return cached.days;
  }
  if (providerBlockedUntil > now) throw new Error(providerBlockedReason);
  if (inFlight.has(key)) return inFlight.get(key);
  for (const [k, entry] of cache) if (entry.until <= now) cache.delete(k);

  const pending = fetchForecast(location, tz).then(
    days => {
      cache.set(key, { until: Date.now() + CACHE_MS, days });
      return days;
    },
    err => {
      const message = err.name === 'TimeoutError' ? 'Bright Sky did not answer in time' : err.message;
      cache.set(key, { until: Date.now() + FAILURE_BACKOFF_MS, error: message });
      throw new Error(message);
    },
  ).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

module.exports = {
  SOURCE,
  providerHost: BRIGHTSKY_URL.host,
  isTimeZone,
  isLocation,
  roundCoordinate,
  getForecast,
};
