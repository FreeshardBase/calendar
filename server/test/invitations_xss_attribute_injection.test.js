'use strict';
process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadFrontendModule(filePath, mockGlobals = {}) {
  let code = fs.readFileSync(filePath, 'utf8');
  // Strip import statements for Node VM evaluation
  code = code.replace(/^\s*import\s+[^;]+;/gm, '');
  // Strip export keywords
  code = code.replace(/^\s*export\s+(async\s+)?function\s+/gm, '$1function ');
  code = code.replace(/^\s*export\s+const\s+/gm, 'const ');
  code = code.replace(/^\s*export\s+let\s+/gm, 'let ');
  
  const context = {
    console,
    Date,
    Array,
    String,
    RegExp,
    parseInt,
    document: { getElementById: () => null, createElement: () => ({ style: {}, dataset: {} }) },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    exports: {},
    module: { exports: {} },
    ...mockGlobals
  };
  context.window = context;
  context.global = context;

  vm.createContext(context);
  vm.runInContext(code, context);

  return context;
}

describe('Issue #76 — Stored XSS in Invitations List & Attribute Injection from Event UID / Calendar Color', () => {
  it('invitations list must HTML-escape title, description, organizer, attendees, and attributes', () => {
    const invitationsPath = path.resolve(__dirname, '../../public/js/invitations.js');
    const { renderInvitationsHTML, escHtml } = loadFrontendModule(invitationsPath);
    assert.strictEqual(typeof renderInvitationsHTML, 'function');
    assert.strictEqual(typeof escHtml, 'function');

    const maliciousInvitations = [
      {
        uid: 'evt-123" onclick="alert(\'xss-uid\')"',
        href: '/cal/evt.ics" onload="alert(1)"',
        calendarId: 'cal-1" onmouseover="alert(1)"',
        title: '<script>alert("xss-title")</script>',
        description: '<img src=x onerror=alert("xss-desc")>',
        start: '2026-09-01T10:00:00Z',
        organizer: {
          name: '<iframe src="javascript:alert(1)"></iframe>',
          email: 'att"onfocus="alert(1)@example.com'
        },
        attendees: [
          {
            name: '<svg/onload=alert("xss-att")>',
            email: 'victim">alert(1)@example.com',
            status: 'NEEDS-ACTION'
          }
        ]
      }
    ];

    const html = renderInvitationsHTML(maliciousInvitations);

    // Assert that raw unescaped script / html tags and attribute breakouts do NOT exist in rendered HTML
    assert.strictEqual(html.includes('<script>'), false, 'Raw <script> tag must not be rendered');
    assert.strictEqual(html.includes('<img src=x'), false, 'Raw <img onerror> tag must not be rendered');
    assert.strictEqual(html.includes('<iframe'), false, 'Raw <iframe> tag must not be rendered');
    assert.strictEqual(html.includes('<svg/onload'), false, 'Raw <svg> payload must not be rendered');
    
    // Assert HTML entities are present
    assert.ok(html.includes('&lt;script&gt;alert(&quot;xss-title&quot;)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(&quot;xss-desc&quot;)&gt;'));
    
    // Assert attribute breakouts are escaped
    assert.strictEqual(html.includes('data-uid="evt-123" onclick='), false, 'UID attribute breakout must be prevented');
    assert.ok(html.includes('data-uid="evt-123&quot; onclick=&quot;alert(&#39;xss-uid&#39;)&quot;"') || html.includes('data-uid="evt-123&quot;'));
  });

  it('calendar color sanitizer must reject malicious CSS / attribute injection payloads', () => {
    const calendarPath = path.resolve(__dirname, '../../public/js/calendar.js');
    const { sanitizeColor } = loadFrontendModule(calendarPath);
    assert.strictEqual(typeof sanitizeColor, 'function');

    // Valid colors
    assert.strictEqual(sanitizeColor('#ff0000'), '#ff0000');
    assert.strictEqual(sanitizeColor('#123'), '#123');
    assert.strictEqual(sanitizeColor('rgb(255, 0, 0)'), 'rgb(255, 0, 0)');
    assert.strictEqual(sanitizeColor('blue'), 'blue');

    // Malicious injection payloads
    const maliciousPayloads = [
      'red; xss: expression(alert(1))',
      '#ff0000" onclick="alert(1)"',
      'url("javascript:alert(1)")',
      '#123456; background-image: url(https://attacker.com/leak)',
      '<script>alert(1)</script>',
      '/* comment */ #000'
    ];

    for (const payload of maliciousPayloads) {
      assert.strictEqual(sanitizeColor(payload), '#6366f1', `Payload "${payload}" must be sanitized to fallback color`);
    }
  });

  it('event chip HTML must attribute-escape event UID and sanitize calendar color', () => {
    const calendarPath = path.resolve(__dirname, '../../public/js/calendar.js');
    const { chipHtml, agendaEventHtml } = loadFrontendModule(calendarPath, {
      calendarById: () => ({ color: 'red; xss: expression(alert(1))' })
    });
    assert.strictEqual(typeof chipHtml, 'function');
    assert.strictEqual(typeof agendaEventHtml, 'function');

    const event = {
      uid: 'uid-999" onmouseover="alert(\'xss\')"',
      title: 'Normal Title',
      start: '2026-09-01T10:00:00Z',
      calendarId: 'cal-1'
    };

    const chip = chipHtml(event);
    assert.strictEqual(chip.includes('data-event-uid="uid-999" onmouseover='), false, 'Chip UID attribute breakout must be prevented');
    assert.ok(chip.includes('data-event-uid="uid-999&quot; onmouseover=&quot;alert(&#39;xss&#39;)&quot;"') || chip.includes('data-event-uid="uid-999&quot;'));
    assert.strictEqual(chip.includes('red; xss'), false, 'Malicious color must be sanitized in chip style attribute');

    const agenda = agendaEventHtml(event);
    assert.strictEqual(agenda.includes('data-event-uid="uid-999" onmouseover='), false, 'Agenda UID attribute breakout must be prevented');
    assert.strictEqual(agenda.includes('red; xss'), false, 'Malicious color must be sanitized in agenda style attribute');
  });
});
