// Delay policy for self-rescheduling pollers. A fixed 150ms setInterval per
// Clawd tail meant ~53 stat calls/s with 8 columns, nearly all on idle
// sessions. Back off while the file is quiet, snap back on the first change.
function nextPollDelay(prevDelay, changed, opts) {
  const min = (opts && opts.min) || 150;
  const max = (opts && opts.max) || 1000;
  if (changed) return min;
  const prev = typeof prevDelay === 'number' && isFinite(prevDelay) && prevDelay > 0 ? prevDelay : min;
  return Math.min(prev * 2, max);
}

module.exports = { nextPollDelay };
