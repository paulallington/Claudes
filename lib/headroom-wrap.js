'use strict';

(function () {
  /**
   * Transform a spawn command so a Claude column launches through Headroom's
   * per-launch wrapper: `headroom wrap claude -- <claude args>`.
   *
   * Passthrough (return the original { cmd, args } unchanged) when any of:
   *   - enabled is falsy, or
   *   - hasEndpoint is truthy (a local endpoint owns ANTHROPIC_BASE_URL), or
   *   - cmd is truthy but not the string 'claude' (an arbitrary-command column).
   *
   * Otherwise wrap: { cmd: 'headroom', args: ['wrap', 'claude', '--', ...args] }.
   *
   * @param {{ enabled?: any, cmd?: any, args?: any[], hasEndpoint?: any }} input
   * @returns {{ cmd: any, args: any }}
   */
  function applyHeadroomWrap(input) {
    var enabled = input.enabled;
    var cmd = input.cmd;
    var args = input.args;
    var hasEndpoint = input.hasEndpoint;

    if (!enabled || hasEndpoint || (cmd && cmd !== 'claude')) {
      return { cmd: cmd, args: args };
    }

    return { cmd: 'headroom', args: ['wrap', 'claude', '--'].concat(args || []) };
  }

  var api = { applyHeadroomWrap: applyHeadroomWrap };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.HeadroomWrap = api;
  }
})();
