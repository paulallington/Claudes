(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ReviewComments = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {

  var ID_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

  function safeIdSegment(s) {
    if (typeof s !== 'string' || !ID_SEGMENT_RE.test(s)) {
      throw new Error('invalid id segment: ' + s);
    }
    return s;
  }

  function comparePosition(a, b) {
    var af = (a && a.filePath) || '';
    var bf = (b && b.filePath) || '';
    if (af < bf) return -1;
    if (af > bf) return 1;
    var as = (a && typeof a.startLine === 'number') ? a.startLine : 0;
    var bs = (b && typeof b.startLine === 'number') ? b.startLine : 0;
    if (as < bs) return -1;
    if (as > bs) return 1;
    return 0;
  }

  function groupByFile(comments) {
    var out = {};
    if (!Array.isArray(comments)) return out;
    for (var i = 0; i < comments.length; i++) {
      var c = comments[i];
      if (!c) continue;
      var fp = c.filePath;
      if (!out[fp]) out[fp] = [];
      out[fp].push(c);
    }
    var keys = Object.keys(out);
    for (var k = 0; k < keys.length; k++) {
      out[keys[k]].sort(function (x, y) {
        var xs = (typeof x.startLine === 'number') ? x.startLine : 0;
        var ys = (typeof y.startLine === 'number') ? y.startLine : 0;
        if (xs < ys) return -1;
        if (xs > ys) return 1;
        return 0;
      });
    }
    return out;
  }

  function stripPrefix(filePath, projectKey) {
    var s = String(filePath == null ? '' : filePath);
    if (projectKey != null && projectKey !== '') {
      var pk = String(projectKey);
      if (s.indexOf(pk) === 0) {
        s = s.slice(pk.length);
      }
    }
    s = s.replace(/^[/\\]/, '');
    s = s.replace(/\\/g, '/');
    return s;
  }

  function formatCommentsForCopy(comments, projectKey) {
    if (!Array.isArray(comments) || comments.length === 0) return '';
    var enriched = [];
    for (var i = 0; i < comments.length; i++) {
      var c = comments[i];
      if (!c) continue;
      enriched.push({
        rel: stripPrefix(c.filePath, projectKey),
        startLine: (typeof c.startLine === 'number') ? c.startLine : 0,
        endLine: (typeof c.endLine === 'number') ? c.endLine : ((typeof c.startLine === 'number') ? c.startLine : 0),
        text: (typeof c.text === 'string') ? c.text : ''
      });
    }
    // Group by relative path
    var groups = {};
    for (var j = 0; j < enriched.length; j++) {
      var e = enriched[j];
      if (!groups[e.rel]) groups[e.rel] = [];
      groups[e.rel].push(e);
    }
    var fileKeys = Object.keys(groups).sort();
    var fileBlocks = [];
    for (var f = 0; f < fileKeys.length; f++) {
      var key = fileKeys[f];
      var arr = groups[key];
      arr.sort(function (x, y) {
        if (x.startLine < y.startLine) return -1;
        if (x.startLine > y.startLine) return 1;
        return 0;
      });
      var commentBlocks = [];
      for (var m = 0; m < arr.length; m++) {
        var item = arr[m];
        var loc = (item.startLine === item.endLine)
          ? (key + ':' + item.startLine)
          : (key + ':' + item.startLine + '-' + item.endLine);
        commentBlocks.push(loc + '\n' + item.text);
      }
      fileBlocks.push(commentBlocks.join('\n\n'));
    }
    return fileBlocks.join('\n\n');
  }

  function migratePendingComments(srcArray, dstArray) {
    var src = Array.isArray(srcArray) ? srcArray : [];
    var dst = Array.isArray(dstArray) ? dstArray : [];
    var seen = {};
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var s = src[i];
      if (!s) continue;
      out.push(s);
      if (s.id != null) seen[String(s.id)] = true;
    }
    for (var j = 0; j < dst.length; j++) {
      var d = dst[j];
      if (!d) continue;
      if (d.id != null && seen[String(d.id)]) continue;
      out.push(d);
    }
    return out;
  }

  function computeDiffSlotKey(sessionId, filePath, scope) {
    var sid = sessionId || '__noSession__';
    return 'diffContent::' + sid + '::' + scope + '::' + filePath;
  }

  // Node-only helpers below. Lazy-require fs/path so the browser load path
  // stays clean — renderer never calls these.

  function readReviewCommentsFromDisk(filePath) {
    var fs = require('fs');
    if (!fs.existsSync(filePath)) return [];
    var raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { return []; }
    var data;
    try { data = JSON.parse(raw); } catch (e) {
      try {
        var corrupt = filePath.replace(/\.json$/, '') + '.corrupt-' + Date.now() + '.json';
        fs.renameSync(filePath, corrupt);
      } catch (err) {
        if (typeof console !== 'undefined') console.error('review-comments quarantine failed:', err);
      }
      return [];
    }
    return Array.isArray(data && data.comments) ? data.comments : [];
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
    var removed = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var isSticky = entry.indexOf(stickyPrefix) === 0;
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
    comparePosition: comparePosition,
    groupByFile: groupByFile,
    formatCommentsForCopy: formatCommentsForCopy,
    migratePendingComments: migratePendingComments,
    computeDiffSlotKey: computeDiffSlotKey,
    readReviewCommentsFromDisk: readReviewCommentsFromDisk,
    scrubArtifactsImpl: scrubArtifactsImpl
  };
}));
