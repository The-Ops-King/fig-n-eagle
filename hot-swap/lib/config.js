import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');
const cache = new Map();

export function loadConfig(client = process.env.HOT_SWAP_CLIENT) {
  if (!client) throw new Error('HOT_SWAP_CLIENT is not set');
  if (!/^[a-z0-9-]+$/.test(client)) throw new Error(`Invalid client name: ${client}`);
  if (cache.has(client)) return cache.get(client);
  const cfg = JSON.parse(readFileSync(path.join(dir, `${client}.json`), 'utf8'));
  validate(cfg);
  cache.set(client, cfg);
  return cfg;
}

function validate(cfg) {
  const need = (cond, msg) => { if (!cond) throw new Error(`Config ${cfg.client}: ${msg}`); };
  need(cfg.timezone, 'timezone required');
  need(cfg.ghl?.locationId && cfg.ghl?.tokenEnv, 'ghl.locationId and ghl.tokenEnv required');
  const c = cfg.coverage;
  need(c && Number.isInteger(c.firstHour) && Number.isInteger(c.lastHour) && c.firstHour <= c.lastHour, 'coverage.firstHour/lastHour invalid');
  const pool = cfg.pool;
  need(pool && typeof pool === 'object' && !Array.isArray(pool), 'pool must be an object');
  need(pool.closerCalendarGroupId || pool.include?.length, 'pool needs closerCalendarGroupId or include entries');
  const ids = new Set();
  for (const p of pool.include || []) {
    need(p.ghlUserId && p.availabilityCalendarId && p.name, `pool.include entry incomplete: ${JSON.stringify(p)}`);
    need(!ids.has(p.ghlUserId), `duplicate ghlUserId ${p.ghlUserId}`);
    ids.add(p.ghlUserId);
  }
}

export function headcountFor(cfg, hour) {
  const h = cfg.coverage.headcount || {};
  return h.byHour?.[String(hour)] ?? h.default ?? 1;
}

export function coverageHours(cfg) {
  const out = [];
  for (let h = cfg.coverage.firstHour; h <= cfg.coverage.lastHour; h++) out.push(h);
  return out;
}

// Hours to cover on `day` (YYYY-MM-DD), applying rules: date rule > weekday rule > config.
// Returns { hours, source } where source is 'date' | 'weekday' | 'default'.
export function dayCoverage(cfg, day, rules = [], weekday) {
  const find = (kind, key) => rules.find((r) => r.kind === kind && String(r.key) === String(key));
  const rule = find('date', day) || find('weekday', weekday);
  if (rule) {
    if (rule.mode === 'off') return { hours: [], source: rule.kind, rule };
    const out = [];
    for (let h = rule.first_hour; h <= rule.last_hour; h++) out.push(h);
    return { hours: out, source: rule.kind, rule };
  }
  return { hours: cfg.coverage.days.includes(weekday) ? coverageHours(cfg) : [], source: 'default' };
}
