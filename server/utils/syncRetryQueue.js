const Db = require('../db');

/**
 * Calculates exponential backoff in milliseconds based on attempt count.
 * @param {number} attempt - Zero-based retry attempt index
 * @param {number} baseDelayMs - Base delay in milliseconds (default 5000)
 * @param {number} maxDelayMs - Maximum delay in milliseconds (default 300000 = 5 min)
 * @returns {number} Backoff delay in milliseconds
 */
function calculateBackoff(attempt, baseDelayMs = 5000, maxDelayMs = 300000) {
  const safeAttempt = Math.max(0, Math.min(attempt, 30));
  const delay = baseDelayMs * Math.pow(2, safeAttempt);
  return Math.min(delay, maxDelayMs);
}

/**
 * Handles sync job failure by scheduling an automatic retry or marking as MAX_RETRIES_EXCEEDED.
 * @param {string} jobId - Sync queue job ID
 * @param {string} errorMessage - Failure reason/error detail
 * @param {object} opts - Optional configuration (baseDelayMs, maxDelayMs)
 */
async function scheduleSyncFailure(jobId, errorMessage, opts = {}) {
  const job = await Db.getSyncJobById(jobId);
  if (!job) {
    throw new Error(`Sync job not found: ${jobId}`);
  }

  const baseDelayMs = opts.baseDelayMs || 5000;
  const maxDelayMs = opts.maxDelayMs || 300000;
  const newAttempts = job.attempts + 1;
  const maxAttempts = job.maxAttempts || 3;

  if (newAttempts < maxAttempts) {
    const backoffMs = calculateBackoff(newAttempts - 1, baseDelayMs, maxDelayMs);
    const nextRetryAt = Date.now() + backoffMs;

    await Db.updateSyncJobStatus(jobId, 'PENDING', errorMessage, {
      attempts: newAttempts,
      maxAttempts: maxAttempts,
      nextRetryAt: nextRetryAt,
      retryState: 'RETRY_PENDING'
    });

    return {
      ...job,
      status: 'PENDING',
      errorMessage: errorMessage,
      attempts: newAttempts,
      maxAttempts: maxAttempts,
      nextRetryAt: nextRetryAt,
      retryState: 'RETRY_PENDING'
    };
  } else {
    await Db.updateSyncJobStatus(jobId, 'ERROR', errorMessage, {
      attempts: newAttempts,
      maxAttempts: maxAttempts,
      nextRetryAt: null,
      retryState: 'MAX_RETRIES_EXCEEDED'
    });

    return {
      ...job,
      status: 'ERROR',
      errorMessage: errorMessage,
      attempts: newAttempts,
      maxAttempts: maxAttempts,
      nextRetryAt: null,
      retryState: 'MAX_RETRIES_EXCEEDED'
    };
  }
}

/**
 * Fetches all sync jobs that are PENDING and due for execution (nextRetryAt <= now).
 * @param {number} now - Timestamp threshold (defaults to Date.now())
 */
async function getDueSyncJobs(now = Date.now()) {
  return await Db.getPendingSyncJobs(now);
}

/**
 * Manually resets sync job retries for a given user and enqueues a fresh pending job.
 * @param {string} userId - User ID
 */
async function resetSyncJobRetries(userId) {
  await Db.clearSyncJobsForUser(userId);
  return await Db.addSyncJob(userId, { maxAttempts: 3 });
}

/**
 * Gets formatted sync queue status for user.
 * @param {string} userId - User ID
 */
async function getSyncQueueStatus(userId) {
  const jobs = await Db.getSyncJobs(userId);
  const activeJob = jobs.find(j => j.status === 'PENDING' || j.status === 'RUNNING');
  const lastJob = jobs[0] || null;

  return {
    userId,
    activeJob,
    lastJob,
    hasPendingRetry: activeJob ? activeJob.retryState === 'RETRY_PENDING' : false,
    allJobs: jobs
  };
}

/**
 * Prunes completed and failed sync jobs older than retention period (default 24 hours).
 * @param {number} maxAgeMs - Max age in milliseconds
 * @param {number} now - Reference timestamp
 */
async function pruneSyncQueue(maxAgeMs, now) {
  return await Db.pruneSyncQueue(maxAgeMs, now);
}

module.exports = {
  calculateBackoff,
  scheduleSyncFailure,
  getDueSyncJobs,
  resetSyncJobRetries,
  getSyncQueueStatus,
  pruneSyncQueue
};
