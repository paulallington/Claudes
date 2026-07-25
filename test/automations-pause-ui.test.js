const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGlobalPauseUi } = require('../lib/automations-pause-ui');

test('resolveGlobalPauseUi treats a missing globalEnabled as enabled (not paused)', () => {
  assert.deepEqual(resolveGlobalPauseUi({}), {
    paused: false,
    showBanner: false,
    bannerText: '',
    toggleGlyph: '❚❚',
    toggleTitle: 'Pause scheduler',
  });
});

test('resolveGlobalPauseUi shows the paused banner/toggle when globalEnabled is explicitly false', () => {
  assert.deepEqual(resolveGlobalPauseUi({ globalEnabled: false }), {
    paused: true,
    showBanner: true,
    bannerText: 'Automations are paused — no scheduled runs will start.',
    toggleGlyph: '▶',
    toggleTitle: 'Resume scheduler',
  });
});
