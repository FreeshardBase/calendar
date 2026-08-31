const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert');

describe('Issue #111 — Design System Compliance (Material palette, shadows, hover lift, contrast floor)', () => {
  const cssPath = path.join(process.cwd(), 'public/css/app.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  test('kanban-card does not use non-standard box-shadow or hover lift', () => {
    // Check kanban-card block for box-shadow and transform: translateY
    const kanbanBlockMatch = cssContent.match(/\.kanban-card\s*\{([^}]+)\}/);
    assert.ok(kanbanBlockMatch, '.kanban-card CSS rule must exist');
    const kanbanCardContent = kanbanBlockMatch[1];
    assert.strictEqual(
      kanbanCardContent.includes('box-shadow'),
      false,
      '.kanban-card must not have box-shadow (design system has elevation: NONE)'
    );

    const kanbanHoverMatch = cssContent.match(/\.kanban-card:hover\s*\{([^}]+)\}/);
    assert.ok(kanbanHoverMatch, '.kanban-card:hover CSS rule must exist');
    const kanbanHoverContent = kanbanHoverMatch[1];
    assert.strictEqual(
      kanbanHoverContent.includes('transform: translateY'),
      false,
      '.kanban-card:hover must not use hover lift (transform: translateY)'
    );
    assert.strictEqual(
      kanbanHoverContent.includes('box-shadow'),
      false,
      '.kanban-card:hover must not use box-shadow'
    );
  });

  test('Status and priority badges do not use hardcoded Material/Tailwind hex colors', () => {
    const prohibitedHexes = ['#34a853', '#ea4335', '#fbbc05', '#6366f1', '#a855f7'];
    const foundProhibited = prohibitedHexes.filter(hex => cssContent.includes(hex));
    assert.deepStrictEqual(
      foundProhibited,
      [],
      `CSS must not contain hardcoded Material/Tailwind hex values: ${foundProhibited.join(', ')}`
    );
  });

  test('Status and priority badges use design system custom properties', () => {
    const badgeClasses = [
      '.status-accepted',
      '.status-declined',
      '.status-tentative',
      '.status-pending',
      '.prio-high',
      '.prio-med',
      '.prio-low',
      '.kanban-due-date',
      '.kanban-recurrence-badge'
    ];

    for (const cls of badgeClasses) {
      const regex = new RegExp(`${cls.replace('.', '\\.')}\\s*\\{([^}]+)\\}`);
      const match = cssContent.match(regex);
      assert.ok(match, `${cls} CSS rule must exist`);
      const body = match[1];
      assert.ok(
        body.includes('var('),
        `${cls} must use design system custom properties (var(...)), found: ${body}`
      );
    }
  });

  test('shortcut-badge does not use box-shadow', () => {
    const match = cssContent.match(/\.shortcut-badge\s*\{([^}]+)\}/);
    assert.ok(match, '.shortcut-badge CSS rule must exist');
    assert.strictEqual(
      match[1].includes('box-shadow'),
      false,
      '.shortcut-badge must not use box-shadow'
    );
  });
});
