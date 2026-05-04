// Anthropic public list prices as of plan authoring (2026-05-04).
// Update when pricing changes. All values USD per million tokens.
const MODEL_PRICES_PER_MTOK = {
  opus:   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreation: 18.75 },
  sonnet: { input:  3.00, output: 15.00, cacheRead: 0.30, cacheCreation:  3.75 },
  haiku:  { input:  1.00, output:  5.00, cacheRead: 0.10, cacheCreation:  1.25 }
};

function classify(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (m.indexOf('opus') !== -1) return 'opus';
  if (m.indexOf('sonnet') !== -1) return 'sonnet';
  if (m.indexOf('haiku') !== -1) return 'haiku';
  return null;
}

// Returns a number (USD). Returns 0 for unknown model.
function sessionCost({ model, input = 0, cacheCreation = 0, cacheRead = 0, output = 0 }) {
  const cls = classify(model);
  if (!cls) return 0;
  const p = MODEL_PRICES_PER_MTOK[cls];
  const cost =
    (input         / 1e6) * p.input +
    (output        / 1e6) * p.output +
    (cacheRead     / 1e6) * p.cacheRead +
    (cacheCreation / 1e6) * p.cacheCreation;
  return cost;
}

module.exports = { sessionCost, MODEL_PRICES_PER_MTOK, classify };
