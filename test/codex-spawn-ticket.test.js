'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSpawnTicketStore } = require('../lib/codex-spawn-ticket');

const THREAD = '123e4567-e89b-42d3-a456-426614174000';
const URL = 'ws://127.0.0.1:4567';

function fixture() {
  let now = 1000;
  let sequence = 0;
  const store = createSpawnTicketStore({
    now: () => now,
    ttlMs: 5000,
    randomBytes: () => Buffer.from(String(++sequence).padStart(32, '0'))
  });
  store.configure(URL, 'raw-bearer-secret');
  return { store, advance: (ms) => { now += ms; } };
}

test('spawn ticket is single-use and yields the bearer only for an exact match', () => {
  const { store } = fixture();
  const issued = store.issue({ threadId: THREAD, cwd: 'D:\\Repo', remoteUrl: URL }, 'win32');
  assert.ok(issued.ticket);
  assert.equal(store.consume({ ticket: issued.ticket, threadId: THREAD, cwd: 'd:/repo', remoteUrl: URL }, 'win32'), 'raw-bearer-secret');
  assert.equal(store.consume({ ticket: issued.ticket, threadId: THREAD, cwd: 'D:/Repo', remoteUrl: URL }, 'win32'), null);
});

test('missing, unknown, mismatched, and replayed tickets fail closed', () => {
  const mismatches = [
    { threadId: '223e4567-e89b-42d3-a456-426614174000', cwd: 'D:/Repo', remoteUrl: URL },
    { threadId: THREAD, cwd: 'D:/Other', remoteUrl: URL },
    { threadId: THREAD, cwd: 'D:/Repo', remoteUrl: 'ws://127.0.0.1:9999' }
  ];
  for (const mismatch of mismatches) {
    const { store } = fixture();
    const issued = store.issue({ threadId: THREAD, cwd: 'D:/Repo', remoteUrl: URL }, 'win32');
    assert.equal(store.consume({ ticket: issued.ticket, ...mismatch }, 'win32'), null);
    assert.equal(store.consume({ ticket: issued.ticket, threadId: THREAD, cwd: 'D:/Repo', remoteUrl: URL }, 'win32'), null);
  }
  const { store } = fixture();
  assert.equal(store.consume({ ticket: '', threadId: THREAD, cwd: 'D:/Repo', remoteUrl: URL }, 'win32'), null);
  assert.equal(store.consume({ ticket: 'unknown', threadId: THREAD, cwd: 'D:/Repo', remoteUrl: URL }, 'win32'), null);
});

test('expired tickets and invalid issue coordinates fail closed', () => {
  const { store, advance } = fixture();
  const issued = store.issue({ threadId: THREAD, cwd: '/repo', remoteUrl: URL }, 'linux');
  advance(5001);
  assert.equal(store.consume({ ticket: issued.ticket, threadId: THREAD, cwd: '/repo', remoteUrl: URL }, 'linux'), null);
  assert.throws(() => store.issue({ threadId: 'bad', cwd: '/repo', remoteUrl: URL }, 'linux'));
  assert.throws(() => store.issue({ threadId: THREAD, cwd: '', remoteUrl: URL }, 'linux'));
  assert.throws(() => store.issue({ threadId: THREAD, cwd: '/repo', remoteUrl: 'ws://evil.test' }, 'linux'));
});

test('reconfiguration revokes outstanding tickets and no public value contains the bearer', () => {
  const { store } = fixture();
  const issued = store.issue({ threadId: THREAD, cwd: '/repo', remoteUrl: URL }, 'linux');
  assert.equal(JSON.stringify(issued).includes('raw-bearer-secret'), false);
  store.configure('ws://127.0.0.1:8888', 'replacement-secret');
  assert.equal(store.consume({ ticket: issued.ticket, threadId: THREAD, cwd: '/repo', remoteUrl: URL }, 'linux'), null);
});

test('issuer can discard its redundant local ticket copy after sidecar acknowledgement', () => {
  const { store } = fixture();
  const issued = store.issue({ threadId: THREAD, cwd: '/repo', remoteUrl: URL }, 'linux');
  assert.equal(store.discard(issued.ticket), true);
  assert.equal(store.discard(issued.ticket), false);
  assert.equal(store.consume({ ticket: issued.ticket, threadId: THREAD, cwd: '/repo', remoteUrl: URL }, 'linux'), null);
});

test('renderer and preload contain no raw bridge bearer or persisted spawn-ticket field', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.equal(renderer.includes('CODEX_BRIDGE_TOKEN'), false);
  assert.equal(preload.includes('CODEX_BRIDGE_TOKEN'), false);
  assert.equal(/codexPersistShape\([^)]*spawnTicket/.test(renderer), false);
  assert.equal(/codexThreadId:[^\n]*spawnTicket/.test(renderer), false);
});
