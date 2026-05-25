function findLastGitBranch(content) {
  if (!content) return null;
  const matches = content.match(/"gitBranch":"([^"]*)"/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const m = last.match(/"gitBranch":"([^"]*)"/);
  return m && m[1] ? m[1] : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { findLastGitBranch };
}
