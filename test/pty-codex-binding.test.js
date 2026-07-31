'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function loadBindingSandbox() {
  class FakeProcess extends EventEmitter {}
  const fakeProcess = new FakeProcess();
  fakeProcess.env = {};
  fakeProcess.platform = 'linux';
  fakeProcess.arch = 'x64';
  fakeProcess.pid = 1;
  fakeProcess.cwd = () => '/repo';
  fakeProcess.exit = () => {};
  fakeProcess.stdin = new EventEmitter();
  fakeProcess.stdin.setEncoding = () => {};

  class FakeWebSocketServer extends EventEmitter {
    address() { return { port: 3456 }; }
    close() {}
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'pty-server.js'), 'utf8');
  const sandbox = {
    Buffer,
    Date,
    JSON,
    Map,
    Set,
    console: { log() {}, error() {}, warn() {} },
    process: fakeProcess,
    __dirname: path.join(__dirname, '..'),
    setTimeout: () => ({ unref() {} }),
    clearTimeout() {},
    require(id) {
      if (id === 'ws') return { WebSocketServer: FakeWebSocketServer };
      if (id === 'node-pty') return {};
      if (id === 'path') return path;
      if (id === 'os') return { homedir: () => '/home/test' };
      if (id === 'fs') {
        return {
          mkdirSync() { throw new Error('disabled in test'); },
          statSync() { throw new Error('not found'); },
          appendFileSync() {},
          readFileSync() { throw new Error('not found'); },
          chmodSync() {},
          writeFileSync() {}
        };
      }
      if (id === 'child_process') return { execFile() {}, execFileSync() { throw new Error('not found'); } };
      throw new Error('unexpected require: ' + id);
    }
  };
  sandbox.testStdin = fakeProcess.stdin;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  vm.runInContext("codexBridgeConfig = { remoteUrl: 'ws://127.0.0.1:4567', token: 'raw-bearer-secret' }", sandbox);
  return sandbox;
}

test('PTY accepts the canonical fresh remote TUI shape without exposing its private claim in argv', () => {
  const sandbox = loadBindingSandbox();
  const binding = vm.runInContext(`codexBindingFromArgs('codex', [
    '-a', 'on-request', '-s', 'workspace-write',
    '--model', 'gpt-5.6-sol',
    '-c', 'model_reasoning_effort=ultra',
    '-c', 'service_tier=priority',
    '-C', '/repo',
    '--remote', 'ws://127.0.0.1:4567',
    '--remote-auth-token-env', 'CLAUDES_CODEX_BRIDGE_TOKEN',
    'hello'
  ])`, sandbox);
  assert.deepEqual({ ...binding }, { mode: 'fresh', cwd: '/repo', remoteUrl: 'ws://127.0.0.1:4567' });
});

test('PTY preserves the exact canonical resume shape and thread UUID binding', () => {
  const sandbox = loadBindingSandbox();
  const binding = vm.runInContext(`codexBindingFromArgs('codex', [
    'resume', '-a', 'on-request', '-s', 'workspace-write',
    '--remote', 'ws://127.0.0.1:4567',
    '--remote-auth-token-env', 'CLAUDES_CODEX_BRIDGE_TOKEN',
    '123e4567-e89b-42d3-a456-426614174000'
  ])`, sandbox);
  assert.deepEqual({ ...binding }, {
    mode: 'resume',
    threadId: '123e4567-e89b-42d3-a456-426614174000',
    remoteUrl: 'ws://127.0.0.1:4567'
  });
});

test('PTY accepts legal shell-active path characters because managed Windows spawns bypass cmd.exe', () => {
  const sandbox = loadBindingSandbox();
  const binding = vm.runInContext(`codexBindingFromArgs('codex', [
    '-C', "/repo/(100%)!'", '--remote', 'ws://127.0.0.1:4567',
    '--remote-auth-token-env', 'CLAUDES_CODEX_BRIDGE_TOKEN'
  ])`, sandbox);
  assert.deepEqual({ ...binding }, { mode: 'fresh', cwd: "/repo/(100%)!'", remoteUrl: 'ws://127.0.0.1:4567' });
  const source = fs.readFileSync(path.join(__dirname, '..', 'pty-server.js'), 'utf8');
  assert.match(source, /authorizedManagedCodex[\s\S]*resolveCodexNodeEntrypoint[\s\S]*process\.execPath/);
});

test('PTY rejects fresh subcommands, UUID positionals, malformed resumes, and unsafe semantic argv', () => {
  const sandbox = loadBindingSandbox();
  const rejected = vm.runInContext(`[
    codexBindingFromArgs('codex', ['exec', '--remote', 'ws://127.0.0.1:4567', '--remote-auth-token-env', 'CLAUDES_CODEX_BRIDGE_TOKEN']),
    codexBindingFromArgs('codex', ['--remote', 'ws://127.0.0.1:4567', '--remote-auth-token-env', 'CLAUDES_CODEX_BRIDGE_TOKEN', '123e4567-e89b-42d3-a456-426614174000']),
    codexBindingFromArgs('codex', ['resume', '--remote', 'ws://127.0.0.1:4567', '--remote-auth-token-env', 'CLAUDES_CODEX_BRIDGE_TOKEN']),
    codexBindingFromArgs('codex', ['resume', 'resume', '--remote', 'ws://127.0.0.1:4567', '--remote-auth-token-env', 'CLAUDES_CODEX_BRIDGE_TOKEN', '123e4567-e89b-42d3-a456-426614174000']),
    codexBindingFromArgs('codex', ['--dangerously-bypass-approvals-and-sandbox', '--evil', '--remote', 'ws://127.0.0.1:4567', '--remote-auth-token-env', 'CLAUDES_CODEX_BRIDGE_TOKEN']),
    codexBindingFromArgs('codex', ['--remote', 'ws://127.0.0.1:4567', '--remote-auth-token-env', 'CLAUDES_CODEX_BRIDGE_TOKEN', 'exec']),
    codexBindingFromArgs('codex', ['--remote', 'ws://127.0.0.1:4567', '--remote-auth-token-env', 'CLAUDES_CODEX_BRIDGE_TOKEN', 'hello & whoami'])
  ]`, sandbox);
  assert.deepEqual(Array.from(rejected), [null, null, null, null, null, null, null]);
});

test('PTY injects the bearer once only for a mode/cwd/endpoint-bound private authorization', () => {
  const sandbox = loadBindingSandbox();
  const freshArgs = "['-C', '/repo', '--remote', 'ws://127.0.0.1:4567', '--remote-auth-token-env', 'CLAUDES_CODEX_BRIDGE_TOKEN']";
  vm.runInContext(`codexSpawnTickets.set('ticket', {
    mode: 'fresh', claimId: '0123456789abcdef0123456789abcdef', cwd: '/repo',
    remoteUrl: 'ws://127.0.0.1:4567', expiresAt: Date.now() + 5000
  })`, sandbox);
  assert.equal(vm.runInContext(`codexBridgeEnvForSpawn('codex', ${freshArgs}, '/repo', 'ticket').CLAUDES_CODEX_BRIDGE_TOKEN`, sandbox), 'raw-bearer-secret');
  assert.deepEqual({ ...vm.runInContext(`codexBridgeEnvForSpawn('codex', ${freshArgs}, '/repo', 'ticket')`, sandbox) }, {});

  vm.runInContext(`codexSpawnTickets.set('cross-mode', {
    mode: 'resume', threadId: '123e4567-e89b-42d3-a456-426614174000', cwd: '/repo',
    remoteUrl: 'ws://127.0.0.1:4567', expiresAt: Date.now() + 5000
  })`, sandbox);
  assert.deepEqual({ ...vm.runInContext(`codexBridgeEnvForSpawn('codex', ${freshArgs}, '/repo', 'cross-mode')`, sandbox) }, {});
  assert.equal(vm.runInContext("codexSpawnTickets.has('cross-mode')", sandbox), false);

  vm.runInContext(`codexSpawnTickets.set('wrong-cwd', {
    mode: 'fresh', claimId: '0123456789abcdef0123456789abcdef', cwd: '/repo',
    remoteUrl: 'ws://127.0.0.1:4567', expiresAt: Date.now() + 5000
  })`, sandbox);
  assert.deepEqual({ ...vm.runInContext(`codexBridgeEnvForSpawn('codex', ${freshArgs}, '/other', 'wrong-cwd')`, sandbox) }, {});

  vm.runInContext(`codexSpawnTickets.set('wrong-url', {
    mode: 'fresh', claimId: '0123456789abcdef0123456789abcdef', cwd: '/repo',
    remoteUrl: 'ws://127.0.0.1:9999', expiresAt: Date.now() + 5000
  })`, sandbox);
  assert.deepEqual({ ...vm.runInContext(`codexBridgeEnvForSpawn('codex', ${freshArgs}, '/repo', 'wrong-url')`, sandbox) }, {});
});

test('PTY private control accepts only exact fresh claim or resume thread authorization shapes', () => {
  const sandbox = loadBindingSandbox();
  const ticket = 'a'.repeat(64);
  sandbox.testStdin.emit('data', JSON.stringify({
    requestId: 'fresh-ok',
    type: 'codex-spawn-authorize',
    ticket,
    mode: 'fresh',
    claimId: '0123456789abcdef0123456789abcdef',
    cwd: '/repo',
    remoteUrl: 'ws://127.0.0.1:4567',
    expiresAt: Date.now() + 5000
  }) + '\n');
  assert.deepEqual(JSON.parse(vm.runInContext(`JSON.stringify(codexSpawnTickets.get('${ticket}'))`, sandbox)), {
    mode: 'fresh',
    claimId: '0123456789abcdef0123456789abcdef',
    cwd: '/repo',
    remoteUrl: 'ws://127.0.0.1:4567',
    expiresAt: vm.runInContext(`codexSpawnTickets.get('${ticket}').expiresAt`, sandbox)
  });

  const rejectedTicket = 'b'.repeat(64);
  sandbox.testStdin.emit('data', JSON.stringify({
    requestId: 'cross-mode',
    type: 'codex-spawn-authorize',
    ticket: rejectedTicket,
    mode: 'fresh',
    claimId: '0123456789abcdef0123456789abcdef',
    threadId: '123e4567-e89b-42d3-a456-426614174000',
    cwd: '/repo',
    remoteUrl: 'ws://127.0.0.1:4567',
    expiresAt: Date.now() + 5000
  }) + '\n');
  assert.equal(vm.runInContext(`codexSpawnTickets.has('${rejectedTicket}')`, sandbox), false);
});
