// Morning job: plan today's roster, block on-call hours in GHL, post to Slack.
// Safe to re-run: existing assignments are kept and the posted message is edited in place.
import { context } from '../../lib/context.js';
import { dateKey } from '../../lib/time.js';
import { postRoster } from '../../lib/service.js';

export async function GET(request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }
  const ctx = await context();
  const day = new URL(request.url).searchParams.get('day') || dateKey(Date.now(), ctx.cfg.timezone);
  const r = await postRoster(ctx.cfg, { ...ctx, day });
  return Response.json({ day, hours: r.hours.length, gaps: r.gaps, errors: r.errors });
}
