'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  MODELS,
  ALIASES,
  DEFAULT_1M_MODEL,
  lookup,
  familyOf,
  contextWindowFor,
  pricesFor,
  supportsOneM,
} = require('../lib/claude-models');

test('DEFAULT_1M_MODEL is claude-opus-5', () => {
  assert.strictEqual(DEFAULT_1M_MODEL, 'claude-opus-5');
});

test('exact-id lookup returns the catalogue entry', () => {
  const entry = lookup('claude-sonnet-5');
  assert.strictEqual(entry.label, 'Sonnet 5');
  assert.strictEqual(entry.family, 'sonnet');
  assert.strictEqual(entry.isAlias, false);
});

test('lookup returns null for unknown/null/undefined ids', () => {
  assert.strictEqual(lookup('nonexistent-model'), null);
  assert.strictEqual(lookup(null), null);
  assert.strictEqual(lookup(undefined), null);
});

test('alias handling: opus/sonnet/haiku resolve to "(latest)" alias entries', () => {
  const opus = lookup('opus');
  assert.strictEqual(opus.label, 'Opus (latest)');
  assert.strictEqual(opus.isAlias, true);
  assert.strictEqual(opus.family, 'opus');

  const sonnet = lookup('sonnet');
  assert.strictEqual(sonnet.label, 'Sonnet (latest)');
  assert.strictEqual(sonnet.isAlias, true);

  const haiku = lookup('haiku');
  assert.strictEqual(haiku.label, 'Haiku (latest)');
  assert.strictEqual(haiku.isAlias, true);
});

test('ALIASES is an ordered array of the three CLI aliases', () => {
  assert.deepStrictEqual(ALIASES.map((a) => a.id), ['opus', 'sonnet', 'haiku']);
  for (const a of ALIASES) assert.strictEqual(a.isAlias, true);
});

test('claude-opus-5 prices are 5/25, NOT the legacy 15/75', () => {
  const prices = pricesFor('claude-opus-5');
  assert.strictEqual(prices.input, 5);
  assert.strictEqual(prices.output, 25);
});

test('claude-fable-5 classifies as fable, not opus or sonnet', () => {
  assert.strictEqual(familyOf('claude-fable-5'), 'fable');
});

test('contextWindowFor: haiku-4-5 is 200000, opus-5 is 1000000', () => {
  assert.strictEqual(contextWindowFor('claude-haiku-4-5'), 200000);
  assert.strictEqual(contextWindowFor('claude-opus-5'), 1000000);
});

test('supportsOneM: true for opus-5/sonnet-5/fable-5, false for haiku-4-5', () => {
  assert.strictEqual(supportsOneM('claude-opus-5'), true);
  assert.strictEqual(supportsOneM('claude-sonnet-5'), true);
  assert.strictEqual(supportsOneM('claude-fable-5'), true);
  assert.strictEqual(supportsOneM('claude-haiku-4-5'), false);
});

test('unknown/null/undefined ids return safe defaults without throwing', () => {
  assert.strictEqual(contextWindowFor('totally-unknown-model'), 200000);
  assert.strictEqual(contextWindowFor(null), 200000);
  assert.strictEqual(contextWindowFor(undefined), 200000);
  assert.strictEqual(pricesFor('totally-unknown-model'), null);
  assert.strictEqual(pricesFor(null), null);
  assert.strictEqual(familyOf('totally-unknown-model'), null);
  assert.strictEqual(familyOf(null), null);
  assert.strictEqual(supportsOneM(null), false);
});

test('family fallback: an old/unversioned opus id gets legacy prices+context', () => {
  const prices = pricesFor('claude-opus-4-1');
  assert.strictEqual(prices.input, 15);
  assert.strictEqual(prices.output, 75);
  assert.strictEqual(contextWindowFor('claude-opus-4-1'), 200000);
});

test('derived cache prices are correct for opus-5 (cacheRead 0.5, cacheCreation 6.25)', () => {
  const prices = pricesFor('claude-opus-5');
  assert.strictEqual(prices.cacheRead, 0.5);
  assert.strictEqual(prices.cacheCreation, 6.25);
});

test('MODELS is the ordered array of pinned entries', () => {
  assert.deepStrictEqual(MODELS.map((m) => m.id), [
    'claude-fable-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ]);
  for (const m of MODELS) assert.strictEqual(m.isAlias, false);
});
