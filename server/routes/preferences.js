'use strict';

// Issue #498: per-user UI choices that follow the user to every browser.

const express = require('express');
const router = express.Router();
const Db = require('../db');

const TASK_VIEWS = ['list', 'kanban'];

// GET /api/preferences
router.get('/', async (req, res, next) => {
  try {
    res.json({ taskView: await Db.getTaskViewPreference(req.session.userId) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/preferences — { taskView: 'list' | 'kanban' }
router.put('/', async (req, res, next) => {
  const { taskView } = req.body || {};
  if (!TASK_VIEWS.includes(taskView)) {
    return res.status(400).json({ error: `taskView must be one of: ${TASK_VIEWS.join(', ')}` });
  }
  try {
    res.json({ taskView: await Db.setTaskViewPreference(req.session.userId, taskView) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
