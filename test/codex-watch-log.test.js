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

test('classifies a running command and flags truncation', () => {
  const r = parseLogChunk('',
    "[2026-07-22T22:42:07.545Z] Running command: \"pwsh.exe\" -Command 'rg --files -g...\n"
    + '[2026-07-22T22:42:08.000Z] x\n');
  assert.strictEqual(r.events[0].type, 'command');
  assert.strictEqual(r.events[0].message, "\"pwsh.exe\" -Command 'rg --files -g...");
  assert.strictEqual(r.events[0].truncated, true);
});

test('classifies a completed command with its exit code', () => {
  const r = parseLogChunk('',
    '[2026-07-22T22:42:12.360Z] Command completed: "git ls-files" (exit 0)\n'
    + '[2026-07-22T22:42:13.000Z] x\n');
  assert.strictEqual(r.events[0].type, 'command-result');
  assert.strictEqual(r.events[0].ok, true);
  assert.strictEqual(r.events[0].exitCode, 0);
  assert.strictEqual(r.events[0].message, '"git ls-files"');
});

test('classifies a failed command', () => {
  const r = parseLogChunk('',
    '[2026-07-22T22:42:08.983Z] Command failed: "rg" (exit 1)\n'
    + '[2026-07-22T22:42:09.000Z] x\n');
  assert.strictEqual(r.events[0].type, 'command-result');
  assert.strictEqual(r.events[0].ok, false);
  assert.strictEqual(r.events[0].exitCode, 1);
});

test('classifies assistant messages in both forms', () => {
  const block = parseLogChunk('',
    '[2026-07-22T22:42:05.922Z] Assistant message\nhello\n[2026-07-22T22:42:06.000Z] x\n');
  assert.strictEqual(block.events[0].type, 'assistant');
  assert.strictEqual(block.events[0].body, 'hello');

  const inline = parseLogChunk('',
    '[2026-07-22T22:42:05.922Z] Assistant message captured: hello there\n'
    + '[2026-07-22T22:42:06.000Z] x\n');
  assert.strictEqual(inline.events[0].type, 'assistant');
  assert.strictEqual(inline.events[0].message, 'hello there');
});

test('anything unrecognised stays a status event', () => {
  const r = parseLogChunk('',
    '[2026-07-22T22:42:01.149Z] Thread ready (019f8bfe).\n[2026-07-22T22:42:02.000Z] x\n');
  assert.strictEqual(r.events[0].type, 'status');
  assert.strictEqual(r.events[0].exitCode, null);
});
