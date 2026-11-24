// Minimal GoHighLevel API v2 client (Private Integration Token).
const BASE = 'https://services.leadconnectorhq.com';
const CAL_VERSION = '2021-04-15';
const CONTACT_VERSION = '2021-07-28';

export class GhlError extends Error {
  constructor(status, body, path) {
    super(`GHL ${status} on ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 500));
    this.status = status;
    this.body = body;
  }
}

export function ghlClient(cfg, { fetchImpl = fetch, token = process.env[cfg.ghl.tokenEnv] } = {}) {
  if (!token) throw new Error(`Missing env ${cfg.ghl.tokenEnv}`);
  const locationId = cfg.ghl.locationId;
  const calCache = new Map();
  const userCache = new Map();
  let usersList = null;

  async function call(path, { method = 'GET', body, version = CAL_VERSION } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(BASE + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Version: version,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      const text = await res.text();
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = text; }
      if (!res.ok) throw new GhlError(res.status, json, path);
      return json;
    }
  }

  const iso = (ms) => new Date(ms).toISOString();

  return {
    async calendar(calendarId) {
      if (!calCache.has(calendarId)) {
        const { calendar } = await call(`/calendars/${calendarId}`);
        calCache.set(calendarId, calendar);
      }
      return calCache.get(calendarId);
    },

    // Bookable slot start times (ms) for one user on one calendar. Respects working hours,
    // existing appointments and blocked slots, which is exactly "free to take a call".
    async freeSlots(calendarId, userId, startMs, endMs, timeZone) {
      const q = new URLSearchParams({ startDate: String(startMs), endDate: String(endMs), timezone: timeZone, userId });
      const res = await call(`/calendars/${calendarId}/free-slots?${q}`);
      const out = [];
      for (const [k, v] of Object.entries(res)) {
        if (k === 'traceId' || !v?.slots) continue;
        for (const s of v.slots) out.push(Date.parse(s));
      }
      return out.sort((a, b) => a - b);
    },

    // Appointments assigned to a user across all calendars. On-call shifts are appointments too,
    // so they're excluded by default: they aren't calls.
    async userEvents(userId, startMs, endMs, { includeOnCall = false } = {}) {
      const q = new URLSearchParams({ locationId, userId, startTime: String(startMs), endTime: String(endMs) });
      const { events = [] } = await call(`/calendars/events?${q}`);
      return events.filter((e) => !e.deleted && !['cancelled', 'invalid'].includes(e.appointmentStatus)
        && (includeOnCall || e.calendarId !== cfg.ghl.onCall?.calendarId));
    },

    // An on-call shift: an appointment on the dedicated "Hot Swap On-Call" calendar, assigned to
    // the person. Appointments sync to their Google Calendar and make them busy for round robin.
    async createOnCall({ userId, startMs, endMs, title }) {
      const { calendarId, contactId } = cfg.ghl.onCall || {};
      if (!calendarId || !contactId) throw new Error(`Config ${cfg.client}: ghl.onCall.calendarId/contactId required`);
      const res = await call('/calendars/events/appointments', {
        method: 'POST',
        body: {
          calendarId, locationId, contactId, assignedUserId: userId, title,
          startTime: iso(startMs), endTime: iso(endMs),
          appointmentStatus: 'confirmed', ignoreFreeSlotValidation: true, toNotify: false,
        },
      });
      return res.id || res.appointment?.id;
    },

    // Active calendars in a calendar group (e.g. each closer's personal calendar).
    async calendarsInGroup(groupId) {
      const q = new URLSearchParams({ locationId, groupId });
      const { calendars = [] } = await call(`/calendars/?${q}`);
      return calendars.filter((c) => c.groupId === groupId && c.isActive !== false);
    },

    async userByEmail(email) {
      if (!email) return null;
      if (!usersList) usersList = call(`/users/?${new URLSearchParams({ locationId })}`, { version: CONTACT_VERSION }).then((r) => r.users || []);
      return (await usersList).find((u) => (u.email || '').toLowerCase() === email.toLowerCase() && !u.deleted) || null;
    },

    async user(userId) {
      if (!userCache.has(userId)) userCache.set(userId, call(`/users/${userId}`, { version: CONTACT_VERSION }).catch(() => null));
      return userCache.get(userId);
    },

    // Make a calendar's team exactly `userIds`. Keeps existing members' settings.
    async setCalendarTeam(calendarId, userIds) {
      const { calendar } = await call(`/calendars/${calendarId}`);
      const current = calendar.teamMembers || [];
      const want = new Set(userIds);
      const same = current.length === want.size && current.every((m) => want.has(m.userId));
      if (same) return { changed: false };
      const kept = current.filter((m) => want.has(m.userId)).map((m) => ({ userId: m.userId, priority: m.priority ?? 0.5 }));
      const added = [...want].filter((id) => !current.some((m) => m.userId === id)).map((id) => ({ userId: id, priority: 0.5 }));
      await call(`/calendars/${calendarId}`, { method: 'PUT', body: { teamMembers: [...kept, ...added] } });
      calCache.delete(calendarId);
      return { changed: true, added: added.map((m) => m.userId), removed: current.filter((m) => !want.has(m.userId)).map((m) => m.userId) };
    },

    async blockedSlots(userId, startMs, endMs) {
      const q = new URLSearchParams({ locationId, userId, startTime: String(startMs), endTime: String(endMs) });
      const { events = [] } = await call(`/calendars/blocked-slots?${q}`);
      return events.filter((e) => !e.deleted);
    },


    async deleteEvent(eventId) {
      return call(`/calendars/events/${eventId}`, { method: 'DELETE' });
    },

    async getAppointment(eventId) {
      const res = await call(`/calendars/events/appointments/${eventId}`);
      return res.appointment || res.event || res;
    },

    async setAppointmentTitle(eventId, title) {
      return call(`/calendars/events/appointments/${eventId}`, { method: 'PUT', body: { title, ignoreFreeSlotValidation: true } });
    },

    // null when the event no longer exists.
    async findEvent(eventId) {
      try { return await this.getAppointment(eventId); } catch (e) {
        if (e.status === 404 || e.status === 400) return null;
        throw e;
      }
    },

    // Open deals for a contact, newest first, optionally limited to some pipelines.
    async openOpportunities(contactId, pipelineIds = []) {
      const q = new URLSearchParams({ location_id: locationId, contact_id: contactId, status: 'open', limit: '20' });
      const { opportunities = [] } = await call(`/opportunities/search?${q}`, { version: CONTACT_VERSION });
      return opportunities
        .filter((o) => !pipelineIds.length || pipelineIds.includes(o.pipelineId))
        .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    },

    async setOpportunityOwner(opportunityId, userId) {
      return call(`/opportunities/${opportunityId}`, { method: 'PUT', version: CONTACT_VERSION, body: { assignedTo: userId } });
    },

    async setContactOwner(contactId, userId) {
      return call(`/contacts/${contactId}`, { method: 'PUT', version: CONTACT_VERSION, body: { assignedTo: userId } });
    },

    async addNote(contactId, body, userId) {
      return call(`/contacts/${contactId}/notes`, { method: 'POST', version: CONTACT_VERSION, body: { body, ...(userId ? { userId } : {}) } });
    },


    async contactName(contactId) {
      const { contact } = await call(`/contacts/${contactId}`, { version: CONTACT_VERSION });
      return [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || contact?.email || 'Unknown contact';
    },
  };
}
