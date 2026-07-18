'use strict';

/**
 * CalDAVClient
 * Low-level HTTP client for CalDAV (RFC 4791 / WebDAV RFC 4918).
 * Uses Node.js 20 native fetch — no external HTTP dependency.
 */
class CalDAVClient {
  constructor({ url, username, password, authType = 'basic', accessToken }) {
    this.baseUrl = url.replace(/\/+$/, '');
    this.username = username;
    this.password = password; // refresh_token for oauth2
    this.authType = authType;
    this.accessToken = accessToken;
  }

  // ── Core request ────────────────────────────────────────────────────────────

  async _request(method, url, { body, headers = {} } = {}) {
    const authHeader = this.authType === 'oauth2'
      ? `Bearer ${this.accessToken}`
      : 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');

    const reqHeaders = {
      Authorization: authHeader,
      ...headers
    };
    if (body && !reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
      reqHeaders['Content-Type'] = 'application/xml; charset=utf-8';
    }
    const response = await fetch(url, {
      method,
      headers: reqHeaders,
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
   * Fetch a single resource (event .ics) with its ETag.
   */
  async get(url) {
    const res = await this._request('GET', url);
    if (!res.ok) {
      throw new Error(`GET ${res.status}: ${res.statusText}`);
    }
    return {
      ics: await res.text(),
      etag: res.headers.get('etag') || null
    };
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

  /**
   * Run automated service discovery to resolve the user's calendar-home-set.
   * Modifies this.baseUrl to the discovered home set URL.
   */
  async discover() {
    let targetUrl = this.baseUrl;
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    let currentUrl = targetUrl;
    let xmlResponse = null;

    const queryProps = async (url) => {
      const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:current-user-principal/>
    <c:calendar-home-set/>
  </d:prop>
</d:propfind>`;
      
      const res = await this._request('PROPFIND', url, {
        body: xmlBody,
        headers: { Depth: '0' }
      });
      
      if (res.status === 401) throw new Error('UNAUTHORIZED');
      if (!res.ok && res.status !== 207) return null;
      return res.text();
    };

    const extractTagValue = (xml, tagName) => {
      const regex = new RegExp(`<([\\w-]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/([\\w-]+:)?${tagName}>`, 'i');
      const match = xml.match(regex);
      if (!match) return null;
      return match[2].trim();
    };

    // Phase 1: Try the provided URL directly
    try {
      xmlResponse = await queryProps(currentUrl);
    } catch (e) {
      if (e.message === 'UNAUTHORIZED') throw e;
    }

    // Phase 2: Try /.well-known/caldav fallback
    if (!xmlResponse) {
      try {
        const u = new URL(currentUrl);
        const wellKnownUrl = `${u.protocol}//${u.host}/.well-known/caldav`;
        const redirectRes = await this._request('PROPFIND', wellKnownUrl, {
          headers: { Depth: '0' }
        });
        if (redirectRes.status === 401) throw new Error('UNAUTHORIZED');
        if (redirectRes.ok || redirectRes.status === 207) {
          currentUrl = redirectRes.url;
          xmlResponse = await queryProps(currentUrl);
        }
      } catch (e) {
        if (e.message === 'UNAUTHORIZED') throw e;
      }
    }

    if (!xmlResponse) {
      throw new Error('COULD_NOT_RESOLVE_CALDAV_ENDPOINT');
    }

    // Phase 3: Parse response XML for calendar-home-set or principal
    let homeSetHref = null;
    const homeSetBlock = extractTagValue(xmlResponse, 'calendar-home-set');
    if (homeSetBlock) {
      homeSetHref = extractTagValue(homeSetBlock, 'href');
    }
    
    if (!homeSetHref) {
      const principalBlock = extractTagValue(xmlResponse, 'current-user-principal');
      if (principalBlock) {
        const principalHref = extractTagValue(principalBlock, 'href');
        if (principalHref) {
          const principalUrl = new URL(principalHref, currentUrl).href;
          const principalXml = await queryProps(principalUrl);
          if (principalXml) {
            const innerHomeSetBlock = extractTagValue(principalXml, 'calendar-home-set');
            if (innerHomeSetBlock) {
              homeSetHref = extractTagValue(innerHomeSetBlock, 'href');
            }
          }
        }
      }
    }

    let resolvedHomeSet = null;
    if (!homeSetHref) {
      resolvedHomeSet = currentUrl;
    } else {
      resolvedHomeSet = new URL(homeSetHref, currentUrl).href;
    }

    if (!resolvedHomeSet.endsWith('/')) resolvedHomeSet += '/';

    this.baseUrl = resolvedHomeSet;
    return resolvedHomeSet;
  }

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

  /** Retrieve current share invitations of a calendar. */
  async getCalendarShares(calendarUrl) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:o="http://owncloud.org/ns">
  <d:prop>
    <cs:invite/>
    <o:invite/>
  </d:prop>
</d:propfind>`;

    const res = await this._request('PROPFIND', calendarUrl, {
      body,
      headers: { Depth: '0' }
    });

    if (!res.ok && res.status !== 207) {
      return [];
    }

    const text = await res.text();
    
    // Cache sharing type based on response property namespace
    if (!this._sharingTypes) {
      this._sharingTypes = {};
    }
    if (text.includes('xmlns:oc="http://owncloud.org/ns"') || text.includes('xmlns:o="http://owncloud.org/ns"') || text.includes('oc:invite') || text.includes('o:invite')) {
      this._sharingTypes[calendarUrl] = 'owncloud';
    } else {
      this._sharingTypes[calendarUrl] = 'standard';
    }

    const userBlocks = text.match(/<([^:>]*:)?user[^>]*>([\s\S]*?)<\/([^:>]*:)?user>/gi) || [];
    const shares = [];

    const extractTagValue = (xml, tagName) => {
      const regex = new RegExp(`<([\\w-]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/([\\w-]+:)?${tagName}>`, 'i');
      const match = xml.match(regex);
      return match ? match[2].trim() : null;
    };

    for (const block of userBlocks) {
      let href = extractTagValue(block, 'href') || '';
      if (href.startsWith('mailto:')) href = href.slice(7);
      const commonName = extractTagValue(block, 'common-name') || extractTagValue(block, 'commonname') || '';
      
      const accessBlock = extractTagValue(block, 'access') || '';
      const readWrite = accessBlock.includes('read-write');
      
      const status = block.includes('invite-accepted') ? 'ACCEPTED'
                   : block.includes('invite-declined') ? 'DECLINED'
                   : 'NO_RESPONSE';

      shares.push({ href, commonName, readWrite, status });
    }

    return shares;
  }

  async _detectSharingType(calendarUrl) {
    if (this._sharingTypes && this._sharingTypes[calendarUrl]) {
      return this._sharingTypes[calendarUrl];
    }
    if (!this._sharingTypes) {
      this._sharingTypes = {};
    }

    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:o="http://owncloud.org/ns">
  <d:prop>
    <cs:invite/>
    <o:invite/>
  </d:prop>
</d:propfind>`;

    try {
      const res = await this._request('PROPFIND', calendarUrl, {
        body,
        headers: { Depth: '0' }
      });
      if (res.ok || res.status === 207) {
        const text = await res.text();
        if (text.includes('xmlns:oc="http://owncloud.org/ns"') || text.includes('xmlns:o="http://owncloud.org/ns"') || text.includes('oc:invite') || text.includes('o:invite')) {
          this._sharingTypes[calendarUrl] = 'owncloud';
          return 'owncloud';
        }
      }
    } catch (e) {
      console.error('[detectSharingType] Failed to detect sharing type:', e);
    }
    
    this._sharingTypes[calendarUrl] = 'standard';
    return 'standard';
  }

  async resolveNextcloudPrincipal(href) {
    if (href.startsWith('principal:')) {
      return href.replace(/\/$/, '');
    }
    if (href.includes('principals/')) {
      const match = href.match(/principals\/(users|groups|circles)\/[^/]+/);
      if (match) {
        return 'principal:' + match[0];
      }
    }
    if (href.includes('@')) {
      const email = href.startsWith('mailto:') ? href.slice(7) : href;
      const matchedUsers = await this.searchUsers(email);
      const user = matchedUsers.find(u => u.email.toLowerCase() === email.toLowerCase());
      if (user && user.href) {
        const match = user.href.match(/principals\/(users|groups|circles)\/[^/]+/);
        if (match) {
          return 'principal:' + match[0];
        }
      }
    }
    return 'principal:principals/users/' + href;
  }

  /** Add or remove a share invitation. */
  async updateCalendarShares(calendarUrl, { href, readWrite, remove = false }) {
    const type = await this._detectSharingType(calendarUrl);
    
    if (type === 'owncloud') {
      const resolvedHref = await this.resolveNextcloudPrincipal(href);
      let xml = `<?xml version="1.0" encoding="utf-8"?>
<o:share xmlns:o="http://owncloud.org/ns" xmlns:d="DAV:">`;

      if (remove) {
        xml += `
  <o:remove>
    <d:href>${resolvedHref}</d:href>
  </o:remove>`;
      } else {
        xml += `
  <o:set>
    <d:href>${resolvedHref}</d:href>
    ${readWrite ? '<o:read-write/>' : ''}
  </o:set>`;
      }
      xml += `
</o:share>`;

      const res = await this._request('POST', calendarUrl, {
        body: xml,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' }
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Failed to update shares: ${res.status} ${txt.slice(0, 200)}`);
      }
      return true;
    } else {
      let targetHref = href;
      if (!targetHref.startsWith('mailto:') && !targetHref.startsWith('http://') && !targetHref.startsWith('https://') && targetHref.includes('@')) {
        targetHref = 'mailto:' + targetHref;
      }

      let xml = `<?xml version="1.0" encoding="utf-8"?>
<cs:share xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">`;

      if (remove) {
        xml += `
  <cs:remove>
    <d:href>${targetHref}</d:href>
  </cs:remove>`;
      } else {
        xml += `
  <cs:set>
    <d:href>${targetHref}</d:href>
    ${readWrite ? '<cs:read-write/>' : '<cs:read/>'}
  </cs:set>`;
      }

      xml += `
</cs:share>`;

      const res = await this._request('POST', calendarUrl, {
        body: xml,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' }
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Failed to update shares: ${res.status} ${txt.slice(0, 200)}`);
      }
      return true;
    }
  }

  /** Search for other server principals by displayname or email. */
  async searchUsers(query) {
    // 1. Resolve current-user-principal dynamically to find the parent principal collection
    const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>`;

    let principalCollectionUrl = new URL('/remote.php/dav/principals/users/', this.baseUrl).href; // Fallback

    const propfindRes = await this._request('PROPFIND', this.baseUrl, {
      body: propfindBody,
      headers: { Depth: '0' }
    });

    const extractTagValue = (xml, tagName) => {
      const regex = new RegExp(`<([\\w-]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/([\\w-]+:)?${tagName}>`, 'i');
      const match = xml.match(regex);
      return match ? match[2].trim() : null;
    };

    if (propfindRes.ok || propfindRes.status === 207) {
      const xml = await propfindRes.text();
      const principalBlock = extractTagValue(xml, 'current-user-principal');
      if (principalBlock) {
        let principalHref = extractTagValue(principalBlock, 'href') || '';
        if (principalHref) {
          const urlObj = new URL(principalHref, this.baseUrl);
          const pathSegments = urlObj.pathname.split('/').filter(Boolean);
          if (pathSegments.length > 0) {
            pathSegments.pop(); // Remove username segment to get the parent principal collection
            urlObj.pathname = '/' + pathSegments.join('/') + '/';
            principalCollectionUrl = urlObj.href;
          }
        }
      }
    }

    const xml = `<?xml version="1.0" encoding="utf-8" ?>
<d:principal-property-search xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">
  <d:property-search>
    <d:prop>
      <d:displayname />
    </d:prop>
    <d:match>${query}</d:match>
  </d:property-search>
  <d:prop>
    <d:displayname />
    <s:email-address />
  </d:prop>
</d:principal-property-search>`;

    console.log('[searchUsers] Querying URL:', principalCollectionUrl);
    const res = await this._request('REPORT', principalCollectionUrl, {
      body: xml,
      headers: { Depth: '0' }
    });

    const parsePrincipalSearch = (xmlText) => {
      const responses = xmlText.match(/<([^:>]*:)?response[^>]*>([\s\S]*?)<\/([^:>]*:)?response>/gi) || [];
      const results = [];

      for (const resp of responses) {
        const displayname = extractTagValue(resp, 'displayname') || '';
        const email = extractTagValue(resp, 'email-address') || '';
        let href = extractTagValue(resp, 'href') || '';
        if (displayname || email) {
          results.push({ displayname, email, href });
        }
      }
      return results;
    };

    const text = await res.text();
    console.log('[searchUsers] Primary response status:', res.status, 'body length:', text.length, 'body:', text);

    if (!res.ok && res.status !== 207) {
      console.log('[searchUsers] Primary failed, attempting fallback on baseUrl:', this.baseUrl);
      const res2 = await this._request('REPORT', this.baseUrl, {
        body: xml,
        headers: { Depth: '0' }
      });
      if (!res2.ok && res2.status !== 207) {
        console.log('[searchUsers] Fallback failed status:', res2.status);
        return [];
      }
      const text2 = await res2.text();
      console.log('[searchUsers] Fallback response status:', res2.status, 'body:', text2);
      return parsePrincipalSearch(text2);
    }

    return parsePrincipalSearch(text);
  }

  /** Fetch custom DAV properties. */
  async getCustomProperty(url, namespace, propName) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:x="${namespace}">
  <d:prop>
    <x:${propName}/>
  </d:prop>
</d:propfind>`;

    const res = await this._request('PROPFIND', url, {
      body,
      headers: { Depth: '0' }
    });

    if (!res.ok && res.status !== 207) return null;
    const xml = await res.text();
    const extractTagValue = (xml, tagName) => {
      const regex = new RegExp(`<([\\w-]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/([\\w-]+:)?${tagName}>`, 'i');
      const match = xml.match(regex);
      return match ? match[2].trim() : null;
    };
    return extractTagValue(xml, propName);
  }

  /** Write custom DAV properties. */
  async setCustomProperty(url, namespace, propName, value) {
    let body = `<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:x="${namespace}">`;

    if (value === null || value === undefined) {
      body += `
  <d:remove>
    <d:prop>
      <x:${propName}/>
    </d:prop>
  </d:remove>`;
    } else {
      body += `
  <d:set>
    <d:prop>
      <x:${propName}>${escapeXML(value)}</x:${propName}>
    </d:prop>
  </d:set>`;
    }

    body += `
</d:propertyupdate>`;

    const res = await this._request('PROPPATCH', url, { body });
    return res.ok || res.status === 207;
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
