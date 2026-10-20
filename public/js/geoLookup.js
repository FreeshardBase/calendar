/**
 * geoLookup.js — Issue #512: address autocomplete and map preview for the location field.
 *
 * Off until the user picks a provider in the settings; switching one on asks for consent and says
 * what goes where. All lookups and tiles go through the shard (/api/geo), which enforces the
 * provider's usage policy; the browser never contacts the provider itself.
 */

import { store } from './store.js';
import { GeoAPI } from './api.js';
import { confirmDialog } from './dialogFocus.js';

const $ = id => document.getElementById(id);
const DEBOUNCE_MS = 400;
const MIN_QUERY = 3;
const ZOOM = 16;
const TILE = 256;

const PROVIDER_NAMES = { off: 'Aus', osm: 'OpenStreetMap (Photon)', google: 'Google Places' };

function consentText(p) {
  return `Beim Tippen im Feld „Ort“ sendet der Shard den eingegebenen Text an ${p.searchHost}. `
    + `Für die Kartenvorschau lädt er Kartenkacheln rund um den gewählten Ort von ${p.tileHost}. `
    + 'Beides geschieht nur, während du einen Termin bearbeitest.';
}

export async function loadGeoSettings() {
  const { provider, providers } = await GeoAPI.getSettings();
  store.set({ geoProvider: provider, geoProviders: providers });
}

export function renderGeoSettings() {
  const select = $('geo-provider');
  const providers = store.get('geoProviders');
  select.innerHTML = ['off', ...providers.map(p => p.id)]
    .map(id => `<option value="${id}">${PROVIDER_NAMES[id]}</option>`).join('');
  select.value = store.get('geoProvider');
  const active = providers.find(p => p.id === store.get('geoProvider'));
  $('geo-provider-notice').textContent = active
    ? consentText(active)
    : 'Aus: Die Adresssuche und die Kartenvorschau senden nichts an Dritte.';
}

async function changeProvider(id) {
  const p = store.get('geoProviders').find(x => x.id === id);
  if (p && !(await confirmDialog(consentText(p), `${PROVIDER_NAMES[id]} für Adressen einschalten?`))) {
    renderGeoSettings();
    return;
  }
  const { provider } = await GeoAPI.setProvider(id);
  store.set({ geoProvider: provider });
  renderGeoSettings();
}

export function initGeoSettings(onError) {
  $('geo-provider').addEventListener('change', e => changeProvider(e.target.value).catch(err => {
    renderGeoSettings();
    onError(err);
  }));
}

// Slippy-map tile coordinates (fractional) of a point.
function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const rad = lat * Math.PI / 180;
  return {
    x: (lon + 180) / 360 * n,
    y: (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n,
  };
}

/**
 * Wires the location input as a combobox. Returns { set(location, geo), geo() }:
 * geo is the point of the chosen suggestion, dropped as soon as the text is edited by hand.
 */
export function createLocationLookup() {
  const input = $('ev-location');
  const list = $('ev-location-suggestions');
  const status = $('ev-location-status');
  const map = $('ev-location-map');
  let geo = null;
  let results = [];
  let active = -1;
  let timer = null;
  let seq = 0;

  const enabled = () => store.get('geoProvider') !== 'off';

  function closeList() {
    results = [];
    active = -1;
    list.innerHTML = '';
    list.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function renderList() {
    list.innerHTML = '';
    results.forEach((r, i) => {
      const li = document.createElement('li');
      li.id = `ev-location-option-${i}`;
      li.className = 'location-option' + (i === active ? ' active' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.textContent = r.label;
      li.addEventListener('mousedown', e => { e.preventDefault(); choose(i); });
      list.appendChild(li);
    });
    list.classList.toggle('hidden', results.length === 0);
    input.setAttribute('aria-expanded', String(results.length > 0));
    if (active >= 0) input.setAttribute('aria-activedescendant', `ev-location-option-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function renderMap() {
    map.innerHTML = '';
    if (!geo || !enabled()) {
      map.classList.add('hidden');
      return;
    }
    const { x, y } = tileXY(geo.lat, geo.lon, ZOOM);
    const n = 2 ** ZOOM;
    // The 2×2 tiles nearest the point, so it has at least half a tile of map on every side.
    const x0 = Math.floor(x - 0.5);
    const y0 = Math.min(Math.max(Math.floor(y - 0.5), 0), n - 2);
    const grid = document.createElement('div');
    grid.className = 'location-map-tiles';
    grid.style.left = `calc(50% - ${Math.round((x - x0) * TILE)}px)`;
    grid.style.top = `calc(50% - ${Math.round((y - y0) * TILE)}px)`;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = `/api/geo/tile/${ZOOM}/${(((x0 + dx) % n) + n) % n}/${y0 + dy}`;
        grid.appendChild(img);
      }
    }
    const pin = document.createElement('div');
    pin.className = 'location-map-pin';
    pin.setAttribute('aria-hidden', 'true');
    const credit = document.createElement('a');
    credit.className = 'location-map-credit';
    credit.href = 'https://www.openstreetmap.org/copyright';
    credit.target = '_blank';
    credit.rel = 'noopener noreferrer';
    credit.textContent = '© OpenStreetMap-Mitwirkende';
    map.append(grid, pin, credit);
    map.setAttribute('aria-label', `Kartenvorschau: ${input.value}`);
    map.classList.remove('hidden');
  }

  function choose(i) {
    const r = results[i];
    input.value = r.label;
    geo = { lat: r.lat, lon: r.lon };
    closeList();
    renderMap();
  }

  async function search(q) {
    const mine = ++seq;
    let data;
    try {
      data = await GeoAPI.search(q);
    } catch (err) {
      if (mine !== seq) return;
      // 429: the shard's rate limit; the next keystroke asks again.
      if (err.status !== 429) status.textContent = `Adresssuche fehlgeschlagen: ${err.message}`;
      return;
    }
    if (mine !== seq || input.value.trim() !== q) return;
    status.textContent = data.results.length ? '' : 'Keine Adresse gefunden.';
    results = data.results;
    active = -1;
    renderList();
  }

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');

  input.addEventListener('input', () => {
    if (geo) {
      geo = null;
      renderMap();
    }
    clearTimeout(timer);
    seq++;
    status.textContent = '';
    if (!enabled()) return;
    const q = input.value.trim();
    if (q.length < MIN_QUERY) {
      closeList();
      return;
    }
    timer = setTimeout(() => search(q), DEBOUNCE_MS);
  });

  input.addEventListener('keydown', e => {
    if (!results.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + results.length) % results.length;
      renderList();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeList();
    }
  });

  input.addEventListener('blur', () => closeList());

  return {
    set(location, point) {
      clearTimeout(timer);
      seq++;
      input.value = location || '';
      geo = point || null;
      status.textContent = '';
      closeList();
      renderMap();
    },
    geo: () => geo,
  };
}
