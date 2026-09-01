const test = require('node:test');
const assert = require('node:assert/strict');
const {
  groupFindingsByAutomation,
  formatFindingRelativeTime,
  occurrenceLabel,
  findingConversationAction,
  unacknowledgedBadgeCount,
} = require('../lib/findings-inbox-view');

test('groupFindingsByAutomation buckets findings under their automation, preserving input (newest-first) order', () => {
  var findings = [
    { id: 'f1', automationId: 'auto_1', automationName: 'Cert Watcher', lastSeenAt: '2026-08-03T00:00:00.000Z' },
    { id: 'f2', automationId: 'auto_2', automationName: 'Disk Watcher', lastSeenAt: '2026-08-02T00:00:00.000Z' },
    { id: 'f3', automationId: 'auto_1', automationName: 'Cert Watcher', lastSeenAt: '2026-08-01T00:00:00.000Z' },
  ];
  var groups = groupFindingsByAutomation(findings);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].automationId, 'auto_1');
  assert.equal(groups[0].automationName, 'Cert Watcher');
  assert.deepEqual(groups[0].findings.map(function (f) { return f.id; }), ['f1', 'f3']);
  assert.equal(groups[1].automationId, 'auto_2');
  assert.deepEqual(groups[1].findings.map(function (f) { return f.id; }), ['f2']);
});

test('formatFindingRelativeTime renders short relative units against an injected now', () => {
  var now = '2026-08-01T00:10:00.000Z';
  assert.equal(formatFindingRelativeTime('2026-08-01T00:09:30.000Z', now), '30s ago');
  assert.equal(formatFindingRelativeTime('2026-08-01T00:05:00.000Z', now), '5m ago');
  assert.equal(formatFindingRelativeTime('2026-07-31T22:10:00.000Z', now), '2h ago');
  assert.equal(formatFindingRelativeTime('2026-07-30T00:10:00.000Z', now), '2d ago');
  assert.equal(formatFindingRelativeTime(null, now), '');
});

test('occurrenceLabel stays quiet for a first sighting and reports count once recurring', () => {
  assert.equal(occurrenceLabel(1), null);
  assert.equal(occurrenceLabel(0), null);
  assert.equal(occurrenceLabel(2), 'Seen 2 times');
  assert.equal(occurrenceLabel(30), 'Seen 30 times');
});

test('findingConversationAction offers resume when a sessionId was recorded, else the discuss fallback', () => {
  assert.deepEqual(findingConversationAction({ sessionId: 'sess_1' }), { type: 'resume', label: 'Open conversation' });
  assert.deepEqual(findingConversationAction({ sessionId: null }), { type: 'discuss', label: 'Discuss finding' });
  assert.deepEqual(findingConversationAction({}), { type: 'discuss', label: 'Discuss finding' });
});

test('unacknowledgedBadgeCount counts only findings without an acknowledgedAt', () => {
  var findings = [
    { id: 'f1', acknowledgedAt: null },
    { id: 'f2', acknowledgedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'f3', acknowledgedAt: null },
  ];
  assert.equal(unacknowledgedBadgeCount(findings), 2);
  assert.equal(unacknowledgedBadgeCount([]), 0);
});
