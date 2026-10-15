// Decision helper for caching a parsed file in memory: the cached entry is
// still good while the file's mtime and size match what we recorded. Pure: the
// caller does the fs.statSync and holds the cache.
function isFresh(entry, stat) {
  if (!entry || !stat) return false;
  return entry.mtimeMs === stat.mtimeMs && entry.size === stat.size;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isFresh: isFresh };
}
if (typeof window !== 'undefined') {
  window.StatCache = { isFresh: isFresh };
}
