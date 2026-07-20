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

test('describeColumnTarget: isDiff + auto-worktree binding gives an accurate diff title', () => {
  assert.deepStrictEqual(
    describeColumnTarget({
      cwd: '/home/paul/worktrees/feature-x',
      projectRoot: '/home/paul/project',
      cwdSource: 'auto-worktree',
      isDiff: true,
    }),
    {
      show: true,
      kind: 'worktree',
      label: '⎇ feature-x',
      title: 'Diff target: /home/paul/worktrees/feature-x',
    }
  );
});

test('describeColumnTarget: isDiff + manual cwd binding gives an accurate diff title', () => {
  assert.deepStrictEqual(
    describeColumnTarget({
      cwd: '/home/paul/subdir',
      projectRoot: '/home/paul/project',
      cwdSource: 'manual',
      isDiff: true,
    }),
    {
      show: true,
      kind: 'cwd',
      label: '→ subdir',
      title: 'Diff target: /home/paul/subdir',
    }
  );
});

test('describeColumnTarget: isDiff with no binding still returns the empty shape', () => {
  assert.deepStrictEqual(
    describeColumnTarget({ cwd: null, projectRoot: '/project', cwdSource: undefined, isDiff: true }),
    { show: false, kind: null, label: '', title: '' }
  );
  assert.deepStrictEqual(
    describeColumnTarget({ cwd: '/project', projectRoot: '/project', cwdSource: 'auto-worktree', isDiff: true }),
    { show: false, kind: null, label: '', title: '' }
  );
});

test('describeColumnTarget: regression — non-diff auto-worktree title unchanged', () => {
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

test('describeColumnTarget: leaf with an astral character is truncated on code-point boundaries, not mid-surrogate-pair', () => {
  // 13 ASCII chars + one astral emoji (2 UTF-16 code units) + 5 more ASCII
  // chars = 19 code points / 20 UTF-16 units. A naive .slice(0, 14) on
  // code units would land inside the emoji's surrogate pair (13 ASCII +
  // 1 lone high surrogate), corrupting it into a replacement glyph.
  const leaf = 'a'.repeat(13) + '\u{1F680}' + 'b'.repeat(5);
  const result = describeColumnTarget({
    cwd: '/home/paul/' + leaf,
    projectRoot: '/home/paul/project',
    cwdSource: 'manual',
  });
  assert.equal(result.label, '→ ' + 'a'.repeat(13) + '\u{1F680}' + '…');
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
