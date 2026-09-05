const test = require('node:test');
const assert = require('node:assert/strict');
const { upsertFindings, resolveFinding, markResolutionsDelivered } = require('../lib/findings-store');
const { buildResolutionsBlock, pendingResolutionIds } = require('../lib/findings-resolution-injection');

test('buildResolutionsBlock returns empty string when the automation has no resolved decisions', () => {
  var r = upsertFindings({ version: 1, findings: [] }, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { key: 'k1', summary: 'Approve?', decision: { prompt: 'Approve?', options: [{ id: 'yes', label: 'Yes' }] } } },
  ], '2026-08-01T00:00:00.000Z');
  assert.equal(buildResolutionsBlock(r.store, 'auto_1'), '');
});

test('buildResolutionsBlock formats a resolved decision as "key: choiceId — \\"text\\""', () => {
  var r = upsertFindings({ version: 1, findings: [] }, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { key: 'kidspass-membership', summary: 'Kids Pass may still be billing', decision: { prompt: 'How should I handle this?', options: [{ id: 'chase', label: 'Chase them' }] } } },
  ], '2026-08-01T00:00:00.000Z');
  var id = r.store.findings[0].id;
  var resolved = resolveFinding(r.store, id, { choiceId: 'chase', text: 'get the refund if you can' }, '2026-08-02T00:00:00.000Z');

  var block = buildResolutionsBlock(resolved, 'auto_1');
  assert.equal(block,
    '\n\n--- RESOLUTIONS SINCE YOUR LAST RUN ---\n' +
    'kidspass-membership: chase — "get the refund if you can"\n' +
    '--- END RESOLUTIONS ---'
  );
});

test('buildResolutionsBlock omits the quoted text segment when no free text was given', () => {
  var r = upsertFindings({ version: 1, findings: [] }, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { key: 'deploy-approval', summary: 'Approve deploy?', decision: { prompt: 'Approve?', options: [{ id: 'yes', label: 'Yes' }] } } },
  ], '2026-08-01T00:00:00.000Z');
  var id = r.store.findings[0].id;
  var resolved = resolveFinding(r.store, id, { choiceId: 'yes' }, '2026-08-02T00:00:00.000Z');

  var block = buildResolutionsBlock(resolved, 'auto_1');
  assert.equal(block,
    '\n\n--- RESOLUTIONS SINCE YOUR LAST RUN ---\n' +
    'deploy-approval: yes\n' +
    '--- END RESOLUTIONS ---'
  );
});

test('buildResolutionsBlock excludes other automations, unresolved decisions, and findings with no decision at all', () => {
  var store = { version: 1, findings: [] };
  var r1 = upsertFindings(store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { key: 'k1', summary: 'Decision one', decision: { prompt: 'p', options: [{ id: 'a', label: 'A' }] } } },
  ], '2026-08-01T00:00:00.000Z');
  var r2 = upsertFindings(r1.store, [
    { automationId: 'auto_2', agentId: 'agent_1', item: { key: 'k2', summary: 'Decision two', decision: { prompt: 'p', options: [{ id: 'a', label: 'A' }] } } },
  ], '2026-08-01T00:00:00.000Z');
  var r3 = upsertFindings(r2.store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'A plain finding with no decision' } },
  ], '2026-08-01T00:00:00.000Z');

  var decisionOneId = r3.store.findings.find(function (f) { return f.summary === 'Decision one'; }).id;
  var decisionTwoId = r3.store.findings.find(function (f) { return f.summary === 'Decision two'; }).id;
  // Resolve auto_2's decision only — auto_1's own decision stays unresolved.
  var resolved = resolveFinding(r3.store, decisionTwoId, { choiceId: 'a' }, '2026-08-02T00:00:00.000Z');

  assert.equal(buildResolutionsBlock(resolved, 'auto_1'), '', 'unresolved decisions and other automations must not leak in');
  assert.notEqual(buildResolutionsBlock(resolved, 'auto_2'), '');
});

// Regression: the block is headed "SINCE YOUR LAST RUN", so it must report
// each answer exactly once. Injecting every resolution ever given on every
// run makes an automation re-action decisions it already carried out.
test('buildResolutionsBlock excludes a resolution that has already been delivered', () => {
  var r = upsertFindings({ version: 1, findings: [] }, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { key: 'kidspass-membership', summary: 'Kids Pass may still be billing', decision: { prompt: 'How?', options: [{ id: 'chase', label: 'Chase them' }] } } },
  ], '2026-08-01T00:00:00.000Z');
  var id = r.store.findings[0].id;
  var resolved = resolveFinding(r.store, id, { choiceId: 'chase' }, '2026-08-02T00:00:00.000Z');

  assert.notEqual(buildResolutionsBlock(resolved, 'auto_1'), '');

  var delivered = markResolutionsDelivered(resolved, [id], '2026-08-03T00:00:00.000Z');
  assert.equal(buildResolutionsBlock(delivered, 'auto_1'), '');
});

test('a decision answered again after delivery is reported once more', () => {
  var r = upsertFindings({ version: 1, findings: [] }, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { key: 'deploy-approval', summary: 'Approve deploy?', decision: { prompt: 'Approve?', options: [{ id: 'yes', label: 'Yes' }] } } },
  ], '2026-08-01T00:00:00.000Z');
  var id = r.store.findings[0].id;
  var delivered = markResolutionsDelivered(
    resolveFinding(r.store, id, { choiceId: 'yes' }, '2026-08-02T00:00:00.000Z'),
    [id], '2026-08-03T00:00:00.000Z'
  );
  assert.equal(buildResolutionsBlock(delivered, 'auto_1'), '');

  var reAnswered = resolveFinding(delivered, id, { choiceId: 'no' }, '2026-08-04T00:00:00.000Z');
  assert.equal(buildResolutionsBlock(reAnswered, 'auto_1'),
    '\n\n--- RESOLUTIONS SINCE YOUR LAST RUN ---\n' +
    'deploy-approval: no\n' +
    '--- END RESOLUTIONS ---'
  );
});

test('pendingResolutionIds matches exactly what buildResolutionsBlock reported, and empties after delivery', () => {
  var r1 = upsertFindings({ version: 1, findings: [] }, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { key: 'k1', summary: 'One?', decision: { prompt: 'One?', options: [{ id: 'a', label: 'A' }] } } },
    { automationId: 'auto_1', agentId: 'agent_1', item: { key: 'k2', summary: 'Two?', decision: { prompt: 'Two?', options: [{ id: 'b', label: 'B' }] } } },
    { automationId: 'auto_2', agentId: 'agent_1', item: { key: 'k3', summary: 'Other automation?', decision: { prompt: 'Three?', options: [{ id: 'c', label: 'C' }] } } },
  ], '2026-08-01T00:00:00.000Z');

  var ids = r1.store.findings.map(function (f) { return f.id; });
  var resolved = resolveFinding(resolveFinding(r1.store, ids[0], { choiceId: 'a' }, '2026-08-02T00:00:00.000Z'), ids[2], { choiceId: 'c' }, '2026-08-02T00:00:00.000Z');

  // k2 is unanswered; k3 belongs to auto_2 — only k1 is pending for auto_1.
  assert.deepEqual(pendingResolutionIds(resolved, 'auto_1'), [ids[0]]);

  var delivered = markResolutionsDelivered(resolved, pendingResolutionIds(resolved, 'auto_1'), '2026-08-03T00:00:00.000Z');
  assert.deepEqual(pendingResolutionIds(delivered, 'auto_1'), []);
  // auto_2's answer is untouched by auto_1's delivery.
  assert.deepEqual(pendingResolutionIds(delivered, 'auto_2'), [ids[2]]);
});
