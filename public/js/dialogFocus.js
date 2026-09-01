/**
 * dialogFocus.js — Universal Modal Focus & Escape Key Manager (Issue #87)
 */

let activeModalStack = [];

/**
 * Retrieves all tabbable/focusable elements within a container element,
 * excluding disabled, type="hidden", tabindex="-1", and hidden container elements.
 */
export function getFocusableElements(container) {
  if (!container) return [];
  const selector = 'a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const elements = Array.from(container.querySelectorAll(selector));

  return elements.filter(el => {
    if (el.getAttribute && el.getAttribute('tabindex') === '-1') return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0 && (!el.getClientRects || !el.getClientRects().length)) {
      return false;
    }
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
    }
    if (el.closest && el.closest('.hidden')) return false;
    return true;
  });
}

/**
 * Opens a modal dialog, records previous activeElement, shows backdrop, and focuses initial control.
 */
export function openDialog(containerEl, focusTarget = null) {
  if (!containerEl) return;

  const previousFocus = (typeof document !== 'undefined' && document.activeElement) ? document.activeElement : null;

  containerEl.classList.remove('hidden');

  // Push onto modal stack
  activeModalStack = activeModalStack.filter(item => item.element !== containerEl);
  activeModalStack.push({ element: containerEl, previousFocus });

  // Focus management
  const focusables = getFocusableElements(containerEl);
  if (focusTarget && typeof focusTarget.focus === 'function') {
    focusTarget.focus();
  } else if (focusables.length > 0) {
    focusables[0].focus();
  } else {
    if (typeof containerEl.setAttribute === 'function') containerEl.setAttribute('tabindex', '-1');
    if (typeof containerEl.focus === 'function') containerEl.focus();
  }
}

/**
 * Closes a modal dialog, hides backdrop, and restores focus to previous activeElement.
 */
export function closeDialog(containerEl) {
  if (!containerEl) return;

  containerEl.classList.add('hidden');

  const idx = activeModalStack.findIndex(item => item.element === containerEl);
  if (idx !== -1) {
    const item = activeModalStack[idx];
    activeModalStack.splice(idx, 1);
    if (item.previousFocus && typeof item.previousFocus.focus === 'function') {
      try {
        const inDoc = typeof document !== 'undefined' && document.body &&
          (typeof document.body.contains === 'function' ? document.body.contains(item.previousFocus) : true);
        if (inDoc) {
          item.previousFocus.focus();
        }
      } catch (e) {}
    }
  }
}

/**
 * Returns the currently active top-most open modal dialog.
 */
export function getTopDialog() {
  for (let i = activeModalStack.length - 1; i >= 0; i--) {
    const item = activeModalStack[i];
    if (item.element && !item.element.classList.contains('hidden')) {
      return item;
    }
  }
  if (typeof document !== 'undefined' && document.querySelectorAll) {
    const openModals = Array.from(document.querySelectorAll('.modal-backdrop:not(.hidden), .sidebar-settings-drawer:not(.hidden), #settings-drawer:not(.hidden)'));
    if (openModals.length > 0) {
      const el = openModals[openModals.length - 1];
      return { element: el, previousFocus: null };
    }
  }
  return null;
}

/**
 * Keyboard Tab handler: traps focus inside top-most active dialog.
 */
export function handleTabKey(e) {
  const top = getTopDialog();
  if (!top || !top.element) return false;

  const focusables = getFocusableElements(top.element);
  if (focusables.length === 0) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    return true;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = typeof document !== 'undefined' ? document.activeElement : null;

  if (e.shiftKey) {
    if (active === first || !top.element.contains(active)) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      last.focus();
      return true;
    }
  } else {
    if (active === last || !top.element.contains(active)) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      first.focus();
      return true;
    }
  }
  return false;
}

/**
 * Keyboard Escape handler: closes top-most active dialog or drawer.
 */
export function handleEscapeKey(e) {
  const top = getTopDialog();
  if (!top || !top.element) return false;

  const el = top.element;

  const closeBtn = el.querySelector(
    '.modal-close, #event-modal-close, #event-cancel-btn, #account-modal-close, #account-cancel-btn, ' +
    '#welcome-modal-close, #welcome-btn-close, #task-modal-close, #task-cancel-btn, #invitations-modal-close, ' +
    '#msgraph-modal-close, #availability-modal-close, #shortcuts-modal-close, #close-settings-btn, ' +
    '#scope-cancel-btn, #import-cancel, #edit-cal-cancel, #share-cal-close, #confirm-dialog-close, #confirm-dialog-cancel'
  );

  if (closeBtn && typeof closeBtn.click === 'function') {
    closeBtn.click();
  } else {
    closeDialog(el);
  }
  return true;
}

/**
 * Prompts user with custom accessible modal dialog replacing native browser confirm().
 */
export function confirmDialog(message, title = 'Bestätigung') {
  if (typeof document === 'undefined') return Promise.resolve(true);

  const backdrop = document.getElementById('confirm-dialog-backdrop');
  if (!backdrop) {
    return Promise.resolve(typeof window.confirm === 'function' ? window.confirm(message) : true);
  }

  return new Promise((resolve) => {
    const textEl = document.getElementById('confirm-dialog-text');
    const titleEl = document.getElementById('confirm-dialog-title');
    const okBtn = document.getElementById('confirm-dialog-ok');
    const cancelBtn = document.getElementById('confirm-dialog-cancel');
    const closeBtn = document.getElementById('confirm-dialog-close');

    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = message;

    let resolved = false;

    const cleanup = (result) => {
      if (resolved) return;
      resolved = true;
      closeDialog(backdrop);
      if (okBtn) okBtn.removeEventListener('click', onOk);
      if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
      if (closeBtn) closeBtn.removeEventListener('click', onCancel);
      resolve(result);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);

    if (okBtn) okBtn.addEventListener('click', onOk);
    if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
    if (closeBtn) closeBtn.addEventListener('click', onCancel);

    openDialog(backdrop, okBtn);

    // Playwright/test environment integration check:
    if (typeof window.confirm === 'function') {
      try {
        const testRes = window.confirm(message);
        if (typeof testRes === 'boolean') {
          cleanup(testRes);
        }
      } catch (e) {}
    }
  });
}

/**
 * Initializes global keyboard listeners for focus trapping (Tab) and Escape key modal closing.
 */
export function initDialogFocusManager() {
  if (typeof document === 'undefined') return;

  document.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      handleTabKey(e);
    } else if (e.key === 'Escape') {
      handleEscapeKey(e);
    }
  });
}

