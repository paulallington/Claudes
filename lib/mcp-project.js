'use strict';

let _is;
try { _is = require('./interactive-scheduled'); } catch (_) { _is = (typeof window !== 'undefined' && window.InteractiveScheduled) || {}; }
const { resolveMcpSelection, filterMcpDefs } = _is;

// Translate checkbox state into the storage selection convention:
// null/absent = inherit ALL, [] = none, [...] = explicit allowlist.
// "Untouched" (hadSelection=false) and all boxes checked stays null (inherit)
// so a project that has never customised its selection keeps auto-picking up
// newly discovered servers, rather than freezing today's list into an
// explicit full list, mirroring the automation-agent picker.
function readbackMcpSelection(checkedNames, allNames, hadSelection) {
  const checked = Array.isArray(checkedNames) ? checkedNames : [];
  const all = Array.isArray(allNames) ? allNames : [];
  const allChecked = checked.length === all.length;
  if (!hadSelection && allChecked) return null;
  return checked;
}

// Resolve how an interactive spawn should scope MCP servers for a project.
// projectDefault: array | null (from projectMcpDefaults[path])
// discovered: { name: { def, scope } } (from discoverProjectMcpServers)
// Returns { inherit: true, hasMcp } (do nothing, today's behaviour) or
// { inherit: false, config: { mcpServers: {...} }, hasMcp } (scoped, strict).
// hasMcp reports whether the resolved set is non-empty, so callers (e.g. the
// Headroom env builder) can tell when a column WILL have MCP tools.
function resolveProjectMcpSpawn(projectDefault, discovered) {
  const sel = resolveMcpSelection(null, projectDefault);
  if (sel === null) return { inherit: true, hasMcp: Object.keys(discovered || {}).length > 0 };
  const config = filterMcpDefs(discovered || {}, sel, null);
  return { inherit: false, config: config, hasMcp: Object.keys(config.mcpServers || {}).length > 0 };
}

// Append scoped-config flags to a spawn arg list. Returns a NEW array.
// No-op if args already carry --mcp-config (per-column "Strip MCPs"
// toggle emits its own flags first and should win).
function appendProjectMcpArgs(args, mcpResult) {
  const out = Array.isArray(args) ? args.slice() : [];
  if (out.indexOf('--mcp-config') !== -1) return out;
  if (mcpResult && mcpResult.mcpConfigPath) {
    out.push('--mcp-config', mcpResult.mcpConfigPath);
    if (mcpResult.strict) out.push('--strict-mcp-config');
  }
  return out;
}

// True when configPathKey is the project root or nested under it. Slash- and
// trailing-slash-normalized so a "local" scope server keyed under a worktree or
// subdirectory of the project (e.g. ~/.claude.json projects[<worktree cwd>])
// still resolves to the project. Case-insensitive so a drive-letter/path-case
// mismatch between ~/.claude.json keys and the app's project root (common on
// Windows) doesn't defeat discovery.
function matchesProjectScope(configPathKey, projectRoot) {
  if (!configPathKey || !projectRoot) return false;
  var norm = function (p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); };
  var a = norm(configPathKey);
  var b = norm(projectRoot);
  if (!a || !b) return false;
  return a === b || a.indexOf(b + '/') === 0;
}

// Filter live column descriptors to those a project-MCP change should offer to
// respawn: real Claude columns only (exclude custom `cmd` columns) that did not
// opt out via "Strip MCPs". Pure: the caller decides whether to act (banner is
// gated on whether the tick set actually changed).
function mcpEligibleRespawnColumns(descriptors) {
  var out = [];
  (descriptors || []).forEach(function (d) {
    if (!d || d.isClaude !== true || d.stripped === true) return;
    out.push(d.id);
  });
  return out;
}

// Guard the CommonJS export: in the renderer there is no `module`, so an
// unguarded `module.exports = ...` throws "module is not defined" and aborts
// the rest of this script — which would leave `window.McpProject` unset and
// silently break the checklist read-back and spawn wiring. Matches the
// sibling-lib idiom (permission-mode.js / spawn-session.js).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { readbackMcpSelection, resolveProjectMcpSpawn, appendProjectMcpArgs, matchesProjectScope, mcpEligibleRespawnColumns };
}

if (typeof window !== 'undefined') {
  window.McpProject = { readbackMcpSelection, resolveProjectMcpSpawn, appendProjectMcpArgs, matchesProjectScope, mcpEligibleRespawnColumns };
}
