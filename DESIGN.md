# DESIGN.md — UI decisions beyond the design guide

What FreeShard's design guide does not cover is decided here (see CONCEPTS.md, "Design").

## Reordering the sidebar on touch devices (#573)

- **Drag handle, not long press.** Every sidebar entry (calendars, task lists, subscriptions) has a grip at
  its right edge. A touch drags the entry only by the grip; it alone has `touch-action: none`, so a swipe
  anywhere else on the entry keeps scrolling the sidebar. This is the same pattern as the Kanban card's grip
  (#499). On phones (≤ 768 px or a coarse pointer) the grip is always shown and is a 44 × 44 px target; with a
  mouse it appears on hover or keyboard focus, and the whole entry stays draggable as before (#504).
- **Menu as the alternative to dragging.** The grip is a menu button ("„Name“ verschieben"). Tapping or
  activating it opens a menu with "Nach oben" and "Nach unten", which move the entry one place within its
  group; at the group's edge the item is disabled. Focus returns to the moved entry's grip. Alt+↑ / Alt+↓ on
  the entry remain.
- Groups and storage are unchanged from #504: entries move only within their group, and each move saves the
  group's order.
