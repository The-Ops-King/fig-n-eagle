import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRoster } from '../lib/service.js';
import { loadConfig } from '../lib/config.js';
import { hourStart } from '../lib/time.js';

const cfg = loadConfig('fig-n-eagle');
const team = {
  manager: { name: 'David Hess', slackUserId: 'UDAVID' },
  byId: new Map([['g1', { name: 'Kad A', slackUserId: 'UKAD' }], ['g2', { name: 'Jake', slackUserId: 'UJAKE' }]]),
};

test('plan render: tags people, flags gaps and short hours, tags manager', () => {
  const day = '2026-11-25';
  const byHour = new Map([[8, [{ ghl_user_id: 'g1' }]], [14, [{ ghl_user_id: 'g2' }]]]);
  const { text, blocks } = renderRoster(cfg, team, day, byHour, { phase: 'plan', now: hourStart(day, 0, cfg.timezone) });
  const body = blocks[1].text.text;
  assert.match(text, /^Tomorrow's hot-swap plan/);
  assert.match(body, /\*8 AM\*: <@UKAD>/);
  assert.match(body, /⚠️ \*9 AM\*: nobody free\. <@UDAVID>/);
  assert.match(body, /\*2 PM\*: <@UJAKE>  ⚠️ short 1/);
  assert.equal(blocks[3].elements.length, 3);
});

test('confirm render strikes through hours already over', () => {
  const day = '2026-11-25';
  const { blocks } = renderRoster(cfg, team, day, new Map([[8, [{ ghl_user_id: 'g1' }]]]), { now: hourStart(day, 10, cfg.timezone) });
  assert.match(blocks[1].text.text, /~8 AM: Kad A~/);
});
