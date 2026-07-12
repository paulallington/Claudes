'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  codexLookupCommand,
  parseWhichOutput,
  buildCodexSpawn,
  columnUsesClaudeChrome
} = require('../lib/codex-spawn');

test('codexLookupCommand: where on win32, which elsewhere', () => {
  assert.strictEqual(codexLookupCommand('win32'), 'where');
  assert.strictEqual(codexLookupCommand('darwin'), 'which');
  assert.strictEqual(codexLookupCommand('linux'), 'which');
});

test('parseWhichOutput: returns first non-empty line, else null', () => {
  assert.strictEqual(parseWhichOutput('C:\\tools\\codex.exe\r\nC:\\other\\codex.exe\r\n'), 'C:\\tools\\codex.exe');
  assert.strictEqual(parseWhichOutput('/usr/local/bin/codex\n'), '/usr/local/bin/codex');
  assert.strictEqual(parseWhichOutput('   \n  \n'), null);
  assert.strictEqual(parseWhichOutput(''), null);
});

test('buildCodexSpawn: cmd=codex, empty args, Codex title, no Claude flags', () => {
  const spec = buildCodexSpawn('D:/proj');
  assert.deepStrictEqual(spec.args, []);
  assert.strictEqual(spec.opts.cmd, 'codex');
  assert.strictEqual(spec.opts.title, 'Codex');
  assert.strictEqual(spec.opts.cwd, 'D:/proj');
  // Guard: nothing Claude-specific leaks in.
  assert.ok(!('endpointId' in spec.opts));
  assert.ok(!('env' in spec.opts));
});

test('buildCodexSpawn: tolerates null cwd', () => {
  assert.strictEqual(buildCodexSpawn(null).opts.cwd, null);
});

test('columnUsesClaudeChrome: true for Claude, false for cmd columns', () => {
  assert.strictEqual(columnUsesClaudeChrome({}), true);
  assert.strictEqual(columnUsesClaudeChrome({ cmd: null }), true);
  assert.strictEqual(columnUsesClaudeChrome(null), true);
  assert.strictEqual(columnUsesClaudeChrome({ cmd: 'codex' }), false);
  assert.strictEqual(columnUsesClaudeChrome({ cmd: 'dotnet' }), false);
});
