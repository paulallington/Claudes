'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeSlot,
  parseCodexRateLimits,
  pickLatestRolloutPath,
  mergeCodexReadings
} = require('../lib/codex-limits');

// A real token_count line as Codex writes it (trimmed to the fields we read).
const TOKEN_COUNT_LINE = JSON.stringify({
  timestamp: '2026-07-12T14:36:43.755Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { total_tokens: 60225 }, model_context_window: 353400 },
    rate_limits: {
      limit_id: 'codex',
      primary: { used_percent: 27, window_minutes: 300, resets_at: 1783876257 },
      secondary: { used_percent: 4, window_minutes: 10080, resets_at: 1784463057 },
      plan_type: 'prolite'
    }
  }
});

test('normalizeSlot: percent + unix-seconds resets_at -> ISO', () => {
  const slot = normalizeSlot({ used_percent: 27, window_minutes: 300, resets_at: 1783876257 });
  assert.strictEqual(slot.utilization, 27);
  assert.strictEqual(slot.window_minutes, 300);
  assert.strictEqual(slot.resets_at, new Date(1783876257 * 1000).toISOString());
});

test('normalizeSlot: null/percent-less slot -> null', () => {
  assert.strictEqual(normalizeSlot(null), null);
  assert.strictEqual(normalizeSlot({ window_minutes: 300 }), null);
});

test('normalizeSlot: missing resets_at stays null (not epoch)', () => {
  assert.strictEqual(normalizeSlot({ used_percent: 5 }).resets_at, null);
  assert.strictEqual(normalizeSlot({ used_percent: 5, resets_at: 0 }).resets_at, null);
});

test('parseCodexRateLimits: reads primary->five_hour, secondary->seven_day', () => {
  const out = parseCodexRateLimits(TOKEN_COUNT_LINE);
  assert.ok(out);
  assert.strictEqual(out.five_hour.utilization, 27);
  assert.strictEqual(out.seven_day.utilization, 4);
  assert.strictEqual(out.five_hour.window_minutes, 300);
  assert.strictEqual(out.seven_day.window_minutes, 10080);
});

test('parseCodexRateLimits: returns the LAST rate-limit event in the file', () => {
  const older = TOKEN_COUNT_LINE;
  const newer = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: 55, window_minutes: 300, resets_at: 1783876257 },
      secondary: { used_percent: 61, window_minutes: 10080, resets_at: 1784463057 }
    } }
  });
  const out = parseCodexRateLimits(older + '\n' + newer + '\n');
  assert.strictEqual(out.five_hour.utilization, 55);
  assert.strictEqual(out.seven_day.utilization, 61);
});

test('parseCodexRateLimits: skips malformed/partial trailing lines', () => {
  const out = parseCodexRateLimits(TOKEN_COUNT_LINE + '\n{"payload":{"type":"token_count","rate_l');
  assert.ok(out);
  assert.strictEqual(out.five_hour.utilization, 27);
});

test('parseCodexRateLimits: no rate-limit events -> null', () => {
  assert.strictEqual(parseCodexRateLimits('{"type":"event_msg","payload":{"type":"agent_message"}}'), null);
  assert.strictEqual(parseCodexRateLimits(''), null);
  assert.strictEqual(parseCodexRateLimits(null), null);
});

test('pickLatestRolloutPath: returns highest mtimeMs', () => {
  const path = pickLatestRolloutPath([
    { path: '/a.jsonl', mtimeMs: 100 },
    { path: '/b.jsonl', mtimeMs: 300 },
    { path: '/c.jsonl', mtimeMs: 200 }
  ]);
  assert.strictEqual(path, '/b.jsonl');
});

test('pickLatestRolloutPath: empty/invalid -> null', () => {
  assert.strictEqual(pickLatestRolloutPath([]), null);
  assert.strictEqual(pickLatestRolloutPath(null), null);
});

// A real placeholder line: a fresh Codex session hasn't received real
// rate-limit headers yet, so the weekly (10080min) window sits in the
// `primary` slot with `secondary:null`.
const PLACEHOLDER_LINE = JSON.stringify({
  timestamp: '2026-07-12T19:20:45.240Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    rate_limits: {
      limit_id: 'codex',
      primary: { used_percent: 0, window_minutes: 10080, resets_at: 1784488704 },
      secondary: null,
      plan_type: 'prolite'
    }
  }
});

test('parseCodexRateLimits: classifies by window_minutes, not position (placeholder)', () => {
  const out = parseCodexRateLimits(PLACEHOLDER_LINE);
  assert.deepStrictEqual(out.five_hour, null);
  assert.strictEqual(out.seven_day.utilization, 0);
  assert.strictEqual(out.seven_day.window_minutes, 10080);
});

test('parseCodexRateLimits: prefers most-recent session-bearing block over a newer placeholder', () => {
  const wellFormed = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: 46, window_minutes: 300, resets_at: 1783876257 },
      secondary: { used_percent: 12, window_minutes: 10080, resets_at: 1784463057 }
    } }
  });
  const out = parseCodexRateLimits(wellFormed + '\n' + PLACEHOLDER_LINE + '\n');
  assert.strictEqual(out.five_hour.utilization, 46);
  assert.strictEqual(out.seven_day.utilization, 12);
});

test('mergeCodexReadings: returns the first complete (five_hour-bearing) reading', () => {
  const out = mergeCodexReadings([
    { five_hour: null, seven_day: { utilization: 0 } },
    { five_hour: { utilization: 46 }, seven_day: { utilization: 12 } }
  ]);
  assert.strictEqual(out.five_hour.utilization, 46);
  assert.strictEqual(out.seven_day.utilization, 12);
});

test('mergeCodexReadings: newest-complete wins when multiple readings have five_hour', () => {
  const out = mergeCodexReadings([
    { five_hour: { utilization: 46 }, seven_day: { utilization: 12 } },
    { five_hour: { utilization: 55 }, seven_day: { utilization: 61 } }
  ]);
  assert.strictEqual(out.five_hour.utilization, 46);
  assert.strictEqual(out.seven_day.utilization, 12);
});

test('mergeCodexReadings: falls back to weekly-only when nothing has five_hour', () => {
  const out = mergeCodexReadings([
    { five_hour: null, seven_day: { utilization: 0 } },
    null
  ]);
  assert.strictEqual(out.five_hour, null);
  assert.strictEqual(out.seven_day.utilization, 0);
});

test('mergeCodexReadings: empty/all-null -> null', () => {
  assert.strictEqual(mergeCodexReadings([]), null);
  assert.strictEqual(mergeCodexReadings([null]), null);
  assert.strictEqual(mergeCodexReadings(null), null);
});
