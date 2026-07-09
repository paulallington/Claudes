const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clampPosition } = require('../lib/clawd-position');

test('clampPosition: in-bounds position with size is unchanged', () => {
  const out = clampPosition({ right: 100, bottom: 50 }, { innerWidth: 2218, innerHeight: 800 }, { width: 180, height: 180 });
  assert.deepEqual(out, { right: 100, bottom: 50 });
});

test('clampPosition: the real bug — off-screen right clamps to keep whole widget on screen', () => {
  const out = clampPosition({ right: 4880, bottom: 394 }, { innerWidth: 2218, innerHeight: 800 }, { width: 180, height: 180 });
  assert.deepEqual(out, { right: 2038, bottom: 394 });
});

test('clampPosition: negative right clamps to 0', () => {
  const out = clampPosition({ right: -500, bottom: 100 }, { innerWidth: 2218, innerHeight: 800 }, { width: 180, height: 180 });
  assert.deepEqual(out, { right: 0, bottom: 100 });
});

test('clampPosition: bottom beyond bound clamps to innerHeight-height', () => {
  const out = clampPosition({ right: 100, bottom: 5000 }, { innerWidth: 2218, innerHeight: 800 }, { width: 180, height: 180 });
  assert.deepEqual(out, { right: 100, bottom: 620 });
});

test('clampPosition: widget larger than viewport clamps to 0', () => {
  const out = clampPosition({ right: 100, bottom: 100 }, { innerWidth: 800, innerHeight: 800 }, { width: 900, height: 900 });
  assert.deepEqual(out, { right: 0, bottom: 0 });
});

test('clampPosition: omitted size behaves as size 0 (cap at dim, back-compatible)', () => {
  const out = clampPosition({ right: 4880, bottom: 5000 }, { innerWidth: 2218, innerHeight: 800 });
  assert.deepEqual(out, { right: 2218, bottom: 800 });
});

test('clampPosition: empty size object behaves as size 0', () => {
  const out = clampPosition({ right: 4880, bottom: 5000 }, { innerWidth: 2218, innerHeight: 800 }, {});
  assert.deepEqual(out, { right: 2218, bottom: 800 });
});

test('clampPosition: input object is not mutated', () => {
  const input = { right: 4880, bottom: 394 };
  clampPosition(input, { innerWidth: 2218, innerHeight: 800 }, { width: 180, height: 180 });
  assert.deepEqual(input, { right: 4880, bottom: 394 });
});
