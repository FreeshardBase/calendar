'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
// Issue #128 — VALARM triggers must survive a read/write round trip unchanged:
// RELATED=END keeps its anchor, absolute triggers are written as
// TRIGGER;VALUE=DATE-TIME, every alarm is kept, malformed triggers are refused
// on the HTTP write path, and an unparseable CalDAV resource is reported
// instead of silently dropped. Runs with production semantics.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue128-'));
// The DB opens asynchronously on require; remove its directory only at exit.
process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
process.env.NODE_ENV = 'production';
delete process.env.E2E_TEST;
process.env.DATABASE_PATH = path.join(tmpDir, 'issue128.db');
process.env.ENCRYPTION_KEY = 'issue128-strong-encryption-key-for-tests-0123456789';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.OUTBOUND_FETCH_ALLOW_HOSTS = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const ICAL = require('ical.js');

const { parseICSToEvent, eventToICS, updateWholeSeries, isNoOpEventSave } = require('../utils/ical');
const { parseEventList } = require('../caldav/parser');
const eventsRouter = require('../routes/events');

function icsWithAlarms(alarmBlocks) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//Issue128//EN',
    'BEGIN:VEVENT',
    'UID:issue128-alarm',
    'DTSTAMP:20260801T000000Z',
    'DTSTART:20260810T090000Z',
    'DTEND:20260810T100000Z',
    'SUMMARY:Test User meeting',
    ...alarmBlocks.flatMap(trigger => [
      'BEGIN:VALARM', 'ACTION:DISPLAY', trigger, 'DESCRIPTION:Reminder', 'END:VALARM'
    ]),
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

// Re-parse the written ICS with ical.js and return each VALARM's TRIGGER as
// { type, related, value } — what a CalDAV server will actually see.
function writtenTriggers(ics) {
  const vevent = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vevent');
  return vevent.getAllSubcomponents('valarm').map(a => {
    const p = a.getFirstProperty('trigger');
    return { type: p.type, related: p.getParameter('related') || null, value: p.getFirstValue().toString() };
  });
}

function triggerLines(ics) {
  return ics.split(/\r?\n/).filter(l => l.startsWith('TRIGGER'));
}

// Both server write paths: a fresh serialisation, and the in-place update of
// the stored ICS that PUT /api/events uses.
function roundTrips(source) {
  const ev = parseICSToEvent(source);
  return {
    parsed: ev,
    fresh: eventToICS({ ...ev, rawIcs: null }),
    inPlace: updateWholeSeries(source, ev)
  };
}

test('Issue #128 — VALARM trigger round trip', async (t) => {
  await t.test('control: a plain relative trigger survives unchanged', () => {
    const { fresh, inPlace } = roundTrips(icsWithAlarms(['TRIGGER:-PT15M']));
    for (const out of [fresh, inPlace]) {
      assert.deepEqual(writtenTriggers(out), [{ type: 'duration', related: null, value: '-PT15M' }]);
    }
  });

  await t.test('RELATED=END keeps its anchor instead of being retimed to the start', () => {
    const { parsed, fresh, inPlace } = roundTrips(icsWithAlarms(['TRIGGER;RELATED=END:-PT15M']));
    assert.equal(parsed.alarms[0].related, 'END');
    for (const out of [fresh, inPlace]) {
      assert.deepEqual(writtenTriggers(out), [{ type: 'duration', related: 'END', value: '-PT15M' }]);
      assert.deepEqual(triggerLines(out), ['TRIGGER;RELATED=END:-PT15M']);
    }
  });

  await t.test('an absolute trigger is written as TRIGGER;VALUE=DATE-TIME (no bare TRIGGER:<date>)', () => {
    const { fresh, inPlace } = roundTrips(icsWithAlarms(['TRIGGER;VALUE=DATE-TIME:20260809T200000Z']));
    for (const out of [fresh, inPlace]) {
      assert.deepEqual(triggerLines(out), ['TRIGGER;VALUE=DATE-TIME:20260809T200000Z']);
      assert.deepEqual(writtenTriggers(out), [{ type: 'date-time', related: null, value: '2026-08-09T20:00:00Z' }]);
    }
  });

  await t.test('the in-place update keeps unrelated stored properties when an absolute trigger is present', () => {
    const source = icsWithAlarms(['TRIGGER;VALUE=DATE-TIME:20260809T200000Z'])
      .replace('SUMMARY:Test User meeting', 'SUMMARY:Test User meeting\r\nX-TESTUSER-CUSTOM:keep-me');
    const out = updateWholeSeries(source, parseICSToEvent(source));
    assert.ok(out.includes('X-TESTUSER-CUSTOM:keep-me'), 'in-place update must not fall back to regenerating the ICS');
  });

  await t.test('every alarm of a multi-alarm event is written back with its own parameters', () => {
    const { parsed, fresh, inPlace } = roundTrips(icsWithAlarms([
      'TRIGGER:-PT15M', 'TRIGGER;RELATED=END:-PT1H', 'TRIGGER;VALUE=DATE-TIME:20260809T200000Z'
    ]));
    assert.equal(parsed.alarms.length, 3);
    for (const out of [fresh, inPlace]) {
      assert.deepEqual(triggerLines(out), [
        'TRIGGER:-PT15M', 'TRIGGER;RELATED=END:-PT1H', 'TRIGGER;VALUE=DATE-TIME:20260809T200000Z'
      ]);
    }
  });

  await t.test('a floating absolute trigger is read in the DTSTART zone and written back as UTC', () => {
    const source = icsWithAlarms(['TRIGGER;VALUE=DATE-TIME:20260809T220000'])
      .replace('DTSTART:20260810T090000Z', 'DTSTART;TZID=Europe/Berlin:20260810T110000');
    const { parsed, fresh, inPlace } = roundTrips(source);
    assert.equal(parsed.alarms[0].trigger, '2026-08-09T20:00:00Z');
    assert.deepEqual(triggerLines(fresh), ['TRIGGER;VALUE=DATE-TIME:20260809T200000Z']);
    // Saved back unchanged, the in-place update keeps the stored VALARM as it was.
    assert.deepEqual(triggerLines(inPlace), ['TRIGGER;VALUE=DATE-TIME:20260809T220000']);
  });

  await t.test('an absolute trigger with its own TZID is converted from that zone, not the DTSTART zone', () => {
    const source = icsWithAlarms(['TRIGGER;VALUE=DATE-TIME;TZID=America/New_York:20260809T160000'])
      .replace('DTSTART:20260810T090000Z', 'DTSTART;TZID=Europe/Berlin:20260810T110000');
    assert.equal(parseICSToEvent(source).alarms[0].trigger, '2026-08-09T20:00:00Z');
  });

  await t.test('changing only RELATED (END to START) is a real change, not a no-op, and is written', () => {
    const source = icsWithAlarms(['TRIGGER;RELATED=END:-PT15M']);
    const ev = parseICSToEvent(source);
    const toStart = { ...ev, alarms: [{ ...ev.alarms[0], related: undefined }] };
    assert.equal(isNoOpEventSave(source, ev), true, 'control: an unchanged save is a no-op');
    assert.equal(isNoOpEventSave(source, toStart), false);
    assert.deepEqual(triggerLines(updateWholeSeries(source, toStart)), ['TRIGGER:-PT15M']);
  });

  await t.test('an alarm saved back unchanged keeps its stored REPEAT, DURATION and X- properties', () => {
    const source = icsWithAlarms(['TRIGGER:-PT15M', 'TRIGGER:-PT1H'])
      .replace('TRIGGER:-PT15M', 'TRIGGER:-PT15M\r\nREPEAT:2\r\nDURATION:PT5M\r\nX-TESTUSER-ALARM:keep');
    const ev = parseICSToEvent(source);
    const out = updateWholeSeries(source, ev);
    for (const line of ['REPEAT:2', 'DURATION:PT5M', 'X-TESTUSER-ALARM:keep']) {
      assert.ok(out.includes(line), `stored alarm property ${line} must survive`);
    }
    // A changed alarm is rebuilt from the request, so its old extras go with it.
    const changed = updateWholeSeries(source, { ...ev, alarms: [{ ...ev.alarms[0], trigger: '-PT30M' }, ev.alarms[1]] });
    assert.deepEqual(triggerLines(changed), ['TRIGGER:-PT30M', 'TRIGGER:-PT1H']);
    assert.ok(!changed.includes('X-TESTUSER-ALARM:keep'));
  });

  await t.test('push evaluation fires a RELATED=END alarm relative to the event end', () => {
    const { evaluateUpcomingAlarms } = require('../utils/webPushNotifications');
    const now = new Date('2026-08-10T12:00:00Z');
    const ev = {
      uid: 'issue128-push', title: 'Test User meeting',
      start: '2026-08-09T09:00:00Z', end: '2026-08-10T12:10:00Z',
      alarms: [{ action: 'DISPLAY', trigger: '-PT15M', related: 'END' }]
    };
    // End-anchored: 11:55 today, inside a 60-minute lookback. Start-anchored
    // would be 08:45 yesterday, far outside it.
    const fired = evaluateUpcomingAlarms([ev], { now, windowMinutes: 15, lookbackMinutes: 60 });
    assert.equal(fired.length, 1);
    assert.equal(new Date(fired[0].alarmTime).toISOString(), '2026-08-10T11:55:00.000Z');
  });

  await t.test('eventToICS and updateWholeSeries refuse a malformed trigger instead of writing it', () => {
    const base = {
      uid: 'issue128-bad', title: 'x',
      start: '2026-08-10T09:00:00.000Z', end: '2026-08-10T10:00:00.000Z'
    };
    const bad = [
      { trigger: 'garbage' },
      { trigger: '15 minutes' },
      { trigger: '-PT' },
      { trigger: 'P15X' },
      { trigger: 'PT15M30H' },
      { trigger: '20261340T250000Z' },                   // shaped like a UTC date-time, but no such date
      { trigger: '2026-08-09T20:00:00' },               // floating absolute trigger: RFC 5545 requires UTC
      { trigger: '-PT15M', related: 'MIDDLE' },
      { trigger: '2026-08-09T20:00:00Z', related: 'END' } // RELATED is only legal on a duration
    ];
    for (const alarm of bad) {
      assert.throws(() => eventToICS({ ...base, alarms: [alarm] }), /trigger|RELATED/i, JSON.stringify(alarm));
      assert.throws(() => updateWholeSeries(icsWithAlarms(['TRIGGER:-PT15M']), { ...base, alarms: [alarm] }),
        /trigger|RELATED/i, JSON.stringify(alarm));
    }
    // A non-array alarms value must not silently become "no alarms".
    assert.throws(() => eventToICS({ ...base, alarms: { trigger: '-PT15M' } }), /alarms/i);
    assert.throws(() => updateWholeSeries(icsWithAlarms(['TRIGGER:-PT15M']), { ...base, alarms: { trigger: '-PT15M' } }), /alarms/i);
    // Positive control: the legal forms are accepted.
    for (const trigger of ['-PT15M', 'PT0S', '-P1W', '+P1DT2H', '-PT1H5S', '20260809T200000Z', '2026-08-09T20:00:00.000Z']) {
      assert.doesNotThrow(() => eventToICS({ ...base, alarms: [{ trigger }] }), trigger);
    }
  });
});

test('Issue #128 — POST and PUT /api/events reject a malformed alarms[].trigger with 400', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: 'testuser' }; next(); });
  app.use('/api/events', eventsRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/events`;
    const body = {
      calendarId: 'acc::/testuser/cal/',
      title: 'x',
      start: '2026-08-10T09:00:00.000Z',
      end: '2026-08-10T10:00:00.000Z'
    };
    for (const alarms of [
      [{ action: 'DISPLAY', trigger: '2026-08-09T20:00:00' }],
      [{ action: 'DISPLAY', trigger: 'garbage' }],
      [{ action: 'DISPLAY', trigger: '-PT15M', related: 'MIDDLE' }],
      ['-PT15M'],
      { trigger: '-PT15M' }
    ]) {
      const post = await fetch(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, alarms })
      });
      assert.equal(post.status, 400, `POST ${JSON.stringify(alarms)}`);
      assert.match((await post.json()).error, /alarm|trigger|RELATED/i);

      const put = await fetch(`${base}/issue128`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, href: '/testuser/cal/issue128.ics', etag: '"1"', alarms })
      });
      assert.equal(put.status, 400, `PUT ${JSON.stringify(alarms)}`);
      assert.match((await put.json()).error, /alarm|trigger|RELATED/i);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

const GOOD_ICS = icsWithAlarms(['TRIGGER:-PT15M']);
const BROKEN_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:issue128-broken\r\nDTSTART:not-a-date\r\n';

// The parse error message quotes the "€" value; neither it nor the href is a legal raw header byte.
const NON_LATIN1_ICS = icsWithAlarms(['TRIGGER:-PT15M'])
  .replace('UID:issue128-alarm', 'UID:issue128-euro')
  .replace('DTSTART:20260810T090000Z', 'DTSTART:2026-€-T::');

function reportXml(calPath, withNonLatin1 = false, extraBroken = []) {
  const resp = (name, data) => `<d:response><d:href>${calPath}${name}</d:href><d:propstat><d:prop>` +
    `<d:getetag>"1"</d:getetag><c:calendar-data>${data.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</c:calendar-data>` +
    '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    resp('good.ics', GOOD_ICS) + resp('broken.ics', BROKEN_ICS) +
    (withNonLatin1 ? resp('br€ken.ics', NON_LATIN1_ICS) : '') +
    extraBroken.map(name => resp(name, BROKEN_ICS)).join('') + '</d:multistatus>';
}

test('Issue #128 — an unparseable CalDAV resource is reported, not silently dropped', async (t) => {
  await t.test('parseEventList hands the failing href to the caller', () => {
    const parseErrors = [];
    const events = parseEventList(reportXml('/testuser/cal/'), 'acc::/testuser/cal/', 'acc', 'http://dav.example.com/testuser/cal/',
      new Date('2026-08-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'), parseErrors);
    assert.deepEqual(events.map(e => e.title), ['Test User meeting']);
    assert.equal(parseErrors.length, 1);
    assert.equal(parseErrors[0].href, '/testuser/cal/broken.ics');
    assert.ok(parseErrors[0].error, 'the parse error message is passed along');
  });

  await t.test('GET /api/events returns the readable events and names the unreadable resource in X-CalDAV-Unparseable', async () => {
    const calPath = '/testuser/cal/';
    const dav = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.method === 'PROPFIND') {
          res.writeHead(207, { 'Content-Type': 'application/xml' });
          return res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
            `<d:response><d:href>${calPath}</d:href><d:propstat><d:prop>` +
            '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Test</d:displayname>' +
            '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>' +
            '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>');
        }
        if (req.method === 'REPORT') {
          res.writeHead(207, { 'Content-Type': 'application/xml' });
          return res.end(reportXml(calPath, true, ['b1.ics', 'b2.ics', 'b3.ics', 'b4.ics', 'b5.ics']));
        }
        res.writeHead(405);
        res.end();
      });
    });
    await new Promise(resolve => dav.listen(0, '127.0.0.1', resolve));
    const davUrl = `http://127.0.0.1:${dav.address().port}/`;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.session = {
        userId: 'testuser',
        accounts: [{ id: 'acc', authType: 'basic', url: davUrl, username: 'testuser', password: 'testpass' }]
      };
      next();
    });
    app.use('/api/events', eventsRouter);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/events?start=2026-08-01T00:00:00Z&end=2026-09-01T00:00:00Z`);
      assert.equal(res.status, 200);
      const events = await res.json();
      assert.deepEqual(events.map(e => e.title), ['Test User meeting']);
      const header = res.headers.get('x-caldav-unparseable');
      assert.ok(header, 'the dropped resources must be reported in X-CalDAV-Unparseable');
      const reported = JSON.parse(decodeURIComponent(header));
      // Seven failures counted; the list names only the first five so the header stays small.
      assert.equal(reported.count, 7);
      assert.deepEqual(reported.resources.map(r => r.href),
        ['broken.ics', 'br€ken.ics', 'b1.ics', 'b2.ics', 'b3.ics'].map(n => `${calPath}${n}`));
      assert.ok(reported.resources.every(r => r.calendarId === `acc::${calPath}`));
    } finally {
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => dav.close(resolve));
    }
  });
});
