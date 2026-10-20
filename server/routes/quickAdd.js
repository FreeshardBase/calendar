'use strict';
const log = require('../utils/logger');

const express = require('express');
const router = express.Router();
const { parseQuickAdd } = require('../utils/nlpQuickAdd');
const { checkCalendarAccess } = require('../utils/calendarAuth');

// ── POST /api/quick-add/parse ─────────────────────────────────────────────────
router.post('/parse', (req, res) => {
  try {
    const { text, refDate } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }

    const referenceDate = refDate ? new Date(refDate) : new Date();
    const result = parseQuickAdd(text, referenceDate);
    res.json(result);
  } catch (err) {
    log.error('[quick-add parse]', err.message);
    res.status(400).json({ error: 'Der Text konnte nicht als Termin erkannt werden.' });
  }
});

module.exports = router;
