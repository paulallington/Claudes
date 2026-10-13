'use strict';

// Pure helpers for claude.ai account connectors (Granola, Wispr Flow, ...) in
// project MCP scoping. No requires: this file also loads in the sandboxed
// renderer as window.McpConnectors.

var CONNECTOR_PREFIX = 'claude.ai ';

function isConnectorName(name) {
  return typeof name === 'string' && name.indexOf(CONNECTOR_PREFIX) === 0;
}

var api = {
  CONNECTOR_PREFIX: CONNECTOR_PREFIX,
  isConnectorName: isConnectorName
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
