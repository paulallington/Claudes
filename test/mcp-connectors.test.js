'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { CONNECTOR_PREFIX, isConnectorName, parseMcpListOutput } = require('../lib/mcp-connectors');

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
