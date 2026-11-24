// Slash command: /hotswap opens the request modal.
// Request URL: https://<deployment>/api/slack/commands
import { waitUntil } from '@vercel/functions';
import { verifySlackSignature } from '../../lib/slack.js';
import { baseContext, context } from '../../lib/context.js';
import * as svc from '../../lib/service.js';
import { loadingView, messageView, requestView } from '../../lib/views.js';

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
  const base = baseContext();
  const title = 'Request a hot swap';
  const { view } = await base.slack.openView(form.get('trigger_id'), loadingView(title));
  waitUntil(context(base)
    .then((ctx) => svc.handoffCandidates(base.cfg, { ...ctx, slackUserId: form.get('user_id') }))
    .then((appts) => base.slack.updateView(view.id, requestView(base.cfg, appts)))
    .catch((e) => { console.error(e); return base.slack.updateView(view.id, messageView(title, `Something went wrong: ${e.message}`)); }));
  return new Response(null, { status: 200 });
}
