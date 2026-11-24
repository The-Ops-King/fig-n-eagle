// Orchestration: GHL + Slack + DB. Each exported function is one user-visible action.
import { activePool, coverageHours, headcountFor } from './config.js';
import { slotsToIntervals, freeHours } from './availability.js';
import { planRoster } from './roster.js';
import { HOUR, dateKey, nextDateKey, hourStart, hourLabel, formatDay, formatTime, weekdayOf } from './time.js';
import { mention } from './slack.js';
import * as store from './db.js';

// ---------- people ----------

export async function resolvePeople(cfg, slack) {
  const people = await Promise.all(activePool(cfg).map(async (p) => ({
    ...p,
    id: p.ghlUserId,
    slackUserId: p.slackUserId || (await slack.userIdByEmail(p.email)),
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
      const cal = await ghl.calendar(p.availabilityCalendarId);
      const slots = await ghl.freeSlots(p.availabilityCalendarId, p.ghlUserId, windowStart, windowEnd, tz);
      const intervals = slotsToIntervals(slots, cal.slotDuration || 60, cal.slotInterval || cal.slotDuration || 60);
      const free = new Set(freeHours(intervals, [...starts.keys()], cfg.coverage.minFreeMinutes ?? 45).map((ms) => starts.get(ms)));
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
export function hoursToCover(cfg, day, now = Date.now()) {
  if (!cfg.coverage.days.includes(weekdayOf(day))) return [];
  return coverageHours(cfg).filter((h) => hourStart(day, h, cfg.timezone) + HOUR > now);
}

// ---------- roster ----------

// Plan (and optionally apply) the roster for `day`.
// apply=false: preview only (evening gap check). apply=true: create GHL blocks + DB rows.
export async function buildRoster(cfg, { ghl, team, day, apply, now = Date.now() }) {
  const hours = hoursToCover(cfg, day, now);
  if (!hours.length) return { day, hours, assignments: new Map(), gaps: [], errors: [] };

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

  const errors = avail.filter((p) => p.error).map((p) => `${p.name}: ${p.error}`);
  if (apply) {
    for (const [hour, ids] of plan.assignments) {
      for (const id of ids) {
        if ((locked.get(hour) || []).includes(id)) continue;
        try {
          await assignHour(cfg, ghl, { day, hour, ghlUserId: id, source: 'auto' });
        } catch (e) {
          errors.push(`${team.byId.get(id)?.name} ${hourLabel(hour)}: ${e.message}`);
        }
      }
    }
  }
  return { day, hours, ...plan, errors };
}

async function assignHour(cfg, ghl, { day, hour, ghlUserId, source }) {
  const start = hourStart(day, hour, cfg.timezone);
  const eventId = await ghl.createOnCall({ userId: ghlUserId, startMs: start, endMs: start + HOUR, title: cfg.blockTitle });
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

export function renderRoster(cfg, team, day, byHour, { phase = 'confirm', now = Date.now() } = {}) {
  const name = (id) => team.byId.get(id);
  const hours = cfg.coverage.days.includes(weekdayOf(day)) ? coverageHours(cfg) : [];
  const lines = hours.map((h) => {
    const ids = (byHour.get(h) || []).map((r) => r.ghl_user_id ?? r);
    const want = headcountFor(cfg, h);
    const who = ids.map((id) => mention(name(id)?.slackUserId, name(id)?.name || id)).join(', ');
    if (hourStart(day, h, cfg.timezone) + HOUR <= now) return `~${hourLabel(h)}: ${ids.map((id) => name(id)?.name || id).join(', ') || '-'}~`;
    if (!ids.length) return `⚠️ *${hourLabel(h)}*: *NOT COVERED*. Tap *Cover an hour* to take it.`;
    if (ids.length < want) return `*${hourLabel(h)}*: ${who}  ⚠️ short ${want - ids.length}`;
    return `*${hourLabel(h)}*: ${who}`;
  });
  const text = `${phase === 'plan' ? "Tomorrow's hot-swap plan" : "Today's hot-swap roster"}: ${formatDay(day)} (ET)`;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || '_No coverage hours today._' } },
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
  const result = await buildRoster(cfg, { ghl, team, day, apply: true });
  const byHour = await currentRoster(cfg, day);
  const msg = renderRoster(cfg, team, day, byHour, { phase });
  const prev = fresh ? null : await store.getRosterPost(cfg.client, day);
  if (prev) {
    await slack.update(prev.channel, prev.ts, msg.text, msg.blocks);
  } else {
    const { ts } = await slack.post(cfg.slack.channelId, msg.text, msg.blocks);
    await store.saveRosterPost(cfg.client, day, cfg.slack.channelId, ts);
  }

  if (team.manager.slackUserId && result.hours.length) {
    const label = phase === 'plan' ? `Tomorrow's hot-swap plan (${formatDay(day)})` : `Today's hot-swap roster (${formatDay(day)})`;
    const gapLines = result.gaps.map((g) => `• ${hourLabel(g.hour)} ET: need ${g.missing} more`);
    const parts = [result.gaps.length
      ? `${label}: *${result.gaps.length} hour(s) without enough cover.*\n${gapLines.join('\n')}\nAnyone in the pool can take an open hour with *Cover an hour* on the roster.`
      : `${label}: every hour is covered. ✅`];
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
  const msg = renderRoster(cfg, team, day, byHour, { phase: day > today ? 'plan' : 'confirm' });
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
  await rosterThread(cfg, slack, day, msg.text, msg.blocks);
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

// Someone takes an hour. More than one person can cover the same hour.
export async function volunteerHour(cfg, { ghl, slack, team, day, hour, slackUserId, coverMessage }) {
  const me = await personForSlackUser(team, slack, slackUserId);
  if (!me) return { ok: false, message: "You're not in the hot-swap pool. Ask your manager to add you." };
  if (hourStart(day, hour, cfg.timezone) + HOUR <= Date.now()) return { ok: false, message: `${hourLabel(hour)} is already over.` };
  const [a] = await availability(cfg, ghl, [me], day, [hour]);
  if (!a.free.has(hour)) return { ok: false, message: `Your GHL calendar isn't free for all of ${hourLabel(hour)}.` };
  const row = await assignHour(cfg, ghl, { day, hour, ghlUserId: me.id, source: 'volunteer' });
  if (!row) return { ok: false, message: `You're already on call at ${hourLabel(hour)}.` };
  await refreshRosterMessage(cfg, { slack, team, day });
  const covering = ((await currentRoster(cfg, day)).get(hour) || []).map((r) => team.byId.get(r.ghl_user_id)).filter(Boolean);
  const done = `✅ *${hourLabel(hour)}* is covered by ${covering.map((p) => mention(p.slackUserId, p.name)).join(', ')}.`;
  if (coverMessage?.ts) {
    const msg = coverRequestMessage(day, hour, `${done}\nMore cover is welcome: tap below to join.`);
    await slack.update(coverMessage.channel, coverMessage.ts, msg.text, msg.blocks);
  } else {
    await rosterThread(cfg, slack, day, `${mention(me.slackUserId, me.name)} is now also covering *${hourLabel(hour)}*.`);
  }
  return { ok: true, message: `You're on call at ${hourLabel(hour)}. It's on your GHL and Google calendar.` };
}

export async function openHoursFor(cfg, day) {
  const byHour = await currentRoster(cfg, day);
  return hoursToCover(cfg, day).filter((h) => (byHour.get(h) || []).length < headcountFor(cfg, h));
}

// Every remaining hour, flagged when it's short of cover. Anyone can add themselves to any hour.
export async function coverableHours(cfg, day) {
  const byHour = await currentRoster(cfg, day);
  return hoursToCover(cfg, day).map((h) => ({ hour: h, count: (byHour.get(h) || []).length, open: (byHour.get(h) || []).length < headcountFor(cfg, h) }));
}

export async function myFutureSlots(cfg, team, day, slackUserId) {
  const rows = await store.activeSlots(cfg.client, day);
  return rows.filter((r) => {
    const p = team.byId.get(r.ghl_user_id);
    return (p?.slackUserId === slackUserId || isManager(team, slackUserId))
      && hourStart(day, r.hour, cfg.timezone) + HOUR > Date.now();
  });
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
    const sched = await slack.schedule(cfg.slack.channelId, Math.floor((Date.now() + escalateMs) / 1000), esc.text, esc.blocks,
      { thread_ts: posted.ts, reply_broadcast: true });
    escalationId = sched.scheduled_message_id;
  }
  await store.setRequestMessage(req.id, posted.channel, posted.ts, escalationId);
  return { ok: true, message: 'Posted. Stay on your current call. Someone will claim it.' };
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

  if (req.escalation_msg_id) await slack.unschedule(req.channel, req.escalation_msg_id).catch(() => {});

  let reassignNote = 'The appointment is now assigned to you in GHL.';
  try {
    await ghl.reassignAppointment(req.appointment_id, me.ghlUserId);
  } catch (e) {
    await store.setReassignError(req.id, e.message);
    reassignNote = `⚠️ GHL reassignment failed (${e.message.slice(0, 120)}). Reassign it manually so you get credit.`;
  }

  const done = requestBlocks(cfg, team, { ...req, ...won }, {
    headline: `✅ *Claimed by ${mention(slackUserId, me.name)}*`,
    onCall: `${reassignNote} Next: text the prospect your Zoom link from GHL.`,
    done: true,
  });
  await slack.update(req.channel, req.ts, done.text, done.blocks);
  return { ok: true, message: reassignNote };
}
