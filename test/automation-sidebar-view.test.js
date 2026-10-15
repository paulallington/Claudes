const test = require('node:test');
const assert = require('node:assert/strict');
const {
  automationRowState,
  openItemCount,
  projectPathKey,
} =require('../lib/automation-sidebar-view');

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

test('openItemCount counts unacknowledged findings and unresolved decisions once each, for one automation', () => {
  var ack = '2026-10-15T00:00:00.000Z';
  var findings = [
    { id: 'f1', automationId: 'a1', acknowledgedAt: null, decision: null, resolution: null },
    { id: 'f2', automationId: 'a1', acknowledgedAt: ack, decision: null, resolution: null },
    { id: 'f3', automationId: 'a1', acknowledgedAt: ack, decision: { prompt: 'Renew?' }, resolution: null },
    { id: 'f4', automationId: 'a1', acknowledgedAt: ack, decision: { prompt: 'Renew?' }, resolution: { choiceId: 'yes' } },
    { id: 'f5', automationId: 'a1', acknowledgedAt: null, decision: { prompt: 'Renew?' }, resolution: null },
    { id: 'f6', automationId: 'a2', acknowledgedAt: null, decision: null, resolution: null },
    null,
  ];
  assert.equal(openItemCount(findings, 'a1'), 3);
  assert.equal(openItemCount(findings, 'a2'), 1);
  assert.equal(openItemCount(findings, 'a3'), 0);
  assert.equal(openItemCount(null, 'a1'), 0);
  assert.equal(openItemCount(undefined, 'a1'), 0);
});

test('projectPathKey normalises backslashes to forward slashes and tolerates non-strings', () => {
  assert.equal(projectPathKey('C:\\Users\\paul\\Git\\Claudes'),'C:/Users/paul/Git/Claudes');
  assert.equal(projectPathKey('/home/paul/proj'), '/home/paul/proj');
  assert.equal(projectPathKey(null), '');
  assert.equal(projectPathKey(undefined), '');
});
