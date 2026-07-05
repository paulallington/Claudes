'use strict';

(function () {
  /**
   * Build the environment a column needs to route its Claude through the
   * app-managed Headroom proxy — WITHOUT the fragile `headroom wrap` subprocess.
   *
   * Binding is just env vars (the same mechanism local-endpoint columns use):
   *   - ANTHROPIC_BASE_URL points Claude Code at the running proxy.
   *   - ENABLE_TOOL_SEARCH keeps on-demand tool loading on (issue #746) — a
   *     custom base URL otherwise makes Claude Code load every tool schema.
   *   - ANTHROPIC_MODEL=<model>[1m] re-activates the 1M window when requested
   *     (behind a custom base URL Claude Code drops the context-1m beta header
   *     and caps at 200k; the [1m] suffix is Headroom's way back to 1M).
   *
   * Returns null when binding does not apply (disabled, a local endpoint owns
   * the base URL, or an arbitrary-command column) so callers can spawn plainly.
   *
   * @param {{ enabled?: any, hasEndpoint?: any, isClaude?: any, oneM?: any, oneMModel?: string, port?: number }} input
   * @returns {object|null}
   */
  function buildHeadroomEnv(input) {
    input = input || {};
    if (!input.enabled || input.hasEndpoint || input.isClaude === false) return null;

    var port = input.port && input.port > 0 && input.port <= 65535 ? input.port : 8787;
    var env = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port,
      ENABLE_TOOL_SEARCH: 'true',
    };
    if (input.oneM && input.oneMModel) {
      env.ANTHROPIC_MODEL = String(input.oneMModel) + '[1m]';
    }
    return env;
  }

  var api = { buildHeadroomEnv: buildHeadroomEnv };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.HeadroomEnv = api;
  }
})();
