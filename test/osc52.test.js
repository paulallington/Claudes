const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOsc52 } = require('../lib/osc52');

function b64(str) {
  return Buffer.from(str).toString('base64');
}

test('1: decodes a c-selection payload', () => {
  assert.equal(parseOsc52('c;' + b64('hello')), 'hello');
});

test('2: empty selection still decodes payload', () => {
  assert.equal(parseOsc52(';' + b64('hi')), 'hi');
});

test('3: multibyte UTF-8 round-trips', () => {
  assert.equal(parseOsc52('c;' + b64('café 🔊')), 'café 🔊');
});

test('4: clipboard read request returns null', () => {
  assert.equal(parseOsc52('c;?'), null);
});

test('5: malformed input (no semicolon) returns null', () => {
  assert.equal(parseOsc52('cnoseparator'), null);
});

test('6: empty / whitespace payload returns null', () => {
  assert.equal(parseOsc52('c;'), null);
  assert.equal(parseOsc52('c;   '), null);
});

test('7: base64 that fails to decode returns null', () => {
  assert.equal(parseOsc52('c;@@@not base64@@@'), null);
});

test('8: whitespace-wrapped base64 still decodes', () => {
  var wrapped = b64('hello world').match(/.{1,4}/g).join('\n');
  assert.equal(parseOsc52('c;' + wrapped), 'hello world');
  assert.equal(parseOsc52('c; ' + b64('hi') + ' '), 'hi');
});

test('9: malformed base64 with length not a multiple of 4 returns null', () => {
  assert.equal(parseOsc52('c;abc'), null);
});

test('10: oversized decoded payload returns null', () => {
  var big = 'a'.repeat(5 * 1024 * 1024 + 1);
  assert.equal(parseOsc52('c;' + b64(big)), null);
});
