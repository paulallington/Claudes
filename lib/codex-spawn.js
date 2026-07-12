// Pure helpers for spawning a Codex CLI column and distinguishing it from a
// Claude column. Extracted so the logic is unit-testable without a DOM.
//
// Loaded two ways:
//   - Node (main.js + tests): require('./lib/codex-spawn') via module.exports.
//   - Renderer: <script src="lib/codex-spawn.js"> — the renderer runs under
//     contextIsolation:true / nodeIntegration:false and cannot require(), so the
//     API is also attached to window. Same UMD pattern as lib/permission-mode.js.

'use strict';

(function () {
  // Which command resolves an executable's path on this platform.
  function codexLookupCommand(platform) {
    return platform === 'win32' ? 'where' : 'which';
  }

  // First non-empty line of `where`/`which` output, or null if none.
  function parseWhichOutput(raw) {
    if (!raw) return null;
    var lines = String(raw).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (trimmed) return trimmed;
    }
    return null;
  }

  // Descriptor for spawning a Codex column via addColumn(args, row, opts).
  // Deliberately carries NO Claude-specific fields — a Codex column must never
  // pick up permission-mode / model / headroom / endpoint plumbing.
  function buildCodexSpawn(cwd) {
    // No `title` — createColumnHeader derives "Codex #<id>" (matching the
    // "Claude #<id>" convention) so the column name doesn't duplicate the badge.
    return {
      args: [],
      opts: { cmd: 'codex', cwd: cwd == null ? null : cwd }
    };
  }

  // A column uses Claude-specific header chrome (compact/teleport/effort, the
  // starburst icon) only when it has no custom command. cmd columns (Codex,
  // launch configs) do not.
  function columnUsesClaudeChrome(col) {
    return !col || !col.cmd;
  }

  var api = {
    codexLookupCommand: codexLookupCommand,
    parseWhichOutput: parseWhichOutput,
    buildCodexSpawn: buildCodexSpawn,
    columnUsesClaudeChrome: columnUsesClaudeChrome
  };

  // CommonJS export for main.js + tests; harmless in the browser (no module global).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Browser: namespace on window so renderer.js can call it, matching the
  // sibling libs (window.PermissionMode, window.MaximizeLayout, window.RowLayout).
  if (typeof window !== 'undefined') {
    window.CodexSpawn = api;
  }
})();
