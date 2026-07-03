'use strict';

(function () {
  /**
   * Transform a spawn command so a Claude column launches through Headroom's
   * per-launch wrapper: `headroom wrap claude --no-proxy [--1m] -- <claude args>`.
   *
   * The app owns a single persistent Headroom proxy (see main.js
   * ensureHeadroomProxy); wrapped columns therefore always pass `--no-proxy` so
   * they only ever REUSE that proxy and never run the fragile detect-or-start
   * path (which races on cold boot and dies with the spawning process).
   *
   * `--1m` (claude-side: sets ANTHROPIC_MODEL=<opus>[1m]) is added when `oneM`
   * is truthy so the 1M context window survives the custom ANTHROPIC_BASE_URL.
   * `--memory` / `--learn` are NOT emitted here — they are proxy-side flags on
   * the app-owned `headroom proxy` start command.
   *
   * Passthrough (return the original { cmd, args } unchanged) when any of:
   *   - enabled is falsy, or
   *   - hasEndpoint is truthy (a local endpoint owns ANTHROPIC_BASE_URL), or
   *   - cmd is truthy but not the string 'claude' (an arbitrary-command column).
   *
   * @param {{ enabled?: any, cmd?: any, args?: any[], hasEndpoint?: any, oneM?: any }} input
   * @returns {{ cmd: any, args: any }}
   */
  function applyHeadroomWrap(input) {
    var enabled = input.enabled;
    var cmd = input.cmd;
    var args = input.args;
    var hasEndpoint = input.hasEndpoint;
    var oneM = input.oneM;

    if (!enabled || hasEndpoint || (cmd && cmd !== 'claude')) {
      return { cmd: cmd, args: args };
    }

    var wrapArgs = ['wrap', 'claude', '--no-proxy'];
    if (oneM) wrapArgs.push('--1m');
    wrapArgs.push('--');
    return { cmd: 'headroom', args: wrapArgs.concat(args || []) };
  }

  var api = { applyHeadroomWrap: applyHeadroomWrap };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.HeadroomWrap = api;
  }
})();
