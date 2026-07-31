const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const {
  REMOTE_TOKEN_ENV_NAME,
  buildAppServerArgs,
  codexBridgeEnvForSpawn,
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

  const resumeArgs = [
    'resume', '--remote', 'ws://127.0.0.1:4567',
    '--remote-auth-token-env', REMOTE_TOKEN_ENV_NAME,
    '0198f064-8ec4-7a21-82db-0cc0f67c9612'
  ];
  assert.deepStrictEqual(codexBridgeEnvForSpawn('codex', resumeArgs, token), {
    [REMOTE_TOKEN_ENV_NAME]: token
  });
  assert.deepStrictEqual(codexBridgeEnvForSpawn('node', resumeArgs, token), {});
  assert.deepStrictEqual(codexBridgeEnvForSpawn('codex', resumeArgs.map((v) => v === 'ws://127.0.0.1:4567' ? 'ws://192.168.1.4:4567' : v), token), {});
  assert.deepStrictEqual(codexBridgeEnvForSpawn('codex', resumeArgs.map((v) => v === REMOTE_TOKEN_ENV_NAME ? 'PATH' : v), token), {});
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
