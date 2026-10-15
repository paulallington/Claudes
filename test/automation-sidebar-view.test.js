const test = require('node:test');
const assert = require('node:assert/strict');
const {
  automationRowState,
} = require('../lib/automation-sidebar-view');

function auto(overrides) {
  return Object.assign({ id: 'a1', name: 'Cert Watcher', projectPath: 'C:\\Git\\Proj', enabled: true, agents: [{ id: 'g1' }] }, overrides);
}

test('automationRowState resolves precedence: disabled > running > attention > paused > idle', () => {
  var running = { id: 'g1', currentRunStartedAt: '2026-10-15T00:00:00.000Z' };
  var errored = { id: 'g2', lastRunStatus: 'error' };
  assert.equal(automationRowState(auto({ enabled: false, agents: [running, errored] }), { globalEnabled: false }), 'disabled');
  assert.equal(automationRowState(auto({ agents: [errored, running] }), { globalEnabled: false }), 'running');
  assert.equal(automationRowState(auto({ agents: [errored] }), { globalEnabled: false }), 'attention');
  assert.equal(automationRowState(auto({ agents: [{ id: 'g3', lastError: 'boom' }] }), {}), 'attention');
  assert.equal(automationRowState(auto({ manager: { enabled: true, needsHuman: true } }), {}), 'attention');
  assert.equal(automationRowState(auto(), { globalEnabled: false }), 'paused');
  assert.equal(automationRowState(auto(), { globalEnabled: true }), 'idle');
  assert.equal(automationRowState(auto(), {}), 'idle');
  assert.equal(automationRowState(auto({ agents: undefined }), undefined), 'idle');
});
