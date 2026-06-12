const { test } = require('node:test');
const assert = require('node:assert');
const { isValidHookToken } = require('../lib/hook-token');

const VALID = 'a'.repeat(64);
const VALID_MIXED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('valid 64-char lowercase hex returns true', () => {
  assert.strictEqual(isValidHookToken(VALID), true);
  assert.strictEqual(isValidHookToken(VALID_MIXED), true);
});

test('wrong length returns false', () => {
  assert.strictEqual(isValidHookToken('a'.repeat(63)), false);
  assert.strictEqual(isValidHookToken('a'.repeat(65)), false);
  assert.strictEqual(isValidHookToken(''), false);
});

test('non-hex chars return false', () => {
  assert.strictEqual(isValidHookToken('A'.repeat(64)), false); // uppercase
  assert.strictEqual(isValidHookToken('g'.repeat(64)), false); // out-of-range letter
  assert.strictEqual(isValidHookToken('a'.repeat(63) + ' '), false); // space
  assert.strictEqual(isValidHookToken(' '.repeat(64)), false);
});

test('non-string values return false', () => {
  assert.strictEqual(isValidHookToken(null), false);
  assert.strictEqual(isValidHookToken(undefined), false);
  assert.strictEqual(isValidHookToken(1234), false);
  assert.strictEqual(isValidHookToken({}), false);
  assert.strictEqual(isValidHookToken(['a'.repeat(64)]), false);
});
