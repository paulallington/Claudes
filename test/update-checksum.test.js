'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseChecksumFile, checksumsMatch } = require('../lib/update-checksum');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('parseChecksumFile: standard two-space shasum line', () => {
  const text = `${HASH_A}  Claudes-1.9.49-mac-arm64.dmg\n`;
  assert.equal(parseChecksumFile(text, 'Claudes-1.9.49-mac-arm64.dmg'), HASH_A);
});

test('parseChecksumFile: space-star (binary mode) shasum line', () => {
  const text = `${HASH_A} *Claudes-1.9.49-mac-arm64.dmg\n`;
  assert.equal(parseChecksumFile(text, 'Claudes-1.9.49-mac-arm64.dmg'), HASH_A);
});

test('parseChecksumFile: multi-line file picks the matching filename', () => {
  const text = [
    `${HASH_B}  Claudes-1.9.49-mac-x64.dmg`,
    `${HASH_A}  Claudes-1.9.49-mac-arm64.dmg`
  ].join('\n');
  assert.equal(parseChecksumFile(text, 'Claudes-1.9.49-mac-arm64.dmg'), HASH_A);
});

test('parseChecksumFile: bare-hash single-line sidecar accepted', () => {
  const text = `${HASH_A}\n`;
  assert.equal(parseChecksumFile(text, 'Claudes-1.9.49-mac-arm64.dmg'), HASH_A);
});

test('parseChecksumFile: tolerates a leading ./ on the filename', () => {
  const text = `${HASH_A}  ./Claudes-1.9.49-mac-arm64.dmg\n`;
  assert.equal(parseChecksumFile(text, 'Claudes-1.9.49-mac-arm64.dmg'), HASH_A);
});

test('parseChecksumFile: returns null for malformed/short hash', () => {
  const text = `deadbeef  Claudes-1.9.49-mac-arm64.dmg\n`;
  assert.equal(parseChecksumFile(text, 'Claudes-1.9.49-mac-arm64.dmg'), null);
});

test('parseChecksumFile: returns null when filename is missing and multiple lines present', () => {
  const text = [
    `${HASH_B}  Claudes-1.9.49-mac-x64.dmg`,
    `${HASH_A}  Claudes-1.9.49-mac-universal.dmg`
  ].join('\n');
  assert.equal(parseChecksumFile(text, 'Claudes-1.9.49-mac-arm64.dmg'), null);
});

test('parseChecksumFile: returns null for empty text', () => {
  assert.equal(parseChecksumFile('', 'Claudes-1.9.49-mac-arm64.dmg'), null);
});

test('parseChecksumFile: uppercase hash lowercased on return', () => {
  const text = `${HASH_A.toUpperCase()}  Claudes-1.9.49-mac-arm64.dmg\n`;
  assert.equal(parseChecksumFile(text, 'Claudes-1.9.49-mac-arm64.dmg'), HASH_A);
});

test('checksumsMatch: case-insensitive match returns true', () => {
  assert.equal(checksumsMatch(HASH_A, HASH_A.toUpperCase()), true);
});

test('checksumsMatch: mismatch returns false', () => {
  assert.equal(checksumsMatch(HASH_A, HASH_B), false);
});

test('checksumsMatch: falsy expected returns false', () => {
  assert.equal(checksumsMatch(null, HASH_A), false);
  assert.equal(checksumsMatch(HASH_A, null), false);
  assert.equal(checksumsMatch(undefined, undefined), false);
});

test('checksumsMatch: rejects non-64-hex input', () => {
  assert.equal(checksumsMatch('deadbeef', 'deadbeef'), false);
  assert.equal(checksumsMatch(HASH_A, HASH_A + 'a'), false);
});
