const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scrubArtifactsImpl } = require('../lib/review-comments');

function setupTmpProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudes-scrub-'));
  const claudesDir = path.join(tmpDir, '.claudes');
  fs.mkdirSync(claudesDir, { recursive: true });
  const files = {
    // Untouched (no workspace scope)
    'sticky-notes.json':                                'untouched',
    // Untouched (different workspace)
    'sticky-notes-WS_OTHER.json':                       'other',
    // Removed (target wsId)
    'sticky-notes-WS_TARGET.json':                      'target',
    'sticky-notes-WS_TARGET-extra.json':                'target-extra',
    // Untouched (no workspace scope)
    'review-comments-SESSION1.json':                    'session1',
    // Untouched (different workspace)
    'review-comments-WS_OTHER-SESSION1.json':           'other-session1',
    // Removed (target)
    'review-comments-WS_TARGET-SESSION1.json':          'target-session1',
    'review-comments-WS_TARGET-SESSION2-commit-abc1234.json': 'target-commit',
    'review-comments-WS_TARGET-pending-col5.json':      'target-pending'
  };
  for (const name of Object.keys(files)) {
    fs.writeFileSync(path.join(claudesDir, name), files[name], 'utf8');
  }
  return { tmpDir, claudesDir, files };
}

function cleanup(tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

test('scrubArtifactsImpl: removes target-workspace artifacts and leaves others alone', () => {
  const { tmpDir, claudesDir } = setupTmpProject();
  try {
    const result = scrubArtifactsImpl(tmpDir, 'WS_TARGET');
    assert.strictEqual(result.removed, 5, 'expected 5 files removed');

    // Removed
    assert.ok(!fs.existsSync(path.join(claudesDir, 'sticky-notes-WS_TARGET.json')));
    assert.ok(!fs.existsSync(path.join(claudesDir, 'sticky-notes-WS_TARGET-extra.json')));
    assert.ok(!fs.existsSync(path.join(claudesDir, 'review-comments-WS_TARGET-SESSION1.json')));
    assert.ok(!fs.existsSync(path.join(claudesDir, 'review-comments-WS_TARGET-SESSION2-commit-abc1234.json')));
    assert.ok(!fs.existsSync(path.join(claudesDir, 'review-comments-WS_TARGET-pending-col5.json')));

    // Untouched
    assert.ok(fs.existsSync(path.join(claudesDir, 'sticky-notes.json')));
    assert.ok(fs.existsSync(path.join(claudesDir, 'sticky-notes-WS_OTHER.json')));
    assert.ok(fs.existsSync(path.join(claudesDir, 'review-comments-SESSION1.json')));
    assert.ok(fs.existsSync(path.join(claudesDir, 'review-comments-WS_OTHER-SESSION1.json')));
  } finally {
    cleanup(tmpDir);
  }
});

test('scrubArtifactsImpl: rejects path-traversal wsId via safeIdSegment', () => {
  const { tmpDir } = setupTmpProject();
  try {
    assert.throws(
      () => scrubArtifactsImpl(tmpDir, '../escape'),
      /invalid id segment/
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('scrubArtifactsImpl: rejects empty wsId', () => {
  const { tmpDir } = setupTmpProject();
  try {
    assert.throws(
      () => scrubArtifactsImpl(tmpDir, ''),
      /invalid id segment/
    );
  } finally {
    cleanup(tmpDir);
  }
});

test('scrubArtifactsImpl: returns {removed:0} when .claudes dir does not exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudes-scrub-empty-'));
  try {
    const result = scrubArtifactsImpl(tmpDir, 'WS_TARGET');
    assert.deepEqual(result, { removed: 0 });
  } finally {
    cleanup(tmpDir);
  }
});

test('scrubArtifactsImpl: returns {removed:0} when no matching files exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudes-scrub-nomatch-'));
  const claudesDir = path.join(tmpDir, '.claudes');
  fs.mkdirSync(claudesDir, { recursive: true });
  fs.writeFileSync(path.join(claudesDir, 'sticky-notes.json'), 'x', 'utf8');
  fs.writeFileSync(path.join(claudesDir, 'review-comments-SESSION1.json'), 'x', 'utf8');
  try {
    const result = scrubArtifactsImpl(tmpDir, 'WS_NOMATCH');
    assert.strictEqual(result.removed, 0);
    // Files still there
    assert.ok(fs.existsSync(path.join(claudesDir, 'sticky-notes.json')));
    assert.ok(fs.existsSync(path.join(claudesDir, 'review-comments-SESSION1.json')));
  } finally {
    cleanup(tmpDir);
  }
});
