import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCHEMA = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'schema.sql'), 'utf8');

let raw;
let ready;

// Tables are created on first use (schema.sql is idempotent), so there's no manual setup step.
async function ensureSchema() {
  const statements = SCHEMA.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
  for (const st of statements) await raw.query(st);
}

function conn() {
  if (!raw) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('Missing env DATABASE_URL (connect Neon to this Vercel project)');
    raw = neon(url);
  }
  return raw;
}

// Tagged-template SQL that waits for the schema on first call.
export function db() {
  conn();
  return async (strings, ...values) => {
    ready ??= ensureSchema().catch((e) => { ready = undefined; throw e; });
    await ready;
    return raw(strings, ...values);
  };
}

export async function activeSlots(client, day) {
  return db()`SELECT * FROM roster_slots WHERE client = ${client} AND day = ${day} AND status = 'active' ORDER BY hour, id`;
}

export async function insertSlot({ client, day, hour, ghlUserId, blockEventId, source }) {
  const rows = await db()`
    INSERT INTO roster_slots (client, day, hour, ghl_user_id, block_event_id, source)
    VALUES (${client}, ${day}, ${hour}, ${ghlUserId}, ${blockEventId}, ${source})
    ON CONFLICT DO NOTHING
    RETURNING *`;
  return rows[0] || null;
}

export async function releaseSlot(id) {
  const rows = await db()`
    UPDATE roster_slots SET status = 'released', released_at = now()
    WHERE id = ${id} AND status = 'active' RETURNING *`;
  return rows[0] || null;
}

export async function getRosterPost(client, day) {
  const rows = await db()`SELECT * FROM roster_posts WHERE client = ${client} AND day = ${day}`;
  return rows[0] || null;
}

export async function saveRosterPost(client, day, channel, ts) {
  await db()`
    INSERT INTO roster_posts (client, day, channel, ts) VALUES (${client}, ${day}, ${channel}, ${ts})
    ON CONFLICT (client, day) DO UPDATE SET channel = EXCLUDED.channel, ts = EXCLUDED.ts`;
}

export async function createRequest(r) {
  const rows = await db()`
    INSERT INTO swap_requests
      (client, appointment_id, calendar_id, contact_id, contact_name, appt_start,
       from_ghl_user_id, from_slack_user_id, reason)
    VALUES (${r.client}, ${r.appointmentId}, ${r.calendarId}, ${r.contactId}, ${r.contactName},
            ${new Date(r.apptStart).toISOString()}, ${r.fromGhlUserId}, ${r.fromSlackUserId}, ${r.reason})
    ON CONFLICT DO NOTHING
    RETURNING *`;
  return rows[0] || null;
}

export async function setRequestMessage(id, channel, ts, escalationMsgId) {
  await db()`UPDATE swap_requests SET channel = ${channel}, ts = ${ts}, escalation_msg_id = ${escalationMsgId} WHERE id = ${id}`;
}

// Atomic: only the first claimer wins.
export async function claimRequest(id, ghlUserId, slackUserId) {
  const rows = await db()`
    UPDATE swap_requests
    SET status = 'claimed', claimed_at = now(), claimed_by_ghl = ${ghlUserId}, claimed_by_slack = ${slackUserId}
    WHERE id = ${id} AND status = 'open'
    RETURNING *`;
  return rows[0] || null;
}

export async function setReassignError(id, message) {
  await db()`UPDATE swap_requests SET reassign_error = ${message} WHERE id = ${id}`;
}

export async function getRequest(id) {
  const rows = await db()`SELECT * FROM swap_requests WHERE id = ${id}`;
  return rows[0] || null;
}

export async function poolOverrides(client) {
  return db()`SELECT * FROM pool_overrides WHERE client = ${client}`;
}

export async function setPoolOverride({ client, ghlUserId, action, name, email, slackUserId, changedBy }) {
  await db()`
    INSERT INTO pool_overrides (client, ghl_user_id, action, name, email, slack_user_id, changed_by)
    VALUES (${client}, ${ghlUserId}, ${action}, ${name}, ${email}, ${slackUserId}, ${changedBy})
    ON CONFLICT (client, ghl_user_id) DO UPDATE
      SET action = EXCLUDED.action, name = EXCLUDED.name, email = EXCLUDED.email,
          slack_user_id = EXCLUDED.slack_user_id, changed_by = EXCLUDED.changed_by, changed_at = now()`;
}

export async function futureSlotsFor(client, ghlUserId, fromDay) {
  return db()`SELECT * FROM roster_slots WHERE client = ${client} AND ghl_user_id = ${ghlUserId}
              AND status = 'active' AND day >= ${fromDay} ORDER BY day, hour`;
}

export async function setSlotEvent(id, eventId) {
  await db()`UPDATE roster_slots SET block_event_id = ${eventId} WHERE id = ${id}`;
}

export async function addCoverMessage({ client, day, hour, channel, ts }) {
  await db()`INSERT INTO cover_messages (client, day, hour, channel, ts) VALUES (${client}, ${day}, ${hour}, ${channel}, ${ts}) ON CONFLICT DO NOTHING`;
}

export async function coverMessages(client, day) {
  return db()`SELECT * FROM cover_messages WHERE client = ${client} AND day = ${day}`;
}

export async function staleCoverMessages(client, beforeDay) {
  return db()`SELECT * FROM cover_messages WHERE client = ${client} AND day < ${beforeDay}`;
}

export async function removeCoverMessage(channel, ts) {
  await db()`DELETE FROM cover_messages WHERE channel = ${channel} AND ts = ${ts}`;
}

export async function coverageRules(client) {
  return db()`SELECT * FROM coverage_rules WHERE client = ${client}`;
}

export async function setCoverageRule({ client, kind, key, mode, firstHour, lastHour, by }) {
  await db()`
    INSERT INTO coverage_rules (client, kind, key, mode, first_hour, last_hour, updated_by)
    VALUES (${client}, ${kind}, ${key}, ${mode}, ${firstHour}, ${lastHour}, ${by})
    ON CONFLICT (client, kind, key) DO UPDATE
      SET mode = EXCLUDED.mode, first_hour = EXCLUDED.first_hour, last_hour = EXCLUDED.last_hour,
          updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export async function clearCoverageRule(client, kind, key) {
  await db()`DELETE FROM coverage_rules WHERE client = ${client} AND kind = ${kind} AND key = ${key}`;
}

export async function getGapBoard(client, day) {
  const rows = await db()`SELECT * FROM gap_boards WHERE client = ${client} AND day = ${day}`;
  return rows[0] || null;
}

export async function saveGapBoard(client, day, channel, ts) {
  await db()`INSERT INTO gap_boards (client, day, channel, ts) VALUES (${client}, ${day}, ${channel}, ${ts})
             ON CONFLICT (client, day) DO UPDATE SET channel = EXCLUDED.channel, ts = EXCLUDED.ts`;
}

export async function deleteGapBoard(client, day) {
  await db()`DELETE FROM gap_boards WHERE client = ${client} AND day = ${day}`;
}

export async function requestsSince(client, sinceIso) {
  return db()`SELECT * FROM swap_requests WHERE client = ${client} AND requested_at >= ${sinceIso}`;
}

export async function slotsBetween(client, fromDay, toDay) {
  return db()`SELECT * FROM roster_slots WHERE client = ${client} AND day >= ${fromDay} AND day <= ${toDay}`;
}

export async function alertedHours(client, day) {
  const rows = await db()`SELECT hour FROM manager_alerts WHERE client = ${client} AND day = ${day}`;
  return new Set(rows.map((r) => Number(r.hour)));
}

export async function markAlerted(client, day, hours) {
  for (const h of hours) {
    await db()`INSERT INTO manager_alerts (client, day, hour) VALUES (${client}, ${day}, ${h}) ON CONFLICT DO NOTHING`;
  }
}
