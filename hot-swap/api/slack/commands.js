// Slash command.
//   /hotswap          open the request modal (anyone)
//   /hotswap roster   build/refresh TODAY's roster now (manager only)
//   /hotswap plan     build TOMORROW's plan now (manager only)
// Request URL: https://<deployment>/api/slack/commands
import { waitUntil } from '@vercel/functions';
import { verifySlackSignature } from '../../lib/slack.js';
import { baseContext, context } from '../../lib/context.js';
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
  const sub = (form.get('text') || '').trim().toLowerCase();
  const user = form.get('user_id');
  const base = baseContext();

  if (sub === 'roster' || sub === 'plan') {
    const today = dateKey(Date.now(), base.cfg.timezone);
    const day = sub === 'plan' ? nextDateKey(today) : today;
    const phase = sub === 'plan' ? 'plan' : 'confirm';
    const responseUrl = form.get('response_url');
    waitUntil(context(base).then(async (ctx) => {
      if (ctx.team.manager.slackUserId !== user) {
        return followUp(responseUrl, `Only ${ctx.team.manager.name} can run \`/hotswap ${sub}\`.`);
      }
      const r = await svc.publishRoster(base.cfg, { ...ctx, day, phase });
      const gaps = r.gaps.length ? `${r.gaps.length} hour(s) still need cover.` : 'Every hour is covered.';
      const errs = r.errors.length ? `\nProblems: ${r.errors.join('; ')}` : '';
      return followUp(responseUrl, `Posted the ${phase === 'plan' ? 'plan' : 'roster'} for ${formatDay(day)}. ${gaps}${errs}`);
    }).catch((e) => { console.error(e); return followUp(responseUrl, `Something went wrong: ${e.message}`); }));
    return ephemeral(`Building the ${sub === 'plan' ? "plan for tomorrow" : "roster for today"}…`);
  }

  if (sub && sub !== 'request') {
    return ephemeral('Usage: `/hotswap` to request a hot swap. Managers: `/hotswap roster` (today) or `/hotswap plan` (tomorrow).');
  }

  const title = 'Request a hot swap';
  const { view } = await base.slack.openView(form.get('trigger_id'), loadingView(title));
  waitUntil(context(base)
    .then((ctx) => svc.handoffCandidates(base.cfg, { ...ctx, slackUserId: user }))
    .then((appts) => base.slack.updateView(view.id, requestView(base.cfg, appts)))
    .catch((e) => { console.error(e); return base.slack.updateView(view.id, messageView(title, `Something went wrong: ${e.message}`)); }));
  return new Response(null, { status: 200 });
}
