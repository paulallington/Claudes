const path = require('path');

/**
 * Build the absolute path to a column's Claude Code transcript JSONL file.
 * The project key is sanitized the same way the Claude CLI keys its project
 * directories (non-alphanumerics -> '-'). Returns null when any argument is
 * missing or empty.
 * @param {string} homeDir
 * @param {string} projectKey
 * @param {string} sessionId
 * @returns {string|null}
 */
function columnTranscriptPath(homeDir, projectKey, sessionId) {
  if (!homeDir || !projectKey || !sessionId) return null;
  const claudeKey = String(projectKey).replace(/[^a-zA-Z0-9]/g, '-');
  // Sanitize the sessionId the same way as the project key so a malicious
  // sessionId (e.g. '../../../../etc/passwd') can't traverse out of the
  // projects dir. Real session UUIDs are [a-zA-Z0-9-] so this is lossless.
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(homeDir, '.claude', 'projects', claudeKey, safeId + '.jsonl');
}

/**
 * True when `p` resolves to a path inside (or equal to) the Claude projects
 * root under `homeDir`. Used to reject any transcript candidate that would
 * escape `~/.claude/projects` via traversal or an absolute out-of-root path.
 * @param {string} homeDir
 * @param {string} p
 * @returns {boolean}
 */
function isUnderProjectsRoot(homeDir, p) {
  // Resolve BOTH sides so the comparison is drive- and separator-consistent
  // (on Windows path.resolve adds the drive letter; comparing a resolved
  // candidate against an unresolved root would always mismatch).
  let root = path.resolve(path.join(homeDir, '.claude', 'projects'));
  let resolved = path.resolve(p);
  // The Windows filesystem is case-insensitive (esp. the drive letter). Lowercase
  // both sides on win32 — matching the project's isInsideRoot contract — so a
  // differently-cased drive (e.g. `c:\` vs `C:\`) can never silently reject a
  // legit transcript and make voice go quiet. (Strictly more permissive; safe.)
  if (process.platform === 'win32') { root = root.toLowerCase(); resolved = resolved.toLowerCase(); }
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Resolve a column's transcript path, accounting for the fact that the Claude
 * CLI keys its transcript dir by the CWD it actually ran in — which may be a
 * subdirectory of the project root (so `cwd` and `projectKey` differ).
 *
 * Resolution order:
 *   1. `transcriptPath` if it exists (caller already knows the file).
 *   2. The cwd-derived path (`columnTranscriptPath(home, cwd, sessionId)`).
 *   3. The projectKey-derived path (backward-compatible fallback).
 *
 * Returns the first existing path, or null. When `cwd === projectKey` the cwd
 * and project candidates are identical, so behavior is unchanged.
 *
 * @param {object} opts
 * @param {string} opts.homeDir
 * @param {string} [opts.transcriptPath]
 * @param {string} [opts.cwd]
 * @param {string} [opts.projectKey]
 * @param {string} opts.sessionId
 * @param {(p: string) => boolean} opts.exists  predicate (e.g. fs.existsSync)
 * @returns {{
 *   resolvedPath: string|null,
 *   triedCwdPath: string|null,
 *   triedProjectPath: string|null,
 * }}
 */
function resolveTranscriptPath(opts) {
  const o = opts || {};
  const exists = typeof o.exists === 'function' ? o.exists : () => false;
  const home = o.homeDir;
  const triedCwdPath = columnTranscriptPath(home, o.cwd, o.sessionId);
  const triedProjectPath = columnTranscriptPath(home, o.projectKey, o.sessionId);

  // A candidate is usable only when it ends in .jsonl, stays under the projects
  // root, and exists. Applied uniformly to the caller-supplied transcriptPath
  // (which is otherwise trusted verbatim) and the derived paths.
  const accepts = (p) =>
    typeof p === 'string' && p &&
    p.endsWith('.jsonl') &&
    home && isUnderProjectsRoot(home, p) &&
    exists(p);

  let resolvedPath = null;
  if (typeof o.transcriptPath === 'string' && o.transcriptPath && accepts(o.transcriptPath)) {
    resolvedPath = o.transcriptPath;
  } else if (accepts(triedCwdPath)) {
    resolvedPath = triedCwdPath;
  } else if (accepts(triedProjectPath)) {
    resolvedPath = triedProjectPath;
  }

  return { resolvedPath, triedCwdPath, triedProjectPath };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { columnTranscriptPath, resolveTranscriptPath, isUnderProjectsRoot };
}
if (typeof window !== 'undefined') {
  window.VoiceTranscriptPath = { columnTranscriptPath, resolveTranscriptPath, isUnderProjectsRoot };
}
