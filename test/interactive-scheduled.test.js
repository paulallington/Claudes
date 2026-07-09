'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildInteractiveArgs,
  interactiveSuffix,
  stripAnsi,
  resolveMcpSelection,
  filterMcpDefs
} = require('../lib/interactive-scheduled');

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// --- buildInteractiveArgs ---

test('buildInteractiveArgs: never adds --print (interactive, not headless)', () => {
  const args = buildInteractiveArgs({ skipPermissions: true, sessionId: 'abc' });
  assert.ok(!args.includes('--print'), 'must not be a --print run');
});

test('buildInteractiveArgs: skipPermissions -> --dangerously-skip-permissions', () => {
  assert.ok(buildInteractiveArgs({ skipPermissions: true }).includes('--dangerously-skip-permissions'));
  assert.ok(!buildInteractiveArgs({ skipPermissions: false }).includes('--dangerously-skip-permissions'));
});

test('buildInteractiveArgs: session id passed through', () => {
  const args = buildInteractiveArgs({ sessionId: 'sess-1' });
  const i = args.indexOf('--session-id');
  assert.ok(i >= 0 && args[i + 1] === 'sess-1');
});

test('buildInteractiveArgs: model added only when no endpoint', () => {
  const withModel = buildInteractiveArgs({ model: 'opus', hasEndpoint: false });
  assert.ok(withModel.includes('--model') && withModel.includes('opus'));
  const withEndpoint = buildInteractiveArgs({ model: 'opus', hasEndpoint: true });
  assert.ok(!withEndpoint.includes('--model'), 'endpoint pins model via env; no --model flag');
});

test('buildInteractiveArgs: strict mcp only with an mcp config path', () => {
  const scoped = buildInteractiveArgs({ mcpConfigPath: '/tmp/x.json', strictMcp: true });
  const ci = scoped.indexOf('--mcp-config');
  assert.ok(ci >= 0 && scoped[ci + 1] === '/tmp/x.json');
  assert.ok(scoped.includes('--strict-mcp-config'));
  // strict flag is meaningless without a config path -> not emitted
  assert.ok(!buildInteractiveArgs({ strictMcp: true }).includes('--strict-mcp-config'));
});

test('buildInteractiveArgs: extraArgs appended verbatim', () => {
  const args = buildInteractiveArgs({ extraArgs: ['--foo', 'bar'] });
  assert.deepStrictEqual(args, ['--foo', 'bar']);
});

// --- interactiveSuffix ---

test('interactiveSuffix: includes the sentinel path and mentions the Write tool', () => {
  const s = interactiveSuffix('/runs/x.result.json');
  assert.ok(s.includes('/runs/x.result.json'));
  assert.ok(/Write tool/i.test(s));
});

// --- stripAnsi ---

test('stripAnsi: removes CSI color codes but keeps text', () => {
  const colored = ESC + '[31mhello' + ESC + '[0m world';
  assert.strictEqual(stripAnsi(colored), 'hello world');
});

test('stripAnsi: removes OSC title sequences', () => {
  const osc = ESC + ']0;my title' + BEL + 'body';
  assert.strictEqual(stripAnsi(osc), 'body');
});

test('stripAnsi: leaves plain text (incl. brackets/letters) untouched', () => {
  const plain = 'array[0] = value; RESULT ok';
  assert.strictEqual(stripAnsi(plain), plain);
});

test('stripAnsi: a :::loop-result block survives stripping and stays parseable', () => {
  const raw = ESC + '[2K' + ':::loop-result\n{"summary":"ok","attentionItems":[]}\n:::loop-result' + ESC + '[0m';
  const clean = stripAnsi(raw);
  const m = clean.match(/:::loop-result\s*\n([\s\S]*?)\n\s*:::loop-result/);
  assert.ok(m, 'marker block preserved');
  assert.deepStrictEqual(JSON.parse(m[1]), { summary: 'ok', attentionItems: [] });
});

test('stripAnsi: removes CSI private-prefix sequences (ESC[>0q, ESC[?25l)', () => {
  const raw = ESC + '[>0q' + ESC + '[?25l' + 'text' + ESC + '[?25h';
  assert.strictEqual(stripAnsi(raw), 'text');
});

test('stripAnsi: removes 2-char escapes (cursor save/restore, keypad)', () => {
  const raw = ESC + '7' + ESC + '=' + 'hi' + ESC + '>' + ESC + '8';
  assert.strictEqual(stripAnsi(raw), 'hi');
});

test('stripAnsi: null/undefined -> empty string', () => {
  assert.strictEqual(stripAnsi(null), '');
  assert.strictEqual(stripAnsi(undefined), '');
});

// --- resolveMcpSelection ---

test('resolveMcpSelection: per-agent array wins', () => {
  assert.deepStrictEqual(resolveMcpSelection(['a', 'b'], ['x']), ['a', 'b']);
});

test('resolveMcpSelection: falls back to project default', () => {
  assert.deepStrictEqual(resolveMcpSelection(null, ['x']), ['x']);
  assert.deepStrictEqual(resolveMcpSelection(undefined, ['x']), ['x']);
});

test('resolveMcpSelection: no selection anywhere -> null (inherit all)', () => {
  assert.strictEqual(resolveMcpSelection(null, null), null);
  assert.strictEqual(resolveMcpSelection(undefined, undefined), null);
});

test('resolveMcpSelection: explicit empty array is preserved (means none)', () => {
  assert.deepStrictEqual(resolveMcpSelection([], ['x']), []);
});

// --- filterMcpDefs ---

const AVAILABLE = {
  taskboard: { def: { type: 'http', url: 'http://tb' }, scope: 'user' },
  playwright: { def: { command: 'npx', args: ['playwright'] }, scope: 'user' },
  slack: { def: { command: 'slack' }, scope: 'user' }
};

test('filterMcpDefs: keeps only selected servers that exist', () => {
  const out = filterMcpDefs(AVAILABLE, ['taskboard', 'playwright', 'ghost']);
  assert.deepStrictEqual(Object.keys(out.mcpServers).sort(), ['playwright', 'taskboard']);
  assert.deepStrictEqual(out.mcpServers.taskboard, { type: 'http', url: 'http://tb' });
});

test('filterMcpDefs: empty selection -> empty (drops all inherited)', () => {
  assert.deepStrictEqual(filterMcpDefs(AVAILABLE, []), { mcpServers: {} });
});

test('filterMcpDefs: extra servers (mongo) merged on top of the allowlist', () => {
  const mongo = { mongodb: { command: 'npx', args: ['-y', 'mongodb-mcp-server@latest'] } };
  const out = filterMcpDefs(AVAILABLE, ['taskboard'], mongo);
  assert.deepStrictEqual(Object.keys(out.mcpServers).sort(), ['mongodb', 'taskboard']);
});
