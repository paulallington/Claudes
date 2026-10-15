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

  function disarmIfIdle() {
    if (pending.size === 0 && timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  return {
    push: function (id, data, immediate) {
      var prev = pending.get(id);
      if (immediate) {
        if (prev !== undefined) {
          pending.delete(id);
          data = prev + data;
          disarmIfIdle();
        }
        deliver(id, data);
        return;
      }
      pending.set(id, prev === undefined ? data : prev + data);
      if (timer === null) timer = setTimer(flushAll, intervalMs);
    },
    flush: function (id) {
      var data = pending.get(id);
      if (data === undefined) return;
      pending.delete(id);
      disarmIfIdle();
      deliver(id, data);
    },
    drop: function (id) {
      if (pending.delete(id)) disarmIfIdle();
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
