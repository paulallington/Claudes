(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.WorkspaceScrub = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {

  var ID_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

  function safeIdSegment(s) {
    if (typeof s !== 'string' || !ID_SEGMENT_RE.test(s)) {
      throw new Error('invalid id segment: ' + s);
    }
    return s;
  }

  function scrubArtifactsImpl(projectPath, wsId) {
    safeIdSegment(wsId);
    var fs = require('fs');
    var path = require('path');
    var claudesDir = path.join(projectPath, '.claudes');
    if (!fs.existsSync(claudesDir)) return { removed: 0 };
    var entries;
    try { entries = fs.readdirSync(claudesDir); } catch (err) {
      if (typeof console !== 'undefined') console.error('scrubArtifacts readdir failed:', err);
      return { removed: 0 };
    }
    var stickyPrefix = 'sticky-notes-' + wsId;
    var reviewPrefix = 'review-comments-' + wsId + '-';
    function isStickyMatch(f) {
      // Match only when the wsId is followed by a recognised separator —
      // '.json' (exact), '-...' (suffix variant), or '.corrupt-...' (quarantine).
      // Rejects e.g. 'sticky-notes-WS_TARGET_OTHER.json' where tail begins with '_'.
      if (f.indexOf(stickyPrefix) !== 0) return false;
      var tail = f.substring(stickyPrefix.length);
      return tail === '.json' || tail.charAt(0) === '-' || tail.charAt(0) === '.';
    }
    var removed = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var isSticky = isStickyMatch(entry);
      var isReview = entry.indexOf(reviewPrefix) === 0;
      if (!isSticky && !isReview) continue;
      var full = path.join(claudesDir, entry);
      try { fs.unlinkSync(full); removed++; } catch (err) {
        if (typeof console !== 'undefined') console.error('scrubArtifacts unlink failed for ' + entry + ':', err);
      }
    }
    return { removed: removed };
  }

  return {
    safeIdSegment: safeIdSegment,
    scrubArtifactsImpl: scrubArtifactsImpl
  };
}));
