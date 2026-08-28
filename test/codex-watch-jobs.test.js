// test/codex-watch-jobs.test.js
const test = require('node:test');
const assert = require('node:assert');
const { selectSessionJobs, summariseCounts, isActiveStatus } = require('../lib/codex-watch-jobs');

const NOW = Date.parse('2026-07-22T23:00:00.000Z');

const SCANS = [
  {
    workspaceKey: 'repo-a-1111111111111111',
    jobs: [
      { id: 'task-1', sessionId: 's1', title: 'Rescue', status: 'running', phase: 'exec', createdAt: '2026-07-22T22:50:00.000Z' },
      { id: 'task-2', sessionId: 's2', title: 'Other session', status: 'running', createdAt: '2026-07-22T22:55:00.000Z' }
    ]
  },
  {
    workspaceKey: 'repo-b-2222222222222222',
    jobs: [
      { id: 'task-3', sessionId: 's1', title: 'Review', status: 'completed', createdAt: '2026-07-22T22:40:00.000Z', completedAt: '2026-07-22T22:45:00.000Z' }
    ]
  }
];

test('keeps only the requested session, across every state dir', () => {
  const jobs = selectSessionJobs(SCANS, 's1', NOW);
  assert.deepStrictEqual(jobs.map((j) => j.id), ['task-1', 'task-3']);
  assert.strictEqual(jobs[0].workspaceKey, 'repo-a-1111111111111111');
});

test('orders active jobs before finished ones', () => {
  const jobs = selectSessionJobs(SCANS, 's1', NOW);
  assert.strictEqual(jobs[0].active, true);
  assert.strictEqual(jobs[1].active, false);
});

test('elapsed runs to now while active, and to completion when finished', () => {
  const jobs = selectSessionJobs(SCANS, 's1', NOW);
  assert.strictEqual(jobs[0].elapsedMs, 10 * 60 * 1000);
  assert.strictEqual(jobs[1].elapsedMs, 5 * 60 * 1000);
});

test('an unparseable createdAt yields null elapsed rather than NaN', () => {
  const jobs = selectSessionJobs(
    [{ workspaceKey: 'k', jobs: [{ id: 'x', sessionId: 's1', status: 'running', createdAt: 'nonsense' }] }],
    's1', NOW);
  assert.strictEqual(jobs[0].elapsedMs, null);
});

test('a missing or empty scan list is not an error', () => {
  assert.deepStrictEqual(selectSessionJobs([], 's1', NOW), []);
  assert.deepStrictEqual(selectSessionJobs(null, 's1', NOW), []);
  assert.deepStrictEqual(selectSessionJobs([{ workspaceKey: 'k' }], 's1', NOW), []);
});

test('no session id matches nothing', () => {
  assert.deepStrictEqual(selectSessionJobs(SCANS, null, NOW), []);
});

test('summariseCounts reports totals and active count', () => {
  const jobs = selectSessionJobs(SCANS, 's1', NOW);
  assert.deepStrictEqual(summariseCounts(jobs), { total: 2, running: 1 });
});

test('queued counts as active', () => {
  assert.strictEqual(isActiveStatus('queued'), true);
  assert.strictEqual(isActiveStatus('running'), true);
  assert.strictEqual(isActiveStatus('completed'), false);
});
