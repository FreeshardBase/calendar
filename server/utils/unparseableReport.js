'use strict';

const UNPARSEABLE_REPORT_LIMIT = 5;

// Resources the server returned but that could not be parsed are left out of
// a list response; name them so the loss is visible rather than silent (#128,
// #208). Percent-encoded so any href or message stays a legal header value;
// the list is capped, the count is not (the parser logs every failure).
function setUnparseableHeader(res, unparseable) {
  if (unparseable.length === 0) return;
  res.setHeader('X-CalDAV-Unparseable', encodeURIComponent(JSON.stringify({
    count: unparseable.length,
    resources: unparseable.slice(0, UNPARSEABLE_REPORT_LIMIT).map(u => ({ calendarId: u.calendarId, href: u.href }))
  })));
}

module.exports = { setUnparseableHeader };
