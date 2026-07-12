// Pure helpers for reading Codex CLI rate-limit usage out of its session
// rollout JSONL. Codex (ChatGPT auth) doesn't expose a usage endpoint like
// Claude's OAuth /usage — instead every `token_count` event it writes to
// ~/.codex/sessions/**/rollout-*.jsonl carries a `rate_limits` block with a
// primary (5h) and secondary (weekly) window. We scrape the newest event so
// the sidebar can show a Codex Session/Week bar mirroring the Claude one.
//
// Loaded two ways, matching lib/codex-spawn.js:
//   - Node (main.js + tests): require('./lib/codex-limits').
//   - Renderer: only the normalization shape matters there; the file scan is
//     main-process only, so the renderer never requires this.

'use strict';

(function () {
  // Codex records rate-limit windows by duration in minutes. 300 = the 5-hour
  // "session" window, 10080 = the 7-day "week" window. We label by the payload's
  // primary/secondary slot (primary is always the shorter window) rather than by
  // the minute count, so an upstream window resize doesn't silently drop a bar.
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

  // Scan a rollout JSONL body for the most recent `rate_limits` block and return
  // it normalized to the Claude mini-bar shape: { five_hour, seven_day } (each a
  // slot or null). Returns null when no rate-limit event is present. Malformed
  // lines are skipped so a partially-written tail never throws.
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
      var fiveHour = normalizeSlot(rl.primary);
      var sevenDay = normalizeSlot(rl.secondary);
      if (!fiveHour && !sevenDay) continue;
      return { five_hour: fiveHour, seven_day: sevenDay };
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
