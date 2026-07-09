const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clampPosition } = require('../lib/clawd-position');

test('clampPosition: in-bounds position is unchanged', () => {
  const out = clampPosition({ right: 100, bottom: 50 }, { innerWidth: 2218, innerHeight: 800 });
  assert.deepEqual(out, { right: 100, bottom: 50 });
});

test('clampPosition: the real bug — off-screen right clamps to innerWidth-40', () => {
  const out = clampPosition({ right: 4880, bottom: 394 }, { innerWidth: 2218, innerHeight: 800 });
  assert.deepEqual(out, { right: 2178, bottom: 394 });
});

test('clampPosition: negative right clamps to 0', () => {
  const out = clampPosition({ right: -500, bottom: 100 }, { innerWidth: 2218, innerHeight: 800 });
  assert.deepEqual(out, { right: 0, bottom: 100 });
});

test('clampPosition: bottom beyond bound clamps to innerHeight-40', () => {
  const out = clampPosition({ right: 100, bottom: 5000 }, { innerWidth: 2218, innerHeight: 800 });
  assert.deepEqual(out, { right: 100, bottom: 760 });
});

test('clampPosition: tiny viewport yields right 0 (never negative)', () => {
  const out = clampPosition({ right: 100, bottom: 100 }, { innerWidth: 20, innerHeight: 20 });
  assert.deepEqual(out, { right: 0, bottom: 0 });
});

test('clampPosition: input object is not mutated', () => {
  const input = { right: 4880, bottom: 394 };
  clampPosition(input, { innerWidth: 2218, innerHeight: 800 });
  assert.deepEqual(input, { right: 4880, bottom: 394 });
});
