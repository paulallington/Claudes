function getGitTargetCwd(state, allColumns, activeProjectKey) {
  if (!state || state.focusedColumnId == null) return activeProjectKey;
  const col = allColumns.get(state.focusedColumnId);
  if (!col || !col.cwd) return activeProjectKey;
  return col.cwd;
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
  module.exports = { getGitTargetCwd, describeGitPanelState };
}
if (typeof window !== 'undefined') {
  window.GitTarget = { getGitTargetCwd, describeGitPanelState };
}
