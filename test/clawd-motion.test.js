const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldAnimate, pausedSvg } = require('../lib/clawd-motion');

test('shouldAnimate: idle-category animations hold still even when focused and visible', () => {
  ['idle', 'sleeping', 'disconnected', 'going-away'].forEach((animId) => {
    assert.equal(shouldAnimate({ animId, windowFocused: true, docVisible: true }), false, animId);
  });
  ['thinking', 'happy', 'confused', 'building'].forEach((animId) => {
    assert.equal(shouldAnimate({ animId, windowFocused: true, docVisible: true }), true, animId);
  });
});

test('shouldAnimate: working animation animates only when focused and visible', () => {
  assert.equal(shouldAnimate({ animId: 'typing', windowFocused: true, docVisible: true }), true);
  assert.equal(shouldAnimate({ animId: 'typing', windowFocused: false, docVisible: true }), false);
  assert.equal(shouldAnimate({ animId: 'typing', windowFocused: true, docVisible: false }), false);
});

test('pausedSvg: injects a pause style before the last </svg>', () => {
  const svg = '<svg><g/><svg><g/></svg></svg>';
  assert.equal(
    pausedSvg(svg),
    '<svg><g/><svg><g/></svg><style>*{animation-play-state:paused!important}</style></svg>'
  );
});

test('pausedSvg: returns null for non-strings and text without </svg>', () => {
  assert.equal(pausedSvg(null), null);
  assert.equal(pausedSvg(42), null);
  assert.equal(pausedSvg('<svg>'), null);
});
