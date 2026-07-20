const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getGitTargetCwd, describeGitPanelState } = require('../lib/git-target');

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

test('describeGitPanelState: not a git repo', () => {
  assert.deepStrictEqual(describeGitPanelState({ isRepo: false, branch: 'main' }), {
    mode: 'no-repo',
    label: 'Not a git repository',
    actionsEnabled: false,
  });
});

test('describeGitPanelState: isRepo falsy/undefined treated as no-repo', () => {
  assert.deepStrictEqual(describeGitPanelState({ branch: 'main' }), {
    mode: 'no-repo',
    label: 'Not a git repository',
    actionsEnabled: false,
  });
});

test('describeGitPanelState: repo with a branch', () => {
  assert.deepStrictEqual(describeGitPanelState({ isRepo: true, branch: 'main' }), {
    mode: 'branch',
    label: 'main',
    actionsEnabled: true,
  });
});

test('describeGitPanelState: trims branch whitespace', () => {
  assert.deepStrictEqual(describeGitPanelState({ isRepo: true, branch: '  feature/x  ' }), {
    mode: 'branch',
    label: 'feature/x',
    actionsEnabled: true,
  });
});

test('describeGitPanelState: repo with detached HEAD (empty branch)', () => {
  assert.deepStrictEqual(describeGitPanelState({ isRepo: true, branch: '' }), {
    mode: 'detached',
    label: 'detached HEAD',
    actionsEnabled: true,
  });
});

test('describeGitPanelState: repo with whitespace-only branch', () => {
  assert.deepStrictEqual(describeGitPanelState({ isRepo: true, branch: '   ' }), {
    mode: 'detached',
    label: 'detached HEAD',
    actionsEnabled: true,
  });
});

test('describeGitPanelState: repo with null/undefined branch', () => {
  assert.deepStrictEqual(describeGitPanelState({ isRepo: true, branch: null }), {
    mode: 'detached',
    label: 'detached HEAD',
    actionsEnabled: true,
  });
  assert.deepStrictEqual(describeGitPanelState({ isRepo: true }), {
    mode: 'detached',
    label: 'detached HEAD',
    actionsEnabled: true,
  });
});
