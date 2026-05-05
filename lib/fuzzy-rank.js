// Lightweight subsequence-based fuzzy ranker.
// Score = +100 for substring at start, +50 for substring anywhere, +1 per
// char of subsequence match (with -1 penalty per char gap between matches).
// Returns items sorted desc by score; non-matches dropped. Stable for ties.
function score(label, q) {
  if (!q) return 0;
  const lab = label.toLowerCase();
  const query = q.toLowerCase();
  if (lab.startsWith(query)) return 1000 + (label.length - query.length === 0 ? 50 : 0);
  const idx = lab.indexOf(query);
  if (idx !== -1) return 500 - idx;

  let s = 0, qi = 0, lastMatch = -1;
  for (let i = 0; i < lab.length && qi < query.length; i++) {
    if (lab[i] === query[qi]) {
      s += 5;
      if (lastMatch >= 0) s -= (i - lastMatch - 1);  // gap penalty
      lastMatch = i;
      qi++;
    }
  }
  if (qi < query.length) return -1;  // not all chars matched
  return s;
}

function fuzzyRank(items, query, getLabel) {
  if (!query) return items.slice();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const s = score(getLabel(items[i]), query);
    if (s < 0) continue;
    out.push({ idx: i, item: items[i], score: s });
  }
  out.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return out.map(o => o.item);
}

module.exports = { fuzzyRank, score };
