const WINDOWS = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus', 'seven_day_omelette'];
const THRESHOLDS = [70, 90];

function getUtil(data, key) {
  if (!data) return null;
  const slot = data[key];
  if (!slot || typeof slot.utilization !== 'number') return null;
  return slot.utilization;
}

// Returns [{ window, threshold, value }] for thresholds crossed UPWARD between prev and next.
// First observation (prev === null) returns []. Downward crossings (resets) return [].
function detectCrossings(prev, next) {
  const out = [];
  if (!prev || !next) return out;
  for (const w of WINDOWS) {
    const p = getUtil(prev, w);
    const n = getUtil(next, w);
    if (p == null || n == null) continue;
    for (const t of THRESHOLDS) {
      if (p < t && n >= t) out.push({ window: w, threshold: t, value: n });
    }
  }
  return out;
}

module.exports = { detectCrossings, WINDOWS, THRESHOLDS };
