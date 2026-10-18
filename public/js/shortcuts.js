(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Shortcuts = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Design guide: letter shortcuts live behind Alt; a plain key never triggers one (#126).
  const ALT_BINDINGS = {
    m: 'NAV_MONTH', 1: 'NAV_MONTH',
    w: 'NAV_WEEK', 2: 'NAV_WEEK',
    d: 'NAV_DAY', 3: 'NAV_DAY',
    a: 'NAV_AGENDA', 4: 'NAV_AGENDA',
    k: 'NAV_KANBAN', 5: 'NAV_KANBAN',
    t: 'NAV_TODAY',
    j: 'NAV_NEXT',
    p: 'NAV_PREV',
    n: 'CREATE_EVENT', c: 'CREATE_EVENT',
    s: 'FOCUS_SEARCH', '/': 'FOCUS_SEARCH',
    h: 'TOGGLE_HELP', '?': 'TOGGLE_HELP'
  };

  const ARROW_BINDINGS = {
    ArrowRight: 'NAV_NEXT',
    ArrowLeft: 'NAV_PREV'
  };

  // Physical key first: Alt (Option on macOS) changes e.key into another character.
  function altBindingKey(e) {
    const code = e.code || '';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    return e.key.length === 1 ? e.key.toLowerCase() : e.key;
  }

  /**
   * Evaluates a keydown event against the shortcut rules.
   * @param {Object} e Event-like object { key, code, targetTagName, targetRole, isTargetEditable,
   *   isTargetInteractive, ctrlKey, altKey, metaKey }
   * @param {boolean} isModalOpen Whether a modal dialog or the event popover is open
   * @returns {string|null} Action type or null
   */
  function parseShortcutAction(e, isModalOpen = false) {
    if (!e || !e.key) return null;

    // Escape always closes modal/popover, even when focused on an input or button
    if (e.key === 'Escape') return 'CLOSE_MODAL';

    if (e.ctrlKey || e.metaKey || isModalOpen) return null;

    const tagName = (e.targetTagName || '').toUpperCase();
    const role = (e.targetRole || '').toLowerCase();
    const isEditable = Boolean(e.isTargetEditable) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName);
    const isInteractive = isEditable || Boolean(e.isTargetInteractive) ||
      ['BUTTON', 'SUMMARY', 'A'].includes(tagName) || role === 'button' || role === 'link';

    if (e.altKey) {
      // Option+letter types characters on macOS, so an editable field keeps the key.
      if (isEditable) return null;
      return ALT_BINDINGS[altBindingKey(e)] || null;
    }

    // Arrows belong to whatever interactive element has focus.
    if (isInteractive) return null;
    return ARROW_BINDINGS[e.key] || null;
  }

  /**
   * Returns list of available keyboard shortcuts for help modal UI.
   * @returns {Array<{key: string, desc: string}>}
   */
  function getShortcutHelpList() {
    return [
      { key: 'Alt+N / Alt+C', desc: 'Neuen Termin erstellen' },
      { key: 'Alt+M / Alt+1', desc: 'Monatsansicht' },
      { key: 'Alt+W / Alt+2', desc: 'Wochenansicht' },
      { key: 'Alt+D / Alt+3', desc: 'Tagesansicht' },
      { key: 'Alt+A / Alt+4', desc: 'Agendaansicht' },
      { key: 'Alt+K / Alt+5', desc: 'Aufgaben' },
      { key: 'Alt+T', desc: 'Heute (Aktueller Tag)' },
      { key: 'Alt+J', desc: 'Nächster Zeitraum' },
      { key: 'Alt+P', desc: 'Vorheriger Zeitraum' },
      { key: '← / →', desc: 'Zeitraum wechseln (wenn kein Bedienelement fokussiert ist)' },
      { key: 'Alt+S / Alt+/', desc: 'Suchfeld fokussieren' },
      { key: 'Alt+H / Alt+?', desc: 'Tastaturkürzel-Hilfe anzeigen' },
      { key: 'Alt halten', desc: 'Tastenhinweise einblenden' },
      { key: 'Esc', desc: 'Dialog / Modal schließen' }
    ];
  }

  return {
    parseShortcutAction,
    getShortcutHelpList
  };
}));
