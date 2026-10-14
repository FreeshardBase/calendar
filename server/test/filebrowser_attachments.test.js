'use strict';
process.env.NODE_ENV = 'test';
process.env.PORT = '3108';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fetchFileBrowserFiles, createFileBrowserShareLink, buildFileBrowserAttachment } = require('../utils/filebrowser');
const { parseICSToEvent, eventToICS } = require('../utils/ical');

test('Issue #12 — Support event attachments using FileBrowser integration and central OIDC/OAuth2 authentication Suite', async (t) => {
  const { app, server } = require('../index');
  const { loginAs } = require('./helpers/testSession');

  if (server && !server.listening) {
    await new Promise((resolve) => server.listen(process.env.PORT || 3108, resolve));
  }

  t.after(() => {
    if (server && server.close) {
      server.close();
    }
  });

  const baseUrl = `http://localhost:${process.env.PORT}`;
  const userId = 'filebrowser-test-user';
  const sampleOidcToken = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test-token';

  await t.test('buildFileBrowserAttachment should return formatted attachment object', () => {
    const fileItem = {
      name: 'annual_report_2026.pdf',
      path: '/documents/annual_report_2026.pdf',
      mimeType: 'application/pdf'
    };
    const shareUrl = 'https://files.freeshard.local/files/documents/annual_report_2026.pdf?token=abc123xyz';

    const attachment = buildFileBrowserAttachment(fileItem, shareUrl);
    assert.deepEqual(attachment, {
      url: 'https://files.freeshard.local/files/documents/annual_report_2026.pdf?token=abc123xyz',
      name: 'annual_report_2026.pdf',
      mimeType: 'application/pdf'
    });
  });

  await t.test('createFileBrowserShareLink should generate valid share link', async () => {
    const filePath = '/projects/spec.docx';
    const result = await createFileBrowserShareLink(filePath, sampleOidcToken);
    assert.ok(result.url, 'Share link URL must be generated');
    assert.ok(result.url.includes('spec.docx'));
    assert.equal(result.name, 'spec.docx');
  });

  await t.test('fetchFileBrowserFiles should list resources for given directory path', async () => {
    const res = await fetchFileBrowserFiles('/', sampleOidcToken);
    assert.ok(Array.isArray(res.items), 'items must be an array');
    assert.ok(res.items.length >= 0);
  });

  await t.test('GET /api/attachments/filebrowser/files returns 401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/attachments/filebrowser/files`);
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/attachments/filebrowser/files returns file list for authenticated user with OIDC token', async () => {
    const res = await fetch(`${baseUrl}/api/attachments/filebrowser/files?path=/`, {
      headers: {
        cookie: await loginAs(userId),
        'Authorization': `Bearer ${sampleOidcToken}`
      }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.success);
    assert.ok(Array.isArray(data.files));
  });

  await t.test('POST /api/attachments/filebrowser/link without filePath returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/attachments/filebrowser/link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: await loginAs(userId)
      },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
  });

  await t.test('POST /api/attachments/filebrowser/link creates FileBrowser attachment object', async () => {
    const res = await fetch(`${baseUrl}/api/attachments/filebrowser/link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: await loginAs(userId),
        'Authorization': `Bearer ${sampleOidcToken}`
      },
      body: JSON.stringify({
        filePath: '/docs/architecture.pdf',
        mimeType: 'application/pdf'
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.success);
    assert.ok(data.attachment);
    assert.equal(data.attachment.name, 'architecture.pdf');
    assert.equal(data.attachment.mimeType, 'application/pdf');
    assert.ok(data.attachment.url.includes('architecture.pdf'));
  });

  await t.test('FileBrowser attachment round-trip via eventToICS and parseICSToEvent', () => {
    const fileItem = {
      name: 'strategy_2026.pdf',
      path: '/strategy_2026.pdf',
      mimeType: 'application/pdf'
    };
    const shareUrl = 'https://files.freeshard.local/files/strategy_2026.pdf';
    const attachment = buildFileBrowserAttachment(fileItem, shareUrl);

    const event = {
      uid: 'filebrowser-event-999',
      title: 'Strategy Meeting with Attachment',
      start: '2026-08-25T10:00:00.000Z',
      end: '2026-08-25T11:00:00.000Z',
      attachments: [attachment]
    };

    const ics = eventToICS(event);
    assert.ok(ics.includes('ATTACH'));
    assert.ok(ics.includes('strategy_2026.pdf'));

    const parsed = parseICSToEvent(ics);
    assert.ok(parsed);
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].name, 'strategy_2026.pdf');
    assert.equal(parsed.attachments[0].url, shareUrl);
  });
});
