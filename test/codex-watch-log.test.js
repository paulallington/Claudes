// test/codex-watch-log.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parseLogChunk, previewEvent } = require('../lib/codex-watch-log');

test('emits completed events and carries the trailing one', () => {
  const chunk = '[2026-07-22T22:41:45.992Z] Starting Codex Task.\n'
    + '[2026-07-22T22:41:48.672Z] Starting Codex task thread.\n';
  const r = parseLogChunk('', chunk);
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].message, 'Starting Codex Task.');
  assert.strictEqual(r.events[0].ts, '2026-07-22T22:41:45.992Z');
  assert.match(r.carry, /Starting Codex task thread\./);
});

test('a chunk split mid-line does not corrupt the event', () => {
  const a = parseLogChunk('', '[2026-07-22T22:41:45.992Z] Starting Codex Ta');
  assert.deepStrictEqual(a.events, []);
  const b = parseLogChunk(a.carry, 'sk.\n[2026-07-22T22:41:48.672Z] Next.\n');
  assert.strictEqual(b.events.length, 1);
  assert.strictEqual(b.events[0].message, 'Starting Codex Task.');
});

test('body lines attach to the preceding event', () => {
  const chunk = '[2026-07-22T22:42:05.922Z] Assistant message\n'
    + 'line one\nline two\n'
    + '[2026-07-22T22:42:07.545Z] Done.\n';
  const r = parseLogChunk('', chunk);
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].body, 'line one\nline two');
});

test('previewEvent exposes the in-flight trailing event', () => {
  const r = parseLogChunk('', '[2026-07-22T22:41:45.992Z] Starting Codex Task.\n');
  const p = previewEvent(r.carry);
  assert.strictEqual(p.message, 'Starting Codex Task.');
});

test('previewEvent returns null for empty carry', () => {
  assert.strictEqual(previewEvent(''), null);
});
