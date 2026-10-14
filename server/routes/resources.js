'use strict';
const { sendError } = require('../utils/errorSanitizer');

const express = require('express');
const router = express.Router();
const Db = require('../db');
const {
  checkResourceAvailability,
  bookResource,
  cancelResourceBooking,
  suggestAvailableResources
} = require('../utils/resourceBooking');

// GET /api/resources — list resources with optional query filters
router.get('/', async (req, res) => {
  try {
    const { type, minCapacity, status } = req.query;
    const resources = await Db.getResources({
      type,
      minCapacity: minCapacity ? parseInt(minCapacity, 10) : undefined,
      status
    });
    res.json({ resources });
  } catch (err) {
    return sendError(res, err, '[resources get]');
  }
});

// POST /api/resources — create resource
router.post('/', async (req, res) => {
  try {
    const { name, type, capacity, location, status } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    const resource = await Db.addResource({ name, type, capacity, location, status, ownerId: req.session.userId });
    res.status(201).json({ success: true, resource });
  } catch (err) {
    return sendError(res, err, '[resources create]');
  }
});

// GET /api/resources/:id — get resource detail
router.get('/:id', async (req, res) => {
  try {
    const resource = await Db.getResourceById(req.params.id);
    if (!resource) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    res.json({ resource });
  } catch (err) {
    return sendError(res, err, '[resources get id]');
  }
});

// Resources are visible to every member, but only their creator may change them.
// Foreign ids get 404 (not 403) so members cannot probe each other's ids.
async function findOwnedResource(req) {
  const resource = await Db.getResourceById(req.params.id);
  if (!resource || resource.ownerId !== req.session.userId) return null;
  return resource;
}

// PATCH /api/resources/:id — update resource
router.patch('/:id', async (req, res) => {
  try {
    if (!(await findOwnedResource(req))) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    const resource = await Db.updateResource(req.params.id, req.body);
    res.json({ success: true, resource });
  } catch (err) {
    return sendError(res, err, '[resources update]');
  }
});

// DELETE /api/resources/:id — delete resource
router.delete('/:id', async (req, res) => {
  try {
    if (!(await findOwnedResource(req))) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    await Db.deleteResource(req.params.id);
    res.json({ success: true });
  } catch (err) {
    return sendError(res, err, '[resources delete]');
  }
});

// POST /api/resources/check-availability — check if slot is available
router.post('/check-availability', async (req, res) => {
  try {
    const { resourceId, startTime, endTime, excludeBookingId } = req.body;
    if (!resourceId || !startTime || !endTime) {
      return res.status(400).json({ error: 'resourceId, startTime, and endTime are required' });
    }
    const result = await checkResourceAvailability(resourceId, startTime, endTime, excludeBookingId);
    res.json(result);
  } catch (err) {
    return sendError(res, err, '[resources check-availability]');
  }
});

// POST /api/resources/suggest — suggest available resources
router.post('/suggest', async (req, res) => {
  try {
    const { startTime, endTime, minCapacity, type } = req.body;
    if (!startTime || !endTime) {
      return res.status(400).json({ error: 'startTime and endTime are required' });
    }
    const suggestions = await suggestAvailableResources({ startTime, endTime, minCapacity, type });
    res.json({ suggestions });
  } catch (err) {
    return sendError(res, err, '[resources suggest]');
  }
});

function getUserId(req) {
  if (req.session && req.session.userId) {
    return req.session.userId;
  }
  if (process.env.NODE_ENV === 'test') {
    return (req.headers && req.headers['x-test-user-id']) || 'testuser-id';
  }
  return null;
}

// GET /api/resources/bookings — get bookings
router.get('/bookings', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { resourceId, startTime, endTime } = req.query;
    const bookings = await Db.getResourceBookings({ resourceId, userId, startTime, endTime });
    res.json({ bookings });
  } catch (err) {
    return sendError(res, err, '[resources get bookings]');
  }
});

// POST /api/resources/bookings — book resource
router.post('/bookings', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { resourceId, eventUid, startTime, endTime } = req.body;

    if (!resourceId || !startTime || !endTime) {
      return res.status(400).json({ error: 'resourceId, startTime, and endTime are required' });
    }

    const booking = await bookResource({ resourceId, userId, eventUid, startTime, endTime });
    res.status(201).json({ success: true, booking });
  } catch (err) {
    if (err.message.includes('RESOURCE_BUSY') || err.message.includes('belegt')) {
      console.error('[resources book]', err.message);
      return res.status(409).json({ error: 'Der Raum/die Ressource ist im gewählten Zeitraum bereits belegt.' });
    }
    return sendError(res, err, '[resources book]');
  }
});

// DELETE /api/resources/bookings/:id — cancel booking
router.delete('/bookings/:id', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    await cancelResourceBooking(req.params.id, userId);
    res.json({ success: true });
  } catch (err) {
    return sendError(res, err, '[resources cancel booking]');
  }
});

module.exports = router;
