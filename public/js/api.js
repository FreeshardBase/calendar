/**
 * api.js — Typed fetch wrapper for the FreeShard CalDAV backend.
 */

const BASE = '';

/**
 * The error message of a failed response: the JSON `error` field, or the status line when the body is
 * not JSON (e.g. a proxy error page). Only that parse error is handled; anything else propagates.
 */
export async function responseErrorMessage(res, fallback) {
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data && data.error) return data.error;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  return fallback ? `${fallback} (HTTP ${res.status})` : (res.statusText || `HTTP ${res.status}`);
}

async function request(method, path, body, onResponse) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(BASE + path, opts);
  if (onResponse) onResponse(res);

  if (!res.ok) {
    const err = new Error(await responseErrorMessage(res));
    err.status = res.status;
    throw err;
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// ── Accounts ──────────────────────────────────────────────────────────────────
export const AccountsAPI = {
  list:                ()              => request('GET',    '/api/accounts'),
  getPresets:          (email)         => request('GET',    `/api/accounts/presets?email=${encodeURIComponent(email || '')}`),
  getOAuthTokenStatus: ()              => request('GET',    '/api/accounts/oauth-token-status'),
  getSyncStatus:       ()              => request('GET',    '/api/accounts/sync-status'),
  getSyncJob:          (id)            => request('GET',    `/api/accounts/sync-jobs/${encodeURIComponent(id)}`),
  add:                 (data)          => request('POST',   '/api/accounts', data),
  remove: (id)            => request('DELETE', `/api/accounts/${id}`),
  update: (id, data)      => request('PATCH',  `/api/accounts/${id}`, data),
  removeAll: ()           => request('DELETE', '/api/accounts'),
  listAppPasswords: ()    => request('GET',    '/api/accounts/app-passwords'),
  addAppPassword: (label) => request('POST',   '/api/accounts/app-passwords', { label }),
  removeAppPassword: (id) => request('DELETE', `/api/accounts/app-passwords/${id}`),
};

// ── Calendars ─────────────────────────────────────────────────────────────────
export const CalendarsAPI = {
  list: async () => {
    try {
      const cals = await request('GET', '/api/calendars');
      if (typeof window !== 'undefined' && window.OfflineCache) {
        window.OfflineCache.saveCalendars(cals);
      }
      return cals;
    } catch (err) {
      if (typeof window !== 'undefined' && window.OfflineCache && window.OfflineCache.isOffline()) {
        const cached = window.OfflineCache.getCalendars();
        if (cached && cached.length > 0) return cached;
      }
      throw err;
    }
  },
  create: (data)          => request('POST',   '/api/calendars', data),
  update: (id, data)      => request('PATCH',  `/api/calendars/${encodeURIComponent(id)}`, data),
  remove: (id)            => request('DELETE', `/api/calendars/${encodeURIComponent(id)}`),
  searchUsers: (q, accountId) => request('GET', `/api/calendars/search-users?q=${encodeURIComponent(q)}&accountId=${encodeURIComponent(accountId || '')}`),
  getShares: (id) => request('GET', `/api/calendars/${encodeURIComponent(id)}/shares`),
  addShare: (id, sharee, readWrite) => request('POST', `/api/calendars/${encodeURIComponent(id)}/shares`, { sharee, readWrite }),
  removeShare: (id, sharee) => request('DELETE', `/api/calendars/${encodeURIComponent(id)}/shares`, { sharee }),
  getPublicLink: (id) => request('GET', `/api/calendars/${encodeURIComponent(id)}/public-link`),
  enablePublicLink: (id) => request('POST', `/api/calendars/${encodeURIComponent(id)}/public-link`),
  disablePublicLink: (id) => request('DELETE', `/api/calendars/${encodeURIComponent(id)}/public-link`),
  setPublicLinkDetail: (id, detail) => request('PUT', `/api/calendars/${encodeURIComponent(id)}/public-link`, { detail }),
  importICS: (id, ics, resolutions, defaultStrategy) => request('POST', `/api/calendars/${encodeURIComponent(id)}/import`, { ics, resolutions, defaultStrategy }),
  detectICSConflicts: (id, ics) => request('POST', `/api/calendars/${encodeURIComponent(id)}/import/detect`, { ics }),
  exportUrl: (id) => `/api/calendars/${encodeURIComponent(id)}/export`,
  listPublicShares: (id) => request('GET', `/api/calendars/${encodeURIComponent(id)}/shares-public`),
  addPublicShare: (id, label) => request('POST', `/api/calendars/${encodeURIComponent(id)}/shares-public`, { label }),
  removePublicShare: (id, token) => request('DELETE', `/api/calendars/${encodeURIComponent(id)}/shares-public/${token}`),
  deltaSync: (id, syncToken, ctag) => request('POST', `/api/calendars/${encodeURIComponent(id)}/delta-sync`, { syncToken, ctag }),
};

// ── Events ────────────────────────────────────────────────────────────────────
export const EventsAPI = {
  // Resolves to { events, errors }: `errors` names every calendar or account
  // the server could not read, so its events are missing from `events` (#65).
  // onUnparseable({ count, resources }) is called when the server could not
  // read some stored events and left them out of the list (#128).
  list: async (start, end, onUnparseable) => {
    try {
      const { events, errors } = await request('GET', `/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, undefined, (res) => {
        const header = res.headers.get('x-caldav-unparseable');
        if (header && onUnparseable) onUnparseable(JSON.parse(decodeURIComponent(header)));
      });
      if (!Array.isArray(events) || !Array.isArray(errors)) {
        throw new Error('Unerwartete Antwort von /api/events');
      }
      if (typeof window !== 'undefined' && window.OfflineCache && errors.length === 0) {
        events.forEach(ev => {
          if (ev.calendarId) window.OfflineCache.saveEvents(ev.calendarId, events);
        });
        window.OfflineCache.saveEvents('all', events);
      }
      return { events, errors };
    } catch (err) {
      if (typeof window !== 'undefined' && window.OfflineCache && window.OfflineCache.isOffline()) {
        const cached = window.OfflineCache.getEvents('all');
        if (cached && cached.length > 0) return { events: cached, errors: [] };
      }
      throw err;
    }
  },
  create: (data)          => request('POST',   '/api/events', data),
  update: (uid, data)     => request('PUT',    `/api/events/${encodeURIComponent(uid)}`, data),
  remove: (uid, data)     => request('DELETE', `/api/events/${encodeURIComponent(uid)}`, data),
  rsvp:   (uid, data)     => request('POST',   `/api/events/${encodeURIComponent(uid)}/rsvp`, data),
  invitations: ()         => request('GET',    '/api/events/invitations'),
};

// ── Invitations (iTIP/RSVP) ───────────────────────────────────────────────────
export const InvitationsAPI = {
  list: ()        => request('GET',  '/api/events/invitations'),
  rsvp: (uid, d) => request('POST', `/api/events/${encodeURIComponent(uid)}/rsvp`, d),
};

// ── Tasks (VTODO) ─────────────────────────────────────────────────────────────
export const TasksAPI = {
  list: async () => {
    try {
      const tasks = await request('GET', '/api/tasks');
      if (typeof window !== 'undefined' && window.OfflineCache) {
        window.OfflineCache.saveTasks(tasks);
      }
      return tasks;
    } catch (err) {
      if (typeof window !== 'undefined' && window.OfflineCache && window.OfflineCache.isOffline()) {
        const cached = window.OfflineCache.getTasks();
        if (cached && cached.length > 0) return cached;
      }
      throw err;
    }
  },
  create: (data)      => request('POST',   '/api/tasks', data),
  update: (uid, data) => request('PUT',    `/api/tasks/${encodeURIComponent(uid)}`, data),
  remove: (uid, data) => request('DELETE', `/api/tasks/${encodeURIComponent(uid)}`, data),
};

// ── Resources & Room Booking ──────────────────────────────────────────────────
export const ResourcesAPI = {
  list:   (type, minCapacity) => request('GET', `/api/resources?type=${encodeURIComponent(type || '')}&minCapacity=${minCapacity || ''}`),
  create: (data)              => request('POST', '/api/resources', data),
  get:    (id)                => request('GET', `/api/resources/${encodeURIComponent(id)}`),
  update: (id, data)          => request('PATCH', `/api/resources/${encodeURIComponent(id)}`, data),
  remove: (id)                => request('DELETE', `/api/resources/${encodeURIComponent(id)}`),
  checkAvailability: (data)   => request('POST', '/api/resources/check-availability', data),
  suggest: (data)             => request('POST', '/api/resources/suggest', data),
  getBookings: (resourceId)   => request('GET', `/api/resources/bookings?resourceId=${encodeURIComponent(resourceId || '')}`),
  createBooking: (data)       => request('POST', '/api/resources/bookings', data),
  cancelBooking: (id)         => request('DELETE', `/api/resources/bookings/${encodeURIComponent(id)}`),
};

// ── Availability Slots Booking ────────────────────────────────────────────────
export const AvailabilityAPI = {
  getPages: () => request('GET', '/api/availability-slots'),
  createPage: (data) => request('POST', '/api/availability-slots', data),
  deletePage: (id) => request('DELETE', `/api/availability-slots/${encodeURIComponent(id)}`),
  getPublicPage: (slug, date) => request('GET', `/api/public/availability/${encodeURIComponent(slug)}?date=${encodeURIComponent(date || '')}`),
  bookPublicSlot: (slug, bookingData) => request('POST', `/api/public/availability/${encodeURIComponent(slug)}/book`, bookingData),
};

// ── Webcal / ICS Subscriptions ────────────────────────────────────────────────
export const WebcalAPI = {
  list: () => request('GET', '/api/webcal/subscriptions'),
  get: (id) => request('GET', `/api/webcal/subscriptions/${encodeURIComponent(id)}`),
  create: (data) => request('POST', '/api/webcal/subscriptions', data),
  update: (id, data) => request('PATCH', `/api/webcal/subscriptions/${encodeURIComponent(id)}`, data),
  remove: (id) => request('DELETE', `/api/webcal/subscriptions/${encodeURIComponent(id)}`),
  getEvents: (id, start, end) => request('GET', `/api/webcal/subscriptions/${encodeURIComponent(id)}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  sync: (id) => request('POST', `/api/webcal/subscriptions/${encodeURIComponent(id)}/sync`),
};





