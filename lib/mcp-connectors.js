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

// `protocol//host/*` allowlist pattern for an http(s) URL, or null. Remote MCP
// URLs often embed secrets (path keys, ?api_key=, user:pass@) and the allowlist
// travels through the renderer, argv and debug logs, so only the origin is used.
function urlOriginPattern(url) {
  if (typeof url !== 'string' || typeof URL === 'undefined') return null;
  var u;
  try { u = new URL(url); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.protocol + '//' + u.host + '/*';
}

// Build the `allowedMcpServers` settings list for a project's tick selection.
// Connectors only match an allowlist by URL; once any serverUrl entry exists,
// remote servers must match by URL too, so every remote server is listed by
// origin wildcard (never the full URL) and only stdio servers by name.
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
    var pattern = urlOriginPattern(serverUrlOf(def));
    add(pattern ? { serverUrl: pattern } : { serverName: name });
  }

  var names = Array.isArray(selectedNames) ? selectedNames : [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (isConnectorName(name)) {
      var cUrl = connectorUrls && connectorUrls[name];
      var pattern = urlOriginPattern(cUrl);
      if (pattern) {
        add({ serverUrl: pattern });
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

// Last `--settings` occurrence (`--settings <v>` or `--settings=<v>`); mirrors
// findLastSettingsOccurrence in headroom-env.js (the CLI is last-wins).
function findLastSettings(args) {
  var found = null;
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--settings' && i + 1 < args.length) {
      found = { index: i, isSingleToken: false, value: args[i + 1] };
    } else if (typeof args[i] === 'string' && /^--settings=/.test(args[i])) {
      found = { index: i, isSingleToken: true, value: args[i].slice('--settings='.length) };
    }
  }
  return found;
}

function parseSettingsObject(value) {
  var parsed;
  try { parsed = JSON.parse(value); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

// Set (or, when value === undefined, delete) one top-level key in the LAST
// `--settings` JSON object, in place. `--settings` is last-wins on the CLI, so
// appending a second one would discard e.g. ultracode's settings; instead the
// key is merged into the existing token. Returns a NEW array, or null when the
// last `--settings` is not a JSON object (a file path we cannot read/merge).
function mergeSettingsKey(args, key, value) {
  args = Array.isArray(args) ? args : [];
  // A malformed trailing bare --settings has no value; drop it.
  var out = (args.length && args[args.length - 1] === '--settings') ? args.slice(0, -1) : args.slice();

  var last = findLastSettings(out);
  if (!last) {
    if (value !== undefined) {
      var fresh = {};
      fresh[key] = value;
      out.push('--settings', JSON.stringify(fresh));
    }
    return out;
  }

  var obj = parseSettingsObject(last.value);
  if (!obj) return null;
  var merged = Object.assign({}, obj);
  if (value === undefined) delete merged[key]; else merged[key] = value;
  var json = JSON.stringify(merged);
  out[last.isSingleToken ? last.index : last.index + 1] = last.isSingleToken ? '--settings=' + json : json;
  return out;
}

// Apply a project's MCP scope to an interactive spawn's args. Returns a NEW
// array. scope is null or { mcpConfigPath, strict, allowedMcpServers }.
//
// With allowedMcpServers the scope is enforced by a settings allowlist plus a
// NON-strict --mcp-config: --strict-mcp-config would make the CLI load zero
// claude.ai connectors. If the user's own --settings is a file we can't merge
// into, fall back to the legacy strict config (connectors are lost, but the
// scope is still enforced).
function applyMcpScope(args, scope) {
  var base = Array.isArray(args) ? args : [];
  // A per-column "Strip MCPs" toggle emits its own --mcp-config and wins.
  if (base.indexOf('--mcp-config') !== -1) return base.slice();

  if (!scope || !scope.mcpConfigPath) return base.slice();

  if (Array.isArray(scope.allowedMcpServers)) {
    var merged = mergeSettingsKey(base, 'allowedMcpServers', scope.allowedMcpServers);
    if (merged) return merged.concat(['--mcp-config', scope.mcpConfigPath]);
    return base.concat(['--mcp-config', scope.mcpConfigPath, '--strict-mcp-config']);
  }

  var out = base.concat(['--mcp-config', scope.mcpConfigPath]);
  if (scope.strict) out.push('--strict-mcp-config');
  return out;
}

var api = {
  CONNECTOR_PREFIX: CONNECTOR_PREFIX,
  isConnectorName: isConnectorName,
  parseMcpListOutput: parseMcpListOutput,
  serverUrlOf: serverUrlOf,
  urlOriginPattern: urlOriginPattern,
  buildMcpAllowlist: buildMcpAllowlist,
  mergeSettingsKey: mergeSettingsKey,
  applyMcpScope: applyMcpScope
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
