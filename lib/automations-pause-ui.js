/**
 * Pure UI-resolution helpers for the two unrelated "pause" concepts in
 * Automations: the GLOBAL scheduler pause (`globalEnabled` in
 * automations.json — when false, main.js never fires a scheduled tick for
 * ANY automation) and the PER-AUTOMATION `enabled` flag (the sidebar panel's
 * pause/resume-all, scoped to the active project). These used to share the
 * same ❚❚/▶ glyph vocabulary with no visual link between them, so a global
 * pause was invisible in the per-project card list. This module gives both
 * concepts an explicit, testable rendering.
 */

/**
 * Resolve the toolbar flyout's global-pause banner/toggle presentation.
 * A missing/undefined globalEnabled is treated as ENABLED (not paused) —
 * the persisted default is true, and only an explicit false means paused.
 * @param {{ globalEnabled?: boolean }} opts
 * @returns {{ paused: boolean, showBanner: boolean, bannerText: string, toggleGlyph: string, toggleTitle: string }}
 */
function resolveGlobalPauseUi(opts) {
  var globalEnabled = opts && opts.globalEnabled;
  var paused = globalEnabled === false;
  return {
    paused: paused,
    showBanner: paused,
    bannerText: paused ? 'Scheduler paused — no scheduled runs will start.' : '',
    toggleGlyph: paused ? '▶' : '❚❚',
    toggleTitle: paused ? 'Resume scheduler' : 'Pause scheduler',
  };
}

/**
 * Resolve an automation card's status class/badge, folding in the global
 * scheduler pause without displacing any existing status signal. Precedence
 * (highest first): disabled > running (a manual run can be in flight even
 * while the scheduler is paused) > error > globally-paused > idle. Global
 * pause only ever displaces idle.
 * @param {{ globalEnabled?: boolean, automation?: { enabled?: boolean, agents?: Array<{ currentRunStartedAt?: any, lastRunStatus?: string }> } }} opts
 * @returns {{ statusClass: string, badgeClass: string, badgeText: string, dimmed: boolean }}
 */
function resolveAutomationCardStatus(opts) {
  var globalEnabled = opts && opts.globalEnabled;
  var automationProvided = opts && opts.automation;
  var automation = automationProvided || {};
  var agents = Array.isArray(automation.agents) ? automation.agents : [];
  // A missing automation isn't "disabled" — there's nothing to disable — so it
  // falls through to idle/paused rather than the disabled rung.
  var enabled = automationProvided ? !!automation.enabled : true;
  var paused = globalEnabled === false;

  var anyRunning = agents.some(function (ag) { return !!(ag && ag.currentRunStartedAt); });
  var anyError = agents.some(function (ag) { return ag && ag.lastRunStatus === 'error'; });

  var statusClass = 'automation-idle';
  var badgeClass = 'badge-idle';
  var badgeText = 'idle';

  if (!enabled) {
    statusClass = 'automation-disabled'; badgeClass = 'badge-disabled'; badgeText = 'disabled';
  } else if (anyRunning) {
    statusClass = 'automation-running'; badgeClass = 'badge-running'; badgeText = 'running...';
  } else if (anyError) {
    statusClass = 'automation-error'; badgeClass = 'badge-error'; badgeText = 'error';
  } else if (paused) {
    statusClass = 'automation-paused'; badgeClass = 'badge-paused'; badgeText = 'paused';
  }

  return {
    statusClass: statusClass,
    badgeClass: badgeClass,
    badgeText: badgeText,
    // Dim only the paused rung itself — a running/error card is the one
    // thing actually active (e.g. a manual run started during a global
    // pause) and shouldn't read as inactive.
    dimmed: badgeText === 'paused',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveGlobalPauseUi, resolveAutomationCardStatus };
}
if (typeof window !== 'undefined') {
  window.AutomationsPauseUi = { resolveGlobalPauseUi, resolveAutomationCardStatus };
}
