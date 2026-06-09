'use strict';

// Tests for the pure arg-surgery behind buildResumeArgs (renderer.js). The
// renderer wrapper computes isLocal, calls buildResumeArgsBase, then pipes the
// result through rewriteArgsForEndpoint (which strips --bare on cloud etc.).
// These tests cover the surgery layer: preserve prior cmdArgs, swap effort/resume.

const { test } = require('node:test');
const assert = require('node:assert');
const { buildResumeArgsBase } = require('../lib/effort-relaunch');

function idx(args, flag) { return args.indexOf(flag); }
function count(args, flag) { return args.filter(function (a) { return a === flag; }).length; }

test('preserves yolo (--dangerously-skip-permissions) across an effort change', () => {
  const col = { cmdArgs: ['--dangerously-skip-permissions', '--effort', 'high'], effort: 'max', sessionId: 'sid' };
  const out = buildResumeArgsBase(col, false, 'medium');
  assert.deepStrictEqual(out, ['--dangerously-skip-permissions', '--effort', 'max', '--resume', 'sid']);
});

test('preserves --permission-mode <mode> across an effort change', () => {
  const col = { cmdArgs: ['--permission-mode', 'plan', '--effort', 'high'], effort: 'low', sessionId: 'sid' };
  const out = buildResumeArgsBase(col, false, 'medium');
  const p = idx(out, '--permission-mode');
  assert.ok(p !== -1 && out[p + 1] === 'plan', 'permission-mode plan preserved');
  assert.strictEqual(count(out, '--effort'), 1);
  assert.strictEqual(out[idx(out, '--effort') + 1], 'low');
});

test('preserves all other spawn flags (bare, strip-mcps, model, remote-control)', () => {
  const col = {
    cmdArgs: ['--dangerously-skip-permissions', '--remote-control', '--bare',
              '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
              '--model', 'opus', '--effort', 'high', '--resume', 'old'],
    effort: 'max', sessionId: 'new'
  };
  const out = buildResumeArgsBase(col, false, 'medium');
  ['--dangerously-skip-permissions', '--remote-control', '--bare', '--strict-mcp-config'].forEach(function (f) {
    assert.ok(out.indexOf(f) !== -1, f + ' preserved');
  });
  assert.strictEqual(out[idx(out, '--mcp-config') + 1], '{"mcpServers":{}}', 'mcp-config value preserved');
  assert.strictEqual(out[idx(out, '--model') + 1], 'opus', 'model preserved');
  assert.strictEqual(count(out, '--effort'), 1);
  assert.strictEqual(out[idx(out, '--effort') + 1], 'max');
  assert.strictEqual(count(out, '--resume'), 1);
  assert.strictEqual(out[idx(out, '--resume') + 1], 'new');
});

test('strips --worktree (must never be repeated on a resume)', () => {
  const col = { cmdArgs: ['--worktree', 'feature-x', '--dangerously-skip-permissions', '--effort', 'high'], effort: 'low', sessionId: 's' };
  const out = buildResumeArgsBase(col, false, 'medium');
  assert.strictEqual(out.indexOf('--worktree'), -1, 'no --worktree');
  assert.strictEqual(out.indexOf('feature-x'), -1, 'no worktree value');
  assert.ok(out.indexOf('--dangerously-skip-permissions') !== -1, 'permission still preserved');
});

test('effort comes before --resume (matches the working startup order)', () => {
  const col = { cmdArgs: ['--bare'], effort: 'high', sessionId: 'sid' };
  const out = buildResumeArgsBase(col, false, 'medium');
  assert.ok(idx(out, '--effort') < idx(out, '--resume'), 'effort precedes resume');
});

test('ultracode (cloud) encodes as --effort xhigh + ultracode --settings', () => {
  const col = { cmdArgs: ['--bare'], effort: 'ultracode', sessionId: 'sid' };
  const out = buildResumeArgsBase(col, false, 'medium');
  assert.ok(out.indexOf('--bare') !== -1, 'bare preserved');
  assert.strictEqual(out[idx(out, '--effort') + 1], 'xhigh');
  const s = idx(out, '--settings');
  assert.ok(s !== -1 && /ultracode/.test(out[s + 1]), 'ultracode settings emitted');
});

test('leaving ultracode strips the prior ultracode --settings', () => {
  const col = {
    cmdArgs: ['--effort', 'xhigh', '--settings', '{"ultracode":true,"enableWorkflows":true}', '--dangerously-skip-permissions'],
    effort: 'high', sessionId: 'sid'
  };
  const out = buildResumeArgsBase(col, false, 'medium');
  assert.strictEqual(out.indexOf('--settings'), -1, 'old ultracode --settings removed');
  assert.strictEqual(out.indexOf('xhigh'), -1, 'old xhigh value removed');
  assert.strictEqual(out[idx(out, '--effort') + 1], 'high');
  assert.ok(out.indexOf('--dangerously-skip-permissions') !== -1, 'permission preserved');
});

test('local ultracode degrades to defaultEffortLocal and emits no --settings', () => {
  const col = { cmdArgs: ['--bare', '--strict-mcp-config'], effort: 'ultracode', sessionId: 'sid' };
  const out = buildResumeArgsBase(col, true, 'medium');
  assert.ok(out.indexOf('--bare') !== -1 && out.indexOf('--strict-mcp-config') !== -1, 'local flags preserved');
  assert.strictEqual(out[idx(out, '--effort') + 1], 'medium');
  assert.strictEqual(out.indexOf('--settings'), -1, 'no ultracode settings on local');
});

test('no sessionId => no --resume', () => {
  const col = { cmdArgs: ['--dangerously-skip-permissions'], effort: 'high', sessionId: null };
  const out = buildResumeArgsBase(col, false, 'medium');
  assert.strictEqual(out.indexOf('--resume'), -1);
  assert.deepStrictEqual(out, ['--dangerously-skip-permissions', '--effort', 'high']);
});

test('missing cmdArgs is handled gracefully', () => {
  const out = buildResumeArgsBase({ effort: 'high', sessionId: 's' }, false, 'medium');
  assert.deepStrictEqual(out, ['--effort', 'high', '--resume', 's']);
});

test('round-trips: prior args already had effort+resume yields exactly one of each', () => {
  const col = { cmdArgs: ['--effort', 'high', '--resume', 'old', '--dangerously-skip-permissions'], effort: 'max', sessionId: 'new' };
  const out = buildResumeArgsBase(col, false, 'medium');
  assert.strictEqual(count(out, '--effort'), 1);
  assert.strictEqual(count(out, '--resume'), 1);
  assert.strictEqual(out[idx(out, '--effort') + 1], 'max');
  assert.strictEqual(out[idx(out, '--resume') + 1], 'new');
  assert.ok(out.indexOf('--dangerously-skip-permissions') !== -1);
});

test('strips a leaked --session-id <uuid> from prior args (flag + value)', () => {
  const col = {
    cmdArgs: ['--dangerously-skip-permissions', '--session-id', 'abcd-1234-uuid', '--effort', 'high'],
    effort: 'max', sessionId: 'abcd-1234-uuid'
  };
  const out = buildResumeArgsBase(col, false, 'medium');
  assert.strictEqual(out.indexOf('--session-id'), -1, 'no --session-id flag');
  assert.strictEqual(out.indexOf('abcd-1234-uuid'), idx(out, '--resume') + 1, 'uuid only appears as --resume value');
  assert.ok(out.indexOf('--dangerously-skip-permissions') !== -1, 'permission preserved');
});

test('a combined --session-id + --resume input yields only the rebuilt --resume', () => {
  const col = {
    cmdArgs: ['--session-id', 'sid', '--resume', 'sid', '--bare'],
    effort: 'high', sessionId: 'sid'
  };
  const out = buildResumeArgsBase(col, false, 'medium');
  assert.strictEqual(out.indexOf('--session-id'), -1, 'no --session-id');
  assert.strictEqual(count(out, '--resume'), 1, 'exactly one --resume');
  assert.strictEqual(out[idx(out, '--resume') + 1], 'sid');
  assert.ok(out.indexOf('--bare') !== -1, 'bare preserved');
});

test('a stripped flag at end-of-array (no value) does not crash or leak', () => {
  const col = { cmdArgs: ['--dangerously-skip-permissions', '--worktree'], effort: 'high', sessionId: 'sid' };
  const out = buildResumeArgsBase(col, false, 'medium');
  assert.strictEqual(out.indexOf('--worktree'), -1, 'trailing --worktree stripped');
  assert.deepStrictEqual(out, ['--dangerously-skip-permissions', '--effort', 'high', '--resume', 'sid']);
});
