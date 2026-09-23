const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('No hardcoded super-secret-bypass in docker-compose.yml', () => {
  const content = fs.readFileSync(path.join(__dirname, '../../docker-compose.yml'), 'utf8');
  assert.ok(!content.includes('super-secret-bypass'), 'Should not contain super-secret-bypass');
  assert.ok(!content.includes('freeshard-default-encryption-key-do-not-use-in-prod'), 'Should not contain default encryption key');
});

test('No hardcoded super-secret-bypass in radicale custom auth', () => {
  const content = fs.readFileSync(path.join(__dirname, '../../radicale/radicale_custom_auth.py'), 'utf8');
  assert.ok(!content.includes('super-secret-bypass'), 'Should not contain super-secret-bypass');
});

test('No hardcoded super-secret-bypass in sync-worker msgraph_worker.py', () => {
  const content = fs.readFileSync(path.join(__dirname, '../../sync-worker/msgraph_worker.py'), 'utf8');
  assert.ok(!content.includes('super-secret-bypass'), 'Should not contain super-secret-bypass');
});

test('No hardcoded super-secret-bypass in sync-worker sync_worker.py', () => {
  const content = fs.readFileSync(path.join(__dirname, '../../sync-worker/sync_worker.py'), 'utf8');
  assert.ok(!content.includes('super-secret-bypass'), 'Should not contain super-secret-bypass');
});

test('No hardcoded super-secret-bypass in server routes', () => {
  const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.ok(!index.includes('super-secret-bypass'), 'index.js should not contain super-secret-bypass');
  
  const calendars = fs.readFileSync(path.join(__dirname, '../routes/calendars.js'), 'utf8');
  assert.ok(!calendars.includes('super-secret-bypass'), 'calendars.js should not contain super-secret-bypass');
});
