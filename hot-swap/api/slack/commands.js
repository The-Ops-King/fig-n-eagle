// Slash command.
//   /hotswap          open the request modal (anyone)
//   /hotswap today      build/refresh TODAY's roster now (manager only; alias: roster)
//   /hotswap tomorrow   build/refresh TOMORROW's plan now (manager only; alias: plan)
//   /hotswap add @name | remove @name   change the pool (manager only)
//   /hotswap pool       list who's in the pool
//   /hotswap help       explain commands and buttons
// Request URL: https://<deployment>/api/slack/commands
import { waitUntil } from '@vercel/functions';
import { verifySlackSignature } from '../../lib/slack.js';
import { baseContext, context, resetTeamCache } from '../../lib/context.js';
import { dateKey, nextDateKey, formatDay } from '../../lib/time.js';
import * as svc from '../../lib/service.js';
import { loadingView, messageView, requestView } from '../../lib/views.js';

const HELP = [
  '*Hot Swap: who takes a closer\'s call when they can\'t.*',
  '',
  '*Everyone*',
  '• `/hotswap`: hand off one of your upcoming calls. Whoever is on call that hour gets tagged; first to click *I\'ve got it* takes it and the appointment is reassigned to them in GHL. Unclaimed after 3 min, it goes to everyone.',
  '• `/hotswap pool`: see who\'s in the hot-swap pool.',
  '• `/hotswap help`: this message.',
  '',
  '*Roster buttons*',
  '• *Request a hot swap*: same as `/hotswap`.',
  '• *Can\'t make my hour*: frees one of your on-call hours. It shows NOT COVERED and the free people get an *I\'ll cover* button.',
  '• *Cover an hour*: take an hour that still needs someone (including the one happening now).',
  '',
  '*Manager*',
  '• `/hotswap today` / `/hotswap tomorrow`: build or refresh the roster now (fills open hours, keeps existing assignments).',
  '• `/hotswap add @name` / `/hotswap remove @name`: add someone to the pool (e.g. a setter) or take them out (frees their hours).',
  '',
  '_Schedule: tomorrow\'s plan posts at 6 PM ET, today\'s roster at 7 AM ET. On-call hours appear on your GHL and Google calendar as "(Name) Hot Swap On-Call"._',
].join('\n');

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
    const unknown = sub === 'help' ? '' : `I don't know \`/hotswap ${raw}\`. `;
    return ephemeral(unknown + HELP);
  }

  const title = 'Request a hot swap';
  const { view } = await base.slack.openView(form.get('trigger_id'), loadingView(title));
  waitUntil(context(base)
    .then((ctx) => svc.handoffCandidates(base.cfg, { ...ctx, slackUserId: user }))
    .then((appts) => base.slack.updateView(view.id, requestView(base.cfg, appts)))
    .catch((e) => { console.error(e); return base.slack.updateView(view.id, messageView(title, `Something went wrong: ${e.message}`)); }));
  return new Response(null, { status: 200 });
}
