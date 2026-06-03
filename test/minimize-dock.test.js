const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRestoreTarget } = require('../lib/minimize-dock');

function makeRows() {
  return [
    { id: 'r1', columnIds: ['c1', 'c2'] },
    { id: 'r2', columnIds: ['c3'] }
  ];
}

test('resolveRestoreTarget: origin row exists, index within range returns existing unchanged', () => {
  var result = resolveRestoreTarget(makeRows(), { rowId: 'r1', index: 1 });
  assert.deepEqual(result, { mode: 'existing', rowId: 'r1', index: 1 });
});

test('resolveRestoreTarget: origin row exists, index past end is clamped to columnIds.length', () => {
  var result = resolveRestoreTarget(makeRows(), { rowId: 'r1', index: 9 });
  assert.deepEqual(result, { mode: 'existing', rowId: 'r1', index: 2 });
});

test('resolveRestoreTarget: origin row exists, negative index is clamped to 0', () => {
  var result = resolveRestoreTarget(makeRows(), { rowId: 'r1', index: -3 });
  assert.deepEqual(result, { mode: 'existing', rowId: 'r1', index: 0 });
});

test('resolveRestoreTarget: origin.rowId not among rows returns new', () => {
  var result = resolveRestoreTarget(makeRows(), { rowId: 'nope', index: 0 });
  assert.deepEqual(result, { mode: 'new' });
});

test('resolveRestoreTarget: origin is null returns new', () => {
  var result = resolveRestoreTarget(makeRows(), null);
  assert.deepEqual(result, { mode: 'new' });
});

test('resolveRestoreTarget: origin missing rowId returns new', () => {
  var result = resolveRestoreTarget(makeRows(), { index: 1 });
  assert.deepEqual(result, { mode: 'new' });
});
