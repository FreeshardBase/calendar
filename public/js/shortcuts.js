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

  // #627: descriptions (and the one worded key) are message keys of public/js/messages/modules.js.
  const HELP = [
    { key: 'Alt+N / Alt+C', desc: 'modules.shortcuts.createEvent' },
    { key: 'Alt+M / Alt+1', desc: 'modules.shortcuts.month' },
    { key: 'Alt+W / Alt+2', desc: 'modules.shortcuts.week' },
    { key: 'Alt+D / Alt+3', desc: 'modules.shortcuts.day' },
    { key: 'Alt+A / Alt+4', desc: 'modules.shortcuts.agenda' },
    { key: 'Alt+K / Alt+5', desc: 'modules.shortcuts.tasks' },
    { key: 'Alt+T', desc: 'modules.shortcuts.today' },
    { key: 'Alt+J', desc: 'modules.shortcuts.next' },
    { key: 'Alt+P', desc: 'modules.shortcuts.prev' },
    { key: '← / →', desc: 'modules.shortcuts.arrows' },
    { key: 'Alt+S / Alt+/', desc: 'modules.shortcuts.search' },
    { key: 'Alt+H / Alt+?', desc: 'modules.shortcuts.help' },
    { keyMessage: 'modules.shortcuts.holdAltKey', desc: 'modules.shortcuts.holdAlt' },
    { key: 'Esc', desc: 'modules.shortcuts.close' }
  ];

  /**
   * Returns list of available keyboard shortcuts for help modal UI.
   * @param {function(string): string} translate the i18n t() of public/js/i18n.js
   * @returns {Array<{key: string, desc: string}>}
   */
  function getShortcutHelpList(translate) {
    if (typeof translate !== 'function') throw new Error('getShortcutHelpList needs the translate function t()');
    return HELP.map(item => ({
      key: item.keyMessage ? translate(item.keyMessage) : item.key,
      desc: translate(item.desc)
    }));
  }

  return {
    parseShortcutAction,
    getShortcutHelpList
  };
}));
