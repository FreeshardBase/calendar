'use strict';

// Issue #592: a mocked list endpoint keeps state. A GET that ignored the PATCH the test just made let
// a late background reload put the old value back, so a test passed or failed depending on timing.
// Here the collection is an in-memory array the test's writes change as the real server's do: a
// PATCH merges into the item, a PUT replaces it (events: merges, as the server answers with the
// stored event), a DELETE removes it, and the list GET always serves the current array.
// Requests the collection does not own (unknown id, other sub-paths) go on to the server or to an
// earlier route; a test that needs more registers its own route afterwards, which runs first.

function itemIdFrom(url, prefix) {
  const { pathname } = new URL(url);
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes('/')) return null;
  return decodeURIComponent(rest);
}

async function mockCollection(page, { listPath, itemPrefix, key, idField, items, errors = [], putMerges = false }) {
  const state = { items, gets: 0, writes: [] };
  await page.route(url => url.pathname === listPath, (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      state.gets += 1;
      return route.fulfill({ json: { [key]: JSON.parse(JSON.stringify(state.items)), errors } });
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      state.writes.push({ method: 'POST', body });
      state.items.push(body);
      return route.fulfill({ status: 201, json: body });
    }
    return route.fallback();
  });
  await page.route(url => itemIdFrom(url.href, itemPrefix) !== null, (route) => {
    const request = route.request();
    const id = itemIdFrom(request.url(), itemPrefix);
    const index = state.items.findIndex(item => item[idField] === id);
    const method = request.method();
    if (index === -1 || !['PATCH', 'PUT', 'DELETE'].includes(method)) return route.fallback();
    const body = method === 'DELETE' ? null : request.postDataJSON();
    state.writes.push({ method, id, body });
    if (method === 'DELETE') {
      state.items.splice(index, 1);
      return route.fulfill({ json: { message: 'deleted', [idField]: id } });
    }
    state.items[index] = method === 'PUT' && !putMerges
      ? { ...body, [idField]: id }
      : { ...state.items[index], ...body };
    return route.fulfill({ json: state.items[index] });
  });
  return state;
}

// GET /api/calendars from `calendars`; PATCH/DELETE /api/calendars/:id change them; PUT
// /api/calendars/order reorders them.
async function mockCalendars(page, calendars, { errors = [] } = {}) {
  const state = await mockCollection(page, {
    listPath: '/api/calendars', itemPrefix: '/api/calendars/', key: 'calendars', idField: 'id', items: calendars, errors,
  });
  await page.route(url => url.pathname === '/api/calendars/order', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const { calendarIds } = route.request().postDataJSON();
    state.writes.push({ method: 'PUT', id: 'order', body: { calendarIds } });
    const known = calendarIds.map(id => state.items.find(c => c.id === id)).filter(Boolean);
    const rest = state.items.filter(c => !calendarIds.includes(c.id));
    state.items.splice(0, state.items.length, ...known, ...rest);
    return route.fulfill({ json: { message: 'Order saved' } });
  });
  return state;
}

// GET /api/events?… from `events` (every range sees all of them); POST /api/events adds one;
// PUT/DELETE /api/events/:uid change or remove it.
async function mockEvents(page, events, { errors = [] } = {}) {
  return mockCollection(page, {
    listPath: '/api/events', itemPrefix: '/api/events/', key: 'events', idField: 'uid', items: events, errors, putMerges: true,
  });
}

module.exports = { mockCollection, mockCalendars, mockEvents };
