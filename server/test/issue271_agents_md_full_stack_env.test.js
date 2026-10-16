'use strict';

/**
 * Issue #271 (Claim 2a) — agents.md's "Full stack" procedure must work on a fresh checkout.
 *
 * `.env` is gitignored, and every service in docker-compose.yml declares `env_file: - .env`
 * (required by default in Compose). The test runs the shell commands that agents.md's
 * "Full stack" entry documents, in order, in a scratch copy of a fresh checkout (no `.env`),
 * with a `docker` stub on PATH that enforces the compose file's env_file requirement the
 * way Compose does. Without a `cp .env.example .env` step the procedure fails exactly as
 * reported: "env file .../.env not found".
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

// Stand-in for `docker compose`: every env_file listed in ./docker-compose.yml must exist.
const DOCKER_STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'compose') { console.error('stub supports only docker compose'); process.exit(2); }
const lines = fs.readFileSync('docker-compose.yml', 'utf8').split('\\n');
for (let i = 0; i < lines.length; i++) {
  if (!/^\\s+env_file:\\s*$/.test(lines[i])) continue;
  for (let j = i + 1; j < lines.length && /^\\s+-\\s/.test(lines[j]); j++) {
    const file = path.resolve(lines[j].replace(/^\\s+-\\s+/, '').trim());
    if (!fs.existsSync(file)) {
      console.error('env file ' + file + ' not found: stat ' + file + ': no such file or directory');
      process.exit(1);
    }
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
    assert.match(r.stderr, /env file .*\.env not found/);
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
