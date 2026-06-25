const test = require('node:test');
const assert = require('node:assert/strict');
const { observeWrapperResize } = require('../lib/wrapper-refit');

// Fake timers: capture scheduled callbacks so the test drives the clock.
function makeFakeTimers() {
  var pending = {};
  var nextId = 1;
  return {
    set: function (fn) {
      var id = nextId++;
      pending[id] = fn;
      return id;
    },
    clear: function (id) {
      delete pending[id];
    },
    // test helper: run all pending callbacks
    runAll: function () {
      var ids = Object.keys(pending);
      for (var i = 0; i < ids.length; i++) {
        var fn = pending[ids[i]];
        delete pending[ids[i]];
        fn();
      }
    },
    pendingCount: function () {
      return Object.keys(pending).length;
    }
  };
}

// Fake ResizeObserver: records observe/disconnect and lets the test fire callbacks.
function makeFakeResizeObserverCtor() {
  var instances = [];
  function Ctor(cb) {
    this.cb = cb;
    this.observed = [];
    this.disconnected = false;
    instances.push(this);
  }
  Ctor.prototype.observe = function (el) {
    this.observed.push(el);
  };
  Ctor.prototype.disconnect = function () {
    this.disconnected = true;
  };
  Ctor.prototype.fire = function () {
    this.cb([], this);
  };
  Ctor._instances = instances;
  return Ctor;
}

test('multiple observer callbacks within window collapse to ONE trailing onResize', () => {
  var timers = makeFakeTimers();
  var ROCtor = makeFakeResizeObserverCtor();
  var calls = 0;
  observeWrapperResize({
    wrapper: {},
    onResize: function () { calls++; },
    debounceMs: 100,
    ResizeObserverCtor: ROCtor,
    timers: timers
  });
  var inst = ROCtor._instances[0];
  inst.fire();
  inst.fire();
  inst.fire();
  assert.equal(calls, 0, 'onResize must not fire before the quiet period');
  timers.runAll();
  assert.equal(calls, 1, 'rapid callbacks collapse to exactly one trailing onResize');
});

test('disconnect() calls observer.disconnect() AND cancels a pending onResize', () => {
  var timers = makeFakeTimers();
  var ROCtor = makeFakeResizeObserverCtor();
  var calls = 0;
  var disconnect = observeWrapperResize({
    wrapper: {},
    onResize: function () { calls++; },
    debounceMs: 100,
    ResizeObserverCtor: ROCtor,
    timers: timers
  });
  var inst = ROCtor._instances[0];
  inst.fire();
  disconnect();
  assert.equal(inst.disconnected, true, 'observer.disconnect() must be called');
  timers.runAll();
  assert.equal(calls, 0, 'pending onResize must NOT fire after disconnect');
});

test('observes the supplied wrapper element', () => {
  var timers = makeFakeTimers();
  var ROCtor = makeFakeResizeObserverCtor();
  var wrapper = { tag: 'wrap' };
  observeWrapperResize({
    wrapper: wrapper,
    onResize: function () {},
    ResizeObserverCtor: ROCtor,
    timers: timers
  });
  var inst = ROCtor._instances[0];
  assert.equal(inst.observed.length, 1);
  assert.equal(inst.observed[0], wrapper);
});

test('safety: missing wrapper returns a no-op disconnect and does not throw', () => {
  var ROCtor = makeFakeResizeObserverCtor();
  var disconnect = observeWrapperResize({
    wrapper: null,
    onResize: function () {},
    ResizeObserverCtor: ROCtor
  });
  assert.equal(typeof disconnect, 'function');
  assert.equal(ROCtor._instances.length, 0, 'no observer created without a wrapper');
  assert.doesNotThrow(function () { disconnect(); });
});

test('safety: absent ResizeObserverCtor returns a no-op disconnect and does not throw', () => {
  var disconnect = observeWrapperResize({
    wrapper: {},
    onResize: function () {},
    ResizeObserverCtor: null
  });
  assert.equal(typeof disconnect, 'function');
  assert.doesNotThrow(function () { disconnect(); });
});
