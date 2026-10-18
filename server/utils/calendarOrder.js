'use strict';

// #504: stable sort by the user's stored sidebar positions (Map id -> position); entries without
// a position go last and keep their order.
function sortByUserOrder(items, order, idOf) {
  const rank = item => (order.has(idOf(item)) ? order.get(idOf(item)) : Infinity);
  return items.sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1));
}

module.exports = { sortByUserOrder };
