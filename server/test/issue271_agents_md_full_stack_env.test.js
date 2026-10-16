'use strict';

/**
 * Issue #271 (Claim 2a) — agents.md's "Full stack" procedure must work on a fresh checkout.
 *
 * `.env` is gitignored, and docker-compose.yml takes every secret from a required variable
 * (`${VAR:?...}`, #118) that Compose resolves from `.env`. The test runs the shell commands that
 * agents.md's "Full stack" entry documents, in order, in a scratch copy of a fresh checkout (no
 * `.env`), with a `docker` stub on PATH that enforces those required variables the way Compose
 * does. Without a `cp .env.example .env` step the procedure fails:
 * "required variable ... is missing a value".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '../..');

// The commands of the "- Full stack:" entry: its inline code spans, in document order.
function fullStackCommands() {
  const lines = fs.readFileSync(path.join(ROOT_DIR, 'agents.md'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('- Full stack:'));
  assert.ok(start >= 0, 'agents.md must have a "- Full stack:" entry');
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith('  ')) end++;
  const entry = lines.slice(start, end).join(' ');
  return [...entry.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

// Stand-in for `docker compose`: every required ${VAR:?err} in ./docker-compose.yml must have a
// non-empty value in ./.env, as Compose's interpolation demands. The shell environment is
// ignored so the test runner's own variables cannot stand in for a missing .env.
const DOCKER_STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
if (process.argv[2] !== 'compose') { console.error('stub supports only docker compose'); process.exit(2); }
const vars = {};
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) vars[m[1]] = m[2];
  }
}
const compose = fs.readFileSync('docker-compose.yml', 'utf8');
for (const [, name, message] of compose.matchAll(/\\$\\{([A-Za-z_][A-Za-z0-9_]*):\\?([^}]*)\\}/g)) {
  if (!vars[name]) {
    console.error('required variable ' + name + ' is missing a value: ' + message);
    process.exit(1);
  }
}
fs.appendFileSync('compose-invocations.log', process.argv.slice(2).join(' ') + '\\n');
`;

function freshCheckout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue271-'));
  for (const f of ['docker-compose.yml', '.env.example']) {
    fs.copyFileSync(path.join(ROOT_DIR, f), path.join(dir, f));
  }
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
  return { dir, bin };
}

test('the docker stub reproduces the reported failure on a checkout without .env', () => {
  const { dir, bin } = freshCheckout();
  try {
    const r = spawnSync('sh', ['-c', 'docker compose up --build'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /required variable [A-Z_]+ is missing a value/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agents.md "Full stack" commands, run in order on a fresh checkout, reach docker compose up', () => {
  const commands = fullStackCommands().filter((c) => /^(cp|docker)\s/.test(c));
  assert.ok(commands.some((c) => c.startsWith('docker compose up')), 'Full stack must document docker compose up');
  const { dir, bin } = freshCheckout();
  try {
    assert.ok(!fs.existsSync(path.join(dir, '.env')), 'a fresh checkout has no .env (gitignored)');
    const r = spawnSync('sh', ['-ec', commands.join('\n')], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(r.status, 0, `documented procedure failed: ${r.stderr}`);
    const log = fs.readFileSync(path.join(dir, 'compose-invocations.log'), 'utf8');
    assert.match(log, /^compose up --build$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
