const test = require('node:test');
const assert = require('node:assert/strict');
const { nextPollDelay } = require('../lib/poll-backoff');

const opts = { min: 150, max: 1000 };

test('a change resets the delay to min', () => {
  assert.strictEqual(nextPollDelay(1000, true, opts), 150);
});

test('no change doubles the delay', () => {
  assert.strictEqual(nextPollDelay(150, false, opts), 300);
});

test('no change never exceeds max', () => {
  assert.strictEqual(nextPollDelay(600, false, opts), 1000);
  assert.strictEqual(nextPollDelay(1000, false, opts), 1000);
});

test('a missing or invalid previous delay starts from min', () => {
  assert.strictEqual(nextPollDelay(undefined, false, opts), 300);
  assert.strictEqual(nextPollDelay(NaN, false, opts), 300);
  assert.strictEqual(nextPollDelay(0, false, opts), 300);
});
