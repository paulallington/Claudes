/**
 * Generate an RFC-4122 v4 UUID using crypto.getRandomValues. Works in both the
 * Electron renderer under file:// and Node 18+ (globalThis.crypto). We avoid
 * crypto.randomUUID because it requires a secure context (unavailable on file://).
 * @returns {string} lowercase hyphenated v4 uuid
 */
function randomUuidV4() {
  var bytes = new Uint8Array(16);
  (globalThis.crypto || crypto).getRandomValues(bytes);
  // Set version (4) and variant (10xx) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  var hex = [];
  for (var i = 0; i < 16; i++) {
    hex.push((bytes[i] + 0x100).toString(16).slice(1));
  }
  return (
    hex[0] + hex[1] + hex[2] + hex[3] + '-' +
    hex[4] + hex[5] + '-' +
    hex[6] + hex[7] + '-' +
    hex[8] + hex[9] + '-' +
    hex[10] + hex[11] + hex[12] + hex[13] + hex[14] + hex[15]
  );
}

/**
 * Decide whether a fresh local Claude CLI spawn should be pinned to a
 * deterministic session id, returning the (possibly augmented) args plus the
 * resolved session id (or null when no pinning applies). Never mutates input.
 * @param {{ args: string[], cmd: *, hasEndpoint: boolean }} input
 * @param {() => string} [genUuid] uuid generator (defaults to randomUuidV4)
 * @returns {{ args: string[], sessionId: string|null }}
 */
function planFreshSessionId(input, genUuid) {
  var args = (input && input.args) || [];
  // 1. Arbitrary non-Claude process spawn — no transcript, no injection.
  if (input && input.cmd) {
    return { args: args, sessionId: null };
  }
  // 2. Remote/cloud endpoint spawn — local transcript attribution doesn't apply.
  if (input && input.hasEndpoint) {
    return { args: args, sessionId: null };
  }
  // 3. Resume/continue already binds the session.
  if (args.indexOf('--resume') !== -1 || args.indexOf('--continue') !== -1) {
    return { args: args, sessionId: null };
  }
  // 4. An explicit --session-id is already present — adopt it, don't duplicate.
  var idx = args.indexOf('--session-id');
  if (idx !== -1) {
    return { args: args, sessionId: args[idx + 1] };
  }
  // 5. Fresh local spawn — pin a generated id.
  var gen = genUuid || randomUuidV4;
  var id = gen();
  return { args: args.concat(['--session-id', id]), sessionId: id };
}

/**
 * Decide whether a restored column should resume its prior session. Returns a
 * NEW array — never mutates baseArgs. Appends ['--resume', sessionId] only when
 * sessionId is truthy AND the session still exists on disk; otherwise returns a
 * plain copy of baseArgs (no --resume), so the column spawns fresh instead of
 * erroring with "No conversation found with session ID …".
 * @param {{ baseArgs: string[], sessionId: string|null|undefined, exists: boolean }} input
 * @returns {string[]} new args array
 */
function planResumeArgs(input) {
  var baseArgs = (input && input.baseArgs) || [];
  var sessionId = input && input.sessionId;
  var exists = !!(input && input.exists);
  if (sessionId && exists) {
    return baseArgs.concat(['--resume', sessionId]);
  }
  return baseArgs.slice();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { planFreshSessionId: planFreshSessionId, randomUuidV4: randomUuidV4, planResumeArgs: planResumeArgs };
}
if (typeof window !== 'undefined') {
  window.SpawnSession = { planFreshSessionId: planFreshSessionId, randomUuidV4: randomUuidV4, planResumeArgs: planResumeArgs };
}
