'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  codexLookupCommand,
  parseWhichOutput,
  buildCodexSpawn,
  columnUsesClaudeChrome,
  CODEX_APPROVAL_PRESETS,
  DEFAULT_CODEX_APPROVAL,
  codexApprovalArgs,
  codexApprovalLabelFromArgs
} = require('../lib/codex-spawn');

test('CODEX_APPROVAL_PRESETS: exact keys and order', () => {
  assert.deepStrictEqual(
    CODEX_APPROVAL_PRESETS.map(function (p) { return p.key; }),
    ['read-only', 'auto', 'full-access', 'yolo', 'codex-default']
  );
  assert.strictEqual(DEFAULT_CODEX_APPROVAL, 'auto');
});

test('codexApprovalArgs: maps each preset to its flags', () => {
  assert.deepStrictEqual(codexApprovalArgs('read-only'), ['-a', 'untrusted', '-s', 'read-only']);
  assert.deepStrictEqual(codexApprovalArgs('auto'), ['-a', 'on-request', '-s', 'workspace-write']);
  assert.deepStrictEqual(codexApprovalArgs('full-access'), ['-a', 'never', '-s', 'danger-full-access']);
  assert.deepStrictEqual(codexApprovalArgs('yolo'), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepStrictEqual(codexApprovalArgs('codex-default'), []);
});

test('codexApprovalArgs: unknown/undefined -> [] (codex default)', () => {
  assert.deepStrictEqual(codexApprovalArgs('bogus'), []);
  assert.deepStrictEqual(codexApprovalArgs(undefined), []);
});

test('codexApprovalArgs: returns a fresh array (no shared mutation)', () => {
  var a = codexApprovalArgs('auto');
  a.push('x');
  assert.deepStrictEqual(codexApprovalArgs('auto'), ['-a', 'on-request', '-s', 'workspace-write']);
});

test('codexApprovalLabelFromArgs: reverse-maps flags to labels', () => {
  assert.strictEqual(codexApprovalLabelFromArgs(['-a', 'on-request', '-s', 'workspace-write']), 'Auto');
  assert.strictEqual(codexApprovalLabelFromArgs(['--dangerously-bypass-approvals-and-sandbox']), 'Yolo (bypass)');
  assert.strictEqual(codexApprovalLabelFromArgs([]), 'Codex default');
  assert.strictEqual(codexApprovalLabelFromArgs(['--weird']), 'Custom');
});

test('buildCodexSpawn: preset drives args; omitted preset stays []', () => {
  assert.deepStrictEqual(buildCodexSpawn('D:/p', 'auto').args, ['-a', 'on-request', '-s', 'workspace-write']);
  assert.deepStrictEqual(buildCodexSpawn('D:/p', 'yolo').args, ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepStrictEqual(buildCodexSpawn('D:/p').args, []);
  assert.strictEqual(buildCodexSpawn('D:/p', 'auto').opts.cmd, 'codex');
});

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

test('buildCodexSpawn: cmd=codex, empty args, no hardcoded title, no Claude flags', () => {
  const spec = buildCodexSpawn('D:/proj');
  assert.deepStrictEqual(spec.args, []);
  assert.strictEqual(spec.opts.cmd, 'codex');
  assert.strictEqual(spec.opts.cwd, 'D:/proj');
  // No hardcoded title — the header derives "Codex #<id>" so the column name
  // doesn't duplicate the "Codex" badge.
  assert.ok(!('title' in spec.opts));
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
