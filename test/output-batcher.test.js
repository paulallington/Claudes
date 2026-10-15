const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutputBatcher } = require('../lib/output-batcher');

function setup() {
  const delivered = [];
  const timers = [];
  const batcher = createOutputBatcher({
    intervalMs: 50,
    deliver: (id, data) => delivered.push([id, data]),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  const fire = () => {
    const t = timers.find((x) => !x.cleared && !x.fired);
    t.fired = true;
    t.fn();
  };
  return { batcher, delivered, timers, fire };
}

test('non-immediate push is not delivered synchronously, and ids share one timer', () => {
  const { batcher, delivered, timers, fire } = setup();
  batcher.push('a', 'x', false);
  batcher.push('b', 'y', false);
  batcher.push('a', 'z', false);
  assert.deepEqual(delivered, []);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 50);
  fire();
  assert.deepEqual(delivered, [['a', 'xz'], ['b', 'y']]);
});

test('immediate push delivers that id pending data first, in one call', () => {
  const { batcher, delivered, fire } = setup();
  batcher.push('a', 'one', false);
  batcher.push('b', 'other', false);
  batcher.push('a', 'two', true);
  assert.deepEqual(delivered, [['a', 'onetwo']]);
  fire();
  assert.deepEqual(delivered, [['a', 'onetwo'], ['b', 'other']]);
});

test('immediate push with nothing pending delivers just the data', () => {
  const { batcher, delivered, timers } = setup();
  batcher.push('a', 'now', true);
  assert.deepEqual(delivered, [['a', 'now']]);
  assert.equal(timers.length, 0);
});
