'use strict';

const util = require('node:util');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * Issue #344: the server's logger. Each entry is one JSON line
 * `{"time","level","msg","reqId"?}`; error and warn go to stderr, info and debug to stdout.
 * The arguments are formatted like console.log after credentials are redacted: values under
 * credential-like keys, the password in URL userinfo, and Basic/Bearer header values.
 * LOG_LEVEL (debug | info | warn | error, default info) drops entries below it.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SINKS = { debug: 'log', info: 'log', warn: 'warn', error: 'error' };
const REDACTED = '[REDACTED]';
const SECRET_KEY = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|credential|private[-_]?key/i;

const requestStore = new AsyncLocalStorage();

function redactString(text) {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]*@/gi, `$1${REDACTED}@`)
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/g, `$1 ${REDACTED}`);
}

function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    const stack = redactString(value.stack || `${value.name}: ${value.message}`);
    return value.cause === undefined ? stack : `${stack}\nCaused by: ${util.format(redact(value.cause, seen))}`;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  const out = {};
  for (const [key, v] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? REDACTED : redact(v, seen);
  return out;
}

function createLogger({ level = process.env.LOG_LEVEL || 'info' } = {}) {
  if (!(level in LEVELS)) throw new Error(`LOG_LEVEL must be one of ${Object.keys(LEVELS).join(', ')}, got "${level}"`);
  const threshold = LEVELS[level];
  const write = (name) => (...args) => {
    if (LEVELS[name] < threshold) return;
    const entry = { time: new Date().toISOString(), level: name, msg: util.format(...args.map((a) => redact(a))) };
    const reqId = requestStore.getStore()?.reqId;
    if (reqId) entry.reqId = reqId;
    console[SINKS[name]](JSON.stringify(entry));
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

// Express middleware: every request gets an id, returned as X-Request-Id and attached to each
// entry logged while it is served.
function requestContext(req, res, next) {
  const reqId = crypto.randomUUID();
  req.id = reqId;
  res.setHeader('X-Request-Id', reqId);
  requestStore.run({ reqId }, next);
}

module.exports = { ...createLogger(), createLogger, requestContext, redact };
