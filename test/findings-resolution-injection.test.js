const test = require('node:test');
const assert = require('node:assert/strict');
const { upsertFindings, resolveFinding } = require('../lib/findings-store');
const { buildResolutionsBlock } = require('../lib/findings-resolution-injection');

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
