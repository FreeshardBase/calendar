'use strict';

/**
 * Issue #100 — HIGH: every container runs as root on a shard
 *
 * The store template starts all three services with `user: "0:0"` because shard_core creates the
 * data bind mount root-owned and all three processes share one SQLite file. The fix is an
 * entrypoint in every image that, when started as root, hands the data directories to one fixed
 * uid:gid (1000:1000) and drops to it before the service starts.
 *
 * Root cannot be obtained in the test environment (no user namespaces), so `id`, `chown` and
 * `setpriv` are replaced by PATH stubs: `id -u` reports $FAKE_UID, `chown` records its arguments,
 * and `setpriv` records its arguments, sets FAKE_UID to the uid it was asked to drop to, and runs
 * the rest of its command line. The entrypoint script itself is the real one each Dockerfile
 * declares.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '../..');

const IMAGES = [
  { name: 'webcalendar', context: '.', service: 'webcalendar' },
  { name: 'radicale', context: 'radicale', service: 'caldav-server' },
  { name: 'sync-worker', context: 'sync-worker', service: 'sync-worker' },
];

function readDockerfile(image) {
  return fs.readFileSync(path.join(ROOT_DIR, image.context, 'Dockerfile'), 'utf8');
}

// The host file behind the first element of the image's ENTRYPOINT, resolved through its COPY line.
function entrypointScript(image) {
  const dockerfile = readDockerfile(image);
  // Docker uses the last ENTRYPOINT instruction.
  const match = [...dockerfile.matchAll(/^ENTRYPOINT\s+(.*?)\s*$/gm)].pop();
  assert.ok(match && match[1].startsWith('['), `${image.name}: Dockerfile must declare an exec-form ENTRYPOINT`);
  const containerPath = JSON.parse(match[1])[0];
  const copy = dockerfile
    .split('\n')
    .map(line => line.match(/^COPY\s+(\S+)\s+(\S+)\s*$/))
    .find(m => m && m[2] === containerPath);
  assert.ok(copy, `${image.name}: ENTRYPOINT ${containerPath} must be COPYed into the image`);
  return path.join(ROOT_DIR, image.context, copy[1]);
}

function declaredDataDirs(image) {
  const match = readDockerfile(image).match(/^ENV\s+DATA_DIRS="([^"]+)"\s*$/m);
  assert.ok(match, `${image.name}: Dockerfile must set DATA_DIRS`);
  return match[1].trim().split(/\s+/);
}

// Writable volume targets per service in docker-compose.yml (read-only mounts excluded).
function writableComposeMounts(service) {
  const lines = fs.readFileSync(path.join(ROOT_DIR, 'docker-compose.yml'), 'utf8').split('\n');
  const start = lines.findIndex(l => l === `  ${service}:`);
  assert.ok(start >= 0, `docker-compose.yml must define service ${service}`);
  const mounts = [];
  let inVolumes = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line) || /^\S/.test(line)) break;
    if (/^ {4}volumes:\s*$/.test(line)) { inVolumes = true; continue; }
    if (/^ {4}\S/.test(line)) { inVolumes = false; continue; }
    const item = inVolumes && line.match(/^ {6}- (\S+)/);
    if (item) {
      const [, target, mode] = item[1].split(':');
      if (mode !== 'ro') mounts.push(target);
    }
  }
  return mounts;
}

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue100-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const realId = spawnSync('sh', ['-c', 'command -v id'], { encoding: 'utf8' }).stdout.trim();
  const stubs = {
    id: `#!/bin/sh\nif [ "$1" = "-u" ] && [ -n "\${FAKE_UID:-}" ]; then echo "$FAKE_UID"; else exec ${realId} "$@"; fi\n`,
    chown: `#!/bin/sh\necho "$*" >> "${dir}/chown.log"\n`,
    setpriv: [
      '#!/bin/sh',
      `echo "$*" >> "${dir}/setpriv.log"`,
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --reuid=*) FAKE_UID="${1#--reuid=}"; export FAKE_UID ;;',
      '    --) shift; break ;;',
      '  esac',
      '  shift',
      'done',
      'exec "$@"',
      '',
    ].join('\n'),
  };
  for (const [name, body] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  // The service stand-in: records the uid it runs as and whether ownership was handed over first.
  const probe = path.join(dir, 'probe.sh');
  fs.writeFileSync(probe, `#!/bin/sh\necho "uid=$(id -u) home=\${HOME:-} chowned_before=$([ -f "${dir}/chown.log" ] && echo yes || echo no) args=$*" >> "${dir}/probe.log"\n`, { mode: 0o755 });
  const dataDirs = [path.join(dir, 'data'), path.join(dir, 'data', 'status')];
  fs.mkdirSync(dataDirs[1], { recursive: true });
  const read = name => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n') : []);
  return { dir, bin, probe, dataDirs, read };
}

function runEntrypoint(script, sandbox, fakeUid) {
  return spawnSync(script, [sandbox.probe, 'serve', '--flag'], {
    encoding: 'utf8',
    env: {
      PATH: `${sandbox.bin}:${process.env.PATH}`,
      HOME: fakeUid === 0 ? '/root' : '/home/testuser',
      DATA_DIRS: sandbox.dataDirs.join(' '),
      ...(fakeUid === undefined ? {} : { FAKE_UID: String(fakeUid) }),
    },
  });
}

test.describe('Issue #100 — containers drop root before the service starts', () => {
  for (const image of IMAGES) {
    test.describe(image.name, () => {
      test('started as root (store template user: "0:0"): data dirs go to 1000:1000, service runs as uid 1000', t => {
        const sandbox = makeSandbox();
        t.after(() => fs.rmSync(sandbox.dir, { recursive: true, force: true }));

        const result = runEntrypoint(entrypointScript(image), sandbox, 0);
        assert.equal(result.status, 0, `entrypoint failed: ${result.stderr}`);

        assert.deepEqual(sandbox.read('chown.log'), sandbox.dataDirs.map(d => `-R 1000:1000 ${d}`));
        assert.equal(sandbox.read('setpriv.log').length, 1, 'setpriv must be invoked exactly once');
        const setprivArgs = sandbox.read('setpriv.log')[0].split(' ');
        assert.ok(setprivArgs.includes('--reuid=1000'), `setpriv must set uid 1000: ${setprivArgs}`);
        assert.ok(setprivArgs.includes('--regid=1000'), `setpriv must set gid 1000: ${setprivArgs}`);
        assert.ok(setprivArgs.includes('--clear-groups'), `setpriv must drop root's groups: ${setprivArgs}`);
        assert.ok(setprivArgs.includes('--no-new-privs'), `setpriv must forbid regaining privileges: ${setprivArgs}`);

        assert.deepEqual(sandbox.read('probe.log'), ['uid=1000 home=/tmp chowned_before=yes args=serve --flag']);
      });

      test('started as non-root with writable data dirs: no chown, no setpriv, service runs unchanged', t => {
        const sandbox = makeSandbox();
        t.after(() => fs.rmSync(sandbox.dir, { recursive: true, force: true }));

        const result = runEntrypoint(entrypointScript(image), sandbox, 1000);
        assert.equal(result.status, 0, `entrypoint failed: ${result.stderr}`);
        assert.deepEqual(sandbox.read('chown.log'), []);
        assert.deepEqual(sandbox.read('setpriv.log'), []);
        assert.deepEqual(sandbox.read('probe.log'), ['uid=1000 home=/home/testuser chowned_before=no args=serve --flag']);
      });

      test('started as non-root with an unwritable data dir: refuses to start', t => {
        assert.notEqual(process.getuid(), 0, 'this test needs a non-root test runner');
        const sandbox = makeSandbox();
        t.after(() => {
          fs.chmodSync(sandbox.dataDirs[1], 0o755);
          fs.rmSync(sandbox.dir, { recursive: true, force: true });
        });
        fs.chmodSync(sandbox.dataDirs[1], 0o555);

        const result = runEntrypoint(entrypointScript(image), sandbox, 1000);
        assert.notEqual(result.status, 0, 'entrypoint must fail on an unwritable data dir');
        assert.match(result.stderr, new RegExp(`${sandbox.dataDirs[1]} is not writable`));
        assert.deepEqual(sandbox.read('probe.log'), [], 'the service must not start');
      });

      test('DATA_DIRS covers every writable volume the compose file mounts into the service', () => {
        const dataDirs = declaredDataDirs(image);
        const mounts = writableComposeMounts(image.service);
        assert.ok(mounts.length > 0, `${image.service} must mount a data volume`);
        for (const mount of mounts) {
          assert.ok(dataDirs.includes(mount), `${image.name}: DATA_DIRS ${dataDirs.join(' ')} must include ${mount}`);
        }
      });
    });
  }

  test('the three entrypoint copies stay identical', () => {
    const scripts = IMAGES.map(entrypointScript);
    const contents = scripts.map(s => fs.readFileSync(s, 'utf8'));
    for (let i = 1; i < contents.length; i++) {
      assert.equal(contents[i], contents[0], `${scripts[i]} must be identical to ${scripts[0]}`);
    }
  });
});
