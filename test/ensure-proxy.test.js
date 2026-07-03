'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeProxyEnsurer } = require('../lib/ensure-proxy');

// A probeHealth built from a scripted sequence of boolean results. The last
// value repeats once the sequence is exhausted.
function scriptedProbe(seq) {
  let i = 0;
  return async function probeHealth() {
    const v = seq[Math.min(i, seq.length - 1)];
    i += 1;
    return v;
  };
}

test('healthy proxy -> reuse, startProxy never called', async () => {
  let starts = 0;
  const ensure = makeProxyEnsurer({
    probeHealth: scriptedProbe([true]),
    startProxy: async () => { starts += 1; },
    sleep: async () => {},
    timeoutMs: 1000,
    intervalMs: 100,
  });
  const res = await ensure();
  assert.deepStrictEqual(res, { ok: true, started: false });
  assert.strictEqual(starts, 0);
});

test('cold start then ready -> startProxy once, ok+started', async () => {
  let starts = 0;
  let healthy = false;
  const ensure = makeProxyEnsurer({
    probeHealth: async () => healthy,
    startProxy: async () => { starts += 1; healthy = true; },
    sleep: async () => {},
    timeoutMs: 1000,
    intervalMs: 100,
  });
  const res = await ensure();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.started, true);
  assert.strictEqual(starts, 1);
});

test('concurrent ensure() calls share one in-flight promise, startProxy once', async () => {
  let starts = 0;
  let healthy = false;
  const ensure = makeProxyEnsurer({
    probeHealth: async () => healthy,
    startProxy: async () => { starts += 1; healthy = true; },
    sleep: async () => {},
    timeoutMs: 1000,
    intervalMs: 100,
  });
  const [a, b, c] = await Promise.all([ensure(), ensure(), ensure()]);
  assert.strictEqual(starts, 1);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(c.ok, true);
});

test('never becomes ready -> ok:false, started:true, error', async () => {
  let starts = 0;
  const ensure = makeProxyEnsurer({
    probeHealth: async () => false,
    startProxy: async () => { starts += 1; },
    sleep: async () => {},
    timeoutMs: 300,
    intervalMs: 100,
  });
  const res = await ensure();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.started, true);
  assert.ok(res.error instanceof Error);
  assert.strictEqual(starts, 1);
});

test('a fresh ensure() after in-flight settles can start again', async () => {
  let starts = 0;
  let healthy = false;
  const ensure = makeProxyEnsurer({
    probeHealth: async () => healthy,
    startProxy: async () => { starts += 1; healthy = true; },
    sleep: async () => {},
    timeoutMs: 1000,
    intervalMs: 100,
  });
  await ensure();            // cold-start -> healthy
  healthy = false;           // proxy died again
  const res = await ensure(); // must be allowed to start once more
  assert.strictEqual(res.ok, true);
  assert.strictEqual(starts, 2);
});
