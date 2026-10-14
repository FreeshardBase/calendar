'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT || '3099';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert');
const Db = require('../db');
const { calculateFreeSlots } = require('../utils/availabilityBooking');
const { app, server } = require('../index');
const { loginAs } = require('./helpers/testSession');

test('Availability Slots Booking Engine Suite', async (t) => {
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

  await Db.clearAll();

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let sessionCookie = '';
  // Owned by the session user 'testuser-id' (page creation checks calendar write access, #339)
  const testCalendarId = 'internal-caldav::/testuser-id/personal/';
  let createdPageId = '';
  let testSlug = 'testuser-consulting';

  await t.test('Initial setup - authenticate session cookie', async () => {
    sessionCookie = await loginAs('testuser-id');
    const res = await fetch(`${baseUrl}/api/accounts`, {
      headers: { cookie: sessionCookie }
    });
    assert.strictEqual(res.status, 200);
  });

  await t.test('calculateFreeSlots utility logic', () => {
    const pageConfig = {
      durationMinutes: 30,
      startHour: 9,
      endHour: 12,
      daysOfWeek: '1,2,3,4,5' // Mon-Fri
    };

    // Test Monday: 2026-08-17 (which is a Monday)
    const dateStr = '2026-08-17';
    const existingEvents = [
      { start: '2026-08-17T10:00:00.000Z', end: '2026-08-17T10:30:00.000Z' }
    ];
    const existingBookings = [
      { start_time: '2026-08-17T11:00:00.000Z', end_time: '2026-08-17T11:30:00.000Z' }
    ];

    const slots = calculateFreeSlots(pageConfig, existingEvents, existingBookings, dateStr);
    
    // Total candidate slots between 09:00 and 12:00 (30 min slots):
    // 09:00-09:30, 09:30-10:00, 10:00-10:30 (busy), 10:30-11:00, 11:00-11:30 (busy), 11:30-12:00
    // Total free slots = 4
    assert.strictEqual(slots.length, 4);
    assert.strictEqual(slots[0].startTime, '2026-08-17T09:00:00.000Z');
    assert.strictEqual(slots[1].startTime, '2026-08-17T09:30:00.000Z');
    assert.strictEqual(slots[2].startTime, '2026-08-17T10:30:00.000Z');
    assert.strictEqual(slots[3].startTime, '2026-08-17T11:30:00.000Z');

    // Test Sunday (day 0): should return 0 slots
    const sundaySlots = calculateFreeSlots(pageConfig, [], [], '2026-08-16');
    assert.strictEqual(sundaySlots.length, 0);
  });

  await t.test('Database Availability Page CRUD Operations', async () => {
    const page = await Db.createAvailabilityPage({
      userId: 'testuser-id',
      slug: testSlug,
      title: 'Test User Consultation',
      calendarId: testCalendarId,
      durationMinutes: 30,
      startHour: 9,
      endHour: 17,
      daysOfWeek: '1,2,3,4,5'
    });

    assert.ok(page.id);
    assert.strictEqual(page.slug, testSlug);
    assert.strictEqual(page.title, 'Test User Consultation');
    createdPageId = page.id;

    const pages = await Db.getAvailabilityPages('testuser-id');
    assert.strictEqual(pages.length, 1);
    assert.strictEqual(pages[0].id, createdPageId);

    const fetchedBySlug = await Db.getAvailabilityPageBySlug(testSlug);
    assert.ok(fetchedBySlug);
    assert.strictEqual(fetchedBySlug.id, createdPageId);
  });

  await t.test('REST API: POST & GET /api/availability-slots', async () => {
    // Create another page via REST
    const createRes = await fetch(`${baseUrl}/api/availability-slots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: sessionCookie
      },
      body: JSON.stringify({
        slug: 'testuser-quick-chat',
        title: 'Quick 15m Chat',
        calendarId: testCalendarId,
        durationMinutes: 15,
        startHour: 10,
        endHour: 16,
        daysOfWeek: '1,3,5'
      })
    });

    assert.strictEqual(createRes.status, 201);
    const createdData = await createRes.json();
    assert.strictEqual(createdData.slug, 'testuser-quick-chat');

    const getRes = await fetch(`${baseUrl}/api/availability-slots`, {
      headers: {
        cookie: sessionCookie
      }
    });

    assert.strictEqual(getRes.status, 200);
    const list = await getRes.json();
    assert.ok(Array.isArray(list));
    assert.strictEqual(list.length, 2);
  });

  await t.test('REST API Public Endpoints: GET & POST /api/public/availability/:slug', async () => {
    // GET public page slots for date 2026-08-17 (Monday)
    const getPublicRes = await fetch(`${baseUrl}/api/public/availability/${testSlug}?date=2026-08-17`);
    assert.strictEqual(getPublicRes.status, 200);
    const publicData = await getPublicRes.json();
    assert.strictEqual(publicData.title, 'Test User Consultation');
    assert.ok(Array.isArray(publicData.availableSlots));
    assert.ok(publicData.availableSlots.length > 0);

    const selectedSlot = publicData.availableSlots[0].startTime;

    // Book the slot
    const bookRes = await fetch(`${baseUrl}/api/public/availability/${testSlug}/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startTime: selectedSlot,
        guestName: 'Test Guest',
        guestEmail: 'testuser@example.com',
        notes: 'Discussion about upcoming project'
      })
    });

    assert.strictEqual(bookRes.status, 201);
    const bookingResult = await bookRes.json();
    assert.ok(bookingResult.bookingId);

    // Attempting to book the SAME slot again should return 409 Conflict
    const duplicateBookRes = await fetch(`${baseUrl}/api/public/availability/${testSlug}/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startTime: selectedSlot,
        guestName: 'Another Guest',
        guestEmail: 'testuser@example.com',
        notes: 'Trying to double book'
      })
    });

    assert.strictEqual(duplicateBookRes.status, 409);
  });

  await t.test('REST API: DELETE /api/availability-slots/:id', async () => {
    const deleteRes = await fetch(`${baseUrl}/api/availability-slots/${createdPageId}`, {
      method: 'DELETE',
      headers: {
        cookie: sessionCookie
      }
    });

    assert.strictEqual(deleteRes.status, 200);

    // Verify public link now returns 404
    const getPublicRes = await fetch(`${baseUrl}/api/public/availability/${testSlug}?date=2026-08-17`);
    assert.strictEqual(getPublicRes.status, 404);
  });
});
