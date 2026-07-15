'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { needsResolution, pickExecutable } = require('../lib/spawn-resolve');

test('needsResolution: true for bare names', () => {
  assert.strictEqual(needsResolution('codex'), true);
  assert.strictEqual(needsResolution('claude'), true);
});

test('needsResolution: false for path-qualified or drive-letter commands', () => {
  assert.strictEqual(needsResolution('./codex'), false);
  assert.strictEqual(needsResolution('../bin/codex'), false);
  assert.strictEqual(needsResolution('C:\\tools\\codex.cmd'), false);
  assert.strictEqual(needsResolution('C:/tools/codex.cmd'), false);
  assert.strictEqual(needsResolution('/usr/local/bin/codex'), false);
  assert.strictEqual(needsResolution('bin\\codex.exe'), false);
});

test('needsResolution: false for empty/null/undefined', () => {
  assert.strictEqual(needsResolution(''), false);
  assert.strictEqual(needsResolution(null), false);
  assert.strictEqual(needsResolution(undefined), false);
});

test('pickExecutable: win32 prefers .cmd/.exe/.bat/.com over other extensions', () => {
  const out = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex\r\nC:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd\r\n';
  assert.strictEqual(pickExecutable(out, 'win32'), 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd');
});

test('pickExecutable: win32 falls back to first line if no executable extension matches', () => {
  const out = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex\r\nC:\\Users\\dev\\AppData\\Roaming\\npm\\codex.ps1\r\n';
  assert.strictEqual(pickExecutable(out, 'win32'), 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex');
});

test('pickExecutable: win32 returns null when there are no non-blank lines', () => {
  assert.strictEqual(pickExecutable('   \n  \n', 'win32'), null);
  assert.strictEqual(pickExecutable('', 'win32'), null);
});

test('pickExecutable: non-win32 returns first non-blank line', () => {
  assert.strictEqual(pickExecutable('/usr/local/bin/codex\n/opt/bin/codex\n', 'darwin'), '/usr/local/bin/codex');
  assert.strictEqual(pickExecutable('', 'linux'), null);
});
