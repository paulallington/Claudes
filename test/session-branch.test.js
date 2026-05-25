const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findLastGitBranch } = require('../lib/session-branch');

test('findLastGitBranch: empty content -> null', () => {
  assert.equal(findLastGitBranch(''), null);
});

test('findLastGitBranch: null/undefined -> null', () => {
  assert.equal(findLastGitBranch(null), null);
  assert.equal(findLastGitBranch(undefined), null);
});

test('findLastGitBranch: no gitBranch field -> null', () => {
  const content = '{"type":"user","message":"hello"}\n{"type":"assistant","message":"hi"}';
  assert.equal(findLastGitBranch(content), null);
});

test('findLastGitBranch: single gitBranch entry -> returns it', () => {
  const content = '{"type":"assistant","gitBranch":"main","message":"hi"}';
  assert.equal(findLastGitBranch(content), 'main');
});

test('findLastGitBranch: multiple gitBranch entries -> returns the LAST one', () => {
  const content =
    '{"type":"assistant","gitBranch":"main","message":"a"}\n' +
    '{"type":"assistant","gitBranch":"feature/foo","message":"b"}\n' +
    '{"type":"assistant","gitBranch":"fix/pr-review-findings","message":"c"}';
  assert.equal(findLastGitBranch(content), 'fix/pr-review-findings');
});

test('findLastGitBranch: empty-string gitBranch value -> null', () => {
  const content = '{"type":"assistant","gitBranch":"","message":"hi"}';
  assert.equal(findLastGitBranch(content), null);
});

test('findLastGitBranch: empty-string LAST among non-empty -> null (last wins)', () => {
  const content =
    '{"type":"assistant","gitBranch":"main","message":"a"}\n' +
    '{"type":"assistant","gitBranch":"","message":"b"}';
  assert.equal(findLastGitBranch(content), null);
});

test('findLastGitBranch: content with quotes in other fields, no gitBranch -> null', () => {
  const content = '{"type":"assistant","message":"he said \\"hello\\" there","cwd":"C:\\\\path"}';
  assert.equal(findLastGitBranch(content), null);
});

test('findLastGitBranch: branch name with slashes preserved', () => {
  const content = '{"gitBranch":"users/foo/bar-baz"}';
  assert.equal(findLastGitBranch(content), 'users/foo/bar-baz');
});
