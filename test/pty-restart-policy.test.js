const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planPtyServerRestart,
  WINDOW_MS,
  MAX_IN_WINDOW,
  BACKOFF_MS,
} = require('../lib/pty-restart-policy');

test('does not restart during an intentional quit', () => {
  const r = planPtyServerRestart([], { isQuitting: true, signal: null, code: -1, now: 1000 });
  assert.equal(r.restart, false);
  assert.equal(r.giveUp, false);
});

test('does not restart on our own SIGTERM (killPtyServer)', () => {
  const r = planPtyServerRestart([], { isQuitting: false, signal: 'SIGTERM', code: null, now: 1000 });
  assert.equal(r.restart, false);
});

test('does not restart on SIGKILL (escalated kill)', () => {
  const r = planPtyServerRestart([], { isQuitting: false, signal: 'SIGKILL', code: null, now: 1000 });
  assert.equal(r.restart, false);
});

test('restarts on an unexpected native crash (exit -1, no signal)', () => {
  const r = planPtyServerRestart([], { isQuitting: false, signal: null, code: 4294967295, now: 1000 });
  assert.equal(r.restart, true);
  assert.equal(r.giveUp, false);
  assert.equal(r.delayMs, BACKOFF_MS[0]);
  assert.deepEqual(r.timestamps, [1000]);
});

test('restarts on a non-zero JS crash (exit 1)', () => {
  const r = planPtyServerRestart([], { isQuitting: false, signal: null, code: 1, now: 1000 });
  assert.equal(r.restart, true);
});

test('backoff grows with each restart in the window', () => {
  assert.equal(planPtyServerRestart([], { isQuitting: false, signal: null, code: 1, now: 0 }).delayMs, BACKOFF_MS[0]);
  assert.equal(planPtyServerRestart([0], { isQuitting: false, signal: null, code: 1, now: 10 }).delayMs, BACKOFF_MS[1]);
  assert.equal(planPtyServerRestart([0, 10], { isQuitting: false, signal: null, code: 1, now: 20 }).delayMs, BACKOFF_MS[2]);
});

test('backoff clamps at the last schedule entry', () => {
  // The most restarts still allowed before the give-up cap; delay clamps to the
  // final schedule entry rather than running off the end of BACKOFF_MS.
  const prior = [0, 1, 2, 3].slice(0, MAX_IN_WINDOW - 1);
  const r = planPtyServerRestart(prior, { isQuitting: false, signal: null, code: 1, now: 5 });
  assert.equal(r.restart, true);
  assert.equal(r.delayMs, BACKOFF_MS[BACKOFF_MS.length - 1]);
});

test('gives up after MAX_IN_WINDOW restarts inside the window (crash-loop guard)', () => {
  const prior = [];
  for (let i = 0; i < MAX_IN_WINDOW; i++) prior.push(i * 100);
  const r = planPtyServerRestart(prior, { isQuitting: false, signal: null, code: 1, now: MAX_IN_WINDOW * 100 });
  assert.equal(r.restart, false);
  assert.equal(r.giveUp, true);
});

test('prunes restarts older than the window so recovery resumes after calm', () => {
  const prior = [];
  for (let i = 0; i < MAX_IN_WINDOW; i++) prior.push(i * 100); // all old
  const now = MAX_IN_WINDOW * 100 + WINDOW_MS + 1; // everything now outside the window
  const r = planPtyServerRestart(prior, { isQuitting: false, signal: null, code: 1, now });
  assert.equal(r.restart, true);
  assert.equal(r.giveUp, false);
  assert.deepEqual(r.timestamps, [now]);
});

test('quit takes precedence even when the crash-loop cap is hit', () => {
  const prior = [];
  for (let i = 0; i < MAX_IN_WINDOW; i++) prior.push(i * 100);
  const r = planPtyServerRestart(prior, { isQuitting: true, signal: null, code: 1, now: MAX_IN_WINDOW * 100 });
  assert.equal(r.restart, false);
  assert.equal(r.giveUp, false);
});
