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
  // Allowlist for the "Open" action (attachments:openPath) — deliberately
  // wider than ALLOWED_EXTS since SendUserFile legitimately sends documents
  // (e.g. an .html mockup), not just images, but still an allowlist: every
  // executable/script extension (.exe, .bat, .ps1, .lnk, .hta, .scr, .msi,
  // .reg, ...) is refused by omission.
  var OPEN_ALLOWED_EXTS = ALLOWED_EXTS.concat(['.html', '.htm', '.pdf', '.txt', '.md', '.csv', '.json', '.svg']);
  var MEDIA_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };
  var MAX_BYTES = 8 * 1024 * 1024;

  // Path resolution for a given TARGET platform, not the host running the
  // check — this policy's `platform` argument may name a different platform
  // than the one `npm test` actually runs on, so path.resolve must be pinned
  // to path.win32/path.posix rather than the ambient (host) `path` module.
  function pathModuleFor(platform) {
    return platform === 'win32' ? path.win32 : path.posix;
  }

  // `platform` picks the TARGET path module, same reasoning as
  // pathModuleFor — using the ambient (host) `path` here would mis-parse a
  // 'win32' candidate on a POSIX host (or vice versa), e.g. treating a dot
  // inside a directory segment as the extension.
  function extOf(filePath, platform) {
    return pathModuleFor(platform).extname(String(filePath || '')).toLowerCase();
  }

  /**
   * @param {string} filePath
   * @param {'win32'|string} [platform]
   * @returns {boolean}
   */
  function isAllowedImageExt(filePath, platform) {
    if (typeof filePath !== 'string' || !filePath) return false;
    return ALLOWED_EXTS.indexOf(extOf(filePath, platform)) !== -1;
  }

  /**
   * @param {string} filePath
   * @param {'win32'|string} [platform]
   * @returns {boolean}
   */
  function isAllowedOpenExt(filePath, platform) {
    if (typeof filePath !== 'string' || !filePath) return false;
    return OPEN_ALLOWED_EXTS.indexOf(extOf(filePath, platform)) !== -1;
  }

  /**
   * @param {string} filePath
   * @param {'win32'|string} [platform]
   * @returns {string|null}
   */
  function mediaTypeFor(filePath, platform) {
    if (typeof filePath !== 'string' || !filePath) return null;
    return MEDIA_TYPES[extOf(filePath, platform)] || null;
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

    // NTFS alternate-data-stream guard: path.win32.extname('payload.bat:evil.pdf')
    // is '.pdf', and fs.realpathSync.native preserves the ':evil.pdf' suffix,
    // so a `payload.bat:evil.pdf` candidate would otherwise pass the
    // extension allowlist, containment, AND this realpath re-check. Any
    // colon past index 1 (the drive-letter colon, e.g. "C:") marks a stream
    // suffix — refuse it outright rather than relying on extname alone.
    if (platform === 'win32' && resolved.indexOf(':', 2) !== -1) {
      return { ok: false, error: 'invalid path' };
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
    if (typeof candidate === 'string' && candidate && !isAllowedImageExt(candidate, platform)) {
      return { ok: false, error: 'unsupported extension' };
    }

    var result = checkAttachmentContainment(candidate, roots, platform, deps);
    if (!result.ok) return result;

    // A symlink can point somewhere with a different extension than the
    // candidate's — re-check the allowlist against what realpath actually
    // resolved to, not just the name the renderer asked for.
    if (!isAllowedImageExt(result.path, platform)) return { ok: false, error: 'unsupported extension' };

    if (result.size > MAX_BYTES) return { ok: false, error: 'too large' };

    return { ok: true, path: result.path, mediaType: mediaTypeFor(result.path, platform), size: result.size };
  }

  /**
   * Decide whether `candidate` is safe to hand to the OS default-handler
   * launcher (shell.openPath) via attachments:openPath. Containment alone
   * is not enough here — an attacker who can write into a project root or
   * <tmpdir>/claude could plant an executable there — so this additionally
   * enforces OPEN_ALLOWED_EXTS, an allowlist of document/image types
   * SendUserFile realistically sends. Never throws — every refusal
   * resolves `{ ok: false, error }` with a short, path-free reason.
   *
   * @param {string} candidate
   * @param {string[]} roots allowed containment roots
   * @param {'win32'|string} platform
   * @param {{ realpath?: (p: string) => string, stat?: (p: string) => { isFile(): boolean, size: number } }} [deps]
   * @returns {{ ok: true, path: string } | { ok: false, error: string }}
   */
  function checkAttachmentOpenPath(candidate, roots, platform, deps) {
    if (typeof candidate === 'string' && candidate && !isAllowedOpenExt(candidate, platform)) {
      return { ok: false, error: 'unsupported extension' };
    }

    var result = checkAttachmentContainment(candidate, roots, platform, deps);
    if (!result.ok) return result;

    // Same symlink re-check as checkAttachmentPath: a candidate named
    // report.pdf can realpath-resolve to payload.bat, so the allowlist is
    // re-applied against what realpath actually resolved to.
    if (!isAllowedOpenExt(result.path, platform)) return { ok: false, error: 'unsupported extension' };

    return { ok: true, path: result.path };
  }

  var api = {
    checkAttachmentPath: checkAttachmentPath,
    checkAttachmentOpenPath: checkAttachmentOpenPath,
    checkAttachmentContainment: checkAttachmentContainment,
    isAllowedImageExt: isAllowedImageExt,
    isAllowedOpenExt: isAllowedOpenExt,
    mediaTypeFor: mediaTypeFor,
    extOf: extOf,
    MAX_ATTACHMENT_BYTES: MAX_BYTES,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.AttachmentFileGuard = api;
  }
})();
