'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3105';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { app, server } = require('../index');

test('Issue #4 — Local Color Customization for Subscribed/Shared Calendars', async (t) => {
  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await Db.clearAll().catch(() => {});

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let ownerCookie = '';
  let inviteeCookie = '';

  const ownerUserId = 'test-owner-color-customization';
  const inviteeUserId = 'test-invitee-color-customization';

  await Db.upsertUser(ownerUserId, 'owner_color@example.com');
  await Db.upsertUser(inviteeUserId, 'invitee_color@example.com');

  const ownerCalId = `internal-caldav::/${ownerUserId}/personal/`;

  await t.test('Low-level Db helper functions for local calendar color overrides', async () => {
    const calId = 'internal-caldav::/user1/test-cal/';
    
    await Db.setUserCalendarColorOverride('user1', calId, '#10b981');
    await Db.setUserCalendarColorOverride('user2', calId, '#ef4444');

    const user1Overrides = await Db.getUserCalendarColorOverrides('user1');
    const user2Overrides = await Db.getUserCalendarColorOverrides('user2');

    assert.strictEqual(user1Overrides[calId], '#10b981');
    assert.strictEqual(user2Overrides[calId], '#ef4444');

    const singleOverride = await Db.getUserCalendarColorOverride('user1', calId);
    assert.strictEqual(singleOverride, '#10b981');

    await Db.deleteUserCalendarColorOverride('user1', calId);
    const afterDelete = await Db.getUserCalendarColorOverride('user1', calId);
    assert.strictEqual(afterDelete, null);
  });

  await t.test('Authenticate user sessions', async () => {
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
  });

  await t.test('Set up shared calendar with read-only access for invitee', async () => {
    const inviteeUuid = await Db.getUserIdByUsername(inviteeUserId);
    await Db.addUserShare(ownerCalId, inviteeUuid, 0, 'ACCEPTED', 'READ');
  });

  await t.test('Invitee updates local calendar color on read-only shared calendar', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}`, {
      method: 'PATCH',
      headers: {
        'Cookie': inviteeCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ color: '#ec4899' })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.color, '#ec4899');
  });

  await t.test('Invitee cannot rename a read-only calendar', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}`, {
      method: 'PATCH',
      headers: {
        'Cookie': inviteeCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'Hacked Name' })
    });

    assert.strictEqual(res.status, 403);
  });

  await t.test('GET /api/calendars returns customized color for invitee, default color for owner', async () => {
    const resInvitee = await fetch(`${baseUrl}/api/calendars`, {
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(resInvitee.status, 200);
    const dataInvitee = await resInvitee.json();
    const inviteeCal = dataInvitee.calendars.find(c => c.id === ownerCalId);
    assert.ok(inviteeCal, 'Invitee should see shared calendar');
    assert.strictEqual(inviteeCal.color, '#ec4899');

    const resOwner = await fetch(`${baseUrl}/api/calendars`, {
      headers: { 'Cookie': ownerCookie }
    });
    assert.strictEqual(resOwner.status, 200);
    const dataOwner = await resOwner.json();
    const ownerCal = dataOwner.calendars.find(c => c.id === ownerCalId);
    assert.ok(ownerCal, 'Owner should see their calendar');
    assert.notStrictEqual(ownerCal.color, '#ec4899', 'Owner calendar color must not be overwritten by invitee override');
  });

  await t.test('Invitee resets/clears local calendar color override', async () => {
    const res = await fetch(`${baseUrl}/api/calendars/${encodeURIComponent(ownerCalId)}/color-override`, {
      method: 'DELETE',
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(res.status, 200);

    const resInvitee = await fetch(`${baseUrl}/api/calendars`, {
      headers: { 'Cookie': inviteeCookie }
    });
    assert.strictEqual(resInvitee.status, 200);
    const dataInvitee = await resInvitee.json();
    const inviteeCal = dataInvitee.calendars.find(c => c.id === ownerCalId);
    assert.notStrictEqual(inviteeCal.color, '#ec4899', 'Color override should be cleared');
  });
});
