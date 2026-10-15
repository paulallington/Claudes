const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDuration,
} = require('../lib/automation-page-view');

test('formatDuration: empty for null or invalid input', () => {
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatDuration('abc'), '');
  assert.equal(formatDuration(NaN), '');
  assert.equal(formatDuration(-5), '');
});

test('formatDuration: seconds, minutes and hours', () => {
  assert.equal(formatDuration(0), '<1s');
  assert.equal(formatDuration(999), '<1s');
  assert.equal(formatDuration(12000), '12s');
  assert.equal(formatDuration((4 * 60 + 12) * 1000), '4m 12s');
  assert.equal(formatDuration(63 * 60 * 1000), '1h 3m');
});
