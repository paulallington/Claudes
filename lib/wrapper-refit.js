/**
 * Re-fit a terminal whenever its wrapper element changes size.
 *
 * The create-time fit() runs before the column's flex layout (header +
 * endpoint banner) has settled, so FitAddon momentarily sees a too-tall
 * wrapper and picks one row too many; the layout then settles shorter but
 * nothing re-fits, so the canvas overflows the (overflow:hidden) wrapper and
 * clips the last row. A ResizeObserver on the wrapper catches that settle (and
 * later header-wrap / panel-toggle resizes) and re-fits uniformly. Observer
 * callbacks are debounced (trailing) so a burst collapses to one fit().
 *
 * @param {Object} opts
 * @param {Element} opts.wrapper            element to observe
 * @param {Function} opts.onResize          called (debounced) on size change
 * @param {number} [opts.debounceMs=100]    quiet period before onResize fires
 * @param {Function} [opts.ResizeObserverCtor=window.ResizeObserver]
 * @param {{ set: Function, clear: Function }} [opts.timers]
 *        timer primitives; defaults to { set: setTimeout, clear: clearTimeout }
 * @returns {Function} disconnect() — stops the observer AND cancels any pending
 *          debounced onResize. Always safe to call; a no-op when setup bailed.
 */
function observeWrapperResize(opts) {
  var noop = function () {};
  if (!opts) return noop;

  var wrapper = opts.wrapper;
  var onResize = typeof opts.onResize === 'function' ? opts.onResize : noop;
  var debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 100;
  var ROCtor = opts.ResizeObserverCtor ||
    (typeof window !== 'undefined' ? window.ResizeObserver : null);

  // Safety: without a wrapper or a ResizeObserver there is nothing to wire.
  if (!wrapper || typeof ROCtor !== 'function') return noop;

  var makeDebouncer = (typeof require !== 'undefined')
    ? require('./resize-scheduler').makeDebouncer
    : (typeof window !== 'undefined' && window.ResizeScheduler
        ? window.ResizeScheduler.makeDebouncer
        : null);
  if (typeof makeDebouncer !== 'function') return noop;

  var debouncer = makeDebouncer(onResize, debounceMs, opts.timers);

  var observer;
  try {
    observer = new ROCtor(function () {
      debouncer.schedule();
    });
    observer.observe(wrapper);
  } catch (e) {
    debouncer.cancel();
    return noop;
  }

  return function disconnect() {
    debouncer.cancel();
    try {
      observer.disconnect();
    } catch (e) {}
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { observeWrapperResize: observeWrapperResize };
}
if (typeof window !== 'undefined') {
  window.WrapperRefit = { observeWrapperResize: observeWrapperResize };
}
