'use strict';

const Db = require('../db');

const BACKUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Issue #120: keeps Db.backupPath (`webcalendar.db.backup`) a consistent snapshot of the live
 * database, so the nightly shard backup always contains a restorable copy. Writes one at start and
 * then every intervalMs; hourly keeps it at most an hour behind whenever the shard backup runs.
 */
function startDbBackupWorker({ intervalMs = BACKUP_INTERVAL_MS } = {}) {
  const run = async () => {
    const { backupPath, size } = await Db.createBackup(Db.backupPath);
    console.log(`[DbBackup] Wrote database snapshot ${backupPath} (${size} bytes)`);
  };
  const logFailure = (err) => console.error('[DbBackup] Writing the database snapshot failed:', err.message);

  const firstRun = run();
  firstRun.catch(logFailure);
  const timer = setInterval(() => run().catch(logFailure), intervalMs);
  if (timer.unref) timer.unref();

  return { firstRun, stop: () => clearInterval(timer) };
}

module.exports = { startDbBackupWorker, BACKUP_INTERVAL_MS };
