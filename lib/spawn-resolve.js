// Pure helpers for resolving a bare command name (e.g. 'codex') to a full
// executable path before handing it to node-pty. On Windows, node-pty's
// CreateProcess doesn't apply PATHEXT the way a shell would, and the first
// `where` hit for a CLI installed via npm is often an extensionless shim
// script it can't execute directly — so a bare spawn throws "Cannot create
// process, error code: 2". Resolving to the .cmd/.exe line up front (same
// mechanism pty-server already uses for CLAUDE_PATH) avoids that.
//
// This file is the unit-tested mirror of the copy INLINED in pty-server.js —
// pty-server.js can't require('./lib/...') because only pty-server.js itself
// is unpacked from the asar (it runs under system Node, not Electron's). Keep
// the two in step; test/spawn-resolve.test.js covers this copy, and
// test/pty-server-selfcontained.test.js guards against the inlined copy ever
// growing a relative require back in.

'use strict';

(function () {
  // True only when `cmd` is a non-empty string that is a bare command name:
  // no path separators and no drive-letter prefix. Deliberately avoids node's
  // `path` module so this stays platform-agnostic and browser-safe.
  function needsResolution(cmd) {
    if (!cmd || typeof cmd !== 'string') return false;
    if (cmd.indexOf('/') !== -1 || cmd.indexOf('\\') !== -1) return false;
    if (/^[A-Za-z]:/.test(cmd)) return false;
    return true;
  }

  // Pick the best line out of `where`/`which` output. On win32, prefer the
  // first line with a directly-executable extension (.com/.exe/.bat/.cmd)
  // over shim scripts with other/no extensions; fall back to the first
  // non-blank line if none match. Elsewhere, just the first non-blank line.
  function pickExecutable(whichOutput, platform) {
    var lines = String(whichOutput || '').split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; });
    if (lines.length === 0) return null;

    if (platform === 'win32') {
      for (var i = 0; i < lines.length; i++) {
        if (/\.(com|exe|bat|cmd)$/i.test(lines[i])) return lines[i];
      }
      return lines[0];
    }

    return lines[0];
  }

  var api = {
    needsResolution: needsResolution,
    pickExecutable: pickExecutable
  };

  // CommonJS export for test/spawn-resolve.test.js. pty-server.js does not
  // require this file — its copy is inlined (see header above).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
