import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

// Every route must load: catches missing exports/imports that unit tests don't touch.
const routes = ['api/slack', 'api/cron'].flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => `../${d}/${f}`));

for (const r of routes) {
  test(`route loads: ${r}`, async () => {
    const m = await import(r);
    assert.ok(typeof m.GET === 'function' || typeof m.POST === 'function', `${r} exports a handler`);
  });
}
