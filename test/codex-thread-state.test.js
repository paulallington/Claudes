const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createThreadState,
  reduceThreadNotification
} = require('../lib/codex-thread-state');

test('reduces Codex notifications into the sanitized renderer state contract', () => {
  const threadId = '0198f064-8ec4-7a21-82db-0cc0f67c9612';
  let state = createThreadState(threadId);

  state = reduceThreadNotification(state, {
    method: 'thread/settings/updated',
    params: {
      threadId,
      threadSettings: {
        cwd: 'D:/secret/project',
        model: 'gpt-5.6-sol',
        effort: 'high',
        serviceTier: 'priority',
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['D:/secret/project'] }
      }
    }
  });
  state = reduceThreadNotification(state, {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId: 'turn-1',
      tokenUsage: {
        total: { totalTokens: 12000 },
        last: { totalTokens: 7500 },
        modelContextWindow: 10000
      }
    }
  });
  state = reduceThreadNotification(state, {
    method: 'thread/status/changed',
    params: { threadId, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }
  });
  state = reduceThreadNotification(state, {
    method: 'item/completed',
    emittedAtMs: 1720000000123,
    params: { threadId, item: { type: 'contextCompaction', id: 'item-1' } }
  });

  assert.deepStrictEqual(state, {
    threadId,
    status: 'needs-input',
    settings: {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      approvalPolicy: 'on-request',
      sandbox: 'workspaceWrite'
    },
    context: {
      usedTokens: 7500,
      modelContextWindow: 10000,
      percent: 75
    },
    compactedAt: 1720000000123
  });
  assert.strictEqual(JSON.stringify(state).includes('secret'), false);
  assert.strictEqual(JSON.stringify(state).includes('turn-1'), false);
});
