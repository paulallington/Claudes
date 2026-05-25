const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectActiveWorktree, normalizePath } = require('../lib/worktree-detect');

const wts = [
  { path: 'D:/Repos/copilot-studio-ux', branch: 'refs/heads/main' },
  { path: 'D:/Repos/wt/csux/826-l2-detail', branch: 'refs/heads/feat/826-l2-tool-detail' },
  { path: 'D:/Repos/wt/csux/753-disconnect', branch: 'refs/heads/feat/disconnect-more-apps-753' },
];

test('detectActiveWorktree: returns null when no jsonl content', () => {
  assert.equal(detectActiveWorktree('', wts), null);
  assert.equal(detectActiveWorktree(null, wts), null);
});

test('detectActiveWorktree: returns null when no worktrees', () => {
  assert.equal(detectActiveWorktree('cd D:/Repos/wt/csux/826-l2-detail', []), null);
});

test('detectActiveWorktree: returns null when below 3-hit threshold', () => {
  // single cd is not "dominant" — could be incidental
  const c = `"command":"cd D:/Repos/wt/csux/826-l2-detail && ls"`;
  assert.equal(detectActiveWorktree(c, wts), null);
});

test('detectActiveWorktree: detects dominant worktree from cd commands', () => {
  const c = [
    `"command":"cd D:/Repos/wt/csux/826-l2-detail && git status"`,
    `"command":"cd D:/Repos/wt/csux/826-l2-detail && git log"`,
    `"command":"cd D:/Repos/wt/csux/826-l2-detail && pnpm test"`,
    `"command":"cd D:/Repos/wt/csux/826-l2-detail && git commit"`,
  ].join('\n');
  const r = detectActiveWorktree(c, wts);
  assert.deepEqual(r, { path: 'D:/Repos/wt/csux/826-l2-detail', branch: 'refs/heads/feat/826-l2-tool-detail', hits: 4 });
});

test('detectActiveWorktree: detects dominant worktree from file_path entries', () => {
  const c = [
    `"file_path":"D:/Repos/wt/csux/753-disconnect/src/foo.ts"`,
    `"file_path":"D:/Repos/wt/csux/753-disconnect/src/bar.ts"`,
    `"file_path":"D:/Repos/wt/csux/753-disconnect/test/baz.test.ts"`,
  ].join('\n');
  const r = detectActiveWorktree(c, wts);
  assert.equal(r && r.path, 'D:/Repos/wt/csux/753-disconnect');
  assert.equal(r && r.branch, 'refs/heads/feat/disconnect-more-apps-753');
});

test('detectActiveWorktree: picks the worktree with the most hits when several appear', () => {
  // 5 hits in 826, 2 in 753 → 826 wins
  const c = [
    `"file_path":"D:/Repos/wt/csux/826-l2-detail/a"`,
    `"file_path":"D:/Repos/wt/csux/826-l2-detail/b"`,
    `"file_path":"D:/Repos/wt/csux/826-l2-detail/c"`,
    `"command":"cd D:/Repos/wt/csux/826-l2-detail && x"`,
    `"command":"cd D:/Repos/wt/csux/826-l2-detail && y"`,
    `"file_path":"D:/Repos/wt/csux/753-disconnect/x"`,
    `"file_path":"D:/Repos/wt/csux/753-disconnect/y"`,
  ].join('\n');
  const r = detectActiveWorktree(c, wts);
  assert.equal(r && r.path, 'D:/Repos/wt/csux/826-l2-detail');
});

test('detectActiveWorktree: case-insensitive drive letter matching', () => {
  const wts2 = [{ path: 'D:/Repos/foo', branch: 'refs/heads/main' }];
  const c = [
    `"command":"cd d:/Repos/foo/x && z"`,
    `"file_path":"D:/Repos/foo/a"`,
    `"file_path":"d:/Repos/foo/b"`,
  ].join('\n');
  const r = detectActiveWorktree(c, wts2);
  assert.equal(r && r.path, 'D:/Repos/foo');
});

test('normalizePath: strips trailing slash and forward-converts', () => {
  assert.equal(normalizePath('D:\\Repos\\foo\\'), 'd:/Repos/foo');
  assert.equal(normalizePath('D:/Repos/foo'), 'd:/Repos/foo');
});

test('detectActiveWorktree: handles JSON-escaped backslash paths in file_path', () => {
  // Real session JSONL stores file_path with escaped backslashes (literal \\ pairs on disk).
  // Each "\\\\" in this JS source = 4 backslash chars in the test string = 2 backslash chars
  // when the regex /"file_path":"([^"]+)"/ captures the value — same shape as on-disk JSONL.
  const c = [
    `"file_path":"D:\\\\Repos\\\\wt\\\\csux\\\\753-disconnect\\\\src\\\\foo.ts"`,
    `"file_path":"D:\\\\Repos\\\\wt\\\\csux\\\\753-disconnect\\\\src\\\\bar.ts"`,
    `"file_path":"D:\\\\Repos\\\\wt\\\\csux\\\\753-disconnect\\\\test\\\\baz.test.ts"`,
  ].join('\n');
  const r = detectActiveWorktree(c, wts);
  assert.equal(r && r.path, 'D:/Repos/wt/csux/753-disconnect');
  assert.equal(r && r.branch, 'refs/heads/feat/disconnect-more-apps-753');
});

test('normalizePath: collapses JSON-escaped double backslashes', () => {
  // String contains literal \\ pairs (4 backslash chars in JS source = 2 chars in the string).
  assert.equal(normalizePath('D:\\\\Repos\\\\foo\\\\bar'), 'd:/Repos/foo/bar');
});
