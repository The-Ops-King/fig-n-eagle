// Slash command.
//   /hotswap          open the request modal (anyone)
//   /hotswap today      build/refresh TODAY's roster now (manager only; alias: roster)
//   /hotswap tomorrow   build/refresh TOMORROW's plan now (manager only; alias: plan)
//   /hotswap add @name | remove @name   change the pool (manager only)
//   /hotswap pool       list who's in the pool
// Request URL: https://<deployment>/api/slack/commands
import { waitUntil } from '@vercel/functions';
import { verifySlackSignature } from '../../lib/slack.js';
import { baseContext, context, resetTeamCache } from '../../lib/context.js';
import { dateKey, nextDateKey, formatDay } from '../../lib/time.js';
import * as svc from '../../lib/service.js';
import { loadingView, messageView, requestView } from '../../lib/views.js';

const ephemeral = (text) => new Response(JSON.stringify({ response_type: 'ephemeral', text }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

// Follow-up message to the person who ran the command (works in any channel).
const followUp = (responseUrl, text) => fetch(responseUrl, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ response_type: 'ephemeral', text }),
});

export async function POST(request) {
  const rawBody = await request.text();
  const ok = verifySlackSignature({
    rawBody,
    timestamp: request.headers.get('x-slack-request-timestamp'),
    signature: request.headers.get('x-slack-signature'),
    secret: process.env.SLACK_SIGNING_SECRET,
  });
  if (!ok) return new Response('invalid signature', { status: 401 });

  const form = new URLSearchParams(rawBody);
  const text = (form.get('text') || '').trim();
  const raw = text.split(/\s+/)[0].toLowerCase();
  const sub = { roster: 'today', plan: 'tomorrow' }[raw] || raw;
  const user = form.get('user_id');
  const base = baseContext();

  if (sub === 'today' || sub === 'tomorrow') {
    const today = dateKey(Date.now(), base.cfg.timezone);
    const day = sub === 'tomorrow' ? nextDateKey(today) : today;
    const phase = sub === 'tomorrow' ? 'plan' : 'confirm';
    const responseUrl = form.get('response_url');
    waitUntil(context(base).then(async (ctx) => {
      if (ctx.team.manager.slackUserId !== user) {
        return followUp(responseUrl, `Only ${ctx.team.manager.name} can run \`/hotswap ${sub}\`.`);
      }
      const r = await svc.publishRoster(base.cfg, { ...ctx, day, phase, fresh: false });
      const gaps = r.gaps.length ? `${r.gaps.length} hour(s) still need cover.` : 'Every hour is covered.';
      const errs = r.errors.length ? `\nProblems: ${r.errors.join('; ')}` : '';
      return followUp(responseUrl, `Updated the ${phase === 'plan' ? 'plan' : 'roster'} for ${formatDay(day)}. ${gaps}${errs}`);
    }).catch((e) => { console.error(e); return followUp(responseUrl, `Something went wrong: ${e.message}`); }));
    return ephemeral(`Building ${sub === 'tomorrow' ? "tomorrow's plan" : "today's roster"}…`);
  }

  if (sub === 'add' || sub === 'remove' || sub === 'pool') {
    const responseUrl = form.get('response_url');
    // Needs "Escape channels, users, and links" on the slash command so @name arrives as <@U123|name>.
    const target = text.match(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/)?.[1];
    waitUntil(context(base).then(async (ctx) => {
      if (sub === 'pool') return followUp(responseUrl, svc.describePool(ctx.team));
      if (ctx.team.manager.slackUserId !== user) return followUp(responseUrl, `Only ${ctx.team.manager.name} can change the pool.`);
      if (!target) return followUp(responseUrl, `Usage: \`/hotswap ${sub} @name\` (pick the person from the @ menu).`);
      const r = sub === 'add'
        ? await svc.addToPool(base.cfg, ctx, { slackUserId: target, by: user })
        : await svc.removeFromPool(base.cfg, ctx, { slackUserId: target, by: user });
      resetTeamCache();
      return followUp(responseUrl, r.message);
    }).catch((e) => { console.error(e); return followUp(responseUrl, `Something went wrong: ${e.message}`); }));
    return ephemeral('Working on it…');
  }

  if (sub && sub !== 'request') {
    return ephemeral('Usage: `/hotswap` request a hot swap · `/hotswap pool` see who is in the pool. Managers: `/hotswap today`, `/hotswap tomorrow`, `/hotswap add @name`, `/hotswap remove @name`.');
  }

  const title = 'Request a hot swap';
  const { view } = await base.slack.openView(form.get('trigger_id'), loadingView(title));
  waitUntil(context(base)
    .then((ctx) => svc.handoffCandidates(base.cfg, { ...ctx, slackUserId: user }))
    .then((appts) => base.slack.updateView(view.id, requestView(base.cfg, appts)))
    .catch((e) => { console.error(e); return base.slack.updateView(view.id, messageView(title, `Something went wrong: ${e.message}`)); }));
  return new Response(null, { status: 200 });
}
