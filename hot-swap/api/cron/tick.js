// Runs hourly (vercel.json). Acts only at the configured local hours, so it stays correct
// across daylight-saving changes and each client can pick its own times:
//   schedule.planHour    (default 18): plan TOMORROW, block hours in GHL, post plan, DM manager
//   schedule.confirmHour (default 7):  re-check TODAY, fill new openings, post today's roster
//
// Manual run (testing):  GET /api/cron/tick?phase=plan|confirm[&day=YYYY-MM-DD]
//   with header  Authorization: Bearer $CRON_SECRET
import { context } from '../../lib/context.js';
import { dateKey, nextDateKey, parts } from '../../lib/time.js';
import { publishRoster } from '../../lib/service.js';

export async function GET(request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }
  const ctx = await context();
  const { cfg } = ctx;
  const url = new URL(request.url);
  const now = Date.now();
  const today = dateKey(now, cfg.timezone);
  const localHour = parts(now, cfg.timezone).hour;
  const planHour = cfg.schedule?.planHour ?? 18;
  const confirmHour = cfg.schedule?.confirmHour ?? 7;

  let phase = url.searchParams.get('phase');
  if (!phase) phase = localHour === planHour ? 'plan' : localHour === confirmHour ? 'confirm' : null;
  if (!phase) return Response.json({ skipped: true, localHour });
  if (!['plan', 'confirm'].includes(phase)) return new Response('bad phase', { status: 400 });

  const day = url.searchParams.get('day') || (phase === 'plan' ? nextDateKey(today) : today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Response('bad day', { status: 400 });
  const r = await publishRoster(cfg, { ...ctx, day, phase });
  return Response.json({ phase, day, hours: r.hours.length, gaps: r.gaps, errors: r.errors });
}
