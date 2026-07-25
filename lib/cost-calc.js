// Pricing is looked up per exact model id (with a family-generic fallback
// for unpinned ids) from lib/claude-models.js — the single source of truth
// for model facts. Do not hardcode a price or model id here.
const ClaudeModels = (typeof module !== 'undefined' && module.exports)
  ? require('./claude-models')
  : (typeof window !== 'undefined' ? window.ClaudeModels : null);

function classify(model) {
  return ClaudeModels ? ClaudeModels.familyOf(model) : null;
}

// Returns a number (USD). Returns 0 for unknown model.
function sessionCost({ model, input = 0, cacheCreation = 0, cacheRead = 0, output = 0 }) {
  const p = ClaudeModels && ClaudeModels.pricesFor(model);
  if (!p) return 0;
  const cost =
    (input         / 1e6) * p.input +
    (output        / 1e6) * p.output +
    (cacheRead     / 1e6) * p.cacheRead +
    (cacheCreation / 1e6) * p.cacheCreation;
  return cost;
}

module.exports = { sessionCost, classify };
