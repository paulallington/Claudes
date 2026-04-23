const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveHeadlessTitle } = require('../lib/headless-helpers');

test('deriveHeadlessTitle: returns first non-empty line', () => {
  assert.equal(deriveHeadlessTitle('Hello world'), 'Hello world');
});

test('deriveHeadlessTitle: skips leading blank lines', () => {
  assert.equal(deriveHeadlessTitle('\n\n  \nSecond line here'), 'Second line here');
});

test('deriveHeadlessTitle: trims whitespace', () => {
  assert.equal(deriveHeadlessTitle('   padded   '), 'padded');
});

test('deriveHeadlessTitle: truncates to 80 chars', () => {
  const long = 'a'.repeat(200);
  const result = deriveHeadlessTitle(long);
  assert.equal(result.length, 80);
  assert.equal(result, 'a'.repeat(80));
});

test('deriveHeadlessTitle: empty prompt returns "(empty)"', () => {
  assert.equal(deriveHeadlessTitle(''), '(empty)');
  assert.equal(deriveHeadlessTitle('   \n\n  '), '(empty)');
});

test('deriveHeadlessTitle: non-string input returns "(empty)"', () => {
  assert.equal(deriveHeadlessTitle(null), '(empty)');
  assert.equal(deriveHeadlessTitle(undefined), '(empty)');
});

const { evictOldHeadlessRuns } = require('../lib/headless-helpers');

test('evictOldHeadlessRuns: returns all when under cap', () => {
  const runs = [{ runId: 'a' }, { runId: 'b' }];
  const result = evictOldHeadlessRuns(runs, 100);
  assert.deepEqual(result.kept, runs);
  assert.deepEqual(result.evicted, []);
});

test('evictOldHeadlessRuns: evicts oldest when over cap', () => {
  const runs = [
    { runId: '1' }, { runId: '2' }, { runId: '3' }, { runId: '4' }
  ];
  const result = evictOldHeadlessRuns(runs, 2);
  assert.deepEqual(result.kept.map(r => r.runId), ['1', '2']);
  assert.deepEqual(result.evicted.map(r => r.runId), ['3', '4']);
});

test('evictOldHeadlessRuns: cap of 0 evicts everything', () => {
  const runs = [{ runId: 'a' }];
  const result = evictOldHeadlessRuns(runs, 0);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.evicted.map(r => r.runId), ['a']);
});

test('evictOldHeadlessRuns: empty input returns empty arrays', () => {
  const result = evictOldHeadlessRuns([], 100);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.evicted, []);
});

test('evictOldHeadlessRuns: non-array input treated as empty', () => {
  const result = evictOldHeadlessRuns(null, 100);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.evicted, []);
});
