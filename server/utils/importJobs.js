'use strict';
const log = require('./logger');

const crypto = require('crypto');

// ICS imports run in the background of this process (#174): Radicale's create cost grows with the
// collection, so a large first import takes minutes. The job's counters are the loop's own state,
// which the import progress banner polls. A finished job is kept for an hour, then forgotten.
const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;

const jobs = new Map();

function pruneFinished(now) {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && now - job.finishedAt > FINISHED_JOB_TTL_MS) jobs.delete(id);
  }
}

function publicView(job) {
  const { id, calendarId, status, total, processed, imported, skipped, failed, error } = job;
  return { id, calendarId, status, total, processed, imported, skipped, failed, error };
}

/**
 * Starts `items` (each `{ uid, ics, etag }`) as PUTs into `calendarUrl`, one after another.
 * `skipped` counts events the conflict resolution already decided to leave out; they are part of
 * the total and done from the start. Returns the job's public view immediately; `onFinished` runs
 * once every item was attempted.
 */
function startImportJob({ userId, calendarId, calendarUrl, client, items, skipped = 0, onFinished }) {
  const now = Date.now();
  pruneFinished(now);
  const job = {
    id: crypto.randomUUID(),
    userId,
    calendarId,
    status: 'running',
    total: items.length + skipped,
    processed: skipped,
    imported: 0,
    skipped,
    failed: 0,
    error: null,
    finishedAt: null
  };
  jobs.set(job.id, job);

  (async () => {
    for (const item of items) {
      const resourceUrl = calendarUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(item.uid) + '.ics';
      try {
        await client.put(resourceUrl, item.ics, item.etag);
        job.imported++;
      } catch (putErr) {
        if (putErr.message === 'ETAG_CONFLICT') job.skipped++;
        else { job.failed++; log.error(`[calendars import] ${item.uid}:`, putErr.message); }
      }
      job.processed++;
    }
    job.status = 'done';
    job.finishedAt = Date.now();
    await onFinished();
  })().catch((err) => {
    // Reaches the user through the job's status, which the progress banner reports as an error toast.
    log.error('[calendars import] job aborted:', err);
    job.status = 'error';
    job.error = 'Der Import wurde abgebrochen.';
    job.finishedAt = Date.now();
  });

  return publicView(job);
}

// The job as its owner may see it, or null (unknown id or another user's job).
function getImportJob(jobId, userId) {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) return null;
  return publicView(job);
}

module.exports = { startImportJob, getImportJob };
