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
};

// ── Calendars ─────────────────────────────────────────────────────────────────
export const CalendarsAPI = {
  list:   ()              => request('GET',    '/api/calendars'),
  create: (data)          => request('POST',   '/api/calendars', data),
  update: (id, data)      => request('PATCH',  `/api/calendars/${encodeURIComponent(id)}`, data),
  remove: (id)            => request('DELETE', `/api/calendars/${encodeURIComponent(id)}`),
};

// ── Events ────────────────────────────────────────────────────────────────────
export const EventsAPI = {
  list:   (start, end)    => request('GET', `/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  create: (data)          => request('POST',   '/api/events', data),
  update: (uid, data)     => request('PUT',    `/api/events/${encodeURIComponent(uid)}`, data),
  remove: (uid, data)     => request('DELETE', `/api/events/${encodeURIComponent(uid)}`, data),
};
