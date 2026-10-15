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

var api = {
  automationRowState: automationRowState,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.AutomationSidebarView = api;
}

})();
