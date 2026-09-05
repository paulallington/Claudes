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
 * The findings for one automation whose answer has not yet been handed to
 * it: a `decision` was asked, a `resolution` was given, and that resolution
 * carries no `deliveredAt` stamp.
 *
 * The undelivered filter is what makes the block's header honest. Without
 * it every answer ever given is re-injected on every subsequent run under a
 * heading that says "since your last run", and the automation re-actions
 * decisions it already carried out — refiling mail, resending replies —
 * while the prompt grows without bound.
 * @param {{version: 1, findings: Array}} store
 * @param {string} automationId
 * @returns {Array}
 */
function pendingResolvedFindings(store, automationId) {
  return FindingsStore.listFindings(store, {}).filter(function (f) {
    return f.automationId === automationId && f.decision && f.resolution && !f.resolution.deliveredAt;
  });
}

/**
 * Build the "RESOLUTIONS SINCE YOUR LAST RUN" prompt block for one
 * automation, or '' when it has nothing undelivered to report. Only findings
 * that carry both a `decision` and a `resolution` qualify — an
 * acknowledge-only finding never had a question to answer.
 * @param {{version: 1, findings: Array}} store
 * @param {string} automationId
 * @returns {string}
 */
function buildResolutionsBlock(store, automationId) {
  var findings = pendingResolvedFindings(store, automationId);
  if (!findings.length) return '';

  var lines = findings.map(function (f) {
    var line = keyFromFingerprint(f) + ': ' + (f.resolution.choiceId != null ? f.resolution.choiceId : '');
    if (f.resolution.text) line += ' — "' + f.resolution.text + '"';
    return line;
  });

  return '\n\n--- RESOLUTIONS SINCE YOUR LAST RUN ---\n' + lines.join('\n') + '\n--- END RESOLUTIONS ---';
}

/**
 * The finding ids that `buildResolutionsBlock` just reported, for stamping
 * via `FindingsStore.markResolutionsDelivered`. Same filter, so the two can
 * never disagree about what was delivered.
 * @param {{version: 1, findings: Array}} store
 * @param {string} automationId
 * @returns {Array<string>}
 */
function pendingResolutionIds(store, automationId) {
  return pendingResolvedFindings(store, automationId).map(function (f) { return f.id; });
}

var api = {
  buildResolutionsBlock: buildResolutionsBlock,
  pendingResolutionIds: pendingResolutionIds,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.FindingsResolutionInjection = api;
}

})();
