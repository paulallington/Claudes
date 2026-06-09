const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { columnTranscriptPath, resolveTranscriptPath } = require('../lib/voice-transcript-path');

test('columnTranscriptPath builds the sanitized .claude/projects path', () => {
  const p = columnTranscriptPath('/home/me', 'D:\\Git Repos\\Claudes', 'sess-123');
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
    homeDir: '/home/me', transcriptPath: explicit,
    cwd: '/proj/sub', projectKey: '/proj', sessionId: 'sess',
    exists: (p) => p === explicit,
  });
  assert.equal(r.resolvedPath, explicit);
});

test('resolveTranscriptPath resolves via cwd when cwd != projectKey', () => {
  const cwdPath = columnTranscriptPath('/home/me', '/proj/sub', 'sess');
  const projectPath = columnTranscriptPath('/home/me', '/proj', 'sess');
  assert.notEqual(cwdPath, projectPath); // sanity: distinct keys
  const r = resolveTranscriptPath({
    homeDir: '/home/me', cwd: '/proj/sub', projectKey: '/proj', sessionId: 'sess',
    exists: (p) => p === cwdPath, // only the cwd-derived file exists on disk
  });
  assert.equal(r.resolvedPath, cwdPath);
  assert.equal(r.triedCwdPath, cwdPath);
  assert.equal(r.triedProjectPath, projectPath);
});

test('resolveTranscriptPath falls back to projectKey when cwd path missing', () => {
  const projectPath = columnTranscriptPath('/home/me', '/proj', 'sess');
  const r = resolveTranscriptPath({
    homeDir: '/home/me', cwd: '/proj/sub', projectKey: '/proj', sessionId: 'sess',
    exists: (p) => p === projectPath, // only the projectKey-derived file exists
  });
  assert.equal(r.resolvedPath, projectPath);
});

test('resolveTranscriptPath: cwd == projectKey resolves identically (backward compat)', () => {
  const samePath = columnTranscriptPath('/home/me', '/proj', 'sess');
  const r = resolveTranscriptPath({
    homeDir: '/home/me', cwd: '/proj', projectKey: '/proj', sessionId: 'sess',
    exists: (p) => p === samePath,
  });
  assert.equal(r.resolvedPath, samePath);
  assert.equal(r.triedCwdPath, samePath);
  assert.equal(r.triedProjectPath, samePath);
});

test('resolveTranscriptPath: cwd absent still resolves via projectKey', () => {
  const projectPath = columnTranscriptPath('/home/me', '/proj', 'sess');
  const r = resolveTranscriptPath({
    homeDir: '/home/me', projectKey: '/proj', sessionId: 'sess',
    exists: (p) => p === projectPath,
  });
  assert.equal(r.resolvedPath, projectPath);
  assert.equal(r.triedCwdPath, null); // no cwd -> no cwd candidate
});

test('resolveTranscriptPath returns null when nothing exists', () => {
  const r = resolveTranscriptPath({
    homeDir: '/home/me', cwd: '/proj/sub', projectKey: '/proj', sessionId: 'sess',
    exists: () => false,
  });
  assert.equal(r.resolvedPath, null);
});

test('columnTranscriptPath sanitizes a traversal sessionId so it cannot escape', () => {
  const home = '/home/me';
  const p = columnTranscriptPath(home, 'proj', '../../../../etc/passwd');
  const root = path.resolve(path.join(home, '.claude', 'projects'));
  // No '..' survives, and the resolved path stays under the projects root.
  assert.ok(!p.includes('..'), `path still contains traversal: ${p}`);
  const resolved = path.resolve(p);
  assert.ok(resolved === root || resolved.startsWith(root + path.sep), `escaped root: ${resolved}`);
  assert.ok(p.endsWith('.jsonl'));
});

test('resolveTranscriptPath rejects a verbatim transcriptPath outside the projects root', () => {
  const home = '/home/me';
  const r = resolveTranscriptPath({
    homeDir: home, transcriptPath: '/etc/passwd.jsonl', sessionId: 'sess',
    exists: () => true, // even though it "exists", it must be rejected for being out-of-root
  });
  assert.equal(r.resolvedPath, null);
});

test('resolveTranscriptPath rejects a transcriptPath that escapes via ..', () => {
  const home = '/home/me';
  const escaping = path.join(home, '.claude', 'projects', '..', '..', 'secret.jsonl');
  const r = resolveTranscriptPath({
    homeDir: home, transcriptPath: escaping, sessionId: 'sess',
    exists: () => true,
  });
  assert.equal(r.resolvedPath, null);
});

test('resolveTranscriptPath rejects a non-.jsonl transcriptPath', () => {
  const home = '/home/me';
  const inRootButWrongExt = path.join(home, '.claude', 'projects', 'proj', 'sess.txt');
  const r = resolveTranscriptPath({
    homeDir: home, transcriptPath: inRootButWrongExt, sessionId: 'sess',
    exists: () => true,
  });
  assert.equal(r.resolvedPath, null);
});

test('resolveTranscriptPath accepts a normal in-root .jsonl transcriptPath', () => {
  const home = '/home/me';
  const good = path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl');
  const r = resolveTranscriptPath({
    homeDir: home, transcriptPath: good, sessionId: 'sess',
    exists: (p) => p === good,
  });
  assert.equal(r.resolvedPath, good);
});
