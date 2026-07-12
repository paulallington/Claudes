// Pure exponential backoff for the renderer's WebSocket reconnect loop. The
// old behavior retried a fixed 2s forever with no cap and no "server is down"
// UX. This module is the tested core; jitter and the actual setTimeout/toast
// wiring live in renderer.js (kept out of this pure function on purpose).

// reconnectDelay: given the 1-based count of consecutive failed reconnects,
// return the delay (ms) before the next attempt. attempt <= 1 returns base.
function reconnectDelay(attempt, opts) {
  opts = opts || {};
  var base = opts.base != null ? opts.base : 1000;
  var factor = opts.factor != null ? opts.factor : 2;
  var cap = opts.cap != null ? opts.cap : 30000;
  var n = attempt <= 1 ? 1 : attempt;
  var delay = base * Math.pow(factor, n - 1);
  return Math.min(cap, delay);
}

// shouldShowServerDown: after this many consecutive failed reconnects, the
// renderer should surface a "terminal server is down" toast instead of
// retrying silently forever.
function shouldShowServerDown(attempt, opts) {
  opts = opts || {};
  var threshold = opts.threshold != null ? opts.threshold : 4;
  return attempt >= threshold;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { reconnectDelay: reconnectDelay, shouldShowServerDown: shouldShowServerDown };
}
if (typeof window !== 'undefined') {
  window.ReconnectBackoff = { reconnectDelay: reconnectDelay, shouldShowServerDown: shouldShowServerDown };
}
