'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildHeadroomEnv, buildHeadroomProxyArgs } = require('../lib/headroom-env');

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

const DEFAULT_TIMEOUT_RETRY_TAIL = [
  '--request-timeout-seconds', '900',
  '--anthropic-buffered-request-timeout-seconds', '900',
  '--retry-max-attempts', '5',
];

test('proxy args: absent mode falls back to cache (subscription-safe default)', () => {
  assert.deepStrictEqual(buildHeadroomProxyArgs({}, 8787), ['proxy', '--port', '8787', '--no-http2', '--mode', 'cache', ...DEFAULT_TIMEOUT_RETRY_TAIL]);
  assert.deepStrictEqual(buildHeadroomProxyArgs(undefined, 8787), ['proxy', '--port', '8787', '--no-http2', '--mode', 'cache', ...DEFAULT_TIMEOUT_RETRY_TAIL]);
});

test('proxy args: cache mode -> --mode cache', () => {
  assert.deepStrictEqual(buildHeadroomProxyArgs({ headroomMode: 'cache' }, 8787), ['proxy', '--port', '8787', '--no-http2', '--mode', 'cache', ...DEFAULT_TIMEOUT_RETRY_TAIL]);
});

test('proxy args: token mode -> --mode token', () => {
  assert.deepStrictEqual(buildHeadroomProxyArgs({ headroomMode: 'token' }, 8787), ['proxy', '--port', '8787', '--no-http2', '--mode', 'token', ...DEFAULT_TIMEOUT_RETRY_TAIL]);
});

test('proxy args: off mode -> --no-optimize (no --mode)', () => {
  assert.deepStrictEqual(buildHeadroomProxyArgs({ headroomMode: 'off' }, 8787), ['proxy', '--port', '8787', '--no-http2', '--no-optimize', ...DEFAULT_TIMEOUT_RETRY_TAIL]);
});

test('proxy args: unknown mode falls back to cache', () => {
  assert.deepStrictEqual(buildHeadroomProxyArgs({ headroomMode: 'bogus' }, 8787), ['proxy', '--port', '8787', '--no-http2', '--mode', 'cache', ...DEFAULT_TIMEOUT_RETRY_TAIL]);
});

test('proxy args: memory adds --memory before the mode flag', () => {
  assert.deepStrictEqual(buildHeadroomProxyArgs({ useHeadroomMemory: true, headroomMode: 'token' }, 8787),
    ['proxy', '--port', '8787', '--no-http2', '--memory', '--mode', 'token', ...DEFAULT_TIMEOUT_RETRY_TAIL]);
});

test('proxy args: memory + off -> --memory --no-optimize', () => {
  assert.deepStrictEqual(buildHeadroomProxyArgs({ useHeadroomMemory: true, headroomMode: 'off' }, 8787),
    ['proxy', '--port', '8787', '--no-http2', '--memory', '--no-optimize', ...DEFAULT_TIMEOUT_RETRY_TAIL]);
});

test('proxy args: mode is case-insensitive', () => {
  assert.deepStrictEqual(buildHeadroomProxyArgs({ headroomMode: 'TOKEN' }, 8787), ['proxy', '--port', '8787', '--no-http2', '--mode', 'token', ...DEFAULT_TIMEOUT_RETRY_TAIL]);
});

test('proxy args: invalid port falls back to 8787', () => {
  assert.deepStrictEqual(buildHeadroomProxyArgs({}, 0), ['proxy', '--port', '8787', '--no-http2', '--mode', 'cache', ...DEFAULT_TIMEOUT_RETRY_TAIL]);
  assert.deepStrictEqual(buildHeadroomProxyArgs({}, 99999), ['proxy', '--port', '8787', '--no-http2', '--mode', 'cache', ...DEFAULT_TIMEOUT_RETRY_TAIL]);
});

test('proxy args: custom port honored', () => {
  assert.deepStrictEqual(buildHeadroomProxyArgs({}, 9191), ['proxy', '--port', '9191', '--no-http2', '--mode', 'cache', ...DEFAULT_TIMEOUT_RETRY_TAIL]);
});

test('proxy args: always includes --no-http2 (HTTP/2 stream-cancel freeze guard)', () => {
  assert.ok(buildHeadroomProxyArgs({}, 8787).includes('--no-http2'));
  assert.ok(buildHeadroomProxyArgs({ headroomMode: 'off' }, 8787).includes('--no-http2'));
  assert.ok(buildHeadroomProxyArgs({ useHeadroomMemory: true }, 8787).includes('--no-http2'));
});

test('proxy args: default timeout (900s) and retry (5) always appended', () => {
  const args = buildHeadroomProxyArgs({}, 8787);
  assert.deepStrictEqual(args.slice(-6), DEFAULT_TIMEOUT_RETRY_TAIL);
});

test('proxy args: headroomRequestTimeout is honored for both timeout flags', () => {
  const args = buildHeadroomProxyArgs({ headroomRequestTimeout: 1200 }, 8787);
  assert.deepStrictEqual(args.slice(-6), [
    '--request-timeout-seconds', '1200',
    '--anthropic-buffered-request-timeout-seconds', '1200',
    '--retry-max-attempts', '5',
  ]);
});

test('proxy args: invalid headroomRequestTimeout falls back to 900', () => {
  for (const bad of [0, -5, 'x', 12.5]) {
    const args = buildHeadroomProxyArgs({ headroomRequestTimeout: bad }, 8787);
    assert.deepStrictEqual(args.slice(-6, -2), [
      '--request-timeout-seconds', '900',
      '--anthropic-buffered-request-timeout-seconds', '900',
    ]);
  }
});

test('proxy args: headroomRetryMax is honored', () => {
  const args = buildHeadroomProxyArgs({ headroomRetryMax: 8 }, 8787);
  assert.deepStrictEqual(args.slice(-2), ['--retry-max-attempts', '8']);
});

test('proxy args: out-of-range or invalid headroomRetryMax falls back to 5', () => {
  for (const bad of [0, 11, 'x']) {
    const args = buildHeadroomProxyArgs({ headroomRetryMax: bad }, 8787);
    assert.deepStrictEqual(args.slice(-2), ['--retry-max-attempts', '5']);
  }
});

test('proxy args: timeout+retry flags present in all three modes', () => {
  for (const mode of ['cache', 'token', 'off']) {
    const args = buildHeadroomProxyArgs({ headroomMode: mode }, 8787);
    assert.deepStrictEqual(args.slice(-6), DEFAULT_TIMEOUT_RETRY_TAIL);
  }
});
