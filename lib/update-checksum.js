// Pure sha256-sidecar parsing/comparison behind the darwin updater's
// integrity check. The custom macOS updater (main.js setupDarwinUpdater)
// downloads the release DMG over HTTPS but historically had no way to detect
// a corrupted/tampered download — CI now publishes a `<dmg-name>.sha256`
// sidecar asset alongside each DMG in standard `shasum -a 256` format
// (`<64-hex>  <filename>` or `<64-hex> *<filename>`). This module parses
// that sidecar and compares digests; main.js wires it to an actual download
// + crypto.createHash('sha256') over the downloaded file.
//
// Loaded two ways:
//   - Node (main.js, tests): require('../lib/update-checksum') via module.exports.
//   - Renderer: not used directly (the check runs entirely in main), but the
//     UMD shape is kept consistent with the rest of lib/ for uniformity.

'use strict';

(function () {
  var HEX64_RE = /^[0-9a-f]{64}$/i;

  function basename(name) {
    if (typeof name !== 'string') return '';
    // Tolerate a leading "./" as emitted by `shasum` when run in-directory.
    var stripped = name.replace(/^\.\//, '');
    var idx = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
    return idx === -1 ? stripped : stripped.slice(idx + 1);
  }

  function normalizeHash(hex) {
    if (typeof hex !== 'string') return null;
    var trimmed = hex.trim();
    return HEX64_RE.test(trimmed) ? trimmed.toLowerCase() : null;
  }

  // Given the sidecar file's text and the expected DMG filename, return the
  // lowercase-hex sha256 digest it names, or null if not found/malformed.
  function parseChecksumFile(text, filename) {
    if (typeof text !== 'string' || !text.trim()) return null;
    var wantName = basename(filename);
    var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (lines.length === 0) return null;

    // Bare-hash single-line sidecar: just the digest, no filename.
    if (lines.length === 1) {
      var bare = normalizeHash(lines[0]);
      if (bare) return bare;
    }

    for (var i = 0; i < lines.length; i++) {
      // Standard shasum formats: "<hex>  <name>" (text mode) or
      // "<hex> *<name>" (binary mode).
      var m = lines[i].match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
      if (!m) continue;
      var lineName = basename(m[2]);
      if (wantName && lineName === wantName) {
        var hash = normalizeHash(m[1]);
        if (hash) return hash;
      }
    }
    return null;
  }

  // Compare two sha256 hex digests case-insensitively. Both must be present
  // and well-formed 64-hex-char strings, else false.
  function checksumsMatch(expectedHex, actualHex) {
    var expected = normalizeHash(expectedHex);
    var actual = normalizeHash(actualHex);
    if (!expected || !actual) return false;
    return expected === actual;
  }

  var api = {
    parseChecksumFile: parseChecksumFile,
    checksumsMatch: checksumsMatch
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.UpdateChecksum = api;
  }
})();
