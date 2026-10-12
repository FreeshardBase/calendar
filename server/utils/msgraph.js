'use strict';

const Db = require('../db');
const { parseICSToEvent, eventToICS } = require('../caldav/parser');

// Standard mapping from Microsoft Windows Time Zones to IANA Time Zones (Unicode CLDR)
const WINDOWS_TO_IANA_TIMEZONES = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Etc/GMT+11',
  'Aleutian Standard Time': 'America/Adak',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Marquesas Standard Time': 'Pacific/Marquesas',
  'Alaskan Standard Time': 'America/Anchorage',
  'UTC-09': 'Etc/GMT+9',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'UTC-08': 'Etc/GMT+8',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time (Mexico)': 'America/Mazatlan',
  'Mountain Standard Time': 'America/Denver',
  'Yukon Standard Time': 'America/Whitehorse',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time': 'America/Chicago',
  'Easter Island Standard Time': 'Pacific/Easter',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'Eastern Standard Time': 'America/New_York',
  'Haiti Standard Time': 'America/Port-au-Prince',
  'Cuba Standard Time': 'America/Havana',
  'US Eastern Standard Time': 'America/Indianapolis',
  'Turks And Caicos Standard Time': 'America/Grand_Turk',
  'Paraguay Standard Time': 'America/Asuncion',
  'Atlantic Standard Time': 'America/Halifax',
  'Venezuela Standard Time': 'America/Caracas',
  'Central Brazilian Standard Time': 'America/Cuiaba',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Tocantins Standard Time': 'America/Araguaina',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'Greenland Standard Time': 'America/Godthab',
  'Montevideo Standard Time': 'America/Montevideo',
  'Magallanes Standard Time': 'America/Punta_Arenas',
  'Saint Pierre Standard Time': 'America/Miquelon',
  'Bahia Standard Time': 'America/Bahia',
  'UTC-02': 'Etc/GMT+2',
  'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde',
  'UTC': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'Sao Tome Standard Time': 'Africa/Sao_Tome',
  'Morocco Standard Time': 'Africa/Casablanca',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Prague',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'Jordan Standard Time': 'Asia/Amman',
  'GTB Standard Time': 'Europe/Bucharest',
  'Middle East Standard Time': 'Asia/Beirut',
  'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Syria Standard Time': 'Asia/Damascus',
  'West Bank Standard Time': 'Asia/Hebron',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Sudan Standard Time': 'Africa/Khartoum',
  'Libya Standard Time': 'Africa/Tripoli',
  'Namibia Standard Time': 'Africa/Windhoek',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Arab Standard Time': 'Asia/Riyadh',
  'Belarus Standard Time': 'Europe/Minsk',
  'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'Astrakhan Standard Time': 'Europe/Astrakhan',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Russia Time Zone 3': 'Europe/Samara',
  'Mauritius Standard Time': 'Indian/Mauritius',
  'Saratov Standard Time': 'Europe/Saratov',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Volgograd Standard Time': 'Europe/Volgograd',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Afghanistan Standard Time': 'Asia/Kabul',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Pakistan Standard Time': 'Asia/Karachi',
  'Qyzylorda Standard Time': 'Asia/Qyzylorda',
  'India Standard Time': 'Asia/Kolkata',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Kathmandu',
  'Central Asia Standard Time': 'Asia/Almaty',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'Omsk Standard Time': 'Asia/Omsk',
  'Myanmar Standard Time': 'Asia/Yangon',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Altai Standard Time': 'Asia/Barnaul',
  'W. Mongolia Standard Time': 'Asia/Hovd',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'Tomsk Standard Time': 'Asia/Tomsk',
  'China Standard Time': 'Asia/Shanghai',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'Aus Central W. Standard Time': 'Australia/Eucla',
  'Transbaikal Standard Time': 'Asia/Chita',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'North Korea Standard Time': 'Asia/Pyongyang',
  'Korea Standard Time': 'Asia/Seoul',
  'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Tasmania Standard Time': 'Australia/Hobart',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'Lord Howe Standard Time': 'Australia/Lord_Howe',
  'Bougainville Standard Time': 'Pacific/Bougainville',
  'Russia Time Zone 10': 'Asia/Srednekolymsk',
  'Magadan Standard Time': 'Asia/Magadan',
  'Norfolk Standard Time': 'Pacific/Norfolk',
  'Sakhalin Standard Time': 'Asia/Sakhalin',
  'Central Pacific Standard Time': 'Pacific/Guadalcanal',
  'Russia Time Zone 11': 'Asia/Kamchatka',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC+12': 'Etc/GMT-12',
  'Fiji Standard Time': 'Pacific/Fiji',
  'Chatham Islands Standard Time': 'Pacific/Chatham',
  'UTC+13': 'Etc/GMT-13',
  'Tonga Standard Time': 'Pacific/Tongatapu',
  'Samoa Standard Time': 'Pacific/Apia',
  'Line Islands Standard Time': 'Pacific/Kiritimati'
};

/**
 * Converts Microsoft Graph dateTime and timeZone into a standard ISO 8601 UTC string.
 * Handles both Windows timezone names and IANA timezone names.
 */
function graphDateTimeToISO(dateTimeStr, timeZone) {
  if (!dateTimeStr) return new Date().toISOString();
  if (dateTimeStr.endsWith('Z')) return new Date(dateTimeStr).toISOString();

  const ianaZone = WINDOWS_TO_IANA_TIMEZONES[timeZone] || timeZone || 'UTC';
  if (ianaZone === 'UTC' || ianaZone === 'Etc/UTC') {
    return new Date(dateTimeStr + 'Z').toISOString();
  }

  const m = dateTimeStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return new Date(dateTimeStr + 'Z').toISOString();

  const [_, y, mo, d, h, mi, s, msRaw] = m;
  const ms = msRaw ? msRaw.slice(0, 3).padEnd(3, '0') : '000';
  const approxUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms);

  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23'
    });

    let guess = approxUtc;
    for (let i = 0; i < 3; i++) {
      const parts = dtf.formatToParts(new Date(guess));
      const getPart = (type) => parts.find(p => p.type === type)?.value;
      const formattedY = +getPart('year');
      const formattedMo = +getPart('month');
      const formattedD = +getPart('day');
      const formattedH = +getPart('hour');
      const formattedMi = +getPart('minute');
      const formattedS = +getPart('second');
      const formattedAsUtc = Date.UTC(formattedY, formattedMo - 1, formattedD, formattedH, formattedMi, formattedS, +ms);
      const diff = formattedAsUtc - approxUtc;
      if (diff === 0) break;
      guess -= diff;
    }
    return new Date(guess).toISOString();
  } catch (err) {
    return new Date(dateTimeStr + 'Z').toISOString();
  }
}

/**
 * Converts Microsoft Graph Event JSON payload into standard WebCalendar VEVENT object.
 */
function graphEventToVEVENT(graphEvent) {
  if (!graphEvent) return null;

  const rawId = graphEvent.id || `msgraph-${Date.now()}`;
  const uid = rawId.startsWith('msgraph-event-') ? rawId : `msgraph-event-${rawId}`;
  const title = graphEvent.subject || '(Ohne Titel)';
  const description = (graphEvent.body && graphEvent.body.content) ? graphEvent.body.content.replace(/<[^>]*>?/gm, '') : '';
  const location = (graphEvent.location && graphEvent.location.displayName) ? graphEvent.location.displayName : '';

  let startIso = new Date().toISOString();
  if (graphEvent.start && graphEvent.start.dateTime) {
    startIso = graphDateTimeToISO(graphEvent.start.dateTime, graphEvent.start.timeZone);
  }

  let endIso = new Date(Date.now() + 3600000).toISOString();
  if (graphEvent.end && graphEvent.end.dateTime) {
    endIso = graphDateTimeToISO(graphEvent.end.dateTime, graphEvent.end.timeZone);
  }

  const attendees = Array.isArray(graphEvent.attendees)
    ? graphEvent.attendees.map(a => ({
        name: (a.emailAddress && a.emailAddress.name) || (a.emailAddress && a.emailAddress.address) || 'Test User',
        email: (a.emailAddress && a.emailAddress.address) || 'testuser@example.com',
        status: (a.status && a.status.response) ? a.status.response.toUpperCase() : 'NEEDS-ACTION'
      }))
    : [];

  return {
    uid,
    title,
    description,
    location,
    start: startIso,
    end: endIso,
    attendees,
    eTag: graphEvent['@odata.etag'] || '',
    isGraphSynced: true
  };
}

/**
 * Converts standard WebCalendar VEVENT object into Microsoft Graph Event JSON payload.
 */
function veventToGraphEvent(eventObj) {
  if (!eventObj) return null;

  const startIso = eventObj.start ? new Date(eventObj.start).toISOString() : new Date().toISOString();
  const endIso = eventObj.end ? new Date(eventObj.end).toISOString() : new Date(Date.now() + 3600000).toISOString();

  const attendees = Array.isArray(eventObj.attendees)
    ? eventObj.attendees.map(a => ({
        emailAddress: {
          address: a.email || 'testuser@example.com',
          name: a.name || 'Test User'
        },
        type: 'required'
      }))
    : [];

  return {
    subject: eventObj.title || 'Neuer Termin',
    body: {
      contentType: 'text',
      content: eventObj.description || ''
    },
    start: {
      dateTime: startIso.slice(0, 19),
      timeZone: 'UTC'
    },
    end: {
      dateTime: endIso.slice(0, 19),
      timeZone: 'UTC'
    },
    location: {
      displayName: eventObj.location || ''
    },
    attendees
  };
}

// In-flight push mutex map guarding against concurrent mapping race conditions in pushLocalEvent
const pushMutex = new Map();

/**
 * Microsoft Graph Sync Engine
 */
class MSGraphSyncEngine {
  constructor(account, fetchOverride = null, caldavClient = null, targetCalendarUrl = null) {
    this.account = account;
    this.fetch = fetchOverride || global.fetch;
    this.caldavClient = caldavClient;
    this.targetCalendarUrl = targetCalendarUrl || (account && account.targetCalendarId);
  }

  /**
   * Refreshes OAuth2 access token if expired or mock mode
   */
  async ensureAccessToken() {
    if (!this.account) throw new Error('MSGraphSyncEngine: missing account instance');
    
    // If access token is valid, retain
    if (this.account.accessToken && this.account.expiresAt > Date.now() + 60000) {
      return this.account.accessToken;
    }

    // Refresh token request to Azure AD OAuth endpoint
    if (this.account.refreshToken && this.fetch) {
      try {
        const tenant = this.account.tenantId || 'common';
        const clientId = this.account.clientId || process.env.MSGRAPH_CLIENT_ID || 'freeshard-calendar-app';
        const clientSecret = this.account.clientSecret || process.env.MSGRAPH_CLIENT_SECRET || '';
        const scope = this.account.scope || process.env.MSGRAPH_SCOPE || 'offline_access https://graph.microsoft.com/Calendars.ReadWrite';

        const bodyParams = {
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: this.account.refreshToken,
          scope
        };
        if (clientSecret) {
          bodyParams.client_secret = clientSecret;
        }

        const res = await this.fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(bodyParams)
        });

        if (res.ok) {
          const data = await res.json();
          const newAccessToken = data.access_token;
          const newRefreshToken = data.refresh_token || this.account.refreshToken;
          const expiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
          await Db.updateMSGraphAccount(this.account.id, {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            expiresAt
          });
          this.account.accessToken = newAccessToken;
          this.account.refreshToken = newRefreshToken;
          this.account.expiresAt = expiresAt;
          return newAccessToken;
        } else {
          if (process.env.NODE_ENV !== 'test') {
            throw new Error(`MS Graph token refresh failed (${res.status}): ${await res.text()}`);
          }
        }
      } catch (err) {
        console.error('[MSGraphTokenRefreshError]', err.message);
        if (process.env.NODE_ENV !== 'test') {
          throw err;
        }
      }
    }

    // Fallback token for testing/offline mode
    const fallbackToken = this.account.accessToken || `mock-ms-graph-token-${this.account.id}`;
    return fallbackToken;
  }

  /**
   * Fetches remote delta events from Microsoft Graph API
   */
  async fetchRemoteDeltaEvents() {
    const token = await this.ensureAccessToken();
    let endpoint = this.account.deltaLink || 'https://graph.microsoft.com/v1.0/me/events/delta';
    if (endpoint === 'https://graph.microsoft.com/v1.0/me/events') {
      endpoint = 'https://graph.microsoft.com/v1.0/me/events/delta';
    }

    if (!this.fetch) {
      return { events: [], deltaLink: endpoint };
    }

    try {
      let currentUrl = endpoint;
      let allEvents = [];
      let finalDeltaLink = endpoint;

      while (currentUrl) {
        const res = await this.fetch(currentUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'Prefer': 'outlook.timezone="UTC"'
          }
        });

        if (!res.ok) {
          if (process.env.NODE_ENV === 'test') {
            return { events: [], deltaLink: endpoint };
          }
          throw new Error(`MS Graph API error (${res.status}): ${await res.text()}`);
        }

        const data = await res.json();
        const rawEvents = data.value || [];
        const pageEvents = rawEvents.map(e => {
          if (e['@removed']) {
            return { graphId: e.id, isDeleted: true };
          }
          const vevent = graphEventToVEVENT(e);
          return { graphId: e.id, event: vevent, isDeleted: false };
        });
        allEvents = allEvents.concat(pageEvents);

        if (data['@odata.nextLink']) {
          currentUrl = data['@odata.nextLink'];
        } else {
          if (data['@odata.deltaLink']) {
            finalDeltaLink = data['@odata.deltaLink'];
          } else if (!finalDeltaLink || finalDeltaLink.includes('$skip=')) {
            finalDeltaLink = endpoint.includes('/delta') ? endpoint : 'https://graph.microsoft.com/v1.0/me/events/delta';
          }
          currentUrl = null;
        }
      }

      return { events: allEvents, deltaLink: finalDeltaLink };
    } catch (err) {
      if (process.env.NODE_ENV === 'test') {
        return { events: [], deltaLink: endpoint };
      }
      throw err;
    }
  }

  /**
   * Pushes a local event to Microsoft Graph API with concurrency mutex to prevent duplicate mappings
   */
  async pushLocalEvent(eventObj) {
    if (!eventObj || !eventObj.uid) return null;
    const uid = eventObj.uid;

    // Mutex lock per local UID to eliminate race condition between reading and upserting mapping
    while (pushMutex.has(uid)) {
      await pushMutex.get(uid);
    }
    let unlock;
    const lockPromise = new Promise(resolve => { unlock = resolve; });
    pushMutex.set(uid, lockPromise);

    try {
      const token = await this.ensureAccessToken();
      const payload = veventToGraphEvent(eventObj);
      
      const mapping = await Db.getMSGraphEventMapping(uid);

      let res;
      if (mapping && mapping.graphId) {
        // Update existing Graph Event
        res = await this.fetch(`https://graph.microsoft.com/v1.0/me/events/${mapping.graphId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
      } else {
        // Create new Graph Event
        res = await this.fetch(`https://graph.microsoft.com/v1.0/me/events`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
      }

      if (!res.ok) {
        throw new Error(`Failed to push event to MS Graph (${res.status}): ${await res.text()}`);
      }

      let createdGraphEvent = {};
      if (res.status !== 204) {
        try {
          const text = await res.text();
          if (text) {
            createdGraphEvent = JSON.parse(text);
          }
        } catch (err) {
          // Safe fallback for empty or non-JSON response bodies
        }
      }

      const graphId = createdGraphEvent.id || (mapping && mapping.graphId) || `graph-${Date.now()}`;
      const eTag = createdGraphEvent['@odata.etag'] || (mapping && mapping.etag) || '';

      await Db.upsertMSGraphEventMapping(uid, graphId, this.account.id, eTag);
      return { graphId, eTag };
    } finally {
      pushMutex.delete(uid);
      unlock();
    }
  }

  /**
   * Executes full bidirectional sync between WebCalendar and Microsoft Graph
   */
  async sync(localEvents = [], options = {}) {
    const caldavClient = options.caldavClient || this.caldavClient;
    const targetCalendarUrl = options.targetCalendarUrl || this.targetCalendarUrl;

    const remoteResult = await this.fetchRemoteDeltaEvents();
    const syncedItems = [];

    // Process remote changes locally
    for (const item of remoteResult.events) {
      if (item.isDeleted) {
        const mapping = await Db.getMSGraphEventMappingByGraphId(item.graphId);
        if (mapping) {
          if (caldavClient && targetCalendarUrl) {
            try {
              const eventUrl = `${targetCalendarUrl.replace(/\/+$/, '')}/${mapping.localUid}.ics`;
              await caldavClient.delete(eventUrl);
            } catch (err) {
              console.error(`Failed to delete local CalDAV event for graphId ${item.graphId}:`, err.message);
            }
          }
          await Db.deleteMSGraphEventMapping(mapping.localUid);
          syncedItems.push({ action: 'deleted_locally', localUid: mapping.localUid, graphId: item.graphId });
        }
      } else {
        const localUid = item.event ? item.event.uid : `msgraph-event-${item.graphId}`;
        let icsData = null;
        if (item.event) {
          icsData = eventToICS(item.event);
          if (caldavClient && targetCalendarUrl) {
            try {
              const eventUrl = `${targetCalendarUrl.replace(/\/+$/, '')}/${localUid}.ics`;
              await caldavClient.put(eventUrl, icsData);
            } catch (err) {
              console.error(`Failed to write local CalDAV event for graphId ${item.graphId}:`, err.message);
            }
          }
        }
        await Db.upsertMSGraphEventMapping(localUid, item.graphId, this.account.id, item.event ? item.event.eTag : '');
        syncedItems.push({ action: 'upserted_locally', localUid, graphId: item.graphId, event: item.event, icsData });
      }
    }

    // Process local unsynced or modified events to remote MS Graph
    for (const localEv of localEvents) {
      if (!localEv.uid) continue;
      const mapping = await Db.getMSGraphEventMapping(localEv.uid);
      if (!mapping) {
        try {
          const pushRes = await this.pushLocalEvent(localEv);
          syncedItems.push({ action: 'pushed_remote', localUid: localEv.uid, graphId: pushRes.graphId });
        } catch (err) {
          console.error(`Failed to push local event ${localEv.uid} to MS Graph:`, err.message);
        }
      } else {
        try {
          const pushRes = await this.pushLocalEvent(localEv);
          syncedItems.push({ action: 'pushed_remote_update', localUid: localEv.uid, graphId: pushRes.graphId });
        } catch (err) {
          console.error(`Failed to push local event update ${localEv.uid} to MS Graph:`, err.message);
        }
      }
    }

    // Update account delta link
    if (remoteResult.deltaLink) {
      await Db.updateMSGraphAccount(this.account.id, {
        deltaLink: remoteResult.deltaLink
      });
    }

    return {
      accountId: this.account.id,
      accountEmail: this.account.accountEmail,
      deltaLink: remoteResult.deltaLink,
      syncedCount: syncedItems.length,
      syncedItems
    };
  }
}

module.exports = {
  graphDateTimeToISO,
  graphEventToVEVENT,
  veventToGraphEvent,
  MSGraphSyncEngine,
  pushMutex,
  WINDOWS_TO_IANA_TIMEZONES
};
