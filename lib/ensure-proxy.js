'use strict';

(function () {
  /**
   * Build an idempotent, race-guarded "ensure the Headroom proxy is up" routine.
   *
   * The app owns a single persistent proxy. On a cold boot many columns may ask
   * for it at once; we must start it exactly ONCE and have every caller await the
   * same readiness. All I/O is injected so the decision logic is pure and unit
   * testable.
   *
   * @param {object} deps
   * @param {() => Promise<boolean>} deps.probeHealth  resolves true when the proxy answers /health
   * @param {() => Promise<void>|void} deps.startProxy  spawns the detached `headroom proxy`
   * @param {(ms:number) => Promise<void>} deps.sleep   delay between readiness polls
   * @param {number} [deps.timeoutMs=15000]  max time to wait for readiness after starting
   * @param {number} [deps.intervalMs=250]   poll interval
   * @returns {() => Promise<{ ok:boolean, started:boolean, error?:Error }>}
   */
  function makeProxyEnsurer(deps) {
    var probeHealth = deps.probeHealth;
    var startProxy = deps.startProxy;
    var sleep = deps.sleep;
    var timeoutMs = deps.timeoutMs != null ? deps.timeoutMs : 15000;
    var intervalMs = deps.intervalMs != null ? deps.intervalMs : 250;

    // Shared in-flight promise: concurrent ensure() calls collapse onto one run,
    // so startProxy fires at most once per cold start.
    var inFlight = null;

    async function run() {
      if (await probeHealth()) {
        return { ok: true, started: false };
      }
      await startProxy();
      var maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
      for (var i = 0; i < maxAttempts; i++) {
        if (await probeHealth()) {
          return { ok: true, started: true };
        }
        await sleep(intervalMs);
      }
      return {
        ok: false,
        started: true,
        error: new Error('Headroom proxy did not become ready within ' + timeoutMs + 'ms'),
      };
    }

    function ensure() {
      if (inFlight) return inFlight;
      inFlight = run();
      // Clear the guard once settled so a later call (e.g. after the proxy dies
      // again) is allowed to start it afresh.
      inFlight.then(clear, clear);
      return inFlight;
    }

    function clear() { inFlight = null; }

    return ensure;
  }

  var api = { makeProxyEnsurer: makeProxyEnsurer };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.EnsureProxy = api;
  }
})();
