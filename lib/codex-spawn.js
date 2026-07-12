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

  // Curated approval presets → Codex CLI flags. Order here is the dropdown order.
  // (Codex has two independent axes: -a approval and -s sandbox; plus a bypass flag.)
  var CODEX_APPROVAL_PRESETS = [
    { key: 'read-only', label: 'Read Only', args: ['-a', 'untrusted', '-s', 'read-only'] },
    { key: 'auto', label: 'Auto', args: ['-a', 'on-request', '-s', 'workspace-write'] },
    { key: 'full-access', label: 'Full Access', args: ['-a', 'never', '-s', 'danger-full-access'] },
    { key: 'yolo', label: 'Yolo (bypass)', args: ['--dangerously-bypass-approvals-and-sandbox'] },
    { key: 'codex-default', label: 'Codex default', args: [] }
  ];
  var DEFAULT_CODEX_APPROVAL = 'auto';

  function findPreset(key) {
    for (var i = 0; i < CODEX_APPROVAL_PRESETS.length; i++) {
      if (CODEX_APPROVAL_PRESETS[i].key === key) return CODEX_APPROVAL_PRESETS[i];
    }
    return null;
  }

  // Preset key -> flag args. Unknown/undefined -> [] (Codex uses its own default).
  // Returns a fresh array so callers can't mutate the preset table.
  function codexApprovalArgs(key) {
    var p = findPreset(key);
    return p ? p.args.slice() : [];
  }

  // Reverse map: flag args -> preset label, for the column badge tooltip (works on
  // restore, where only cmdArgs survive). [] -> 'Codex default'; unmatched -> 'Custom'.
  function codexApprovalLabelFromArgs(args) {
    var target = JSON.stringify(args || []);
    for (var i = 0; i < CODEX_APPROVAL_PRESETS.length; i++) {
      if (JSON.stringify(CODEX_APPROVAL_PRESETS[i].args) === target) return CODEX_APPROVAL_PRESETS[i].label;
    }
    return (args && args.length) ? 'Custom' : 'Codex default';
  }

  // Descriptor for spawning a Codex column via addColumn(args, row, opts).
  // Deliberately carries NO Claude-specific fields — a Codex column must never
  // pick up permission-mode / model / headroom / endpoint plumbing. `preset` maps
  // to approval/sandbox flags; omitted -> [] (Codex default), preserving old callers.
  function buildCodexSpawn(cwd, preset) {
    // No `title` — createColumnHeader derives "Codex #<id>" (matching the
    // "Claude #<id>" convention) so the column name doesn't duplicate the badge.
    return {
      args: codexApprovalArgs(preset),
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
    columnUsesClaudeChrome: columnUsesClaudeChrome,
    CODEX_APPROVAL_PRESETS: CODEX_APPROVAL_PRESETS,
    DEFAULT_CODEX_APPROVAL: DEFAULT_CODEX_APPROVAL,
    codexApprovalArgs: codexApprovalArgs,
    codexApprovalLabelFromArgs: codexApprovalLabelFromArgs
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
