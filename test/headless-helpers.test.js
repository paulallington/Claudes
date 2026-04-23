const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveHeadlessTitle } = require('../lib/headless-helpers');

test('deriveHeadlessTitle: returns first non-empty line', () => {
  assert.equal(deriveHeadlessTitle('Hello world'), 'Hello world');
});

test('deriveHeadlessTitle: skips leading blank lines', () => {
  assert.equal(deriveHeadlessTitle('\n\n  \nSecond line here'), 'Second line here');
});

test('deriveHeadlessTitle: trims whitespace', () => {
  assert.equal(deriveHeadlessTitle('   padded   '), 'padded');
});

test('deriveHeadlessTitle: truncates to 80 chars', () => {
  const long = 'a'.repeat(200);
  const result = deriveHeadlessTitle(long);
  assert.equal(result.length, 80);
  assert.equal(result, 'a'.repeat(80));
});

test('deriveHeadlessTitle: empty prompt returns "(empty)"', () => {
  assert.equal(deriveHeadlessTitle(''), '(empty)');
  assert.equal(deriveHeadlessTitle('   \n\n  '), '(empty)');
});

test('deriveHeadlessTitle: non-string input returns "(empty)"', () => {
  assert.equal(deriveHeadlessTitle(null), '(empty)');
  assert.equal(deriveHeadlessTitle(undefined), '(empty)');
});
