const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const {
  safeIdSegment,
  comparePosition,
  groupByFile,
  formatCommentsForCopy,
  migratePendingComments,
  computeDiffSlotKey
} = require('../lib/review-comments');

// ---------------------------------------------------------------------------
// safeIdSegment
// ---------------------------------------------------------------------------

test('safeIdSegment: accepts simple alphanumeric', () => {
  assert.strictEqual(safeIdSegment('abc'), 'abc');
});

test('safeIdSegment: accepts alphanumeric with underscore and dash', () => {
  assert.strictEqual(safeIdSegment('abc_def-1'), 'abc_def-1');
});

test('safeIdSegment: accepts single char', () => {
  assert.strictEqual(safeIdSegment('a'), 'a');
});

test('safeIdSegment: accepts mixed case', () => {
  assert.strictEqual(safeIdSegment('AbCdEf'), 'AbCdEf');
});

test('safeIdSegment: accepts 64-char alphanumeric string', () => {
  const s64 = 'a'.repeat(64);
  assert.strictEqual(safeIdSegment(s64), s64);
});

test('safeIdSegment: rejects empty string', () => {
  assert.throws(() => safeIdSegment(''), /invalid id segment/);
});

test('safeIdSegment: rejects path-separator characters', () => {
  assert.throws(() => safeIdSegment('a/b'), /invalid id segment/);
});

test('safeIdSegment: rejects dots (parent-traversal)', () => {
  assert.throws(() => safeIdSegment('a..b'), /invalid id segment/);
});

test('safeIdSegment: rejects spaces', () => {
  assert.throws(() => safeIdSegment('a b'), /invalid id segment/);
});

test('safeIdSegment: rejects semicolons', () => {
  assert.throws(() => safeIdSegment('a;b'), /invalid id segment/);
});

test('safeIdSegment: rejects 65-char string', () => {
  assert.throws(() => safeIdSegment('a'.repeat(65)), /invalid id segment/);
});

test('safeIdSegment: rejects null', () => {
  assert.throws(() => safeIdSegment(null), /invalid id segment/);
});

test('safeIdSegment: rejects undefined', () => {
  assert.throws(() => safeIdSegment(undefined), /invalid id segment/);
});

test('safeIdSegment: rejects numbers', () => {
  assert.throws(() => safeIdSegment(5), /invalid id segment/);
});

test('safeIdSegment: rejects objects', () => {
  assert.throws(() => safeIdSegment({}), /invalid id segment/);
});

// ---------------------------------------------------------------------------
// comparePosition
// ---------------------------------------------------------------------------

test('comparePosition: sorts by filePath first', () => {
  const a = { filePath: 'a.js', startLine: 10 };
  const b = { filePath: 'b.js', startLine: 1 };
  assert.strictEqual(comparePosition(a, b), -1);
  assert.strictEqual(comparePosition(b, a), 1);
});

test('comparePosition: sorts by startLine when filePaths equal', () => {
  const a = { filePath: 'a.js', startLine: 5 };
  const b = { filePath: 'a.js', startLine: 10 };
  assert.strictEqual(comparePosition(a, b), -1);
  assert.strictEqual(comparePosition(b, a), 1);
});

test('comparePosition: returns 0 for equal positions', () => {
  const a = { filePath: 'a.js', startLine: 5 };
  const b = { filePath: 'a.js', startLine: 5 };
  assert.strictEqual(comparePosition(a, b), 0);
});

// ---------------------------------------------------------------------------
// groupByFile
// ---------------------------------------------------------------------------

test('groupByFile: empty array returns empty object', () => {
  assert.deepEqual(groupByFile([]), {});
});

test('groupByFile: single comment', () => {
  const c = { id: '1', filePath: 'a.js', startLine: 5 };
  const out = groupByFile([c]);
  assert.deepEqual(Object.keys(out), ['a.js']);
  assert.deepEqual(out['a.js'], [c]);
});

test('groupByFile: three same-file comments are sorted by startLine', () => {
  const a = { id: '1', filePath: 'a.js', startLine: 30 };
  const b = { id: '2', filePath: 'a.js', startLine: 5 };
  const c = { id: '3', filePath: 'a.js', startLine: 12 };
  const out = groupByFile([a, b, c]);
  assert.deepEqual(Object.keys(out), ['a.js']);
  assert.deepEqual(out['a.js'].map(x => x.startLine), [5, 12, 30]);
});

test('groupByFile: three multi-file comments group correctly and sort within group', () => {
  const a = { id: '1', filePath: 'a.js', startLine: 30 };
  const b = { id: '2', filePath: 'b.js', startLine: 5 };
  const c = { id: '3', filePath: 'a.js', startLine: 5 };
  const out = groupByFile([a, b, c]);
  const keys = Object.keys(out).sort();
  assert.deepEqual(keys, ['a.js', 'b.js']);
  assert.deepEqual(out['a.js'].map(x => x.startLine), [5, 30]);
  assert.deepEqual(out['b.js'].map(x => x.startLine), [5]);
});

// ---------------------------------------------------------------------------
// formatCommentsForCopy
// ---------------------------------------------------------------------------

test('formatCommentsForCopy: empty array returns empty string', () => {
  assert.strictEqual(formatCommentsForCopy([], '/proj'), '');
});

test('formatCommentsForCopy: single single-line comment', () => {
  const c = { filePath: 'a.js', startLine: 5, endLine: 5, text: 'hello' };
  assert.strictEqual(formatCommentsForCopy([c], null), 'a.js:5\nhello');
});

test('formatCommentsForCopy: single range comment', () => {
  const c = { filePath: 'a.js', startLine: 8, endLine: 11, text: 'multi' };
  assert.strictEqual(formatCommentsForCopy([c], null), 'a.js:8-11\nmulti');
});

test('formatCommentsForCopy: two comments same file are blank-line separated', () => {
  const a = { filePath: 'a.js', startLine: 5, endLine: 5, text: 'first' };
  const b = { filePath: 'a.js', startLine: 12, endLine: 12, text: 'second' };
  const out = formatCommentsForCopy([a, b], null);
  assert.strictEqual(out, 'a.js:5\nfirst\n\na.js:12\nsecond');
});

test('formatCommentsForCopy: two files are blank-line separated and sorted alphabetically', () => {
  const b = { filePath: 'b.js', startLine: 1, endLine: 1, text: 'two' };
  const a = { filePath: 'a.js', startLine: 1, endLine: 1, text: 'one' };
  const out = formatCommentsForCopy([b, a], null);
  assert.strictEqual(out, 'a.js:1\none\n\nb.js:1\ntwo');
});

test('formatCommentsForCopy: strips projectKey prefix to make relative path', () => {
  const c = { filePath: '/proj/lib/a.js', startLine: 5, endLine: 5, text: 'hello' };
  assert.strictEqual(formatCommentsForCopy([c], '/proj'), 'lib/a.js:5\nhello');
});

test('formatCommentsForCopy: backslash path stripped and normalized to forward slashes', () => {
  const c = { filePath: 'C:\\proj\\lib\\a.js', startLine: 5, endLine: 5, text: 'hello' };
  assert.strictEqual(formatCommentsForCopy([c], 'C:\\proj'), 'lib/a.js:5\nhello');
});

test('formatCommentsForCopy: null projectKey leaves path unchanged but normalizes backslashes', () => {
  const c = { filePath: 'C:\\proj\\lib\\a.js', startLine: 5, endLine: 5, text: 'hi' };
  assert.strictEqual(formatCommentsForCopy([c], null), 'C:/proj/lib/a.js:5\nhi');
});

test('formatCommentsForCopy: undefined projectKey leaves path unchanged but normalizes backslashes', () => {
  const c = { filePath: 'C:\\proj\\lib\\a.js', startLine: 5, endLine: 5, text: 'hi' };
  assert.strictEqual(formatCommentsForCopy([c], undefined), 'C:/proj/lib/a.js:5\nhi');
});

test('formatCommentsForCopy: empty-string projectKey leaves path unchanged but normalizes backslashes', () => {
  const c = { filePath: 'C:\\proj\\lib\\a.js', startLine: 5, endLine: 5, text: 'hi' };
  assert.strictEqual(formatCommentsForCopy([c], ''), 'C:/proj/lib/a.js:5\nhi');
});

test('formatCommentsForCopy: no trailing newline at end', () => {
  const c = { filePath: 'a.js', startLine: 5, endLine: 5, text: 'hello' };
  const out = formatCommentsForCopy([c], null);
  assert.ok(!out.endsWith('\n'), 'output should not end with newline');
});

// ---------------------------------------------------------------------------
// migratePendingComments
// ---------------------------------------------------------------------------

test('migratePendingComments: empty src + empty dst returns []', () => {
  assert.deepEqual(migratePendingComments([], []), []);
});

test('migratePendingComments: empty src + 2 dst returns 2 dst items in order', () => {
  const d1 = { id: 'D1', text: 'd1' };
  const d2 = { id: 'D2', text: 'd2' };
  assert.deepEqual(migratePendingComments([], [d1, d2]), [d1, d2]);
});

test('migratePendingComments: 2 src + empty dst returns 2 src items in order', () => {
  const s1 = { id: 'S1', text: 's1' };
  const s2 = { id: 'S2', text: 's2' };
  assert.deepEqual(migratePendingComments([s1, s2], []), [s1, s2]);
});

test('migratePendingComments: 2 src + 2 dst with no id overlap returns src first then dst', () => {
  const s1 = { id: 'S1' };
  const s2 = { id: 'S2' };
  const d1 = { id: 'D1' };
  const d2 = { id: 'D2' };
  assert.deepEqual(migratePendingComments([s1, s2], [d1, d2]), [s1, s2, d1, d2]);
});

test('migratePendingComments: id conflict — source wins', () => {
  const s = { id: 'A', text: 'src' };
  const d = { id: 'A', text: 'dst' };
  const out = migratePendingComments([s], [d]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].text, 'src');
});

test('migratePendingComments: src order preserved with interleaved dst', () => {
  const s1 = { id: 'A', text: 's-A' };
  const s2 = { id: 'C', text: 's-C' };
  const d1 = { id: 'B', text: 'd-B' };
  const d2 = { id: 'C', text: 'd-C' }; // conflict, src wins
  const d3 = { id: 'D', text: 'd-D' };
  const out = migratePendingComments([s1, s2], [d1, d2, d3]);
  assert.deepEqual(out.map(x => x.id), ['A', 'C', 'B', 'D']);
  // Confirm src text won on conflict
  assert.strictEqual(out.find(x => x.id === 'C').text, 's-C');
});

test('migratePendingComments: non-array src treated as empty', () => {
  const d1 = { id: 'D1' };
  assert.deepEqual(migratePendingComments(null, [d1]), [d1]);
  assert.deepEqual(migratePendingComments(undefined, [d1]), [d1]);
  assert.deepEqual(migratePendingComments('not-an-array', [d1]), [d1]);
});

test('migratePendingComments: non-array dst treated as empty', () => {
  const s1 = { id: 'S1' };
  assert.deepEqual(migratePendingComments([s1], null), [s1]);
  assert.deepEqual(migratePendingComments([s1], undefined), [s1]);
});

test('migratePendingComments: both non-array returns []', () => {
  assert.deepEqual(migratePendingComments(null, null), []);
});

// ---------------------------------------------------------------------------
// computeDiffSlotKey
// ---------------------------------------------------------------------------

test('computeDiffSlotKey: null sessionId yields __noSession__ in key', () => {
  const k = computeDiffSlotKey(null, '/x/a.js', 'working');
  assert.ok(k.indexOf('__noSession__') >= 0, 'expected __noSession__ in key');
});

test('computeDiffSlotKey: same triplet yields identical strings', () => {
  const a = computeDiffSlotKey('S1', '/x/a.js', 'working');
  const b = computeDiffSlotKey('S1', '/x/a.js', 'working');
  assert.strictEqual(a, b);
});

test('computeDiffSlotKey: different filePath yields different keys', () => {
  const a = computeDiffSlotKey('S1', '/x/a.js', 'working');
  const b = computeDiffSlotKey('S1', '/x/b.js', 'working');
  assert.notStrictEqual(a, b);
});

test('computeDiffSlotKey: different scope yields different keys', () => {
  const a = computeDiffSlotKey('S1', '/x/a.js', 'working');
  const b = computeDiffSlotKey('S1', '/x/a.js', 'commit-abc1234');
  assert.notStrictEqual(a, b);
});

test('computeDiffSlotKey: different sessionId yields different keys', () => {
  const a = computeDiffSlotKey('S1', '/x/a.js', 'working');
  const b = computeDiffSlotKey('S2', '/x/a.js', 'working');
  assert.notStrictEqual(a, b);
});

test('computeDiffSlotKey: format prefix is diffContent::', () => {
  const k = computeDiffSlotKey('S1', '/x/a.js', 'working');
  assert.ok(k.indexOf('diffContent::') === 0);
});

// ---------------------------------------------------------------------------
// UMD dual-export
// ---------------------------------------------------------------------------

test('UMD: CommonJS require populates exports object', () => {
  const mod = require('../lib/review-comments');
  assert.ok(mod && typeof mod === 'object');
  assert.ok(typeof mod.safeIdSegment === 'function');
  assert.ok(typeof mod.formatCommentsForCopy === 'function');
});

test('UMD: browser path (module undefined) populates globalThis.ReviewComments', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'review-comments.js'),
    'utf8'
  );
  const sandbox = vm.createContext({ globalThis: {}, console });
  vm.runInContext(src, sandbox);
  const exported = sandbox.globalThis.ReviewComments;
  assert.ok(exported && typeof exported === 'object', 'globalThis.ReviewComments should be set');
  assert.ok(typeof exported.safeIdSegment === 'function');
});
