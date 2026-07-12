const test = require('node:test');
const assert = require('node:assert/strict');
const { reconnectDelay, shouldShowServerDown } = require('../lib/reconnect-backoff');

test('reconnectDelay: attempt 1 returns base', () => {
  assert.equal(reconnectDelay(1), 1000);
});

test('reconnectDelay: attempt <= 1 (0 or negative) also returns base', () => {
  assert.equal(reconnectDelay(0), 1000);
  assert.equal(reconnectDelay(-5), 1000);
});

test('reconnectDelay: grows exponentially with default factor', () => {
  assert.equal(reconnectDelay(1), 1000);
  assert.equal(reconnectDelay(2), 2000);
  assert.equal(reconnectDelay(3), 4000);
  assert.equal(reconnectDelay(4), 8000);
  assert.equal(reconnectDelay(5), 16000);
});

test('reconnectDelay: caps at default 30000', () => {
  assert.equal(reconnectDelay(6), 30000);
  assert.equal(reconnectDelay(10), 30000);
  assert.equal(reconnectDelay(100), 30000);
});

test('reconnectDelay: respects custom opts', () => {
  assert.equal(reconnectDelay(1, { base: 500, factor: 3, cap: 5000 }), 500);
  assert.equal(reconnectDelay(2, { base: 500, factor: 3, cap: 5000 }), 1500);
  assert.equal(reconnectDelay(3, { base: 500, factor: 3, cap: 5000 }), 4500);
  assert.equal(reconnectDelay(4, { base: 500, factor: 3, cap: 5000 }), 5000); // capped
});

test('reconnectDelay: is pure — no randomness, deterministic for same input', () => {
  assert.equal(reconnectDelay(3), reconnectDelay(3));
});

test('shouldShowServerDown: false below default threshold of 4', () => {
  assert.equal(shouldShowServerDown(1), false);
  assert.equal(shouldShowServerDown(2), false);
  assert.equal(shouldShowServerDown(3), false);
});

test('shouldShowServerDown: true at and above default threshold of 4', () => {
  assert.equal(shouldShowServerDown(4), true);
  assert.equal(shouldShowServerDown(5), true);
  assert.equal(shouldShowServerDown(100), true);
});

test('shouldShowServerDown: respects custom threshold', () => {
  assert.equal(shouldShowServerDown(2, { threshold: 2 }), true);
  assert.equal(shouldShowServerDown(1, { threshold: 2 }), false);
});
