const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getGitTargetCwd } = require('../lib/git-target');

test('returns project path when state is null', () => {
  assert.equal(getGitTargetCwd(null, new Map(), '/project'), '/project');
});
test('returns project path when no focused column', () => {
  assert.equal(getGitTargetCwd({ focusedColumnId: null }, new Map(), '/project'), '/project');
});
test('returns column cwd when focused column has one', () => {
  const cols = new Map([[1, { cwd: '/wt/foo' }]]);
  assert.equal(getGitTargetCwd({ focusedColumnId: 1 }, cols, '/project'), '/wt/foo');
});
test('falls back when focused column has empty cwd', () => {
  const cols = new Map([[1, { cwd: '' }]]);
  assert.equal(getGitTargetCwd({ focusedColumnId: 1 }, cols, '/project'), '/project');
});
test('falls back when focused column id no longer exists', () => {
  assert.equal(getGitTargetCwd({ focusedColumnId: 999 }, new Map(), '/project'), '/project');
});
