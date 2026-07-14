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
   *     Omitted when the column has MCP servers (see below).
   *   - ANTHROPIC_MODEL=<model>[1m] re-activates the 1M window when requested
   *     (behind a custom base URL Claude Code drops the context-1m beta header
   *     and caps at 200k; the [1m] suffix is Headroom's way back to 1M).
   *
   * Returns null when binding does not apply (disabled, a local endpoint owns
   * the base URL, or an arbitrary-command column) so callers can spawn plainly.
   *
   * @param {{ enabled?: any, hasEndpoint?: any, isClaude?: any, oneM?: any, oneMModel?: string, port?: number, hasMcp?: any }} input
   * @returns {object|null}
   */
  function buildHeadroomEnv(input) {
    input = input || {};
    if (!input.enabled || input.hasEndpoint || input.isClaude === false) return null;

    var port = input.port && input.port > 0 && input.port <= 65535 ? input.port : 8787;
    var env = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port,
    };
    // Headroom's tool_search_deferral transform strips inlined tool schemas
    // into a search-only manifest the CLI's tool_search_tool_regex can't load
    // MCP tools from — so a column WITH MCP servers must keep schemas inlined
    // (skip tool search) or its mcp__* tools become unreachable.
    if (!input.hasMcp) { env.ENABLE_TOOL_SEARCH = 'true'; }
    if (input.oneM && input.oneMModel) {
      env.ANTHROPIC_MODEL = String(input.oneMModel) + '[1m]';
    }
    return env;
  }

  /**
   * Build the argv for spawning the app-managed Headroom proxy, mirroring the
   * CLI: `headroom proxy --port <p> --no-http2 [--memory] [--mode <m> | --no-optimize]`.
   *
   * `--no-http2` is always passed. With Claude + Codex running across several
   * columns, streams are cancelled constantly (every ESC/interrupt), and
   * Headroom's own help warns that shared-connection HTTP/2 can then corrupt the
   * TLS session (SSLV3_ALERT_BAD_RECORD_MAC) — the proxy appears up but stops
   * answering, forcing a manual restart. Forcing HTTP/1.1 to upstream avoids it.
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
   * After the mode flags, we ALWAYS append upstream-timeout and retry flags:
   *   - `--request-timeout-seconds` / `--anthropic-buffered-request-timeout-seconds`:
   *     Headroom's own default is 300s, but the Claude CLI itself waits up to
   *     600s upstream (`x-stainless-timeout: 600`) — a long extended-thinking
   *     turn (observed 600s+ in practice) blows straight through Headroom's
   *     300s and gets aborted with `API Error: The operation timed out` even
   *     though the CLI was still happily waiting. We set both to 900s so
   *     Headroom always outlasts the CLI's own patience.
   *   - `--retry-max-attempts`: a couple more upstream retries to ride out
   *     transient failures on those same long turns.
   * Like mode, these are start-time-only flags — restart the proxy to apply
   * a change. They are appended regardless of mode or `--memory`.
   *
   * @param {{ useHeadroomMemory?: any, headroomMode?: string, headroomRequestTimeout?: number, headroomRetryMax?: number }} cfg
   * @param {number} port
   * @returns {string[]}
   */
  function buildHeadroomProxyArgs(cfg, port) {
    cfg = cfg || {};
    var p = port && port > 0 && port <= 65535 ? port : 8787;
    var args = ['proxy', '--port', String(p), '--no-http2'];
    if (cfg.useHeadroomMemory) args.push('--memory');
    var mode = String(cfg.headroomMode || 'cache').toLowerCase();
    if (mode === 'off') args.push('--no-optimize');
    else if (mode === 'token') args.push('--mode', 'token');
    else args.push('--mode', 'cache');

    var t = cfg.headroomRequestTimeout;
    var timeout = typeof t === 'number' && t > 0 && Number.isInteger(t) ? t : 900;
    var r = cfg.headroomRetryMax;
    var retry = typeof r === 'number' && Number.isInteger(r) && r >= 1 && r <= 10 ? r : 5;

    args.push('--request-timeout-seconds', String(timeout));
    args.push('--anthropic-buffered-request-timeout-seconds', String(timeout));
    args.push('--retry-max-attempts', String(retry));
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
