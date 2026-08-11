'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3093';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');
const { checkResourceAvailability, bookResource, cancelResourceBooking, suggestAvailableResources } = require('../utils/resourceBooking');

test('Resource & Room Booking System Suite', async (t) => {
  const { app, server } = require('../index');

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;
  let sessionCookie = '';

  await t.test('Initial setup - authenticate session', async () => {
    const res = await fetch(`${baseUrl}/api/accounts`, {
      headers: { 'x-test-user-id': 'testuser-id' }
    });
    assert.equal(res.status, 200);
    const cookieHeader = res.headers.get('set-cookie');
    if (cookieHeader) {
      sessionCookie = cookieHeader.split(';')[0];
    }
  });

  await t.test('Database Resource CRUD Operations', async () => {
    const room = await Db.addResource({
      name: 'Konferenzraum Alpha',
      type: 'ROOM',
      capacity: 12,
      location: 'Gebäude A, 2. OG',
      status: 'AVAILABLE'
    });

    assert.ok(room.id);
    assert.equal(room.name, 'Konferenzraum Alpha');
    assert.equal(room.capacity, 12);

    const fetched = await Db.getResourceById(room.id);
    assert.ok(fetched);
    assert.equal(fetched.name, 'Konferenzraum Alpha');

    const updated = await Db.updateResource(room.id, { capacity: 15 });
    assert.equal(updated.capacity, 15);

    const list = await Db.getResources({ type: 'ROOM' });
    assert.ok(list.some(r => r.id === room.id));

    await Db.deleteResource(room.id);
    const deleted = await Db.getResourceById(room.id);
    assert.equal(deleted, null);
  });

  await t.test('Resource Booking Collision Detection & Overlap Logic', async () => {
    const room = await Db.addResource({
      name: 'Besprechungsraum Beta',
      type: 'ROOM',
      capacity: 6,
      location: 'Gebäude B, EG'
    });

    const startTime = '2026-10-01T10:00:00.000Z';
    const endTime = '2026-10-01T11:30:00.000Z';

    // 1. Initial check - should be available
    const avail1 = await checkResourceAvailability(room.id, startTime, endTime);
    assert.equal(avail1.available, true);

    // 2. Book resource
    const booking = await bookResource({
      resourceId: room.id,
      userId: 'testuser-id',
      eventUid: 'event-101',
      startTime,
      endTime
    });
    assert.ok(booking.id);
    assert.equal(booking.resourceId, room.id);
    assert.equal(booking.status, 'CONFIRMED');

    // 3. Exact overlap attempt - should be unavailable
    const avail2 = await checkResourceAvailability(room.id, startTime, endTime);
    assert.equal(avail2.available, false);
    assert.ok(avail2.conflictingBooking);

    // 4. Double booking attempt should throw / fail
    await assert.rejects(
      async () => {
        await bookResource({
          resourceId: room.id,
          userId: 'testuser-2',
          eventUid: 'event-102',
          startTime: '2026-10-01T10:30:00.000Z',
          endTime: '2026-10-01T12:00:00.000Z'
        });
      },
      (err) => err.message.includes('RESOURCE_BUSY') || err.message.includes('belegt')
    );

    // 5. Adjacent non-overlapping booking - should succeed
    const availAdjacent = await checkResourceAvailability(room.id, '2026-10-01T11:30:00.000Z', '2026-10-01T12:30:00.000Z');
    assert.equal(availAdjacent.available, true);

    // 6. Cancel booking
    await cancelResourceBooking(booking.id, 'testuser-id');
    const avail3 = await checkResourceAvailability(room.id, startTime, endTime);
    assert.equal(avail3.available, true);

    await Db.deleteResource(room.id);
  });

  await t.test('Suggest Available Resources based on capacity and time slot', async () => {
    const roomA = await Db.addResource({ name: 'Großer Saal', type: 'ROOM', capacity: 50 });
    const roomB = await Db.addResource({ name: 'Kleine Kabine', type: 'ROOM', capacity: 2 });

    const start = '2026-10-02T14:00:00.000Z';
    const end = '2026-10-02T15:00:00.000Z';

    // Book roomA during this time
    await bookResource({ resourceId: roomA.id, userId: 'testuser-id', startTime: start, endTime: end });

    // Suggest rooms with minCapacity = 2
    const suggestions = await suggestAvailableResources({ startTime: start, endTime: end, minCapacity: 2, type: 'ROOM' });
    assert.ok(suggestions.some(r => r.id === roomB.id));
    assert.ok(!suggestions.some(r => r.id === roomA.id));

    await Db.deleteResource(roomA.id);
    await Db.deleteResource(roomB.id);
  });

  await t.test('REST API Resource Endpoints & Booking Flow', async () => {
    // 1. POST /api/resources create resource
    const resCreate = await fetch(`${baseUrl}/api/resources`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
        'x-test-user-id': 'testuser-id'
      },
      body: JSON.stringify({
        name: 'Projektraum Gamma',
        type: 'ROOM',
        capacity: 8,
        location: 'Gebäude C'
      })
    });
    assert.equal(resCreate.status, 201);
    const created = await resCreate.json();
    assert.ok(created.resource.id);
    const resId = created.resource.id;

    // 2. GET /api/resources list
    const resList = await fetch(`${baseUrl}/api/resources`, {
      headers: { 'Cookie': sessionCookie, 'x-test-user-id': 'testuser-id' }
    });
    assert.equal(resList.status, 200);
    const listData = await resList.json();
    assert.ok(listData.resources.some(r => r.id === resId));

    // 3. POST /api/resources/check-availability
    const resCheck = await fetch(`${baseUrl}/api/resources/check-availability`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
        'x-test-user-id': 'testuser-id'
      },
      body: JSON.stringify({
        resourceId: resId,
        startTime: '2026-10-05T09:00:00.000Z',
        endTime: '2026-10-05T10:00:00.000Z'
      })
    });
    assert.equal(resCheck.status, 200);
    const checkData = await resCheck.json();
    assert.equal(checkData.available, true);

    // 4. POST /api/resources/bookings create booking
    const resBook = await fetch(`${baseUrl}/api/resources/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
        'x-test-user-id': 'testuser-id'
      },
      body: JSON.stringify({
        resourceId: resId,
        eventUid: 'event-gamma-1',
        startTime: '2026-10-05T09:00:00.000Z',
        endTime: '2026-10-05T10:00:00.000Z'
      })
    });
    assert.equal(resBook.status, 201);
    const bookingData = await resBook.json();
    assert.ok(bookingData.booking.id);
    const bookingId = bookingData.booking.id;

    // 5. POST /api/resources/bookings duplicate booking conflict -> 409
    const resBookDup = await fetch(`${baseUrl}/api/resources/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
        'x-test-user-id': 'testuser-id'
      },
      body: JSON.stringify({
        resourceId: resId,
        eventUid: 'event-gamma-2',
        startTime: '2026-10-05T09:30:00.000Z',
        endTime: '2026-10-05T10:30:00.000Z'
      })
    });
    assert.equal(resBookDup.status, 409);

    // 6. DELETE /api/resources/bookings/:id
    const resDelBooking = await fetch(`${baseUrl}/api/resources/bookings/${bookingId}`, {
      method: 'DELETE',
      headers: { 'Cookie': sessionCookie, 'x-test-user-id': 'testuser-id' }
    });
    assert.equal(resDelBooking.status, 200);

    // 7. DELETE /api/resources/:id
    const resDelResource = await fetch(`${baseUrl}/api/resources/${resId}`, {
      method: 'DELETE',
      headers: { 'Cookie': sessionCookie, 'x-test-user-id': 'testuser-id' }
    });
    assert.equal(resDelResource.status, 200);
  });
});
