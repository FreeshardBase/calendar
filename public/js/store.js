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
  view:            'month',   // 'month' | 'week' | 'workweek' | 'day' | 'agenda' | 'kanban'
  currentDate:     new Date(today), // date the view is centered on

  // Tasks state (VTODO)
  tasks:           [],
  loadingTasks:    false,

  // Loading state
  loadingEvents:   false,
  loadingCalendars: false,

  // Search
  searchQuery:     '',
  searchResults:   [],

  // CTag & RFC 6578 Delta Sync Cache: Map<calendarId, { ctag, syncToken }>
  calendarSyncCache: new Map(),

  // Timezone Settings
  primaryTimezone:       localStorage.getItem('primaryTimezone') || 'Europe/Berlin',
  secondaryTimezone:     localStorage.getItem('secondaryTimezone') || null,
  showSecondaryTimezone: localStorage.getItem('showSecondaryTimezone') === 'true',

  // Working Hours Policy
  workingHours:          { startHour: 9, endHour: 17, workDays: '1,2,3,4,5' },
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

export function setCalendarSyncCache(calendarId, ctag, syncToken) {
  const syncCache = store.get('calendarSyncCache') || new Map();
  const nextCache = new Map(syncCache);
  nextCache.set(calendarId, { ctag, syncToken });
  store.set({ calendarSyncCache: nextCache });
}

export function getCalendarSyncCache(calendarId) {
  const syncCache = store.get('calendarSyncCache') || new Map();
  return syncCache.get(calendarId) || null;
}
