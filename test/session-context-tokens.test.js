const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { lastAssistantContextTokens } = require('../lib/session-context-tokens');

function tmpFile(lines) {
  const p = path.join(os.tmpdir(), 'ctxtok-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jsonl');
  fs.writeFileSync(p, lines.map(JSON.stringify).join('\n') + '\n');
  return p;
}

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
