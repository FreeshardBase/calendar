'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Db = require('../db');
const sharedTestDbKeyEnv = require('./helpers/sharedTestDbKeyEnv');

test('Issue #145 — Foreign Keys Enforcement & Connection Pragma Enabling', async (t) => {
  await t.test('1. Node Db connection has PRAGMA foreign_keys enabled', async () => {
    const row = await new Promise((resolve, reject) => {
      Db.db.get('PRAGMA foreign_keys', (err, r) => {
        if (err) return reject(err);
        resolve(r);
      });
    });
    assert.ok(row, 'PRAGMA foreign_keys query returned result');
    assert.equal(Object.values(row)[0], 1, 'PRAGMA foreign_keys should be 1 (ON) on Node Db connection');
  });

  // Every SQLite connection the Python side opens records, when it is closed, whether foreign
  // keys were enforced on it. The real functions run against a temporary database.
  const pyScript = `
import json, os, sqlite3, sys, tempfile, types

opened = []
class RecordingConnection(sqlite3.Connection):
    def close(self):
        opened.append(self.execute('PRAGMA foreign_keys').fetchone()[0])
        super().close()
_connect = sqlite3.connect
sqlite3.connect = lambda *a, **k: _connect(*a, factory=RecordingConnection, **k)

def run(label, fn):
    del opened[:]
    fn()
    return {'label': label, 'connections': list(opened)}

m_radicale = types.ModuleType('radicale')
m_auth = types.ModuleType('radicale.auth')
m_rights = types.ModuleType('radicale.rights')
m_pathutils = types.ModuleType('radicale.pathutils')
class Base:
    def __init__(self, configuration):
        self.configuration = configuration
m_auth.BaseAuth = Base
m_rights.BaseRights = Base
m_pathutils.strip_path = lambda p: p.strip('/')
m_radicale.pathutils = m_pathutils
sys.modules.update({'radicale': m_radicale, 'radicale.auth': m_auth, 'radicale.rights': m_rights, 'radicale.pathutils': m_pathutils})
sys.path[0:0] = [${JSON.stringify(path.join(__dirname, '../../radicale'))}, ${JSON.stringify(path.join(__dirname, '../../sync-worker'))}]

db_path = os.path.join(tempfile.mkdtemp(), 'webcalendar.db')
seed = _connect(db_path)
seed.executescript('''
  CREATE TABLE users (user_id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL);
  CREATE TABLE app_passwords (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE user_calendar_shares (calendar_id TEXT, sharee_user_id TEXT, read_write INTEGER, role TEXT, status TEXT);
  CREATE TABLE sync_queue (id INTEGER PRIMARY KEY, status TEXT, updated_at INTEGER);
  INSERT INTO users VALUES ('testuser', 'testuser');
''')
seed.commit()
seed.close()
os.environ['DATABASE_PATH'] = db_path
os.environ['RADICALE_COLLECTIONS_FOLDER'] = os.path.join(os.path.dirname(db_path), 'no-collections')
os.environ.pop('SYSTEM_SYNC_SECRET', None)

import radicale_custom_auth, radicale_custom_rights, sync_worker
print(json.dumps([
    run('radicale_custom_auth.Auth._login', lambda: radicale_custom_auth.Auth({})._login('testuser', 'wrong-password')),
    run('radicale_custom_rights.Rights.authorization', lambda: radicale_custom_rights.Rights({}).authorization('testuser', '/otheruser/personal/')),
    run('sync_worker.recover_stranded_jobs', lambda: sync_worker.recover_stranded_jobs(db_path)),
]))
`;

  const result = spawnSync('python3', ['-c', pyScript], { env: { ...process.env, ...sharedTestDbKeyEnv }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const { label, connections } of JSON.parse(result.stdout.trim().split('\n').pop())) {
    await t.test(`Python ${label} enforces foreign keys on every connection it opens`, () => {
      assert.ok(connections.length > 0, `${label} must open the database`);
      assert.deepEqual(connections, connections.map(() => 1), `${label}: PRAGMA foreign_keys per connection`);
    });
  }

  // The real constraints on a freshly booted database are checked in issue206_schema_from_boot.test.js.
});
