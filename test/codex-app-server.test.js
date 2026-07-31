const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const {
  REMOTE_TOKEN_ENV_NAME,
  buildAppServerArgs,
  CodexRpcClient,
  CodexAppServerService
} = require('../lib/codex-app-server');

test('app-server auth uses a loopback listener and passes only the token digest on argv', () => {
  const token = 'super-secret-capability';
  const args = buildAppServerArgs(4567, token);

  assert.deepStrictEqual(args, [
    'app-server',
    '--listen', 'ws://127.0.0.1:4567',
    '--ws-auth', 'capability-token',
    '--ws-token-sha256', crypto.createHash('sha256').update(token).digest('hex')
  ]);
  assert.strictEqual(args.join(' ').includes(token), false);

});

test('RPC client initializes once and correlates app-server responses', async () => {
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.sent = [];
    }
    send(raw) { this.sent.push(JSON.parse(raw)); }
  }

  const socket = new FakeSocket();
  const client = new CodexRpcClient(socket, { requestTimeoutMs: 100 });
  const initializing = client.initialize({ name: 'claudes', title: 'Claudes', version: '1.2.3' });

  assert.deepStrictEqual(socket.sent[0], {
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'claudes', title: 'Claudes', version: '1.2.3' },
      capabilities: { experimentalApi: false, requestAttestation: false }
    }
  });
  socket.emit('message', JSON.stringify({ id: 1, result: { userAgent: 'codex-cli' } }));
  await initializing;
  assert.deepStrictEqual(socket.sent[1], { method: 'initialized' });

  const pending = client.request('model/list', { includeHidden: false });
  assert.deepStrictEqual(socket.sent[2], { id: 2, method: 'model/list', params: { includeHidden: false } });
  socket.emit('message', JSON.stringify({ id: 2, result: { data: [], nextCursor: null } }));
  assert.deepStrictEqual(await pending, { data: [], nextCursor: null });
});

test('managed service prepares a resumable thread and publishes sanitized live state', async () => {
  const threadId = '0198f064-8ec4-7a21-82db-0cc0f67c9612';
  const token = 'a-main-owned-capability-token';
  const spawnCalls = [];
  const socketCalls = [];
  const stateEvents = [];

  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1;
      this.sent = [];
    }
    send(raw) {
      const msg = JSON.parse(raw);
      this.sent.push(msg);
      if (msg.method === 'initialize') this.emit('message', JSON.stringify({ id: msg.id, result: {} }));
      if (msg.method === 'model/list') {
        this.emit('message', JSON.stringify({ id: msg.id, result: {
          data: [{
            id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol',
            description: 'Frontier coding', hidden: false, isDefault: true,
            defaultReasoningEffort: 'high',
            supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Deep' }],
            serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Fast' }],
            defaultServiceTier: null,
            path: 'must-not-pass-through'
          }], nextCursor: null
        } }));
      }
      if (msg.method === 'thread/start') {
        this.emit('message', JSON.stringify({ id: msg.id, result: {
          thread: { id: threadId, status: { type: 'idle' }, cwd: msg.params.cwd, preview: 'private prompt' },
          model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'priority',
          approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [msg.params.cwd] }
        } }));
      }
      if (msg.method === 'thread/read') {
        this.emit('message', JSON.stringify({ id: msg.id, result: {
          thread: { id: threadId, cwd: 'D:/safe/project' }
        } }));
      }
      if (msg.method === 'thread/resume') {
        this.emit('message', JSON.stringify({ id: msg.id, result: {
          thread: { id: threadId, status: { type: 'idle' }, cwd: msg.params.cwd },
          model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'priority',
          approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' }
        } }));
      }
    }
    close() { this.emit('close'); }
  }

  const socket = new FakeSocket();
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false,
    kill() { this.killed = true; }
  });
  const service = new CodexAppServerService({
    command: 'codex.cmd',
    token,
    version: '1.9.63',
    platform: 'win32',
    allocatePort: async () => 4567,
    spawnProcess: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    },
    createSocket: (url, options) => {
      socketCalls.push({ url, options });
      return socket;
    },
    onState: (state) => stateEvents.push(state)
  });

  const catalog = await service.getCatalog();
  assert.deepStrictEqual(catalog, [{
    id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Frontier coding',
    isDefault: true, defaultReasoningEffort: 'high',
    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Deep' }],
    serviceTiers: [{ id: 'priority', name: 'Priority', description: 'Fast' }],
    defaultServiceTier: null
  }]);
  assert.strictEqual(spawnCalls[0].args.join(' ').includes(token), false);
  assert.strictEqual(spawnCalls[0].options.shell, true);
  assert.deepStrictEqual(socketCalls[0], {
    url: 'ws://127.0.0.1:4567',
    options: { headers: { Authorization: 'Bearer ' + token } }
  });

  const prepared = await service.prepareThread({ cwd: 'D:/safe/project' });
  assert.deepStrictEqual(prepared, {
    threadId,
    remoteUrl: 'ws://127.0.0.1:4567',
    remoteTokenEnvName: REMOTE_TOKEN_ENV_NAME
  });
  assert.deepStrictEqual(await service.prepareThread({ cwd: 'd:\\SAFE\\project', threadId }), prepared);
  socket.emit('message', JSON.stringify({
    method: 'thread/tokenUsage/updated',
    params: { threadId, tokenUsage: { last: { totalTokens: 2500 }, modelContextWindow: 10000 } }
  }));
  assert.deepStrictEqual(service.getThreadState(threadId).context, {
    usedTokens: 2500, modelContextWindow: 10000, percent: 25
  });
  assert.deepStrictEqual(stateEvents.at(-1), service.getThreadState(threadId));
  assert.strictEqual(JSON.stringify(stateEvents).includes('private prompt'), false);
  assert.strictEqual(JSON.stringify(stateEvents).includes('D:/safe/project'), false);

  service.stop();
  assert.strictEqual(child.killed, true);
});

test('resume refuses a thread owned by a different working directory', async () => {
  const threadId = '0198f064-8ec4-7a21-82db-0cc0f67c9612';
  const methods = [];
  class FakeSocket extends EventEmitter {
    constructor() { super(); this.readyState = 1; }
    send(raw) {
      const msg = JSON.parse(raw);
      methods.push(msg.method);
      if (msg.method === 'initialize') this.emit('message', JSON.stringify({ id: msg.id, result: {} }));
      if (msg.method === 'thread/read') {
        this.emit('message', JSON.stringify({
          id: msg.id,
          result: { thread: { id: threadId, cwd: 'D:/someone-elses-project' } }
        }));
      }
      if (msg.method === 'thread/resume') {
        this.emit('message', JSON.stringify({ id: msg.id, result: {
          thread: { id: threadId, cwd: msg.params.cwd, status: { type: 'idle' } },
          model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: null,
          approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' }
        } }));
      }
    }
    close() { this.emit('close'); }
  }
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false,
    kill() { this.killed = true; }
  });
  const service = new CodexAppServerService({
    token: 'a-main-owned-capability-token', platform: 'win32',
    allocatePort: async () => 4567,
    spawnProcess: () => child,
    createSocket: () => new FakeSocket()
  });

  await assert.rejects(
    service.prepareThread({ cwd: 'D:/safe/project', threadId }),
    /working directory/i
  );
  assert.strictEqual(methods.includes('thread/resume'), false);
  service.stop();
});

test('unexpected app-server exit disables the bridge instead of changing its endpoint', async () => {
  let spawnCount = 0;
  let unavailableCount = 0;
  class FakeSocket extends EventEmitter {
    constructor() { super(); this.readyState = 1; }
    send(raw) {
      const msg = JSON.parse(raw);
      if (msg.method === 'initialize') this.emit('message', JSON.stringify({ id: msg.id, result: {} }));
      if (msg.method === 'model/list') this.emit('message', JSON.stringify({ id: msg.id, result: { data: [], nextCursor: null } }));
    }
    close() { this.emit('close'); }
  }
  let child;
  const service = new CodexAppServerService({
    token: 'a-main-owned-capability-token',
    allocatePort: async () => 4567 + spawnCount,
    spawnProcess: () => {
      spawnCount++;
      child = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; } });
      return child;
    },
    createSocket: () => new FakeSocket(),
    onUnavailable: () => { unavailableCount++; }
  });

  await service.getCatalog();
  child.emit('exit', 1);
  await assert.rejects(service.getCatalog(), /unavailable/i);
  assert.strictEqual(spawnCount, 1);
  assert.strictEqual(unavailableCount, 1);
});

test('stopping during asynchronous startup prevents a late app-server child spawn', async () => {
  let releasePort;
  let spawnCount = 0;
  const service = new CodexAppServerService({
    token: 'a-main-owned-capability-token',
    allocatePort: () => new Promise((resolve) => { releasePort = resolve; }),
    spawnProcess: () => { spawnCount++; return new EventEmitter(); },
    createSocket: () => new EventEmitter()
  });
  const pending = service.ensureStarted();
  service.stop();
  releasePort(4567);
  await assert.rejects(pending, /stopp/i);
  assert.equal(spawnCount, 0);
});

test('Windows service shutdown terminates only the owned app-server process tree', () => {
  const calls = [];
  let directKillCount = 0;
  const child = {
    pid: 4321,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill() { directKillCount++; }
  };
  const service = new CodexAppServerService({
    token: 'a-main-owned-capability-token',
    platform: 'win32',
    spawnProcess: () => child,
    createSocket: () => new EventEmitter(),
    execFileSync: (file, args, options) => {
      calls.push({ file, args, options });
    }
  });

  service.child = child;
  service.stop();

  assert.deepStrictEqual(calls, [{
    file: 'taskkill.exe',
    args: ['/PID', '4321', '/T', '/F'],
    options: { windowsHide: true, stdio: 'ignore' }
  }]);
  assert.equal(directKillCount, 0);
});
