'use strict';

// Issue #513: weather forecast in the week and day views, opt-in. Setting a location in the settings
// is the consent to send it (rounded to about 1 km) to Bright Sky; without one nothing is sent.

const express = require('express');
const router = express.Router();
const Db = require('../db');
const { SOURCE, providerHost, isTimeZone, isLocation, roundCoordinate, getForecast } = require('../utils/weather');

// GET /api/weather/settings — { location: { latitude, longitude } | null, provider }
router.get('/settings', async (req, res, next) => {
  try {
    res.json({
      location: await Db.getWeatherLocation(req.session.userId),
      provider: { name: SOURCE, host: providerHost },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/weather/settings — { location: { latitude, longitude } | null }
router.put('/settings', async (req, res, next) => {
  const body = req.body || {};
  if (!Object.hasOwn(body, 'location') || (body.location !== null && !isLocation(body.location))) {
    return res.status(400).json({ error: 'location must be { latitude: -90…90, longitude: -180…180 } or null' });
  }
  const location = body.location && {
    latitude: roundCoordinate(body.location.latitude),
    longitude: roundCoordinate(body.location.longitude),
  };
  try {
    res.json({ location: await Db.setWeatherLocation(req.session.userId, location) });
  } catch (err) {
    next(err);
  }
});

// GET /api/weather/forecast?tz=<IANA zone> — the next days for the user's location, by local date.
router.get('/forecast', async (req, res, next) => {
  const tz = req.query.tz;
  if (!isTimeZone(tz)) return res.status(400).json({ error: 'tz must be an IANA time zone' });
  let location;
  try {
    location = await Db.getWeatherLocation(req.session.userId);
  } catch (err) {
    return next(err);
  }
  if (!location) return res.status(404).json({ error: 'Weather is off: no location set' });
  try {
    res.json({ source: SOURCE, days: await getForecast(location, tz) });
  } catch (err) {
    console.warn('[weather] forecast unavailable:', err.message);
    res.status(502).json({ error: `Weather from Bright Sky unavailable: ${err.message}` });
  }
});

module.exports = router;
