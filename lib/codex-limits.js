// Pure helpers for reading Codex CLI rate-limit usage out of its session
// rollout JSONL. Codex (ChatGPT auth) doesn't expose a usage endpoint like
// Claude's OAuth /usage — instead `token_count` events it writes to
// ~/.codex/sessions/**/rollout-*.jsonl carry a `rate_limits` block with a
// primary (usually 5h, 300min) and secondary (usually weekly, 10080min)
// window. Not every reading carries both: some accounts (e.g. Pro Lite) have
// NO 5-hour window at all, and a fresh session can put the weekly window in
// the `primary` slot with `secondary: null`. So we classify each slot by its
// window_minutes rather than trusting primary/secondary position, and we
// always read the NEWEST rollout — usage windows reset/refresh over time, so
// an older reading is stale, not "more complete".
//
// Loaded two ways, matching lib/codex-spawn.js:
//   - Node (main.js + tests): require('./lib/codex-limits').
//   - Renderer: only the normalization shape matters there; the file scan is
//     main-process only, so the renderer never requires this.

'use strict';

(function () {
  // Codex records rate-limit windows by duration in minutes. 300 = the 5-hour
  // "session" window, 10080 = the 7-day "week" window. We classify each slot
  // by its window_minutes (nearest of the two) rather than by primary/secondary
  // position, because some readings put the weekly window in the `primary`
  // slot (with `secondary: null`) — classifying by position alone would
  // mislabel that as the session bar.
  var FIVE_HOUR_MINUTES = 300;
  var SEVEN_DAY_MINUTES = 10080;

  // Codex resets_at is unix SECONDS; Claude's usage API gives an ISO string and
  // the renderer feeds resets_at straight into `new Date(...)`. Normalize codex
  // to the same ISO shape so both bars share fmtResetsIn / popover formatting.
  function normalizeSlot(slot) {
    if (!slot || typeof slot.used_percent !== 'number') return null;
    var out = { utilization: slot.used_percent };
    if (typeof slot.resets_at === 'number' && slot.resets_at > 0) {
      out.resets_at = new Date(slot.resets_at * 1000).toISOString();
    } else {
      out.resets_at = null;
    }
    if (typeof slot.window_minutes === 'number') out.window_minutes = slot.window_minutes;
    return out;
  }

  // Classify a normalized slot by its window_minutes rather than trusting its
  // primary/secondary position. Nearest-of-two so an upstream window resize
  // doesn't silently flip the label. When window_minutes is missing/non-numeric
  // (can't classify by duration), fall back to positionalDefault — a valid
  // slot with no duration keeps its slot-based label instead of collapsing.
  function classifySlot(normalized, positionalDefault) {
    var w = normalized && normalized.window_minutes;
    if (typeof w === 'number' && !isNaN(w)) {
      return Math.abs(w - SEVEN_DAY_MINUTES) < Math.abs(w - FIVE_HOUR_MINUTES) ? 'seven_day' : 'five_hour';
    }
    return positionalDefault;
  }

  // Scan a rollout JSONL body newest->oldest for `rate_limits` blocks and
  // return the Claude mini-bar shape: { five_hour, seven_day } (each a slot
  // or null) from the FIRST (i.e. newest) parseable block that has a
  // non-null primary or secondary. Usage windows reset/refresh, so the
  // freshest reading is authoritative — an older block is stale, not more
  // complete, and must never be preferred or merged in. A reading missing a
  // window (e.g. no 5h window on this account) correctly reports that window
  // as null so the caller can hide it rather than resurrect a stale value.
  // Malformed lines are skipped so a partially-written tail never throws.
  function parseCodexRateLimits(jsonlText) {
    if (!jsonlText) return null;
    var lines = String(jsonlText).split(/\r?\n/);
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i].trim();
      if (!line || line.indexOf('rate_limits') === -1) continue;
      var obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      var rl = obj && obj.payload && obj.payload.rate_limits;
      if (!rl) continue;
      var primary = normalizeSlot(rl.primary);
      var secondary = normalizeSlot(rl.secondary);
      if (!primary && !secondary) continue;

      var result = { five_hour: null, seven_day: null };
      if (primary) result[classifySlot(primary, 'five_hour')] = primary;
      if (secondary) result[classifySlot(secondary, 'seven_day')] = secondary;
      return result;
    }
    return null;
  }

  // Given [{ path, mtimeMs }, …], return the path of the most recently modified
  // entry (the live/last-used Codex session), or null for an empty list.
  function pickLatestRolloutPath(entries) {
    if (!entries || !entries.length) return null;
    var best = null;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || !e.path) continue;
      if (!best || (e.mtimeMs || 0) > (best.mtimeMs || 0)) best = e;
    }
    return best ? best.path : null;
  }

  var api = {
    FIVE_HOUR_MINUTES: FIVE_HOUR_MINUTES,
    SEVEN_DAY_MINUTES: SEVEN_DAY_MINUTES,
    normalizeSlot: normalizeSlot,
    parseCodexRateLimits: parseCodexRateLimits,
    pickLatestRolloutPath: pickLatestRolloutPath
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.CodexLimits = api;
  }
})();
