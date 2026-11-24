import { createHmac, timingSafeEqual } from 'node:crypto';

// Verify a Slack request signature. `rawBody` must be the exact request body string.
export function verifySlackSignature({ rawBody, timestamp, signature, secret, now = Date.now() }) {
  if (!secret || !timestamp || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 60 * 5) return false; // replay window
  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function slackClient({ token = process.env.SLACK_BOT_TOKEN, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('Missing env SLACK_BOT_TOKEN');
  const emailCache = new Map();

  async function api(method, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 3) {
        const wait = Number(res.headers.get('retry-after') || 1);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const json = await res.json();
      if (!json.ok) {
        const err = new Error(`Slack ${method}: ${json.error}`);
        err.slackError = json.error;
        throw err;
      }
      return json;
    }
  }

  return {
    api,
    post: (channel, text, blocks, extra = {}) => api('chat.postMessage', { channel, text, blocks, unfurl_links: false, ...extra }),
    update: (channel, ts, text, blocks) => api('chat.update', { channel, ts, text, blocks }),
    schedule: (channel, postAtSec, text, blocks, extra = {}) =>
      api('chat.scheduleMessage', { channel, post_at: postAtSec, text, blocks, ...extra }),
    unschedule: (channel, id) => api('chat.deleteScheduledMessage', { channel, scheduled_message_id: id }),
    async scheduledIn(channel) {
      const { scheduled_messages = [] } = await api('chat.scheduledMessages.list', { channel, limit: 100 });
      return scheduled_messages;
    },
    remove: (channel, ts) => api('chat.delete', { channel, ts }),
    ephemeral: (channel, user, text, blocks) => api('chat.postEphemeral', { channel, user, text, ...(blocks ? { blocks } : {}) }),
    dm: async (userId, text, blocks) => {
      const { channel } = await api('conversations.open', { users: userId });
      return api('chat.postMessage', { channel: channel.id, text, blocks });
    },
    openView: (triggerId, view) => api('views.open', { trigger_id: triggerId, view }),
    updateView: (viewId, view) => api('views.update', { view_id: viewId, view }),
    async userIdByEmail(email) {
      if (!email) return null;
      const key = email.toLowerCase();
      if (!emailCache.has(key)) {
        try {
          const { user } = await api('users.lookupByEmail', { email: key });
          emailCache.set(key, user.id);
        } catch (e) {
          if (e.slackError !== 'users_not_found') throw e;
          emailCache.set(key, null);
        }
      }
      return emailCache.get(key);
    },
    async emailByUserId(userId) {
      const { user } = await api('users.info', { user: userId });
      return user?.profile?.email?.toLowerCase() || null;
    },
  };
}

export const mention = (slackUserId, fallbackName) => (slackUserId ? `<@${slackUserId}>` : `*${fallbackName}*`);
