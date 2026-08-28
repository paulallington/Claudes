'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

function functionSource(name, nextName) {
  const start = renderer.indexOf(`function ${name}`);
  const end = renderer.indexOf(`function ${nextName}`, start);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return renderer.slice(start, end);
}

test('new managed and direct Codex columns are persisted after registration', () => {
  const source = functionSource('spawnCodexColumn', 'showColumnOverflowMenu');

  for (const [registration, result] of [
    ['addColumn(managedArgs, targetRow, columnOpts);', 'return { managed: true'],
    ['addColumn(directArgs, targetRow, columnOpts);', 'return { managed: false'],
  ]) {
    const registeredAt = source.indexOf(registration);
    const returnedAt = source.indexOf(result, registeredAt);
    const persistedAt = source.indexOf('persistSessions(', registeredAt);
    assert.notEqual(registeredAt, -1, `${registration} must remain present`);
    assert.ok(
      persistedAt > registeredAt && persistedAt < returnedAt,
      `${registration} must persist the newly registered column before returning`
    );
  }
});

test('Codex restart persists managed thread adoption and direct fallback clearing', () => {
  const source = functionSource('restartColumn', 'tryEndpointFailover');
  const managedAt = source.indexOf('col.codexThreadId = preparedThread.threadId;');
  const clearedAt = source.indexOf('col.codexThreadId = null;', managedAt);
  const claudeBranchAt = source.indexOf("sendMsg.args = buildResumeArgs(col);", clearedAt);
  const persistedAt = source.indexOf('persistSessions(col.projectKey, col.workspaceId);', clearedAt);

  assert.notEqual(managedAt, -1, 'managed restart must adopt the prepared thread');
  assert.notEqual(clearedAt, -1, 'direct fallback must clear stale thread intent');
  assert.ok(
    persistedAt > clearedAt && persistedAt < claudeBranchAt,
    'Codex restart must persist its final managed/direct thread state before continuing'
  );
});
