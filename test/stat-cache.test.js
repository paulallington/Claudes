const test = require('node:test');
const assert = require('node:assert/strict');
const { isFresh } = require('../lib/stat-cache');

test('isFresh: same mtime and size is fresh', () => {
  assert.equal(isFresh({ mtimeMs: 100.5, size: 42 }, { mtimeMs: 100.5, size: 42 }), true);
});

test('isFresh: changed mtime or size is stale', () => {
  assert.equal(isFresh({ mtimeMs: 100, size: 42 }, { mtimeMs: 101, size: 42 }), false);
  assert.equal(isFresh({ mtimeMs: 100, size: 42 }, { mtimeMs: 100, size: 43 }), false);
});

test('isFresh: missing entry or stat is stale', () => {
  assert.equal(isFresh(null, { mtimeMs: 1, size: 1 }), false);
  assert.equal(isFresh({ mtimeMs: 1, size: 1 }, null), false);
  assert.equal(isFresh(undefined, undefined), false);
});
