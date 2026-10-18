/**
 * sidebarOrder.js — Reordering the entries of a sidebar list (#504).
 *
 * Every entry carries `data-order-group`; it moves only among entries of the same group (own
 * calendars, one linked account, subscriptions), by a pointer drag or with Alt+↑ / Alt+↓.
 * `onReorder(ids)` receives the group's ids in their new order and re-renders the list.
 *
 * The drag uses pointer events like the Kanban cards (#499). A touch keeps scrolling the sidebar:
 * the browser cancels the pointer, which ends the gesture without a move; Alt+↑/↓ remains.
 */

export const REORDER_HINT = 'Mit Alt+↑ / Alt+↓ oder per Drag & Drop verschieben';
const DRAG_THRESHOLD_PX = 5;

// The ids of one group in the list's current order.
function groupIds(list, itemSelector, idOf, group) {
  return [...list.querySelectorAll(itemSelector)].filter(el => el.dataset.orderGroup === group).map(idOf);
}

function moved(ids, id, toIndex) {
  const rest = ids.filter(x => x !== id);
  rest.splice(toIndex, 0, id);
  return rest;
}

// Puts `ids` into the slots their entries hold in `items`, so other groups keep their places.
export function applyGroupOrder(items, ids, idOf) {
  const set = new Set(ids);
  const queue = [...ids];
  const byId = new Map(items.map(item => [idOf(item), item]));
  return items.map(item => (set.has(idOf(item)) ? byId.get(queue.shift()) : item));
}

// The list an entry is being dragged in, and the re-render a reload asked for meanwhile: replacing
// the entries under the pointer would lose the drop.
let draggingIn = null;
const deferredRenders = new Map();

// True when `list` is mid-drag; `render` then runs once the drag ends without a drop.
export function renderLater(list, render) {
  if (draggingIn !== list) return false;
  deferredRenders.set(list, render);
  return true;
}

function endDrag(list) {
  draggingIn = null;
  const render = deferredRenders.get(list);
  deferredRenders.delete(list);
  return render;
}

// The entry of `group` under the pointer, and whether the pointer is on its lower half.
function dropTargetAt(list, itemSelector, group, dragged, y) {
  for (const el of list.querySelectorAll(itemSelector)) {
    if (el === dragged || el.dataset.orderGroup !== group) continue;
    const r = el.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom) return { el, after: y > r.top + r.height / 2 };
  }
  return null;
}

function enableDrag(list, el, { itemSelector, idOf, onReorder }) {
  el.addEventListener('pointerdown', down => {
    if (down.button !== 0 || down.target.closest('button')) return;
    const group = el.dataset.orderGroup;
    let dragging = false;
    let target = null;

    const mark = next => {
      if (target) target.el.classList.remove('drop-before', 'drop-after');
      target = next;
      if (target) target.el.classList.add(target.after ? 'drop-after' : 'drop-before');
    };
    const move = e => {
      if (e.pointerId !== down.pointerId) return;
      const dy = e.clientY - down.clientY;
      if (!dragging) {
        if (Math.hypot(e.clientX - down.clientX, dy) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        draggingIn = list;
        el.classList.add('dragging');
      }
      e.preventDefault();
      el.style.transform = `translateY(${dy}px)`;
      mark(dropTargetAt(list, itemSelector, group, el, e.clientY));
    };
    const end = e => {
      if (e.pointerId !== down.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (!dragging) return;
      const drop = target;
      mark(null);
      el.classList.remove('dragging');
      el.style.transform = '';
      // The release ends a drag, not a click: the entry's visibility stays as it is.
      const swallowClick = c => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener('click', swallowClick, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }), 0);
      const deferred = endDrag(list);
      if (e.type !== 'pointerup' || !drop) {
        if (deferred) deferred();
        return;
      }
      // onReorder renders the current state, which includes whatever a deferred render would show.
      const id = idOf(el);
      const ids = groupIds(list, itemSelector, idOf, group).filter(x => x !== id);
      onReorder(moved([id, ...ids], id, ids.indexOf(idOf(drop.el)) + (drop.after ? 1 : 0)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
}

export function enableReorder(list, { itemSelector, idOf, onReorder }) {
  for (const el of list.querySelectorAll(itemSelector)) {
    el.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    el.title = REORDER_HINT;
    enableDrag(list, el, { itemSelector, idOf, onReorder });

    el.addEventListener('keydown', e => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.target !== el) return;
      e.preventDefault();
      const ids = groupIds(list, itemSelector, idOf, el.dataset.orderGroup);
      const id = idOf(el);
      const target = ids.indexOf(id) + (e.key === 'ArrowUp' ? -1 : 1);
      if (target < 0 || target >= ids.length) return;
      onReorder(moved(ids, id, target));
      const again = [...list.querySelectorAll(itemSelector)].find(x => idOf(x) === id);
      if (again) again.focus();
    });
  }
}
