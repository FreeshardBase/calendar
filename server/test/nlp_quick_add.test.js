'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuickAdd } = require('../utils/nlpQuickAdd');
const express = require('express');
const session = require('express-session');
const quickAddRouter = require('../routes/quickAdd');

// Use fixed reference date: Monday, Aug 24, 2026
const REF_DATE = new Date('2026-08-24T09:00:00Z');

test('NLP Quick-Add Utility Suite', async (t) => {
  await t.test('parseQuickAdd parses simple event title without date/time', () => {
    const res = parseQuickAdd('Team Sync', REF_DATE);
    assert.equal(res.title, 'Team Sync');
    assert.equal(res.type, 'event');
    assert.equal(res.allDay, true);
    assert.equal(res.startDate, '2026-08-24');
    assert.equal(res.startTime, null);
    assert.equal(res.endTime, null);
  });

  await t.test('parseQuickAdd parses task prefix (todo:, task:, aufgabe:)', () => {
    const res1 = parseQuickAdd('todo: Buy groceries', REF_DATE);
    assert.equal(res1.title, 'Buy groceries');
    assert.equal(res1.type, 'task');

    const res2 = parseQuickAdd('Aufgabe: Bericht schreiben', REF_DATE);
    assert.equal(res2.title, 'Bericht schreiben');
    assert.equal(res2.type, 'task');
  });

  await t.test('parseQuickAdd parses relative date (tomorrow / morgen, übermorgen)', () => {
    const resMorgen = parseQuickAdd('Meeting morgen', REF_DATE);
    assert.equal(resMorgen.title, 'Meeting');
    assert.equal(resMorgen.startDate, '2026-08-25');

    const resTomorrow = parseQuickAdd('Project review tomorrow', REF_DATE);
    assert.equal(resTomorrow.title, 'Project review');
    assert.equal(resTomorrow.startDate, '2026-08-25');

    const resUebermorgen = parseQuickAdd('Workshop übermorgen', REF_DATE);
    assert.equal(resUebermorgen.startDate, '2026-08-26');
  });

  await t.test('parseQuickAdd parses weekdays (nächsten Freitag / next Friday)', () => {
    // 2026-08-24 is Monday. Next Friday is 2026-08-28.
    const res = parseQuickAdd('Sprint Planning next Friday', REF_DATE);
    assert.equal(res.title, 'Sprint Planning');
    assert.equal(res.startDate, '2026-08-28');
  });

  await t.test('parseQuickAdd parses explicit dates (YYYY-MM-DD, DD.MM.YYYY, DD.MM.)', () => {
    const res1 = parseQuickAdd('Doctor Appointment on 2026-09-15', REF_DATE);
    assert.equal(res1.title, 'Doctor Appointment');
    assert.equal(res1.startDate, '2026-09-15');

    const res2 = parseQuickAdd('Zahnarzt am 05.10.2026', REF_DATE);
    assert.equal(res2.title, 'Zahnarzt');
    assert.equal(res2.startDate, '2026-10-05');

    const res3 = parseQuickAdd('Geburtstag am 12.09.', REF_DATE);
    assert.equal(res3.title, 'Geburtstag');
    assert.equal(res3.startDate, '2026-09-12');
  });

  await t.test('parseQuickAdd parses times and time ranges', () => {
    const res1 = parseQuickAdd('Standup at 14:00', REF_DATE);
    assert.equal(res1.title, 'Standup');
    assert.equal(res1.allDay, false);
    assert.equal(res1.startTime, '14:00');
    assert.equal(res1.endTime, '15:00');

    const res2 = parseQuickAdd('Workshop 10:00 to 12:30', REF_DATE);
    assert.equal(res2.title, 'Workshop');
    assert.equal(res2.allDay, false);
    assert.equal(res2.startTime, '10:00');
    assert.equal(res2.endTime, '12:30');

    const res3 = parseQuickAdd('Call at 3pm', REF_DATE);
    assert.equal(res3.title, 'Call');
    assert.equal(res3.allDay, false);
    assert.equal(res3.startTime, '15:00');
    assert.equal(res3.endTime, '16:00');
  });

  await t.test('parseQuickAdd parses location (at ..., in ..., im ...)', () => {
    const res1 = parseQuickAdd('Meeting at Conference Room A', REF_DATE);
    assert.equal(res1.title, 'Meeting');
    assert.equal(res1.location, 'Conference Room A');

    const res2 = parseQuickAdd('Lunch im Restaurant Sol', REF_DATE);
    assert.equal(res2.title, 'Lunch');
    assert.equal(res2.location, 'Restaurant Sol');
  });

  await t.test('parseQuickAdd parses recurrence rules (every Monday, jeden Tag)', () => {
    const res1 = parseQuickAdd('Weekly Sync every Monday at 10:00', REF_DATE);
    assert.equal(res1.title, 'Weekly Sync');
    assert.equal(res1.recurrence, 'FREQ=WEEKLY;BYDAY=MO');
    assert.equal(res1.startTime, '10:00');

    const res2 = parseQuickAdd('Daily Standup jeden Tag um 09:00 Uhr', REF_DATE);
    assert.equal(res2.title, 'Daily Standup');
    assert.equal(res2.recurrence, 'FREQ=DAILY');
    assert.equal(res2.startTime, '09:00');
  });
});

test('NLP Quick-Add REST API Suite', async (t) => {
  let app;
  let server;
  let baseUrl;

  t.before(async () => {
    app = express();
    app.use(express.json());
    app.use(session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: true
    }));

    app.use((req, res, next) => {
      if (req.headers['x-test-user-id'] !== 'unauthenticated') {
        req.session.userId = 'testuser-id';
        req.session.accounts = [{ id: 'internal-caldav', username: 'testuser-id' }];
      }
      next();
    });

    app.use('/api/quick-add', (req, res, next) => {
      if (!req.session?.userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      next();
    }, quickAddRouter);

    server = app.listen(0);
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  t.after(() => {
    if (server) server.close();
  });

  await t.test('POST /api/quick-add/parse returns 401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/quick-add/parse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': 'unauthenticated'
      },
      body: JSON.stringify({ text: 'Meeting tomorrow' })
    });
    assert.equal(res.status, 401);
  });

  await t.test('POST /api/quick-add/parse returns 400 when text is missing', async () => {
    const res = await fetch(`${baseUrl}/api/quick-add/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
  });

  await t.test('POST /api/quick-add/parse returns parsed event object', async () => {
    const res = await fetch(`${baseUrl}/api/quick-add/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Design Review tomorrow at 15:00 at Room 2' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.title, 'Design Review');
    assert.equal(data.location, 'Room 2');
    assert.equal(data.allDay, false);
    assert.equal(data.startTime, '15:00');
    assert.equal(data.endTime, '16:00');
  });
});
