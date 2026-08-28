'use strict';

const crypto = require('crypto');
const path = require('path');

const THREAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_RE = /^[0-9a-f]{32}$/;
const REMOTE_RE = /^ws:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})\/?$/;

function normalizeCwd(cwd, platform) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const value = paths.normalize(paths.resolve(cwd));
  return platform === 'win32' ? value.toLowerCase() : value;
}

function createSpawnTicketStore(options) {
  options = options || {};
  const now = options.now || Date.now;
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 15000;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const tickets = new Map();
  let remoteUrl = null;
  let bearer = null;

  function configure(url, token) {
    if (!REMOTE_RE.test(url) || typeof token !== 'string' || token.length < 16) {
      throw new Error('invalid Codex bridge configuration');
    }
    remoteUrl = url;
    bearer = token;
    tickets.clear();
  }

  function issue(binding, platform) {
    const cwd = normalizeCwd(binding && binding.cwd, platform);
    const mode = binding && binding.mode;
    const identity = mode === 'resume' && !binding.claimId && THREAD_RE.test(binding && binding.threadId || '')
      ? { threadId: binding.threadId }
      : mode === 'fresh' && !binding.threadId && CLAIM_RE.test(binding && binding.claimId || '')
        ? { claimId: binding.claimId }
        : null;
    if (!bearer || !identity || !cwd || binding.remoteUrl !== remoteUrl) {
      throw new Error('invalid Codex spawn authorization');
    }
    const ticket = randomBytes(32).toString('hex');
    const expiresAt = now() + ttlMs;
    tickets.set(ticket, { mode, ...identity, cwd, remoteUrl, expiresAt });
    return { ticket, expiresAt };
  }

  function consume(binding, platform) {
    const ticket = binding && binding.ticket;
    if (typeof ticket !== 'string' || !ticket) return null;
    const stored = tickets.get(ticket);
    tickets.delete(ticket);
    if (!stored || stored.expiresAt < now()) return null;
    const cwd = normalizeCwd(binding.cwd, platform);
    const mode = binding.mode;
    const identityMatches = mode === 'resume'
      ? stored.threadId === binding.threadId
      : mode === 'fresh' && stored.claimId === binding.claimId;
    if (!cwd || stored.mode !== mode || !identityMatches || stored.cwd !== cwd || stored.remoteUrl !== binding.remoteUrl) return null;
    return bearer;
  }

  function discard(ticket) {
    return typeof ticket === 'string' && tickets.delete(ticket);
  }

  return { configure, issue, consume, discard };
}

module.exports = { createSpawnTicketStore, normalizeCwd, THREAD_RE, CLAIM_RE, REMOTE_RE };
