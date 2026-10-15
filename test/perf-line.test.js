const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeRendererLag, formatMainLag, formatRendererLag, MAIN_LAG_RESOLUTION_MS } = require('../lib/perf-line');

const full = {
  lagP50: 4, lagP99: 40, lagMax: 120, longTasks: 3, longTaskMs: 210,
  echoP50: 8, echoP99: 30, echoMax: 55, echoCount: 12, termKB: 640,
};

test('sanitizeRendererLag rejects non-objects', () => {
  assert.strictEqual(sanitizeRendererLag(null), null);
  assert.strictEqual(sanitizeRendererLag('x'), null);
  assert.strictEqual(sanitizeRendererLag(5), null);
  assert.strictEqual(sanitizeRendererLag([1, 2]), null);
  assert.strictEqual(sanitizeRendererLag(undefined), null);
});

test('sanitizeRendererLag copies only the known numeric fields', () => {
  const out = sanitizeRendererLag(Object.assign({ evil: 1, __proto__x: 2 }, full));
  assert.deepStrictEqual(out, full);
});

test('sanitizeRendererLag drops non-finite, negative and non-number values', () => {
  const out = sanitizeRendererLag({ lagP50: NaN, lagP99: -1, lagMax: '5', longTasks: Infinity, termKB: 7 });
  assert.deepStrictEqual(out, { termKB: 7 });
});

test('sanitizeRendererLag clamps huge values', () => {
  assert.strictEqual(sanitizeRendererLag({ lagMax: 1e12 }).lagMax, 1e7);
});

test('formatMainLag subtracts the sampling resolution and floors at zero', () => {
  // monitorEventLoopDelay records the whole gap between ticks, so an idle loop
  // reads as the resolution itself.
  const h = { percentile: (p) => (p === 50 ? 22.4e6 : 51.6e6), max: 140.2e6 };
  assert.strictEqual(formatMainLag(h, 20), ' mainLag=2/32/120');
  const idle = { percentile: () => 18e6, max: 20e6 };
  assert.strictEqual(formatMainLag(idle, 20), ' mainLag=0/0/0');
});

test('formatMainLag defaults to the shared sampling resolution', () => {
  const h = { percentile: () => 31e6, max: 39e6 };
  assert.strictEqual(MAIN_LAG_RESOLUTION_MS, 20);
  assert.strictEqual(formatMainLag(h), ' mainLag=11/11/19');
});

test('formatRendererLag renders the full snapshot', () => {
  assert.strictEqual(
    formatRendererLag(full),
    ' | rLag=4/40/120 lt=3/210ms echo=8/30/55(n=12) termKB=640'
  );
});

test('formatRendererLag treats missing fields as zero and returns empty for no snapshot', () => {
  assert.strictEqual(formatRendererLag(null), '');
  assert.strictEqual(
    formatRendererLag({ lagP99: 9 }),
    ' | rLag=0/9/0 lt=0/0ms echo=0/0/0(n=0) termKB=0'
  );
});
