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

    // Hand the appointment to a new owner. The receiver's own on-call block covers this
    // hour, so free-slot validation must be skipped.
    async reassignAppointment(eventId, userId) {
      return call(`/calendars/events/appointments/${eventId}`, {
        method: 'PUT',
        body: { assignedUserId: userId, ignoreFreeSlotValidation: true },
      });
    },

    async contactName(contactId) {
      const { contact } = await call(`/contacts/${contactId}`, { version: CONTACT_VERSION });
      return [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || contact?.email || 'Unknown contact';
    },
  };
}
