/**
 * Tiny dependency-injectable trailing debounce factory. Used to coalesce the
 * burst of resize requests fired during a column/row drag into a single
 * authoritative fit()+PTY-resize so xterm.cols and the PTY width never mismatch
 * mid-drag (which corrupts the terminal buffer).
 *
 * @param {Function} fn          the work to run once the burst settles
 * @param {number} delayMs       quiet period before fn fires
 * @param {{ set: Function, clear: Function }} [timers]
 *        timer primitives; defaults to { set: setTimeout, clear: clearTimeout }
 * @returns {{ schedule: Function, flush: Function, cancel: Function }}
 *   - schedule(): (re)start the timer; rapid calls collapse to ONE trailing fn()
 *   - flush(): if a call is pending, cancel the timer and invoke fn() now
 *   - cancel(): clear any pending timer without invoking fn()
 */
function makeDebouncer(fn, delayMs, timers) {
  var setT = (timers && timers.set) || setTimeout;
  var clearT = (timers && timers.clear) || clearTimeout;
  var timerId = null;

  function cancel() {
    if (timerId !== null) {
      clearT(timerId);
      timerId = null;
    }
  }

  function schedule() {
    cancel();
    timerId = setT(function () {
      timerId = null;
      fn();
    }, delayMs);
  }

  function flush() {
    if (timerId !== null) {
      cancel();
      fn();
    }
  }

  return { schedule: schedule, flush: flush, cancel: cancel };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { makeDebouncer: makeDebouncer };
}
if (typeof window !== 'undefined') {
  window.ResizeScheduler = { makeDebouncer: makeDebouncer };
}
