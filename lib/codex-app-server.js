'use strict';

const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  isUuid,
  createThreadState,
  reduceThreadNotification
} = require('./codex-thread-state');

const REMOTE_TOKEN_ENV_NAME = 'CLAUDES_CODEX_BRIDGE_TOKEN';

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
        var rpcError = new Error(detail);
        if (typeof message.error.code === 'number' && Number.isFinite(message.error.code)) {
          rpcError.code = message.error.code;
        }
        entry.reject(rpcError);
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

function sameWorkingDirectory(left, right, platform) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  var paths = platform === 'win32' ? path.win32 : path.posix;
  var a = paths.normalize(paths.resolve(left));
  var b = paths.normalize(paths.resolve(right));
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function normalizeWorkingDirectory(cwd, platform) {
  var paths = platform === 'win32' ? path.win32 : path.posix;
  var normalized = paths.normalize(paths.resolve(cwd));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isMissingRolloutError(error) {
  if (!error || error.code !== -32600 || typeof error.message !== 'string') return false;
  if (/\bno rollout found for thread id\b/i.test(error.message)) return true;
  var notLoaded = /^thread not loaded:\s*([0-9a-f-]+)$/i.exec(error.message.trim());
  return !!(notLoaded && isUuid(notLoaded[1]));
}

function terminateOwnedProcess(child, platform, execFileSyncImpl) {
  if (!child || child.killed) return;
  if (child.exitCode !== null && child.exitCode !== undefined) return;
  if (child.signalCode !== null && child.signalCode !== undefined) return;
  if (platform === 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      (execFileSyncImpl || execFileSync)(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' }
      );
      return;
    } catch {
      // The process may have exited between the state check and taskkill.
    }
  }
  try { child.kill(); } catch { /* already exited */ }
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
    this.execFileSync = options.execFileSync;
    this.createSocket = options.createSocket;
    this.onState = typeof options.onState === 'function' ? options.onState : function () {};
    this.onUnavailable = typeof options.onUnavailable === 'function' ? options.onUnavailable : function () {};
    this.onThreadClaimed = typeof options.onThreadClaimed === 'function' ? options.onThreadClaimed : function () {};
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
    this.claimTtlMs = options.claimTtlMs || 15000;
    this.connectTimeoutMs = options.connectTimeoutMs || 5000;
    this.retryDelayMs = options.retryDelayMs || 100;
    this.requestTimeoutMs = options.requestTimeoutMs || 15000;
    this.child = null;
    this.socket = null;
    this.client = null;
    this.remoteUrl = null;
    this.startPromise = null;
    this.threadStates = new Map();
    this.freshClaims = [];
    this.unavailable = false;
    this.stopping = false;
    if (typeof this.spawnProcess !== 'function') throw new Error('spawnProcess is required');
    if (typeof this.createSocket !== 'function') throw new Error('createSocket is required');
    if (typeof this.token !== 'string' || this.token.length < 16) throw new Error('invalid Codex app-server token');
  }

  async ensureStarted() {
    if (this.unavailable) throw new Error('Codex bridge unavailable until app restart');
    if (this.client) return this.client;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().catch((error) => {
      this.stop();
      throw error;
    }).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async start() {
    if (this.stopping) throw new Error('Codex app-server startup stopped');
    var port = await this.allocatePort();
    if (this.stopping) throw new Error('Codex app-server startup stopped');
    this.remoteUrl = 'ws://127.0.0.1:' + port;
    this.child = this.spawnProcess(this.command, buildAppServerArgs(port, this.token), {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      shell: this.platform === 'win32'
    });
    if (!this.child || typeof this.child.on !== 'function') throw new Error('Codex app-server failed to spawn');
    this.child.once('exit', () => this.markUnavailable(true));

    var deadline = Date.now() + this.connectTimeoutMs;
    var lastError = null;
    while (Date.now() < deadline) {
      if (this.stopping) throw new Error('Codex app-server startup stopped');
      if (this.unavailable) throw new Error('Codex app-server exited during startup');
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
        socket.once('close', () => this.markUnavailable(false));
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
    if (message && message.method === 'thread/started') {
      var thread = params && params.thread;
      if (!thread || !isUuid(thread.id)) return;
      var startedState = this.threadStates.get(thread.id) || createThreadState(thread.id);
      startedState = reduceThreadNotification(startedState, {
        method: 'thread/status/changed',
        params: { threadId: thread.id, status: thread.status }
      });
      this.threadStates.set(thread.id, startedState);

      var now = this.now();
      this.freshClaims = this.freshClaims.filter((claim) => claim.expiresAt > now);
      if (typeof thread.cwd === 'string' && thread.cwd) {
        var cwd = normalizeWorkingDirectory(thread.cwd, this.platform);
        var claimIndex = this.freshClaims.findIndex((claim) => claim.cwd === cwd);
        if (claimIndex !== -1) {
          var claim = this.freshClaims.splice(claimIndex, 1)[0];
          this.onThreadClaimed({ claimId: claim.claimId, threadId: thread.id });
        }
      }
      this.onState(this.getThreadState(thread.id));
      return;
    }
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
    if (options.threadId !== undefined && options.threadId !== null) {
      if (!isUuid(options.threadId)) throw new Error('invalid Codex thread id');
      var read;
      try {
        read = await client.request('thread/read', { threadId: options.threadId, includeTurns: false });
      } catch (error) {
        if (isMissingRolloutError(error)) return this.prepareFreshThread(options.cwd);
        throw error;
      }
      var stored = read && read.thread;
      if (!stored || stored.id !== options.threadId || !sameWorkingDirectory(stored.cwd, options.cwd, this.platform)) {
        throw new Error('Codex thread working directory does not match this project');
      }
      var result = await client.request('thread/resume', { threadId: options.threadId, cwd: options.cwd });
      var threadId = this.seedThreadState(result);
      return {
        mode: 'resume',
        threadId: threadId,
        remoteUrl: this.remoteUrl,
        remoteTokenEnvName: REMOTE_TOKEN_ENV_NAME
      };
    }

    return this.prepareFreshThread(options.cwd);
  }

  prepareFreshThread(cwd) {
    var now = this.now();
    this.freshClaims = this.freshClaims.filter((claim) => claim.expiresAt > now);
    var claimId = this.randomBytes(16).toString('hex');
    this.freshClaims.push({
      claimId: claimId,
      cwd: normalizeWorkingDirectory(cwd, this.platform),
      expiresAt: now + this.claimTtlMs
    });
    return {
      mode: 'fresh',
      claimId: claimId,
      remoteUrl: this.remoteUrl,
      remoteTokenEnvName: REMOTE_TOKEN_ENV_NAME
    };
  }

  getThreadState(threadId) {
    if (!isUuid(threadId)) return null;
    var state = this.threadStates.get(threadId);
    return state ? JSON.parse(JSON.stringify(state)) : null;
  }

  markUnavailable(childAlreadyExited) {
    if (this.stopping || this.unavailable) return;
    this.unavailable = true;
    var socket = this.socket;
    var child = this.child;
    this.socket = null;
    this.client = null;
    this.child = null;
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
    if (!childAlreadyExited) terminateOwnedProcess(child, this.platform, this.execFileSync);
    this.onUnavailable();
  }

  stop() {
    this.stopping = true;
    var socket = this.socket;
    var child = this.child;
    this.socket = null;
    this.client = null;
    this.child = null;
    this.remoteUrl = null;
    this.freshClaims = [];
    if (socket) { try { socket.close(); } catch { /* already closed */ } }
    terminateOwnedProcess(child, this.platform, this.execFileSync);
  }
}

module.exports = {
  REMOTE_TOKEN_ENV_NAME,
  buildAppServerArgs,
  CodexRpcClient,
  CodexAppServerService,
  allocateLoopbackPort,
  sanitizeCatalogModel,
  sameWorkingDirectory
};
