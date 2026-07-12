'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  planHeadroomWatchdog,
  FAILURE_THRESHOLD,
  MAX_RESTARTS_IN_WINDOW,
  WINDOW_MS,
  BACKOFF_MS,
} = require('../lib/headroom-watchdog');

const S = (over) => Object.assign({ consecutiveFailures: 0, restartTimestamps: [] }, over || {});
// evt defaults to the "we own a live proxy the user wants" case; override per test.
const E = (over) => Object.assign({ enabled: true, installed: true, managed: true, healthy: false, now: 1000 }, over || {});

test('disabled -> idle and clears any accrued failures', () => {
  const r = planHeadroomWatchdog(S({ consecutiveFailures: 2 }), E({ enabled: false }));
  assert.strictEqual(r.action, 'idle');
  assert.strictEqual(r.consecutiveFailures, 0);
});

test('not installed -> idle (nothing to supervise)', () => {
  const r = planHeadroomWatchdog(S({ consecutiveFailures: 5 }), E({ installed: false }));
  assert.strictEqual(r.action, 'idle');
  assert.strictEqual(r.consecutiveFailures, 0);
});

test('not app-managed (manually stopped / external / no child) -> idle, never restart', () => {
  // Even at the failure threshold, an unmanaged proxy must be left alone.
  const r = planHeadroomWatchdog(S({ consecutiveFailures: FAILURE_THRESHOLD - 1 }), E({ managed: false }));
  assert.strictEqual(r.action, 'idle');
  assert.strictEqual(r.consecutiveFailures, 0);
});

test('healthy probe -> idle and resets the failure streak', () => {
  const r = planHeadroomWatchdog(S({ consecutiveFailures: 2 }), E({ healthy: true }));
  assert.strictEqual(r.action, 'idle');
  assert.strictEqual(r.consecutiveFailures, 0);
});

test('first unhealthy probe -> watch, not restart (tolerate a transient blip)', () => {
  const r = planHeadroomWatchdog(S(), E());
  assert.strictEqual(r.action, 'watch');
  assert.strictEqual(r.consecutiveFailures, 1);
  assert.deepStrictEqual(r.restartTimestamps, []);
});

test('below threshold stays watching', () => {
  let s = S();
  for (let i = 1; i < FAILURE_THRESHOLD; i++) {
    const r = planHeadroomWatchdog(s, E({ now: 1000 + i }));
    assert.strictEqual(r.action, 'watch');
    assert.strictEqual(r.consecutiveFailures, i);
    s = r;
  }
});

test('reaching the threshold triggers a restart, resets the streak, records a timestamp', () => {
  let s = S();
  let r;
  for (let i = 1; i <= FAILURE_THRESHOLD; i++) {
    r = planHeadroomWatchdog(s, E({ now: 5000 + i }));
    s = r;
  }
  assert.strictEqual(r.action, 'restart');
  assert.strictEqual(r.consecutiveFailures, 0);
  assert.strictEqual(r.restartTimestamps.length, 1);
  assert.strictEqual(r.delayMs, BACKOFF_MS[0]);
});

test('a healthy probe after failures clears the streak so it must re-accrue', () => {
  let s = S({ consecutiveFailures: FAILURE_THRESHOLD - 1 });
  s = planHeadroomWatchdog(s, E({ healthy: true, now: 2000 }));
  assert.strictEqual(s.consecutiveFailures, 0);
  const r = planHeadroomWatchdog(s, E({ now: 2001 }));
  assert.strictEqual(r.action, 'watch');
});

test('crash-loop guard: gives up after MAX_RESTARTS_IN_WINDOW restarts in the window', () => {
  const now = 100000;
  const prior = [];
  for (let k = 0; k < MAX_RESTARTS_IN_WINDOW; k++) prior.push(now - k * 100);
  const r = planHeadroomWatchdog(S({ consecutiveFailures: FAILURE_THRESHOLD - 1, restartTimestamps: prior }), E({ now }));
  assert.strictEqual(r.action, 'giveUp');
  assert.strictEqual(r.restartTimestamps.length, MAX_RESTARTS_IN_WINDOW);
});

test('restarts older than the window are pruned and do not count toward the cap', () => {
  const now = 1000000;
  const stale = [now - WINDOW_MS - 1, now - WINDOW_MS - 500];
  const r = planHeadroomWatchdog(S({ consecutiveFailures: FAILURE_THRESHOLD - 1, restartTimestamps: stale }), E({ now }));
  assert.strictEqual(r.action, 'restart');
  assert.strictEqual(r.restartTimestamps.length, 1); // stale dropped, this restart added
});

test('backoff grows with the number of recent restarts', () => {
  const now = 200000;
  const one = planHeadroomWatchdog(S({ consecutiveFailures: FAILURE_THRESHOLD - 1, restartTimestamps: [now - 10] }), E({ now }));
  assert.strictEqual(one.action, 'restart');
  assert.strictEqual(one.delayMs, BACKOFF_MS[Math.min(1, BACKOFF_MS.length - 1)]);
});
