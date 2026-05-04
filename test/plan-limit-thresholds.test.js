const test = require('node:test');
const assert = require('node:assert');
const { detectCrossings } = require('../lib/plan-limit-thresholds');

test('returns no crossings on first observation', () => {
  const crossings = detectCrossings(null, { five_hour: { utilization: 50 }, seven_day: { utilization: 50 } });
  assert.deepStrictEqual(crossings, []);
});

test('detects 70% upward crossing on session', () => {
  const prev = { five_hour: { utilization: 65 }, seven_day: { utilization: 10 } };
  const next = { five_hour: { utilization: 71 }, seven_day: { utilization: 10 } };
  const crossings = detectCrossings(prev, next);
  assert.deepStrictEqual(crossings, [{ window: 'five_hour', threshold: 70, value: 71 }]);
});

test('detects 90% upward crossing on weekly', () => {
  const prev = { five_hour: { utilization: 50 }, seven_day: { utilization: 89 } };
  const next = { five_hour: { utilization: 50 }, seven_day: { utilization: 91 } };
  const crossings = detectCrossings(prev, next);
  assert.deepStrictEqual(crossings, [{ window: 'seven_day', threshold: 90, value: 91 }]);
});

test('does not re-fire on same side of threshold', () => {
  const prev = { five_hour: { utilization: 75 } };
  const next = { five_hour: { utilization: 80 } };
  assert.deepStrictEqual(detectCrossings(prev, next), []);
});

test('does not fire on downward crossing (reset)', () => {
  const prev = { five_hour: { utilization: 95 } };
  const next = { five_hour: { utilization: 5 } };
  assert.deepStrictEqual(detectCrossings(prev, next), []);
});

test('handles missing window gracefully', () => {
  assert.deepStrictEqual(detectCrossings({ five_hour: null }, { five_hour: null }), []);
  assert.deepStrictEqual(detectCrossings({}, { five_hour: { utilization: 80 } }), []);
});
