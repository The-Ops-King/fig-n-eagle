// Evening job: DM the manager tomorrow's coverage gaps. Writes nothing.
import { context } from '../../lib/context.js';
import { previewTomorrow } from '../../lib/service.js';

export async function GET(request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }
  const ctx = await context();
  const r = await previewTomorrow(ctx.cfg, ctx);
  return Response.json({ day: r.day, gaps: r.gaps, errors: r.errors });
}
