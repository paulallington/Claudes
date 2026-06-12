// Decide whether a column's Claude Code hooks look "stale" — i.e. it has done
// genuine user work but the app has received NO hook event for it, which happens
// when an app restart rotated the hook endpoint out from under an already-running
// session. Pure + side-effect free so it's unit-testable.
// @param col  column-like { createdAt, hasUserInput, sessionId, activityState, hookEverSeen }
// @param now  Date.now()
// @param opts { voiceEnabled, muted, minAgeMs? }
function shouldFlagStaleHooks(col, now, opts) {
  opts = opts || {};
  if (!col) return false;
  if (!opts.voiceEnabled || opts.muted) return false;     // only when voice is on for this project
  if (!col.hasUserInput) return false;                    // user has actually engaged the column
  if (!col.sessionId) return false;                       // session established
  if (col.activityState === 'exited') return false;       // dead column
  if (col.hookEverSeen) return false;                     // hooks ARE arriving — healthy
  var minAge = typeof opts.minAgeMs === 'number' ? opts.minAgeMs : 60000;
  if (!col.createdAt || (now - col.createdAt) < minAge) return false; // grace for first hook
  return true;
}

module.exports = { shouldFlagStaleHooks };

if (typeof window !== 'undefined') {
  window.StaleHooks = { shouldFlagStaleHooks };
}
