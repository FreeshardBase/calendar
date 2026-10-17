'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3124';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const {
  grantDelegatePermission,
  revokeDelegatePermission,
  getDelegatesForPrincipal,
  getPrincipalsForDelegate,
  checkDelegateAccess,
  decorateEventForDelegate
} = require('../utils/delegatePermissions');

test('Delegate Permissions System Suite', async (t) => {
  const { app, server } = require('../index');
  const { loginAs } = require('./helpers/testSession');

  t.before(async () => {
    if (!server.listening) {
      await new Promise((resolve) => server.listen(process.env.PORT, resolve));
    }
  });

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;
  const principalId = 'executive-user@example.com';
  const delegateId = 'assistant-user@example.com';

  await t.test('Database & Utility - grant and query delegate permissions', async () => {
    await Db.upsertUser(principalId, principalId);
    await Db.upsertUser(delegateId, delegateId);

    const granted = await grantDelegatePermission({
      principalUserId: principalId,
      delegateUserId: delegateId,
      calendarId: 'work-cal',
      role: 'DELEGATE_WRITE',
      canManageInvitations: 1,
      canViewPrivate: 0,
      canManageDelegates: 0
    });

    assert.ok(granted.id, 'Permission ID should be generated');
    assert.equal(granted.principal_user_id, principalId);
    assert.equal(granted.delegate_user_id, delegateId);

    const delegates = await getDelegatesForPrincipal(principalId);
    assert.equal(delegates.length, 1);
    assert.equal(delegates[0].delegate_user_id, delegateId);

    const principals = await getPrincipalsForDelegate(delegateId);
    assert.equal(principals.length, 1);
    assert.equal(principals[0].principal_user_id, principalId);
  });

  await t.test('Utility - checkDelegateAccess rules', async () => {
    const canWrite = await checkDelegateAccess({
      principalUserId: principalId,
      delegateUserId: delegateId,
      calendarId: 'work-cal',
      action: 'WRITE',
      isPrivate: false,
      isInvitation: false
    });
    assert.equal(canWrite.allowed, true);

    const canViewPrivate = await checkDelegateAccess({
      principalUserId: principalId,
      delegateUserId: delegateId,
      calendarId: 'work-cal',
      action: 'READ',
      isPrivate: true,
      isInvitation: false
    });
    assert.equal(canViewPrivate.allowed, false);

    const canAccessOther = await checkDelegateAccess({
      principalUserId: principalId,
      delegateUserId: delegateId,
      calendarId: 'personal-cal',
      action: 'READ',
      isPrivate: false,
      isInvitation: false
    });
    assert.equal(canAccessOther.allowed, false);
  });

  await t.test('Utility - decorateEventForDelegate appends delegate metadata', () => {
    const origEvent = { title: 'Strategy Meeting', start: '2026-08-20T10:00:00Z' };
    const decorated = decorateEventForDelegate(origEvent, principalId, delegateId);
    assert.equal(decorated.sentBy, delegateId);
    assert.equal(decorated.onBehalfOf, principalId);
    assert.ok(decorated.xDelegateBy.includes(delegateId));
  });

  await t.test('REST API Endpoints - /api/delegates management', async () => {
    const principalCookie = await loginAs(principalId);
    const delegateCookie = await loginAs(delegateId);

    // GET /api/delegates
    const resGet = await fetch(`${baseUrl}/api/delegates`, {
      headers: { cookie: principalCookie }
    });
    assert.equal(resGet.status, 200);
    const bodyGet = await resGet.json();
    assert.ok(Array.isArray(bodyGet.delegates));

    // POST /api/delegates - update permission to include private events & admin
    const resPost = await fetch(`${baseUrl}/api/delegates`, {
      method: 'POST',
      headers: {
        cookie: principalCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        delegateUserId: delegateId,
        calendarId: 'work-cal',
        role: 'DELEGATE_ADMIN',
        canManageInvitations: 1,
        canViewPrivate: 1,
        canManageDelegates: 1
      })
    });
    assert.equal(resPost.status, 200);
    const bodyPost = await resPost.json();
    assert.equal(bodyPost.role, 'DELEGATE_ADMIN');

    // Re-verify private access after update
    const privateAccess = await checkDelegateAccess({
      principalUserId: principalId,
      delegateUserId: delegateId,
      calendarId: 'work-cal',
      action: 'READ',
      isPrivate: true
    });
    assert.equal(privateAccess.allowed, true);

    // GET /api/delegates/principals as assistant user
    const resPrincipals = await fetch(`${baseUrl}/api/delegates/principals`, {
      headers: { cookie: delegateCookie }
    });
    assert.equal(resPrincipals.status, 200);
    const bodyPrincipals = await resPrincipals.json();
    assert.ok(bodyPrincipals.principals.some(p => p.principal_user_id === principalId));

    // DELETE /api/delegates/:id
    const resDel = await fetch(`${baseUrl}/api/delegates/${bodyPost.id}`, {
      method: 'DELETE',
      headers: { cookie: principalCookie }
    });
    assert.equal(resDel.status, 200);

    const postDelDelegates = await getDelegatesForPrincipal(principalId);
    assert.equal(postDelDelegates.length, 0);
  });
});
