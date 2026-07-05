'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildHeadroomEnv } = require('../lib/headroom-env');

test('enabled claude column -> base URL + tool search', () => {
  const env = buildHeadroomEnv({ enabled: true, hasEndpoint: false });
  assert.deepStrictEqual(env, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
    ENABLE_TOOL_SEARCH: 'true',
  });
});

test('oneM adds ANTHROPIC_MODEL=<model>[1m]', () => {
  const env = buildHeadroomEnv({ enabled: true, hasEndpoint: false, oneM: true, oneMModel: 'claude-opus-4-8' });
  assert.strictEqual(env.ANTHROPIC_MODEL, 'claude-opus-4-8[1m]');
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787');
});

test('oneM without a model does not set ANTHROPIC_MODEL', () => {
  const env = buildHeadroomEnv({ enabled: true, hasEndpoint: false, oneM: true });
  assert.ok(!('ANTHROPIC_MODEL' in env));
});

test('custom port is honored', () => {
  const env = buildHeadroomEnv({ enabled: true, hasEndpoint: false, port: 9191 });
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9191');
});

test('invalid port falls back to 8787', () => {
  assert.strictEqual(buildHeadroomEnv({ enabled: true, port: 0 }).ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787');
  assert.strictEqual(buildHeadroomEnv({ enabled: true, port: 99999 }).ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787');
});

test('disabled -> null (spawn plainly)', () => {
  assert.strictEqual(buildHeadroomEnv({ enabled: false }), null);
});

test('local endpoint present -> null (endpoint owns the base URL)', () => {
  assert.strictEqual(buildHeadroomEnv({ enabled: true, hasEndpoint: true }), null);
});

test('arbitrary-command column (isClaude false) -> null', () => {
  assert.strictEqual(buildHeadroomEnv({ enabled: true, hasEndpoint: false, isClaude: false }), null);
});

test('no input -> null (safe)', () => {
  assert.strictEqual(buildHeadroomEnv(), null);
  assert.strictEqual(buildHeadroomEnv({}), null);
});
