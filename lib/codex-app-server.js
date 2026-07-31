'use strict';

const crypto = require('crypto');

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

function codexBridgeEnvForSpawn(cmd, args, token) {
  if (cmd !== 'codex' || !Array.isArray(args) || typeof token !== 'string' || !token) return {};
  if (!args.includes('resume')) return {};
  var remoteIdx = args.indexOf('--remote');
  var envIdx = args.indexOf('--remote-auth-token-env');
  if (remoteIdx < 0 || envIdx < 0) return {};
  if (!LOOPBACK_REMOTE_RE.test(String(args[remoteIdx + 1] || ''))) return {};
  if (args[envIdx + 1] !== REMOTE_TOKEN_ENV_NAME) return {};
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
      capabilities: { experimentalApi: true, requestAttestation: false }
    }).then((result) => {
      this.notify('initialized');
      return result;
    });
    return this.initializePromise;
  }
}

module.exports = {
  REMOTE_TOKEN_ENV_NAME,
  buildAppServerArgs,
  codexBridgeEnvForSpawn,
  CodexRpcClient
};
