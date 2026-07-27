const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { columnTranscriptPath, resolveTranscriptPath, isUnderProjectsRoot } = require('../lib/voice-transcript-path');

test('columnTranscriptPath builds the sanitized projects path', () => {
  const p = columnTranscriptPath(path.join('/home/me', '.claude'), 'D:\\Git Repos\\Claudes', 'sess-123');
  const expected = path.join('/home/me', '.claude', 'projects', 'D--Git-Repos-Claudes', 'sess-123.jsonl');
  assert.equal(p, expected);
  assert.ok(p.endsWith('sess-123.jsonl'));
  assert.ok(p.includes(path.join('.claude', 'projects', 'D--Git-Repos-Claudes')));
});

test('columnTranscriptPath returns null on missing args', () => {
  assert.equal(columnTranscriptPath('', 'key', 'sess'), null);
  assert.equal(columnTranscriptPath('/home', '', 'sess'), null);
  assert.equal(columnTranscriptPath('/home', 'key', ''), null);
  assert.equal(columnTranscriptPath(undefined, 'key', 'sess'), null);
  assert.equal(columnTranscriptPath('/home', 'key', undefined), null);
});

test('resolveTranscriptPath prefers an existing transcriptPath arg', () => {
  // The explicit path must itself be in-root and .jsonl now (containment is
  // enforced on the verbatim arg too); it still wins over the derived paths.
  const explicit = path.join('/home/me', '.claude', 'projects', 'explicit', 'file.jsonl');
  const r = resolveTranscriptPath({
    claudeRoot: path.join('/home/me', '.claude'), transcriptPath: explicit,
    cwd: '/proj/sub', projectKey: '/proj', sessionId: 'sess',
    exists: (p) => p === explicit,
  });
  assert.equal(r.resolvedPath, explicit);
});

test('resolveTranscriptPath resolves via cwd when cwd != projectKey', () => {
  const root = path.join('/home/me', '.claude');
  const cwdPath = columnTranscriptPath(root, '/proj/sub', 'sess');
  const projectPath = columnTranscriptPath(root, '/proj', 'sess');
  assert.notEqual(cwdPath, projectPath); // sanity: distinct keys
  const r = resolveTranscriptPath({
    claudeRoot: root, cwd: '/proj/sub', projectKey: '/proj', sessionId: 'sess',
    exists: (p) => p === cwdPath, // only the cwd-derived file exists on disk
  });
  assert.equal(r.resolvedPath, cwdPath);
  assert.equal(r.triedCwdPath, cwdPath);
  assert.equal(r.triedProjectPath, projectPath);
});

test('resolveTranscriptPath falls back to projectKey when cwd path missing', () => {
  const root = path.join('/home/me', '.claude');
  const projectPath = columnTranscriptPath(root, '/proj', 'sess');
  const r = resolveTranscriptPath({
    claudeRoot: root, cwd: '/proj/sub', projectKey: '/proj', sessionId: 'sess',
    exists: (p) => p === projectPath, // only the projectKey-derived file exists
  });
  assert.equal(r.resolvedPath, projectPath);
});

test('resolveTranscriptPath: cwd == projectKey resolves identically (backward compat)', () => {
  const root = path.join('/home/me', '.claude');
  const samePath = columnTranscriptPath(root, '/proj', 'sess');
  const r = resolveTranscriptPath({
    claudeRoot: root, cwd: '/proj', projectKey: '/proj', sessionId: 'sess',
    exists: (p) => p === samePath,
  });
  assert.equal(r.resolvedPath, samePath);
  assert.equal(r.triedCwdPath, samePath);
  assert.equal(r.triedProjectPath, samePath);
});

test('resolveTranscriptPath: cwd absent still resolves via projectKey', () => {
  const root = path.join('/home/me', '.claude');
  const projectPath = columnTranscriptPath(root, '/proj', 'sess');
  const r = resolveTranscriptPath({
    claudeRoot: root, projectKey: '/proj', sessionId: 'sess',
    exists: (p) => p === projectPath,
  });
  assert.equal(r.resolvedPath, projectPath);
  assert.equal(r.triedCwdPath, null); // no cwd -> no cwd candidate
});

test('resolveTranscriptPath returns null when nothing exists', () => {
  const r = resolveTranscriptPath({
    claudeRoot: path.join('/home/me', '.claude'), cwd: '/proj/sub', projectKey: '/proj', sessionId: 'sess',
    exists: () => false,
  });
  assert.equal(r.resolvedPath, null);
});

test('columnTranscriptPath sanitizes a traversal sessionId so it cannot escape', () => {
  const root = path.join('/home/me', '.claude');
  const p = columnTranscriptPath(root, 'proj', '../../../../etc/passwd');
  const projRoot = path.resolve(path.join(root, 'projects'));
  // No '..' survives, and the resolved path stays under the projects root.
  assert.ok(!p.includes('..'), `path still contains traversal: ${p}`);
  const resolved = path.resolve(p);
  assert.ok(resolved === projRoot || resolved.startsWith(projRoot + path.sep), `escaped root: ${resolved}`);
  assert.ok(p.endsWith('.jsonl'));
});

test('resolveTranscriptPath rejects a verbatim transcriptPath outside the projects root', () => {
  const root = path.join('/home/me', '.claude');
  const r = resolveTranscriptPath({
    claudeRoot: root, transcriptPath: '/etc/passwd.jsonl', sessionId: 'sess',
    exists: () => true, // even though it "exists", it must be rejected for being out-of-root
  });
  assert.equal(r.resolvedPath, null);
});

test('resolveTranscriptPath rejects a transcriptPath that escapes via ..', () => {
  const root = path.join('/home/me', '.claude');
  const escaping = path.join(root, 'projects', '..', '..', 'secret.jsonl');
  const r = resolveTranscriptPath({
    claudeRoot: root, transcriptPath: escaping, sessionId: 'sess',
    exists: () => true,
  });
  assert.equal(r.resolvedPath, null);
});

test('resolveTranscriptPath rejects a non-.jsonl transcriptPath', () => {
  const root = path.join('/home/me', '.claude');
  const inRootButWrongExt = path.join(root, 'projects', 'proj', 'sess.txt');
  const r = resolveTranscriptPath({
    claudeRoot: root, transcriptPath: inRootButWrongExt, sessionId: 'sess',
    exists: () => true,
  });
  assert.equal(r.resolvedPath, null);
});

test('resolveTranscriptPath accepts a normal in-root .jsonl transcriptPath', () => {
  const root = path.join('/home/me', '.claude');
  const good = path.join(root, 'projects', 'proj', 'sess.jsonl');
  const r = resolveTranscriptPath({
    claudeRoot: root, transcriptPath: good, sessionId: 'sess',
    exists: (p) => p === good,
  });
  assert.equal(r.resolvedPath, good);
});

test('builds a transcript path under an explicit claude root', () => {
  const p = columnTranscriptPath('/home/me/.claudes/profiles/pf_work', 'D:\\Git Repos\\Claudes', 'sess-123');
  assert.strictEqual(
    p,
    path.join('/home/me/.claudes/profiles/pf_work', 'projects', 'D--Git-Repos-Claudes', 'sess-123.jsonl')
  );
});

test('a Primary-rooted transcript is rejected against a secondary root', () => {
  // The silent-failure case: a secondary-profile column looked up under
  // Primary's root finds nothing and voice goes quiet with no error.
  const primaryPath = path.join('/home/me/.claude', 'projects', 'proj', 'sess.jsonl');
  assert.strictEqual(isUnderProjectsRoot('/home/me/.claudes/profiles/pf_work', primaryPath), false);
  assert.strictEqual(isUnderProjectsRoot('/home/me/.claude', primaryPath), true);
});

test('resolveTranscriptPath honours the profile root', () => {
  const root = '/home/me/.claudes/profiles/pf_work';
  const good = path.join(root, 'projects', 'proj', 'sess.jsonl');
  const r = resolveTranscriptPath({
    claudeRoot: root, projectKey: 'proj', sessionId: 'sess', exists: (p) => p === good
  });
  assert.strictEqual(r.resolvedPath, good);
});

test('resolveTranscriptPath rejects a caller-supplied path from another profile', () => {
  // exists() discriminates on the exact path: only otherProfile "exists". If it
  // returned true unconditionally, the projectKey-derived fallback candidate
  // (legitimately rooted under pf_work) would also pass — which is correct,
  // secure behavior, not the case under test here. This isolates the actual
  // claim: an out-of-root transcriptPath is never returned, wrong-profile or not.
  const otherProfile = path.join('/home/me/.claude', 'projects', 'proj', 'sess.jsonl');
  const r = resolveTranscriptPath({
    claudeRoot: '/home/me/.claudes/profiles/pf_work',
    transcriptPath: otherProfile,
    projectKey: 'proj', sessionId: 'sess',
    exists: (p) => p === otherProfile
  });
  assert.strictEqual(r.resolvedPath, null);
});
