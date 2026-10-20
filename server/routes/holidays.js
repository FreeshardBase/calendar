'use strict';

// Issue #514: public holidays as a built-in, read-only subscription. The user chooses a country and
// region in the settings; the events are computed on the shard (utils/holidays.js).

const express = require('express');
const router = express.Router();
const Db = require('../db');
const { HOLIDAY_COUNTRIES, isHolidayRegion, regionName, holidaysInRange } = require('../utils/holidays');

const DAY = 24 * 60 * 60 * 1000;
const isoDate = ms => new Date(ms).toISOString().slice(0, 10);

// GET /api/holidays/regions
router.get('/regions', (req, res) => {
  res.json({ countries: HOLIDAY_COUNTRIES });
});

// GET /api/holidays/settings — { region: 'DE-BY' | null }
router.get('/settings', async (req, res, next) => {
  try {
    res.json({ region: await Db.getHolidayRegion(req.session.userId) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/holidays/settings — { region: '<ISO 3166-2 code>' | null }
router.put('/settings', async (req, res, next) => {
  const region = (req.body || {}).region;
  if (region !== null && !isHolidayRegion(region)) {
    return res.status(400).json({ error: 'region must be a known holiday region or null' });
  }
  try {
    res.json({ region: await Db.setHolidayRegion(req.session.userId, region) });
  } catch (err) {
    next(err);
  }
});

// GET /api/holidays/events?start=&end= — all-day events of the chosen region overlapping the window
router.get('/events', async (req, res, next) => {
  const start = new Date(req.query.start);
  const end = new Date(req.query.end);
  if (!req.query.start || !req.query.end || isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
    return res.status(400).json({ error: 'Valid start and end query parameters are required' });
  }
  try {
    const region = await Db.getHolidayRegion(req.session.userId);
    if (!region) return res.status(404).json({ error: 'No holiday region chosen' });
    // All-day dates carry no zone: a day just outside the UTC window may still be visible locally.
    const holidays = holidaysInRange(region, isoDate(start.getTime() - DAY), isoDate(end.getTime() + DAY));
    const events = holidays.map(h => ({
      id: `holiday-${region}-${h.date}`,
      uid: `holiday-${region}-${h.date}`,
      title: h.name,
      description: '',
      location: '',
      start: h.date,
      end: isoDate(Date.parse(h.date) + DAY),
      allDay: true,
      readOnly: true,
    }));
    res.json({ region, name: `Feiertage (${regionName(region)})`, events });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
