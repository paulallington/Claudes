/**
 * Pure view-model for the automation findings inbox: grouping, relative-time
 * formatting, the "seen N times" label, per-finding action set, and the tab
 * badge count. No fs, no Electron, no DOM — takes the plain finding objects
 * `window.FindingsStore.listFindings` returns and derives what the renderer
 * needs to draw. See lib/findings-store.js for the finding shape.
 */
(function () {
'use strict';

/**
 * Bucket findings by automation, preserving the input order both across
 * groups (a group appears at the position of its first-seen member) and
 * within a group. Callers pass an already newest-`lastSeenAt`-first list
 * (as returned by `FindingsStore.listFindings`), so this keeps that order —
 * it does not re-sort.
 * @param {Array<{automationId, automationName}>} findings
 * @returns {Array<{automationId: string, automationName: string, findings: Array}>}
 */
function groupFindingsByAutomation(findings) {
  var list = Array.isArray(findings) ? findings : [];
  var order = [];
  var byId = Object.create(null);
  for (var i = 0; i < list.length; i++) {
    var f = list[i] || {};
    var id = f.automationId || '';
    var group = byId[id];
    if (!group) {
      group = { automationId: f.automationId || null, automationName: f.automationName || null, findings: [] };
      byId[id] = group;
      order.push(group);
    }
    group.findings.push(f);
  }
  return order;
}

/**
 * Format an ISO timestamp as a short relative-time string ("3m ago"),
 * mirroring renderer.js's `formatRelativeTime` but taking `now` explicitly
 * so it's deterministic under test.
 * @param {string} iso
 * @param {string|Date} [now]
 * @returns {string}
 */
function formatFindingRelativeTime(iso, now) {
  if (!iso) return '';
  var nowMs = now instanceof Date ? now.getTime() : (typeof now === 'string' ? new Date(now).getTime() : Date.now());
  var then = new Date(iso).getTime();
  var diffSec = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (diffSec < 60) return diffSec + 's ago';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm ago';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h ago';
  return Math.floor(diffSec / 86400) + 'd ago';
}

/**
 * A quiet "seen N times" label for a recurring finding — context, not
 * emphasis, so it's only produced once a finding has actually recurred.
 * @param {number} occurrences
 * @returns {string|null}
 */
function occurrenceLabel(occurrences) {
  var n = typeof occurrences === 'number' ? occurrences : 0;
  if (n <= 1) return null;
  return 'Seen ' + n + ' times';
}

/**
 * Decide the conversation action for a finding. Older runs never recorded a
 * `sessionId`, so there's no live column to resume — offer the
 * append-system-prompt "discuss" fallback instead of a dead resume button.
 * @param {{sessionId?: string}} finding
 * @returns {{type: 'resume'|'discuss', label: string}}
 */
function findingConversationAction(finding) {
  var f = finding && typeof finding === 'object' ? finding : {};
  if (typeof f.sessionId === 'string' && f.sessionId) {
    return { type: 'resume', label: 'Open conversation' };
  }
  return { type: 'discuss', label: 'Discuss finding' };
}

/**
 * Count unacknowledged findings for the Automations tab badge. Safe to call
 * with either an unacknowledged-only list or the full list.
 * @param {Array<{acknowledgedAt?: string|null}>} findings
 * @returns {number}
 */
function unacknowledgedBadgeCount(findings) {
  var list = Array.isArray(findings) ? findings : [];
  var count = 0;
  for (var i = 0; i < list.length; i++) {
    if (!list[i] || !list[i].acknowledgedAt) count++;
  }
  return count;
}

/**
 * Shape a finding's `decision` for rendering — option buttons, an optional
 * free-text box, and whether it's already been answered. Returns `null` for
 * a finding with no decision, so callers can render nothing at all.
 * @param {{decision?: *, resolution?: *}} finding
 * @returns {{prompt: (string|null), options: Array, freeText: boolean, resolved: boolean}|null}
 */
function decisionViewModel(finding) {
  var f = finding && typeof finding === 'object' ? finding : {};
  if (!f.decision) return null;
  return {
    prompt: f.decision.prompt != null ? f.decision.prompt : null,
    options: Array.isArray(f.decision.options) ? f.decision.options : [],
    freeText: !!f.decision.freeText,
    resolved: !!f.resolution,
  };
}

/**
 * A muted "Resolved as: <label> (<when>)" string for an already-answered
 * decision, or `null` when unresolved. Prefers the matching option's
 * `label` over the raw `choiceId` so free-text-only answers or options
 * dropped between runs still degrade to something readable.
 * @param {{decision?: {options?: Array}, resolution?: {choiceId?: string, resolvedAt?: string}}} finding
 * @param {string|Date} [now]
 * @returns {string|null}
 */
function resolutionSummaryLabel(finding, now) {
  var f = finding && typeof finding === 'object' ? finding : {};
  if (!f.resolution) return null;
  var options = (f.decision && Array.isArray(f.decision.options)) ? f.decision.options : [];
  var match = options.filter(function (o) { return o && o.id === f.resolution.choiceId; })[0];
  var choiceLabel = match ? match.label : f.resolution.choiceId;
  var when = formatFindingRelativeTime(f.resolution.resolvedAt, now);
  return 'Resolved as: ' + choiceLabel + (when ? ' (' + when + ')' : '');
}

var api = {
  groupFindingsByAutomation: groupFindingsByAutomation,
  formatFindingRelativeTime: formatFindingRelativeTime,
  occurrenceLabel: occurrenceLabel,
  findingConversationAction: findingConversationAction,
  unacknowledgedBadgeCount: unacknowledgedBadgeCount,
  decisionViewModel: decisionViewModel,
  resolutionSummaryLabel: resolutionSummaryLabel,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.FindingsInboxView = api;
}

})();
