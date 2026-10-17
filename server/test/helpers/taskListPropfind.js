'use strict';

/**
 * Multistatus a CalDAV server answers to a Depth 0 PROPFIND on a task list: a calendar collection
 * whose supported-calendar-component-set holds VEVENT and VTODO. The tasks routes ask for it before
 * every task write (#495); fake servers use this to answer that question.
 */
function taskListMultistatus(collectionPath) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + `<d:response><d:href>${collectionPath}</d:href><d:propstat><d:prop>`
    + '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
    + '<c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>'
    + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
}

module.exports = { taskListMultistatus };
