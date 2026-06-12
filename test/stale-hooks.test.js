'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { shouldFlagStaleHooks } = require('../lib/stale-hooks.js');

const NOW = 1_000_000_000_000;

// A column that satisfies every condition for being flagged as stale.
function staleCol(overrides) {
  return Object.assign({
    createdAt: NOW - 120000, // older than default 60s grace
    hasUserInput: true,
    sessionId: 'sess-123',
    activityState: 'working',
    hookEverSeen: false,
  }, overrides || {});
}

const defaultOpts = { voiceEnabled: true, muted: false };

test('healthy column (hookEverSeen true) → false', () => {
  assert.equal(shouldFlagStaleHooks(staleCol({ hookEverSeen: true }), NOW, defaultOpts), false);
});

test('genuinely stale column → true', () => {
  assert.equal(shouldFlagStaleHooks(staleCol(), NOW, defaultOpts), true);
});

test('voice disabled → false', () => {
  assert.equal(shouldFlagStaleHooks(staleCol(), NOW, { voiceEnabled: false, muted: false }), false);
});

test('muted → false', () => {
  assert.equal(shouldFlagStaleHooks(staleCol(), NOW, { voiceEnabled: true, muted: true }), false);
});

test('no user input → false', () => {
  assert.equal(shouldFlagStaleHooks(staleCol({ hasUserInput: false }), NOW, defaultOpts), false);
});

test('no sessionId → false', () => {
  assert.equal(shouldFlagStaleHooks(staleCol({ sessionId: null }), NOW, defaultOpts), false);
});

test('exited column → false', () => {
  assert.equal(shouldFlagStaleHooks(staleCol({ activityState: 'exited' }), NOW, defaultOpts), false);
});

test('too young (age < minAgeMs) → false', () => {
  assert.equal(shouldFlagStaleHooks(staleCol({ createdAt: NOW - 1000 }), NOW, defaultOpts), false);
});

test('null col → false', () => {
  assert.equal(shouldFlagStaleHooks(null, NOW, defaultOpts), false);
});

test('respects a custom minAgeMs', () => {
  const col = staleCol({ createdAt: NOW - 5000 });
  // Default 60s grace would suppress, but a 2s minAge lets it through.
  assert.equal(shouldFlagStaleHooks(col, NOW, { voiceEnabled: true, muted: false, minAgeMs: 2000 }), true);
  // And a 10s minAge re-suppresses the same column.
  assert.equal(shouldFlagStaleHooks(col, NOW, { voiceEnabled: true, muted: false, minAgeMs: 10000 }), false);
});

test('missing createdAt → false', () => {
  assert.equal(shouldFlagStaleHooks(staleCol({ createdAt: 0 }), NOW, defaultOpts), false);
});
