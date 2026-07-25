'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildHeadroomEnv, buildHeadroomProxyArgs, headroomModelWindow, headroomOwnsModel, reconcileModelArgForRespawn } = require('../lib/headroom-env');

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

test('hasMcp true -> ENABLE_TOOL_SEARCH omitted (tool_search_deferral would swallow mcp__* tools)', () => {
  const env = buildHeadroomEnv({ enabled: true, hasEndpoint: false, hasMcp: true });
  assert.ok(!('ENABLE_TOOL_SEARCH' in env));
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787');
});

test('hasMcp true + oneM -> still sets ANTHROPIC_MODEL, still no ENABLE_TOOL_SEARCH', () => {
  const env = buildHeadroomEnv({ enabled: true, hasEndpoint: false, hasMcp: true, oneM: true, oneMModel: 'claude-opus-4-8' });
  assert.strictEqual(env.ANTHROPIC_MODEL, 'claude-opus-4-8[1m]');
  assert.ok(!('ENABLE_TOOL_SEARCH' in env));
});

test('hasMcp explicitly false -> ENABLE_TOOL_SEARCH still set', () => {
  const env = buildHeadroomEnv({ enabled: true, hasEndpoint: false, hasMcp: false });
  assert.strictEqual(env.ENABLE_TOOL_SEARCH, 'true');
});

test('oneM with a non-1M-capable model pins the bare id, no [1m] suffix', () => {
  const env = buildHeadroomEnv({ enabled: true, hasEndpoint: false, oneM: true, oneMModel: 'claude-haiku-4-5' });
  assert.strictEqual(env.ANTHROPIC_MODEL, 'claude-haiku-4-5');
});

test('headroomModelWindow: 1M model -> 1000000', () => {
  assert.strictEqual(headroomModelWindow({ enabled: true, hasEndpoint: false, oneM: true, oneMModel: 'claude-opus-4-8' }), 1000000);
});

test('headroomModelWindow: non-1M model -> 200000', () => {
  assert.strictEqual(headroomModelWindow({ enabled: true, hasEndpoint: false, oneM: true, oneMModel: 'claude-haiku-4-5' }), 200000);
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

// Regression: picking the "Opus (latest)" alias in the spawn dropdown used to
// inject ANTHROPIC_MODEL=opus with no [1m] suffix — silently dropping the 1M
// window for one of the most likely picks in the list.
test('alias model is resolved and still gets the [1m] pin', () => {
  const env = buildHeadroomEnv({ enabled: true, oneM: true, oneMModel: 'opus' });
  assert.strictEqual(env.ANTHROPIC_MODEL, 'claude-opus-5[1m]');
  assert.strictEqual(
    headroomModelWindow({ oneM: true, oneMModel: 'opus' }), 1000000
  );
});

test('non-1M alias is pinned bare, with a 200k window', () => {
  const env = buildHeadroomEnv({ enabled: true, oneM: true, oneMModel: 'haiku' });
  assert.strictEqual(env.ANTHROPIC_MODEL, 'claude-haiku-4-5');
  assert.strictEqual(
    headroomModelWindow({ oneM: true, oneMModel: 'haiku' }), 200000
  );
});

// headroomOwnsModel: the shared "does Headroom own --model?" predicate used
// by both buildSpawnArgs and buildResumeArgs, so they can't drift.
test('headroomOwnsModel: installed + enabled + 1M on + no endpoint -> true', () => {
  assert.strictEqual(headroomOwnsModel({
    headroomInstalled: true, useHeadroom: true, useHeadroom1m: true, hasEndpoint: false
  }), true);
});

test('headroomOwnsModel: not installed -> false', () => {
  assert.strictEqual(headroomOwnsModel({
    headroomInstalled: false, useHeadroom: true, useHeadroom1m: true, hasEndpoint: false
  }), false);
});

test('headroomOwnsModel: Headroom toggle off -> false', () => {
  assert.strictEqual(headroomOwnsModel({
    headroomInstalled: true, useHeadroom: false, useHeadroom1m: true, hasEndpoint: false
  }), false);
});

test('headroomOwnsModel: an endpoint preset owns the base URL instead -> false', () => {
  assert.strictEqual(headroomOwnsModel({
    headroomInstalled: true, useHeadroom: true, useHeadroom1m: true, hasEndpoint: true
  }), false);
});

test('headroomOwnsModel: 1M explicitly disabled -> false (Headroom binds but not the model)', () => {
  assert.strictEqual(headroomOwnsModel({
    headroomInstalled: true, useHeadroom: true, useHeadroom1m: false, hasEndpoint: false
  }), false);
});

test('headroomOwnsModel: useHeadroom1m undefined defaults to on (matches buildHeadroomEnv convention)', () => {
  assert.strictEqual(headroomOwnsModel({
    headroomInstalled: true, useHeadroom: true, hasEndpoint: false
  }), true);
});

test('headroomOwnsModel: no input -> false (safe)', () => {
  assert.strictEqual(headroomOwnsModel(), false);
  assert.strictEqual(headroomOwnsModel({}), false);
});

// reconcileModelArgForRespawn: shared by every respawn (buildResumeArgs) AND
// restoreSessions (buildResumeForEntry) so a saved per-column model is never
// silently clobbered by whatever the global spawn dropdown currently reads.
function countModelSelectors(args) {
  var n = 0;
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--model') n++;
    else if (typeof args[i] === 'string' && /^--model=/.test(args[i])) n++;
  }
  return n;
}

test('reconcile: Headroom owns model, no model pinned -> no --model, args untouched', () => {
  const out = reconcileModelArgForRespawn(['--effort', 'high'], null, true, false);
  assert.deepStrictEqual(out, ['--effort', 'high']);
  assert.strictEqual(countModelSelectors(out), 0);
});

test('reconcile: Headroom owns model, model pinned -> --model stripped (env owns it)', () => {
  const out = reconcileModelArgForRespawn(['--effort', 'high', '--model', 'claude-opus-5'], 'claude-opus-5', true, false);
  assert.deepStrictEqual(out, ['--effort', 'high']);
  assert.strictEqual(countModelSelectors(out), 0);
});

test('reconcile: Headroom off, no model pinned -> nothing injected', () => {
  const out = reconcileModelArgForRespawn(['--effort', 'high'], null, false, false);
  assert.deepStrictEqual(out, ['--effort', 'high']);
  assert.strictEqual(countModelSelectors(out), 0);
});

test('reconcile: Headroom off, model pinned, no existing flag -> --model injected exactly once', () => {
  const out = reconcileModelArgForRespawn(['--effort', 'high'], 'claude-opus-5', false, false);
  assert.deepStrictEqual(out, ['--effort', 'high', '--model', 'claude-opus-5']);
  assert.strictEqual(countModelSelectors(out), 1);
});

test('reconcile: Headroom off, alias model pinned -> alias re-injected verbatim (not resolved)', () => {
  const out = reconcileModelArgForRespawn(['--effort', 'high'], 'opus', false, false);
  assert.deepStrictEqual(out, ['--effort', 'high', '--model', 'opus']);
});

test('reconcile: Headroom off, model pinned, matching existing --model -> still exactly one selector', () => {
  const out = reconcileModelArgForRespawn(['--model', 'claude-opus-5', '--effort', 'high'], 'claude-opus-5', false, false);
  assert.deepStrictEqual(out, ['--effort', 'high', '--model', 'claude-opus-5']);
  assert.strictEqual(countModelSelectors(out), 1);
});

// M1 regression: restoreSessions builds args once from the CURRENT global
// spawn dropdown, so a stray --model in `args` can belong to the dropdown,
// not this entry. The reconciler must never trust that value — it always
// wins with the entry's own `model`, replacing whatever was already there.
test("reconcile: stray --model from the CURRENT dropdown is replaced by the entry's own model", () => {
  const out = reconcileModelArgForRespawn(['--model', 'claude-haiku-4-5', '--effort', 'high'], 'claude-sonnet-5', false, false);
  assert.deepStrictEqual(out, ['--effort', 'high', '--model', 'claude-sonnet-5']);
  assert.strictEqual(countModelSelectors(out), 1);
});

test('reconcile: isLocal -> no bare --model re-injected even with a model pinned (endpoint env owns the tier)', () => {
  const out = reconcileModelArgForRespawn(['--effort', 'high'], 'claude-opus-5', false, true);
  assert.deepStrictEqual(out, ['--effort', 'high']);
  assert.strictEqual(countModelSelectors(out), 0);
});

test('reconcile: isLocal + Headroom owns -> --model still stripped', () => {
  const out = reconcileModelArgForRespawn(['--model', 'claude-opus-5'], 'claude-opus-5', true, true);
  assert.deepStrictEqual(out, []);
});

// m3: --model=<value> single-token shape (typable in the Custom args field)
// must be recognised, not treated as "no existing selector" (which used to
// let a second --model get appended alongside it).
test('reconcile: --model=<value> shape is recognised and replaced by the pinned model, exactly once', () => {
  const out = reconcileModelArgForRespawn(['--model=claude-opus-5', '--effort', 'high'], 'claude-opus-5', false, false);
  assert.deepStrictEqual(out, ['--effort', 'high', '--model', 'claude-opus-5']);
  assert.strictEqual(countModelSelectors(out), 1);
});

test('reconcile: --model=<value> shape is stripped when Headroom owns the binding', () => {
  const out = reconcileModelArgForRespawn(['--model=claude-opus-5', '--effort', 'high'], 'claude-opus-5', true, false);
  assert.deepStrictEqual(out, ['--effort', 'high']);
  assert.strictEqual(countModelSelectors(out), 0);
});

// m3: a malformed trailing bare --model (no value) must never survive AND
// must never cause a second --model to be appended alongside it.
test('reconcile: trailing bare --model (malformed) is dropped and replaced by exactly one valid selector', () => {
  const out = reconcileModelArgForRespawn(['--effort', 'high', '--model'], 'claude-opus-5', false, false);
  assert.deepStrictEqual(out, ['--effort', 'high', '--model', 'claude-opus-5']);
  assert.strictEqual(countModelSelectors(out), 1);
});

test('reconcile: trailing bare --model dropped with no model to fall back on -> no selector at all', () => {
  const out = reconcileModelArgForRespawn(['--effort', 'high', '--model'], null, true, false);
  assert.deepStrictEqual(out, ['--effort', 'high']);
  assert.strictEqual(countModelSelectors(out), 0);
});

test('reconcile: empty/undefined args -> safe no-op', () => {
  assert.deepStrictEqual(reconcileModelArgForRespawn([], 'claude-opus-5', false, false), ['--model', 'claude-opus-5']);
  assert.deepStrictEqual(reconcileModelArgForRespawn(undefined, null, false, false), []);
});

// m4: re-injection strips a [1m] window marker rather than pinning it back
// onto a plain --model flag (the marker only means something as an env var).
test('reconcile: re-injection strips a [1m] window marker from the saved model', () => {
  const out = reconcileModelArgForRespawn(['--effort', 'high'], 'claude-opus-5[1m]', false, false);
  assert.deepStrictEqual(out, ['--effort', 'high', '--model', 'claude-opus-5']);
});

// --- regression guards for the restore/respawn reconciler -------------------
// m5: the legacy path (no saved pin) is the highest-value case in this file —
// it is what guarantees an old sessions.json entry restores byte-identical.

test('no saved pin: an existing --model is left completely untouched', () => {
  const r = reconcileModelArgForRespawn;
  assert.deepStrictEqual(
    r(['--model', 'claude-opus-5', '--effort', 'high'], null, false, false),
    ['--model', 'claude-opus-5', '--effort', 'high']
  );
  assert.deepStrictEqual(
    r(['--model=claude-opus-5', '--effort', 'high'], null, false, false),
    ['--model=claude-opus-5', '--effort', 'high']
  );
});

test('repeated --model collapses to exactly one selector (CLI is last-wins)', () => {
  const r = reconcileModelArgForRespawn;
  assert.deepStrictEqual(
    r(['--model', 'a', '--model', 'b'], 'claude-sonnet-5', false, false),
    ['--model', 'claude-sonnet-5']
  );
});
