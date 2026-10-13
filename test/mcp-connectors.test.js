'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  CONNECTOR_PREFIX,
  isConnectorName,
  parseMcpListOutput,
  serverUrlOf,
  buildMcpAllowlist
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
