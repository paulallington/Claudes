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
  codexTuningArgs,
  codexTuningFromArgs,
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

// --- model / effort / service-tier tuning -----------------------------------
// Every axis is opt-in: omitted or empty emits nothing, so a Codex column
// spawned without an explicit choice must be byte-identical to one spawned by
// the old two-argument signature. That backward compatibility is the point.

test('tuning: omitted or empty emits no flags (falls back to config.toml)', () => {
  assert.deepStrictEqual(codexTuningArgs(undefined), []);
  assert.deepStrictEqual(codexTuningArgs({}), []);
  assert.deepStrictEqual(codexTuningArgs({ model: '', effort: '', tier: '' }), []);
  // the old 2-arg call must be unchanged by this feature
  assert.deepStrictEqual(
    buildCodexSpawn(null, 'yolo').args,
    ['--dangerously-bypass-approvals-and-sandbox']
  );
});

test('tuning: model is a flag, effort and tier are -c config overrides', () => {
  assert.deepStrictEqual(
    codexTuningArgs({ model: 'gpt-5.6-sol', effort: 'ultra', tier: 'priority' }),
    ['--model', 'gpt-5.6-sol',
     '-c', 'model_reasoning_effort=ultra',
     '-c', 'service_tier=priority']
  );
});

test('tuning: values that would corrupt argv are refused', () => {
  // whitespace would split into extra argv entries; a leading dash reads as a flag
  assert.deepStrictEqual(codexTuningArgs({ model: 'a b' }), []);
  assert.deepStrictEqual(codexTuningArgs({ effort: '--dangerously-bypass-approvals-and-sandbox' }), []);
  assert.deepStrictEqual(codexTuningArgs({ tier: '   ' }), []);
});

test('approval badge survives appended tuning flags', () => {
  // regression: the reverse map compares the WHOLE array, so without stripping
  // the tuning flags every tuned column would have reported 'Custom'
  const tuned = buildCodexSpawn(null, 'auto', { model: 'gpt-5.6-sol', effort: 'max' }).args;
  assert.strictEqual(codexApprovalLabelFromArgs(tuned), 'Auto');
  const bypass = buildCodexSpawn(null, 'yolo', { tier: 'priority' }).args;
  assert.strictEqual(codexApprovalLabelFromArgs(bypass), 'Yolo (bypass)');
  // tuning alone, no preset, is still 'Codex default' not 'Custom'
  assert.strictEqual(codexApprovalLabelFromArgs(codexTuningArgs({ model: 'gpt-5.6-terra' })), 'Codex default');
});

test('tuning round-trips back out of cmdArgs', () => {
  const args = buildCodexSpawn(null, 'read-only',
    { model: 'gpt-5.3-codex-spark', effort: 'low', tier: 'default' }).args;
  assert.deepStrictEqual(codexTuningFromArgs(args), {
    model: 'gpt-5.3-codex-spark', effort: 'low', tier: 'default'
  });
  assert.deepStrictEqual(codexTuningFromArgs([]), { model: '', effort: '', tier: '' });
  assert.deepStrictEqual(codexTuningFromArgs(null), { model: '', effort: '', tier: '' });
});
