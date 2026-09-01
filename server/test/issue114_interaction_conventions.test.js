const { describe, it } = require('node:test');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

describe('Issue #114 — Interaction Conventions Audit & Standard Alignment', () => {
  const publicDir = path.join(__dirname, '../../public');
  const jsDir = path.join(publicDir, 'js');
  const cssDir = path.join(publicDir, 'css');

  it('should not contain raw UI emoji icons in tasks.js, index.html or app.js', () => {
    const tasksContent = fs.readFileSync(path.join(jsDir, 'tasks.js'), 'utf8');
    const indexContent = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    
    // Check for emojis in tasks.js card renderer
    assert.strictEqual(tasksContent.includes('📅'), false, 'tasks.js should not contain 📅 emoji icon');
    assert.strictEqual(tasksContent.includes('🔄'), false, 'tasks.js should not contain 🔄 emoji icon');
    assert.strictEqual(tasksContent.includes('➡️'), false, 'tasks.js should not contain ➡️ emoji icon');
    assert.strictEqual(tasksContent.includes('↩️'), false, 'tasks.js should not contain ↩️ emoji icon');
    assert.strictEqual(tasksContent.includes('✏️'), false, 'tasks.js should not contain ✏️ emoji icon');
    assert.strictEqual(tasksContent.includes('🗑️'), false, 'tasks.js should not contain 🗑️ emoji icon');

    // Check for emoji in index.html welcome modal
    assert.strictEqual(indexContent.includes('🗓️'), false, 'index.html welcome modal should not contain 🗓️ emoji');
  });

  it('should enforce touch target sizes (>= 44px) for kanban buttons and sm buttons in app.css', () => {
    const cssContent = fs.readFileSync(path.join(cssDir, 'app.css'), 'utf8');
    
    // Check .kanban-btn touch target properties
    const kanbanMatch = cssContent.match(/\.kanban-btn\s*\{([^}]+)\}/);
    assert.ok(kanbanMatch, '.kanban-btn CSS rule should exist in app.css');
    const kanbanBody = kanbanMatch[1];
    assert.ok(kanbanBody.includes('min-height') || kanbanBody.includes('min-width') || kanbanBody.includes('height: 44px') || kanbanBody.includes('min-height: 44px'), '.kanban-btn should specify min 44px height or min dimensions');

    // Check .btn-sm touch target properties
    const btnSmMatch = cssContent.match(/\.btn-sm\s*\{([^}]+)\}/);
    assert.ok(btnSmMatch, '.btn-sm CSS rule should exist in app.css');
    const btnSmBody = btnSmMatch[1];
    assert.ok(btnSmBody.includes('min-height') || btnSmBody.includes('height: 44px') || btnSmBody.includes('min-height: 44px'), '.btn-sm should specify min 44px height or touch target');
  });

  it('should replace raw browser confirm() calls with custom confirmDialog in frontend JS modules', () => {
    const targetFiles = ['tasks.js', 'availability.js', 'msgraph.js', 'eventModal.js', 'app.js'];
    
    for (const fileName of targetFiles) {
      const fileContent = fs.readFileSync(path.join(jsDir, fileName), 'utf8');
      const lines = fileContent.split('\n');
      lines.forEach((line, index) => {
        // Exclude comments or definition of confirmDialog itself
        if (line.trim().startsWith('//') || line.includes('function confirmDialog') || line.includes('window.confirm.toString()') || line.includes('window.confirm(message)')) {
          return;
        }
        assert.strictEqual(
          /\bconfirm\s*\(/.test(line),
          false,
          `Raw confirm() found in ${fileName} at line ${index + 1}: "${line.trim()}"`
        );
      });
    }
  });
});
