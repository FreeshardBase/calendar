'use strict';

/**
 * Issue #239 — the e2e browser and the e2e server must run in fixed, different time zones.
 *
 * If both share a zone, every clock assertion in the Playwright suite passes vacuously. The guard
 * resolves the zones the way a real run does: it loads playwright.config.js in a child process
 * under a given ambient TZ (the browser zone is `use.timezoneId`), then spawns a node process with
 * the env Playwright hands the webServer command (ambient env overlaid with `webServer.env`) and
 * asks it which zone it resolved. Ambient values include the server-side zone itself, so a config
 * that merely tracks the ambient env collapses the two and goes red.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'playwright.config.js');
const AMBIENT_TZ = [undefined, 'UTC', 'Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe'];

function ambientEnv(tz) {
  const env = { ...process.env };
  delete env.TZ;
  if (tz !== undefined) env.TZ = tz;
  return env;
}

function loadConfig(env) {
  const script = [
    `const c = require(${JSON.stringify(CONFIG_PATH)});`,
    'process.stdout.write(JSON.stringify({ use: c.use, serverEnv: c.webServer.env || {} }));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, env, encoding: 'utf8' });
  return JSON.parse(out);
}

function serverZone(env, serverEnv) {
  return execFileSync(process.execPath, ['-e',
    'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)'],
  { cwd: REPO_ROOT, env: { ...env, ...serverEnv }, encoding: 'utf8' });
}

test('Issue #239: browser and server zones are pinned and differ under any ambient TZ', () => {
  const seen = AMBIENT_TZ.map((tz) => {
    const env = ambientEnv(tz);
    const { use, serverEnv } = loadConfig(env);
    return { ambient: tz, browser: use.timezoneId, server: serverZone(env, serverEnv) };
  });

  for (const s of seen) {
    assert.ok(s.browser, `browser timezoneId unset (ambient TZ=${s.ambient})`);
    assert.notEqual(s.browser, s.server,
      `browser and server share zone ${s.server} under ambient TZ=${s.ambient}: clock assertions are vacuous`);
  }
  assert.equal(new Set(seen.map((s) => s.browser)).size, 1,
    `browser zone tracks the ambient env: ${JSON.stringify(seen)}`);
  assert.equal(new Set(seen.map((s) => s.server)).size, 1,
    `server zone tracks the ambient env: ${JSON.stringify(seen)}`);
});

test('Issue #239: browser and server zones have different UTC offsets in summer and winter', () => {
  const env = ambientEnv('UTC');
  const { use, serverEnv } = loadConfig(env);
  const server = serverZone(env, serverEnv);
  const offset = (zone, iso) => new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(iso)).find((p) => p.type === 'timeZoneName').value;
  for (const iso of ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z']) {
    assert.notEqual(offset(use.timezoneId, iso), offset(server, iso),
      `browser ${use.timezoneId} and server ${server} share an offset at ${iso}`);
  }
});

test('Issue #239: the browser runs the German locale the UI is written in', () => {
  for (const tz of AMBIENT_TZ) {
    assert.equal(loadConfig(ambientEnv(tz)).use.locale, 'de-DE', `ambient TZ=${tz}`);
  }
});
