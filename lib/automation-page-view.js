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

var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/**
 * Local-time label for a run: 'HH:MM' today, 'Yesterday HH:MM', 'Mon 09:00'
 * within the last 6 days, otherwise '3 Oct 09:00'. `now` (Date or ms) is
 * injected so tests are deterministic.
 * @param {string} iso
 * @param {Date|number} [now]
 * @returns {string}
 */
function formatRunTime(iso, now) {
  if (!iso) return '';
  var then = new Date(iso);
  if (isNaN(then.getTime())) return '';
  var nowDate = now instanceof Date ? now : (typeof now === 'number' ? new Date(now) : new Date());
  var hhmm = pad2(then.getHours()) + ':' + pad2(then.getMinutes());
  // Calendar-day difference in local time (DST-safe via UTC day numbers).
  var dayNum = function (d) { return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000); };
  var diff = dayNum(nowDate) - dayNum(then);
  if (diff <= 0) return hhmm;
  if (diff === 1) return 'Yesterday ' + hhmm;
  if (diff <= 6) return WEEKDAYS[then.getDay()] + ' ' + hhmm;
  return then.getDate() + ' ' + MONTHS[then.getMonth()] + ' ' + hhmm;
}

var api = {
  formatRunTime: formatRunTime,
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
