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
// Returns { inherit: true } (do nothing, today's behaviour) or
// { inherit: false, config: { mcpServers: {...} } } (scoped, strict).
function resolveProjectMcpSpawn(projectDefault, discovered) {
  const sel = resolveMcpSelection(null, projectDefault);
  if (sel === null) return { inherit: true };
  return { inherit: false, config: filterMcpDefs(discovered || {}, sel, null) };
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

module.exports = { readbackMcpSelection, resolveProjectMcpSpawn, appendProjectMcpArgs };

if (typeof window !== 'undefined') {
  window.McpProject = { readbackMcpSelection, resolveProjectMcpSpawn, appendProjectMcpArgs };
}
