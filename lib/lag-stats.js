// Small sample accumulator for the renderer's responsiveness telemetry
// (event-loop lag, keystroke-to-echo latency). Pure: no DOM, no Electron.
//
// Stores at most `cap` recent samples (ring buffer) so memory stays bounded;
// count and max are tracked separately and stay exact past the cap.
function createLagStats(cap) {
  var limit = cap > 0 ? cap : 2000;
  var samples = [];
  var next = 0;
  var count = 0;
  var max = 0;

  function rank(sorted, p) {
    var i = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, i))];
  }

  return {
    record: function (ms) {
      if (typeof ms !== 'number' || !isFinite(ms)) return;
      count++;
      if (ms > max) max = ms;
      if (samples.length < limit) {
        samples.push(ms);
      } else {
        samples[next] = ms;
        next = (next + 1) % limit;
      }
    },
    snapshot: function () {
      if (samples.length === 0) return { p50: 0, p99: 0, max: 0, count: 0 };
      var sorted = samples.slice().sort(function (a, b) { return a - b; });
      return { p50: rank(sorted, 50), p99: rank(sorted, 99), max: max, count: count };
    },
    reset: function () {
      samples = [];
      next = 0;
      count = 0;
      max = 0;
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createLagStats: createLagStats };
}
if (typeof window !== 'undefined') {
  window.LagStats = { createLagStats: createLagStats };
}
