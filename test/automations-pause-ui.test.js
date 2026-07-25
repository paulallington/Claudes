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
