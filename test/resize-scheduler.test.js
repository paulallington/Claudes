const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDebouncer } = require('../lib/resize-scheduler');

// Build a deterministic fake timer pair. set() records the callback + delay and
// returns an incrementing id; clear() forgets it. fire(id) manually invokes a
// pending callback (simulating the timer elapsing) and removes it.
function makeFakeTimers() {
  var pending = new Map();
  var nextId = 1;
  return {
    set: function (cb, delay) {
      var id = nextId++;
      pending.set(id, { cb: cb, delay: delay });
      return id;
    },
    clear: function (id) {
      pending.delete(id);
    },
    fire: function (id) {
      var entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id);
      entry.cb();
      return true;
    },
    fireAll: function () {
      var ids = Array.from(pending.keys());
      ids.forEach(function (id) {
        var entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.cb();
      });
    },
    pendingIds: function () {
      return Array.from(pending.keys());
    }
  };
}

test('a: 5 rapid schedule() calls then timer fires -> fn called exactly once', () => {
  const timers = makeFakeTimers();
  let calls = 0;
  const d = makeDebouncer(() => { calls++; }, 100, timers);
  d.schedule();
  d.schedule();
  d.schedule();
  d.schedule();
  d.schedule();
  // Only the latest scheduled timer should remain pending.
  assert.equal(timers.pendingIds().length, 1);
  timers.fireAll();
  assert.equal(calls, 1);
});

test('b: flush() invokes fn immediately and a stale timer firing later does not call again', () => {
  const timers = makeFakeTimers();
  let calls = 0;
  const d = makeDebouncer(() => { calls++; }, 100, timers);
  d.schedule();
  const staleIds = timers.pendingIds();
  d.flush();
  assert.equal(calls, 1, 'flush invokes immediately');
  // The previously-scheduled (now cancelled) timer must not fire fn again.
  staleIds.forEach((id) => timers.fire(id));
  assert.equal(calls, 1, 'stale timer does not re-invoke fn');
});

test('c: cancel() prevents any fn call', () => {
  const timers = makeFakeTimers();
  let calls = 0;
  const d = makeDebouncer(() => { calls++; }, 100, timers);
  d.schedule();
  d.cancel();
  timers.fireAll();
  assert.equal(calls, 0);
});

test('d: schedule() after a completed cycle starts a fresh one (fn called again)', () => {
  const timers = makeFakeTimers();
  let calls = 0;
  const d = makeDebouncer(() => { calls++; }, 100, timers);
  d.schedule();
  timers.fireAll();
  assert.equal(calls, 1);
  d.schedule();
  timers.fireAll();
  assert.equal(calls, 2);
});

test('flush() with nothing pending does not call fn', () => {
  const timers = makeFakeTimers();
  let calls = 0;
  const d = makeDebouncer(() => { calls++; }, 100, timers);
  d.flush();
  assert.equal(calls, 0);
});

test('uses provided delay when scheduling', () => {
  const timers = makeFakeTimers();
  let delayUsed = null;
  const captureTimers = {
    set: function (cb, delay) { delayUsed = delay; return timers.set(cb, delay); },
    clear: timers.clear
  };
  const d = makeDebouncer(() => {}, 250, captureTimers);
  d.schedule();
  assert.equal(delayUsed, 250);
});
