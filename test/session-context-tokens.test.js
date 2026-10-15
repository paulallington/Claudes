const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { lastAssistantContextTokens, modelContextLimit, sampleAndResetReadStats } = require('../lib/session-context-tokens');

function tmpFile(lines) {
  const p = path.join(os.tmpdir(), 'ctxtok-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jsonl');
  fs.writeFileSync(p, lines.map(JSON.stringify).join('\n') + '\n');
  return p;
}

// head lines, then `filler` ~1KB non-usage lines, then tail lines.
function bigTmpFile(head, tail, filler) {
  const p = path.join(os.tmpdir(), 'ctxtok-big-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jsonl');
  const fillerLine = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } });
  const parts = head.map(JSON.stringify);
  for (let i = 0; i < filler; i++) parts.push(fillerLine);
  fs.writeFileSync(p, parts.concat(tail.map(JSON.stringify)).join('\n') + '\n');
  return p;
}
const usageLine = (n) => ({ type: 'assistant', message: { usage: { input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });

test('large file: reads only the tail when the usage line is near the end', () => {
  const p = bigTmpFile([usageLine(1)], [usageLine(777)], 600);
  assert.ok(fs.statSync(p).size > 512 * 1024);
  sampleAndResetReadStats();
  assert.strictEqual(lastAssistantContextTokens(p), 777);
  const stats = sampleAndResetReadStats();
  assert.ok(stats.bytesRead <= 256 * 1024, 'bytesRead ' + stats.bytesRead);
  assert.strictEqual(stats.fullReads, 0);
  fs.unlinkSync(p);
});

test('large file: falls back to a full read when the usage line is only near the start', () => {
  const p = bigTmpFile([usageLine(555)], [], 600);
  sampleAndResetReadStats();
  assert.strictEqual(lastAssistantContextTokens(p), 555);
  const stats = sampleAndResetReadStats();
  assert.strictEqual(stats.fullReads, 1);
  assert.ok(stats.bytesRead > 512 * 1024);
  fs.unlinkSync(p);
});

test('large file: sinceMs still filters entries found in the tail', () => {
  const old = Object.assign({ timestamp: '2026-01-01T00:00:00Z' }, usageLine(900));
  const fresh = Object.assign({ timestamp: '2026-03-01T00:00:00Z' }, usageLine(40));
  const p = bigTmpFile([fresh], [old], 600);
  const cutoff = Date.parse('2026-02-01T00:00:00Z');
  assert.strictEqual(lastAssistantContextTokens(p, cutoff), 40);
  fs.unlinkSync(p);
});

test('unchanged file with no usage line is read once, then served from cache', () => {
  const p = bigTmpFile([], [{ type: 'user', message: { content: 'hi' } }], 600);
  assert.strictEqual(lastAssistantContextTokens(p), null);
  sampleAndResetReadStats();
  assert.strictEqual(lastAssistantContextTokens(p), null);
  assert.strictEqual(sampleAndResetReadStats().bytesRead, 0);
  fs.unlinkSync(p);
});

test('returns null for empty file', () => {
  const p = tmpFile([]);
  assert.strictEqual(lastAssistantContextTokens(p), null);
  fs.unlinkSync(p);
});

test('sums input + cache_creation + cache_read of last assistant message', () => {
  const p = tmpFile([
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 50, output_tokens: 5 } } },
    { type: 'user', message: { content: 'again' } },
    { type: 'assistant', message: { usage: { input_tokens: 110, cache_creation_input_tokens: 0, cache_read_input_tokens: 380, output_tokens: 7 } } }
  ]);
  assert.strictEqual(lastAssistantContextTokens(p), 110 + 0 + 380);
  fs.unlinkSync(p);
});

test('skips non-assistant lines and malformed JSON', () => {
  const p = path.join(os.tmpdir(), 'ctxtok-bad-' + Date.now() + '.jsonl');
  fs.writeFileSync(p,
    '{"type":"system","x":1}\n' +
    'not json\n' +
    '{"type":"assistant","message":{"usage":{"input_tokens":42,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n'
  );
  assert.strictEqual(lastAssistantContextTokens(p), 42);
  fs.unlinkSync(p);
});

test('returns null for nonexistent file', () => {
  assert.strictEqual(lastAssistantContextTokens('/no/such/file.jsonl'), null);
});

test('sinceMs skips assistant turns older than the cutoff', () => {
  const p = tmpFile([
    { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { usage: { input_tokens: 325000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  ]);
  const cutoff = Date.parse('2026-02-01T00:00:00Z');
  assert.strictEqual(lastAssistantContextTokens(p, cutoff), null);
  fs.unlinkSync(p);
});

test('sinceMs returns the most recent assistant turn at or after the cutoff', () => {
  const p = tmpFile([
    { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { usage: { input_tokens: 325000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: 'user', message: { content: 'fresh' } },
    { type: 'assistant', timestamp: '2026-03-01T00:00:00Z', message: { usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 } } }
  ]);
  const cutoff = Date.parse('2026-02-01T00:00:00Z');
  assert.strictEqual(lastAssistantContextTokens(p, cutoff), 1200);
  fs.unlinkSync(p);
});

test('sinceMs without a timestamp on the entry is treated as too-old', () => {
  const p = tmpFile([
    { type: 'assistant', message: { usage: { input_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  ]);
  assert.strictEqual(lastAssistantContextTokens(p, Date.now() - 60_000), null);
  fs.unlinkSync(p);
});

test('omitting sinceMs preserves prior behavior (no time filter)', () => {
  const p = tmpFile([
    { type: 'assistant', timestamp: '2020-01-01T00:00:00Z', message: { usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  ]);
  assert.strictEqual(lastAssistantContextTokens(p), 50);
  fs.unlinkSync(p);
});

test('modelContextLimit is 1M for natively-1M models (opus 5)', () => {
  assert.strictEqual(modelContextLimit('claude-opus-5'), 1000000);
});

test('modelContextLimit is 200000 for haiku 4.5', () => {
  assert.strictEqual(modelContextLimit('claude-haiku-4-5'), 200000);
});

test('modelContextLimit is 200000 for opus 4.5 (pinned, not 1M)', () => {
  assert.strictEqual(modelContextLimit('claude-opus-4-5'), 200000);
});

test('modelContextLimit [1m] suffix wins regardless of family', () => {
  assert.strictEqual(modelContextLimit('claude-opus-4-5[1m]'), 1000000);
});

test('modelContextLimit returns the safe default for null/undefined/unknown', () => {
  assert.strictEqual(modelContextLimit(null), 200000);
  assert.strictEqual(modelContextLimit(undefined), 200000);
  assert.strictEqual(modelContextLimit('gpt-4'), 200000);
});
