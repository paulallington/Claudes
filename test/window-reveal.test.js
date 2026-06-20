const test = require('node:test');
const assert = require('node:assert/strict');
const { revealWindow } = require('../lib/window-reveal');

// Fake BrowserWindow recording which methods were called, in order.
function makeWin(overrides) {
  const calls = [];
  const win = {
    calls: calls,
    isDestroyed: function () { return false; },
    isMinimized: function () { return false; },
    restore: function () { calls.push('restore'); },
    show: function () { calls.push('show'); },
    focus: function () { calls.push('focus'); }
  };
  return Object.assign(win, overrides || {});
}

test('minimized window: restore THEN show THEN focus, in order', () => {
  const win = makeWin({ isMinimized: function () { return true; } });
  revealWindow(win);
  assert.deepEqual(win.calls, ['restore', 'show', 'focus']);
});

test('hidden-but-not-minimized window: show + focus, NO restore', () => {
  const win = makeWin({ isMinimized: function () { return false; } });
  revealWindow(win);
  assert.deepEqual(win.calls, ['show', 'focus']);
});

test('destroyed window: no calls', () => {
  const win = makeWin({ isDestroyed: function () { return true; } });
  revealWindow(win);
  assert.deepEqual(win.calls, []);
});

test('null window: does not throw', () => {
  assert.doesNotThrow(function () { revealWindow(null); });
  assert.doesNotThrow(function () { revealWindow(undefined); });
});

test('missing isDestroyed/isMinimized methods: still shows + focuses', () => {
  const calls = [];
  const win = {
    show: function () { calls.push('show'); },
    focus: function () { calls.push('focus'); }
  };
  revealWindow(win);
  assert.deepEqual(calls, ['show', 'focus']);
});
