const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveWorktreeCandidates, pathIsDirectory } = require('../lib/path-utils');

const fakeStat = (existsAs) => async (p) => {
  if (!existsAs.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
  return { isDirectory: () => existsAs.get(p) === 'dir' };
};

test('resolveWorktreeCandidates: empty value -> none', async () => {
  assert.deepEqual(await resolveWorktreeCandidates('/proj', '', fakeStat(new Map())), { kind: 'none' });
});
test('resolveWorktreeCandidates: absolute path that exists -> cwd', async () => {
  const stat = fakeStat(new Map([['/wt/foo', 'dir']]));
  assert.deepEqual(await resolveWorktreeCandidates('/proj', '/wt/foo', stat), { kind: 'cwd', path: '/wt/foo' });
});
test('resolveWorktreeCandidates: relative path resolves under projectPath', async () => {
  const path = require('path');
  const subPath = path.join('/proj', 'sub');
  const stat = fakeStat(new Map([[subPath, 'dir']]));
  assert.deepEqual(await resolveWorktreeCandidates('/proj', 'sub', stat), { kind: 'cwd', path: subPath });
});
test('resolveWorktreeCandidates: name resolves under .claude/worktrees/', async () => {
  const wtPath = require('path').join('/proj', '.claude', 'worktrees', 'feat');
  const stat = fakeStat(new Map([[wtPath, 'dir']]));
  assert.deepEqual(await resolveWorktreeCandidates('/proj', 'feat', stat), { kind: 'cwd', path: wtPath });
});
test('resolveWorktreeCandidates: file (not dir) falls through to flag', async () => {
  const stat = fakeStat(new Map([['/proj/notes.txt', 'file']]));
  assert.deepEqual(await resolveWorktreeCandidates('/proj', 'notes.txt', stat), { kind: 'flag', name: 'notes.txt' });
});
test('resolveWorktreeCandidates: nothing resolves -> flag', async () => {
  assert.deepEqual(await resolveWorktreeCandidates('/proj', 'nope', fakeStat(new Map())), { kind: 'flag', name: 'nope' });
});

test('resolveWorktreeCandidates: matches by branch (refs/heads/x)', async () => {
  const wtPath = require('path').join('/wt', 'feat');
  const stat = fakeStat(new Map([[wtPath, 'dir']]));
  const list = async () => [{ path: wtPath, branch: 'refs/heads/feat' }];
  assert.deepEqual(
    await resolveWorktreeCandidates('/proj', 'feat', stat, list),
    { kind: 'cwd', path: wtPath }
  );
});
test('resolveWorktreeCandidates: matches by path basename', async () => {
  const wtPath = require('path').join('/some', 'where', '750-picker');
  const stat = fakeStat(new Map([[wtPath, 'dir']]));
  const list = async () => [{ path: wtPath, branch: 'refs/heads/something-else' }];
  assert.deepEqual(
    await resolveWorktreeCandidates('/proj', '750-picker', stat, list),
    { kind: 'cwd', path: wtPath }
  );
});
test('resolveWorktreeCandidates: re-stats hit, dropping stale entries', async () => {
  const wtPath = require('path').join('/wt', 'gone');
  const stat = fakeStat(new Map());
  const list = async () => [{ path: wtPath, branch: 'refs/heads/gone' }];
  assert.deepEqual(
    await resolveWorktreeCandidates('/proj', 'gone', stat, list),
    { kind: 'flag', name: 'gone' }
  );
});
test('resolveWorktreeCandidates: no list fn → original behavior', async () => {
  assert.deepEqual(
    await resolveWorktreeCandidates('/proj', 'unknown', fakeStat(new Map())),
    { kind: 'flag', name: 'unknown' }
  );
});

test('pathIsDirectory: empty -> false', async () => {
  assert.equal(await pathIsDirectory('', fakeStat(new Map())), false);
});
test('pathIsDirectory: directory -> true', async () => {
  assert.equal(await pathIsDirectory('/x', fakeStat(new Map([['/x', 'dir']]))), true);
});
test('pathIsDirectory: file -> false', async () => {
  assert.equal(await pathIsDirectory('/x', fakeStat(new Map([['/x', 'file']]))), false);
});
test('pathIsDirectory: missing -> false', async () => {
  assert.equal(await pathIsDirectory('/missing', fakeStat(new Map())), false);
});
