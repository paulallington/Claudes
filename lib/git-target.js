function getGitTargetCwd(state, allColumns, activeProjectKey) {
  if (!state || state.focusedColumnId == null) return activeProjectKey;
  const col = allColumns.get(state.focusedColumnId);
  if (!col || !col.cwd) return activeProjectKey;
  return col.cwd;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getGitTargetCwd };
}
if (typeof window !== 'undefined') {
  window.GitTarget = { getGitTargetCwd };
}
