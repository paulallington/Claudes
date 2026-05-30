// Pure helpers mapping a Claude Code permission mode to spawn CLI args, and
// migrating persisted spawn-options. Extracted so the logic is unit-testable
// without a DOM.
//
// Loaded two ways:
//   - Node (tests): require('../lib/permission-mode') via module.exports.
//   - Renderer: <script src="lib/permission-mode.js"> — the renderer runs under
//     contextIsolation:true / nodeIntegration:false and cannot require(), so the
//     API is also attached to window. Same UMD pattern as lib/clawd-widget.js,
//     lib/maximize-layout.js, lib/row-layout.js.

'use strict';

(function () {
  // Order matters: this is also the display order in the spawn dropdown.
  var VALID_PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'];

  // The CLI's --permission-mode accepts only acceptEdits/auto/dontAsk/plan
  // (verified via `claude --help`). 'default' means "pass no flag". bypass must
  // use the legacy --dangerously-skip-permissions flag: --permission-mode
  // rejects "bypassPermissions" as an invalid choice, and the automation
  // de-dupe guard plus the proxy-auth / --bare paths key on that exact string.
  function permissionModeToArgs(mode) {
    if (mode === 'bypassPermissions') return ['--dangerously-skip-permissions'];
    if (mode === 'plan' || mode === 'acceptEdits' || mode === 'dontAsk' || mode === 'auto') {
      return ['--permission-mode', mode];
    }
    return []; // 'default' or anything unrecognized
  }

  // Resolve a persisted spawnOptions object to a valid mode string.
  // Priority: a valid permissionMode wins; else legacy skipPermissions:true
  // migrates to bypassPermissions; else default.
  function migratePermissionMode(opts) {
    opts = opts || {};
    if (VALID_PERMISSION_MODES.indexOf(opts.permissionMode) !== -1) return opts.permissionMode;
    if (opts.skipPermissions === true) return 'bypassPermissions';
    return 'default';
  }

  var api = {
    VALID_PERMISSION_MODES: VALID_PERMISSION_MODES,
    permissionModeToArgs: permissionModeToArgs,
    migratePermissionMode: migratePermissionMode
  };

  // CommonJS export for tests; harmless in the browser (no module global).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Browser: attach to window so renderer.js can call it.
  if (typeof window !== 'undefined') {
    window.permissionModeToArgs = permissionModeToArgs;
    window.migratePermissionMode = migratePermissionMode;
    window.VALID_PERMISSION_MODES = VALID_PERMISSION_MODES;
  }
})();
