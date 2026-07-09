'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  readbackMcpSelection,
  resolveProjectMcpSpawn,
  appendProjectMcpArgs
} = require('../lib/mcp-project');

// --- readbackMcpSelection ---

test('readbackMcpSelection: untouched, all checked -> null (inherit)', () => {
  assert.strictEqual(readbackMcpSelection(['a', 'b'], ['a', 'b'], false), null);
});

test('readbackMcpSelection: touched, all checked -> explicit full list', () => {
  assert.deepStrictEqual(readbackMcpSelection(['a', 'b'], ['a', 'b'], true), ['a', 'b']);
});

test('readbackMcpSelection: subset checked -> explicit subset', () => {
  assert.deepStrictEqual(readbackMcpSelection(['a'], ['a', 'b'], false), ['a']);
});

test('readbackMcpSelection: none checked -> empty array (none)', () => {
  assert.deepStrictEqual(readbackMcpSelection([], ['a', 'b'], false), []);
});

// --- resolveProjectMcpSpawn ---

const DISCOVERED = {
  github: { def: { command: 'gh-mcp' }, scope: 'user' },
  mongo: { def: { command: 'mongo-mcp' }, scope: 'project' }
};

test('resolveProjectMcpSpawn: null default -> inherit', () => {
  assert.deepStrictEqual(resolveProjectMcpSpawn(null, DISCOVERED), { inherit: true });
});

test('resolveProjectMcpSpawn: explicit subset -> scoped config', () => {
  const r = resolveProjectMcpSpawn(['github'], DISCOVERED);
  assert.strictEqual(r.inherit, false);
  assert.deepStrictEqual(r.config, { mcpServers: { github: { command: 'gh-mcp' } } });
});

test('resolveProjectMcpSpawn: empty array -> scoped empty config (none)', () => {
  const r = resolveProjectMcpSpawn([], DISCOVERED);
  assert.strictEqual(r.inherit, false);
  assert.deepStrictEqual(r.config, { mcpServers: {} });
});

// --- appendProjectMcpArgs ---

test('appendProjectMcpArgs: adds flags for a scoped config', () => {
  const out = appendProjectMcpArgs(['--bare'], { mcpConfigPath: '/tmp/x.json', strict: true });
  assert.deepStrictEqual(out, ['--bare', '--mcp-config', '/tmp/x.json', '--strict-mcp-config']);
});

test('appendProjectMcpArgs: inherit (no path) -> unchanged copy', () => {
  const out = appendProjectMcpArgs(['--bare'], { inherit: true });
  assert.deepStrictEqual(out, ['--bare']);
});

test('appendProjectMcpArgs: does not override an existing --mcp-config (strip wins)', () => {
  const base = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  const out = appendProjectMcpArgs(base, { mcpConfigPath: '/tmp/x.json', strict: true });
  assert.deepStrictEqual(out, base);
});

test('appendProjectMcpArgs: returns a new array (no mutation)', () => {
  const base = ['--bare'];
  const out = appendProjectMcpArgs(base, { mcpConfigPath: '/tmp/x.json', strict: true });
  assert.notStrictEqual(out, base);
  assert.deepStrictEqual(base, ['--bare']);
});
