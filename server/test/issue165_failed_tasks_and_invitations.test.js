'use strict';
process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadFrontendModule(filePath, mockGlobals = {}) {
  let code = fs.readFileSync(filePath, 'utf8');
  code = code.replace(/^\s*import\s+[^;]+;/gm, '');
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

describe('Issue #165 — Error States for Failed Tasks and Invitations Fetch', () => {
  it('renderSidebarTasks renders error state instead of "Keine offenen Aufgaben." when options.error is present', () => {
    const tasksJsPath = path.resolve(__dirname, '../../public/js/tasks.js');
    const mod = loadFrontendModule(tasksJsPath);

    const mockContainer = { innerHTML: '' };
    const mockBadge = { textContent: '', title: '' };

    mod.renderSidebarTasks(mockContainer, mockBadge, [], {}, { error: 'Server error 500' });

    assert.strictEqual(mockBadge.textContent, '!');
    assert.strictEqual(mockBadge.title, 'Fehler beim Laden der Aufgaben');
    assert.ok(mod.renderSidebarTasks && mockContainer.innerHTML.includes('sidebar-tasks-error'));
    assert.ok(mockContainer.innerHTML.includes('Fehler beim Laden der Aufgaben'));
    assert.ok(!mockContainer.innerHTML.includes('Keine offenen Aufgaben.'));
  });

  it('renderKanbanBoard renders error state instead of "Keine Aufgaben vorhanden" when options.error is present', () => {
    const tasksJsPath = path.resolve(__dirname, '../../public/js/tasks.js');
    const mod = loadFrontendModule(tasksJsPath);

    const mockContainer = { innerHTML: '' };

    mod.renderKanbanBoard(mockContainer, [], {}, { error: 'Server error 500' });

    assert.ok(mockContainer.innerHTML.includes('kanban-error-state'));
    assert.ok(mockContainer.innerHTML.includes('Fehler beim Laden der Aufgaben'));
    assert.ok(!mockContainer.innerHTML.includes('Keine Aufgaben vorhanden'));
  });

  it('renderInvitationsHTML renders error state instead of "Keine ausstehenden Einladungen vorhanden." when options.error is present', () => {
    const invitationsJsPath = path.resolve(__dirname, '../../public/js/invitations.js');
    const mod = loadFrontendModule(invitationsJsPath);

    const html = mod.renderInvitationsHTML([], { error: true });

    assert.ok(html.includes('invitations-error-state'));
    assert.ok(html.includes('Fehler beim Laden der Einladungen'));
    assert.ok(!html.includes('Keine ausstehenden Einladungen vorhanden.'));
  });

  it('loadInvitations shows error badge when InvitationsAPI.list() fails', async () => {
    const invitationsJsPath = path.resolve(__dirname, '../../public/js/invitations.js');

    const badgeMock = { textContent: '0', style: { display: 'none' }, classList: { add() {}, remove() {} }, title: '' };
    const mockDocument = {
      getElementById: (id) => {
        if (id === 'invitations-badge') return badgeMock;
        return null;
      }
    };

    const mockInvitationsAPI = {
      list: async () => {
        throw new Error('500 Internal Server Error');
      }
    };

    const mod = loadFrontendModule(invitationsJsPath, {
      document: mockDocument,
      InvitationsAPI: mockInvitationsAPI
    });

    await mod.loadInvitations();
    assert.strictEqual(badgeMock.style.display, 'inline-flex', 'Badge must not be hidden on fetch failure');
    assert.strictEqual(badgeMock.textContent, '!', 'Badge text must show error indicator !');
    assert.strictEqual(badgeMock.title, 'Fehler beim Laden der Einladungen');

    const errHtml = mod.renderInvitationsHTML([]);
    assert.ok(errHtml.includes('Fehler beim Laden der Einladungen'));
  });
});
