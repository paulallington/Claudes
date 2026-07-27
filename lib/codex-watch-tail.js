// lib/codex-watch-tail.js
// Pure byte-offset tail logic for a Codex job log. Takes an injected `io`
// ({ statSync, openSync, readSync, closeSync }) instead of requiring `fs`
// directly, so main.js can pass the real fs and tests can pass a fake. This
// module is Node-only (Buffer, string_decoder) — it is never loaded by the
// sandboxed renderer, unlike most lib/ modules.
//
// `state` is the per-stream tracking object the caller owns across ticks:
// { offset, carry, decoder }. `offset` is bytes already consumed; `decoder`
// is a persistent StringDecoder so a multi-byte UTF-8 codepoint split across
// two reads decodes correctly instead of becoming U+FFFD on both sides.
var StringDecoder = require('string_decoder').StringDecoder;

var TAIL_BYTES = 64 * 1024;

// <root>/<workspaceKey>/jobs/<jobId>.log — the one place this path shape is
// built, shared by the poll loop and the openStream/resolve path.
function logPathFor(path, root, workspaceKey, jobId) {
  return path.join(root, workspaceKey, 'jobs', jobId + '.log');
}

function readDelta(io, logPath, state) {
  var stat;
  try { stat = io.statSync(logPath); }
  catch (err) { return null; }

  // Truncated or rotated: start over rather than reading from a stale offset.
  // The decoder is discarded too — any bytes it was holding belong to a file
  // that no longer exists in this form.
  if (stat.size < state.offset) {
    state.offset = 0;
    state.carry = '';
    state.decoder = null;
  }
  if (stat.size === state.offset) return null;

  var start = state.offset === 0 && stat.size > TAIL_BYTES
    ? stat.size - TAIL_BYTES
    : state.offset;

  var want = stat.size - start;
  var buf = Buffer.alloc(want);
  var fd = io.openSync(logPath, 'r');
  var bytesRead;
  try {
    bytesRead = io.readSync(fd, buf, 0, want, start);
  } finally {
    io.closeSync(fd);
  }

  // A short read (file shrank between statSync and readSync, or any partial
  // read) must not zero-fill into the decoded text, and offset must only
  // advance by what was actually read — otherwise the next tick's
  // `stat.size < state.offset` truncation check misfires and re-emits the
  // whole 64KB tail.
  state.offset = start + bytesRead;
  if (bytesRead === 0) return null;

  if (!state.decoder) state.decoder = new StringDecoder('utf8');
  var chunk = state.decoder.write(buf.subarray(0, bytesRead));

  return { chunk: chunk };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { readDelta, logPathFor, TAIL_BYTES: TAIL_BYTES };
}
