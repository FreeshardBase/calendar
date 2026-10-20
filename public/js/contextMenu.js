/**
 * contextMenu.js — the right-click (or menu key / Shift+F10) menu on events and tasks (#515).
 * One menu at a time; arrow keys move between items, Escape or a click elsewhere closes it and
 * focus returns to where it was. The sidebar entries' move menu (#573) is one too.
 */

let _menu = null;
let _returnFocus = null;
let _onClose = null;

export function closeContextMenu() {
  if (!_menu) return;
  _menu.remove();
  _menu = null;
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('blur', closeContextMenu);
  const target = _returnFocus;
  _returnFocus = null;
  const onClose = _onClose;
  _onClose = null;
  if (onClose) onClose();
  if (target && target.isConnected) target.focus();
}

function onOutside(e) {
  if (_menu && !_menu.contains(e.target)) closeContextMenu();
}

// items: [{ label, action, disabled }]; `label` names the menu, `onClose` runs when it closes.
export function openContextMenu(x, y, items, returnFocus, { label, onClose } = {}) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  if (label) menu.setAttribute('aria-label', label);
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'context-menu-item';
    btn.setAttribute('role', 'menuitem');
    btn.tabIndex = -1;
    btn.textContent = item.label;
    btn.disabled = Boolean(item.disabled);
    btn.addEventListener('click', () => {
      closeContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  }
  menu.addEventListener('keydown', e => {
    const buttons = [...menu.querySelectorAll('.context-menu-item:not(:disabled)')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      buttons[(i + step + buttons.length) % buttons.length].focus();
    }
  });
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  _menu = menu;
  _returnFocus = returnFocus || document.activeElement;
  _onClose = onClose || null;
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('blur', closeContextMenu);
  menu.querySelector('.context-menu-item:not(:disabled)')?.focus();
}
