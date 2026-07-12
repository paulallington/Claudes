'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeSlot,
  parseCodexRateLimits,
  pickLatestRolloutPath
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

test('parseCodexRateLimits: fresh session with weekly window in primary slot -> seven_day only (session hidden, not resurrected)', () => {
  // Pro Lite often has no 5-hour window at all; a fresh session's reading can
  // put the weekly window in the `primary` slot with `secondary: null`. This
  // must classify by window_minutes (10080 -> seven_day) and leave five_hour
  // null rather than mislabeling it as the session bar.
  const line = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: 1, window_minutes: 10080 },
      secondary: null
    } }
  });
  const out = parseCodexRateLimits(line);
  assert.strictEqual(out.five_hour, null);
  assert.strictEqual(out.seven_day.utilization, 1);
  assert.strictEqual(out.seven_day.window_minutes, 10080);
});

test('parseCodexRateLimits: missing window_minutes falls back to positional classification', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: 30 },
      secondary: { used_percent: 8 }
    } }
  });
  const out = parseCodexRateLimits(line);
  assert.strictEqual(out.five_hour.utilization, 30);
  assert.strictEqual(out.seven_day.utilization, 8);
});
