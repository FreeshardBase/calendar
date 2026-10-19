'use strict';

// Issue #515: "Als Vorlage speichern" / "Neu aus Vorlage". A template holds the fields of an event or
// a task without date and time; it is stored per user in the app database and never synced.

const express = require('express');
const router = express.Router();
const Db = require('../db');

const isString = v => typeof v === 'string';
const isOptString = v => v === null || typeof v === 'string';
const isStringList = v => Array.isArray(v) && v.every(isString);
const isListOf = check => v => Array.isArray(v) && v.every(x => x !== null && typeof x === 'object' && check(x));

// A reminder relative to the start or due time; one at a fixed time is a date and is left out.
const RELATIVE_TRIGGER = /^[+-]?P(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/;
const isAlarm = a => isString(a.action) && isString(a.trigger) && RELATIVE_TRIGGER.test(a.trigger)
  && (a.description === undefined || isString(a.description))
  && (a.related === undefined || a.related === null || ['START', 'END'].includes(a.related));

const FIELDS = {
  event: {
    title: isString,
    calendarId: isOptString,
    allDay: v => typeof v === 'boolean',
    location: isOptString,
    description: isOptString,
    categories: isStringList,
    attendees: isListOf(a => isString(a.email) && (a.name === undefined || isString(a.name))),
    alarms: isListOf(isAlarm),
    attachments: isListOf(a => isString(a.url) && isString(a.name)),
    transp: v => ['OPAQUE', 'TRANSPARENT'].includes(v),
    classification: v => ['PUBLIC', 'PRIVATE', 'CONFIDENTIAL'].includes(v),
  },
  task: {
    title: isString,
    calendarId: isOptString,
    description: isOptString,
    priority: v => v === null || (Number.isInteger(v) && v >= 0 && v <= 9),
    duration: isOptString,
    alarms: isListOf(isAlarm),
  },
};

// The reason a body is refused, or null.
function invalidTemplate(body) {
  const allowed = FIELDS[body.kind];
  if (!allowed) return `kind must be one of: ${Object.keys(FIELDS).join(', ')}`;
  if (!isString(body.name) || !body.name.trim() || body.name.length > 200) return 'name must be a non-empty text';
  const fields = body.fields;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return 'fields must be an object';
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed[key]) return `${key} is not kept in a ${body.kind} template`;
    if (!allowed[key](value)) return `${key} has an invalid value`;
  }
  return null;
}

// GET /api/templates?kind=event|task
router.get('/', async (req, res, next) => {
  if (!FIELDS[req.query.kind]) return res.status(400).json({ error: 'kind must be event or task' });
  try {
    res.json({ templates: await Db.listTemplates(req.session.userId, req.query.kind) });
  } catch (err) {
    next(err);
  }
});

// POST /api/templates — { kind, name, fields }
router.post('/', async (req, res, next) => {
  const body = req.body || {};
  const reason = invalidTemplate(body);
  if (reason) return res.status(400).json({ error: reason });
  try {
    const created = await Db.createTemplate(req.session.userId, { kind: body.kind, name: body.name.trim(), fields: body.fields });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/templates/:id
router.delete('/:id', async (req, res, next) => {
  try {
    if (!(await Db.deleteTemplate(req.session.userId, req.params.id))) {
      return res.status(404).json({ error: 'Vorlage nicht gefunden' });
    }
    res.json({ id: req.params.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
