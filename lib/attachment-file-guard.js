'use strict';

// Security policy for `attachments:readImage` — deciding whether a path the
// renderer asks main to read (an attachment Claude handed to the user via
// SendUserFile, living OUTSIDE the app's normal allowed roots under
// <os.tmpdir()>/claude/) is safe to read back as a data: URI. Pure/testable:
// fs/electron calls are injected by the caller (main.js) rather than baked in
// here, mirroring lib/voice-transcript-path.js's `exists` injection.

(function () {
  var path = (typeof module !== 'undefined' && module.exports) ? require('path') : null;

  var ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
  var MEDIA_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };
  var MAX_BYTES = 8 * 1024 * 1024;

  function extOf(filePath) {
    return path.extname(String(filePath || '')).toLowerCase();
  }

  /**
   * @param {string} filePath
   * @returns {boolean}
   */
  function isAllowedImageExt(filePath) {
    if (typeof filePath !== 'string' || !filePath) return false;
    return ALLOWED_EXTS.indexOf(extOf(filePath)) !== -1;
  }

  /**
   * @param {string} filePath
   * @returns {string|null}
   */
  function mediaTypeFor(filePath) {
    if (typeof filePath !== 'string' || !filePath) return null;
    return MEDIA_TYPES[extOf(filePath)] || null;
  }

  // Same contract as main.js's isInsideRoot: case-insensitive on win32.
  function isInsideRoot(target, root, platform) {
    var tNorm = platform === 'win32' ? target.toLowerCase() : target;
    var rNorm = platform === 'win32' ? root.toLowerCase() : root;
    if (tNorm === rNorm) return true;
    var sep = rNorm.charAt(rNorm.length - 1) === path.sep ? '' : path.sep;
    return tNorm.indexOf(rNorm + sep) === 0;
  }

  /**
   * Decide whether `candidate` is safe to read back as an image attachment.
   * Never throws — every refusal resolves `{ ok: false, error }` with a short,
   * path-free reason.
   *
   * @param {string} candidate
   * @param {string[]} roots allowed containment roots (listAllowedRoots() + <tmpdir>/claude)
   * @param {'win32'|string} platform
   * @param {{ realpath?: (p: string) => string, stat?: (p: string) => { isFile(): boolean, size: number } }} [deps]
   * @returns {{ ok: true, path: string, mediaType: string, size: number } | { ok: false, error: string }}
   */
  function checkAttachmentPath(candidate, roots, platform, deps) {
    deps = deps || {};
    if (typeof candidate !== 'string' || !candidate) return { ok: false, error: 'empty path' };
    if (/^\\\\/.test(candidate) || /^\/\//.test(candidate)) return { ok: false, error: 'UNC path' };
    if (!isAllowedImageExt(candidate)) return { ok: false, error: 'unsupported extension' };

    var resolved = path.resolve(candidate);
    if (typeof deps.realpath === 'function') {
      try { resolved = deps.realpath(resolved); }
      catch (e) { return { ok: false, error: 'not found' }; }
    }

    var list = Array.isArray(roots) ? roots : [];
    var contained = false;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (typeof r === 'string' && r && isInsideRoot(resolved, path.resolve(r), platform)) {
        contained = true;
        break;
      }
    }
    if (!contained) return { ok: false, error: 'outside allowed roots' };

    if (typeof deps.stat !== 'function') return { ok: false, error: 'not found' };
    var stat;
    try { stat = deps.stat(resolved); }
    catch (e) { return { ok: false, error: 'not found' }; }
    if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
      return { ok: false, error: 'not a file' };
    }
    if (typeof stat.size !== 'number' || stat.size > MAX_BYTES) {
      return { ok: false, error: 'too large' };
    }

    return { ok: true, path: resolved, mediaType: mediaTypeFor(resolved), size: stat.size };
  }

  var api = {
    checkAttachmentPath: checkAttachmentPath,
    isAllowedImageExt: isAllowedImageExt,
    mediaTypeFor: mediaTypeFor,
    MAX_ATTACHMENT_BYTES: MAX_BYTES,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.AttachmentFileGuard = api;
  }
})();
