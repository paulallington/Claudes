/**
 * Pure view-model for the sidebar's automation rows: the per-row state marker,
 * the open-items badge count and the tooltip. No fs, no Electron, no DOM —
 * takes the plain automation objects from `getAutomations()` and the finding
 * objects from lib/findings-store.js. State precedence mirrors
 * lib/automations-pause-ui.js `resolveAutomationCardStatus`.
 */
(function () {
'use strict';

/**
 * Resolve the state marker for one automation row. Precedence (highest
 * first): disabled > running > attention > paused (global scheduler pause) >
 * idle. A missing/undefined globalEnabled counts as enabled.
 * @param {object} automation
 * @param {{globalEnabled?: boolean}} [opts]
 * @returns {'running'|'attention'|'paused'|'disabled'|'idle'}
 */
function automationRowState(automation, opts) {
  var a = automation && typeof automation === 'object' ? automation : null;
  if (a && !a.enabled) return 'disabled';
  var agents = a && Array.isArray(a.agents) ? a.agents : [];
  var anyRunning = agents.some(function (ag) { return !!(ag && ag.currentRunStartedAt); });
  if (anyRunning) return 'running';
  var anyError = agents.some(function (ag) { return !!(ag && (ag.lastRunStatus === 'error' || ag.lastError)); });
  if (anyError || (a && a.manager && a.manager.needsHuman)) return 'attention';
  if (opts && opts.globalEnabled === false) return 'paused';
  return 'idle';
}

/**
 * Count the findings for one automation that still need the user: either
 * unacknowledged, or carrying a decision nobody has resolved. Each finding
 * counts once however many of those apply.
 * @param {Array} findings
 * @param {string} automationId
 * @returns {number}
 */
function openItemCount(findings, automationId) {
  var list = Array.isArray(findings) ? findings : [];
  var count = 0;
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    if (!f || f.automationId !== automationId) continue;
    if (!f.acknowledgedAt || (f.decision && !f.resolution)) count++;
  }
  return count;
}

var api = {
  automationRowState: automationRowState,
  openItemCount: openItemCount,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.AutomationSidebarView = api;
}

})();
