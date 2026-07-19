'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  readbackMcpSelection,
  resolveProjectMcpSpawn,
  appendProjectMcpArgs,
  matchesProjectScope,
  mcpEligibleRespawnColumns
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
  assert.deepStrictEqual(resolveProjectMcpSpawn(null, DISCOVERED), { inherit: true, hasMcp: true });
});

test('resolveProjectMcpSpawn: null default, no discovered servers -> inherit, no mcp', () => {
  assert.deepStrictEqual(resolveProjectMcpSpawn(null, {}), { inherit: true, hasMcp: false });
});

test('resolveProjectMcpSpawn: explicit subset -> scoped config', () => {
  const r = resolveProjectMcpSpawn(['github'], DISCOVERED);
  assert.strictEqual(r.inherit, false);
  assert.deepStrictEqual(r.config, { mcpServers: { github: { command: 'gh-mcp' } } });
  assert.strictEqual(r.hasMcp, true);
});

test('resolveProjectMcpSpawn: empty array -> scoped empty config (none)', () => {
  const r = resolveProjectMcpSpawn([], DISCOVERED);
  assert.strictEqual(r.inherit, false);
  assert.deepStrictEqual(r.config, { mcpServers: {} });
  assert.strictEqual(r.hasMcp, false);
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

// --- matchesProjectScope ---

test('matchesProjectScope: exact root matches', () => {
  assert.strictEqual(matchesProjectScope('D:/Git Repos/Claudes', 'D:/Git Repos/Claudes'), true);
});
test('matchesProjectScope: worktree subpath matches', () => {
  assert.strictEqual(matchesProjectScope('D:/Git Repos/Claudes/.claude/worktrees/x', 'D:/Git Repos/Claudes'), true);
});
test('matchesProjectScope: backslash key normalizes to match', () => {
  assert.strictEqual(matchesProjectScope('D:\\Git Repos\\Claudes\\sub', 'D:/Git Repos/Claudes'), true);
});
test('matchesProjectScope: trailing slash on root still matches', () => {
  assert.strictEqual(matchesProjectScope('D:/Git Repos/Claudes/sub', 'D:/Git Repos/Claudes/'), true);
});
test('matchesProjectScope: sibling dir does NOT match', () => {
  assert.strictEqual(matchesProjectScope('D:/Git Repos/ClaudesOther', 'D:/Git Repos/Claudes'), false);
});
test('matchesProjectScope: empty/nullish returns false', () => {
  assert.strictEqual(matchesProjectScope('', 'D:/Git Repos/Claudes'), false);
  assert.strictEqual(matchesProjectScope('D:/x', ''), false);
});

// --- mcpEligibleRespawnColumns ---

test('mcpEligibleRespawnColumns: keeps real claude columns', () => {
  const out = mcpEligibleRespawnColumns([
    { id: 'a', isClaude: true, stripped: false },
    { id: 'b', isClaude: true, stripped: false },
  ]);
  assert.deepStrictEqual(out, ['a', 'b']);
});
test('mcpEligibleRespawnColumns: excludes custom cmd columns', () => {
  const out = mcpEligibleRespawnColumns([
    { id: 'a', isClaude: true, stripped: false },
    { id: 'c', isClaude: false, stripped: false },
  ]);
  assert.deepStrictEqual(out, ['a']);
});
test('mcpEligibleRespawnColumns: excludes strip-MCPs columns', () => {
  const out = mcpEligibleRespawnColumns([
    { id: 'a', isClaude: true, stripped: false },
    { id: 's', isClaude: true, stripped: true },
  ]);
  assert.deepStrictEqual(out, ['a']);
});
test('mcpEligibleRespawnColumns: empty / nullish input', () => {
  assert.deepStrictEqual(mcpEligibleRespawnColumns([]), []);
  assert.deepStrictEqual(mcpEligibleRespawnColumns(null), []);
});
