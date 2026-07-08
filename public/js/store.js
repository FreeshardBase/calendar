/**
 * store.js — Lightweight reactive state store.
 * No external dependencies. Observer pattern.
 */

function createStore(initial) {
  let state = { ...initial };
  const listeners = new Map(); // key → Set<fn>

  function get(key) {
    return key ? state[key] : { ...state };
  }

  function set(updates) {
    const changed = [];
    for (const [k, v] of Object.entries(updates)) {
      if (state[k] !== v) {
        state[k] = v;
        changed.push(k);
      }
    }
    // Notify watchers for each changed key
    for (const k of changed) {
      listeners.get(k)?.forEach(fn => fn(state[k], state));
    }
    // Notify wildcard '*' listeners
    if (changed.length) {
      listeners.get('*')?.forEach(fn => fn(state));
    }
  }

  function on(key, fn) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => listeners.get(key).delete(fn); // returns unsubscribe fn
  }

  return { get, set, on };
}

// ── App store singleton ───────────────────────────────────────────────────────

const today = new Date();
today.setHours(0, 0, 0, 0);

export const store = createStore({
  // Auth / accounts
  accounts:        [],   // [{ id, url, username, displayName }]

  // Calendar data
  calendars:       [],   // [{ id, accountId, name, color, href, url, ... }]
  hiddenCalendars: new Set(),  // calendarIds to hide

  // Events cache: Map<string(YYYY-MM), Event[]>
  eventCache:      new Map(),

  // Current view state
  view:            'month',   // 'month' | 'week' | 'day' | 'agenda'
  currentDate:     new Date(today), // date the view is centered on

  // Loading state
  loadingEvents:   false,
  loadingCalendars: false,

  // Search
  searchQuery:     '',
  searchResults:   [],
});

// ── Derived helpers ───────────────────────────────────────────────────────────

export function visibleCalendars() {
  const { calendars, hiddenCalendars } = store.get();
  return calendars.filter(c => !hiddenCalendars.has(c.id));
}

export function calendarById(id) {
  return store.get('calendars').find(c => c.id === id) || null;
}

export function toggleCalendar(calendarId) {
  const hidden = new Set(store.get('hiddenCalendars'));
  if (hidden.has(calendarId)) hidden.delete(calendarId);
  else hidden.add(calendarId);
  store.set({ hiddenCalendars: hidden });
}

export function cacheEvents(cacheKey, events) {
  const cache = new Map(store.get('eventCache'));
  cache.set(cacheKey, events);
  store.set({ eventCache: cache });
}

export function getCachedEvents(cacheKey) {
  return store.get('eventCache').get(cacheKey) || null;
}

export function invalidateEventCache() {
  store.set({ eventCache: new Map() });
}
