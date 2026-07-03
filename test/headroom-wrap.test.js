'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { applyHeadroomWrap } = require('../lib/headroom-wrap');

test('enabled, cmd undefined, wraps claude with args after --', () => {
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: undefined,
    args: ['--model', 'opus'],
    hasEndpoint: false,
  });
  assert.deepStrictEqual(result, {
    cmd: 'headroom',
    args: ['wrap', 'claude', '--', '--model', 'opus'],
  });
});

test('enabled, cmd "claude", wraps with originals after --', () => {
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: 'claude',
    args: ['--resume', 'x'],
    hasEndpoint: false,
  });
  assert.deepStrictEqual(result, {
    cmd: 'headroom',
    args: ['wrap', 'claude', '--', '--resume', 'x'],
  });
});

test('enabled but hasEndpoint true -> passthrough unchanged', () => {
  const args = ['--model', 'opus'];
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: 'claude',
    args,
    hasEndpoint: true,
  });
  assert.deepStrictEqual(result, { cmd: 'claude', args });
  assert.strictEqual(result.args, args);
});

test('enabled but cmd is an arbitrary command -> passthrough', () => {
  const args = ['-c', 'echo hi'];
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: 'bash',
    args,
    hasEndpoint: false,
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

test('enabled with empty args array -> wrap with just --', () => {
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: 'claude',
    args: [],
    hasEndpoint: false,
  });
  assert.deepStrictEqual(result, {
    cmd: 'headroom',
    args: ['wrap', 'claude', '--'],
  });
});

test('enabled with undefined args -> wrap with just --', () => {
  const result = applyHeadroomWrap({
    enabled: true,
    cmd: undefined,
    args: undefined,
    hasEndpoint: false,
  });
  assert.deepStrictEqual(result, {
    cmd: 'headroom',
    args: ['wrap', 'claude', '--'],
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
  });
  assert.deepStrictEqual(args, snapshot);
});
