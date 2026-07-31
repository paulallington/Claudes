'use strict';

const crypto = require('crypto');
const net = require('net');
const {
  isUuid,
  createThreadState,
  reduceThreadNotification
} = require('./codex-thread-state');

const REMOTE_TOKEN_ENV_NAME = 'CLAUDES_CODEX_BRIDGE_TOKEN';
const LOOPBACK_REMOTE_RE = /^ws:\/\/127\.0\.0\.1:(\d{1,5})\/?$/;

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function buildAppServerArgs(port, token) {
  if (!validPort(port)) throw new Error('invalid Codex app-server port');
  if (typeof token !== 'string' || token.length < 16) throw new Error('invalid Codex app-server token');
  return [
    'app-server',
    '--listen', 'ws://127.0.0.1:' + port,
    '--ws-auth', 'capability-token',
    '--ws-token-sha256', crypto.createHash('sha256').update(token).digest('hex')
  ];
}

function codexBridgeEnvForSpawn(cmd, args, token, expectedRemoteUrl) {
  if (cmd !== 'codex' || !Array.isArray(args) || typeof token !== 'string' || !token) return {};
  if (typeof expectedRemoteUrl !== 'string' || !LOOPBACK_REMOTE_RE.test(expectedRemoteUrl)) return {};
  if (args.filter((value) => value === 'resume').length !== 1) return {};
  if (args.filter((value) => value === '--remote').length !== 1) return {};
  if (args.filter((value) => value === '--remote-auth-token-env').length !== 1) return {};
  var resumeIdx = args.indexOf('resume');
  var remoteIdx = args.indexOf('--remote');
  var envIdx = args.indexOf('--remote-auth-token-env');
  if (remoteIdx <= resumeIdx || envIdx <= resumeIdx) return {};
  if (args[remoteIdx + 1] !== expectedRemoteUrl) return {};
  if (args[envIdx + 1] !== REMOTE_TOKEN_ENV_NAME) return {};
  if (!args.slice(resumeIdx + 1).some((value) => isUuid(value))) return {};
  return { [REMOTE_TOKEN_ENV_NAME]: token };
}

class CodexRpcClient {
  constructor(socket, options) {
    options = options || {};
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.requestTimeoutMs = options.requestTimeoutMs || 15000;
    this.onNotification = typeof options.onNotification === 'function' ? options.onNotification : function () {};
    this.initializePromise = null;
    socket.on('message', (raw) => this.handleMessage(raw));
    socket.on('close', () => this.rejectAll(new Error('Codex app-server connection closed')));
    socket.on('error', () => { /* close or request timeout carries the user-facing failure */ });
  }

  handleMessage(raw) {
    var message;
    try {
      var value = raw && raw.data !== undefined ? raw.data : raw;
      message = JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
    } catch {
      return;
    }
    if (message && message.id !== undefined && this.pending.has(message.id)) {
      var entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        var detail = typeof message.error.message === 'string' ? message.error.message : 'Codex app-server request failed';
        entry.reject(new Error(detail));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message && typeof message.method === 'string') this.onNotification(message);
  }

  rejectAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  request(method, params) {
    var id = this.nextId++;
    return new Promise((resolve, reject) => {
      var timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex app-server request timed out'));
      }, this.requestTimeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      this.send({ id: id, method: method, params: params });
    });
  }

  notify(method) {
    this.send({ method: method });
  }

  initialize(clientInfo) {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.request('initialize', {
      clientInfo: clientInfo,
      capabilities: { experimentalApi: false, requestAttestation: false }
    }).then((result) => {
      this.notify('initialized');
      return result;
    });
    return this.initializePromise;
  }
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    var server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      var address = server.address();
      server.close((err) => err ? reject(err) : resolve(address.port));
    });
  });
}

function waitForSocketOpen(socket, timeoutMs) {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    var settled = false;
    var timer = setTimeout(() => finish(new Error('Codex app-server connection timed out')), timeoutMs);
    if (timer.unref) timer.unref();
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('open', onOpen);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }
    function finish(error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    }
    function onOpen() { finish(); }
    function onError(error) { finish(error || new Error('Codex app-server connection failed')); }
    function onClose() { finish(new Error('Codex app-server connection closed during startup')); }
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    var timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

function sanitizeText(value, max) {
  return typeof value === 'string' && value.length <= max ? value : '';
}

function sanitizeCatalogModel(model) {
  if (!model || model.hidden === true) return null;
  var id = sanitizeText(model.model || model.id, 120);
  if (!id) return null;
  var efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((option) => ({
        reasoningEffort: sanitizeText(option && option.reasoningEffort, 40),
        description: sanitizeText(option && option.description, 500)
      })).filter((option) => option.reasoningEffort)
    : [];
  var tiers = Array.isArray(model.serviceTiers)
    ? model.serviceTiers.map((tier) => ({
        id: sanitizeText(tier && tier.id, 80),
        name: sanitizeText(tier && tier.name, 120),
        description: sanitizeText(tier && tier.description, 500)
      })).filter((tier) => tier.id)
    : [];
  return {
    id: id,
    displayName: sanitizeText(model.displayName, 160) || id,
    description: sanitizeText(model.description, 1000),
    isDefault: model.isDefault === true,
    defaultReasoningEffort: sanitizeText(model.defaultReasoningEffort, 40) || null,
    supportedReasoningEfforts: efforts,
    serviceTiers: tiers,
    defaultServiceTier: sanitizeText(model.defaultServiceTier, 80) || null
  };
}

class CodexAppServerService {
  constructor(options) {
    options = options || {};
    this.command = options.command || 'codex';
    this.token = options.token;
    this.version = options.version || '0.0.0';
    this.platform = options.platform || process.platform;
    this.allocatePort = options.allocatePort || allocateLoopbackPort;
    this.spawnProcess = options.spawnProcess;
    this.createSocket = options.createSocket;
    this.onState = typeof options.onState === 'function' ? options.onState : function () {};
    this.connectTimeoutMs = options.connectTimeoutMs || 5000;
    this.retryDelayMs = options.retryDelayMs || 100;
    this.requestTimeoutMs = options.requestTimeoutMs || 15000;
    this.child = null;
    this.socket = null;
    this.client = null;
    this.remoteUrl = null;
    this.startPromise = null;
    this.threadStates = new Map();
    if (typeof this.spawnProcess !== 'function') throw new Error('spawnProcess is required');
    if (typeof this.createSocket !== 'function') throw new Error('createSocket is required');
    if (typeof this.token !== 'string' || this.token.length < 16) throw new Error('invalid Codex app-server token');
  }

  async ensureStarted() {
    if (this.client) return this.client;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().catch((error) => {
      this.stop();
      throw error;
    }).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async start() {
    var port = await this.allocatePort();
    this.remoteUrl = 'ws://127.0.0.1:' + port;
    this.child = this.spawnProcess(this.command, buildAppServerArgs(port, this.token), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: this.platform === 'win32'
    });
    if (!this.child || typeof this.child.on !== 'function') throw new Error('Codex app-server failed to spawn');
    this.child.once('exit', () => {
      if (this.child) {
        this.child = null;
        this.client = null;
        this.socket = null;
      }
    });

    var deadline = Date.now() + this.connectTimeoutMs;
    var lastError = null;
    while (Date.now() < deadline) {
      var socket = this.createSocket(this.remoteUrl, {
        headers: { Authorization: 'Bearer ' + this.token }
      });
      try {
        await waitForSocketOpen(socket, Math.max(1, deadline - Date.now()));
        this.socket = socket;
        this.client = new CodexRpcClient(socket, {
          requestTimeoutMs: this.requestTimeoutMs,
          onNotification: (message) => this.handleNotification(message)
        });
        await this.client.initialize({ name: 'claudes', title: 'Claudes', version: this.version });
        return this.client;
      } catch (error) {
        lastError = error;
        try { socket.close(); } catch { /* already closed */ }
        if (Date.now() < deadline) await delay(this.retryDelayMs);
      }
    }
    throw lastError || new Error('Codex app-server did not become ready');
  }

  handleNotification(message) {
    var params = message && message.params;
    if (!params || !isUuid(params.threadId)) return;
    var previous = this.threadStates.get(params.threadId) || createThreadState(params.threadId);
    var next = reduceThreadNotification(previous, message);
    if (next === previous) return;
    this.threadStates.set(params.threadId, next);
    this.onState(this.getThreadState(params.threadId));
  }

  seedThreadState(result) {
    var thread = result && result.thread;
    if (!thread || !isUuid(thread.id)) throw new Error('Codex app-server returned an invalid thread id');
    var state = this.threadStates.get(thread.id) || createThreadState(thread.id);
    state = reduceThreadNotification(state, {
      method: 'thread/settings/updated',
      params: {
        threadId: thread.id,
        threadSettings: {
          model: result.model,
          effort: result.reasoningEffort,
          serviceTier: result.serviceTier,
          approvalPolicy: result.approvalPolicy,
          sandboxPolicy: result.sandbox
        }
      }
    });
    state = reduceThreadNotification(state, {
      method: 'thread/status/changed',
      params: { threadId: thread.id, status: thread.status }
    });
    this.threadStates.set(thread.id, state);
    this.onState(this.getThreadState(thread.id));
    return thread.id;
  }

  async getCatalog() {
    var client = await this.ensureStarted();
    var models = [];
    var cursor = null;
    for (var page = 0; page < 20; page++) {
      var params = { includeHidden: false };
      if (cursor) params.cursor = cursor;
      var result = await client.request('model/list', params);
      var data = result && Array.isArray(result.data) ? result.data : [];
      for (const raw of data) {
        var model = sanitizeCatalogModel(raw);
        if (model) models.push(model);
      }
      cursor = result && typeof result.nextCursor === 'string' ? result.nextCursor : null;
      if (!cursor) break;
    }
    return models;
  }

  async prepareThread(options) {
    options = options || {};
    if (typeof options.cwd !== 'string' || !options.cwd) throw new Error('invalid Codex thread cwd');
    var client = await this.ensureStarted();
    var result;
    if (options.threadId !== undefined && options.threadId !== null) {
      if (!isUuid(options.threadId)) throw new Error('invalid Codex thread id');
      result = await client.request('thread/resume', { threadId: options.threadId, cwd: options.cwd });
    } else {
      result = await client.request('thread/start', { cwd: options.cwd, serviceName: 'claudes' });
    }
    var threadId = this.seedThreadState(result);
    return {
      threadId: threadId,
      remoteUrl: this.remoteUrl,
      remoteTokenEnvName: REMOTE_TOKEN_ENV_NAME
    };
  }

  getThreadState(threadId) {
    if (!isUuid(threadId)) return null;
    var state = this.threadStates.get(threadId);
    return state ? JSON.parse(JSON.stringify(state)) : null;
  }

  stop() {
    var socket = this.socket;
    var child = this.child;
    this.socket = null;
    this.client = null;
    this.child = null;
    this.remoteUrl = null;
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
    if (child && !child.killed) { try { child.kill(); } catch { /* already exited */ } }
  }
}

module.exports = {
  REMOTE_TOKEN_ENV_NAME,
  buildAppServerArgs,
  codexBridgeEnvForSpawn,
  CodexRpcClient,
  CodexAppServerService,
  allocateLoopbackPort,
  sanitizeCatalogModel
};
