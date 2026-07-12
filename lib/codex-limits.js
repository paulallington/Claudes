// Pure helpers for reading Codex CLI rate-limit usage out of its session
// rollout JSONL. Codex (ChatGPT auth) doesn't expose a usage endpoint like
// Claude's OAuth /usage — instead `token_count` events it writes to
// ~/.codex/sessions/**/rollout-*.jsonl carry a `rate_limits` block with a
// primary (5h) and secondary (weekly) window. Not every block carries both:
// a fresh session's first event is a placeholder with only the weekly window
// populated (secondary null). We scrape the newest usable event(s) so the
// sidebar can show a Codex Session/Week bar mirroring the Claude one.
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
  // position, because a fresh session's placeholder block can put the weekly
  // window in the `primary` slot (with `secondary: null`) — classifying by
  // position alone would mislabel that placeholder as the session bar.
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
  // primary/secondary position: a fresh Codex session writes a PLACEHOLDER
  // block before real rate-limit headers arrive, where the weekly (10080min)
  // window sits in the `primary` slot with `secondary:null`. Nearest-of-two
  // so an upstream window resize doesn't silently flip the label. When
  // window_minutes is missing/non-numeric (can't classify by duration), fall
  // back to the slot's position — primary->five_hour, secondary->seven_day —
  // the legacy behavior, so a missing-duration slot never both defaults to
  // the same label and clobbers the other window.
  function classifySlot(normalized, position) {
    var w = normalized && normalized.window_minutes;
    if (typeof w === 'number' && !isNaN(w)) {
      return Math.abs(w - SEVEN_DAY_MINUTES) < Math.abs(w - FIVE_HOUR_MINUTES) ? 'seven_day' : 'five_hour';
    }
    return position === 'secondary' ? 'seven_day' : 'five_hour';
  }

  // True only for the observed fresh-session PLACEHOLDER shape: no session
  // (five_hour) window at all, and every window slot the block does carry
  // reports 0%. A block with any nonzero window, or with a session window
  // (even at 0%), is a real reading and must NOT be treated as a placeholder
  // — e.g. a genuinely fresh weekly-only reset (weekly 0% right after
  // rollover) is legitimate and distinct from "never received real headers".
  function isPlaceholderSlots(slots) {
    if (slots.five_hour) return false;
    var present = [];
    if (slots.seven_day) present.push(slots.seven_day);
    if (!present.length) return true;
    for (var i = 0; i < present.length; i++) {
      if (present[i].utilization !== 0) return false;
    }
    return true;
  }

  // Scan a rollout JSONL body newest->oldest for `rate_limits` blocks and
  // return the Claude mini-bar shape: { five_hour, seven_day } (each a slot
  // or null). Each window is resolved independently: the freshest (newest)
  // non-null slot for that window, scanning across all non-skipped blocks —
  // so a legit weekly-only block never gets masked by an unrelated, older
  // session-bearing block and vice versa. Uninitialized placeholder blocks
  // (see isPlaceholderSlots) are skipped like malformed lines. Returns null
  // only when no usable rate-limit event is present at all. Malformed lines
  // are skipped so a partially-written tail never throws.
  function parseCodexRateLimits(jsonlText) {
    if (!jsonlText) return null;
    var lines = String(jsonlText).split(/\r?\n/);
    var result = { five_hour: null, seven_day: null };
    var found = false;
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i].trim();
      if (!line || line.indexOf('rate_limits') === -1) continue;
      var obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      var rl = obj && obj.payload && obj.payload.rate_limits;
      if (!rl) continue;
      var slots = { five_hour: null, seven_day: null };
      var primary = normalizeSlot(rl.primary);
      if (primary) slots[classifySlot(primary, 'primary')] = primary;
      var secondary = normalizeSlot(rl.secondary);
      if (secondary) slots[classifySlot(secondary, 'secondary')] = secondary;
      if (!slots.five_hour && !slots.seven_day) continue;
      if (isPlaceholderSlots(slots)) continue;

      found = true;
      if (result.five_hour === null && slots.five_hour) result.five_hour = slots.five_hour;
      if (result.seven_day === null && slots.seven_day) result.seven_day = slots.seven_day;
      if (result.five_hour !== null && result.seven_day !== null) break;
    }
    return found ? result : null;
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

  // A reading (already the output of parseCodexRateLimits, or a raw slots
  // object of the same shape) is an uninitialized placeholder by the same
  // rule as isPlaceholderSlots: no five_hour window, and every window it
  // does carry reads 0%.
  function isPlaceholderReading(r) {
    if (!r) return true;
    return isPlaceholderSlots(r);
  }

  // Codex's 5h/weekly limits are ACCOUNT-level rolling windows, not
  // per-session, so a single (newest) rollout isn't enough: starting a fresh
  // Codex column creates a rollout whose only rate_limits block is the
  // weekly-only placeholder, "losing" the real session reading a moment
  // earlier. `readings` is [{five_hour, seven_day}|null, ...] ordered
  // NEWEST-FIRST (one per rollout, e.g. from parseCodexRateLimits). Resolves
  // each window independently — the freshest non-null slot for that window
  // across all non-placeholder readings — so a newer weekly-only reading is
  // never masked by an older, unrelated complete reading (or vice versa).
  // Returns { five_hour, seven_day } or null when nothing usable is found.
  function mergeCodexReadings(readings) {
    if (!readings || !readings.length) return null;
    var five_hour = null;
    var seven_day = null;
    for (var i = 0; i < readings.length; i++) {
      var r = readings[i];
      if (isPlaceholderReading(r)) continue;
      if (five_hour === null && r.five_hour) five_hour = r.five_hour;
      if (seven_day === null && r.seven_day) seven_day = r.seven_day;
      if (five_hour !== null && seven_day !== null) break;
    }
    if (five_hour === null && seven_day === null) return null;
    return { five_hour: five_hour, seven_day: seven_day };
  }

  var api = {
    FIVE_HOUR_MINUTES: FIVE_HOUR_MINUTES,
    SEVEN_DAY_MINUTES: SEVEN_DAY_MINUTES,
    normalizeSlot: normalizeSlot,
    parseCodexRateLimits: parseCodexRateLimits,
    pickLatestRolloutPath: pickLatestRolloutPath,
    mergeCodexReadings: mergeCodexReadings
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.CodexLimits = api;
  }
})();
