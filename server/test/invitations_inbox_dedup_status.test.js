'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3115';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Issue #88 — Invitations Inbox Deduplication and PARTSTAT Filtering', async (t) => {
  const { app, server } = require('../index');

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await t.test('GET /api/events/invitations deduplicates recurring series and excludes accepted/declined items', async () => {
    // We can test the handler directly or via HTTP request if mock server is running
    const port = process.env.PORT || 3115;
    const baseUrl = `http://localhost:${port}`;

    const res = await fetch(`${baseUrl}/api/events/invitations`, {
      headers: {
        'x-test-user-id': 'user-bob-88',
        'x-test-username': 'bob@example.com'
      }
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    
    // Verify no duplicate UIDs exist in returned pending invitations
    const uids = data.map(inv => inv.uid);
    const uniqueUids = new Set(uids);
    assert.equal(uids.length, uniqueUids.size, 'Invitations inbox should contain no duplicate UIDs');

    // Verify all returned invitations have user as matching attendee with pending status
    for (const inv of data) {
      assert.ok(inv.userEmail, 'Invitation must set userEmail');
      if (Array.isArray(inv.attendees)) {
        const att = inv.attendees.find(a => (a.email || '').toLowerCase() === inv.userEmail.toLowerCase());
        assert.ok(att, 'User must be a matched attendee on returned invitation');
        const status = (att.status || att.partstat || 'NEEDS-ACTION').toUpperCase();
        assert.notEqual(status, 'ACCEPTED', 'Accepted invitation must not appear in pending inbox');
        assert.notEqual(status, 'DECLINED', 'Declined invitation must not appear in pending inbox');
      }
    }
  });
});
