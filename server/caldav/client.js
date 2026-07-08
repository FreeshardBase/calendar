'use strict';

/**
 * CalDAVClient
 * Low-level HTTP client for CalDAV (RFC 4791 / WebDAV RFC 4918).
 * Uses Node.js 20 native fetch — no external HTTP dependency.
 */
class CalDAVClient {
  constructor({ url, username, password }) {
    // Normalise base URL: remove trailing slash
    this.baseUrl = url.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this._auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  // ── Core request ────────────────────────────────────────────────────────────

  async _request(method, url, { body, headers = {} } = {}) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this._auth,
        'Content-Type': 'application/xml; charset=utf-8',
        ...headers
      },
      body
    });
    return response;
  }

  // ── CalDAV Methods ──────────────────────────────────────────────────────────

  async propfind(url, depth, body) {
    const res = await this._request('PROPFIND', url, {
      body,
      headers: { Depth: String(depth) }
    });
    if (res.status !== 207 && !res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PROPFIND ${res.status}: ${res.statusText} — ${text.slice(0, 200)}`);
    }
    return res.text();
  }

  async report(url, body) {
    const res = await this._request('REPORT', url, {
      body,
      headers: { Depth: '1' }
    });
    if (res.status !== 207 && !res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`REPORT ${res.status}: ${res.statusText} — ${text.slice(0, 200)}`);
    }
    return res.text();
  }

  /**
   * Create or update an event.
   * @param {string} url        - Full event URL (.ics)
   * @param {string} icsData    - iCalendar text
   * @param {string|null} etag  - For updates: current ETag (with quotes). Null for creation.
   */
  async put(url, icsData, etag = null) {
    const headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
    if (etag) {
      headers['If-Match'] = etag;
    } else {
      headers['If-None-Match'] = '*'; // Fail if resource already exists
    }

    const res = await this._request('PUT', url, { body: icsData, headers });

    if (res.status === 412) throw new Error('ETAG_CONFLICT');
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`PUT ${res.status}: ${res.statusText}`);
    }

    return {
      status: res.status,
      etag: res.headers.get('etag') || null
    };
  }

  /**
   * Delete an event.
   * @param {string} url        - Full event URL
   * @param {string|null} etag  - Current ETag for conflict detection
   */
  async delete(url, etag = null) {
    const headers = {};
    if (etag) headers['If-Match'] = etag;

    const res = await this._request('DELETE', url, { headers });

    if (res.status === 412) throw new Error('ETAG_CONFLICT');
    if (!res.ok && res.status !== 204) {
      throw new Error(`DELETE ${res.status}: ${res.statusText}`);
    }
    return true;
  }

  async mkcalendar(url, displayName, color = '#6366f1') {
    // Step 1: Create the calendar collection (no color — Nextcloud rejects it in MKCALENDAR)
    const mkBody = `<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:displayname>${escapeXML(displayName)}</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VEVENT"/>
        <c:comp name="VTODO"/>
      </c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</c:mkcalendar>`;

    const res = await this._request('MKCALENDAR', url, { body: mkBody });
    if (!res.ok && res.status !== 201) {
      const text = await res.text().catch(() => '');
      throw new Error(`MKCALENDAR ${res.status}: ${text.slice(0, 200) || res.statusText}`);
    }

    // Step 2: Set the calendar color via PROPPATCH (Apple + Nextcloud namespace)
    if (color) {
      const ppBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/" xmlns:nc="http://nextcloud.org/ns">
  <d:set>
    <d:prop>
      <a:calendar-color>${escapeXML(color)}</a:calendar-color>
    </d:prop>
  </d:set>
</d:propertyupdate>`;
      // Best-effort — don't fail if color PROPPATCH doesn't work
      await this._request('PROPPATCH', url, { body: ppBody }).catch(e =>
        console.warn('[mkcalendar] PROPPATCH color failed:', e.message)
      );
    }

    return true;
  }

  // ── High-level helpers ──────────────────────────────────────────────────────

  /** Verify credentials and URL by doing a minimal PROPFIND. */
  async testConnection() {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;

    const res = await this._request('PROPFIND', this.baseUrl, {
      body,
      headers: { Depth: '0' }
    });

    if (res.status === 401) throw new Error('UNAUTHORIZED');
    if (res.status === 404) throw new Error('NOT_FOUND');
    if (res.status === 207 || res.ok) return true;
    throw new Error(`HTTP_${res.status}`);
  }

  /** List all calendar collections under the base URL. */
  async getCalendars() {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"
            xmlns:c="urn:ietf:params:xml:ns:caldav"
            xmlns:a="http://apple.com/ns/ical/"
            xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <a:calendar-color/>
    <cs:getctag/>
    <d:sync-token/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;

    return this.propfind(this.baseUrl, 1, body);
  }

  /** Fetch events within a date range from a specific calendar URL. */
  async getEvents(calendarUrl, startDate, endDate) {
    const start = toICalDateTime(startDate);
    const end   = toICalDateTime(endDate);

    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${start}" end="${end}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

    return this.report(calendarUrl, body);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function toICalDateTime(date) {
  return date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function escapeXML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = CalDAVClient;
