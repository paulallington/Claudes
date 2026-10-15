const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDuration,
  runStatusMarker,
  formatRunTime,
  buildRunListItems,
  pickDefaultRunKey,
  filterOutputLines,
} = require('../lib/automation-page-view');

test('formatDuration: empty for null or invalid input', () => {
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatDuration('abc'), '');
  assert.equal(formatDuration(NaN), '');
  assert.equal(formatDuration(-5), '');
});

test('formatDuration: seconds, minutes and hours', () => {
  assert.equal(formatDuration(0), '<1s');
  assert.equal(formatDuration(999), '<1s');
  assert.equal(formatDuration(12000), '12s');
  assert.equal(formatDuration((4 * 60 + 12) * 1000), '4m 12s');
  assert.equal(formatDuration(63 * 60 * 1000), '1h 3m');
});

test('runStatusMarker: maps the statuses main.js writes to glyph, class and plain label', () => {
  assert.deepEqual(runStatusMarker('completed'), { glyph: '✓', cls: 'run-ok', label: 'Succeeded' });
  assert.deepEqual(runStatusMarker('success'), { glyph: '✓', cls: 'run-ok', label: 'Succeeded' });
  assert.deepEqual(runStatusMarker('error'), { glyph: '✗', cls: 'run-error', label: 'Failed' });
  assert.deepEqual(runStatusMarker('escalated'), { glyph: '!', cls: 'run-attention', label: 'Needs you' });
  assert.deepEqual(runStatusMarker('running'), { glyph: '▶', cls: 'run-live', label: 'Running' });
  assert.deepEqual(runStatusMarker('interrupted'), { glyph: '■', cls: 'run-warn', label: 'Interrupted' });
  assert.deepEqual(runStatusMarker('cancelled'), { glyph: '■', cls: 'run-warn', label: 'Cancelled' });
  assert.deepEqual(runStatusMarker('skipped'), { glyph: '○', cls: 'run-skipped', label: 'Skipped' });
  assert.deepEqual(runStatusMarker('acted'), { glyph: '✓', cls: 'run-ok', label: 'Acted' });
  assert.deepEqual(runStatusMarker('resolved'), { glyph: '✓', cls: 'run-ok', label: 'Resolved' });
});

// 2026-10-15 is a Thursday. Local-time constructors keep these timezone-safe.
test('formatRunTime: today, yesterday, this week and older', () => {
  var now = new Date(2026, 9, 15, 14, 30);
  var at = function (y, m, d, h, min) { return new Date(y, m, d, h, min).toISOString(); };
  assert.equal(formatRunTime(at(2026, 9, 15, 7, 5), now), '07:05');
  assert.equal(formatRunTime(at(2026, 9, 14, 23, 59), now), 'Yesterday 23:59');
  assert.equal(formatRunTime(at(2026, 9, 12, 9, 0), now), 'Mon 09:00');
  assert.equal(formatRunTime(at(2026, 9, 9, 18, 45), now), 'Fri 18:45');
  assert.equal(formatRunTime(at(2026, 9, 8, 18, 45), now), '8 Oct 18:45');
  assert.equal(formatRunTime(at(2026, 9, 3, 9, 0), now), '3 Oct 09:00');
});

test('formatRunTime: accepts ms for now and tolerates bad input', () => {
  var now = new Date(2026, 9, 15, 14, 30).getTime();
  assert.equal(formatRunTime(new Date(2026, 9, 15, 0, 0).toISOString(), now), '00:00');
  assert.equal(formatRunTime(null, now), '');
  assert.equal(formatRunTime('not a date', now), '');
});

test('buildRunListItems: newest first, with labels, markers and keys', () => {
  var now = new Date(2026, 9, 15, 14, 30);
  var older = new Date(2026, 9, 14, 9, 0).toISOString();
  var newer = new Date(2026, 9, 15, 8, 0).toISOString();
  var items = buildRunListItems([
    { startedAt: older, durationMs: 252000, status: 'error', summary: 'Disk full' },
    { startedAt: newer, durationMs: 12000, status: 'completed', summary: 'All good' },
  ], { now: now });
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    key: newer, isLive: false, startedAt: newer, timeLabel: '08:00', durationLabel: '12s',
    marker: { glyph: '✓', cls: 'run-ok', label: 'Succeeded' }, summary: 'All good',
  });
  assert.equal(items[1].key, older);
  assert.equal(items[1].timeLabel, 'Yesterday 09:00');
  assert.equal(items[1].durationLabel, '4m 12s');
  assert.equal(items[1].marker.cls, 'run-error');
});

test('buildRunListItems: a live run is prepended with elapsed time', () => {
  var now = new Date(2026, 9, 15, 14, 30, 0);
  var liveStartedAt = new Date(2026, 9, 15, 14, 25, 30).toISOString();
  var items = buildRunListItems([{ startedAt: new Date(2026, 9, 15, 8, 0).toISOString(), status: 'completed' }],
    { liveStartedAt: liveStartedAt, now: now });
  assert.equal(items.length, 2);
  assert.equal(items[0].key, 'live');
  assert.equal(items[0].isLive, true);
  assert.equal(items[0].startedAt, liveStartedAt);
  assert.equal(items[0].timeLabel, 'Live');
  assert.equal(items[0].durationLabel, '4m 30s');
  assert.equal(items[0].marker.cls, 'run-live');
  assert.equal(items[1].isLive, false);
});

test('buildRunListItems: tolerates null history and missing fields', () => {
  assert.deepEqual(buildRunListItems(null, {}), []);
  assert.deepEqual(buildRunListItems(undefined), []);
  var items = buildRunListItems([{ status: 'completed' }, null], { now: new Date(2026, 9, 15) });
  assert.equal(items.length, 2);
  assert.equal(items[0].key, '0');
  assert.equal(items[0].timeLabel, '');
  assert.equal(items[0].durationLabel, '');
  assert.equal(items[0].summary, '');
  assert.equal(items[1].key, '1');
  assert.equal(items[1].marker.label, 'Unknown');
});

test('pickDefaultRunKey: live first, else newest, else null', () => {
  assert.equal(pickDefaultRunKey([{ key: 'live', isLive: true }, { key: 'a', isLive: false }]), 'live');
  assert.equal(pickDefaultRunKey([{ key: 'a', isLive: false }, { key: 'b', isLive: false }]), 'a');
  assert.equal(pickDefaultRunKey([]), null);
  assert.equal(pickDefaultRunKey(null), null);
});

test('filterOutputLines: counts case-insensitive matches', () => {
  assert.deepEqual(filterOutputLines('Error here\nanother ERROR\nfine', 'error'), { matchCount: 2 });
  assert.deepEqual(filterOutputLines('aaaa', 'aa'), { matchCount: 2 });
  assert.deepEqual(filterOutputLines('abc', 'x'), { matchCount: 0 });
  assert.deepEqual(filterOutputLines('abc', ''), { matchCount: 0 });
  assert.deepEqual(filterOutputLines(null, 'a'), { matchCount: 0 });
  assert.deepEqual(filterOutputLines('abc', null), { matchCount: 0 });
});

test('runStatusMarker: unknown or missing status falls back', () => {
  assert.deepEqual(runStatusMarker('weird'), { glyph: '•', cls: 'run-unknown', label: 'weird' });
  assert.deepEqual(runStatusMarker(null), { glyph: '•', cls: 'run-unknown', label: 'Unknown' });
  assert.deepEqual(runStatusMarker(undefined), { glyph: '•', cls: 'run-unknown', label: 'Unknown' });
});

const { buildAgentTabs, pickDefaultAgentKey, isNearBottom, splitMatches } = require('../lib/automation-page-view');

test('splitMatches: nothing to highlight without a query', () => {
  assert.deepEqual(splitMatches('abc', ''), { matchCount: 0, segments: null });
  assert.deepEqual(splitMatches('abc', null), { matchCount: 0, segments: null });
  assert.deepEqual(splitMatches(null, 'a'), { matchCount: 0, segments: null });
});

test('splitMatches: case-insensitive segments keep the original text', () => {
  assert.deepEqual(splitMatches('Error here, ERROR', 'error'), {
    matchCount: 2,
    segments: [
      { text: 'Error', match: true },
      { text: ' here, ', match: false },
      { text: 'ERROR', match: true },
    ],
  });
  assert.deepEqual(splitMatches('abc', 'x'), { matchCount: 0, segments: [{ text: 'abc', match: false }] });
});

test('splitMatches: the query is literal text, not a pattern', () => {
  const res = splitMatches('a.b axb a+b', 'a.b');
  assert.equal(res.matchCount, 1);
  assert.deepEqual(res.segments.filter((s) => s.match).map((s) => s.text), ['a.b']);
  assert.equal(splitMatches('1 (2) 3', '(2)').matchCount, 1);
});

test('splitMatches: very large output is only counted, not split', () => {
  const big = 'ab'.repeat(10);
  assert.deepEqual(splitMatches(big, 'ab', { maxChars: 10 }), { matchCount: 10, segments: null });
});

test('splitMatches: highlighting stops at maxMatches but the count stays whole', () => {
  assert.deepEqual(splitMatches('aaaa', 'a', { maxMatches: 2 }), {
    matchCount: 4,
    segments: [
      { text: 'a', match: true },
      { text: 'a', match: true },
      { text: 'aa', match: false },
    ],
  });
});

test('isNearBottom: follows the tail only when within the threshold of the end', () => {
  assert.equal(isNearBottom(960, 400, 1360), true);   // exactly at the end
  assert.equal(isNearBottom(920, 400, 1360), true);   // 40px short
  assert.equal(isNearBottom(919, 400, 1360), false);  // 41px short
  assert.equal(isNearBottom(0, 400, 300), true);      // content shorter than the pane
  assert.equal(isNearBottom(500, 400, 1360, 500), true);
  assert.equal(isNearBottom(undefined, 400, 1360), false);
});

function agent(id, extra) {
  return Object.assign({ id, name: 'Agent ' + id, currentRunStartedAt: null, lastRunAt: null, lastRunStatus: null }, extra);
}

test('buildAgentTabs: no tab strip for one agent without a manager', () => {
  assert.deepEqual(buildAgentTabs({ agents: [agent('a')] }), []);
  assert.deepEqual(buildAgentTabs({ agents: [agent('a')], manager: { enabled: false } }), []);
  assert.deepEqual(buildAgentTabs(null), []);
});

test('buildAgentTabs: one tab per agent, plus Manager when enabled', () => {
  const tabs = buildAgentTabs({
    agents: [agent('a'), agent('b', { currentRunStartedAt: '2026-10-15T10:00:00Z' }), agent('c', { lastRunStatus: 'error' })],
    manager: { enabled: true, lastRunStatus: 'resolved', needsHuman: false },
  });
  assert.deepEqual(tabs.map((t) => t.key), ['a', 'b', 'c', 'manager']);
  assert.deepEqual(tabs.map((t) => t.label), ['Agent a', 'Agent b', 'Agent c', 'Manager']);
  assert.deepEqual(tabs.map((t) => t.status), ['idle', 'running', 'error', 'idle']);
  assert.equal(tabs[3].isManager, true);
  assert.equal(tabs[0].isManager, false);
});

test('buildAgentTabs: a single agent with a manager still shows both tabs', () => {
  const tabs = buildAgentTabs({ agents: [agent('a')], manager: { enabled: true } });
  assert.deepEqual(tabs.map((t) => t.key), ['a', 'manager']);
});

test('buildAgentTabs: manager status is running, attention (needs a person) or error', () => {
  const base = { agents: [agent('a'), agent('b')] };
  assert.equal(buildAgentTabs({ ...base, manager: { enabled: true, lastRunStatus: 'running' } })[2].status, 'running');
  assert.equal(buildAgentTabs({ ...base, manager: { enabled: true, needsHuman: true, lastRunStatus: 'escalated' } })[2].status, 'attention');
  assert.equal(buildAgentTabs({ ...base, manager: { enabled: true, lastRunStatus: 'error' } })[2].status, 'error');
});

test('pickDefaultAgentKey: a running agent wins', () => {
  const a = { agents: [agent('a', { lastRunAt: '2026-10-15T09:00:00Z' }), agent('b', { currentRunStartedAt: '2026-10-15T08:00:00Z' })] };
  assert.equal(pickDefaultAgentKey(a), 'b');
});

test('pickDefaultAgentKey: otherwise the most recently run agent', () => {
  const a = { agents: [
    agent('a', { lastRunAt: '2026-10-14T09:00:00Z' }),
    agent('b', { lastRunAt: '2026-10-15T07:00:00Z' }),
    agent('c'),
  ] };
  assert.equal(pickDefaultAgentKey(a), 'b');
});

test('pickDefaultAgentKey: otherwise the first agent, or null with none', () => {
  assert.equal(pickDefaultAgentKey({ agents: [agent('a'), agent('b')] }), 'a');
  assert.equal(pickDefaultAgentKey({ agents: [] }), null);
  assert.equal(pickDefaultAgentKey(null), null);
});
