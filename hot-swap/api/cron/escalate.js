// Runs every minute (vercel.json): escalates hot-swap requests that are still unclaimed.
import { context } from '../../lib/context.js';
import { escalateRequests } from '../../lib/service.js';

export async function GET(request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }
  const ctx = await context();
  const n = await escalateRequests(ctx.cfg, ctx);
  return Response.json({ escalated: n });
}
