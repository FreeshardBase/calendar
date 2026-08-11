/**
 * api.js — Typed fetch wrapper for the FreeShard CalDAV backend.
 */

const BASE = '';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(BASE + path, opts);

  if (!res.ok) {
    let msg;
    try { msg = (await res.json()).error; } catch { msg = res.statusText; }
    const err = new Error(msg || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// ── Accounts ──────────────────────────────────────────────────────────────────
export const AccountsAPI = {
  list:   ()              => request('GET',    '/api/accounts'),
  add:    (data)          => request('POST',   '/api/accounts', data),
  remove: (id)            => request('DELETE', `/api/accounts/${id}`),
  update: (id, data)      => request('PATCH',  `/api/accounts/${id}`, data),
  removeAll: ()           => request('DELETE', '/api/accounts'),
  listAppPasswords: ()    => request('GET',    '/api/accounts/app-passwords'),
  addAppPassword: (label) => request('POST',   '/api/accounts/app-passwords', { label }),
  removeAppPassword: (id) => request('DELETE', `/api/accounts/app-passwords/${id}`),
};

// ── Calendars ─────────────────────────────────────────────────────────────────
export const CalendarsAPI = {
  list:   ()              => request('GET',    '/api/calendars'),
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
  importICS: (id, ics) => request('POST', `/api/calendars/${encodeURIComponent(id)}/import`, { ics }),
  exportUrl: (id) => `/api/calendars/${encodeURIComponent(id)}/export`,
  listPublicShares: (id) => request('GET', `/api/calendars/${encodeURIComponent(id)}/shares-public`),
  addPublicShare: (id, label) => request('POST', `/api/calendars/${encodeURIComponent(id)}/shares-public`, { label }),
  removePublicShare: (id, token) => request('DELETE', `/api/calendars/${encodeURIComponent(id)}/shares-public/${token}`),
  deltaSync: (id, syncToken, ctag) => request('POST', `/api/calendars/${encodeURIComponent(id)}/delta-sync`, { syncToken, ctag }),
};

// ── Events ────────────────────────────────────────────────────────────────────
export const EventsAPI = {
  list:   (start, end)    => request('GET', `/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
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
  list:   ()          => request('GET',    '/api/tasks'),
  create: (data)      => request('POST',   '/api/tasks', data),
  update: (uid, data) => request('PUT',    `/api/tasks/${encodeURIComponent(uid)}`, data),
  remove: (uid, data) => request('DELETE', `/api/tasks/${encodeURIComponent(uid)}`, data),
};


