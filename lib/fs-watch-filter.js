// Filter for the Explorer's project-root fs.watch. The watch is
// non-recursive, so `filename` is a single root entry name. Anything with a
// path separator should not occur and is dropped defensively.
function isRelevantRootEvent(filename, ignoredSet) {
  if (filename === null || filename === undefined) return true;
  const name = String(filename);
  if (!name) return true;
  if (name.indexOf('/') !== -1 || name.indexOf('\\') !== -1) return false;
  if (ignoredSet && ignoredSet.has(name)) return false;
  return true;
}

module.exports = { isRelevantRootEvent };
