// Orchestration: GHL + Slack + DB. Each exported function is one user-visible action.
import { coverageHours, headcountFor, dayCoverage } from './config.js';
import { slotsToIntervals, freeHours } from './availability.js';
import { planRoster } from './roster.js';
import { HOUR, dateKey, nextDateKey, hourStart, hourLabel, formatDay, formatTime, weekdayOf } from './time.js';
import { mention } from './slack.js';
import * as store from './db.js';

// ---------- people ----------

// The pool, straight from GHL: every active calendar in the closers' calendar group is one
// closer (its owner), using that calendar for availability. Adding a closer's calendar to the
// group during onboarding is all it takes. `include` adds setters/others; `exclude` removes.
export async function poolFromGhl(cfg, ghl, overrides = []) {
  const pool = cfg.pool;
  const byId = new Map();
  if (pool.closerCalendarGroupId) {
    for (const cal of await ghl.calendarsInGroup(pool.closerCalendarGroupId)) {
      const owner = (cal.teamMembers || [])[0]?.userId;
      if (!owner || (cal.teamMembers || []).length !== 1 || byId.has(owner)) continue;
      const u = await ghl.user(owner);
      if (!u || u.deleted) continue;
      byId.set(owner, { name: u.name || [u.firstName, u.lastName].filter(Boolean).join(' '), firstName: u.firstName, ghlUserId: owner, email: (u.email || '').toLowerCase(), role: 'closer', availabilityCalendarId: cal.id });
    }
  }
  for (const p of pool.include || []) byId.set(p.ghlUserId, { role: 'setter', ...p });
  for (const id of pool.exclude || []) byId.delete(id);
  // Slack-made changes (/hotswap add|remove) win over the group and config.
  for (const o of overrides) {
    if (o.action === 'remove') byId.delete(o.ghl_user_id);
    else if (o.action === 'add' && !byId.has(o.ghl_user_id)) {
      byId.set(o.ghl_user_id, { name: o.name, ghlUserId: o.ghl_user_id, email: o.email, role: 'added', slackUserId: o.slack_user_id, availabilityCalendarId: null });
    }
  }
  return [...byId.values()].map((p) => ({ ...p, id: p.ghlUserId }));
}

export async function resolvePeople(cfg, slack, ghl) {
  const slackIds = cfg.pool.slackUserIds || {};
  const overrides = await store.poolOverrides(cfg.client).catch((e) => { console.error('pool overrides', e.message); return []; });
  const people = await Promise.all((await poolFromGhl(cfg, ghl, overrides)).map(async (p) => ({
    ...p,
    slackUserId: slackIds[p.ghlUserId] || p.slackUserId || (await slack.userIdByEmail(p.email)),
  })));
  const m = cfg.slack.manager || {};
  const manager = { ...m, slackUserId: m.slackUserId || (await slack.userIdByEmail(m.email)) };
  return { people, manager, byId: new Map(people.map((p) => [p.id, p])) };
}

export async function personForSlackUser(team, slack, slackUserId) {
  const direct = team.people.find((p) => p.slackUserId === slackUserId);
  if (direct) return direct;
  const email = await slack.emailByUserId(slackUserId).catch(() => null);
  return team.people.find((p) => p.email && p.email.toLowerCase() === email) || null;
}

const isManager = (team, slackUserId) => team.manager.slackUserId && team.manager.slackUserId === slackUserId;

// ---------- availability ----------

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// For each person: which local hours (of `hours`) they are fully free, plus their call load that day.
export async function availability(cfg, ghl, people, day, hours) {
  const tz = cfg.timezone;
  const dayStart = hourStart(day, 0, tz);
  const dayEnd = hourStart(day, 23, tz) + HOUR;
  const windowStart = hourStart(day, Math.min(...hours), tz);
  const windowEnd = hourStart(day, Math.max(...hours), tz) + HOUR;
  const starts = new Map(hours.map((h) => [hourStart(day, h, tz), h]));

  return mapLimit(people, 4, async (p) => {
    try {
      if (!p.availabilityCalendarId) {
        // Added from Slack with no personal calendar: treat as available all coverage hours
        // except where they already have an appointment.
        const events = await ghl.userEvents(p.ghlUserId, dayStart, dayEnd);
        const busy = (ms) => events.some((e) => Date.parse(e.startTime) < ms + HOUR && Date.parse(e.endTime) > ms);
        const free = new Set([...starts].filter(([ms]) => !busy(ms) && ms + HOUR > Date.now()).map(([, h]) => h));
        return { ...p, free, load: events.length };
      }
      const cal = await ghl.calendar(p.availabilityCalendarId);
      const slots = await ghl.freeSlots(p.availabilityCalendarId, p.ghlUserId, windowStart, windowEnd, tz);
      const intervals = slotsToIntervals(slots, cal.slotDuration || 60, cal.slotInterval || cal.slotDuration || 60);
      const free = new Set(freeHours(intervals, [...starts.keys()], cfg.coverage.minFreeMinutes ?? 45,
        { now: Date.now(), stepMinutes: cal.slotInterval || cal.slotDuration || 30 }).map((ms) => starts.get(ms)));
      const load = (await ghl.userEvents(p.ghlUserId, dayStart, dayEnd)).length;
      return { ...p, free, load };
    } catch (e) {
      console.error(`availability failed for ${p.name}:`, e.message);
      return { ...p, free: new Set(), load: 0, error: e.message };
    }
  });
}

// Hours still worth covering: configured window, skip the day if not a coverage day,
// skip hours that have already ended.
export async function loadRules(cfg) {
  return store.coverageRules(cfg.client).catch((e) => {
    if (!/DATABASE_URL/.test(e.message)) console.error('coverage rules', e.message);
    return [];
  });
}

// All coverage hours for the day after applying /hotswap dates rules.
export async function hoursForDay(cfg, day, rules) {
  return dayCoverage(cfg, day, rules ?? await loadRules(cfg), weekdayOf(day)).hours;
}

// Coverage hours that haven't ended yet.
export async function hoursToCover(cfg, day, now = Date.now(), rules) {
  return (await hoursForDay(cfg, day, rules)).filter((h) => hourStart(day, h, cfg.timezone) + HOUR > now);
}

// ---------- roster ----------

// Plan (and optionally apply) the roster for `day`.
// apply=false: preview only (evening gap check). apply=true: create GHL blocks + DB rows.
export async function buildRoster(cfg, { ghl, team, day, apply, now = Date.now() }) {
  const hours = await hoursToCover(cfg, day, now);
  if (!hours.length) return { day, hours, assignments: new Map(), gaps: [], errors: [] };

  const repairErrors = apply ? await repairSlots(cfg, ghl, team, day) : [];
  const existing = apply ? await store.activeSlots(cfg.client, day) : [];
  const locked = new Map();
  for (const s of existing) locked.set(s.hour, [...(locked.get(s.hour) || []), s.ghl_user_id]);

  const avail = await availability(cfg, ghl, team.people, day, hours);
  const plan = planRoster({
    hours,
    people: avail,
    headcount: (h) => headcountFor(cfg, h),
    maxConsecutive: cfg.coverage.maxConsecutiveHours ?? 3,
    locked,
  });

  const errors = [...repairErrors, ...avail.filter((p) => p.error).map((p) => `${p.name}: ${p.error}`)];
  if (apply) {
    for (const [hour, ids] of plan.assignments) {
      for (const id of ids) {
        if ((locked.get(hour) || []).includes(id)) continue;
        try {
          await assignHour(cfg, ghl, { day, hour, ghlUserId: id, source: 'auto', team });
        } catch (e) {
          errors.push(`${team.byId.get(id)?.name} ${hourLabel(hour)}: ${e.message}`);
        }
      }
    }
  }
  return { day, hours, ...plan, errors };
}

// "(Tyler) Hot Swap On-Call". First name, skipping a leading initial ("J Tyler Ray" -> "Tyler").
export function shortName(p) {
  const words = String(p?.firstName || p?.name || '').trim().split(/\s+/).filter(Boolean);
  const first = words.find((w) => w.replace(/\./g, '').length > 1) || words[0] || '';
  return first;
}

function onCallTitle(cfg, team, ghlUserId) {
  const who = shortName(team.byId.get(ghlUserId));
  return who ? `(${who}) ${cfg.blockTitle}` : cfg.blockTitle;
}

// Make sure every assigned hour really has an on-call appointment in GHL:
// - no event id, or a leftover blocked slot from before appointments  -> replace with an appointment
// - the appointment was deleted/cancelled in GHL                      -> free the hour (planner refills it)
async function repairSlots(cfg, ghl, team, day) {
  const errors = [];
  const onCal = cfg.ghl.onCall.calendarId;
  for (const slot of await store.activeSlots(cfg.client, day)) {
    if (hourStart(day, slot.hour, cfg.timezone) + HOUR <= Date.now()) continue;
    const name = team.byId.get(slot.ghl_user_id)?.name || slot.ghl_user_id;
    try {
      const ev = slot.block_event_id ? await ghl.findEvent(slot.block_event_id) : null;
      const isOnCall = ev && ev.calendarId === onCal;
      const gone = !ev || ev.deleted || ['cancelled', 'invalid'].includes(ev.appointmentStatus);
      if (isOnCall && !gone) {
        const want = onCallTitle(cfg, team, slot.ghl_user_id);
        if (ev.title !== want) await ghl.setAppointmentTitle(slot.block_event_id, want);
        continue;
      }
      if (isOnCall && gone) { await store.releaseSlot(slot.id); continue; }
      // Legacy block (or missing id): convert to an on-call appointment.
      if (slot.block_event_id) await ghl.deleteEvent(slot.block_event_id).catch(() => {}); // remove leftover block
      if (!team.byId.has(slot.ghl_user_id)) { await store.releaseSlot(slot.id); continue; }
      const [start, end] = onCallWindow(cfg, day, slot.hour);
      const id = await ghl.createOnCall({ userId: slot.ghl_user_id, startMs: start, endMs: end, title: onCallTitle(cfg, team, slot.ghl_user_id) });
      await store.setSlotEvent(slot.id, id);
    } catch (e) {
      errors.push(`${name} ${hourLabel(slot.hour)}: ${e.message}`);
    }
  }
  return errors;
}

// The on-call appointment for an hour. For the hour already under way it starts now
// (rounded down to 5 min) so nothing is booked in the past.
function onCallWindow(cfg, day, hour, now = Date.now()) {
  const start = hourStart(day, hour, cfg.timezone);
  const end = start + HOUR;
  const from = now > start ? Math.floor(now / 300_000) * 300_000 : start;
  return [Math.min(from, end - 300_000), end];
}

async function assignHour(cfg, ghl, { day, hour, ghlUserId, source, team }) {
  const [start, end] = onCallWindow(cfg, day, hour);
  const title = team ? onCallTitle(cfg, team, ghlUserId) : cfg.blockTitle;
  const eventId = await ghl.createOnCall({ userId: ghlUserId, startMs: start, endMs: end, title });
  const row = await store.insertSlot({ client: cfg.client, day, hour, ghlUserId, blockEventId: eventId, source });
  if (!row && eventId) await ghl.deleteEvent(eventId).catch(() => {}); // already assigned: undo the duplicate
  return row;
}

async function currentRoster(cfg, day) {
  const rows = await store.activeSlots(cfg.client, day);
  const byHour = new Map();
  for (const r of rows) byHour.set(r.hour, [...(byHour.get(r.hour) || []), r]);
  return byHour;
}

// Tomorrow's plan shows plain names (no notifications); today's roster tags people. That way each
// on-call person gets one tag per day, in the morning, and the shift is already on their calendar.
export function renderRoster(cfg, team, day, byHour, { phase = 'confirm', now = Date.now(), hours = [] } = {}) {
  const name = (id) => team.byId.get(id);
  const tag = (id) => (phase === 'plan' ? `*${name(id)?.name || id}*` : mention(name(id)?.slackUserId, name(id)?.name || id));
  const lines = hours.map((h) => {
    const ids = (byHour.get(h) || []).map((r) => r.ghl_user_id ?? r);
    const want = headcountFor(cfg, h);
    const who = ids.map(tag).join(', ');
    if (hourStart(day, h, cfg.timezone) + HOUR <= now) return `~${hourLabel(h)}: ${ids.map((id) => name(id)?.name || id).join(', ') || '-'}~`;
    if (!ids.length) return `⚠️ *${hourLabel(h)}*: *NOT COVERED*. Tap *Cover an hour* to take it.`;
    if (ids.length < want) return `*${hourLabel(h)}*: ${who}  ⚠️ short ${want - ids.length}`;
    return `*${hourLabel(h)}*: ${who}`;
  });
  const text = `${phase === 'plan' ? "Tomorrow's hot-swap plan" : "Today's hot-swap roster"}: ${formatDay(day)} (ET)`;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || '_No hot-swap coverage scheduled for this day._' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Times are ET. Your on-call hours are on your GHL and Google calendar, so round robin won\'t book you then. If a transfer comes in during your hour, claim it.' }] },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Request a hot swap' }, style: 'primary', action_id: 'request_open', value: day },
        { type: 'button', text: { type: 'plain_text', text: "Can't make my hour" }, action_id: 'release_open', value: day },
        { type: 'button', text: { type: 'plain_text', text: 'Cover an hour' }, action_id: 'volunteer_open', value: day },
      ],
    },
  ];
  return { text, blocks };
}

// Night before (phase 'plan') and morning (phase 'confirm'):
// build/extend the roster, block hours in GHL, post a fresh roster message, DM the manager gaps.
// Re-running keeps existing assignments and only fills holes, so the morning run picks up
// anyone who became free overnight.
// fresh=true (scheduled runs): always post a new message. fresh=false (manual re-run):
// edit today's existing message in place if there is one.
export async function publishRoster(cfg, { ghl, slack, team, day, phase, fresh = true }) {
  const sync = await ghl.setCalendarTeam(cfg.ghl.onCall.calendarId, team.people.map((p) => p.ghlUserId))
    .catch((e) => ({ error: e.message }));
  const result = await buildRoster(cfg, { ghl, team, day, apply: true });
  if (sync.error) result.errors.push(`Couldn't update the Hot Swap On-Call calendar team: ${sync.error}`);
  if (sync.added?.length || sync.removed?.length) {
    const nm = (id) => team.byId.get(id)?.name || id;
    result.notes = [
      ...(sync.added?.length ? [`Added to the pool: ${sync.added.map(nm).join(', ')}`] : []),
      ...(sync.removed?.length ? [`Removed from the Hot Swap On-Call calendar: ${sync.removed.length} user(s) no longer in the pool`] : []),
    ];
  }
  const byHour = await currentRoster(cfg, day);
  const msg = renderRoster(cfg, team, day, byHour, { phase, hours: await hoursForDay(cfg, day) });
  await clearCoverMessages(cfg, slack, day).catch((e) => result.errors.push(`Cleaning up cover messages: ${e.message}`));
  const prev = fresh ? null : await store.getRosterPost(cfg.client, day);
  if (prev) {
    await slack.update(prev.channel, prev.ts, msg.text, msg.blocks);
  } else {
    const { ts } = await slack.post(cfg.slack.channelId, msg.text, msg.blocks);
    await store.saveRosterPost(cfg.client, day, cfg.slack.channelId, ts);
  }

  // Open hours go to the whole pool first; the manager only hears about what's left later.
  await refreshGapBoard(cfg, { slack, team }, day, { post: true }).catch((e) => result.errors.push(`Gap board: ${e.message}`));
  if (phase === 'confirm') await escalateGaps(cfg, { slack, team }, day);

  if (team.manager.slackUserId && (result.notes?.length || result.errors.length)) {
    const parts = [`Hot-swap roster for ${formatDay(day)}:`];
    if (result.notes?.length) parts.push(result.notes.join('\n'));
    if (result.errors.length) parts.push(`Problems:\n• ${result.errors.join('\n• ')}`);
    await slack.dm(team.manager.slackUserId, parts.join('\n\n'));
  }
  return result;
}

async function refreshRosterMessage(cfg, { slack, team, day }) {
  const post = await store.getRosterPost(cfg.client, day);
  if (!post) return;
  const byHour = await currentRoster(cfg, day);
  const today = dateKey(Date.now(), cfg.timezone);
  const msg = renderRoster(cfg, team, day, byHour, { phase: day > today ? 'plan' : 'confirm', hours: await hoursForDay(cfg, day) });
  await slack.update(post.channel, post.ts, msg.text, msg.blocks);
}

async function rosterThread(cfg, slack, day, text, blocks) {
  const post = await store.getRosterPost(cfg.client, day);
  if (post) return slack.post(post.channel, text, blocks, { thread_ts: post.ts, reply_broadcast: !!blocks });
  return slack.post(cfg.slack.channelId, text, blocks);
}

// Person can't make one of their hours: free it, mark the hour NOT COVERED, and post a
// "cover it" button in the roster thread tagging whoever is free. First click takes it.
export async function releaseHour(cfg, { ghl, slack, team, day, slotId, slackUserId }) {
  const slots = await store.activeSlots(cfg.client, day);
  const slot = slots.find((s) => String(s.id) === String(slotId));
  if (!slot) return { ok: false, message: 'That hour is no longer assigned to you.' };
  const me = team.byId.get(slot.ghl_user_id);
  if (me?.slackUserId !== slackUserId && !isManager(team, slackUserId)) return { ok: false, message: 'You can only release your own hours.' };
  if (hourStart(day, slot.hour, cfg.timezone) + HOUR <= Date.now()) return { ok: false, message: 'That hour is already over.' };

  if (slot.block_event_id) await ghl.deleteEvent(slot.block_event_id).catch((e) => console.error('unblock failed', e.message));
  await store.releaseSlot(slot.id);
  await refreshRosterMessage(cfg, { slack, team, day });

  const stillCovered = slots.filter((s) => s.hour === slot.hour && s.id !== slot.id).map((s) => s.ghl_user_id);
  const candidates = team.people.filter((p) => p.id !== slot.ghl_user_id && !stillCovered.includes(p.id));
  const free = (await availability(cfg, ghl, candidates, day, [slot.hour])).filter((p) => p.free.has(slot.hour));

  const who = free.length
    ? `Free then: ${free.map((p) => mention(p.slackUserId, p.name)).join(' ')}`
    : `Nobody is free then. ${mention(team.manager.slackUserId, team.manager.name)}, this hour needs cover.`;
  const msg = coverRequestMessage(day, slot.hour, `${mention(me?.slackUserId, me?.name)} can't make *${hourLabel(slot.hour)}*. It's *NOT COVERED*.\n${who}`);
  const posted = await rosterThread(cfg, slack, day, msg.text, msg.blocks);
  if (posted?.ts) await store.addCoverMessage({ client: cfg.client, day, hour: slot.hour, channel: posted.channel, ts: posted.ts });
  return { ok: true, message: `Released ${hourLabel(slot.hour)}. It's marked not covered and the free people were tagged.` };
}

function coverRequestMessage(day, hour, text) {
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: `I'll cover ${hourLabel(hour)}` }, style: 'primary', action_id: 'cover_hour', value: `${day}|${hour}` },
      ] },
    ],
  };
}

// Someone takes an open hour, up to that hour's headcount.
// The hour already under way can always be taken unless the person has a call during the rest of it.
export async function volunteerHour(cfg, { ghl, slack, team, day, hour, slackUserId }) {
  const me = await personForSlackUser(team, slack, slackUserId);
  if (!me) return { ok: false, message: "You're not in the hot-swap pool. Ask your manager to add you." };
  const hStart = hourStart(day, hour, cfg.timezone);
  const hEnd = hStart + HOUR;
  const now = Date.now();
  if (hEnd <= now) return { ok: false, message: `${hourLabel(hour)} is already over.` };

  const coveringNow = () => currentRoster(cfg, day).then((m) => m.get(hour) || []);
  const before = await coveringNow();
  if (before.some((r) => r.ghl_user_id === me.id)) return { ok: false, message: `You're already on call at ${hourLabel(hour)}.` };
  if (before.length >= headcountFor(cfg, hour)) {
    const who = before.map((r) => team.byId.get(r.ghl_user_id)?.name).filter(Boolean).join(', ');
    return { ok: false, message: `${hourLabel(hour)} is already covered${who ? ` by ${who}` : ''}.` };
  }

  if (now > hStart) {
    const calls = await ghl.userEvents(me.ghlUserId, now, hEnd);
    const clash = calls.find((e) => Date.parse(e.startTime) < hEnd && Date.parse(e.endTime) > now);
    if (clash) return { ok: false, message: `You have a call at ${formatTime(Date.parse(clash.startTime), cfg.timezone)} ET during the rest of ${hourLabel(hour)}.` };
  } else {
    const [a] = await availability(cfg, ghl, [me], day, [hour]);
    if (!a.free.has(hour)) return { ok: false, message: `Your GHL calendar isn't free for ${hourLabel(hour)}.` };
  }

  const row = await assignHour(cfg, ghl, { day, hour, ghlUserId: me.id, source: 'volunteer', team });
  if (!row) return { ok: false, message: `You're already on call at ${hourLabel(hour)}.` };
  // Two people clicking at once: keep the first ones up to headcount, undo the rest.
  const after = (await coveringNow()).sort((a, b) => Number(a.id) - Number(b.id));
  if (after.findIndex((r) => r.id === row.id) >= headcountFor(cfg, hour)) {
    if (row.block_event_id) await ghl.deleteEvent(row.block_event_id).catch(() => {});
    await store.releaseSlot(row.id);
    return { ok: false, message: `Someone else just took ${hourLabel(hour)}.` };
  }

  await refreshRosterMessage(cfg, { slack, team, day });
  await clearCoverMessages(cfg, slack, day);
  await refreshGapBoard(cfg, { slack, team }, day);
  return { ok: true, message: `You're on call at ${hourLabel(hour)}. It's on your GHL and Google calendar.` };
}

// Delete "needs cover" messages for hours that are now fully covered or already over,
// so the channel only shows hours that still need someone.
export async function clearCoverMessages(cfg, slack, day) {
  const byHour = await currentRoster(cfg, day);
  const hours = await hoursForDay(cfg, day);
  for (const m of await store.coverMessages(cfg.client, day)) {
    const full = (byHour.get(m.hour) || []).length >= headcountFor(cfg, m.hour);
    const over = hourStart(day, m.hour, cfg.timezone) + HOUR <= Date.now();
    const dropped = !hours.includes(m.hour);
    if (!full && !over && !dropped) continue;
    await slack.remove(m.channel, m.ts).catch((e) => { if (e.slackError !== 'message_not_found') throw e; });
    await store.removeCoverMessage(m.channel, m.ts);
  }
}

// Hourly housekeeping: today's covered/finished requests plus anything left from earlier days.
export async function sweepCoverMessages(cfg, slack, now = Date.now(), team) {
  const today = dateKey(now, cfg.timezone);
  await clearCoverMessages(cfg, slack, today);
  if (team) await refreshGapBoard(cfg, { slack, team }, today);
  for (const m of await store.staleCoverMessages(cfg.client, today)) {
    await slack.remove(m.channel, m.ts).catch(() => {});
    await store.removeCoverMessage(m.channel, m.ts);
  }
}

export async function openHoursFor(cfg, day) {
  const byHour = await currentRoster(cfg, day);
  return (await hoursToCover(cfg, day)).filter((h) => (byHour.get(h) || []).length < headcountFor(cfg, h));
}

// Remaining hours that still need people (including the one under way).
export async function coverableHours(cfg, day) {
  const byHour = await currentRoster(cfg, day);
  return (await hoursToCover(cfg, day))
    .map((h) => ({ hour: h, count: (byHour.get(h) || []).length, need: headcountFor(cfg, h) - (byHour.get(h) || []).length }))
    .filter((h) => h.need > 0);
}

export async function myFutureSlots(cfg, team, day, slackUserId) {
  const rows = await store.activeSlots(cfg.client, day);
  return rows.filter((r) => {
    const p = team.byId.get(r.ghl_user_id);
    return (p?.slackUserId === slackUserId || isManager(team, slackUserId))
      && hourStart(day, r.hour, cfg.timezone) + HOUR > Date.now();
  });
}

// ---------- gap board ----------

// One message per day listing hours that still need people, with an "I'll cover" button per hour.
// It tags the pool once, when first posted; after that it's only edited (edits don't notify),
// so the pool gets at most one tag per day, and only on days with gaps.
// Deleted when nothing is open.
export async function refreshGapBoard(cfg, { slack, team }, day, { post = false } = {}) {
  const open = await coverableHours(cfg, day);
  const board = await store.getGapBoard(cfg.client, day);
  if (!open.length) {
    if (board) {
      await slack.remove(board.channel, board.ts).catch((e) => { if (e.slackError !== 'message_not_found') throw e; });
      await store.deleteGapBoard(cfg.client, day);
    }
    return;
  }
  const today = dateKey(Date.now(), cfg.timezone);
  const when = day === today ? `Today (${formatDay(day)})` : day === nextDateKey(today) ? `Tomorrow (${formatDay(day)})` : formatDay(day);
  const tags = team.people.filter((p) => p.slackUserId).map((p) => `<@${p.slackUserId}>`).join(' ');
  const list = open.map((h) => `${hourLabel(h.hour)} ET${h.need > 1 ? ` (needs ${h.need})` : ''}`).join(', ');
  const text = `⚠️ *${when} still needs hot-swap cover:* ${list}\nCan you take one? ${tags}`;
  const buttons = open.slice(0, 25).map((h) => ({
    type: 'button', text: { type: 'plain_text', text: `I'll cover ${hourLabel(h.hour)}` }, action_id: `cover_hour_${h.hour}`, value: `${day}|${h.hour}`,
  }));
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  for (let i = 0; i < buttons.length; i += 5) blocks.push({ type: 'actions', elements: buttons.slice(i, i + 5) });
  if (board) {
    await slack.update(board.channel, board.ts, text, blocks);
  } else if (post) {
    const posted = await slack.post(cfg.slack.channelId, text, blocks);
    await store.saveGapBoard(cfg.client, day, posted.channel, posted.ts);
  }
}

// Tell the manager about hours nobody has taken, once per hour: an hour already reported
// is never repeated. Silent when everything is covered.
export async function escalateGaps(cfg, { slack, team }, day) {
  if (!team.manager.slackUserId) return;
  const already = await store.alertedHours(cfg.client, day);
  const open = (await coverableHours(cfg, day)).filter((h) => !already.has(h.hour));
  if (!open.length) return;
  const today = dateKey(Date.now(), cfg.timezone);
  const when = day === today ? 'today' : 'tomorrow';
  const list = open.map((h) => `• ${hourLabel(h.hour)} ET${h.need > 1 ? ` (needs ${h.need})` : ''}`).join('\n');
  await slack.dm(team.manager.slackUserId,
    `Nobody has picked up these hot-swap hours for ${when} (${formatDay(day)}):\n${list}\nThe pool was already tagged. You may need to line someone up.`);
  await store.markAlerted(cfg.client, day, open.map((h) => h.hour));
}

// ---------- test reset ----------

export const isTestClient = (cfg) => /-test$/.test(cfg.client);

// Wipe test activity: on-call appointments, every appointment on the test pool's own calendars
// (+/- 14 days), the app's Slack messages and pending alerts, and logged activity.
// Refuses to run for anything but a "-test" client.
export async function resetTestData(cfg, { ghl, slack, team }, now = Date.now()) {
  if (!isTestClient(cfg)) throw new Error(`Refusing to reset "${cfg.client}": reset only runs on a -test client.`);
  const from = now - 14 * 24 * HOUR;
  const to = now + 14 * 24 * HOUR;
  const poolIds = new Set(team.people.map((p) => p.ghlUserId));
  const testCalendars = (cfg.pool.include || []).map((p) => p.availabilityCalendarId).filter(Boolean);
  const errors = [];
  const del = async (id) => { try { await ghl.deleteEvent(id); return 1; } catch (e) { if (e.status !== 404) errors.push(e.message.slice(0, 80)); return 0; } };

  let appts = 0;
  const ids = new Set(await store.slotEventIds(cfg.client));
  for (const e of await ghl.calendarEvents(cfg.ghl.onCall.calendarId, from, to)) if (poolIds.has(e.assignedUserId)) ids.add(e.id);
  for (const cal of testCalendars) for (const e of await ghl.calendarEvents(cal, from, to)) ids.add(e.id);
  for (const id of ids) appts += await del(id);

  let msgs = 0;
  try {
    for (const m of await slack.scheduledIn(cfg.slack.channelId)) {
      await slack.unschedule(cfg.slack.channelId, m.id).then(() => msgs++).catch(() => {});
    }
  } catch (e) { errors.push(`scheduled messages: ${e.message}`); }
  for (const m of await store.trackedMessages(cfg.client)) {
    await slack.remove(m.channel, m.ts).then(() => msgs++).catch((e) => { if (e.slackError !== 'message_not_found') errors.push(`slack: ${e.slackError || e.message}`); });
  }

  await store.wipeActivity(cfg.client);
  return { appts, msgs, errors };
}

// ---------- insights ----------

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const mins = (ms) => (ms == null ? '-' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)} min`);
const asDay = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));

export async function insights(cfg, team, days = 7, now = Date.now()) {
  const today = dateKey(now, cfg.timezone);
  let from = today;
  for (let i = 1; i < days; i++) {
    const [y, m, d] = from.split('-').map(Number);
    from = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  }
  const since = hourStart(from, 0, cfg.timezone);
  const name = (id) => team.byId.get(id)?.name || 'someone no longer in the pool';
  const rules = await loadRules(cfg);
  const [requests, slots] = await Promise.all([
    store.requestsSince(cfg.client, new Date(since).toISOString()),
    store.slotsBetween(cfg.client, from, today),
  ]);

  // Coverage: finished hours in the window that had their full headcount.
  let total = 0; let covered = 0; const shortHours = new Map();
  for (let day = from; day <= today; day = nextDateKey(day)) {
    for (const h of dayCoverage(cfg, day, rules, weekdayOf(day)).hours) {
      if (hourStart(day, h, cfg.timezone) + HOUR > now) continue;
      total++;
      const n = slots.filter((x) => asDay(x.day) === day && x.hour === h && x.status === 'active').length;
      if (n >= headcountFor(cfg, h)) covered++;
      else shortHours.set(hourLabel(h), (shortHours.get(hourLabel(h)) || 0) + 1);
    }
  }

  // Swaps.
  const escalateMs = (cfg.claim?.escalateAfterMinutes ?? 3) * 60_000;
  const claimed = requests.filter((r) => r.status === 'claimed');
  const claimMs = claimed.map((r) => Date.parse(r.claimed_at) - Date.parse(r.requested_at));
  const slow = claimMs.filter((ms) => ms > escalateMs).length;
  const missed = requests.filter((r) => r.status === 'open' && Date.parse(r.appt_start) < now).length;
  const creditIssues = claimed.filter((r) => r.reassign_error).length;

  const tally = (arr, key) => {
    const m = new Map();
    for (const x of arr) if (x[key]) m.set(x[key], (m.get(x[key]) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const list = (pairs, n = 5) => (pairs.length ? pairs.slice(0, n).map(([id, c]) => `${name(id)} (${c})`).join(', ') : 'none');

  const inWindow = (t) => t && Date.parse(t) >= since;
  const released = tally(slots.filter((x) => x.status === 'released' && inWindow(x.released_at)), 'ghl_user_id');
  const pickedUp = tally(slots.filter((x) => x.source === 'volunteer' && inWindow(x.created_at)), 'ghl_user_id');
  const pct = total ? Math.round((covered / total) * 100) : null;
  const shortList = [...shortHours].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h, c]) => `${h} (${c}x)`).join(', ');

  return [
    `*Hot-swap insights: last ${days} day${days === 1 ? '' : 's'}* (${formatDay(from)} to ${formatDay(today)})`,
    '',
    '*Coverage*',
    `• ${pct == null ? 'No finished coverage hours yet' : `${pct}% of hours fully covered (${covered}/${total})`}`,
    shortHours.size ? `• Most often short: ${shortList}` : '• No short hours',
    '',
    '*Hot swaps*',
    `• ${requests.length} requested, ${claimed.length} claimed${missed ? `, *${missed} never claimed*` : ''}`,
    `• Median time to claim: ${mins(median(claimMs))}${slow ? ` · ${slow} took longer than ${cfg.claim?.escalateAfterMinutes ?? 3} min` : ''}`,
    creditIssues ? `• ${creditIssues} claim(s) where GHL credit didn't fully update` : null,
    '',
    '*People*',
    `• Handed off the most calls: ${list(tally(requests, 'from_ghl_user_id'))}`,
    `• Took the most calls: ${list(tally(claimed, 'claimed_by_ghl'))}`,
    `• Picked up the most open hours: ${list(pickedUp)}`,
    `• Released the most hours: ${list(released)}`,
  ].filter((l) => l !== null).join('\n');
}

// ---------- coverage exceptions (/hotswap dates) ----------

const describeCoverage = (dc) => {
  if (!dc.hours.length) return 'Off';
  const range = `${hourLabel(dc.hours[0])}–${hourLabel(dc.hours[dc.hours.length - 1] + 1)}`;
  return dc.source === 'default' ? `Normal (${range})` : range;
};

export async function upcomingCoverage(cfg, days = 14, now = Date.now()) {
  const rules = await loadRules(cfg);
  const out = [];
  let day = dateKey(now, cfg.timezone);
  for (let i = 0; i < days; i++) {
    const dc = dayCoverage(cfg, day, rules, weekdayOf(day));
    out.push({ day, label: describeCoverage(dc), source: dc.source });
    day = nextDateKey(day);
  }
  return out;
}

// Save a rule, then bring today's/tomorrow's roster in line right away.
export async function setCoverage(cfg, ctx, { day, scope, mode, firstHour, lastHour, by }) {
  const kind = scope === 'weekday' ? 'weekday' : 'date';
  const key = kind === 'date' ? day : String(weekdayOf(day));
  if (mode === 'normal') await store.clearCoverageRule(cfg.client, kind, key);
  else await store.setCoverageRule({ client: cfg.client, kind, key, mode, firstHour, lastHour, by });

  const today = dateKey(Date.now(), cfg.timezone);
  const affected = [today, nextDateKey(today)].filter((d) => (kind === 'date' ? d === day : weekdayOf(d) === weekdayOf(day)));
  for (const d of affected) await applyCoverageChange(cfg, ctx, d);

  const what = mode === 'normal' ? 'normal coverage' : mode === 'off' ? 'no coverage' : `${hourLabel(firstHour)}–${hourLabel(lastHour + 1)} ET`;
  const when = kind === 'date' ? formatDay(day) : `every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekdayOf(day)]}`;
  return { ok: true, message: `Saved: ${when} → ${what}.${affected.length ? ' Updated the roster.' : ''}` };
}

// Cancel on-call hours that are no longer covered, drop their cover requests, refill new hours.
async function applyCoverageChange(cfg, ctx, day) {
  const hours = await hoursForDay(cfg, day);
  for (const slot of await store.activeSlots(cfg.client, day)) {
    if (hours.includes(slot.hour) || hourStart(day, slot.hour, cfg.timezone) + HOUR <= Date.now()) continue;
    if (slot.block_event_id) await ctx.ghl.deleteEvent(slot.block_event_id).catch((e) => console.error('cancel on-call failed', e.message));
    await store.releaseSlot(slot.id);
  }
  await clearCoverMessages(cfg, ctx.slack, day);
  const today = dateKey(Date.now(), cfg.timezone);
  if (await store.getRosterPost(cfg.client, day)) {
    await publishRoster(cfg, { ...ctx, day, phase: day > today ? 'plan' : 'confirm', fresh: false });
  }
}

// ---------- pool management from Slack ----------

async function ghlUserForSlack(cfg, { ghl, slack }, slackUserId) {
  const email = await slack.emailByUserId(slackUserId).catch(() => null);
  const mapped = Object.entries(cfg.pool.slackUserIds || {}).find(([, s]) => s === slackUserId)?.[0];
  const u = mapped ? await ghl.user(mapped) : await ghl.userByEmail(email);
  return u ? { ghlUserId: u.id, name: u.name || [u.firstName, u.lastName].filter(Boolean).join(' '), email: (u.email || email || '').toLowerCase() } : null;
}

export async function addToPool(cfg, ctx, { slackUserId, by }) {
  const u = await ghlUserForSlack(cfg, ctx, slackUserId);
  if (!u) return { ok: false, message: `<@${slackUserId}> doesn't match a GHL user by email. Their Slack and GHL emails must match (or add them to pool.slackUserIds in the config).` };
  await store.setPoolOverride({ client: cfg.client, ghlUserId: u.ghlUserId, action: 'add', name: u.name, email: u.email, slackUserId, changedBy: by });
  await ctx.ghl.setCalendarTeam(cfg.ghl.onCall.calendarId, [...new Set([...ctx.team.people.map((p) => p.ghlUserId), u.ghlUserId])]);
  return { ok: true, message: `Added <@${slackUserId}> (${u.name}) to the hot-swap pool. They'll be included from the next roster run.` };
}

export async function removeFromPool(cfg, ctx, { slackUserId, by }) {
  const u = await ghlUserForSlack(cfg, ctx, slackUserId);
  if (!u) return { ok: false, message: `<@${slackUserId}> doesn't match a GHL user by email.` };
  await store.setPoolOverride({ client: cfg.client, ghlUserId: u.ghlUserId, action: 'remove', name: u.name, email: u.email, slackUserId, changedBy: by });
  // Free their remaining on-call hours so they show as NOT COVERED with a cover button.
  const today = dateKey(Date.now(), cfg.timezone);
  const freed = [];
  for (const slot of await store.futureSlotsFor(cfg.client, u.ghlUserId, today)) {
    const day = typeof slot.day === 'string' ? slot.day.slice(0, 10) : dateKey(new Date(slot.day).getTime() + 12 * HOUR, 'UTC');
    if (hourStart(day, slot.hour, cfg.timezone) + HOUR <= Date.now()) continue;
    const r = await releaseHour(cfg, { ...ctx, day, slotId: slot.id, slackUserId: by });
    if (r.ok) freed.push(`${formatDay(day)} ${hourLabel(slot.hour)}`);
  }
  return { ok: true, message: `Removed <@${slackUserId}> (${u.name}) from the hot-swap pool.${freed.length ? ` Freed their hours: ${freed.join(', ')}.` : ''}` };
}

export function describePool(team) {
  const lines = team.people.map((p) => `• ${p.slackUserId ? `<@${p.slackUserId}>` : p.name} (${p.role}${p.availabilityCalendarId ? '' : ', no calendar'})`);
  return `Hot-swap pool (${team.people.length}):\n${lines.join('\n')}`;
}

// ---------- hot swap requests ----------

// Upcoming appointments the requester could hand off (next 12h).
export async function handoffCandidates(cfg, { ghl, team, slack, slackUserId, now = Date.now() }) {
  const me = await personForSlackUser(team, slack, slackUserId);
  const owners = isManager(team, slackUserId) ? team.people : me ? [me] : [];
  const out = [];
  for (const p of owners) {
    const events = await ghl.userEvents(p.ghlUserId, now - 15 * 60_000, now + 12 * HOUR);
    for (const e of events) out.push({ ...e, ownerName: p.name });
  }
  return out.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)).slice(0, 25);
}

function requestBlocks(cfg, team, req, { onCall, headline, done }) {
  const start = Date.parse(req.appt_start);
  const from = team.people.find((p) => p.slackUserId === req.from_slack_user_id);
  const lines = [
    headline,
    `*${req.contact_name}*: ${formatTime(start, cfg.timezone)} ET (${formatDay(dateKey(start, cfg.timezone))})`,
    `From ${mention(req.from_slack_user_id, from?.name || 'closer')}${req.reason ? `: _${req.reason}_` : ''}`,
  ];
  if (onCall) lines.push(onCall);
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }];
  if (!done) {
    blocks.push({ type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: "I've got it" }, style: 'primary', action_id: 'claim', value: String(req.id) },
    ] });
  }
  return { text: `Hot swap: ${req.contact_name} at ${formatTime(start, cfg.timezone)} ET`, blocks };
}

export async function createSwapRequest(cfg, { ghl, slack, team, appointmentId, reason, slackUserId }) {
  const appt = await ghl.getAppointment(appointmentId);
  const start = Date.parse(appt.startTime);
  const contactName = appt.contactId ? await ghl.contactName(appt.contactId).catch(() => appt.title) : appt.title;
  const req = await store.createRequest({
    client: cfg.client, appointmentId, calendarId: appt.calendarId, contactId: appt.contactId, contactName,
    apptStart: start, fromGhlUserId: appt.assignedUserId, fromSlackUserId: slackUserId, reason,
  });
  if (!req) return { ok: false, message: 'There is already an open hot-swap request for that appointment.' };

  const day = dateKey(start, cfg.timezone);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(start)));
  const onCallRows = (await store.activeSlots(cfg.client, day)).filter((r) => r.hour === hour && r.ghl_user_id !== appt.assignedUserId);
  const onCallPeople = onCallRows.map((r) => team.byId.get(r.ghl_user_id)).filter(Boolean);

  const escalateMs = (cfg.claim?.escalateAfterMinutes ?? 3) * 60_000;
  const urgent = start - Date.now() <= escalateMs || !onCallPeople.length;
  const everyone = team.people.filter((p) => p.slackUserId && p.slackUserId !== slackUserId);
  const allMentions = [...everyone.map((p) => `<@${p.slackUserId}>`), mention(team.manager.slackUserId, team.manager.name)].join(' ');

  const onCallText = urgent
    ? `${onCallPeople.length ? 'Starting soon, so this goes to everyone' : 'Nobody is on call this hour, so this goes to everyone'}: ${allMentions}`
    : `On call: ${onCallPeople.map((p) => mention(p.slackUserId, p.name)).join(', ')}`;
  const msg = requestBlocks(cfg, team, req, { onCall: onCallText, headline: '🔥 *Hot swap needed*' });
  const posted = await slack.post(cfg.slack.channelId, msg.text, msg.blocks);

  let escalationId = null;
  if (!urgent) {
    const esc = requestBlocks(cfg, team, req, {
      headline: `⏰ *Unclaimed after ${cfg.claim?.escalateAfterMinutes ?? 3} min.* Anyone free?`,
      onCall: allMentions,
    });
    esc.text = `${escalationMarker(req.id)} still unclaimed: ${esc.text}`;
    const sched = await slack.schedule(cfg.slack.channelId, Math.floor((Date.now() + escalateMs) / 1000), esc.text, esc.blocks,
      { thread_ts: posted.ts, reply_broadcast: true });
    escalationId = sched.scheduled_message_id;
  }
  await store.setRequestMessage(req.id, posted.channel, posted.ts, escalationId);
  // Claimed while we were scheduling? Cancel the alert ourselves.
  if (escalationId && (await store.getRequest(req.id))?.status !== 'open') {
    await slack.unschedule(cfg.slack.channelId, escalationId).catch(() => {});
  }
  return { ok: true, message: 'Posted. Stay on your current call. Someone will claim it.' };
}

const escalationMarker = (id) => `Hot swap #${id}`;

// Cancel the pending "unclaimed" alert. Uses the saved ID, and also scans the channel's scheduled
// messages for this request's marker, so it works even if the claim lands before the ID was saved.
async function cancelEscalation(cfg, slack, req) {
  const channel = req.channel || cfg.slack.channelId;
  const fresh = await store.getRequest(req.id);
  const ids = new Set([req.escalation_msg_id, fresh?.escalation_msg_id].filter(Boolean));
  try {
    const marker = `${escalationMarker(req.id)} still unclaimed`;
    for (const m of await slack.scheduledIn(cfg.slack.channelId)) if ((m.text || '').startsWith(marker)) ids.add(m.id);
  } catch (e) { console.error('list scheduled failed', e.message); }
  for (const id of ids) {
    await slack.unschedule(channel, id).catch((e) => {
      if (!['invalid_scheduled_message_id'].includes(e.slackError)) console.error('unschedule failed', e.slackError || e.message);
    });
  }
}

export async function claimSwap(cfg, { ghl, slack, team, requestId, slackUserId }) {
  const req = await store.getRequest(requestId);
  if (!req) return { ok: false, message: 'Request not found.' };
  if (req.status !== 'open') return { ok: false, message: 'Already claimed.' };
  const me = await personForSlackUser(team, slack, slackUserId);
  if (!me) return { ok: false, message: "You're not in the hot-swap pool, so the appointment can't be assigned to you in GHL." };
  if (me.ghlUserId === req.from_ghl_user_id) return { ok: false, message: "That's your own appointment." };

  // Don't hand someone a call that overlaps another call they already have.
  const start = Date.parse(req.appt_start);
  const clash = (await ghl.userEvents(me.ghlUserId, start - HOUR, start + HOUR))
    .filter((e) => e.id !== req.appointment_id)
    .find((e) => Date.parse(e.startTime) < start + 45 * 60_000 && Date.parse(e.endTime) > start);
  if (clash) return { ok: false, message: `You already have a call at ${formatTime(Date.parse(clash.startTime), cfg.timezone)} ET that overlaps.` };

  const won = await store.claimRequest(req.id, me.ghlUserId, slackUserId);
  if (!won) return { ok: false, message: 'Someone else just claimed it.' };

  await cancelEscalation(cfg, slack, req);

  // Credit moves via the deal owner + contact owner. The appointment itself is left alone:
  // GHL only allows calendar team members as appointment owners, and A/B teams stay as they are.
  const { done: did, problems } = await creditClaimer(cfg, ghl, team, req, me);
  if (problems.length) await store.setReassignError(req.id, problems.join(' | '));
  const status = [
    did.length ? `Moved to you in GHL: ${did.join(', ')}.` : '',
    problems.length ? `⚠️ Not updated: ${problems.join('; ')}. Fix it in GHL so you get credit.` : '',
  ].filter(Boolean).join(' ');

  const msg = requestBlocks(cfg, team, { ...req, ...won }, {
    headline: `✅ *Claimed by ${mention(slackUserId, me.name)}*`,
    onCall: `${status} Next: text the prospect your Zoom link from GHL.`,
    done: true,
  });
  await slack.update(req.channel, req.ts, msg.text, msg.blocks);
  return { ok: true, message: status || 'Claimed.' };
}

async function creditClaimer(cfg, ghl, team, req, me) {
  const done = [];
  const problems = [];
  if (!req.contact_id) return { done, problems: ['no contact on the appointment'] };
  const from = team.byId.get(req.from_ghl_user_id)?.name || 'the original closer';
  try {
    const [deal] = await ghl.openOpportunities(req.contact_id, cfg.ghl.dealPipelineIds || []);
    if (deal) { await ghl.setOpportunityOwner(deal.id, me.ghlUserId); done.push('deal owner'); }
    else problems.push('no open deal found');
  } catch (e) { problems.push(`deal owner (${e.message.slice(0, 80)})`); }
  try { await ghl.setContactOwner(req.contact_id, me.ghlUserId); done.push('contact owner'); }
  catch (e) { problems.push(`contact owner (${e.message.slice(0, 80)})`); }
  try {
    const when = `${formatTime(Date.parse(req.appt_start), cfg.timezone)} ET on ${formatDay(dateKey(Date.parse(req.appt_start), cfg.timezone))}`;
    await ghl.addNote(req.contact_id,
      `Hot swap: ${from} couldn't take the ${when} call${req.reason ? ` (${req.reason})` : ''}. ${me.name} took it. ` +
      `Deal and contact owner moved to ${me.name}. The calendar appointment stays under ${from}.`, me.ghlUserId);
    done.push('note added');
  } catch (e) { problems.push(`note (${e.message.slice(0, 80)})`); }
  return { done, problems };
}
