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

// The http(s) URL of a server definition, or null for stdio/other servers.
function serverUrlOf(def) {
  if (def && typeof def === 'object' && typeof def.url === 'string' && /^https?:\/\//i.test(def.url)) return def.url;
  return null;
}

// Build the `allowedMcpServers` settings list for a project's tick selection.
// Connectors only match an allowlist by URL; once any serverUrl entry exists,
// remote servers must match by URL too, so every remote server is listed by
// URL and only stdio servers by name.
//   selectedNames  array of ticked names (connector names included)
//   discovered     { name: { def, scope } } file-based servers
//   connectorUrls  { 'claude.ai Granola': 'https://...' }
//   extraServers   optional { name: def } always included
// Returns { entries, hasConnectors, missingConnectors }.
function buildMcpAllowlist(selectedNames, discovered, connectorUrls, extraServers) {
  var entries = [];
  var seen = {};
  var missing = [];
  var hasConnectors = false;

  function add(entry) {
    var key = JSON.stringify(entry);
    if (seen[key]) return;
    seen[key] = true;
    entries.push(entry);
  }
  function addServer(name, def) {
    var url = serverUrlOf(def);
    add(url ? { serverUrl: url } : { serverName: name });
  }

  var names = Array.isArray(selectedNames) ? selectedNames : [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (isConnectorName(name)) {
      var cUrl = connectorUrls && connectorUrls[name];
      if (typeof cUrl === 'string' && cUrl) {
        add({ serverUrl: cUrl });
        hasConnectors = true;
      } else if (missing.indexOf(name) === -1) {
        missing.push(name);
      }
    } else if (discovered && discovered[name] && discovered[name].def) {
      addServer(name, discovered[name].def);
    }
  }

  if (extraServers && typeof extraServers === 'object') {
    Object.keys(extraServers).forEach(function (k) { addServer(k, extraServers[k]); });
  }

  return { entries: entries, hasConnectors: hasConnectors, missingConnectors: missing };
}

var api = {
  CONNECTOR_PREFIX: CONNECTOR_PREFIX,
  isConnectorName: isConnectorName,
  parseMcpListOutput: parseMcpListOutput,
  serverUrlOf: serverUrlOf,
  buildMcpAllowlist: buildMcpAllowlist
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
