const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDuration,
  runStatusMarker,
  formatRunTime,
  buildRunListItems,
  pickDefaultRunKey,
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

test('runStatusMarker: unknown or missing status falls back', () => {
  assert.deepEqual(runStatusMarker('weird'), { glyph: '•', cls: 'run-unknown', label: 'weird' });
  assert.deepEqual(runStatusMarker(null), { glyph: '•', cls: 'run-unknown', label: 'Unknown' });
  assert.deepEqual(runStatusMarker(undefined), { glyph: '•', cls: 'run-unknown', label: 'Unknown' });
});
