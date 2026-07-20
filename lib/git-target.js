function getGitTargetCwd(state, allColumns, activeProjectKey) {
  if (!state || state.focusedColumnId == null) return activeProjectKey;
  const col = allColumns.get(state.focusedColumnId);
  if (!col || !col.cwd) return activeProjectKey;
  return col.cwd;
}

// Mirrors renderer.js's normalizePathForCompare: backslashes to forward
// slashes, strip a trailing slash, lowercase a Windows drive letter.
function normalizeCwdForCompare(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (/^[A-Za-z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}

function truncateLeaf(leaf) {
  // Use Array.from (code-point aware) rather than .length/.slice (UTF-16
  // code-unit based) so an astral character (e.g. an emoji in a directory
  // name) doesn't get split mid-surrogate-pair and render as a replacement
  // glyph.
  const chars = Array.from(leaf);
  if (chars.length <= 14) return leaf;
  return chars.slice(0, 14).join('') + '…';
}

function describeColumnTarget({ cwd, projectRoot, cwdSource, isDiff } = {}) {
  const empty = { show: false, kind: null, label: '', title: '' };
  if (!cwd) return empty;

  const cwdNorm = normalizeCwdForCompare(cwd);
  const rootNorm = normalizeCwdForCompare(projectRoot);
  if (cwdNorm === rootNorm) return empty;

  const segments = cwdNorm.split('/').filter(Boolean);
  const leaf = truncateLeaf(segments.length ? segments[segments.length - 1] : cwdNorm);

  if (isDiff) {
    return {
      show: true,
      kind: cwdSource === 'auto-worktree' ? 'worktree' : 'cwd',
      label: (cwdSource === 'auto-worktree' ? '⎇ ' : '→ ') + leaf,
      title: 'Diff target: ' + cwd,
    };
  }

  if (cwdSource === 'auto-worktree') {
    return {
      show: true,
      kind: 'worktree',
      label: '⎇ ' + leaf,
      title: 'Git tab bound to ' + cwd + ' — display only; this column runs in the project root',
    };
  }

  return {
    show: true,
    kind: 'cwd',
    label: '→ ' + leaf,
    title: 'Working directory: ' + cwd,
  };
}

function describeGitPanelState({ isRepo, branch } = {}) {
  if (!isRepo) {
    return { mode: 'no-repo', label: 'Not a git repository', actionsEnabled: false };
  }
  const trimmed = typeof branch === 'string' ? branch.trim() : '';
  if (trimmed) {
    return { mode: 'branch', label: trimmed, actionsEnabled: true };
  }
  return { mode: 'detached', label: 'detached HEAD', actionsEnabled: true };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getGitTargetCwd, describeGitPanelState, describeColumnTarget };
}
if (typeof window !== 'undefined') {
  window.GitTarget = { getGitTargetCwd, describeGitPanelState, describeColumnTarget };
}
