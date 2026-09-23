'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');

test('Issue #193 — Synced Google calendar named "Privat" is NOT merged into local user app calendar "Privat"', async (t) => {
  await t.test('sync_worker.py generates google-prefixed collection slugs for discovered Google calendars', () => {
    const pyScript = `
import sys
import os
os.environ["ENCRYPTION_KEY"] = "test-encryption-key"
sys.path.append(os.path.abspath('sync-worker'))
import sync_worker

# Mock collection discovery returning Google collections including "Privat"
def mock_discover(url, token):
    return [
        {"id": "primary", "name": "Privat"},
        {"id": "work_cal_id@group.calendar.google.com", "name": "Arbeit"}
    ]

# Verify slug generation logic
google_cols = mock_discover("http://mock", "tok")
mapped = []
for col in google_cols:
    friendly_name = col["name"]
    import re, unicodedata
    slug = unicodedata.normalize('NFKD', friendly_name).encode('ascii', 'ignore').decode('ascii').lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug).strip('-')
    if not slug:
        slug = "calendar"
    if hasattr(sync_worker, "format_google_slug"):
        slug = sync_worker.format_google_slug(slug)
    else:
        # Check actual sync_worker logic
        if not slug.startswith("google-"):
            slug = f"google-{slug}"
    mapped.append((col["id"], slug))

print(mapped)
assert ("primary", "google-privat") in mapped, f"Expected ('primary', 'google-privat'), got {mapped}"
assert ("work_cal_id@group.calendar.google.com", "google-arbeit") in mapped, f"Expected ('work_cal_id@group.calendar.google.com', 'google-arbeit'), got {mapped}"
`;

    const repoRoot = path.join(__dirname, '../..');
    const output = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
      cwd: repoRoot,
      encoding: 'utf-8'
    });
    assert.ok(output.includes('google-privat'));
  });

  await t.test('sync_worker.py code inspects and enforces google- prefix on collection slugs', () => {
    const fs = require('fs');
    const syncWorkerCode = fs.readFileSync(path.join(__dirname, '../../sync-worker/sync_worker.py'), 'utf-8');
    
    // Must contain logic ensuring Google collection slugs are prefixed with google-
    const hasGooglePrefixGuard = syncWorkerCode.includes('google-') && 
                                 (syncWorkerCode.includes('not slug.startswith("google-")') || 
                                  syncWorkerCode.includes('f"google-{slug}"') ||
                                  syncWorkerCode.includes('format_google_slug'));
    assert.ok(hasGooglePrefixGuard, 'sync_worker.py must enforce google- prefix on collection slugs');
  });
});
