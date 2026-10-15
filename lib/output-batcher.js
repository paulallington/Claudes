// Coalesces terminal output for columns the user is not typing in, so many
// columns repainting at once reach their xterms in one task (one composited
// frame) instead of one frame each. Pure: the timer and the sink are injected.
//
// pending is a Map so flushAll delivers ids in the order they first received
// data since the last flush.
function createOutputBatcher(opts) {
  var intervalMs = opts.intervalMs;
  var deliver = opts.deliver;
  var setTimer = opts.setTimer;
  var clearTimer = opts.clearTimer;
  var pending = new Map();
  var timer = null;

  function flushAll() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    var batch = pending;
    pending = new Map();
    batch.forEach(function (data, id) { deliver(id, data); });
  }

  return {
    push: function (id, data) {
      var prev = pending.get(id);
      pending.set(id, prev === undefined ? data : prev + data);
      if (timer === null) timer = setTimer(flushAll, intervalMs);
    },
    flushAll: flushAll,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createOutputBatcher: createOutputBatcher };
}
if (typeof window !== 'undefined') {
  window.OutputBatcher = { createOutputBatcher: createOutputBatcher };
}
