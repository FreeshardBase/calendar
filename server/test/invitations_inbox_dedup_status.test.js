'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3115';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const Db = require('../db');
const { loginAs } = require('./helpers/testSession');

test('Issue #88 — Invitations Inbox Deduplication and PARTSTAT Filtering', async (t) => {
  const { app, server } = require('../index');

  if (server && !server.listening) {
    await new Promise((resolve) => server.listen(process.env.PORT || 3115, resolve));
  }

  t.after(async () => {
    if (server && server.close) {
      server.close();
    }
  });

  await t.test('GET /api/events/invitations deduplicates recurring series and excludes accepted/declined/tentative/organizer items', async () => {
    const port = process.env.PORT || 3115;
    const baseUrl = `http://localhost:${port}`;
    const testUserId = 'user-bob-88';
    const testEmail = 'bob@example.com';

    await Db.upsertUser(testUserId, testEmail, testEmail);

    const calPath = `/mock-dav/calendars/${testUserId}/personal/`;
    const calId = `mock-acc-88::${calPath}`;

    try {
      await Db.addAccount(testUserId, {
        id: 'mock-acc-88',
        url: `${baseUrl}${calPath}`,
        authType: 'basic',
        username: testEmail,
        password: 'password'
      });
    } catch (err) {
      // Left over from an earlier run against the same test database.
      if (!/UNIQUE constraint failed/.test(err.message)) throw err;
    }

    const now = new Date();
    const dtstart = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    // 1. 92-occurrence daily standup (NEEDS-ACTION) -> should collapse to 1 card
    const standupIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:daily-standup-88
DTSTART:${dtstart}
DTEND:${dtstart}
RRULE:FREQ=DAILY;COUNT=92
SUMMARY:Daily Standup
ORGANIZER:mailto:lead@example.com
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${testEmail}
END:VEVENT
END:VCALENDAR`;

    // 2. Event with PARTSTAT=TENTATIVE -> excluded
    const tentativeIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev-tentative-88
DTSTART:${dtstart}
DTEND:${dtstart}
SUMMARY:Tentative Event
ORGANIZER:mailto:other@example.com
ATTENDEE;PARTSTAT=TENTATIVE:mailto:${testEmail}
END:VEVENT
END:VCALENDAR`;

    // 3. Event with PARTSTAT=ACCEPTED -> excluded
    const acceptedIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev-accepted-88
DTSTART:${dtstart}
DTEND:${dtstart}
SUMMARY:Accepted Event
ORGANIZER:mailto:other@example.com
ATTENDEE;PARTSTAT=ACCEPTED:mailto:${testEmail}
END:VEVENT
END:VCALENDAR`;

    // 4. Event with PARTSTAT=DECLINED -> excluded
    const declinedIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev-declined-88
DTSTART:${dtstart}
DTEND:${dtstart}
SUMMARY:Declined Event
ORGANIZER:mailto:other@example.com
ATTENDEE;PARTSTAT=DECLINED:mailto:${testEmail}
END:VEVENT
END:VCALENDAR`;

    // 5. User is ORGANIZER -> excluded even if listed as attendee with NEEDS-ACTION
    const organizedIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev-organized-88
DTSTART:${dtstart}
DTEND:${dtstart}
SUMMARY:Organized by Bob
ORGANIZER:mailto:${testEmail}
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${testEmail}
END:VEVENT
END:VCALENDAR`;

    // 6. User not attendee -> excluded
    const nonAttendeeIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ev-not-attendee-88
DTSTART:${dtstart}
DTEND:${dtstart}
SUMMARY:Not for Bob
ORGANIZER:mailto:other@example.com
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:charlie@example.com
END:VEVENT
END:VCALENDAR`;

    // PUT resources into mock-dav
    for (const [name, ics] of [
      ['standup.ics', standupIcs],
      ['tentative.ics', tentativeIcs],
      ['accepted.ics', acceptedIcs],
      ['declined.ics', declinedIcs],
      ['organized.ics', organizedIcs],
      ['not-attendee.ics', nonAttendeeIcs]
    ]) {
      await fetch(`${baseUrl}${calPath}${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/calendar' },
        body: ics
      });
    }

    const headers = {
      cookie: await loginAs(testUserId, { username: testEmail, email: testEmail })
    };

    const res = await fetch(`${baseUrl}/api/events/invitations`, { headers });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));

    // The 92 occurrences must collapse to exactly 1 card; tentative, accepted, declined, organizer, and non-attendee must be excluded
    assert.equal(data.length, 1, `Expected exactly 1 pending invitation (daily standup), but got ${data.length}`);
    assert.equal(data[0].uid, 'daily-standup-88', 'Card UID must be the base series UID');

    // Verify no duplicate UIDs exist
    const uids = data.map(inv => inv.uid);
    const uniqueUids = new Set(uids);
    assert.equal(uids.length, uniqueUids.size, 'Invitations inbox should contain no duplicate UIDs');

    // Verify attendee matching and pending status
    for (const inv of data) {
      assert.ok(inv.userEmail, 'Invitation must set userEmail');
      assert.equal(inv.userEmail.toLowerCase(), testEmail.toLowerCase());
      assert.ok(Array.isArray(inv.attendees));
      const att = inv.attendees.find(a => (a.email || '').toLowerCase() === inv.userEmail.toLowerCase());
      assert.ok(att, 'User must be a matched attendee on returned invitation');
      const status = (att.status || att.partstat || 'NEEDS-ACTION').toUpperCase();
      assert.notEqual(status, 'ACCEPTED', 'Accepted invitation must not appear in pending inbox');
      assert.notEqual(status, 'DECLINED', 'Declined invitation must not appear in pending inbox');
      assert.notEqual(status, 'TENTATIVE', 'Tentative invitation must not appear in pending inbox');
    }

    // Now verify that RSVP'ing with TENTATIVE clears the card from the inbox
    const rsvpRes = await fetch(`${baseUrl}/api/events/${data[0].uid}/rsvp`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: data[0].calendarId,
        href: data[0].href,
        email: testEmail,
        status: 'TENTATIVE'
      })
    });
    const rsvpText = await rsvpRes.text();
    assert.equal(rsvpRes.status, 200, `RSVP failed: ${rsvpText}`);
    const rsvpData = JSON.parse(rsvpText);
    assert.equal(rsvpData.status, 'TENTATIVE');

    // Subsequent fetch must return empty list (0 pending invitations)
    const afterRsvpRes = await fetch(`${baseUrl}/api/events/invitations`, { headers });
    assert.equal(afterRsvpRes.status, 200);
    const afterData = await afterRsvpRes.json();
    assert.equal(afterData.length, 0, 'Card must be cleared from invitations inbox upon RSVP TENTATIVE');
  });
});
