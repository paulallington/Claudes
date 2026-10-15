const fs = require('fs');
const ClaudeModels = (typeof module !== 'undefined' && module.exports)
  ? require('./claude-models')
  : (typeof window !== 'undefined' ? window.ClaudeModels : null);

// mtime-keyed cache so repeat polls of an unchanged JSONL don't keep re-
// reading and re-parsing megabytes of history. Each entry is keyed by
// (filePath, sinceMs) since the result depends on both. Bounded so a
// long-running app with many distinct sessions can't grow it without limit.
const ctxCache = new Map();
const CTX_CACHE_MAX = 256;
const CTX_TAIL_BYTES = 256 * 1024;
// The tail window doubles on a miss up to this size; only then is the rest read.
const CTX_TAIL_MAX_BYTES = 8 * 1024 * 1024;
// scanForUsage result: met an assistant entry older than sinceMs.
const STALE = Symbol('stale');
function cacheKey(filePath, sinceMs) {
  return filePath + '|' + (typeof sinceMs === 'number' && isFinite(sinceMs) ? sinceMs : '');
}
function cacheStore(key, mtimeMs, size, tokens) {
  if (ctxCache.size >= CTX_CACHE_MAX) {
    // Drop the oldest insertion — Map iteration is in insertion order.
    const firstKey = ctxCache.keys().next().value;
    if (firstKey !== undefined) ctxCache.delete(firstKey);
  }
  ctxCache.set(key, { mtimeMs, size, tokens });
}

// Counters for perf instrumentation. Sampled and reset by main.js.
let _ctxFullReads = 0;
let _ctxBytesRead = 0;
function sampleAndResetReadStats() {
  const r = { fullReads: _ctxFullReads, bytesRead: _ctxBytesRead };
  _ctxFullReads = 0;
  _ctxBytesRead = 0;
  return r;
}

// Returns the live context-token count for the last assistant turn in a JSONL,
// or null if the file is missing/empty/malformed. Reads the last 256 KB,
// doubling the window up to 8 MB on a miss, and reads the whole file only if
// that still finds nothing.
//
// When `sinceMs` is a finite number, only assistant entries whose
// `entry.timestamp` parses to a time >= sinceMs are considered. This is used
// by the renderer for newly-spawned (non-resume) columns to avoid surfacing
// stale tokens from a prior session that detectSession may briefly attach to
// before Claude's first reply lands.
function lastAssistantContextTokens(filePath, sinceMs) {
  // mtime gate — if the file hasn't changed since our last successful read,
  // return the cached token count. One stat() vs reading the whole file.
  let st;
  try { st = fs.statSync(filePath); } catch { return null; }
  const key = cacheKey(filePath, sinceMs);
  const hit = ctxCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return hit.tokens;
  }
  const filterByTime = typeof sinceMs === 'number' && isFinite(sinceMs);
  // The newest usage line is almost always in the last few KB, so read only
  // the tail. A full read of a 30 MB transcript on every mtime change was a
  // measurable share of main-thread time while columns were streaming.
  // On a miss the window grows backwards by doubling (reading only the newly
  // exposed older bytes) rather than jumping to the whole file, because one
  // oversized tool-result line can push the usage line past 256 KB.
  let total = null;
  let buf = Buffer.alloc(0);
  let start = st.size;
  let span = CTX_TAIL_BYTES;
  while (start > 0) {
    const nextStart = Math.max(0, st.size - span);
    const older = readBuf(filePath, nextStart, start - nextStart);
    if (older === null) return null;
    // Joined as bytes, so a multi-byte character straddling a boundary is
    // decoded whole (and a partial first line is dropped before decoding
    // matters).
    buf = Buffer.concat([older, buf]);
    start = nextStart;
    if (start === 0) _ctxFullReads++;
    let text = buf.toString('utf8');
    if (start > 0) {
      // The read began mid-file, so its first line is probably partial.
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    const found = scanForUsage(text, filterByTime, sinceMs);
    if (found === STALE) break;  // total stays null
    if (found !== null) { total = found; break; }
    // Past the cap, stop doubling and read whatever is left.
    span = span >= CTX_TAIL_MAX_BYTES ? st.size : span * 2;
  }
  cacheStore(key, st.mtimeMs, st.size, total);
  return total;
}

// Scan newest-to-oldest for the last qualifying assistant usage line.
function scanForUsage(content, filterByTime, sinceMs) {
  if (!content) return null;
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    if (line.indexOf('"usage"') === -1) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' || !entry.message || !entry.message.usage) continue;
    if (filterByTime) {
      const t = Date.parse(entry.timestamp || '');
      if (!isFinite(t)) continue;
      // Transcripts are chronological, so nothing earlier can qualify.
      if (t < sinceMs) return STALE;
    }
    const u = entry.message.usage;
    return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  }
  return null;
}

// Read `length` bytes at `position`; null on any fs error. Counts the bytes
// actually read for the perf line.
function readBuf(filePath, position, length) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(fd, buf, got, length - got, position + got);
      if (n <= 0) break;
      got += n;
    }
    _ctxBytesRead += got;
    return buf.subarray(0, got);
  } catch { return null; } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// Effective context window in tokens for a model id. The `[1m]` suffix
// (Headroom's way of re-activating the 1M window behind a custom base URL)
// always wins over the model's native window. Otherwise delegates to the
// claude-models catalogue, which knows which pinned models are natively 1M
// vs 200k. Falls back to the conservative 200000 default for null/unknown.
function modelContextLimit(model) {
  if (!model) return 200000;
  const m = String(model).toLowerCase();
  if (m.indexOf('1m') !== -1) return 1000000;
  if (ClaudeModels) return ClaudeModels.contextWindowFor(model);
  return 200000;
}

module.exports = { lastAssistantContextTokens, modelContextLimit, sampleAndResetReadStats };
