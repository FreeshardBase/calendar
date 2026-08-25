'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3094';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('assert');
const Db = require('../db');
const { evaluateWorkingHoursPolicy } = require('../utils/workingHoursPolicy');
const { app, server } = require('../index');

const baseUrl = `http://localhost:${process.env.PORT}`;

test('Working Hours Policy Suite', async (t) => {
  let sessionCookie = '';

  t.before(async () => {
    // Obtain session cookie
    const res = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': 'test' }
    });
    const cookieHeader = res.headers.get('set-cookie');
    if (cookieHeader) {
      sessionCookie = cookieHeader.split(';')[0];
    }
  });

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  await t.test('Database Policy Persistence Lifecycle', async () => {
    const userId = 'testuser-wh-db-' + Date.now();
    
    // Default policy when none exists
    const defaultPolicy = await Db.getWorkingHoursPolicy(userId);
    assert.strictEqual(defaultPolicy.startHour, 9);
    assert.strictEqual(defaultPolicy.endHour, 17);
    assert.strictEqual(defaultPolicy.workDays, '1,2,3,4,5');
    assert.strictEqual(defaultPolicy.autoDecline, 0);

    // Upsert custom policy
    const customPolicy = {
      startHour: 8,
      endHour: 16,
      workDays: '1,2,3,4',
      autoDecline: 1,
      oooEnabled: 1,
      oooStart: '2026-08-15',
      oooEnd: '2026-08-25',
      oooMessage: 'Test User is currently out of office.'
    };

    await Db.upsertWorkingHoursPolicy(userId, customPolicy);
    const updated = await Db.getWorkingHoursPolicy(userId);
    assert.strictEqual(updated.startHour, 8);
    assert.strictEqual(updated.endHour, 16);
    assert.strictEqual(updated.workDays, '1,2,3,4');
    assert.strictEqual(updated.autoDecline, 1);
    assert.strictEqual(updated.oooEnabled, 1);
    assert.strictEqual(updated.oooStart, '2026-08-15');
    assert.strictEqual(updated.oooEnd, '2026-08-25');
    assert.strictEqual(updated.oooMessage, 'Test User is currently out of office.');
  });

  await t.test('evaluateWorkingHoursPolicy Logic', () => {
    const policy = {
      startHour: 9,
      endHour: 17,
      workDays: '1,2,3,4,5', // Mon-Fri
      autoDecline: 1,
      oooEnabled: 1,
      oooStart: '2026-08-20T00:00:00Z',
      oooEnd: '2026-08-25T23:59:59Z',
      oooMessage: 'Test User on vacation'
    };

    // 1. Within working hours on a Monday (2026-08-10 is Monday)
    const inWorkingHours = evaluateWorkingHoursPolicy('2026-08-10T10:00:00Z', '2026-08-10T11:00:00Z', policy);
    assert.strictEqual(inWorkingHours.outsideWorkingHours, false);
    assert.strictEqual(inWorkingHours.isOutOfOffice, false);
    assert.strictEqual(inWorkingHours.shouldAutoDecline, false);

    // 2. Before working hours (07:00 AM)
    const beforeHours = evaluateWorkingHoursPolicy('2026-08-10T07:00:00Z', '2026-08-10T08:00:00Z', policy);
    assert.strictEqual(beforeHours.outsideWorkingHours, true);
    assert.strictEqual(beforeHours.shouldAutoDecline, true);

    // 3. Weekend (2026-08-16 is Sunday)
    const weekend = evaluateWorkingHoursPolicy('2026-08-16T10:00:00Z', '2026-08-16T11:00:00Z', policy);
    assert.strictEqual(weekend.outsideWorkingHours, true);
    assert.strictEqual(weekend.shouldAutoDecline, true);

    // 4. Within OOO date range (2026-08-21)
    const oooEvent = evaluateWorkingHoursPolicy('2026-08-21T10:00:00Z', '2026-08-21T11:00:00Z', policy);
    assert.strictEqual(oooEvent.isOutOfOffice, true);
    assert.strictEqual(oooEvent.shouldAutoDecline, true);
    assert.strictEqual(oooEvent.declineMessage, 'Test User on vacation');
  });

  await t.test('REST Endpoints GET and POST /api/working-hours', async () => {
    // GET initial policy
    const getRes = await fetch(`${baseUrl}/api/working-hours`, {
      headers: { Cookie: sessionCookie }
    });
    assert.strictEqual(getRes.status, 200);
    const initialData = await getRes.json();
    assert.strictEqual(typeof initialData.startHour, 'number');

    // POST update policy
    const postRes = await fetch(`${baseUrl}/api/working-hours`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie
      },
      body: JSON.stringify({
        startHour: 9,
        endHour: 18,
        workDays: '1,2,3,4,5',
        autoDecline: 1,
        oooEnabled: 1,
        oooStart: '2026-09-01',
        oooEnd: '2026-09-10',
        oooMessage: 'Test User is away'
      })
    });
    assert.strictEqual(postRes.status, 200);
    const postData = await postRes.json();
    assert.strictEqual(postData.success, true);
    assert.strictEqual(postData.policy.endHour, 18);
    assert.strictEqual(postData.policy.oooEnabled, 1);

    // Evaluate Endpoint
    const evalRes = await fetch(`${baseUrl}/api/working-hours/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie
      },
      body: JSON.stringify({
        startTime: '2026-09-05T10:00:00Z',
        endTime: '2026-09-05T11:00:00Z'
      })
    });
    assert.strictEqual(evalRes.status, 200);
    const evalData = await evalRes.json();
    assert.strictEqual(evalData.isOutOfOffice, true);
    assert.strictEqual(evalData.shouldAutoDecline, true);
  });
});
