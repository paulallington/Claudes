// Pure arg-surgery behind renderer.js's buildResumeArgs. Every column respawn
// (effort change, reattach-after-sleep, endpoint failover) re-launches the
// session with --resume. The old code rebuilt the arg list from scratch (effort
// + resume only), silently dropping the flags the column was spawned with: the
// permission mode (--dangerously-skip-permissions / --permission-mode), --bare,
// --strict-mcp-config, --remote-control, --model, custom args. Because the
// respawn overwrites col.cmdArgs, the flags were lost permanently after the
// first change.
//
// buildResumeArgsBase preserves the prior cmdArgs MINUS the flags it rebuilds
// (--effort, --resume, the ultracode --settings) and the one that must never be
// repeated on a resume (--worktree — the column's cwd already pins its location;
// re-passing it would create/switch a worktree again). It then appends the fresh
// effort (endpoint-aware) and --resume. The renderer still pipes the result
// through rewriteArgsForEndpoint, which enforces endpoint correctness (strips
// --bare / --model on the wrong endpoint kind, clamps effort) — so this layer
// only does preservation + effort/resume rebuild.
//
// Loaded two ways:
//   - Node (tests): require('../lib/effort-relaunch') via module.exports.
//   - Renderer: <script src="lib/effort-relaunch.js"> (contextIsolation:true /
//     nodeIntegration:false means no require()), exposed as window.EffortRelaunch.
//   Same UMD pattern as lib/permission-mode.js, lib/maximize-layout.js.

'use strict';

(function () {
  var ULTRACODE_SETTINGS = { ultracode: true, enableWorkflows: true };

  // Flags consuming the next token as their value that we rebuild or must not
  // repeat — stripped (with their value) from the preserved prior args.
  function isStrippedFlag(flag) {
    return flag === '--effort' || flag === '--resume' || flag === '--worktree';
  }

  function buildResumeArgsBase(col, isLocal, defaultEffortLocal) {
    col = col || {};
    var prior = Array.isArray(col.cmdArgs) ? col.cmdArgs : [];

    var preserved = [];
    for (var i = 0; i < prior.length; i++) {
      var a = prior[i];
      if (isStrippedFlag(a)) { i++; continue; } // skip flag + its value
      // Strip only the ultracode --settings (rebuilt below); keep any other.
      if (a === '--settings' && /ultracode/.test(prior[i + 1] || '')) { i++; continue; }
      preserved.push(a);
    }

    var args = preserved.slice();

    // Re-emit effort (endpoint-aware), then resume — effort before resume to
    // match the order the working startup path uses.
    if (col.effort === 'ultracode' && !isLocal) {
      // ultracode = xhigh effort + standing workflow settings (cloud only).
      args.push('--effort', 'xhigh', '--settings', JSON.stringify(ULTRACODE_SETTINGS));
    } else if (col.effort === 'ultracode') {
      // Local endpoints can't take xhigh/ultracode — degrade to the local default.
      if (defaultEffortLocal) args.push('--effort', defaultEffortLocal);
    } else if (col.effort) {
      args.push('--effort', col.effort);
    }

    if (col.sessionId) args.push('--resume', col.sessionId);

    return args;
  }

  var api = { buildResumeArgsBase: buildResumeArgsBase };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.EffortRelaunch = api;
  }
})();
