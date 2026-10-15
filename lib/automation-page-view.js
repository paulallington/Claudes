/**
 * Pure view-model for the full-window automation page: run-list items, status
 * markers, time/duration labels and the in-output Find count. No fs, no
 * Electron, no DOM. Takes the run-history entries `automations:getAgentHistory`
 * / `automations:getManagerHistory` return (see getAgentHistory in main.js).
 */
(function () {
'use strict';

/**
 * Compact duration label: '<1s', '12s', '4m 12s', '1h 3m'. Empty for a
 * missing or invalid value.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
  var totalSec = Math.floor(ms / 1000);
  if (totalSec < 1) return '<1s';
  if (totalSec < 60) return totalSec + 's';
  var mins = Math.floor(totalSec / 60);
  if (mins < 60) return mins + 'm ' + (totalSec % 60) + 's';
  return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
}

// Statuses main.js writes: agent runs finish as completed / error /
// interrupted (finalizeAgentRun), headless adds cancelled, a skipped run is
// reported by runAgent, and managers end as error / escalated / acted /
// resolved. 'success' is accepted for any caller that normalises first.
var STATUS_MARKERS = {
  completed: { glyph: '✓', cls: 'run-ok', label: 'Succeeded' },
  success: { glyph: '✓', cls: 'run-ok', label: 'Succeeded' },
  acted: { glyph: '✓', cls: 'run-ok', label: 'Acted' },
  resolved: { glyph: '✓', cls: 'run-ok', label: 'Resolved' },
  error: { glyph: '✗', cls: 'run-error', label: 'Failed' },
  escalated: { glyph: '!', cls: 'run-attention', label: 'Needs you' },
  running: { glyph: '▶', cls: 'run-live', label: 'Running' },
  interrupted: { glyph: '■', cls: 'run-warn', label: 'Interrupted' },
  cancelled: { glyph: '■', cls: 'run-warn', label: 'Cancelled' },
  skipped: { glyph: '○', cls: 'run-skipped', label: 'Skipped' },
};

/**
 * Glyph, CSS class and plain-English label for a run or manager status.
 * @param {string} status
 * @returns {{glyph: string, cls: string, label: string}}
 */
function runStatusMarker(status) {
  var known = typeof status === 'string' && Object.prototype.hasOwnProperty.call(STATUS_MARKERS, status)
    ? STATUS_MARKERS[status] : null;
  if (known) return { glyph: known.glyph, cls: known.cls, label: known.label };
  return { glyph: '•', cls: 'run-unknown', label: (typeof status === 'string' && status) ? status : 'Unknown' };
}

var api = {
  formatDuration: formatDuration,
  runStatusMarker: runStatusMarker,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.AutomationPageView = api;
}

})();
