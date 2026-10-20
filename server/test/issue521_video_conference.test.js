'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3521';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

// Issue #521: one-click video conference link. The Jitsi base URL is a per-user setting, off
// (null) until the user sets one; the link is stored as RFC 7986 CONFERENCE on the event.

const test = require('node:test');
const assert = require('assert');
const Db = require('../db');
const { server } = require('../index');
const { loginAs } = require('./helpers/testSession');
const { eventToICS, parseICSToEvent } = require('../utils/ical');

const baseUrl = `http://localhost:${process.env.PORT}`;
const ROOM = 'https://meet.example.org/freeshard-abcdefghijklmnopqrst';

async function getPrefs(cookie) {
  const res = await fetch(`${baseUrl}/api/preferences`, { headers: { cookie } });
  assert.strictEqual(res.status, 200);
  return res.json();
}

function putPrefs(cookie, body) {
  return fetch(`${baseUrl}/api/preferences`, {
    method: 'PUT',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function unfold(ics) {
  return ics.replace(/\r?\n[ \t]/g, '');
}

const BASE_EVENT = {
  uid: 'issue521@example.com',
  title: 'Abstimmung',
  start: '2037-05-04T08:00:00.000Z',
  end: '2037-05-04T09:00:00.000Z',
  allDay: false,
};

test('Issue #521 — Jitsi base URL preference', async (t) => {
  const run = Date.now().toString(36);
  const alice = `testuser-521-a-${run}`;
  const bob = `testuser-521-b-${run}`;
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

  await t.test('off by default', async () => {
    assert.strictEqual((await getPrefs(aliceCookie)).conferenceBaseUrl, null);
  });

  await t.test('a base URL is stored normalised, for that user only, and null switches it off', async () => {
    const put = await putPrefs(aliceCookie, { conferenceBaseUrl: 'https://meet.example.org/' });
    assert.strictEqual(put.status, 200);
    assert.strictEqual((await put.json()).conferenceBaseUrl, 'https://meet.example.org');
    assert.strictEqual((await getPrefs(aliceCookie)).conferenceBaseUrl, 'https://meet.example.org');
    assert.strictEqual((await getPrefs(bobCookie)).conferenceBaseUrl, null);

    // A self-hosted Jitsi under a path keeps the path.
    await putPrefs(aliceCookie, { conferenceBaseUrl: 'https://shard.example.org/jitsi/' });
    assert.strictEqual((await getPrefs(aliceCookie)).conferenceBaseUrl, 'https://shard.example.org/jitsi');

    // Another setting leaves it alone.
    await putPrefs(aliceCookie, { showWeekNumbers: true });
    assert.strictEqual((await getPrefs(aliceCookie)).conferenceBaseUrl, 'https://shard.example.org/jitsi');

    const off = await putPrefs(aliceCookie, { conferenceBaseUrl: null });
    assert.strictEqual(off.status, 200);
    assert.strictEqual((await getPrefs(aliceCookie)).conferenceBaseUrl, null);
  });

  await t.test('anything but a plain http(s) base URL is refused and nothing changes', async () => {
    await putPrefs(bobCookie, { conferenceBaseUrl: 'https://meet.example.org' });
    for (const value of [
      'javascript:alert(1)',
      'ftp://meet.example.org',
      'meet.example.org',
      'https://testuser:secret@meet.example.org',
      'https://meet.example.org/?room=x',
      'https://meet.example.org/#x',
      `https://meet.example.org/${'a'.repeat(600)}`,
      '',
      42,
      true,
    ]) {
      const res = await putPrefs(bobCookie, { conferenceBaseUrl: value });
      assert.strictEqual(res.status, 400, JSON.stringify(value));
    }
    assert.strictEqual((await getPrefs(bobCookie)).conferenceBaseUrl, 'https://meet.example.org');
  });

  await t.test('an event with a script URL as conference link is refused', async () => {
    const res = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { cookie: aliceCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId: 'any', ...BASE_EVENT, conference: 'javascript:alert(1)' }),
    });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /conference/i);
  });

  await t.test('deleting the user deletes the setting', async () => {
    await Db.deleteUser(bob);
    assert.strictEqual(await Db.getConferenceBaseUrlPreference(bob), null);
  });
});

test('Issue #521 — CONFERENCE property (RFC 7986)', async (t) => {
  await t.test('a new event writes the link as CONFERENCE and reads it back', () => {
    const ics = eventToICS({ ...BASE_EVENT, conference: ROOM, description: `Videokonferenz: ${ROOM}` });
    assert.match(unfold(ics), new RegExp(`\\r\\nCONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=Videokonferenz:${ROOM}\\r\\n`));
    const parsed = parseICSToEvent(ics);
    assert.strictEqual(parsed.conference, ROOM);
    assert.strictEqual(parsed.description, `Videokonferenz: ${ROOM}`);
  });

  await t.test('an event without a link has none', () => {
    const ics = eventToICS({ ...BASE_EVENT });
    assert.doesNotMatch(ics, /CONFERENCE/);
    assert.strictEqual(parseICSToEvent(ics).conference, null);
  });

  await t.test('editing an existing event adds, replaces and removes the link, keeping other conference entries', () => {
    const foreign = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN', 'BEGIN:VEVENT',
      'UID:issue521-foreign@example.com', 'DTSTAMP:20370101T000000Z',
      'DTSTART:20370504T080000Z', 'DTEND:20370504T090000Z', 'SUMMARY:Abstimmung',
      'CONFERENCE;VALUE=URI;FEATURE=PHONE;LABEL=Einwahl:tel:+49-30-1234567',
      'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    assert.strictEqual(parseICSToEvent(foreign).conference, null, 'a dial-in number is no video link');

    const added = eventToICS({ ...BASE_EVENT, conference: ROOM }, foreign);
    assert.strictEqual(parseICSToEvent(added).conference, ROOM);
    assert.match(added, /tel:\+49-30-1234567/);

    const other = 'https://meet.example.org/freeshard-zyxwvutsrqponmlkjihg';
    const replaced = eventToICS({ ...BASE_EVENT, conference: other }, added);
    assert.strictEqual(parseICSToEvent(replaced).conference, other);
    assert.strictEqual((unfold(replaced).match(/\r\nCONFERENCE[;:]/g) || []).length, 2);

    // A save that does not mention the link keeps it.
    const untouched = eventToICS({ ...BASE_EVENT, title: 'Neu' }, replaced);
    assert.strictEqual(parseICSToEvent(untouched).conference, other);

    const removed = eventToICS({ ...BASE_EVENT, conference: null }, untouched);
    assert.strictEqual(parseICSToEvent(removed).conference, null);
    assert.doesNotMatch(removed, /freeshard-zyx/);
    assert.match(removed, /tel:\+49-30-1234567/);
  });

  await t.test('a foreign conference link with a script scheme is not passed on', () => {
    const ics = eventToICS({ ...BASE_EVENT }).replace('END:VEVENT', 'CONFERENCE;VALUE=URI:javascript:alert(1)\r\nEND:VEVENT');
    assert.strictEqual(parseICSToEvent(ics).conference, null);
  });

  await t.test('an invalid link is refused when writing', () => {
    for (const value of ['javascript:alert(1)', 'mailto:testuser@example.com', 'https://meet.example.org/a b', 42]) {
      assert.throws(() => eventToICS({ ...BASE_EVENT, conference: value }), /conference/i, String(value));
    }
  });
});
