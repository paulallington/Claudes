const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeProportionalRowRatios } = require('../lib/row-layout');

test('computeProportionalRowRatios: empty array returns []', () => {
  assert.deepEqual(computeProportionalRowRatios([]), []);
});

test('computeProportionalRowRatios: single value returns [1]', () => {
  assert.deepEqual(computeProportionalRowRatios([300]), [1]);
});

test('computeProportionalRowRatios: proportional heights divide cleanly', () => {
  assert.deepEqual(computeProportionalRowRatios([300, 500, 200]), [0.3, 0.5, 0.2]);
});

test('computeProportionalRowRatios: zero is sanitized to 1', () => {
  var ratios = computeProportionalRowRatios([0, 100]);
  assert.ok(Math.abs(ratios[0] - 1 / 101) < 1e-9);
  assert.ok(Math.abs(ratios[1] - 100 / 101) < 1e-9);
});

test('computeProportionalRowRatios: negative is sanitized to 1', () => {
  var ratios = computeProportionalRowRatios([-1, 100]);
  assert.ok(Math.abs(ratios[0] - 1 / 101) < 1e-9);
  assert.ok(Math.abs(ratios[1] - 100 / 101) < 1e-9);
});

test('computeProportionalRowRatios: NaN is sanitized to 1', () => {
  var ratios = computeProportionalRowRatios([NaN, 50]);
  assert.ok(Math.abs(ratios[0] - 1 / 51) < 1e-9);
  assert.ok(Math.abs(ratios[1] - 50 / 51) < 1e-9);
});

test('computeProportionalRowRatios: null returns []', () => {
  assert.deepEqual(computeProportionalRowRatios(null), []);
});

test('computeProportionalRowRatios: undefined returns []', () => {
  assert.deepEqual(computeProportionalRowRatios(undefined), []);
});
