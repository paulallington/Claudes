const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const {
  REMOTE_TOKEN_ENV_NAME,
  buildAppServerArgs,
  codexBridgeEnvForSpawn,
  CodexRpcClient
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
      capabilities: { experimentalApi: true, requestAttestation: false }
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
