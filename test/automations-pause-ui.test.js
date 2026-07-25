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
    bannerText: 'Scheduler paused — no scheduled runs will start.',
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

test('resolveAutomationCardStatus: an empty agents array is treated as idle, never throws', () => {
  const automation = { enabled: true, agents: [] };
  assert.deepEqual(resolveAutomationCardStatus({ globalEnabled: true, automation }), {
    statusClass: 'automation-idle',
    badgeClass: 'badge-idle',
    badgeText: 'idle',
    dimmed: false,
  });
});

test('resolveAutomationCardStatus: a missing agents array is treated as idle, never throws', () => {
  const automation = { enabled: true };
  assert.deepEqual(resolveAutomationCardStatus({ globalEnabled: true, automation }), {
    statusClass: 'automation-idle',
    badgeClass: 'badge-idle',
    badgeText: 'idle',
    dimmed: false,
  });
});

test('resolveAutomationCardStatus: a missing automation renders the idle shape, never throws', () => {
  assert.deepEqual(resolveAutomationCardStatus({ globalEnabled: true }), {
    statusClass: 'automation-idle',
    badgeClass: 'badge-idle',
    badgeText: 'idle',
    dimmed: false,
  });
});

test('resolveAutomationCardStatus: a missing automation renders the paused shape when globally paused, never throws', () => {
  assert.deepEqual(resolveAutomationCardStatus({ globalEnabled: false }), {
    statusClass: 'automation-paused',
    badgeClass: 'badge-paused',
    badgeText: 'paused',
    dimmed: true,
  });
});

test('resolveAutomationCardStatus: running outranks a global pause on an enabled automation, and is not dimmed', () => {
  const automation = { enabled: true, agents: [{ currentRunStartedAt: 123 }] };
  assert.deepEqual(resolveAutomationCardStatus({ globalEnabled: false, automation }), {
    statusClass: 'automation-running',
    badgeClass: 'badge-running',
    badgeText: 'running...',
    dimmed: false,
  });
});

test('resolveAutomationCardStatus: error outranks a global pause on an enabled automation, and is not dimmed', () => {
  const automation = { enabled: true, agents: [{ lastRunStatus: 'error' }] };
  assert.deepEqual(resolveAutomationCardStatus({ globalEnabled: false, automation }), {
    statusClass: 'automation-error',
    badgeClass: 'badge-error',
    badgeText: 'error',
    dimmed: false,
  });
});

test('resolveAutomationCardStatus: a globally paused, enabled, otherwise-idle automation shows paused and dimmed', () => {
  const automation = { enabled: true, agents: [{}] };
  assert.deepEqual(resolveAutomationCardStatus({ globalEnabled: false, automation }), {
    statusClass: 'automation-paused',
    badgeClass: 'badge-paused',
    badgeText: 'paused',
    dimmed: true,
  });
});

test('resolveAutomationCardStatus: idle and not dimmed when the scheduler is not paused', () => {
  const automation = { enabled: true, agents: [{}] };
  assert.deepEqual(resolveAutomationCardStatus({ globalEnabled: true, automation }), {
    statusClass: 'automation-idle',
    badgeClass: 'badge-idle',
    badgeText: 'idle',
    dimmed: false,
  });
});

test('resolveAutomationCardStatus: a disabled automation is never dimmed even when globally paused', () => {
  const automation = { enabled: false, agents: [{}] };
  assert.deepEqual(resolveAutomationCardStatus({ globalEnabled: false, automation }), {
    statusClass: 'automation-disabled',
    badgeClass: 'badge-disabled',
    badgeText: 'disabled',
    dimmed: false,
  });
});
