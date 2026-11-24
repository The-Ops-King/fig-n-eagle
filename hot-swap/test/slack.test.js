import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from '../lib/slack.js';

const secret = 'shh';
const sign = (ts, body) => 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');

test('accepts a valid signature', () => {
  const ts = '1700000000';
  assert.ok(verifySlackSignature({ rawBody: 'a=1', timestamp: ts, signature: sign(ts, 'a=1'), secret, now: 1700000000_000 }));
});

test('rejects tampered body, wrong secret, and old timestamps', () => {
  const ts = '1700000000';
  assert.ok(!verifySlackSignature({ rawBody: 'a=2', timestamp: ts, signature: sign(ts, 'a=1'), secret, now: 1700000000_000 }));
  assert.ok(!verifySlackSignature({ rawBody: 'a=1', timestamp: ts, signature: sign(ts, 'a=1'), secret: 'nope', now: 1700000000_000 }));
  assert.ok(!verifySlackSignature({ rawBody: 'a=1', timestamp: ts, signature: sign(ts, 'a=1'), secret, now: 1700000000_000 + 10 * 60_000 }));
});
