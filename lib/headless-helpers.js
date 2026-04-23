function deriveHeadlessTitle(prompt) {
  if (typeof prompt !== 'string') return '(empty)';
  const lines = prompt.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 80);
  }
  return '(empty)';
}

function evictOldHeadlessRuns(runs, cap) {
  if (!Array.isArray(runs)) return { kept: [], evicted: [] };
  if (runs.length <= cap) return { kept: runs.slice(), evicted: [] };
  return {
    kept: runs.slice(0, cap),
    evicted: runs.slice(cap)
  };
}

module.exports = { deriveHeadlessTitle, evictOldHeadlessRuns };
