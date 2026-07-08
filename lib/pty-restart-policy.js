'use strict';

// Decides whether the Electron main process should relaunch pty-server after it
// exits, and how long to wait first.
//
// pty-server is the sole conduit between the renderer's terminals and node-pty:
// when it dies, every column's WebSocket drops at once and the UI appears
// frozen. On Windows it crashes natively inside node-pty's ConPTY layer
// (observed as exit code 4294967295 / -1 with no JS stack), so it MUST be
// resurrected automatically — otherwise the only recovery is quitting the app.
//
// Restarts are backed off and capped: a server that can't even start (e.g. no
// system Node) would otherwise fork-bomb the host in a tight crash loop.

// Backoff schedule (ms) indexed by how many restarts have already happened in
// the current window; clamped to the last entry.
const BACKOFF_MS = [250, 500, 1000, 2000, 4000];
const WINDOW_MS = 60 * 1000;   // rolling window for crash-loop detection
const MAX_IN_WINDOW = 5;       // give up after this many restarts inside the window

// prior: array of prior restart timestamps (ms) accumulated this session.
// evt:   { isQuitting, signal, code, now }
// Returns { restart, delayMs, giveUp, recentCount, timestamps } where
// `timestamps` is the pruned/updated list the caller should store back.
function planPtyServerRestart(prior, evt) {
  const now = evt.now;

  // Never resurrect during an intentional shutdown, nor when we killed it
  // ourselves (killPtyServer sends SIGTERM, then SIGKILL). Checked before the
  // crash-loop cap so a quit is always honoured.
  if (evt.isQuitting || evt.signal === 'SIGTERM' || evt.signal === 'SIGKILL') {
    return { restart: false, delayMs: 0, giveUp: false, recentCount: 0, timestamps: prior || [] };
  }

  // Drop restarts that fell outside the rolling window — a burst that has since
  // gone quiet shouldn't count against a fresh crash hours later.
  const recent = (prior || []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_IN_WINDOW) {
    return { restart: false, delayMs: 0, giveUp: true, recentCount: recent.length, timestamps: recent };
  }

  const delayMs = BACKOFF_MS[Math.min(recent.length, BACKOFF_MS.length - 1)];
  return {
    restart: true,
    delayMs,
    giveUp: false,
    recentCount: recent.length + 1,
    timestamps: recent.concat(now),
  };
}

module.exports = { planPtyServerRestart, BACKOFF_MS, WINDOW_MS, MAX_IN_WINDOW };
