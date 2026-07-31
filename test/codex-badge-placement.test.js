'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { placeBadgeTooltip } = require('../lib/codex-badge-placement');

test('placeBadgeTooltip keeps narrow and rightmost-column details inside the viewport', () => {
  assert.deepStrictEqual(placeBadgeTooltip(
    { left: 1160, top: 20, right: 1210, bottom: 35, width: 50, height: 15 },
    { width: 280, height: 120 },
    { width: 1280, height: 720 }
  ), { left: 992, top: 41 });

  assert.deepStrictEqual(placeBadgeTooltip(
    { left: 4, top: 20, right: 54, bottom: 35, width: 50, height: 15 },
    { width: 280, height: 120 },
    { width: 1280, height: 720 }
  ), { left: 8, top: 41 });
});

test('placeBadgeTooltip flips above the badge near the bottom edge', () => {
  assert.deepStrictEqual(placeBadgeTooltip(
    { left: 100, top: 680, right: 150, bottom: 695, width: 50, height: 15 },
    { width: 240, height: 100 },
    { width: 1280, height: 720 }
  ), { left: 8, top: 574 });
});
