'use strict';

const Db = require('../db');
const { parseICSToEvent, eventToICS } = require('../caldav/parser');

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
    const rawStart = graphEvent.start.dateTime;
    startIso = rawStart.endsWith('Z') ? rawStart : new Date(rawStart + 'Z').toISOString();
  }

  let endIso = new Date(Date.now() + 3600000).toISOString();
  if (graphEvent.end && graphEvent.end.dateTime) {
    const rawEnd = graphEvent.end.dateTime;
    endIso = rawEnd.endsWith('Z') ? rawEnd : new Date(rawEnd + 'Z').toISOString();
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
        const res = await this.fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: this.account.clientId || 'freeshard-calendar-app',
            grant_type: 'refresh_token',
            refresh_token: this.account.refreshToken
          })
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
        }
        throw new Error(`MS Graph token refresh failed (${res.status}): ${await res.text()}`);
      } catch (err) {
        console.error('[MSGraphTokenRefreshError]', err.message);
        throw err;
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
    const endpoint = this.account.deltaLink || 'https://graph.microsoft.com/v1.0/me/events';

    if (!this.fetch) {
      return { events: [], deltaLink: endpoint };
    }

    let currentUrl = endpoint;
    let allEvents = [];
    let finalDeltaLink = endpoint;

    while (currentUrl) {
      const res = await this.fetch(currentUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      });

      if (!res.ok) {
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
        finalDeltaLink = data['@odata.deltaLink'] || currentUrl;
        currentUrl = null;
      }
    }

    return { events: allEvents, deltaLink: finalDeltaLink };
  }

  /**
   * Pushes a local event to Microsoft Graph API
   */
  async pushLocalEvent(eventObj) {
    const token = await this.ensureAccessToken();
    const payload = veventToGraphEvent(eventObj);
    
    const mapping = await Db.getMSGraphEventMapping(eventObj.uid);

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

    // An empty body (204, or a PATCH answered without content) keeps the stored mapping; a body that is
    // not JSON is a protocol error and fails the push (#343).
    let createdGraphEvent = {};
    if (res.status !== 204) {
      const text = await res.text();
      if (text) {
        createdGraphEvent = JSON.parse(text);
      }
    }

    const graphId = createdGraphEvent.id || (mapping && mapping.graphId);
    if (!graphId) {
      throw new Error(`MS Graph answered ${res.status} without an event id; the event mapping cannot be stored`);
    }
    const eTag = createdGraphEvent['@odata.etag'] || (mapping && mapping.etag) || '';

    await Db.upsertMSGraphEventMapping(eventObj.uid, graphId, this.account.id, eTag);
    return { graphId, eTag };
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
    await Db.updateMSGraphAccount(this.account.id, {
      deltaLink: remoteResult.deltaLink
    });

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
  graphEventToVEVENT,
  veventToGraphEvent,
  MSGraphSyncEngine
};
