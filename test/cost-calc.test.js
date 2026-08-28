const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionCost, classify } = require('../lib/cost-calc');

test('opus 5 pricing: 100k input + 10k output', () => {
  // Opus 5 prices: $5 input, $25 output per MTok (not the legacy Opus-3-era $15/$75)
  const c = sessionCost({
    model: 'claude-opus-5',
    input: 100000,
    cacheCreation: 0,
    cacheRead: 0,
    output: 10000
  });
  // 100k input @ $5/MTok = $0.50; 10k output @ $25/MTok = $0.25 → $0.75
  assert.equal(c.toFixed(2), '0.75');
});

test('opus 4.1 pricing stays at the legacy $15/$75 rate (pinned, older model)', () => {
  const c = sessionCost({
    model: 'claude-opus-4-1',
    input: 100000,
    cacheCreation: 0,
    cacheRead: 0,
    output: 10000
  });
  assert.equal(c.toFixed(2), '2.25');
});

test('fable classifies as its own family and costs a non-zero amount', () => {
  assert.equal(classify('claude-fable-5'), 'fable');
  const c = sessionCost({
    model: 'claude-fable-5',
    input: 100000,
    cacheCreation: 0,
    cacheRead: 0,
    output: 0
  });
  assert.ok(c > 0);
});

test('sonnet pricing: cache reads cost less than fresh input', () => {
  // Sonnet 4.x: $3 input, $15 output, $0.30 cache_read, $3.75 cache_creation
  const c = sessionCost({
    model: 'claude-sonnet-4-6',
    input: 0,
    cacheCreation: 0,
    cacheRead: 1000000, // 1MTok cache read
    output: 0
  });
  assert.equal(c.toFixed(2), '0.30');
});

test('haiku pricing on unknown variant falls back to haiku rate', () => {
  const c = sessionCost({
    model: 'claude-haiku-99-99',
    input: 1000000,
    cacheCreation: 0,
    cacheRead: 0,
    output: 0
  });
  // Haiku 4.x: $1 input
  assert.equal(c.toFixed(2), '1.00');
});

test('unknown model returns 0', () => {
  const c = sessionCost({ model: 'gpt-4', input: 1000, cacheCreation: 0, cacheRead: 0, output: 1000 });
  assert.equal(c, 0);
});
