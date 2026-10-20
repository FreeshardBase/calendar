'use strict';

// Issue #149: multi-statement operations must apply completely or not at all — also when another
// caller in this process overlaps in time. Failures are injected with SQLite triggers scoped to
// this test's own rows, so they hit whichever connection runs the statement.

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uniq = (label) => `testuser-149-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function sql(method, statement, params = []) {
  return new Promise((resolve, reject) => {
    Db.db[method](statement, params, function (err, value) {
      if (err) return reject(err);
      resolve(method === 'run' ? this : value);
    });
  });
}

async function withFailingTrigger(name, definition, body) {
  await sql('run', `CREATE TRIGGER ${name} ${definition} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  try {
    return await body();
  } finally {
    await sql('run', `DROP TRIGGER IF EXISTS ${name}`);
  }
}

async function seedMSGraphAccount(userId, mappings) {
  const accountId = uniq('acct');
  const now = Date.now();
  await sql('run',
    'INSERT INTO msgraph_accounts (id, user_id, account_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [accountId, userId, 'testuser@example.com', now, now]);
  for (let i = 0; i < mappings; i++) {
    await sql('run',
      'INSERT INTO msgraph_event_mappings (local_uid, graph_id, account_id, last_synced_at) VALUES (?, ?, ?, ?)',
      [`${accountId}-uid-${i}`, `${accountId}-graph-${i}`, accountId, now]);
  }
  // #614: the mirror is the last thing deleteMSGraphAccount unpairs; the mappings stay.
  await sql('run',
    `INSERT INTO msgraph_calendar_collections (account_id, user_id, graph_calendar_id, local_collection, created_at)
     VALUES (?, ?, 'cal', ?, ?)`, [accountId, userId, `msgraph-${accountId}`, now]);
  return accountId;
}

async function msgraphState(accountId) {
  const account = await sql('get', 'SELECT id FROM msgraph_accounts WHERE id = ?', [accountId]);
  const { n } = await sql('get', 'SELECT COUNT(*) AS n FROM msgraph_event_mappings WHERE account_id = ?', [accountId]);
  const { detached } = await sql('get', 'SELECT COUNT(*) AS detached FROM detached_mirrors WHERE former_account_id = ?', [accountId]);
  return { accountPresent: Boolean(account), mappings: n, detached };
}

async function cleanupMSGraph(accountId) {
  await sql('run', 'DELETE FROM msgraph_calendar_collections WHERE account_id = ?', [accountId]);
  await sql('run', 'DELETE FROM detached_mirrors WHERE former_account_id = ?', [accountId]);
  await sql('run', 'DELETE FROM msgraph_event_mappings WHERE account_id = ?', [accountId]);
  await sql('run', 'DELETE FROM msgraph_accounts WHERE id = ?', [accountId]);
}

test('Db.withTransaction commits when the callback resolves and rolls back when it throws', async () => {
  const committed = uniq('commit');
  const rolledBack = uniq('rollback');
  await Db.withTransaction(async (tx) => {
    await tx.run('INSERT INTO users (user_id, username) VALUES (?, ?)', [committed, committed]);
  });
  await assert.rejects(
    Db.withTransaction(async (tx) => {
      await tx.run('INSERT INTO users (user_id, username) VALUES (?, ?)', [rolledBack, rolledBack]);
      throw new Error('Simulated failure');
    }),
    /Simulated failure/
  );
  assert.ok(await sql('get', 'SELECT 1 FROM users WHERE user_id = ?', [committed]));
  assert.equal(await sql('get', 'SELECT 1 FROM users WHERE user_id = ?', [rolledBack]), undefined);
  await Db.deleteUser(committed);
});

test('deleteMSGraphAccount keeps the account when unpairing its mirrors fails', async () => {
  const userId = uniq('owner');
  const accountId = await seedMSGraphAccount(userId, 2);
  try {
    await withFailingTrigger('t149_fail_mappings_single',
      `BEFORE DELETE ON msgraph_calendar_collections WHEN OLD.account_id = '${accountId}'`,
      () => assert.rejects(Db.deleteMSGraphAccount(accountId), /injected failure/));
    assert.deepEqual(await msgraphState(accountId), { accountPresent: true, mappings: 2, detached: 0 });
  } finally {
    await cleanupMSGraph(accountId);
  }
});

test('addSyncJob keeps the previous PENDING job when its INSERT fails', async () => {
  const userId = uniq('sync');
  const prior = await Db.addSyncJob(userId);
  try {
    await withFailingTrigger('t149_fail_sync_insert',
      `BEFORE INSERT ON sync_queue WHEN NEW.user_id = '${userId}'`,
      () => assert.rejects(Db.addSyncJob(userId), /injected failure/));
    const rows = await sql('all', 'SELECT id, status FROM sync_queue WHERE user_id = ?', [userId]);
    assert.deepEqual(rows, [{ id: prior.id, status: 'PENDING' }]);
  } finally {
    await Db.deleteUser(userId);
  }
});

test('clearAll rolls back its earlier deletes when a later one fails', async () => {
  const userId = uniq('clear');
  const token = uniq('token');
  await Db.upsertUser(userId, userId);
  await sql('run',
    'INSERT INTO app_passwords (id, user_id, label, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    [token, userId, 'Test', 'hash', Date.now()]);
  await sql('run',
    'INSERT INTO calendar_shares (token, calendar_id, label, created_at) VALUES (?, ?, ?, ?)',
    [token, `acc::/${userId}/cal/`, 'Test', Date.now()]);
  try {
    await withFailingTrigger('t149_fail_clearall',
      `BEFORE DELETE ON calendar_shares WHEN OLD.token = '${token}'`,
      () => assert.rejects(Db.clearAll(), /injected failure/));
    assert.ok(await sql('get', 'SELECT 1 FROM app_passwords WHERE id = ?', [token]), 'app_passwords delete was rolled back');
  } finally {
    await sql('run', 'DELETE FROM calendar_shares WHERE token = ?', [token]);
    await Db.deleteUser(userId);
  }
});

test('an overlapping transaction does not commit a failed deleteMSGraphAccount half-way', async () => {
  const unrelated = uniq('unrelated');
  const userId = uniq('owner');
  const accountId = await seedMSGraphAccount(userId, 3);
  try {
    await withFailingTrigger('t149_fail_mappings_overlap',
      `BEFORE DELETE ON msgraph_calendar_collections WHEN OLD.account_id = '${accountId}'`,
      async () => {
        // Caller A holds a transaction open (e.g. waiting on a busy lock) while caller B arrives.
        const a = Db.withTransaction(async (tx) => {
          await tx.run('INSERT INTO users (user_id, username) VALUES (?, ?)', [unrelated, unrelated]);
          await sleep(150);
        });
        await sleep(20);
        const b = Db.deleteMSGraphAccount(accountId);
        const [aResult, bResult] = await Promise.allSettled([a, b]);
        assert.equal(aResult.status, 'fulfilled');
        assert.equal(bResult.status, 'rejected');
        assert.match(bResult.reason.message, /injected failure/);
      });
    assert.deepEqual(await msgraphState(accountId), { accountPresent: true, mappings: 3, detached: 0 },
      'a failed delete must leave neither an orphan nor a missing account');
  } finally {
    await cleanupMSGraph(accountId);
    await Db.deleteUser(unrelated);
  }
});

test('a failing overlapping transaction does not erase an unrelated addSyncJob', async () => {
  const userId = uniq('victim');
  const a = Db.withTransaction(async (tx) => {
    await tx.run('DELETE FROM sync_queue WHERE user_id = ?', [uniq('nobody')]);
    await sleep(150);
    throw new Error('opener failed');
  });
  await sleep(20);
  const b = Db.addSyncJob(userId);
  const [aResult, bResult] = await Promise.allSettled([a, b]);
  try {
    assert.equal(aResult.status, 'rejected');
    assert.equal(bResult.status, 'fulfilled', `addSyncJob failed: ${bResult.reason && bResult.reason.message}`);
    const rows = await sql('all', 'SELECT id FROM sync_queue WHERE user_id = ?', [userId]);
    assert.deepEqual(rows, [{ id: bResult.value.id }], 'the job addSyncJob reported must exist');
  } finally {
    await Db.deleteUser(userId);
  }
});

test('a nested withTransaction is a savepoint: its failure undoes only its own writes', async () => {
  const outerUser = uniq('outer');
  const innerUser = uniq('inner');
  await Db.withTransaction(async (tx) => {
    await tx.run('INSERT INTO users (user_id, username) VALUES (?, ?)', [outerUser, outerUser]);
    await assert.rejects(
      Db.withTransaction(async (inner) => {
        await inner.run('INSERT INTO users (user_id, username) VALUES (?, ?)', [innerUser, innerUser]);
        throw new Error('inner failed');
      }),
      /inner failed/
    );
  });
  try {
    assert.ok(await sql('get', 'SELECT 1 FROM users WHERE user_id = ?', [outerUser]), 'outer write committed');
    assert.equal(await sql('get', 'SELECT 1 FROM users WHERE user_id = ?', [innerUser]), undefined, 'inner write rolled back');
  } finally {
    await Db.deleteUser(outerUser);
    await Db.deleteUser(innerUser);
  }
});
