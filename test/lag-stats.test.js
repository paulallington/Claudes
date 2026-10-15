const test = require('node:test');
const assert = require('node:assert/strict');
const { createLagStats } = require('../lib/lag-stats');

test('nearest-rank percentiles over 1..100', () => {
  const s = createLagStats();
  for (let i = 100; i >= 1; i--) s.record(i);
  assert.deepEqual(s.snapshot(), { p50: 50, p99: 99, max: 100, count: 100 });
});

test('reset clears samples', () => {
  const s = createLagStats();
  s.record(5);
  s.reset();
  assert.deepEqual(s.snapshot(), { p50: 0, p99: 0, max: 0, count: 0 });
});

test('stored samples are capped but count and max keep tracking', () => {
  const s = createLagStats(10);
  for (let i = 1; i <= 25; i++) s.record(i);
  s.record(1000);
  const snap = s.snapshot();
  assert.equal(snap.count, 26);
  assert.equal(snap.max, 1000);
  assert.ok(snap.p99 <= 1000);
});

test('snapshot of an empty accumulator is all zeros', () => {
  const s = createLagStats();
  assert.deepEqual(s.snapshot(), { p50: 0, p99: 0, max: 0, count: 0 });
});
