'use strict';

(function () {
  var ClaudeModels = (typeof module !== 'undefined' && module.exports)
    ? require('./claude-models')
    : (typeof window !== 'undefined' ? window.ClaudeModels : null);
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
      // Resolve `opus`/`sonnet`/`haiku` to a concrete id first: an alias has no
      // version, so it has no known context window, and would be pinned bare —
      // silently costing the 1M window for the most obvious dropdown picks.
      var modelId = ClaudeModels
        ? ClaudeModels.resolveModelId(String(input.oneMModel))
        : String(input.oneMModel);
      // Only claim the [1m] suffix for models that actually support it — a
      // model without a 1M window (e.g. Haiku) still gets pinned via
      // ANTHROPIC_MODEL, just without a window it doesn't have.
      var supportsOneM = ClaudeModels ? ClaudeModels.supportsOneM(modelId) : true;
      env.ANTHROPIC_MODEL = supportsOneM ? modelId + '[1m]' : modelId;
    }
    return env;
  }

  /**
   * Whether the Headroom binding — not a CLI `--model` flag — owns the
   * effective model for a column. Both the initial spawn (`buildSpawnArgs`)
   * and every respawn (`buildResumeArgs`) must agree on this, since the CLI's
   * `--model` flag overrides `ANTHROPIC_MODEL` env: if both callers decide
   * independently they drift (exactly how the two model lists once did), and
   * a respawn can end up sending BOTH selectors (the flag silently wins,
   * dropping the [1m] window) or NEITHER (the column falls back to the CLI
   * default). One decision, shared.
   *
   * @param {{ headroomInstalled?: any, useHeadroom?: any, useHeadroom1m?: any, hasEndpoint?: any }} input
   * @returns {boolean}
   */
  function headroomOwnsModel(input) {
    input = input || {};
    return !!(input.headroomInstalled && input.useHeadroom) &&
      !input.hasEndpoint && input.useHeadroom1m !== false;
  }

  /**
   * Effective context window for a Headroom binding, derived from the same
   * catalogue used to build the env — so callers (e.g. the renderer's
   * context meter) don't have to pattern-match the `[1m]` suffix themselves.
   * @param {{ oneM?: any, oneMModel?: string }} input
   * @returns {number}
   */
  function headroomModelWindow(input) {
    input = input || {};
    if (input.oneM && input.oneMModel && ClaudeModels) {
      return ClaudeModels.contextWindowFor(
        ClaudeModels.resolveModelId(String(input.oneMModel))
      );
    }
    return input.oneM && input.oneMModel ? 1000000 : 200000;
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

  /**
   * Reconcile a stored `--model` flag (or its absence) against whatever owns
   * the model NOW, using the same `headroomOwnsModel()` predicate
   * `buildSpawnArgs()`/`buildResumeArgs()` decide with — otherwise the two
   * can drift on a Headroom toggle flip across a respawn or restore:
   *   - Headroom was OFF at spawn (--model survives in the saved args) ->
   *     Headroom is ON now -> would inject ANTHROPIC_MODEL=<model>[1m] AND
   *     keep the stale --model flag; the flag wins over the env var,
   *     silently dropping the 1M window.
   *   - Headroom was ON at spawn (--model was never pushed) -> Headroom is
   *     OFF now -> would carry neither selector and the column falls back
   *     to the CLI default instead of the saved model.
   * So: strip --model when Headroom will own the binding, and (re)inject
   * --model <model> when it will not.
   *
   * `args` may carry a --model that has NOTHING to do with `model` — e.g.
   * restoreSessions builds args once from the CURRENT global spawn dropdown,
   * which can push its own `--model <dropdown pick>` unrelated to the saved
   * per-column model being restored. So whenever we're going to own the
   * decision (Headroom owns it, or we have a `model` to pin and no endpoint
   * owns the tier), we unconditionally strip EVERY existing `--model`
   * occurrence first and, in the latter case, inject exactly one fresh one —
   * never trusting an existing flag's value. Only when there's no `model` to
   * fall back on (a legacy entry with no saved model) do we leave whatever
   * was already there untouched, so that case restores unchanged.
   *
   * Handles both `--model <value>` (positional) and `--model=<value>`
   * (single-token, as typed into the Custom args field) shapes, plus a
   * malformed trailing bare `--model` with no value (always dropped — it's
   * not a valid CLI invocation either way).
   *
   * @param {string[]} args
   * @param {string|null|undefined} model - the model this column is pinned to
   * @param {boolean} headroomOwns - result of headroomOwnsModel() for this column
   * @param {boolean} isLocal - true when a local endpoint preset owns --model instead
   * @returns {string[]}
   */
  function reconcileModelArgForRespawn(args, model, headroomOwns, isLocal) {
    args = Array.isArray(args) ? args : [];
    // We own the outcome (and so must strip any pre-existing --model rather
    // than trust its value) whenever Headroom will bind the model itself, OR
    // we have our own model to pin and no endpoint owns the tier instead.
    var willReplace = !!headroomOwns || (!!model && !isLocal);
    var out = [];
    for (var i = 0; i < args.length; i++) {
      if (args[i] === '--model') {
        if (i + 1 < args.length) {
          if (!willReplace) out.push(args[i], args[i + 1]);
          i++;
        }
        // else: malformed trailing bare --model with no value — always dropped.
        continue;
      }
      if (typeof args[i] === 'string' && /^--model=/.test(args[i])) {
        if (!willReplace) out.push(args[i]);
        continue;
      }
      out.push(args[i]);
    }
    // isLocal columns never get a bare --model re-injected here — an
    // endpoint preset's env block owns the model tier, same as buildSpawnArgs.
    if (!headroomOwns && !isLocal && model) {
      var injectModel = ClaudeModels ? ClaudeModels.stripWindowMarker(model) : model;
      out.push('--model', injectModel);
    }
    return out;
  }

  var api = {
    buildHeadroomEnv: buildHeadroomEnv,
    buildHeadroomProxyArgs: buildHeadroomProxyArgs,
    headroomModelWindow: headroomModelWindow,
    headroomOwnsModel: headroomOwnsModel,
    reconcileModelArgForRespawn: reconcileModelArgForRespawn
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.HeadroomEnv = api;
  }
})();
