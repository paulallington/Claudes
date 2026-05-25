function normalizePath(p) {
  if (!p) return '';
  let s = String(p);
  s = s.replace(/\\\\/g, '\\');
  s = s.replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (/^[A-Za-z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}

function detectActiveWorktree(jsonlContent, worktrees) {
  if (!jsonlContent || !Array.isArray(worktrees) || worktrees.length === 0) return null;
  const normalized = worktrees.map(w => ({
    path: w.path,
    branch: w.branch || null,
    norm: normalizePath(w.path)
  }));
  const counts = new Map();

  function tally(rawPath) {
    const norm = normalizePath(rawPath);
    if (!norm) return;
    // Pick the longest worktree prefix that matches (so a nested worktree wins
    // over its parent project root).
    let bestNorm = null;
    let bestLen = -1;
    for (const w of normalized) {
      if (norm === w.norm || norm.startsWith(w.norm + '/')) {
        if (w.norm.length > bestLen) {
          bestLen = w.norm.length;
          bestNorm = w.norm;
        }
      }
    }
    if (bestNorm !== null) counts.set(bestNorm, (counts.get(bestNorm) || 0) + 1);
  }

  const cdRegex = /cd\s+([A-Za-z]:[\\/][^\s"&|;'<>]+)/g;
  let m;
  while ((m = cdRegex.exec(jsonlContent)) !== null) tally(m[1]);

  const fpRegex = /"file_path":"([^"]+)"/g;
  while ((m = fpRegex.exec(jsonlContent)) !== null) tally(m[1]);

  let bestNorm = null;
  let bestCount = 0;
  counts.forEach((cnt, norm) => {
    if (cnt > bestCount) { bestCount = cnt; bestNorm = norm; }
  });
  if (bestCount < 3) return null;
  const winner = normalized.find(w => w.norm === bestNorm);
  return winner ? { path: winner.path, branch: winner.branch, hits: bestCount } : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { detectActiveWorktree, normalizePath };
}
if (typeof window !== 'undefined') {
  window.WorktreeDetect = { detectActiveWorktree };
}
