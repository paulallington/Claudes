const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGlobalPauseUi, resolveAutomationCardStatus } = require('../lib/automations-pause-ui');

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

test('resolveAutomationCardStatus: disabled outranks everything, including global pause', () => {
  const automation = { enabled: false, agents: [] };
  assert.deepEqual(resolveAutomationCardStatus({ globalEnabled: false, automation }), {
    statusClass: 'automation-disabled',
    badgeClass: 'badge-disabled',
    badgeText: 'disabled',
    dimmed: false,
  });
});
