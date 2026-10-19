'use strict';

/**
 * The shard's trash (#348): every delete in the app keeps a copy of what it removes from
 * Radicale, restorable for 30 days (Db.TRASH_RETENTION_MS). Radicale stays the source of
 * truth; the copy lives in `trash_items` and is put back with a plain CalDAV PUT/MKCALENDAR,
 * so a mirrored (linked) calendar carries the restore out to its provider on the next sync.
 */

const { DOMParser } = require('@xmldom/xmldom');
const ICAL = require('ical.js');
const Db = require('../db');

const ALL_ITEMS_REPORT = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR"/>
  </c:filter>
</c:calendar-query>`;

const COLLECTION_PROPFIND = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <a:calendar-color/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;

function byLocalName(node, name) {
  return Array.from(node.getElementsByTagNameNS('*', name));
}

function multistatus(xml, what) {
  const problems = [];
  const doc = new DOMParser({
    errorHandler: { warning: () => {}, error: (m) => problems.push(m), fatalError: (m) => problems.push(m) }
  }).parseFromString(String(xml ?? ''), 'text/xml');
  const root = doc && doc.documentElement;
  if (problems.length || !root || root.localName !== 'multistatus' || root.namespaceURI !== 'DAV:') {
    throw new Error(`${what}: server did not answer with a complete DAV multistatus`);
  }
  return root;
}

/** The SUMMARY of the item's first VEVENT/VTODO, or its UID when it has none. */
function itemTitle(ics) {
  const vcal = new ICAL.Component(ICAL.parse(ics));
  const comp = vcal.getFirstSubcomponent('vevent') || vcal.getFirstSubcomponent('vtodo');
  if (!comp) throw new Error('Trash: the resource holds no VEVENT or VTODO');
  return comp.getFirstPropertyValue('summary') || comp.getFirstPropertyValue('uid') || '';
}

/** Every resource of a collection as { href (path), ics }. A failed listing throws: nothing is deleted then. */
async function collectionItems(client, calendarUrl) {
  const root = multistatus(await client.report(calendarUrl, ALL_ITEMS_REPORT), 'Trash listing');
  const items = [];
  for (const response of byLocalName(root, 'response')) {
    const hrefEl = byLocalName(response, 'href')[0];
    const dataEl = byLocalName(response, 'calendar-data')[0];
    if (!hrefEl || !dataEl) continue;
    const ics = (dataEl.textContent || '').trim();
    if (!ics) continue;
    items.push({ href: new URL(hrefEl.textContent.trim(), calendarUrl).pathname, ics });
  }
  return items;
}

/** Display name, colour and component set of a collection. */
async function collectionProps(client, calendarUrl) {
  const root = multistatus(await client.propfind(calendarUrl, 0, COLLECTION_PROPFIND), 'Trash collection');
  const prop = byLocalName(root, 'prop')[0];
  const text = (name) => {
    const el = prop && byLocalName(prop, name)[0];
    return el ? (el.textContent || '').trim() : '';
  };
  const components = prop
    ? byLocalName(prop, 'comp').map(el => el.getAttribute('name')).filter(c => c === 'VEVENT' || c === 'VTODO')
    : [];
  return {
    name: text('displayname'),
    color: text('calendar-color') || null,
    components: components.length ? components : ['VEVENT', 'VTODO']
  };
}

/**
 * Whether the calendar mirrors a provider (Google, CalDAV, Microsoft 365) or is a live linked
 * account: a restore there re-creates the item at the provider, where its UID may change and
 * guests may get a new invitation, which the restore dialog says.
 */
async function isLinkedCalendar(userId, calendarId) {
  const sep = calendarId.indexOf('::');
  const accountId = calendarId.slice(0, sep);
  if (accountId !== 'internal-caldav') return true;
  const collection = calendarId.slice(sep + 2).split('/').filter(Boolean)[1];
  const mirrored = await Db.getMirroredCollectionAccounts(userId);
  if (mirrored.has(collection)) return true;
  const graph = await Db.getMSGraphAccounts(userId);
  return graph.some(a => a.targetCalendarId === calendarId);
}

/** Keep a copy of one event or task that is about to be deleted; returns the trash id. */
async function trashItem(userId, { kind, calendarId, href, ics }) {
  return Db.addTrashItem({
    userId, kind, calendarId,
    title: itemTitle(ics),
    linked: await isLinkedCalendar(userId, calendarId),
    payload: { href, ics }
  });
}

/** Keep a copy of a whole collection that is about to be deleted; returns the trash id. */
async function trashCollection(userId, { calendarId, client, calendarUrl }) {
  const props = await collectionProps(client, calendarUrl);
  const items = await collectionItems(client, calendarUrl);
  return Db.addTrashItem({
    userId, kind: 'calendar', calendarId,
    title: props.name || calendarId,
    linked: await isLinkedCalendar(userId, calendarId),
    payload: { url: new URL(calendarUrl).pathname, ...props, items }
  });
}

module.exports = { trashItem, trashCollection, collectionItems, itemTitle, isLinkedCalendar };
