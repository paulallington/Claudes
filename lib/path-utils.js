async function resolveWorktreeCandidates(projectPath, value, statFn, gitListWorktreesFn) {
  if (!value) return { kind: 'none' };
  const path = require('path');
  const candidates = [
    path.isAbsolute(value) ? value : null,
    path.isAbsolute(value) ? null : path.join(projectPath, value),
    path.isAbsolute(value) ? null : path.join(projectPath, '.claude', 'worktrees', value),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const st = await statFn(p);
      if (st.isDirectory()) return { kind: 'cwd', path: p };
    } catch {}
  }
  if (gitListWorktreesFn) {
    try {
      const worktrees = await gitListWorktreesFn(projectPath);
      if (Array.isArray(worktrees) && worktrees.length > 0) {
        const valLower = value.toLowerCase();
        const refsValLower = ('refs/heads/' + value).toLowerCase();
        const hit = worktrees.find(wt => {
          if (!wt || !wt.path) return false;
          const branchLower = (wt.branch || '').toLowerCase();
          if (branchLower === valLower) return true;
          if (branchLower === refsValLower) return true;
          if (path.basename(wt.path).toLowerCase() === valLower) return true;
          return false;
        });
        if (hit) {
          try {
            const st = await statFn(hit.path);
            if (st.isDirectory()) return { kind: 'cwd', path: hit.path };
          } catch {}
        }
      }
    } catch {}
  }
  return { kind: 'flag', name: value };
}

async function pathIsDirectory(p, statFn) {
  if (!p) return false;
  try {
    const st = await statFn(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveWorktreeCandidates, pathIsDirectory };
}
