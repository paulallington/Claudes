const fs = require('fs');

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
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
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

module.exports = { lastAssistantContextTokens, modelContextLimit };
