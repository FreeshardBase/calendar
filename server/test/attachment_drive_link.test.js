'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseICSToEvent, eventToICS } = require('../utils/ical');

test('ATTACHMENT-DRIVE-LINK Suite', async (t) => {
  await t.test('should parse VEVENT with ATTACH property into attachments array', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Freeshard//WebCalendar 1.0//EN
BEGIN:VEVENT
UID:test-attachment-123
DTSTAMP:20260812T000000Z
DTSTART:20260812T100000Z
DTEND:20260812T110000Z
SUMMARY:Meeting with Files Attachment
ATTACH;FMTTYPE=application/pdf;X-FILENAME=Q3_Report.pdf:https://files.freeshard.local/d/q3-report.pdf
END:VEVENT
END:VCALENDAR`;

    const event = parseICSToEvent(ics);
    assert.ok(event, 'Event should be parsed');
    assert.ok(Array.isArray(event.attachments), 'attachments should be an array');
    assert.equal(event.attachments.length, 1);
    assert.equal(event.attachments[0].url, 'https://files.freeshard.local/d/q3-report.pdf');
    assert.equal(event.attachments[0].name, 'Q3_Report.pdf');
    assert.equal(event.attachments[0].mimeType, 'application/pdf');
  });

  await t.test('should serialize attachments array back to ATTACH RFC 5545 property', () => {
    const event = {
      uid: 'test-attachment-456',
      title: 'Drive Attachment Event',
      start: '2026-08-12T10:00:00.000Z',
      end: '2026-08-12T11:00:00.000Z',
      attachments: [
        {
          url: 'https://files.freeshard.local/d/project-spec.docx',
          name: 'project-spec.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        }
      ]
    };

    const ics = eventToICS(event);
    assert.ok(ics.includes('ATTACH'), 'ICS should contain ATTACH property');
    const unfoldedIcs = ics.replace(/\r?\n /g, '');
    assert.ok(unfoldedIcs.includes('https://files.freeshard.local/d/project-spec.docx'));
    assert.ok(unfoldedIcs.includes('project-spec.docx'));

    const reParsed = parseICSToEvent(ics);
    assert.equal(reParsed.attachments.length, 1);
    assert.equal(reParsed.attachments[0].url, 'https://files.freeshard.local/d/project-spec.docx');
    assert.equal(reParsed.attachments[0].name, 'project-spec.docx');
  });
});
