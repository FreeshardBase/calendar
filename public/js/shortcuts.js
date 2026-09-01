(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Shortcuts = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Evaluates a keydown event against power-user navigation rules.
   * @param {Object} e Event-like object { key, targetTagName, isTargetEditable, isTargetButton, ctrlKey, altKey, metaKey }
   * @param {boolean} isModalOpen Whether a modal dialog is currently active
   * @returns {string|null} Action type or null
   */
  function parseShortcutAction(e, isModalOpen = false) {
    if (!e || !e.key) return null;

    // Ignore modifier key combinations (Ctrl, Alt, Meta)
    if (e.ctrlKey || e.altKey || e.metaKey) return null;

    const key = e.key;
    const tagName = (e.targetTagName || '').toUpperCase();
    const role = (e.targetRole || '').toLowerCase();
    const isEditable = e.isTargetEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
    const isButton = e.isTargetButton || tagName === 'BUTTON' || role === 'button' || tagName === 'SUMMARY';

    // Escape always closes modal/popover, even when focused on an input or button
    if (key === 'Escape') {
      return 'CLOSE_MODAL';
    }

    // Suppress all plain-letter navigation shortcuts when typing in inputs or focusing buttons or when modal is open
    if (isEditable || isButton || isModalOpen) {
      return null;
    }

    switch (key) {
      case 'm':
      case '1':
        return 'NAV_MONTH';

      case 'w':
      case '2':
        return 'NAV_WEEK';

      case 'd':
      case '3':
        return 'NAV_DAY';

      case 'a':
      case '4':
        return 'NAV_AGENDA';

      case 'k':
      case '5':
        return 'NAV_KANBAN';

      case 't':
        return 'NAV_TODAY';

      case 'j':
      case 'ArrowRight':
        return 'NAV_NEXT';

      case 'p':
      case 'ArrowLeft':
        return 'NAV_PREV';

      case 'n':
      case 'c':
        return 'CREATE_EVENT';

      case '/':
      case 's':
        return 'FOCUS_SEARCH';

      case '?':
      case 'h':
        return 'TOGGLE_HELP';

      default:
        return null;
    }
  }

  /**
   * Returns list of available keyboard shortcuts for help modal UI.
   * @returns {Array<{key: string, desc: string}>}
   */
  function getShortcutHelpList() {
    return [
      { key: 'n / c', desc: 'Neuen Termin erstellen' },
      { key: 'm / 1', desc: 'Monatsansicht' },
      { key: 'w / 2', desc: 'Wochenansicht' },
      { key: 'd / 3', desc: 'Tagesansicht' },
      { key: 'a / 4', desc: 'Agendaansicht' },
      { key: 'k / 5', desc: 'Kanban-Board' },
      { key: 't', desc: 'Heute (Aktueller Tag)' },
      { key: 'j / →', desc: 'Nächster Zeitraum' },
      { key: 'p / ←', desc: 'Vorheriger Zeitraum' },
      { key: ' / s', desc: 'Suchfeld fokussieren' },
      { key: '? / h', desc: 'Tastaturkürzel-Hilfe anzeigen' },
      { key: 'Esc', desc: 'Dialog / Modal schließen' }
    ];
  }

  return {
    parseShortcutAction,
    getShortcutHelpList
  };
}));
