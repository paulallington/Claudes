'use strict';

// Pure helpers for claude.ai account connectors (Granola, Wispr Flow, ...) in
// project MCP scoping. No requires: this file also loads in the sandboxed
// renderer as window.McpConnectors.

var CONNECTOR_PREFIX = 'claude.ai ';

function isConnectorName(name) {
  return typeof name === 'string' && name.indexOf(CONNECTOR_PREFIX) === 0;
}

// Built from char codes so no literal control byte sits in source (ESC = 27).
var ESC = String.fromCharCode(27);
var ANSI_RE = new RegExp(ESC + '(?:\\[[0-9;?<=>]*[ -\\/]*[@-~]|\\][^' + String.fromCharCode(7) + ESC + ']*(?:' + String.fromCharCode(7) + '|' + ESC + '\\\\))', 'g');
function stripTerminalNoise(s) {
  return s.replace(ANSI_RE, '').replace(/\r/g, '');
}

// Parse `claude mcp list` stdout into the claude.ai connectors it lists.
// Returns [{ name, url }]. Non-connector servers (plugins, stdio, user-added
// http servers) are ignored: only connectors need URL-based allowlisting.
function parseMcpListOutput(text) {
  var out = [];
  if (typeof text !== 'string' || !text) return out;
  var seen = {};
  var lines = stripTerminalNoise(text).split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = /^(claude\.ai .+?): (https?:\/\/\S+)/.exec(lines[i]);
    if (!m || seen[m[1]]) continue;
    seen[m[1]] = true;
    out.push({ name: m[1], url: m[2] });
  }
  return out;
}

var api = {
  CONNECTOR_PREFIX: CONNECTOR_PREFIX,
  isConnectorName: isConnectorName,
  parseMcpListOutput: parseMcpListOutput
};

// Guard the CommonJS export: in the renderer there is no `module`, so an
// unguarded `module.exports = ...` throws "module is not defined" and aborts
// the rest of this script, leaving window.McpConnectors unset.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.McpConnectors = api;
}
