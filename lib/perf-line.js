// Pure helpers for the main-process [perf] line: validation of the
// renderer-supplied lag snapshot (untrusted IPC payload) and formatting of
// the main event-loop histogram and renderer snapshot.
const RENDERER_LAG_FIELDS = [
  'lagP50', 'lagP99', 'lagMax', 'longTasks', 'longTaskMs',
  'echoP50', 'echoP99', 'echoMax', 'echoCount', 'termKB',
];
const RENDERER_LAG_MAX = 1e7;

// Returns a fresh object holding only known, finite, non-negative numbers
// (clamped), or null if the payload is not a plain object.
function sanitizeRendererLag(snap) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return null;
  const out = {};
  for (const k of RENDERER_LAG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(snap, k)) continue;
    const v = snap[k];
    if (typeof v !== 'number' || !isFinite(v) || v < 0) continue;
    out[k] = Math.min(v, RENDERER_LAG_MAX);
  }
  return out;
}

const ms = (ns) => Math.round(ns / 1e6) || 0;
const n = (v) => Math.round(v || 0);

// Sampling interval for monitorEventLoopDelay. Shared with main.js so the
// histogram and the correction below cannot drift apart.
const MAIN_LAG_RESOLUTION_MS = 20;

// `h` is a perf_hooks IntervalHistogram (values in nanoseconds). It records
// the whole gap between ticks, so an idle loop reads as the resolution itself;
// subtract it to report delay beyond the tick.
function formatMainLag(h, resolutionMs) {
  const res = (resolutionMs === undefined ? MAIN_LAG_RESOLUTION_MS : resolutionMs) * 1e6;
  const d = (ns) => ms(Math.max(0, ns - res));
  return ' mainLag=' + d(h.percentile(50)) + '/' + d(h.percentile(99)) + '/' + d(h.max);
}

// `snap` is the output of sanitizeRendererLag (values already in ms / counts).
function formatRendererLag(snap) {
  if (!snap) return '';
  return ' | rLag=' + n(snap.lagP50) + '/' + n(snap.lagP99) + '/' + n(snap.lagMax)
    + ' lt=' + n(snap.longTasks) + '/' + n(snap.longTaskMs) + 'ms'
    + ' echo=' + n(snap.echoP50) + '/' + n(snap.echoP99) + '/' + n(snap.echoMax) + '(n=' + n(snap.echoCount) + ')'
    + ' termKB=' + n(snap.termKB);
}

module.exports = { sanitizeRendererLag, formatMainLag, formatRendererLag, MAIN_LAG_RESOLUTION_MS };
