const test = require('node:test');
const assert = require('node:assert/strict');
const { fuzzyRank } = require('../lib/fuzzy-rank');

const items = [
  { id: 1, label: 'Switch to Claudes' },
  { id: 2, label: 'Switch to other-project' },
  { id: 3, label: 'Open Usage' },
  { id: 4, label: 'Spawn in Claudes' }
];

test('empty query returns input order', () => {
  const out = fuzzyRank(items, '', i => i.label);
  assert.deepEqual(out.map(x => x.id), [1, 2, 3, 4]);
});

test('subsequence match returns scored hits, exact substrings rank highest', () => {
  const out = fuzzyRank(items, 'Claudes', i => i.label);
  assert.deepEqual(out.slice(0, 2).map(x => x.id).sort(), [1, 4]);
});

test('non-matches are excluded', () => {
  const out = fuzzyRank(items, 'xyz', i => i.label);
  assert.equal(out.length, 0);
});

test('case-insensitive', () => {
  const out = fuzzyRank(items, 'OPEN', i => i.label);
  assert.deepEqual(out.map(x => x.id), [3]);
});

test('subsequence — "switcla" matches "Switch to Claudes"', () => {
  const out = fuzzyRank(items, 'switcla', i => i.label);
  assert.ok(out.length >= 1);
  assert.equal(out[0].id, 1);
});
