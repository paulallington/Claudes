const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionCost, MODEL_PRICES_PER_MTOK } = require('../lib/cost-calc');

test('opus pricing: 100k input + 10k output', () => {
  // Opus 4.x prices: $15 input, $75 output, $1.50 cache_read, $18.75 cache_creation per MTok
  const c = sessionCost({
    model: 'claude-opus-4-7',
    input: 100000,
    cacheCreation: 0,
    cacheRead: 0,
    output: 10000
  });
  // 100k input @ $15/MTok = $1.50; 10k output @ $75/MTok = $0.75 → $2.25
  assert.equal(c.toFixed(2), '2.25');
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

test('MODEL_PRICES_PER_MTOK is exported', () => {
  assert.ok(MODEL_PRICES_PER_MTOK.opus);
  assert.ok(MODEL_PRICES_PER_MTOK.sonnet);
  assert.ok(MODEL_PRICES_PER_MTOK.haiku);
});
