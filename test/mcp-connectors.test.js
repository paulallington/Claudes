'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { CONNECTOR_PREFIX, isConnectorName } = require('../lib/mcp-connectors');

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
