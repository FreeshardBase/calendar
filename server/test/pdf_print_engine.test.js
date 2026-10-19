'use strict';
require('./helpers/sameOriginFetch'); // #340: requests carry Sec-Fetch-Site: same-origin like the app's own fetches
process.env.NODE_ENV = 'test';
process.env.PORT = '3095';
process.env.DISABLE_INTERNAL_CALDAV = '1';
process.env.SSL_KEY_PATH = '';
process.env.SSL_CERT_PATH = '';
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generateCalendarPDF, parseExportOptions } = require('../utils/pdfExport');
const CALENDARS = [{ id: 'testuser/personal', name: 'Persönlich', color: '#3b82f6' }];
const exportOptions = (body) => parseExportOptions({ calendars: CALENDARS, ...body }).options;
const { app, server: globalServer } = require('../index');
globalServer.listen(process.env.PORT);
const { loginAs } = require('./helpers/testSession');

test('PDF Print Engine & Vector Export Suite', async (t) => {
  let server = globalServer;
  let port = process.env.PORT || 3095;

  if (server && !server.listening) {
    await new Promise((resolve) => server.listen(port, resolve));
  }

  t.after(async () => {
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const testCookie = await loginAs('test', { username: 'testuser', email: 'testuser@example.com' });


  await t.test('generateCalendarPDF generates vector PDF buffer for Month view', () => {
    const events = [
      {
        calendarId: 'testuser/personal',
        summary: 'Team Sync Meeting',
        dtstart: '2026-08-12T10:00:00Z',
        dtend: '2026-08-12T11:00:00Z',
        location: 'Conference Room A'
      },
      {
        calendarId: 'testuser/personal',
        summary: 'Project Sprint Review',
        dtstart: '2026-08-15T14:00:00Z',
        dtend: '2026-08-15T15:30:00Z'
      }
    ];

    const pdfBuffer = generateCalendarPDF(exportOptions({
      view: 'month',
      from: '2026-08-01',
      to: '2026-08-31',
      events,
      title: 'Monatsansicht - August 2026',
      orientation: 'landscape'
    }));

    assert.ok(Buffer.isBuffer(pdfBuffer), 'Output must be a Buffer');
    const pdfString = pdfBuffer.toString('latin1');
    assert.ok(pdfString.startsWith('%PDF-1.4'), 'PDF must start with %PDF-1.4 header');
    assert.ok(pdfString.includes('%%EOF'), 'PDF must terminate with %%EOF marker');
    assert.ok(pdfString.includes('Monatsansicht - August 2026'), 'PDF must contain document title');
    assert.ok(pdfString.includes('Team Sync Meeting'), 'PDF must contain event summary text');
    assert.ok(pdfString.includes('Project Sprint Review'), 'PDF must contain second event summary text');
  });

  await t.test('generateCalendarPDF generates vector PDF buffer for Week view', () => {
    const events = [
      {
        calendarId: 'testuser/personal',
        summary: 'Architecture Planning',
        dtstart: '2026-08-12T09:00:00Z',
        dtend: '2026-08-12T10:30:00Z'
      }
    ];

    const pdfBuffer = generateCalendarPDF(exportOptions({
      view: 'week',
      from: '2026-08-10',
      to: '2026-08-16',
      events,
      title: 'Wochenansicht - KW 33 (2026)',
      orientation: 'portrait'
    }));

    assert.ok(Buffer.isBuffer(pdfBuffer), 'Output must be a Buffer');
    const pdfString = pdfBuffer.toString('latin1');
    assert.ok(pdfString.startsWith('%PDF-1.4'), 'PDF must start with %PDF-1.4 header');
    assert.ok(pdfString.includes('Wochenansicht - KW 33'), 'PDF must contain week header title');
    assert.ok(pdfString.includes('(Architec'), 'PDF must contain week event text (cut to the narrow portrait column)');
  });

  await t.test('POST /api/calendars/export/pdf without view parameter should return 400 Bad Request', async () => {
    const reqData = JSON.stringify({});
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        `http://localhost:${port}/api/calendars/export/pdf`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(reqData),
            cookie: testCookie
          }
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode, data }));
        }
      );
      req.on('error', reject);
      req.write(reqData);
      req.end();
    });

    assert.equal(res.status, 400, 'Expected 400 Bad Request');
  });

  await t.test('POST /api/calendars/export/pdf returns valid PDF download', async () => {
    const payload = JSON.stringify({
      view: 'month',
      from: '2026-08-01',
      to: '2026-08-31',
      calendars: CALENDARS,
      title: 'Export Test Calendar',
      events: [
        {
          calendarId: 'testuser/personal',
          summary: 'API Test Event',
          dtstart: '2026-08-12T12:00:00Z',
          dtend: '2026-08-12T13:00:00Z'
        }
      ]
    });

    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        `http://localhost:${port}/api/calendars/export/pdf`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            cookie: testCookie
          }
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body
            });
          });
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.ok(res.headers['content-disposition'].includes('attachment; filename='));
    const pdfStr = res.body.toString('latin1');
    assert.ok(pdfStr.startsWith('%PDF-1.4'));
    assert.ok(pdfStr.includes('API Test Event'));
  });
});
