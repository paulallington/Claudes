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

  // Path resolution for a given TARGET platform, not the host running the
  // check — this policy's `platform` argument may name a different platform
  // than the one `npm test` actually runs on, so path.resolve must be pinned
  // to path.win32/path.posix rather than the ambient (host) `path` module.
  function pathModuleFor(platform) {
    return platform === 'win32' ? path.win32 : path.posix;
  }

  // Same contract as main.js's isInsideRoot: case-insensitive on win32.
  // The separator is derived from the `platform` argument rather than the
  // runtime's path.sep, for the same host-independence reason as above.
  function isInsideRoot(target, root, platform) {
    var sepChar = platform === 'win32' ? '\\' : '/';
    var tNorm = platform === 'win32' ? target.toLowerCase() : target;
    var rNorm = platform === 'win32' ? root.toLowerCase() : root;
    if (tNorm === rNorm) return true;
    var sep = rNorm.charAt(rNorm.length - 1) === sepChar ? '' : sepChar;
    return tNorm.indexOf(rNorm + sep) === 0;
  }

  /**
   * Shared containment core for both readImage (image-only) and reveal
   * (any file) — resolves, realpath-checks, and root-contains `candidate`.
   * Never throws — every refusal resolves `{ ok: false, error }` with a
   * short, path-free reason. Does NOT apply the image-extension allowlist;
   * callers that need it (checkAttachmentPath) layer it on themselves.
   *
   * @param {string} candidate
   * @param {string[]} roots allowed containment roots
   * @param {'win32'|string} platform
   * @param {{ realpath?: (p: string) => string, stat?: (p: string) => { isFile(): boolean, size: number } }} [deps]
   * @returns {{ ok: true, path: string, size: number } | { ok: false, error: string }}
   */
  function checkAttachmentContainment(candidate, roots, platform, deps) {
    deps = deps || {};
    if (typeof candidate !== 'string' || !candidate) return { ok: false, error: 'empty path' };
    if (/^\\\\/.test(candidate) || /^\/\//.test(candidate)) return { ok: false, error: 'UNC path' };

    var pm = pathModuleFor(platform);
    var resolved = pm.resolve(candidate);
    if (typeof deps.realpath === 'function') {
      try { resolved = deps.realpath(resolved); }
      catch (e) { return { ok: false, error: 'not found' }; }
    }

    var list = Array.isArray(roots) ? roots : [];
    var contained = false;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (typeof r === 'string' && r && isInsideRoot(resolved, pm.resolve(r), platform)) {
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

    return { ok: true, path: resolved, size: typeof stat.size === 'number' ? stat.size : 0 };
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
    if (typeof candidate === 'string' && candidate && !isAllowedImageExt(candidate)) {
      return { ok: false, error: 'unsupported extension' };
    }

    var result = checkAttachmentContainment(candidate, roots, platform, deps);
    if (!result.ok) return result;

    // A symlink can point somewhere with a different extension than the
    // candidate's — re-check the allowlist against what realpath actually
    // resolved to, not just the name the renderer asked for.
    if (!isAllowedImageExt(result.path)) return { ok: false, error: 'unsupported extension' };

    if (result.size > MAX_BYTES) return { ok: false, error: 'too large' };

    return { ok: true, path: result.path, mediaType: mediaTypeFor(result.path), size: result.size };
  }

  var api = {
    checkAttachmentPath: checkAttachmentPath,
    checkAttachmentContainment: checkAttachmentContainment,
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
