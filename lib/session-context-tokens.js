const fs = require('fs');

// mtime-keyed cache so repeat polls of an unchanged JSONL don't keep re-
// reading and re-parsing megabytes of history. Each entry is keyed by
// (filePath, sinceMs) since the result depends on both. Bounded so a
// long-running app with many distinct sessions can't grow it without limit.
const ctxCache = new Map();
const CTX_CACHE_MAX = 256;
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
// or null if the file is missing/empty/malformed. Reads the whole file
// (acceptable: typical session JSONLs are <50MB; called only on demand).
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
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  _ctxFullReads++;
  _ctxBytesRead += (content && content.length) || 0;
  if (!content) return null;
  const filterByTime = typeof sinceMs === 'number' && isFinite(sinceMs);
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
      if (!isFinite(t) || t < sinceMs) continue;
    }
    const u = entry.message.usage;
    const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    cacheStore(key, st.mtimeMs, st.size, total);
    return total;
  }
  return null;
}

// Map model name fragment → effective context window in tokens.
// Defaults to 200000 if unknown. Update when new context tiers ship.
function modelContextLimit(model) {
  if (!model) return 200000;
  const m = String(model).toLowerCase();
  if (m.indexOf('1m') !== -1) return 1000000;
  if (m.indexOf('haiku') !== -1) return 200000;
  if (m.indexOf('opus') !== -1) return 200000;
  if (m.indexOf('sonnet') !== -1) return 200000;
  return 200000;
}

module.exports = { lastAssistantContextTokens, modelContextLimit, sampleAndResetReadStats };
