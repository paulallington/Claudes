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

var api = {
  formatDuration: formatDuration,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.AutomationPageView = api;
}

})();
