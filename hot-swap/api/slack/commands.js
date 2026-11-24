// Slash command.
//   /hotswap          open the request modal (anyone)
//   /hotswap today      build/refresh TODAY's roster now (manager only; alias: roster)
//   /hotswap tomorrow   build/refresh TOMORROW's plan now (manager only; alias: plan)
//   /hotswap add @name | remove @name   change the pool (manager only)
//   /hotswap pool       list who's in the pool
//   /hotswap dates      coverage exceptions by date / weekday (manager only)
//   /hotswap insights [days]   coverage + swap stats (manager only)
//   /hotswap assign @name 3pm [tomorrow]   manager puts someone on call
//   /hotswap help       explain commands and buttons
// Request URL: https://<deployment>/api/slack/commands
import { waitUntil } from '@vercel/functions';
import { verifySlackSignature } from '../../lib/slack.js';
import { baseContext, context, resetTeamCache } from '../../lib/context.js';
import { dateKey, nextDateKey, formatDay } from '../../lib/time.js';
import * as svc from '../../lib/service.js';
import { loadingView, messageView, requestView, datesView } from '../../lib/views.js';

const HELP = [
  '*Hot Swap: who takes a closer\'s call when they can\'t.*',
  '',
  '*Everyone*',
  '• `/hotswap`: hand off one of your upcoming calls. Whoever is on call that hour gets tagged; first to click *I\'ve got it* takes it, and the deal + contact owner move to them in GHL (with a note). Unclaimed after 3 min, it goes to everyone.',
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
  '• `/hotswap insights` (or `/hotswap insights 30`): coverage, swap and claim stats for the last 7 (or N) days.',
  '• `/hotswap assign @name 3pm` (add `tomorrow` for tomorrow): put someone on call for an hour. On a hot-swap request, use *Manager: assign to…* to give the call to someone.',
  '• `/hotswap dates`: turn coverage off or change the hours for a date (holidays) or every week on a weekday (weekends).',
  '',
  '_Schedule: tomorrow\'s plan posts at 6 PM ET, today\'s roster at 7 AM ET. On-call hours appear on your GHL and Google calendar as "(Name) Hot Swap On-Call"._',
].join('\n');

// "3pm", "3 pm", "15", "3:00pm", "9am". Bare 1-7 means PM, 8-11 AM, 12 noon.
function parseHour(str) {
  const m = String(str).match(/\b(\d{1,2})(?::00)?\s*(am|pm)?\b/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = m[2]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  else if (ap === 'am' && h === 12) h = 0;
  else if (!ap && h >= 1 && h <= 7) h += 12;
  return h >= 0 && h <= 23 ? h : null;
}

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

  if (sub === 'dates') {
    const title = 'Hot-swap coverage';
    const { view } = await base.slack.openView(form.get('trigger_id'), loadingView(title));
    waitUntil(context(base).then(async (ctx) => {
      if (ctx.team.manager.slackUserId !== user) {
        return base.slack.updateView(view.id, messageView(title, `Only ${ctx.team.manager.name} can change coverage dates.`));
      }
      const tomorrow = nextDateKey(dateKey(Date.now(), base.cfg.timezone));
      return base.slack.updateView(view.id, datesView(await svc.upcomingCoverage(base.cfg), tomorrow));
    }).catch((e) => { console.error(e); return base.slack.updateView(view.id, messageView(title, `Something went wrong: ${e.message}`)); }));
    return new Response(null, { status: 200 });
  }

  if (sub === 'reset') {
    const responseUrl = form.get('response_url');
    const confirmed = text.split(/\s+/)[1]?.toLowerCase() === 'confirm';
    waitUntil(context(base).then(async (ctx) => {
      if (ctx.team.manager.slackUserId !== user) return followUp(responseUrl, `Only ${ctx.team.manager.name} can reset.`);
      if (!svc.isTestClient(base.cfg)) return followUp(responseUrl, `Reset only works on the test setup. This is the live setup (${base.cfg.client}), so nothing was touched.`);
      if (!confirmed) {
        return followUp(responseUrl, [
          '*This wipes the test setup:*',
          '• Deletes all test on-call appointments and every appointment on the two test calendars (past 14 days to next 14 days). A/B and closer calendars are never touched.',
          '• Deletes the app\'s messages in this channel and any pending "unclaimed" alerts.',
          '• Clears rosters, requests and logged activity. Your `/hotswap dates` rules and pool changes are kept.',
          'Type `/hotswap reset confirm` to go ahead.',
        ].join('\n'));
      }
      const r = await svc.resetTestData(base.cfg, ctx);
      return followUp(responseUrl, `Reset done: ${r.appts} appointment(s) and ${r.msgs} message(s) removed, activity cleared.${r.errors.length ? `\nProblems: ${r.errors.slice(0, 5).join('; ')}` : ''}\nRun \`/hotswap today\` to start fresh.`);
    }).catch((e) => { console.error(e); return followUp(responseUrl, `Something went wrong: ${e.message}`); }));
    return ephemeral(confirmed ? 'Resetting the test setup…' : 'Checking…');
  }

  if (sub === 'insights') {
    const responseUrl = form.get('response_url');
    const days = Math.min(Math.max(parseInt(text.split(/\s+/)[1], 10) || 7, 1), 90);
    waitUntil(context(base).then(async (ctx) => {
      if (ctx.team.manager.slackUserId !== user) return followUp(responseUrl, `Only ${ctx.team.manager.name} can see insights.`);
      return followUp(responseUrl, await svc.insights(base.cfg, ctx.team, days));
    }).catch((e) => { console.error(e); return followUp(responseUrl, `Something went wrong: ${e.message}`); }));
    return ephemeral('Crunching the numbers…');
  }

  if (sub === 'assign') {
    const responseUrl = form.get('response_url');
    const target = text.match(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/)?.[1];
    const hour = parseHour(text.replace(/<@[^>]+>/g, ''));
    const tomorrowWanted = /\btomorrow\b/i.test(text);
    waitUntil(context(base).then(async (ctx) => {
      if (ctx.team.manager.slackUserId !== user) return followUp(responseUrl, `Only ${ctx.team.manager.name} can assign hours.`);
      if (!target || hour == null) return followUp(responseUrl, 'Usage: `/hotswap assign @name 3pm` (add `tomorrow` for tomorrow).');
      const today = dateKey(Date.now(), base.cfg.timezone);
      const day = tomorrowWanted ? nextDateKey(today) : today;
      const r = await svc.assignHourTo(base.cfg, ctx, { day, hour, slackUserId: target, by: user });
      return followUp(responseUrl, r.message);
    }).catch((e) => { console.error(e); return followUp(responseUrl, `Something went wrong: ${e.message}`); }));
    return ephemeral('Assigning…');
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
