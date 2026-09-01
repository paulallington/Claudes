const test = require('node:test');
const assert = require('node:assert/strict');
const { fingerprintFinding, upsertFindings, acknowledgeFinding, acknowledgeAll, pruneFindings, listFindings } = require('../lib/findings-store');


test('upsertFindings collapses a recurring "N days" finding into one entry, bumping occurrences', () => {
  var store = { version: 1, findings: [] };
  var entry1 = {
    automationId: 'auto_1', automationName: 'Cert check', agentId: 'agent_1', agentName: 'Watcher',
    item: { summary: 'Certificate expiring in 12 days' },
    runStartedAt: '2026-08-01T00:00:00.000Z', sessionId: 'sess_1', cwd: '/proj', profileId: null,
  };
  var r1 = upsertFindings(store, [entry1], '2026-08-01T00:00:00.000Z');
  assert.equal(r1.store.findings.length, 1);
  assert.equal(r1.store.findings[0].occurrences, 1);
  assert.equal(r1.newFindings.length, 1);

  var entry2 = Object.assign({}, entry1, { item: { summary: 'Certificate expiring in 11 days' }, runStartedAt: '2026-08-02T00:00:00.000Z' });
  var r2 = upsertFindings(r1.store, [entry2], '2026-08-02T00:00:00.000Z');
  assert.equal(r2.store.findings.length, 1);
  assert.equal(r2.store.findings[0].occurrences, 2);
  assert.equal(r2.store.findings[0].summary, 'Certificate expiring in 11 days');
  assert.equal(r2.store.findings[0].firstSeenAt, '2026-08-01T00:00:00.000Z');
  assert.equal(r2.store.findings[0].lastSeenAt, '2026-08-02T00:00:00.000Z');
  assert.equal(r2.newFindings.length, 0);
});

test('digit folding is narrowed to time/quantity expressions: a countdown still collapses, but distinct ports do not', () => {
  // Countdown direction: "N days" folds to the same fingerprint regardless of N.
  var fpDays12 = fingerprintFinding('auto_1', 'agent_1', { summary: 'Certificate expiring in 12 days' });
  var fpDays11 = fingerprintFinding('auto_1', 'agent_1', { summary: 'Certificate expiring in 11 days' });
  assert.equal(fpDays12, fpDays11, 'a countdown in full-word days should still collapse to one fingerprint');

  // Abbreviated units fold the same way ("12d" / "5d"), but a 4+ digit token
  // directly touching a unit letter (no genuine time expression) must not.
  var fp12d = fingerprintFinding('auto_1', 'agent_1', { summary: 'Cache expires in 12d' });
  var fp5d = fingerprintFinding('auto_1', 'agent_1', { summary: 'Cache expires in 5d' });
  assert.equal(fp12d, fp5d, 'abbreviated day counts should still collapse to one fingerprint');

  // Distinct-outage direction: different port numbers must stay distinct —
  // this is the real bug: they used to fold to "port n is unreachable" and
  // silently swallow the second outage.
  var fpPort8080 = fingerprintFinding('auto_1', 'agent_1', { summary: 'Port 8080 is unreachable' });
  var fpPort9090 = fingerprintFinding('auto_1', 'agent_1', { summary: 'Port 9090 is unreachable' });
  assert.notEqual(fpPort8080, fpPort9090, 'different port numbers must produce distinct fingerprints');

  // A bare 4-digit token immediately followed by a unit letter (e.g. "8080s")
  // must not be mistaken for an abbreviated time expression.
  var fp8080s = fingerprintFinding('auto_1', 'agent_1', { summary: 'Saw error 8080s during rollout' });
  var fp9090s = fingerprintFinding('auto_1', 'agent_1', { summary: 'Saw error 9090s during rollout' });
  assert.notEqual(fp8080s, fp9090s, 'a bare 4+ digit token touching a unit letter must not fold');

  // Same class of bug: PR numbers must stay distinct.
  var fpPr1234 = fingerprintFinding('auto_1', 'agent_1', { summary: 'PR #1234 needs review' });
  var fpPr5678 = fingerprintFinding('auto_1', 'agent_1', { summary: 'PR #5678 needs review' });
  assert.notEqual(fpPr1234, fpPr5678, 'different PR numbers must produce distinct fingerprints');

  // An ISO date must still fold, unaffected by the narrowing.
  var fpIso1 = fingerprintFinding('auto_1', 'agent_1', { summary: 'Certificate expires on 2026-09-15' });
  var fpIso2 = fingerprintFinding('auto_1', 'agent_1', { summary: 'Certificate expires on 2026-10-20' });
  assert.equal(fpIso1, fpIso2, 'an ISO date should still fold to one fingerprint');
});

test('upsertFindings treats a second, different port outage as a genuinely new finding', () => {
  var r1 = upsertFindings({ version: 1, findings: [] }, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'Port 8080 is unreachable' } },
  ], '2026-08-01T00:00:00.000Z');
  assert.equal(r1.newFindings.length, 1);

  var r2 = upsertFindings(r1.store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'Port 9090 is unreachable' } },
  ], '2026-08-02T00:00:00.000Z');
  assert.equal(r2.store.findings.length, 2, 'both ports should be recorded as separate findings');
  assert.equal(r2.newFindings.length, 1, 'the second port outage must fire as a new finding, not a silent recurrence');
});

test('an explicit item.key wins over the summary hash, so two totally different summaries with the same key collapse', () => {
  var entryA = {
    automationId: 'auto_1', agentId: 'agent_1',
    item: { key: 'disk-full:/var', summary: 'Disk /var is 91% full' },
  };
  var entryB = {
    automationId: 'auto_1', agentId: 'agent_1',
    item: { key: 'disk-full:/var', summary: 'Disk /var is now completely full, immediate action required' },
  };
  var r1 = upsertFindings({ version: 1, findings: [] }, [entryA], '2026-08-01T00:00:00.000Z');
  var r2 = upsertFindings(r1.store, [entryB], '2026-08-02T00:00:00.000Z');
  assert.equal(r2.store.findings.length, 1);
  assert.equal(r2.store.findings[0].occurrences, 2);
  assert.equal(r2.store.findings[0].summary, 'Disk /var is now completely full, immediate action required');
  assert.equal(fingerprintFinding('auto_1', 'agent_1', entryA.item), fingerprintFinding('auto_1', 'agent_1', entryB.item));
});

test('acknowledgeFinding survives a later recurrence and the recurrence stays out of newFindings', () => {
  var entry = {
    automationId: 'auto_1', agentId: 'agent_1',
    item: { summary: 'Certificate expiring in 12 days' },
  };
  var r1 = upsertFindings({ version: 1, findings: [] }, [entry], '2026-08-01T00:00:00.000Z');
  var id = r1.store.findings[0].id;
  var acked = acknowledgeFinding(r1.store, id, '2026-08-01T12:00:00.000Z');
  assert.equal(acked.findings[0].acknowledgedAt, '2026-08-01T12:00:00.000Z');

  var entry2 = Object.assign({}, entry, { item: { summary: 'Certificate expiring in 11 days' } });
  var r2 = upsertFindings(acked, [entry2], '2026-08-02T00:00:00.000Z');
  assert.equal(r2.store.findings[0].acknowledgedAt, '2026-08-01T12:00:00.000Z');
  assert.equal(r2.store.findings[0].occurrences, 2);
  assert.equal(r2.newFindings.length, 0);
});

test('a genuinely different summary produces a distinct fingerprint and is not merged', () => {
  var r1 = upsertFindings({ version: 1, findings: [] }, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'Certificate expiring in 12 days' } },
  ], '2026-08-01T00:00:00.000Z');
  var r2 = upsertFindings(r1.store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'Disk usage is critically high' } },
  ], '2026-08-02T00:00:00.000Z');
  assert.equal(r2.store.findings.length, 2);
  assert.equal(r2.newFindings.length, 1);
});

test('pruneFindings drops acknowledged findings whose lastSeenAt is older than ackMaxAgeDays', () => {
  var r1 = upsertFindings({ version: 1, findings: [] }, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'Old resolved issue' } },
  ], '2026-01-01T00:00:00.000Z');
  var id = r1.store.findings[0].id;
  var acked = acknowledgeFinding(r1.store, id, '2026-01-01T00:00:00.000Z');
  var pruned = pruneFindings(acked, '2026-08-01T00:00:00.000Z', { ackMaxAgeDays: 30 });
  assert.equal(pruned.findings.length, 0);
});

test('pruneFindings enforces the per-automation cap by evicting the oldest-acknowledged finding first', () => {
  var store = { version: 1, findings: [] };
  var r = upsertFindings(store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'finding one' } },
  ], '2026-08-01T00:00:00.000Z');
  r = upsertFindings(r.store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'finding two' } },
  ], '2026-08-02T00:00:00.000Z');
  r = upsertFindings(r.store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'finding three' } },
  ], '2026-08-03T00:00:00.000Z');
  var oneId = r.store.findings.find(f => f.summary === 'finding one').id;
  var twoId = r.store.findings.find(f => f.summary === 'finding two').id;
  var acked = acknowledgeFinding(r.store, oneId, '2026-08-01T01:00:00.000Z');
  acked = acknowledgeFinding(acked, twoId, '2026-08-02T01:00:00.000Z');

  var pruned = pruneFindings(acked, '2026-08-04T00:00:00.000Z', { perAutomation: 2, ackMaxAgeDays: 3650 });
  assert.equal(pruned.findings.length, 2);
  assert.ok(!pruned.findings.some(f => f.summary === 'finding one'), 'oldest-acknowledged finding should be evicted first');
  assert.ok(pruned.findings.some(f => f.summary === 'finding two'));
  assert.ok(pruned.findings.some(f => f.summary === 'finding three'));
});

test('pruneFindings enforces the global cap across automations the same way as the per-automation cap', () => {
  var store = { version: 1, findings: [] };
  var r = upsertFindings(store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'finding one' } },
  ], '2026-08-01T00:00:00.000Z');
  r = upsertFindings(r.store, [
    { automationId: 'auto_2', agentId: 'agent_1', item: { summary: 'finding two' } },
  ], '2026-08-02T00:00:00.000Z');
  var oneId = r.store.findings.find(f => f.summary === 'finding one').id;
  var acked = acknowledgeFinding(r.store, oneId, '2026-08-01T01:00:00.000Z');

  var pruned = pruneFindings(acked, '2026-08-04T00:00:00.000Z', { perAutomation: 100, global: 1, ackMaxAgeDays: 3650 });
  assert.equal(pruned.findings.length, 1);
  assert.equal(pruned.findings[0].summary, 'finding two');
});

test('pruneFindings never evicts unacknowledged findings, even when they alone exceed the cap', () => {
  var store = { version: 1, findings: [] };
  var r = upsertFindings(store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'finding one' } },
  ], '2026-08-01T00:00:00.000Z');
  r = upsertFindings(r.store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'finding two' } },
  ], '2026-08-02T00:00:00.000Z');
  r = upsertFindings(r.store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'finding three' } },
  ], '2026-08-03T00:00:00.000Z');

  var pruned = pruneFindings(r.store, '2026-08-04T00:00:00.000Z', { perAutomation: 1, global: 1, ackMaxAgeDays: 3650 });
  assert.equal(pruned.findings.length, 3);
});

test('a missing, empty, or malformed store never throws and behaves like an empty store', () => {
  assert.doesNotThrow(() => upsertFindings(undefined, [], '2026-08-01T00:00:00.000Z'));
  assert.doesNotThrow(() => upsertFindings(null, [], '2026-08-01T00:00:00.000Z'));
  assert.doesNotThrow(() => upsertFindings({}, [], '2026-08-01T00:00:00.000Z'));
  assert.doesNotThrow(() => upsertFindings({ findings: 'not-an-array' }, [], '2026-08-01T00:00:00.000Z'));
  assert.doesNotThrow(() => acknowledgeFinding(undefined, 'fnd_x', '2026-08-01T00:00:00.000Z'));
  assert.doesNotThrow(() => pruneFindings(undefined, '2026-08-01T00:00:00.000Z', {}));
  assert.doesNotThrow(() => listFindings(undefined));

  var r = upsertFindings(null, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'first finding' } },
  ], '2026-08-01T00:00:00.000Z');
  assert.equal(r.store.findings.length, 1);
  assert.deepEqual(listFindings(malformed()), []);

  function malformed() { return { version: 1, findings: null }; }
});

test('listFindings returns findings sorted by lastSeenAt descending, optionally filtered to unacknowledged only', () => {
  var store = { version: 1, findings: [] };
  var r = upsertFindings(store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'older finding' } },
  ], '2026-08-01T00:00:00.000Z');
  r = upsertFindings(r.store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'newer finding' } },
  ], '2026-08-03T00:00:00.000Z');
  var olderId = r.store.findings.find(f => f.summary === 'older finding').id;

  var all = listFindings(r.store);
  assert.deepEqual(all.map(f => f.summary), ['newer finding', 'older finding']);

  var acked = acknowledgeFinding(r.store, olderId, '2026-08-01T01:00:00.000Z');
  var unacked = listFindings(acked, { unacknowledgedOnly: true });
  assert.deepEqual(unacked.map(f => f.summary), ['newer finding']);
});

test('acknowledgeAll acknowledges only the given automation when a filter is passed, and everything when filter is null', () => {
  var store = { version: 1, findings: [] };
  var r = upsertFindings(store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'finding a' } },
  ], '2026-08-01T00:00:00.000Z');
  r = upsertFindings(r.store, [
    { automationId: 'auto_2', agentId: 'agent_1', item: { summary: 'finding b' } },
  ], '2026-08-01T00:00:00.000Z');

  var scoped = acknowledgeAll(r.store, { automationId: 'auto_1' }, '2026-08-02T00:00:00.000Z');
  var a = scoped.findings.find(f => f.summary === 'finding a');
  var b = scoped.findings.find(f => f.summary === 'finding b');
  assert.equal(a.acknowledgedAt, '2026-08-02T00:00:00.000Z');
  assert.equal(b.acknowledgedAt, null);

  var all = acknowledgeAll(scoped, null, '2026-08-03T00:00:00.000Z');
  assert.ok(all.findings.every(f => f.acknowledgedAt));
  // already-acknowledged 'finding a' keeps its original acknowledgedAt
  assert.equal(all.findings.find(f => f.summary === 'finding a').acknowledgedAt, '2026-08-02T00:00:00.000Z');
});

test('upsertFindings never creates a finding from an empty or whitespace-only summary', () => {
  // Defends against callers that pass through malformed items (e.g. a
  // string-shaped attentionItems array coerced upstream, or a missing
  // summary field) without validating shape first — an empty summary must
  // never reach the store as a blank, unreadable inbox row.
  var store = { version: 1, findings: [] };
  var r = upsertFindings(store, [
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: '' } },
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: '   ' } },
    { automationId: 'auto_1', agentId: 'agent_1', item: {} },
    { automationId: 'auto_1', agentId: 'agent_1', item: { summary: 'a real finding' } },
  ], '2026-08-01T00:00:00.000Z');
  assert.equal(r.store.findings.length, 1);
  assert.equal(r.store.findings[0].summary, 'a real finding');
  assert.equal(r.newFindings.length, 1);
});
