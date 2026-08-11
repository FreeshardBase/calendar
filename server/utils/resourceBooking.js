'use strict';

const Db = require('../db');

async function checkResourceAvailability(resourceId, startTime, endTime, excludeBookingId = null) {
  if (!resourceId || !startTime || !endTime) {
    throw new Error('resourceId, startTime, and endTime are required');
  }
  return Db.checkResourceAvailability(resourceId, startTime, endTime, excludeBookingId);
}

async function bookResource({ resourceId, userId, eventUid = null, startTime, endTime }) {
  if (!resourceId || !userId || !startTime || !endTime) {
    throw new Error('resourceId, userId, startTime, and endTime are required');
  }
  return Db.createResourceBooking({ resourceId, userId, eventUid, startTime, endTime });
}

async function cancelResourceBooking(bookingId, userId = null) {
  if (!bookingId) {
    throw new Error('bookingId is required');
  }
  return Db.cancelResourceBooking(bookingId, userId);
}

async function suggestAvailableResources({ startTime, endTime, minCapacity = 1, type = 'ROOM' }) {
  if (!startTime || !endTime) {
    throw new Error('startTime and endTime are required');
  }

  const allResources = await Db.getResources({ type, minCapacity, status: 'AVAILABLE' });
  const available = [];

  for (const res of allResources) {
    const check = await Db.checkResourceAvailability(res.id, startTime, endTime);
    if (check.available) {
      available.push(res);
    }
  }

  return available;
}

module.exports = {
  checkResourceAvailability,
  bookResource,
  cancelResourceBooking,
  suggestAvailableResources
};
