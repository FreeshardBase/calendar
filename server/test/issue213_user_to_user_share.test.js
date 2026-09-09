'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3213';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { app, server } = require('../index');

const baseUrl = `http://localhost:${process.env.PORT}`;

test('Issue #213 — User-to-User Calendar Sharing & Sabotage Prevention Suite', async (t) => {
  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll().catch(() => {});

  let ownerCookie = '';
  let inviteeCookie = '';
  let strangerCookie = '';

  const ownerUserId = 'test-owner-213';
  const inviteeUserId = 'test-invitee-213';
  const strangerUserId = 'test-stranger-213';

  await Db.upsertUser(ownerUserId, 'owner213@example.com');
  await Db.upsertUser(inviteeUserId, 'invitee213@example.com');
  await Db.upsertUser(strangerUserId, 'stranger213@example.com');

  const ownerCalId = `internal-caldav::/${ownerUserId}/personal/`;
  const timeQuery = '&start=2026-01-01T00:00:00Z&end=2026-12-31T23:59:59Z';

  await t.test('1. Authenticate user sessions for owner, invitee, and stranger', async () => {
    const res1 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': ownerUserId }
    });
    assert.strictEqual(res1.status, 200);
    ownerCookie = res1.headers.get('set-cookie').split(';')[0];

    const res2 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': inviteeUserId }
    });
    assert.strictEqual(res2.status, 200);
    inviteeCookie = res2.headers.get('set-cookie').split(';')[0];

    const res3 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': strangerUserId }
    });
    assert.strictEqual(res3.status, 200);
    strangerCookie = res3.headers.get('set-cookie').split(';')[0];
  });

  let invitationId = '';

  await t.test('2. Owner posts share invite to invitee, creating PENDING invitation', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      method: 'POST',
      headers: {
        'Cookie': ownerCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sharee: inviteeUserId,
        readWrite: true
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.message, 'Share invite sent.');

    const sharesRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      headers: { 'Cookie': ownerCookie }
    });
    assert.strictEqual(sharesRes.status, 200);
    const sharesData = await sharesRes.json();
    const match = (sharesData.shares || []).find(s => s.shareeUserId === inviteeUserId || s.commonName === inviteeUserId);
    assert.ok(match, 'Share should exist in owner shares list');
    assert.strictEqual(match.status, 'PENDING', 'New share invitation status must be PENDING');
    invitationId = match.id;
  });

  await t.test('3. Invitee cannot access calendar events while invitation is PENDING', async () => {
    const res = await fetch(`${baseUrl}/api/events?calendarId=${encodeURIComponent(ownerCalId)}${timeQuery}`, {
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(res.status, 403, 'Pending share must not grant calendar event access');
  });

  await t.test('4. GET /api/calendars/share-invitations lists pending invitation for invitee', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/share-invitations`, {
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.invitations), 'Should return array of invitations');
    const invite = data.invitations.find(i => i.id === invitationId || i.calendarId === ownerCalId);
    assert.ok(invite, 'Pending invitation should be listed for invitee');
    assert.strictEqual(invite.status, 'PENDING');
  });

  await t.test('5. Share Sabotage Prevention: Stranger cannot accept invitee invitation (403 Forbidden)', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/share-invitations/${invitationId}/accept`, {
      method: 'POST',
      headers: { 'Cookie': strangerCookie }
    });
    assert.strictEqual(res.status, 403, 'Stranger must be forbidden from accepting someone else invitation');
  });

  await t.test('6. Share Sabotage Prevention: Stranger cannot grant self-share on foreign calendar (403 Forbidden)', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      method: 'POST',
      headers: {
        'Cookie': strangerCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sharee: strangerUserId,
        readWrite: true
      })
    });
    assert.strictEqual(res.status, 403, 'Stranger must be forbidden from granting shares on owner calendar');
  });

  await t.test('7. Invitee accepts share invitation via POST /api/calendars/share-invitations/:id/accept', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/share-invitations/${invitationId}/accept`, {
      method: 'POST',
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'ACCEPTED');
  });

  await t.test('8. Invitee gains read/write access to calendar after ACCEPTED', async () => {
    const res = await fetch(`${baseUrl}/api/events?calendarId=${encodeURIComponent(ownerCalId)}${timeQuery}`, {
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(res.status, 200, 'Accepted share must grant access to calendar');
  });

  await t.test('9. Owner can update granular share permissions for internal user share', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares/${inviteeUserId}`, {
      method: 'PUT',
      headers: {
        'Cookie': ownerCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        role: 'READ',
        readWrite: false,
        canViewPrivate: false,
        canManageShares: false
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.message, 'Share permissions updated.');

    const sharesRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      headers: { 'Cookie': ownerCookie }
    });
    const sharesData = await sharesRes.json();
    const match = (sharesData.shares || []).find(s => s.shareeUserId === inviteeUserId || s.commonName === inviteeUserId);
    assert.ok(match);
    assert.strictEqual(match.readWrite, false);
    assert.strictEqual(match.role, 'READ');
  });

  await t.test('10. Share Sabotage Prevention: Stranger cannot revoke share on owner calendar (403 Forbidden)', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      method: 'DELETE',
      headers: {
        'Cookie': strangerCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sharee: inviteeUserId
      })
    });
    assert.strictEqual(res.status, 403, 'Stranger must be forbidden from revoking shares on owner calendar');
  });

  await t.test('11. Owner can revoke share, terminating invitee access', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      method: 'DELETE',
      headers: {
        'Cookie': ownerCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sharee: inviteeUserId
      })
    });
    assert.strictEqual(res.status, 200);

    const accessRes = await fetch(`${baseUrl}/api/events?calendarId=${encodeURIComponent(ownerCalId)}${timeQuery}`, {
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(accessRes.status, 403, 'Revoked share must block invitee access');
  });

  await t.test('12. GET /api/calendars/:id/shares returns 403 Forbidden for stranger', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      headers: { 'Cookie': strangerCookie }
    });
    assert.strictEqual(res.status, 403, 'Stranger must be forbidden from reading calendar shares list');
  });
});
