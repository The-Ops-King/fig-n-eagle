import { loadConfig } from './config.js';
import { ghlClient } from './ghl.js';
import { slackClient } from './slack.js';
import { resolvePeople } from './service.js';

const TEAM_TTL_MS = 10 * 60_000;
let teamCache = null; // survives across warm invocations

// Cheap, synchronous pieces: safe to build before answering Slack's 3-second deadline.
export function baseContext() {
  const cfg = loadConfig();
  if (!cfg.slack.channelId) throw new Error(`Config ${cfg.client}: slack.channelId is empty`);
  return { cfg, ghl: ghlClient(cfg), slack: slackClient() };
}

// Full context including the Slack <-> GHL people mapping (needs Slack API calls).
export async function context(base = baseContext()) {
  if (!teamCache || teamCache.client !== base.cfg.client || Date.now() - teamCache.at > TEAM_TTL_MS) {
    teamCache = { client: base.cfg.client, at: Date.now(), team: await resolvePeople(base.cfg, base.slack) };
  }
  return { ...base, team: teamCache.team };
}
