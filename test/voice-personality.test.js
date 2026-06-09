const test = require('node:test');
const assert = require('node:assert/strict');
const { PERSONALITY_PRESETS, upsertPersonalityBlock, extractPersonalityBlock } = require('../lib/voice-personality');

const START = '<!-- VOICE-PERSONALITY:START -->';
const END = '<!-- VOICE-PERSONALITY:END -->';

test('PERSONALITY_PRESETS exposes the expected presets', () => {
  assert.ok(Array.isArray(PERSONALITY_PRESETS));
  const byKey = {};
  for (const p of PERSONALITY_PRESETS) {
    assert.equal(typeof p.key, 'string');
    assert.equal(typeof p.label, 'string');
    assert.equal(typeof p.persona, 'string');
    byKey[p.key] = p;
  }
  assert.deepEqual(byKey.warm, { key: 'warm', label: 'Warm & enthusiastic', persona: 'warm, upbeat and encouraging' });
  assert.deepEqual(byKey.dry, { key: 'dry', label: 'Dry & witty', persona: 'dry, witty and a little sardonic' });
  assert.deepEqual(byKey.concise, { key: 'concise', label: 'Concise & professional', persona: 'concise, professional and matter-of-fact' });
  assert.deepEqual(byKey.calm, { key: 'calm', label: 'Calm & measured', persona: 'calm, measured and reassuring' });
  assert.deepEqual(byKey.playful, { key: 'playful', label: 'Playful', persona: 'playful and lighthearted' });
  assert.equal(PERSONALITY_PRESETS.length, 5);
});

test('upsertPersonalityBlock appends a block when absent, preserving original text', () => {
  const original = '# My project\n\nSome existing notes.';
  const out = upsertPersonalityBlock(original, 'warm, upbeat and encouraging');
  assert.ok(out.includes(START));
  assert.ok(out.includes(END));
  assert.ok(out.includes('When writing the \u{1F50A} summary line, speak with this persona: warm, upbeat and encouraging.'));
  assert.ok(out.startsWith(original));
  // separated by a blank line from the original
  assert.ok(out.indexOf(original) === 0 && out.slice(original.length).startsWith('\n\n'));
});

function countOccurrences(s, needle) {
  let n = 0, i = 0;
  while ((i = s.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

test('upsertPersonalityBlock replaces the existing block in place, no duplicates', () => {
  const original = '# My project';
  const first = upsertPersonalityBlock(original, 'warm, upbeat and encouraging');
  const second = upsertPersonalityBlock(first, 'dry, witty and a little sardonic');
  assert.equal(countOccurrences(second, START), 1);
  assert.equal(countOccurrences(second, END), 1);
  assert.ok(second.includes('speak with this persona: dry, witty and a little sardonic.'));
  assert.ok(!second.includes('warm, upbeat and encouraging'));
});

test('upsertPersonalityBlock removes the block when persona is empty/whitespace', () => {
  const original = '# My project\n\nSome notes.';
  const withBlock = upsertPersonalityBlock(original, 'warm, upbeat and encouraging');
  const removed = upsertPersonalityBlock(withBlock, '   ');
  assert.ok(!removed.includes(START));
  assert.ok(!removed.includes(END));
  assert.equal(removed, original);
  // absent -> empty persona returns text unchanged
  assert.equal(upsertPersonalityBlock(original, ''), original);
});

test('upsertPersonalityBlock sanitizes embedded markers, no orphaned cruft on double-apply', () => {
  const evil = 'evil <!-- VOICE-PERSONALITY:END --> tail';
  const out = upsertPersonalityBlock(upsertPersonalityBlock('', evil), evil);
  assert.equal(countOccurrences(out, START), 1);
  assert.equal(countOccurrences(out, END), 1);
  // round-trips to the sanitized persona, stable across re-extraction
  assert.equal(extractPersonalityBlock(out), 'evil  tail');
});

test('extractPersonalityBlock round-trips the persona, anchored on ASCII text', () => {
  assert.equal(extractPersonalityBlock('no block here'), '');
  const text = upsertPersonalityBlock('# Project', 'dry, witty and a little sardonic');
  assert.equal(extractPersonalityBlock(text), 'dry, witty and a little sardonic');
});
