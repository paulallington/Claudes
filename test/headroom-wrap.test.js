'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { applyHeadroomWrap } = require('../lib/headroom-wrap');

// The app owns a single persistent Headroom proxy; wrapped columns must only
// ever REUSE it (--no-proxy), never run the detect-or-start path. --1m is a
// claude-side flag added when the caller asks for the 1M context window.

test('enabled, cmd undefined, wraps claude with --no-proxy and args after --', () => {
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: undefined,
    args: ['--model', 'opus'],
    hasEndpoint: false,
  });
  assert.deepStrictEqual(result, {
    cmd: 'headroom',
    args: ['wrap', 'claude', '--no-proxy', '--', '--model', 'opus'],
  });
});

test('enabled, cmd "claude", wraps with --no-proxy + originals after --', () => {
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: 'claude',
    args: ['--resume', 'x'],
    hasEndpoint: false,
  });
  assert.deepStrictEqual(result, {
    cmd: 'headroom',
    args: ['wrap', 'claude', '--no-proxy', '--', '--resume', 'x'],
  });
});

test('oneM true -> --1m after --no-proxy, before --', () => {
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: 'claude',
    args: ['--resume', 'x'],
    hasEndpoint: false,
    oneM: true,
  });
  assert.deepStrictEqual(result, {
    cmd: 'headroom',
    args: ['wrap', 'claude', '--no-proxy', '--1m', '--', '--resume', 'x'],
  });
});

test('oneM false -> no --1m', () => {
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: 'claude',
    args: [],
    hasEndpoint: false,
    oneM: false,
  });
  assert.deepStrictEqual(result, {
    cmd: 'headroom',
    args: ['wrap', 'claude', '--no-proxy', '--'],
  });
});

test('enabled but hasEndpoint true -> passthrough unchanged (oneM ignored)', () => {
  const args = ['--model', 'opus'];
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: 'claude',
    args,
    hasEndpoint: true,
    oneM: true,
  });
  assert.deepStrictEqual(result, { cmd: 'claude', args });
  assert.strictEqual(result.args, args);
});

test('enabled but cmd is an arbitrary command -> passthrough (oneM ignored)', () => {
  const args = ['-c', 'echo hi'];
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: 'bash',
    args,
    hasEndpoint: false,
    oneM: true,
  });
  assert.deepStrictEqual(result, { cmd: 'bash', args });
  assert.strictEqual(result.args, args);
});

test('enabled === false -> passthrough', () => {
  const args = ['--model', 'opus'];
  const result = applyHeadroomWrap({
    enabled: false,
    cmd: 'claude',
    args,
    hasEndpoint: false,
  });
  assert.deepStrictEqual(result, { cmd: 'claude', args });
  assert.strictEqual(result.args, args);
});

test('passthrough returns args exactly as received (undefined stays undefined)', () => {
  const result = applyHeadroomWrap({
    enabled: false,
    cmd: 'claude',
    args: undefined,
    hasEndpoint: false,
  });
  assert.deepStrictEqual(result, { cmd: 'claude', args: undefined });
});

test('enabled with empty args array -> wrap with --no-proxy + --', () => {
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: 'claude',
    args: [],
    hasEndpoint: false,
  });
  assert.deepStrictEqual(result, {
    cmd: 'headroom',
    args: ['wrap', 'claude', '--no-proxy', '--'],
  });
});

test('enabled with undefined args -> wrap with --no-proxy + --', () => {
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: undefined,
    args: undefined,
    hasEndpoint: false,
  });
  assert.deepStrictEqual(result, {
    cmd: 'headroom',
    args: ['wrap', 'claude', '--no-proxy', '--'],
  });
});

test('input args array is not mutated', () => {
  const args = ['--model', 'opus'];
  const snapshot = args.slice();
  applyHeadroomWrap({
    enabled: true,
    cmd: 'claude',
    args,
    hasEndpoint: false,
    oneM: true,
  });
  assert.deepStrictEqual(args, snapshot);
});
