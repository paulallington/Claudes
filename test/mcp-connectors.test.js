'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  CONNECTOR_PREFIX,
  isConnectorName,
  parseMcpListOutput,
  serverUrlOf,
  buildMcpAllowlist,
  mergeSettingsKey,
  applyMcpScope
} = require('../lib/mcp-connectors');

// --- isConnectorName ---

test('isConnectorName: true only for strings with the claude.ai prefix', () => {
  assert.strictEqual(CONNECTOR_PREFIX, 'claude.ai ');
  assert.strictEqual(isConnectorName('claude.ai Granola'), true);
  assert.strictEqual(isConnectorName('claude.ai'), false);
  assert.strictEqual(isConnectorName('Granola'), false);
  assert.strictEqual(isConnectorName('plugin:context7:context7'), false);
  assert.strictEqual(isConnectorName(null), false);
  assert.strictEqual(isConnectorName(42), false);
});

// --- parseMcpListOutput ---

const LIST_SAMPLE = [
  'Checking MCP server health…',
  '',
  'claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - √ Connected',
  'claude.ai Wispr Flow: https://api.wisprflow.ai/connect/mcp - √ Connected',
  'claude.ai Ashley Payne: https://www.ashleypayne.co.uk/mcp - √ Connected',
  'claude.ai Granola: https://mcp.granola.ai/mcp - × Failed to connect',
  'plugin:context7:context7: https://mcp.context7.com/mcp?client=claude-code-plugin (HTTP) - √ Connected',
  'mongodb: npx -y mongodb-mcp-server --connectionString mongodb://localhost:27017 - √ Connected',
  'sentry: https://mcp.sentry.dev/mcp (HTTP) - √ Connected',
  ''
].join('\n');

test('parseMcpListOutput: extracts only claude.ai connectors with http(s) urls', () => {
  assert.deepStrictEqual(parseMcpListOutput(LIST_SAMPLE), [
    { name: 'claude.ai Claude Docs', url: 'https://api.anthropic.com/v1/pages/mcp' },
    { name: 'claude.ai Wispr Flow', url: 'https://api.wisprflow.ai/connect/mcp' },
    { name: 'claude.ai Ashley Payne', url: 'https://www.ashleypayne.co.uk/mcp' },
    { name: 'claude.ai Granola', url: 'https://mcp.granola.ai/mcp' }
  ]);
});

test('parseMcpListOutput: strips ANSI escapes and CRs before matching', () => {
  const esc = String.fromCharCode(27);
  const text = esc + '[32mclaude.ai Granola: https://mcp.granola.ai/mcp - ' + esc + '[0m✓ Connected\r\n' +
    esc + '[1mclaude.ai Wispr Flow: https://api.wisprflow.ai/connect/mcp - ! Needs authentication\r\n';
  assert.deepStrictEqual(parseMcpListOutput(text), [
    { name: 'claude.ai Granola', url: 'https://mcp.granola.ai/mcp' },
    { name: 'claude.ai Wispr Flow', url: 'https://api.wisprflow.ai/connect/mcp' }
  ]);
});

test('parseMcpListOutput: tolerates (HTTP)/(SSE) tags and colons in names, dedupes by name', () => {
  const text = [
    'claude.ai Foo: Bar: https://foo.example/mcp?x=1 (SSE) - ✔ Connected',
    'claude.ai Granola: https://mcp.granola.ai/mcp (HTTP) - ✓ Connected',
    'claude.ai Granola: https://other.example/mcp - ✗ Failed'
  ].join('\n');
  assert.deepStrictEqual(parseMcpListOutput(text), [
    { name: 'claude.ai Foo: Bar', url: 'https://foo.example/mcp?x=1' },
    { name: 'claude.ai Granola', url: 'https://mcp.granola.ai/mcp' }
  ]);
});

test('parseMcpListOutput: ignores connectors with non-http targets; bad input -> []', () => {
  assert.deepStrictEqual(parseMcpListOutput('claude.ai Weird: npx foo - ✓ Connected'), []);
  assert.deepStrictEqual(parseMcpListOutput(''), []);
  assert.deepStrictEqual(parseMcpListOutput(null), []);
  assert.deepStrictEqual(parseMcpListOutput(42), []);
});

// --- serverUrlOf ---

test('serverUrlOf: returns http(s) url strings only', () => {
  assert.strictEqual(serverUrlOf({ type: 'http', url: 'https://a.example/mcp' }), 'https://a.example/mcp');
  assert.strictEqual(serverUrlOf({ url: 'HTTP://a.example/mcp' }), 'HTTP://a.example/mcp');
  assert.strictEqual(serverUrlOf({ command: 'npx', args: [] }), null);
  assert.strictEqual(serverUrlOf({ url: 'ws://a.example' }), null);
  assert.strictEqual(serverUrlOf({ url: 42 }), null);
  assert.strictEqual(serverUrlOf(null), null);
  assert.strictEqual(serverUrlOf('https://a.example'), null);
});

// --- buildMcpAllowlist ---

const DISCOVERED = {
  sentry: { def: { type: 'http', url: 'https://mcp.sentry.dev/mcp' }, scope: 'user' },
  mongodb: { def: { command: 'npx', args: ['-y', 'mongodb-mcp-server'] }, scope: 'project' }
};
const CONNECTORS = { 'claude.ai Granola': 'https://mcp.granola.ai/mcp' };

test('buildMcpAllowlist: connectors by serverUrl, remote file servers by url, stdio by serverName', () => {
  assert.deepStrictEqual(
    buildMcpAllowlist(['claude.ai Granola', 'sentry', 'mongodb'], DISCOVERED, CONNECTORS),
    {
      entries: [
        { serverUrl: 'https://mcp.granola.ai/mcp' },
        { serverUrl: 'https://mcp.sentry.dev/mcp' },
        { serverName: 'mongodb' }
      ],
      hasConnectors: true,
      missingConnectors: []
    }
  );
});

test('buildMcpAllowlist: unknown connectors are reported missing, unknown names skipped', () => {
  assert.deepStrictEqual(
    buildMcpAllowlist(['claude.ai Gone', 'nope', 'mongodb'], DISCOVERED, CONNECTORS),
    {
      entries: [{ serverName: 'mongodb' }],
      hasConnectors: false,
      missingConnectors: ['claude.ai Gone']
    }
  );
});

test('buildMcpAllowlist: extraServers always included, duplicates collapsed', () => {
  const extra = { mongodb: { command: 'npx', args: [] }, remote: { url: 'https://r.example/mcp' } };
  assert.deepStrictEqual(
    buildMcpAllowlist(['mongodb'], DISCOVERED, CONNECTORS, extra),
    {
      entries: [{ serverName: 'mongodb' }, { serverUrl: 'https://r.example/mcp' }],
      hasConnectors: false,
      missingConnectors: []
    }
  );
});

test('buildMcpAllowlist: non-array selection and missing maps are tolerated', () => {
  assert.deepStrictEqual(
    buildMcpAllowlist(null, null, null),
    { entries: [], hasConnectors: false, missingConnectors: [] }
  );
  assert.deepStrictEqual(
    buildMcpAllowlist(['claude.ai Granola', 'x'], undefined, undefined),
    { entries: [], hasConnectors: false, missingConnectors: ['claude.ai Granola'] }
  );
});

// --- mergeSettingsKey ---

const ALLOW = [{ serverUrl: 'https://mcp.granola.ai/mcp' }];

test('mergeSettingsKey: no --settings -> appends a fresh one, input untouched', () => {
  const input = ['--model', 'opus'];
  const out = mergeSettingsKey(input, 'allowedMcpServers', ALLOW);
  assert.deepStrictEqual(out, ['--model', 'opus', '--settings', JSON.stringify({ allowedMcpServers: ALLOW })]);
  assert.deepStrictEqual(input, ['--model', 'opus']);
});

test('mergeSettingsKey: no --settings and undefined value -> unchanged copy', () => {
  const input = ['--model', 'opus'];
  const out = mergeSettingsKey(input, 'allowedMcpServers', undefined);
  assert.deepStrictEqual(out, ['--model', 'opus']);
  assert.notStrictEqual(out, input);
});

test('mergeSettingsKey: merges into the LAST --settings JSON in place, preserving other keys', () => {
  const input = ['--settings', '{"a":1}', '--x', '--settings', '{"ultracode":true,"env":{"K":"v"}}', '--y'];
  const out = mergeSettingsKey(input, 'allowedMcpServers', ALLOW);
  assert.deepStrictEqual(out, [
    '--settings', '{"a":1}', '--x',
    '--settings', JSON.stringify({ ultracode: true, env: { K: 'v' }, allowedMcpServers: ALLOW }),
    '--y'
  ]);
});

test('mergeSettingsKey: handles the single-token --settings=<json> form', () => {
  const out = mergeSettingsKey(['--settings={"a":1}'], 'allowedMcpServers', ALLOW);
  assert.deepStrictEqual(out, ['--settings=' + JSON.stringify({ a: 1, allowedMcpServers: ALLOW })]);
});

test('mergeSettingsKey: undefined value deletes the key', () => {
  const input = ['--settings', JSON.stringify({ a: 1, allowedMcpServers: ALLOW })];
  assert.deepStrictEqual(mergeSettingsKey(input, 'allowedMcpServers', undefined), ['--settings', '{"a":1}']);
});

test('mergeSettingsKey: file-path or non-object --settings is unmergeable -> null', () => {
  assert.strictEqual(mergeSettingsKey(['--settings', 'C:\\cfg\\s.json'], 'k', ALLOW), null);
  assert.strictEqual(mergeSettingsKey(['--settings', '[1]'], 'k', ALLOW), null);
  assert.strictEqual(mergeSettingsKey(['--settings=s.json'], 'k', undefined), null);
});

test('mergeSettingsKey: drops a malformed trailing bare --settings', () => {
  assert.deepStrictEqual(
    mergeSettingsKey(['--model', 'opus', '--settings'], 'allowedMcpServers', ALLOW),
    ['--model', 'opus', '--settings', JSON.stringify({ allowedMcpServers: ALLOW })]
  );
});

// --- renderer (UMD) contract ---

test('loads in a sandbox with window but no module/require, exposing window.McpConnectors', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-connectors.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.strictEqual(typeof sandbox.window.McpConnectors.applyMcpScope, 'function');
  assert.strictEqual(typeof sandbox.window.McpConnectors.buildMcpAllowlist, 'function');
  assert.strictEqual(sandbox.window.McpConnectors.isConnectorName('claude.ai Granola'), true);
});

// --- applyMcpScope ---

test('applyMcpScope: allowlist scope -> non-strict --mcp-config plus merged allowedMcpServers', () => {
  const input = ['--model', 'opus'];
  const out = applyMcpScope(input, { mcpConfigPath: 'C:\\t\\mcp.json', strict: true, allowedMcpServers: ALLOW });
  assert.deepStrictEqual(out, [
    '--model', 'opus',
    '--settings', JSON.stringify({ allowedMcpServers: ALLOW }),
    '--mcp-config', 'C:\\t\\mcp.json'
  ]);
  assert.ok(!out.includes('--strict-mcp-config'));
  assert.deepStrictEqual(input, ['--model', 'opus']);
});

test('applyMcpScope: merges into an existing --settings rather than appending a second', () => {
  const out = applyMcpScope(
    ['--settings', '{"ultracode":true}'],
    { mcpConfigPath: 'p.json', allowedMcpServers: [] }
  );
  assert.deepStrictEqual(out, [
    '--settings', JSON.stringify({ ultracode: true, allowedMcpServers: [] }),
    '--mcp-config', 'p.json'
  ]);
});

test('applyMcpScope: unmergeable user settings file falls back to legacy strict config', () => {
  const out = applyMcpScope(
    ['--settings', 'user.json'],
    { mcpConfigPath: 'p.json', allowedMcpServers: ALLOW }
  );
  assert.deepStrictEqual(out, ['--settings', 'user.json', '--mcp-config', 'p.json', '--strict-mcp-config']);
});

test('applyMcpScope: legacy scope honours strict flag', () => {
  assert.deepStrictEqual(
    applyMcpScope(['a'], { mcpConfigPath: 'p.json', strict: true }),
    ['a', '--mcp-config', 'p.json', '--strict-mcp-config']
  );
  assert.deepStrictEqual(
    applyMcpScope(['a'], { mcpConfigPath: 'p.json', strict: false }),
    ['a', '--mcp-config', 'p.json']
  );
});

test('applyMcpScope: args already carrying --mcp-config (Strip MCPs) are returned unchanged', () => {
  const input = ['--mcp-config', 'empty.json', '--strict-mcp-config'];
  const out = applyMcpScope(input, { mcpConfigPath: 'p.json', strict: true, allowedMcpServers: ALLOW });
  assert.deepStrictEqual(out, input);
  assert.notStrictEqual(out, input);
});

test('applyMcpScope: no scope / no allowlist -> args byte-identical, user allowedMcpServers survives', () => {
  const user = ['--settings', '{ "allowedMcpServers":[{"serverName":"a"}], "x":1.0 }'];
  const viaNull = applyMcpScope(user, null);
  assert.deepStrictEqual(viaNull, user);
  assert.notStrictEqual(viaNull, user);
  assert.deepStrictEqual(applyMcpScope(user, { strict: true }), user);
  assert.deepStrictEqual(
    applyMcpScope(user, { mcpConfigPath: 'p.json', strict: true }),
    user.concat(['--mcp-config', 'p.json', '--strict-mcp-config'])
  );
  assert.deepStrictEqual(applyMcpScope(undefined, null), []);
});

test('applyMcpScope: a respawn re-scoping an already-stamped allowlist replaces it', () => {
  const first = applyMcpScope(['--model', 'opus'], { mcpConfigPath: 'p.json', allowedMcpServers: ALLOW });
  const rebuilt = applyMcpScope(first.slice(0, -2), { mcpConfigPath: 'p.json', allowedMcpServers: [] });
  assert.deepStrictEqual(rebuilt, [
    '--model', 'opus',
    '--settings', JSON.stringify({ allowedMcpServers: [] }),
    '--mcp-config', 'p.json'
  ]);
});
