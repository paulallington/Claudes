const test = require('node:test');
const assert = require('node:assert/strict');
const { isUsableSessionTarget, shouldBindHookSession, resolveInputColumn, resolveSessionLookupCwd } = require('../lib/session-target');

test('isUsableSessionTarget is true only for a session with size > 0', () => {
  assert.equal(isUsableSessionTarget({ size: 1 }), true);
  assert.equal(isUsableSessionTarget({ size: 4096 }), true);
});

test('isUsableSessionTarget is false for empty/missing size', () => {
  assert.equal(isUsableSessionTarget({ size: 0 }), false);
  assert.equal(isUsableSessionTarget({ size: undefined }), false);
  assert.equal(isUsableSessionTarget({ size: null }), false);
  assert.equal(isUsableSessionTarget({}), false);
  assert.equal(isUsableSessionTarget(null), false);
  assert.equal(isUsableSessionTarget(undefined), false);
});

test('shouldBindHookSession binds on a cwd UserPromptSubmit with a new session id', () => {
  assert.equal(
    shouldBindHookSession({ via: 'cwd', isUserPromptSubmit: true, eventSessionId: 'new', colSessionId: 'old', claimedBySibling: false }),
    true
  );
});

test('shouldBindHookSession binds on an input UserPromptSubmit with a new unclaimed session id', () => {
  assert.equal(
    shouldBindHookSession({ via: 'input', isUserPromptSubmit: true, eventSessionId: 'new', colSessionId: 'old', claimedBySibling: false }),
    true
  );
});

test('shouldBindHookSession does not bind on a cwd match that is not UserPromptSubmit', () => {
  assert.equal(
    shouldBindHookSession({ via: 'cwd', isUserPromptSubmit: false, eventSessionId: 'new', colSessionId: 'old', claimedBySibling: false }),
    false
  );
});

test('shouldBindHookSession does not bind on a sid match', () => {
  assert.equal(
    shouldBindHookSession({ via: 'sid', isUserPromptSubmit: true, eventSessionId: 'new', colSessionId: 'old', claimedBySibling: false }),
    false
  );
});

test('shouldBindHookSession does not bind when the target id is claimed by a sibling', () => {
  assert.equal(
    shouldBindHookSession({ via: 'input', isUserPromptSubmit: true, eventSessionId: 'new', colSessionId: 'old', claimedBySibling: true }),
    false
  );
});

test('shouldBindHookSession does not bind without an event session id', () => {
  assert.equal(
    shouldBindHookSession({ via: 'cwd', isUserPromptSubmit: true, eventSessionId: '', colSessionId: 'old', claimedBySibling: false }),
    false
  );
  assert.equal(
    shouldBindHookSession({ via: 'cwd', isUserPromptSubmit: true, eventSessionId: null, colSessionId: 'old', claimedBySibling: false }),
    false
  );
});

test('shouldBindHookSession does not bind when the session id is unchanged', () => {
  assert.equal(
    shouldBindHookSession({ via: 'cwd', isUserPromptSubmit: true, eventSessionId: 'same', colSessionId: 'same', claimedBySibling: false }),
    false
  );
});

test('resolveInputColumn picks the dominant recent-input column', () => {
  const now = 10000;
  const candidates = [
    { colId: 'a', lastInputAt: now - 200 },
    { colId: 'b', lastInputAt: now - 4000 },
  ];
  assert.equal(resolveInputColumn(candidates, now), 'a');
});

test('resolveInputColumn returns null on a tie within the gap', () => {
  const now = 10000;
  const candidates = [
    { colId: 'a', lastInputAt: now - 200 },
    { colId: 'b', lastInputAt: now - 1000 },
  ];
  assert.equal(resolveInputColumn(candidates, now), null);
});

test('resolveInputColumn returns null when the top is stale (>= windowMs)', () => {
  const now = 10000;
  const candidates = [
    { colId: 'a', lastInputAt: now - 5000 },
    { colId: 'b', lastInputAt: now - 9000 },
  ];
  assert.equal(resolveInputColumn(candidates, now), null);
});

test('resolveInputColumn returns null for an empty list', () => {
  assert.equal(resolveInputColumn([], 10000), null);
  assert.equal(resolveInputColumn(null, 10000), null);
});

test('resolveInputColumn picks a single recent candidate', () => {
  const now = 10000;
  assert.equal(resolveInputColumn([{ colId: 'a', lastInputAt: now - 500 }], now), 'a');
});

test('resolveInputColumn returns null for a single stale candidate', () => {
  const now = 10000;
  assert.equal(resolveInputColumn([{ colId: 'a', lastInputAt: now - 6000 }], now), null);
});

test('resolveSessionLookupCwd redirects auto-worktree bindings to the project root', () => {
  assert.equal(
    resolveSessionLookupCwd({ cwd: '/proj/.worktrees/foo', cwdSource: 'auto-worktree' }, '/proj'),
    '/proj'
  );
});

test('resolveSessionLookupCwd uses the entry cwd for a manual binding', () => {
  assert.equal(
    resolveSessionLookupCwd({ cwd: '/proj/sub', cwdSource: 'manual' }, '/proj'),
    '/proj/sub'
  );
});

test('resolveSessionLookupCwd uses the entry cwd when cwdSource is unset', () => {
  assert.equal(
    resolveSessionLookupCwd({ cwd: '/proj/sub' }, '/proj'),
    '/proj/sub'
  );
});

test('resolveSessionLookupCwd falls back to projectRoot when there is no cwd', () => {
  assert.equal(resolveSessionLookupCwd({}, '/proj'), '/proj');
  assert.equal(resolveSessionLookupCwd({ cwd: null }, '/proj'), '/proj');
});

test('resolveSessionLookupCwd falls back to projectRoot for a null/undefined entry', () => {
  assert.equal(resolveSessionLookupCwd(null, '/proj'), '/proj');
  assert.equal(resolveSessionLookupCwd(undefined, '/proj'), '/proj');
});
