// Read-only dry run against live GHL: prints the roster the bot would build for a day.
// No Slack, no DB, no writes.  Usage:  GHL_PIT_FIG_N_EAGLE=pit-... node scripts/preview.js [YYYY-MM-DD] [client]
import { loadConfig, activePool, headcountFor } from '../lib/config.js';
import { ghlClient } from '../lib/ghl.js';
import { availability, hoursToCover } from '../lib/service.js';
import { planRoster } from '../lib/roster.js';
import { dateKey, hourLabel, hourStart, formatDay } from '../lib/time.js';

const cfg = loadConfig(process.argv[3] || process.env.HOT_SWAP_CLIENT || 'fig-n-eagle');
const day = process.argv[2] || dateKey(Date.now(), cfg.timezone);
const ghl = ghlClient(cfg);
const people = activePool(cfg).map((p) => ({ ...p, id: p.ghlUserId }));
const hours = hoursToCover(cfg, day, hourStart(day, 0, cfg.timezone));
const avail = await availability(cfg, ghl, people, day, hours);
const { assignments, gaps } = planRoster({ hours, people: avail, headcount: (h) => headcountFor(cfg, h), maxConsecutive: cfg.coverage.maxConsecutiveHours });
const name = new Map(avail.map((p) => [p.id, p.name]));

console.log(`\nHot-swap roster preview: ${formatDay(day)} (${cfg.timezone})\n`);
for (const h of hours) {
  const ids = assignments.get(h) || [];
  const free = avail.filter((p) => p.free.has(h)).length;
  console.log(`${hourLabel(h).padStart(6)}  ${(ids.map((i) => name.get(i)).join(', ') || '⚠️  NOBODY').padEnd(40)} (${free} free, want ${headcountFor(cfg, h)})`);
}
console.log(`\nGaps: ${gaps.length ? gaps.map((g) => `${hourLabel(g.hour)} (-${g.missing})`).join(', ') : 'none'}`);
console.log('\nPer person (free hours / calls that day):');
for (const p of avail) console.log(`  ${p.name.padEnd(20)} free ${String(p.free.size).padStart(2)}h  calls ${p.load}${p.error ? `  ERROR ${p.error}` : ''}`);
