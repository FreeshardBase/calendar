'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3518';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

// Issue #518: a subtask is a VTODO with RELATED-TO;RELTYPE=PARENT (RFC 5545 §3.8.4.5, RFC 9253);
// subtasks written by other clients are read and kept. Whether a task list's due tasks show in the
// calendar views is a per-user choice per list, stored on the server.

const test = require('node:test');
const assert = require('node:assert/strict');
const ICAL = require('ical.js');
const { taskToICS, parseICSToTask, isNoOpTaskSave } = require('../caldav/parser');
const tasksRouter = require('../routes/tasks');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');

const baseUrl = `http://localhost:${process.env.PORT}`;

function vtodo(lines) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//Client//EN',
    'BEGIN:VTODO', 'DTSTAMP:20360101T000000Z', ...lines, 'END:VTODO',
    'END:VCALENDAR', ''
  ].join('\r\n');
}

function relatedTo(ics) {
  const todo = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vtodo');
  return todo.getAllProperties('related-to').map(p => [p.getParameter('reltype') || null, p.getFirstValue()]);
}

// Thunderbird writes RELATED-TO without RELTYPE, which RFC 5545 defines as PARENT.
const THUNDERBIRD_CHILD = vtodo(['UID:child-tb@example.com', 'SUMMARY:Milch kaufen', 'RELATED-TO:parent-518@example.com']);
// jtx Board and Tasks.org write RELTYPE=PARENT explicitly; jtx adds further relations of its own.
const JTX_CHILD = vtodo([
  'UID:child-jtx@example.com', 'SUMMARY:Brot kaufen',
  'RELATED-TO;RELTYPE=PARENT:parent-518@example.com',
  'RELATED-TO;RELTYPE=SIBLING:child-tb@example.com',
  'X-JTX-FOREIGN:keep me',
]);

test('a RELATED-TO without RELTYPE (Thunderbird) names the parent', () => {
  assert.equal(parseICSToTask(THUNDERBIRD_CHILD).parentUid, 'parent-518@example.com');
});

test('RELTYPE=PARENT names the parent; SIBLING and CHILD do not', () => {
  assert.equal(parseICSToTask(JTX_CHILD).parentUid, 'parent-518@example.com');
  const parentWithChildLink = vtodo(['UID:p@example.com', 'SUMMARY:P', 'RELATED-TO;RELTYPE=CHILD:c@example.com']);
  assert.equal(parseICSToTask(parentWithChildLink).parentUid, null);
  assert.equal(parseICSToTask(vtodo(['UID:plain@example.com', 'SUMMARY:Plain'])).parentUid, null);
});

test('a new subtask is written with RELATED-TO;RELTYPE=PARENT', () => {
  const ics = taskToICS({ uid: 'child-new', title: 'Eier', parentUid: 'parent-518@example.com' });
  assert.deepEqual(relatedTo(ics), [['PARENT', 'parent-518@example.com']]);
  assert.equal(parseICSToTask(ics).parentUid, 'parent-518@example.com');
  assert.deepEqual(relatedTo(taskToICS({ uid: 'top', title: 'Oben', parentUid: null })), []);
});

test('editing a foreign subtask keeps its parent and every other relation and property', () => {
  const task = parseICSToTask(JTX_CHILD);
  const ics = taskToICS({ ...task, title: 'Vollkornbrot kaufen', status: 'COMPLETED', percentComplete: 100 }, JTX_CHILD);
  assert.deepEqual(relatedTo(ics), [['PARENT', 'parent-518@example.com'], ['SIBLING', 'child-tb@example.com']]);
  assert.match(ics, /X-JTX-FOREIGN:keep me/);

  // A save that does not name the parent at all leaves it alone, too.
  const { parentUid: _omit, ...withoutParent } = task;
  assert.deepEqual(relatedTo(taskToICS({ ...withoutParent, title: 'x' }, THUNDERBIRD_CHILD)), [[null, 'parent-518@example.com']]);
});

test('detaching or re-parenting a subtask changes only the parent relation', () => {
  const task = parseICSToTask(JTX_CHILD);
  assert.deepEqual(relatedTo(taskToICS({ ...task, parentUid: null }, JTX_CHILD)), [['SIBLING', 'child-tb@example.com']]);
  assert.deepEqual(
    relatedTo(taskToICS({ ...task, parentUid: 'other@example.com' }, JTX_CHILD)),
    [['SIBLING', 'child-tb@example.com'], ['PARENT', 'other@example.com']]
  );
  // Thunderbird's RELTYPE-less parent is replaced, not kept beside a second parent.
  const tb = parseICSToTask(THUNDERBIRD_CHILD);
  assert.deepEqual(relatedTo(taskToICS({ ...tb, parentUid: 'other@example.com' }, THUNDERBIRD_CHILD)), [['PARENT', 'other@example.com']]);
});

test('a save that only changes the parent is not a no-op', () => {
  assert.equal(isNoOpTaskSave(JTX_CHILD, { title: 'Brot kaufen', parentUid: 'parent-518@example.com' }), true);
  assert.equal(isNoOpTaskSave(JTX_CHILD, { title: 'Brot kaufen', parentUid: null }), false);
  assert.equal(isNoOpTaskSave(JTX_CHILD, { title: 'Brot kaufen', parentUid: 'other@example.com' }), false);
});

test('a parent UID must be a single-line text', () => {
  const { validateTaskInput } = tasksRouter;
  assert.equal(validateTaskInput({ title: 'x', parentUid: 'parent-518@example.com' }), null);
  assert.equal(validateTaskInput({ title: 'x', parentUid: null }), null);
  for (const parentUid of ['a\r\nX-EVIL:1', 42, { uid: 'x' }, 'x'.repeat(256)]) {
    assert.ok(validateTaskInput({ title: 'x', parentUid }), JSON.stringify(parentUid));
  }
});

// ── Due tasks in the calendar views, per task list ──────────────────────────

function getPrefs(cookie) {
  return fetch(`${baseUrl}/api/preferences`, { headers: { cookie } });
}

function putPrefs(cookie, body) {
  return fetch(`${baseUrl}/api/preferences`, {
    method: 'PUT',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Issue #518 — due tasks in the calendar, per task list', async (t) => {
  const run = Date.now().toString(36);
  const alice = `testuser-518-a-${run}`;
  const bob = `testuser-518-b-${run}`;
  const listA = `internal-caldav::/${alice}/tasks/`;
  const listB = `internal-caldav::/${alice}/einkauf/`;
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

  await t.test('every list shows its due tasks until the user turns it off', async () => {
    const res = await getPrefs(aliceCookie);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).tasksHiddenInCalendar, []);
  });

  await t.test('turning a list off and on again is stored for that user only', async () => {
    let res = await putPrefs(aliceCookie, { taskListInCalendar: { calendarId: listA, shown: false } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).tasksHiddenInCalendar, [listA]);
    res = await putPrefs(aliceCookie, { taskListInCalendar: { calendarId: listB, shown: false } });
    assert.deepEqual((await res.json()).tasksHiddenInCalendar.sort(), [listB, listA].sort());
    assert.deepEqual((await (await getPrefs(bobCookie)).json()).tasksHiddenInCalendar, []);

    res = await putPrefs(aliceCookie, { taskListInCalendar: { calendarId: listA, shown: true } });
    assert.deepEqual((await res.json()).tasksHiddenInCalendar, [listB]);
    // The other preferences are untouched.
    assert.equal((await (await getPrefs(aliceCookie)).json()).taskView, 'kanban');
  });

  await t.test('a malformed toggle is refused and nothing changes', async () => {
    for (const body of [
      { taskListInCalendar: { calendarId: listA } },
      { taskListInCalendar: { calendarId: listA, shown: 'no' } },
      { taskListInCalendar: { calendarId: '', shown: false } },
      { taskListInCalendar: { calendarId: 42, shown: false } },
      { taskListInCalendar: { calendarId: 'x'.repeat(1025), shown: false } },
      { taskListInCalendar: null },
    ]) {
      const res = await putPrefs(aliceCookie, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual((await (await getPrefs(aliceCookie)).json()).tasksHiddenInCalendar, [listB]);
  });

  await t.test('deleting the list or the user deletes the choice', async () => {
    await putPrefs(bobCookie, { taskListInCalendar: { calendarId: listA, shown: false } });
    await Db.deleteCalendarData(listB);
    assert.deepEqual(await Db.getTasksHiddenInCalendar(alice), []);
    assert.deepEqual(await Db.getTasksHiddenInCalendar(bob), [listA]);
    await Db.deleteUser(bob);
    assert.deepEqual(await Db.getTasksHiddenInCalendar(bob), []);
  });
});
