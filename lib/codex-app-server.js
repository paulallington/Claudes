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

module.exports = {
  REMOTE_TOKEN_ENV_NAME,
  buildAppServerArgs,
  codexBridgeEnvForSpawn
};
