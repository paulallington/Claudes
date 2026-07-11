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

  /**
   * Build the argv for spawning the app-managed Headroom proxy, mirroring the
   * CLI: `headroom proxy --port <p> [--memory] [--mode <m> | --no-optimize]`.
   *
   * Mode is a start-time flag (NOT hot-swappable) — callers restart the proxy
   * to apply a change:
   *   - 'cache'  (default): freeze prior turns, delta-only compression at ~0
   *     prefix-cache busts. Headroom's own default and the right posture for a
   *     Claude subscription (cache-reads are what stretch the rate-limit window).
   *   - 'token': prioritise compression; rewrites prior turns for max savings —
   *     busts the prefix cache, so it only pays off on a metered API key.
   *   - 'off':   passthrough (`--no-optimize`), no optimisation.
   *
   * An absent or unrecognised mode falls back to 'cache' so existing configs
   * (no headroomMode key) keep the subscription-safe default unchanged.
   *
   * @param {{ useHeadroomMemory?: any, headroomMode?: string }} cfg
   * @param {number} port
   * @returns {string[]}
   */
  function buildHeadroomProxyArgs(cfg, port) {
    cfg = cfg || {};
    var p = port && port > 0 && port <= 65535 ? port : 8787;
    var args = ['proxy', '--port', String(p)];
    if (cfg.useHeadroomMemory) args.push('--memory');
    var mode = String(cfg.headroomMode || 'cache').toLowerCase();
    if (mode === 'off') args.push('--no-optimize');
    else if (mode === 'token') args.push('--mode', 'token');
    else args.push('--mode', 'cache');
    return args;
  }

  var api = { buildHeadroomEnv: buildHeadroomEnv, buildHeadroomProxyArgs: buildHeadroomProxyArgs };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.HeadroomEnv = api;
  }
})();
