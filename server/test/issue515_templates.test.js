'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3515';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

// Issue #515: "Als Vorlage speichern" keeps an event's or task's fields without date and time,
// per user, in the app database. Templates never reach Radicale or a provider.

const test = require('node:test');
const assert = require('assert');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const baseUrl = `http://localhost:${process.env.PORT}`;

function call(cookie, method, path, body) {
  return fetch(`${baseUrl}/api/templates${path}`, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const EVENT_FIELDS = {
  title: 'Teamrunde',
  calendarId: 'testuser-cal',
  allDay: false,
  location: 'Raum 1',
  description: 'Agenda',
  categories: ['Arbeit'],
  attendees: [{ name: 'Test User', email: 'testuser@example.com' }],
  alarms: [{ action: 'DISPLAY', trigger: '-PT15M', description: 'Teamrunde' }],
  attachments: [{ url: 'https://example.com/agenda', name: 'Agenda' }],
  transp: 'OPAQUE',
  classification: 'PUBLIC',
};

const TASK_FIELDS = {
  title: 'Wochenbericht',
  calendarId: 'testuser-tasks',
  description: 'Zahlen eintragen',
  priority: 1,
  duration: 'PT1H',
  alarms: [{ action: 'DISPLAY', trigger: '-PT1H', description: 'Wochenbericht' }],
};

test('Issue #515 — templates for events and tasks', async (t) => {
  const run = Date.now().toString(36);
  const alice = `testuser-515-a-${run}`;
  const bob = `testuser-515-b-${run}`;
  let aliceCookie;
  let bobCookie;

  t.before(async () => {
    if (!server.listening) await new Promise(resolve => server.listen(process.env.PORT, resolve));
    aliceCookie = await loginAs(alice, { username: 'testuser', email: 'testuser@example.com' });
    bobCookie = await loginAs(bob, { username: 'testuser2', email: 'testuser2@example.com' });
  });

  t.after(async () => {
    await Db.deleteUser(alice);
    await Db.deleteUser(bob);
    server.close();
  });

  await t.test('a saved event template is listed for its user only, with its fields', async () => {
    const res = await call(aliceCookie, 'POST', '', { kind: 'event', name: 'Teamrunde', fields: EVENT_FIELDS });
    assert.strictEqual(res.status, 201);
    const created = await res.json();
    assert.ok(created.id);
    assert.deepStrictEqual({ ...created, id: undefined }, { id: undefined, kind: 'event', name: 'Teamrunde', fields: EVENT_FIELDS });

    const list = await (await call(aliceCookie, 'GET', '?kind=event')).json();
    assert.deepStrictEqual(list.templates, [created]);
    assert.deepStrictEqual((await (await call(aliceCookie, 'GET', '?kind=task')).json()).templates, []);
    assert.deepStrictEqual((await (await call(bobCookie, 'GET', '?kind=event')).json()).templates, []);
  });

  await t.test('a task template is stored next to it', async () => {
    const res = await call(aliceCookie, 'POST', '', { kind: 'task', name: 'Wochenbericht', fields: TASK_FIELDS });
    assert.strictEqual(res.status, 201);
    const list = (await (await call(aliceCookie, 'GET', '?kind=task')).json()).templates;
    assert.deepStrictEqual(list.map(x => [x.name, x.fields]), [['Wochenbericht', TASK_FIELDS]]);
  });

  await t.test('date and time fields are refused, as is an alarm at a fixed time', async () => {
    const bad = [
      { kind: 'event', name: 'x', fields: { ...EVENT_FIELDS, start: '2036-01-01T10:00:00.000Z' } },
      { kind: 'event', name: 'x', fields: { ...EVENT_FIELDS, end: '2036-01-01T11:00:00.000Z' } },
      { kind: 'event', name: 'x', fields: { ...EVENT_FIELDS, recurrence: 'FREQ=WEEKLY' } },
      { kind: 'task', name: 'x', fields: { ...TASK_FIELDS, due: '2036-01-01T10:00:00.000Z' } },
      { kind: 'task', name: 'x', fields: { ...TASK_FIELDS, dtstart: '2036-01-01T10:00:00.000Z' } },
      { kind: 'event', name: 'x', fields: { ...EVENT_FIELDS, alarms: [{ action: 'DISPLAY', trigger: '20360101T090000Z' }] } },
      { kind: 'task', name: 'x', fields: { ...TASK_FIELDS, location: 'Raum 1' } },
      { kind: 'note', name: 'x', fields: {} },
      { kind: 'event', name: '', fields: EVENT_FIELDS },
      { kind: 'event', name: 'x', fields: { ...EVENT_FIELDS, title: 42 } },
      { kind: 'event', name: 'x' },
    ];
    for (const body of bad) {
      const res = await call(bobCookie, 'POST', '', body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual((await (await call(bobCookie, 'GET', '?kind=event')).json()).templates, []);
    assert.deepStrictEqual((await (await call(bobCookie, 'GET', '?kind=task')).json()).templates, []);
    assert.strictEqual((await call(bobCookie, 'GET', '?kind=note')).status, 400);
  });

  await t.test('a template is deleted by its user only', async () => {
    const [own] = (await (await call(aliceCookie, 'GET', '?kind=event')).json()).templates;
    assert.strictEqual((await call(bobCookie, 'DELETE', `/${own.id}`)).status, 404);
    assert.strictEqual((await (await call(aliceCookie, 'GET', '?kind=event')).json()).templates.length, 1);
    assert.strictEqual((await call(aliceCookie, 'DELETE', `/${own.id}`)).status, 200);
    assert.deepStrictEqual((await (await call(aliceCookie, 'GET', '?kind=event')).json()).templates, []);
  });

  await t.test('deleting the user deletes the templates', async () => {
    await Db.deleteUser(alice);
    assert.deepStrictEqual(await Db.listTemplates(alice, 'task'), []);
  });
});
