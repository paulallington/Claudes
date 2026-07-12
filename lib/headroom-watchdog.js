'use strict';

// Decides whether the Electron main process should restart the app-managed
// Headroom proxy after a periodic /health probe.
//
// Unlike pty-server (which we restart on process *exit*), the Headroom proxy
// fails by going quiet: the process stays alive but stops answering — a hang
// the proxy-lifecycle code already anticipates ("started but not answering").
// Nothing periodic watched for it, so recovery was a manual restart. This
// policy drives a poll: N consecutive failed probes trip a restart, backed off
// and capped so a proxy that can't come up can't fork-bomb the host.
//
// Pure and deterministic (no I/O, no clock) so it is unit-testable — the caller
// supplies `now` and the probe result and stores the returned state back, the
// same shape as lib/pty-restart-policy.js.

// Consecutive unhealthy probes before we act. >1 so a single blip (or a probe
// that raced a cold start still indexing the code graph) doesn't restart a
// proxy that is merely slow for one tick.
const FAILURE_THRESHOLD = 3;
const WINDOW_MS = 5 * 60 * 1000;   // rolling window for crash-loop detection
const MAX_RESTARTS_IN_WINDOW = 3;  // give up after this many restarts in the window
// Delay before a restart, indexed by how many restarts already happened in the
// window; clamped to the last entry. First recovery is immediate.
const BACKOFF_MS = [0, 2000, 10000];

// state: { consecutiveFailures, restartTimestamps }
// evt:   { enabled, installed, healthy, now }
// Returns { action, consecutiveFailures, restartTimestamps, delayMs } where
// action is 'idle' | 'watch' | 'restart' | 'giveUp'. The caller stores the
// returned consecutiveFailures/restartTimestamps back for the next tick.
function planHeadroomWatchdog(state, evt) {
  state = state || {};
  const timestamps = Array.isArray(state.restartTimestamps) ? state.restartTimestamps : [];

  // Not our concern when Headroom is off or absent — clear the streak so a
  // later enable starts clean, but preserve restart history for the window.
  if (!evt.enabled || !evt.installed) {
    return { action: 'idle', consecutiveFailures: 0, restartTimestamps: timestamps, delayMs: 0 };
  }

  // Answering again — reset the failure streak.
  if (evt.healthy) {
    return { action: 'idle', consecutiveFailures: 0, restartTimestamps: timestamps, delayMs: 0 };
  }

  const failures = (state.consecutiveFailures || 0) + 1;

  // Still within tolerance — keep watching, don't restart yet.
  if (failures < FAILURE_THRESHOLD) {
    return { action: 'watch', consecutiveFailures: failures, restartTimestamps: timestamps, delayMs: 0 };
  }

  // Threshold reached. Prune restarts that fell outside the rolling window so a
  // burst that has since gone quiet doesn't count against a fresh hang.
  const recent = timestamps.filter((t) => evt.now - t < WINDOW_MS);

  if (recent.length >= MAX_RESTARTS_IN_WINDOW) {
    // Keep the streak so we stay in giveUp until a healthy probe (or the window
    // clears); avoids re-restarting a proxy that clearly can't stay up.
    return { action: 'giveUp', consecutiveFailures: failures, restartTimestamps: recent, delayMs: 0 };
  }

  const delayMs = BACKOFF_MS[Math.min(recent.length, BACKOFF_MS.length - 1)];
  return {
    action: 'restart',
    consecutiveFailures: 0,
    restartTimestamps: recent.concat(evt.now),
    delayMs,
  };
}

module.exports = { planHeadroomWatchdog, FAILURE_THRESHOLD, WINDOW_MS, MAX_RESTARTS_IN_WINDOW, BACKOFF_MS };
