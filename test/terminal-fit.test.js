const test = require('node:test');
const assert = require('node:assert/strict');
const { correctRows } = require('../lib/terminal-fit');

test('no-op when rows already fit (whole-pixel cell, dpr=1)', () => {
  // floor(782/17) = 46, proposedRows 46 -> 46
  const r = correctRows({ availableHeightCss: 782, deviceCellHeightPx: 17, devicePixelRatio: 1, proposedRows: 46 });
  assert.equal(r, 46);
});

test('trims on overflow (taller device cell)', () => {
  // floor(782/18) = 43, proposedRows 46 -> 43
  const r = correctRows({ availableHeightCss: 782, deviceCellHeightPx: 18, devicePixelRatio: 1, proposedRows: 46 });
  assert.equal(r, 43);
});

test('fractional dpr rounds rendered row height', () => {
  // renderedRow = 26/1.5 ≈ 17.333; floor(782/17.333) = 45, proposedRows 46 -> 45
  const r = correctRows({ availableHeightCss: 782, deviceCellHeightPx: 26, devicePixelRatio: 1.5, proposedRows: 46 });
  assert.equal(r, 45);
});

test('never grows rows beyond proposed', () => {
  // maxRows would be 43 but proposed is 40 -> 40
  const r = correctRows({ availableHeightCss: 782, deviceCellHeightPx: 18, devicePixelRatio: 1, proposedRows: 40 });
  assert.equal(r, 40);
});

test('always returns at least 1 row', () => {
  const r = correctRows({ availableHeightCss: 5, deviceCellHeightPx: 18, devicePixelRatio: 1, proposedRows: 46 });
  assert.equal(r, 1);
});

test('safety: deviceCellHeightPx=0 returns proposedRows unchanged', () => {
  const r = correctRows({ availableHeightCss: 782, deviceCellHeightPx: 0, devicePixelRatio: 1, proposedRows: 46 });
  assert.equal(r, 46);
});

test('safety: devicePixelRatio=0 returns proposedRows unchanged', () => {
  const r = correctRows({ availableHeightCss: 782, deviceCellHeightPx: 18, devicePixelRatio: 0, proposedRows: 46 });
  assert.equal(r, 46);
});

test('safety: availableHeightCss=0 returns proposedRows unchanged', () => {
  const r = correctRows({ availableHeightCss: 0, deviceCellHeightPx: 18, devicePixelRatio: 1, proposedRows: 46 });
  assert.equal(r, 46);
});

test('safety: availableHeightCss=NaN returns proposedRows unchanged', () => {
  const r = correctRows({ availableHeightCss: NaN, deviceCellHeightPx: 18, devicePixelRatio: 1, proposedRows: 46 });
  assert.equal(r, 46);
});
