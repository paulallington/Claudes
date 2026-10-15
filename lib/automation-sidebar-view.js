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

/**
 * Open-item counts for every automation in one pass: { [automationId]: count },
 * same rule as openItemCount. Findings without an automationId are skipped and
 * automations with no open items are absent. Lets main send counts over IPC
 * instead of the whole findings store.
 * @param {Array} findings
 * @returns {Object<string, number>}
 */
function openItemCounts(findings) {
  var list = Array.isArray(findings) ? findings : [];
  var counts = {};
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    if (!f || !f.automationId) continue;
    if (!f.acknowledgedAt || (f.decision && !f.resolution)) counts[f.automationId] = (counts[f.automationId] || 0) + 1;
  }
  return counts;
}

/**
 * Normalise a project path for use as a lookup key (forward slashes), so the
 * renderer can find a project's rows from `project.path` whatever separator
 * the stored path used.
 * @param {string} p
 * @returns {string}
 */
function projectPathKey(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : '';
}

var STATE_TITLES = {
  running: 'Running',
  attention: 'Needs attention',
  paused: 'Paused (scheduler paused)',
  disabled: 'Disabled',
  idle: 'Idle',
};

/**
 * Build the sidebar row models for every automation, keyed by normalised
 * project path (see projectPathKey). Rows keep the input order within a
 * project. `dimmed` marks the inactive states (disabled, paused).
 * @param {Array} automations
 * @param {Array} findings  ignored when opts.openCounts is given
 * @param {{globalEnabled?: boolean, openCounts?: Object<string, number>}} [opts]
 * @returns {Object<string, Array<{id: string, name: string, state: string, badgeCount: number, dimmed: boolean, title: string}>>}
 */
function buildSidebarAutomationRows(automations, findings, opts) {
  var list = Array.isArray(automations) ? automations : [];
  var openCounts = opts && opts.openCounts && typeof opts.openCounts === 'object' ? opts.openCounts : null;
  var byProject = {};
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a || typeof a !== 'object') continue;
    var key = projectPathKey(a.projectPath);
    var state = automationRowState(a, opts);
    var badgeCount = openCounts ? (openCounts[a.id] || 0) : openItemCount(findings, a.id);
    var title = STATE_TITLES[state];
    if (badgeCount > 0) title += ' · ' + badgeCount + ' open ' + (badgeCount === 1 ? 'item' : 'items');
    if (!byProject[key]) byProject[key] = [];
    byProject[key].push({
      id: a.id,
      name: a.name,
      state: state,
      badgeCount: badgeCount,
      dimmed: state === 'disabled' || state === 'paused',
      title: title,
    });
  }
  return byProject;
}

/**
 * Ids of automation rows that should flash: the open-item badge went up, or the
 * state became 'attention', between two row sets. A row absent from `prev` is
 * not flashed, so the first load (and a freshly created automation) is quiet.
 * @param {Object<string, Array>} prevRows
 * @param {Object<string, Array>} nextRows
 * @returns {string[]}
 */
function rowsNeedingFlash(prevRows, nextRows) {
  var prevById = {};
  var prev = prevRows && typeof prevRows === 'object' ? prevRows : {};
  Object.keys(prev).forEach(function (key) {
    (prev[key] || []).forEach(function (r) { if (r && r.id) prevById[r.id] = r; });
  });
  var next = nextRows && typeof nextRows === 'object' ? nextRows : {};
  var ids = [];
  Object.keys(next).forEach(function (key) {
    (next[key] || []).forEach(function (r) {
      var old = r && prevById[r.id];
      if (!old) return;
      if (r.badgeCount > old.badgeCount || (r.state === 'attention' && old.state !== 'attention')) ids.push(r.id);
    });
  });
  return ids;
}

var api = {
  rowsNeedingFlash: rowsNeedingFlash,
  automationRowState: automationRowState,
  openItemCount: openItemCount,
  openItemCounts: openItemCounts,
  projectPathKey: projectPathKey,
  buildSidebarAutomationRows: buildSidebarAutomationRows,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.AutomationSidebarView = api;
}

})();
