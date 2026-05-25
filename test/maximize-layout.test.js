const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeMaximizeRowOp, computeRestoreRowOp } = require('../lib/maximize-layout');

test('computeMaximizeRowOp: target with prior resize captures snapshot and overrides flex/height', () => {
  var rows = [
    { id: 1, inlineFlex: 'none', inlineHeight: '350px' },
    { id: 2, inlineFlex: 'none', inlineHeight: '200px' },
    { id: 3, inlineFlex: '', inlineHeight: '' },
  ];
  var op = computeMaximizeRowOp(rows, 1);
  assert.deepEqual(op.hide, [2, 3]);
  assert.deepEqual(op.expand, { rowId: 1, flex: '1', height: '' });
  assert.deepEqual(op.snapshot, { rowId: 1, flex: 'none', height: '350px' });
});

test('computeMaximizeRowOp: target without prior resize captures empty strings; expand still forces flex:1', () => {
  var rows = [
    { id: 10, inlineFlex: '', inlineHeight: '' },
    { id: 11, inlineFlex: '', inlineHeight: '' },
  ];
  var op = computeMaximizeRowOp(rows, 10);
  assert.deepEqual(op.hide, [11]);
  assert.deepEqual(op.expand, { rowId: 10, flex: '1', height: '' });
  assert.deepEqual(op.snapshot, { rowId: 10, flex: '', height: '' });
});

test('computeMaximizeRowOp: single-row case hides nothing but still expands target', () => {
  var rows = [{ id: 7, inlineFlex: 'none', inlineHeight: '500px' }];
  var op = computeMaximizeRowOp(rows, 7);
  assert.deepEqual(op.hide, []);
  assert.deepEqual(op.expand, { rowId: 7, flex: '1', height: '' });
  assert.deepEqual(op.snapshot, { rowId: 7, flex: 'none', height: '500px' });
});

test('computeMaximizeRowOp: targetRowId not found returns nulls and empty hide', () => {
  var rows = [
    { id: 1, inlineFlex: '', inlineHeight: '' },
    { id: 2, inlineFlex: '', inlineHeight: '' },
  ];
  var op = computeMaximizeRowOp(rows, 999);
  assert.deepEqual(op, { hide: [], expand: null, snapshot: null });
});

test('computeMaximizeRowOp: empty rows array returns defensive defaults', () => {
  var op = computeMaximizeRowOp([], 1);
  assert.deepEqual(op, { hide: [], expand: null, snapshot: null });
});

test('computeMaximizeRowOp: non-array input returns defensive defaults', () => {
  assert.deepEqual(computeMaximizeRowOp(null, 1), { hide: [], expand: null, snapshot: null });
  assert.deepEqual(computeMaximizeRowOp(undefined, 1), { hide: [], expand: null, snapshot: null });
});

test('computeRestoreRowOp: round-trips snapshot fields verbatim including empty strings', () => {
  var snap = { rowId: 4, flex: 'none', height: '350px' };
  assert.deepEqual(computeRestoreRowOp(snap), { rowId: 4, flex: 'none', height: '350px' });

  var emptySnap = { rowId: 5, flex: '', height: '' };
  assert.deepEqual(computeRestoreRowOp(emptySnap), { rowId: 5, flex: '', height: '' });
});

test('computeRestoreRowOp(null) returns null', () => {
  assert.equal(computeRestoreRowOp(null), null);
});

test('computeRestoreRowOp(undefined) returns null', () => {
  assert.equal(computeRestoreRowOp(undefined), null);
});
