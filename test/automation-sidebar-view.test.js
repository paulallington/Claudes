const test = require('node:test');
const assert = require('node:assert/strict');
const {
  automationRowState,
  openItemCount,
  openItemCounts,
  projectPathKey,
  buildSidebarAutomationRows,
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

test('buildSidebarAutomationRows groups row models by normalised project path in input order', () => {
  var automations = [
    auto({ id: 'a1', name: 'Cert Watcher', projectPath: 'C:\\Git\\Proj' }),
    auto({ id: 'a2', name: 'Disk Watcher', projectPath: 'C:/Git/Other', enabled: false }),
    auto({ id: 'a3', name: 'Backups', projectPath: 'C:/Git/Proj', agents: [{ id: 'g', currentRunStartedAt: 'x' }] }),
    auto({ id: 'a4', name: 'Lint', projectPath: 'C:/Git/Proj', agents: [{ id: 'g', lastRunStatus: 'error' }] }),
  ];
  var findings = [
    { id: 'f1', automationId: 'a1', acknowledgedAt: null },
    { id: 'f2', automationId: 'a1', acknowledgedAt: null },
    { id: 'f3', automationId: 'a4', acknowledgedAt: null },
  ];
  var rows = buildSidebarAutomationRows(automations, findings, { globalEnabled: true });
  assert.deepEqual(Object.keys(rows), ['C:/Git/Proj', 'C:/Git/Other']);
  assert.deepEqual(rows['C:/Git/Proj'].map(function (r) { return r.id; }), ['a1', 'a3', 'a4']);
  assert.deepEqual(rows['C:/Git/Proj'][0], { id: 'a1', name: 'Cert Watcher', state: 'idle', badgeCount: 2, dimmed: false, title: 'Idle \u00b7 2 open items' });
  assert.equal(rows['C:/Git/Proj'][1].title, 'Running');
  assert.equal(rows['C:/Git/Proj'][2].title, 'Needs attention \u00b7 1 open item');
  assert.deepEqual(rows['C:/Git/Other'][0], { id: 'a2', name: 'Disk Watcher', state: 'disabled', badgeCount: 0, dimmed: true, title: 'Disabled' });
});

test('buildSidebarAutomationRows dims and titles paused rows and tolerates missing inputs', () => {
  var rows = buildSidebarAutomationRows([auto()], null, { globalEnabled: false });
  assert.equal(rows['C:/Git/Proj'][0].state, 'paused');
  assert.equal(rows['C:/Git/Proj'][0].dimmed, true);
  assert.equal(rows['C:/Git/Proj'][0].title, 'Paused (scheduler paused)');
  assert.deepEqual(buildSidebarAutomationRows(undefined, undefined, undefined), {});
  assert.deepEqual(buildSidebarAutomationRows([], [], {}), {});
  assert.deepEqual(buildSidebarAutomationRows([null, 'x'], [], {}), {});
});

test('buildSidebarAutomationRows uses opts.openCounts instead of findings when given', () => {
  var automations = [auto({ id: 'a1' }), auto({ id: 'a2', projectPath: 'C:/Git/Other' })];
  var findings = [{ id: 'f1', automationId: 'a2', acknowledgedAt: null }];
  var rows = buildSidebarAutomationRows(automations, findings, { globalEnabled: true, openCounts: { a1: 2 } });
  assert.equal(rows['C:/Git/Proj'][0].badgeCount, 2);
  assert.equal(rows['C:/Git/Proj'][0].title, 'Idle \u00b7 2 open items');
  assert.equal(rows['C:/Git/Other'][0].badgeCount, 0);
  var viaNull = buildSidebarAutomationRows(automations, null, { openCounts: { a2: 1 } });
  assert.equal(viaNull['C:/Git/Other'][0].title, 'Idle \u00b7 1 open item');
});

test('openItemCounts maps automationId to the open count using the openItemCount rule', () => {
  var ack = '2026-10-15T00:00:00.000Z';
  var findings = [
    { id: 'f1', automationId: 'a1', acknowledgedAt: null },
    { id: 'f2', automationId: 'a1', acknowledgedAt: ack },
    { id: 'f3', automationId: 'a1', acknowledgedAt: ack, decision: { prompt: 'Renew?' }, resolution: null },
    { id: 'f4', automationId: 'a1', acknowledgedAt: null, decision: { prompt: 'Renew?' }, resolution: null },
    { id: 'f5', automationId: 'a2', acknowledgedAt: ack, decision: { prompt: 'x' }, resolution: { choiceId: 'y' } },
    { id: 'f6', automationId: 'a3', acknowledgedAt: null },
    { id: 'f7', acknowledgedAt: null },
    null,
  ];
  assert.deepEqual(openItemCounts(findings), { a1: 3, a3: 1 });
  assert.deepEqual(openItemCounts(null), {});
  assert.deepEqual(openItemCounts(undefined), {});
});
