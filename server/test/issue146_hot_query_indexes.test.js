'use strict';

/**
 * Issue #146 — MEDIUM: eleven of fifteen hot queries are full table scans, including the CalDAV authentication path
 *
 * Verifies that all hot queries (including CalDAV authentication path on app_passwords)
 * utilize covering/selective indexes instead of performing full table scans (SCAN TABLE).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const Db = require('../db');

test('Issue #146 — Hot queries use indexes instead of SCAN TABLE', async () => {
  const dbPath = process.env.DATABASE_PATH || (Db.getDbPath && Db.getDbPath()) || path.join(ROOT, 'webcalendar.db');
  const db = new sqlite3.Database(dbPath);

  // Helper to run EXPLAIN QUERY PLAN
  const explain = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.all(`EXPLAIN QUERY PLAN ${sql}`, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  };

  const queriesToVerify = [
    {
      name: 'CalDAV Authentication Path (app_passwords by user_id)',
      sql: 'SELECT password_hash FROM app_passwords WHERE user_id = ?',
      params: ['test-user']
    },
    {
      name: 'Calendar Shares by calendar_id',
      sql: 'SELECT token, label, created_at FROM calendar_shares WHERE calendar_id = ?',
      params: ['cal-123']
    },
    {
      name: 'Sync Queue by user_id',
      sql: 'SELECT id, status FROM sync_queue WHERE user_id = ?',
      params: ['test-user']
    },
    {
      name: 'Sync Queue PENDING worker poll',
      sql: 'SELECT id FROM sync_queue WHERE status = "PENDING" AND (next_retry_at IS NULL OR next_retry_at <= ?)',
      params: [Date.now()]
    },
    {
      name: 'User Calendar Shares by sharee_user_id',
      sql: 'SELECT calendar_id FROM user_calendar_shares WHERE sharee_user_id = ?',
      params: ['test-user']
    },
    {
      name: 'MS Graph Accounts by user_id',
      sql: 'SELECT id FROM msgraph_accounts WHERE user_id = ?',
      params: ['test-user']
    },
    {
      name: 'MS Graph Event Mappings by graph_id',
      sql: 'SELECT local_uid FROM msgraph_event_mappings WHERE graph_id = ?',
      params: ['graph-123']
    },
    {
      name: 'Web Push Subscriptions by user_id',
      sql: 'SELECT endpoint FROM web_push_subscriptions WHERE user_id = ?',
      params: ['test-user']
    },
    {
      name: 'Resource Bookings by resource_id',
      sql: 'SELECT id FROM resource_bookings WHERE resource_id = ?',
      params: ['res-123']
    },
    {
      name: 'Availability Pages by user_id',
      sql: 'SELECT id FROM availability_pages WHERE user_id = ?',
      params: ['test-user']
    },
    {
      name: 'Slot Bookings by page_id',
      sql: 'SELECT id FROM slot_bookings WHERE page_id = ?',
      params: ['page-123']
    },
    {
      name: 'Cross User Deletions by owner_user_id',
      sql: 'SELECT id FROM cross_user_deletions WHERE owner_user_id = ?',
      params: ['test-user']
    }
  ];

  try {
    for (const q of queriesToVerify) {
      const plan = await explain(q.sql, q.params);
      const planDetail = plan.map(r => r.detail).join(' | ');
      
      // Ensure plan does NOT perform a SCAN TABLE
      assert.ok(
        !planDetail.includes('SCAN TABLE'),
        `Query "${q.name}" performed full table scan! Plan: ${planDetail}`
      );
      // Ensure plan uses SEARCH TABLE using index
      assert.ok(
        planDetail.includes('SEARCH TABLE') || planDetail.includes('USING INDEX'),
        `Query "${q.name}" should use index. Plan: ${planDetail}`
      );
    }
  } finally {
    db.close();
  }
});
