'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3101';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');

test('Issue #2 — Notification & Share Acceptance Workflow for Shared Calendars', async (t) => {
  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll();

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let ownerCookie = '';
  let inviteeCookie = '';
  let strangerCookie = '';

  const ownerUserId = 'test-owner-share-workflow';
  const inviteeUserId = 'test-invitee-share-workflow';
  const strangerUserId = 'test-stranger-share-workflow';

  await Db.upsertUser(ownerUserId, 'owner_share_workflow@example.com');
  await Db.upsertUser(inviteeUserId, 'invitee_share_workflow@example.com');
  await Db.upsertUser(strangerUserId, 'stranger_share_workflow@example.com');

  const ownerCalId = `internal-caldav::/${ownerUserId}/personal/`;
  const timeQuery = '&start=2026-01-01T00:00:00Z&end=2026-12-31T23:59:59Z';

  await t.test('Authenticate user sessions', async () => {
    ownerCookie = await loginAs(ownerUserId);
    const res1 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: ownerCookie }
    });
    assert.strictEqual(res1.status, 200);

    inviteeCookie = await loginAs(inviteeUserId);
    const res2 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: inviteeCookie }
    });
    assert.strictEqual(res2.status, 200);

    strangerCookie = await loginAs(strangerUserId);
    const res3 = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: strangerCookie }
    });
    assert.strictEqual(res3.status, 200);
  });

  let invitationId = '';

  await t.test('Owner posts share invite to invitee, creating PENDING invitation', async () => {
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

    // Check shares on calendar
    const sharesRes = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/shares`, {
      headers: { 'Cookie': ownerCookie }
    });
    assert.strictEqual(sharesRes.status, 200);
    const sharesData = await sharesRes.json();
    const match = (sharesData.shares || []).find(s => s.shareeUserId === inviteeUserId || s.commonName === inviteeUserId);
    assert.ok(match, 'Share should exist');
    assert.strictEqual(match.status, 'PENDING', 'New share invitation status should be PENDING');
    invitationId = match.id;
  });

  await t.test('Invitee cannot access calendar while invitation is PENDING', async () => {
    const res = await fetch(`${baseUrl}/api/events?calendarId=${encodeURIComponent(ownerCalId)}${timeQuery}`, {
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(res.status, 403, 'Pending share must not grant calendar access');
  });

  await t.test('GET /api/calendars/share-invitations returns 401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/share-invitations`);
    assert.strictEqual(res.status, 401);
  });

  await t.test('GET /api/calendars/share-invitations lists pending invitation for invitee', async () => {
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

  await t.test('Stranger cannot accept invitee invitation (returns 403)', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/share-invitations/${invitationId}/accept`, {
      method: 'POST',
      headers: { 'Cookie': strangerCookie }
    });
    assert.strictEqual(res.status, 403);
  });

  await t.test('Invitee accepts share invitation via POST /api/calendars/share-invitations/:id/accept', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/share-invitations/${invitationId}/accept`, {
      method: 'POST',
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'ACCEPTED');
  });

  await t.test('Invitee gains access to calendar after ACCEPTED', async () => {
    const res = await fetch(`${baseUrl}/api/events?calendarId=${encodeURIComponent(ownerCalId)}${timeQuery}`, {
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(res.status, 200, 'Accepted share must grant access to calendar');
  });

  await t.test('Invitee declines share invitation via POST /api/calendars/share-invitations/:id/decline', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/share-invitations/${invitationId}/decline`, {
      method: 'POST',
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'DECLINED');

    // Access revoked
    const accessRes = await fetch(`${baseUrl}/api/events?calendarId=${encodeURIComponent(ownerCalId)}${timeQuery}`, {
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(accessRes.status, 403, 'Declined share must block access');
  });
});
