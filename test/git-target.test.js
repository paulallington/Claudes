const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getGitTargetCwd, describeGitPanelState, describeColumnTarget } = require('../lib/git-target');

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

test('describeColumnTarget: no cwd at all', () => {
  assert.deepStrictEqual(
    describeColumnTarget({ cwd: null, projectRoot: '/project', cwdSource: undefined }),
    { show: false, kind: null, label: '', title: '' }
  );
  assert.deepStrictEqual(
    describeColumnTarget({ cwd: '', projectRoot: '/project', cwdSource: undefined }),
    { show: false, kind: null, label: '', title: '' }
  );
});

test('describeColumnTarget: cwd equals project root exactly', () => {
  assert.deepStrictEqual(
    describeColumnTarget({ cwd: '/project', projectRoot: '/project', cwdSource: undefined }),
    { show: false, kind: null, label: '', title: '' }
  );
});

test('describeColumnTarget: cwd equals project root, Windows case and separator variant', () => {
  assert.deepStrictEqual(
    describeColumnTarget({
      cwd: 'c:\\Users\\paul\\Git\\Claudes',
      projectRoot: 'C:/Users/paul/Git/Claudes',
      cwdSource: undefined,
    }),
    { show: false, kind: null, label: '', title: '' }
  );
});

test('describeColumnTarget: cwd equals project root, trailing slash variant', () => {
  assert.deepStrictEqual(
    describeColumnTarget({
      cwd: 'C:/Users/paul/Git/Claudes/',
      projectRoot: 'C:/Users/paul/Git/Claudes',
      cwdSource: undefined,
    }),
    { show: false, kind: null, label: '', title: '' }
  );
});

test('describeColumnTarget: auto-worktree binding', () => {
  assert.deepStrictEqual(
    describeColumnTarget({
      cwd: '/home/paul/worktrees/feature-x',
      projectRoot: '/home/paul/project',
      cwdSource: 'auto-worktree',
    }),
    {
      show: true,
      kind: 'worktree',
      label: '⎇ feature-x',
      title: 'Git tab bound to /home/paul/worktrees/feature-x — display only; this column runs in the project root',
    }
  );
});

test('describeColumnTarget: manual cwd binding', () => {
  assert.deepStrictEqual(
    describeColumnTarget({
      cwd: '/home/paul/subdir',
      projectRoot: '/home/paul/project',
      cwdSource: 'manual',
    }),
    {
      show: true,
      kind: 'cwd',
      label: '→ subdir',
      title: 'Working directory: /home/paul/subdir',
    }
  );
});

test('describeColumnTarget: non-root cwd with unknown/undefined source is treated as cwd kind', () => {
  assert.deepStrictEqual(
    describeColumnTarget({
      cwd: '/home/paul/other-dir',
      projectRoot: '/home/paul/project',
      cwdSource: undefined,
    }),
    {
      show: true,
      kind: 'cwd',
      label: '→ other-dir',
      title: 'Working directory: /home/paul/other-dir',
    }
  );
});

test('describeColumnTarget: leaf longer than 14 chars is truncated with ellipsis', () => {
  const result = describeColumnTarget({
    cwd: '/home/paul/this-is-a-very-long-directory-name',
    projectRoot: '/home/paul/project',
    cwdSource: 'manual',
  });
  assert.equal(result.label, '→ this-is-a-very…');
  assert.equal(result.show, true);
  assert.equal(result.kind, 'cwd');
});

test('describeColumnTarget: bare drive root has no meaningful leaf, falls back to full normalised cwd', () => {
  assert.deepStrictEqual(
    describeColumnTarget({
      cwd: 'C:/',
      projectRoot: 'D:/other',
      cwdSource: 'manual',
    }),
    {
      show: true,
      kind: 'cwd',
      label: '→ c:',
      title: 'Working directory: C:/',
    }
  );
});
