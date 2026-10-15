const test = require('node:test');
const assert = require('node:assert/strict');
const { isRelevantRootEvent } = require('../lib/fs-watch-filter');

const ignored = new Set(['.git', 'node_modules']);

test('events with a missing filename are relevant (Windows sometimes omits it)', () => {
  assert.strictEqual(isRelevantRootEvent(null, ignored), true);
  assert.strictEqual(isRelevantRootEvent(undefined, ignored), true);
  assert.strictEqual(isRelevantRootEvent('', ignored), true);
});

test('events for ignored directory names are not relevant', () => {
  assert.strictEqual(isRelevantRootEvent('node_modules', ignored), false);
  assert.strictEqual(isRelevantRootEvent('.git', ignored), false);
});

test('ordinary root entries are relevant', () => {
  assert.strictEqual(isRelevantRootEvent('README.md', ignored), true);
  assert.strictEqual(isRelevantRootEvent('src', ignored), true);
});

test('names containing a path separator are not relevant', () => {
  assert.strictEqual(isRelevantRootEvent('src/deep.js', ignored), false);
  assert.strictEqual(isRelevantRootEvent('src\\deep.js', ignored), false);
});

test('a Buffer filename is handled', () => {
  assert.strictEqual(isRelevantRootEvent(Buffer.from('node_modules'), ignored), false);
  assert.strictEqual(isRelevantRootEvent(Buffer.from('a.txt'), ignored), true);
});
