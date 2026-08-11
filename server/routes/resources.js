'use strict';

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
    console.error('[resources get]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/resources — create resource
router.post('/', async (req, res) => {
  try {
    const { name, type, capacity, location, status } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    const resource = await Db.addResource({ name, type, capacity, location, status });
    res.status(201).json({ success: true, resource });
  } catch (err) {
    console.error('[resources create]', err.message);
    res.status(500).json({ error: err.message });
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
    console.error('[resources get id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/resources/:id — update resource
router.patch('/:id', async (req, res) => {
  try {
    const resource = await Db.updateResource(req.params.id, req.body);
    if (!resource) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    res.json({ success: true, resource });
  } catch (err) {
    console.error('[resources update]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/resources/:id — delete resource
router.delete('/:id', async (req, res) => {
  try {
    await Db.deleteResource(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[resources delete]', err.message);
    res.status(500).json({ error: err.message });
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
    console.error('[resources check-availability]', err.message);
    res.status(500).json({ error: err.message });
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
    console.error('[resources suggest]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/resources/bookings — get bookings
router.get('/bookings', async (req, res) => {
  try {
    const { resourceId, startTime, endTime } = req.query;
    const userId = req.session ? req.session.userId : (req.headers['x-test-user-id'] || 'testuser-id');
    const bookings = await Db.getResourceBookings({ resourceId, userId, startTime, endTime });
    res.json({ bookings });
  } catch (err) {
    console.error('[resources get bookings]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/resources/bookings — book resource
router.post('/bookings', async (req, res) => {
  try {
    const { resourceId, eventUid, startTime, endTime } = req.body;
    const userId = req.session ? req.session.userId : (req.headers['x-test-user-id'] || 'testuser-id');

    if (!resourceId || !startTime || !endTime) {
      return res.status(400).json({ error: 'resourceId, startTime, and endTime are required' });
    }

    const booking = await bookResource({ resourceId, userId, eventUid, startTime, endTime });
    res.status(201).json({ success: true, booking });
  } catch (err) {
    if (err.message.includes('RESOURCE_BUSY') || err.message.includes('belegt')) {
      return res.status(409).json({ error: err.message });
    }
    console.error('[resources book]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/resources/bookings/:id — cancel booking
router.delete('/bookings/:id', async (req, res) => {
  try {
    const userId = req.session ? req.session.userId : (req.headers['x-test-user-id'] || 'testuser-id');
    await cancelResourceBooking(req.params.id, userId);
    res.json({ success: true });
  } catch (err) {
    console.error('[resources cancel booking]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
