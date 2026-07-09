'use strict';

// Pure helpers for scheduled INTERACTIVE automation runs and per-agent MCP
// selection. Kept side-effect-free so they can be unit-tested without a PTY,
// a WebSocket, or the filesystem. The stateful orchestration (WS client to
// pty-server, prompt injection timing, sentinel-file polling, watchdog) lives
// in main.js's spawnInteractiveScheduled and calls into these.

// Build the argv for an interactive `claude` spawn (NOT `--print`). This is the
// scheduled analogue of the renderer's buildSpawnArgs: only the flags an
// unattended interactive run needs.
//
// opts:
//   sessionId       string  -> --session-id <id> (deterministic, so a respawn could resume)
//   skipPermissions bool    -> --dangerously-skip-permissions (unattended: no blocking prompt)
//   model           string  -> --model <m> (skipped when an endpoint env pins the model)
//   hasEndpoint     bool    -> when true, omit --model (endpoint env already pins every tier)
//   mcpConfigPath   string  -> --mcp-config <path>
//   strictMcp       bool    -> --strict-mcp-config (only with mcpConfigPath)
//   extraArgs       array   -> appended verbatim (raw passthrough, same as headless)
function buildInteractiveArgs(opts) {
  opts = opts || {};
  const args = [];
  if (opts.skipPermissions) args.push('--dangerously-skip-permissions');
  if (opts.sessionId) args.push('--session-id', opts.sessionId);
  if (opts.model && !opts.hasEndpoint) args.push('--model', opts.model);
  if (opts.mcpConfigPath) {
    args.push('--mcp-config', opts.mcpConfigPath);
    if (opts.strictMcp) args.push('--strict-mcp-config');
  }
  if (Array.isArray(opts.extraArgs)) {
    for (const a of opts.extraArgs) args.push(a);
  }
  return args;
}

// The extra instruction appended (after AGENT_PROMPT_SUFFIX) for interactive
// runs. Interactive sessions render a TUI, so the :::loop-result block is buried
// in ANSI/redraws and unreliable to scrape. We additionally ask the model to
// Write the same JSON to a sentinel file, which we poll for - a clean, ANSI-free
// completion signal and capture.
function interactiveSuffix(sentinelPath) {
  return '\n\nIMPORTANT - this is an UNATTENDED scheduled interactive run. As your final action, ' +
    'in addition to the :::loop-result block above, use the Write tool to write that same JSON object ' +
    '(the {"summary": ..., "attentionItems": [...]} object, and nothing else - no markdown fences) to this exact file path:\n' +
    sentinelPath + '\n' +
    'The run is considered complete only once that file exists, so writing it must be the very last thing you do.';
}

// Strip ANSI escape sequences (CSI, OSC, single Fe escapes) so scraped PTY
// output is human-readable in the run record and safe to regex. Patterns are
// built from explicit control-char codes so no literal control byte appears in
// source: ESC is char 27, BEL is char 7.
var ESC = String.fromCharCode(27);
var BEL = String.fromCharCode(7);
var OSC_RE = new RegExp(ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)', 'g');
// CSI: ESC [ , optional private-prefix bytes (< = > ?), params (0-9 ; ),
// intermediates (0x20-0x2f), final byte (0x40-0x7e). The private prefix matters
// for sequences like ESC[>0q and ESC[?25l that a bare param class misses.
var CSI_RE = new RegExp(ESC + '\\[[0-9;?<=>]*[ -\\/]*[@-~]', 'g');
// Two-char escapes that carry no printable payload: cursor save/restore (ESC 7 /
// ESC 8) and keypad mode (ESC = / ESC >).
var TWO_RE = new RegExp(ESC + '[=>78]', 'g');
// Other Fe escapes: ESC followed by a single byte in @-_ (e.g. ESC \ , ESC M).
var FE_RE = new RegExp(ESC + '[@-Z\\\\-_]', 'g');
function stripAnsi(s) {
  return String(s == null ? '' : s)
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(TWO_RE, '')
    .replace(FE_RE, '')
    .replace(/\r/g, '');
}

// Resolve the effective MCP allowlist for an agent.
//   agentMcp       array | null | undefined  (per-agent selection)
//   projectDefault array | null | undefined  (per-project default)
// Returns an array (allowlist) or null (= inherit ALL servers, today's behaviour).
// An explicit empty array means "no MCP servers" and is preserved.
function resolveMcpSelection(agentMcp, projectDefault) {
  if (Array.isArray(agentMcp)) return agentMcp;
  if (Array.isArray(projectDefault)) return projectDefault;
  return null;
}

// Build a scoped { mcpServers } config object from a discovered server map,
// keeping only the selected names (that actually exist), then merging any extra
// servers (e.g. the derived MongoDB server) on top.
//   available     { name: { def, scope } }  (from discoverProjectMcpServers)
//   selectedNames array of names to keep
//   extraServers  { name: def }  merged in unconditionally (optional)
function filterMcpDefs(available, selectedNames, extraServers) {
  const mcpServers = {};
  if (Array.isArray(selectedNames)) {
    for (const name of selectedNames) {
      if (available && available[name] && available[name].def) {
        mcpServers[name] = available[name].def;
      }
    }
  }
  if (extraServers && typeof extraServers === 'object') {
    Object.assign(mcpServers, extraServers);
  }
  return { mcpServers };
}

module.exports = {
  buildInteractiveArgs,
  interactiveSuffix,
  stripAnsi,
  resolveMcpSelection,
  filterMcpDefs
};
