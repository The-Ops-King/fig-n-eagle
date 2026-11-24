// Slack interactivity endpoint: buttons, modal submissions, global shortcut.
// Request URL: https://<deployment>/api/slack/interactions
//
// Slack requires a response within 3 seconds, so every handler answers immediately
// and does the slow work (GHL calls, DB) in waitUntil().
import { waitUntil } from '@vercel/functions';
import { verifySlackSignature } from '../../lib/slack.js';
import { baseContext, context } from '../../lib/context.js';
import { dateKey } from '../../lib/time.js';
import * as svc from '../../lib/service.js';
import { loadingView, messageView, requestView, releaseView, volunteerView } from '../../lib/views.js';

const empty = () => new Response(null, { status: 200 });
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

export async function POST(request) {
  const rawBody = await request.text();
  const ok = verifySlackSignature({
    rawBody,
    timestamp: request.headers.get('x-slack-request-timestamp'),
    signature: request.headers.get('x-slack-signature'),
    secret: process.env.SLACK_SIGNING_SECRET,
  });
  if (!ok) return new Response('invalid signature', { status: 401 });

  const payload = JSON.parse(new URLSearchParams(rawBody).get('payload'));
  const base = baseContext();
  const { cfg, slack } = base;
  const user = payload.user?.id;
  const today = dateKey(Date.now(), cfg.timezone);
  const say = (text) => slack.ephemeral(payload.channel?.id || cfg.slack.channelId, user, text);
  const fail = (e) => { console.error(e); return say(`Something went wrong: ${e.message}`).catch(() => {}); };

  // Open a "Loading" modal right away, then fill it in.
  const openModal = async (title, build) => {
    const { view } = await slack.openView(payload.trigger_id, loadingView(title));
    waitUntil(context(base).then(build).then((v) => slack.updateView(view.id, v))
      .catch((e) => { console.error(e); return slack.updateView(view.id, messageView(title, `Something went wrong: ${e.message}`)); }));
    return empty();
  };
  // Runs after Slack has its answer. A result may carry `after`: follow-up work (e.g. the
  // 3-minute unclaimed check) that keeps running in the same invocation.
  const background = (fn) => {
    waitUntil(context(base).then(fn).then(async (r) => {
      if (r?.message) await say(r.message);
      if (r?.after) await r.after();
    }).catch(fail));
  };

  if (payload.type === 'shortcut' && payload.callback_id === 'hot_swap_request') {
    return openModal('Request a hot swap', async (ctx) =>
      requestView(cfg, await svc.handoffCandidates(cfg, { ...ctx, slackUserId: user })));
  }

  if (payload.type === 'block_actions') {
    const action = payload.actions[0];
    const day = /^\d{4}-\d{2}-\d{2}$/.test(action.value || '') ? action.value : today;
    const actionId = action.action_id.startsWith('cover_hour') ? 'cover_hour' : action.action_id;
    switch (actionId) {
      case 'request_open':
        return openModal('Request a hot swap', async (ctx) =>
          requestView(cfg, await svc.handoffCandidates(cfg, { ...ctx, slackUserId: user })));
      case 'release_open':
        return openModal("Can't make my hour", async (ctx) =>
          releaseView(day, await svc.myFutureSlots(cfg, ctx.team, day, user)));
      case 'volunteer_open':
        return openModal('Cover an hour', async () => volunteerView(day, await svc.coverableHours(cfg, day)));
      case 'cover_hour': {
        const [coverDay, coverHour] = String(action.value).split('|');
        background((ctx) => svc.volunteerHour(cfg, { ...ctx, day: coverDay, hour: Number(coverHour), slackUserId: user }));
        return empty();
      }
      case 'claim':
        background((ctx) => svc.claimSwap(cfg, { ...ctx, requestId: action.value, slackUserId: user }));
        return empty();
      default:
        return empty();
    }
  }

  if (payload.type === 'view_submission') {
    const v = payload.view;
    const sel = (block) => v.state.values[block]?.value?.selected_option?.value;
    switch (v.callback_id) {
      case 'request_submit':
        background((ctx) => svc.createSwapRequest(cfg, {
          ...ctx, slackUserId: user,
          appointmentId: sel('appt'),
          reason: v.state.values.reason?.value?.value || null,
        }));
        break;
      case 'release_submit':
        background((ctx) => svc.releaseHour(cfg, { ...ctx, day: v.private_metadata, slotId: sel('slot'), slackUserId: user }));
        break;
      case 'dates_submit': {
        const vals = v.state.values;
        const day = vals.day?.value?.selected_date;
        const scope = vals.scope?.value?.selected_option?.value || 'date';
        const mode = vals.mode?.value?.selected_option?.value;
        const from = vals.from?.value?.selected_option?.value;
        const until = vals.until?.value?.selected_option?.value;
        const errors = {};
        if (!day) errors.day = 'Pick a date.';
        if (mode === 'hours') {
          if (!from) errors.from = 'Pick a start time.';
          if (!until) errors.until = 'Pick an end time.';
          if (from && until && Number(until) <= Number(from)) errors.until = 'End must be after start.';
        }
        if (Object.keys(errors).length) return json({ response_action: 'errors', errors });
        background(async (ctx) => {
          if (ctx.team.manager.slackUserId !== user) return { message: `Only ${ctx.team.manager.name} can change coverage dates.` };
          return svc.setCoverage(cfg, ctx, {
            day, scope, mode, by: user,
            firstHour: mode === 'hours' ? Number(from) : null,
            lastHour: mode === 'hours' ? Number(until) - 1 : null,
          });
        });
        break;
      }
      case 'volunteer_submit':
        background((ctx) => svc.volunteerHour(cfg, { ...ctx, day: v.private_metadata, hour: Number(sel('hour')), slackUserId: user }));
        break;
    }
    return json({ response_action: 'clear' });
  }

  return empty();
}
