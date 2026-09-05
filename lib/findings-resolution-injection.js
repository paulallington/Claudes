/**
 * Turns resolved decisions in the findings store into the prompt block an
 * automation reads back at its next spawn — the "answer" half of the
 * decisions pane (see docs/superpowers/specs/2026-09-05-decisions-pane-design.md).
 * Pure — no fs, no Electron. Callers (main.js's runAgent) load the store and
 * append the block to the agent's prompt themselves.
 */
(function () {
'use strict';

var FindingsStore = (typeof module !== 'undefined' && module.exports)
  ? require('./findings-store')
  : window.FindingsStore;

/**
 * Recover the business `key` an automation reported on `item.key` from a
 * finding's fingerprint. `fingerprintFinding` requires a non-empty key
 * whenever `item.decision` is set (see findings-store.js), so a finding with
 * a decision always has a fingerprint of the exact shape
 * `automationId:agentId:key` — stripping that prefix is safe here in a way
 * it would not be for a summary-hash fingerprint.
 * @param {{automationId?: string, agentId?: string, fingerprint?: string, id: string}} finding
 * @returns {string}
 */
function keyFromFingerprint(finding) {
  var prefix = (finding.automationId || '') + ':' + (finding.agentId || '') + ':';
  if (typeof finding.fingerprint === 'string' && finding.fingerprint.indexOf(prefix) === 0) {
    return finding.fingerprint.slice(prefix.length);
  }
  return finding.fingerprint || finding.id;
}

/**
 * Build the "RESOLUTIONS SINCE YOUR LAST RUN" prompt block for one
 * automation, or '' when it has nothing resolved to report. Only findings
 * that carry both a `decision` and a `resolution` qualify — an
 * acknowledge-only finding never had a question to answer.
 * @param {{version: 1, findings: Array}} store
 * @param {string} automationId
 * @returns {string}
 */
function buildResolutionsBlock(store, automationId) {
  var findings = FindingsStore.listFindings(store, {}).filter(function (f) {
    return f.automationId === automationId && f.decision && f.resolution;
  });
  if (!findings.length) return '';

  var lines = findings.map(function (f) {
    var line = keyFromFingerprint(f) + ': ' + (f.resolution.choiceId != null ? f.resolution.choiceId : '');
    if (f.resolution.text) line += ' — "' + f.resolution.text + '"';
    return line;
  });

  return '\n\n--- RESOLUTIONS SINCE YOUR LAST RUN ---\n' + lines.join('\n') + '\n--- END RESOLUTIONS ---';
}

var api = {
  buildResolutionsBlock: buildResolutionsBlock,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.FindingsResolutionInjection = api;
}

})();
