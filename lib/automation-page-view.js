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

function toMs(now) {
  return now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now());
}

/**
 * Left-pane run list: one item per history entry, newest first, with an
 * optional live item (key 'live') in front while a run is in progress.
 * History entries are the lighter objects `getAgentHistory` returns.
 * @param {Array} history
 * @param {{liveStartedAt?: (string|null), now?: (Date|number)}} [opts]
 * @returns {Array<{key: string, isLive: boolean, startedAt: ?string, timeLabel: string, durationLabel: string, marker: Object, summary: string}>}
 */
function buildRunListItems(history, opts) {
  var o = opts && typeof opts === 'object' ? opts : {};
  var nowMs = toMs(o.now);
  var list = Array.isArray(history) ? history : [];
  var entries = [];
  for (var i = 0; i < list.length; i++) {
    var h = list[i] && typeof list[i] === 'object' ? list[i] : {};
    var t = h.startedAt ? new Date(h.startedAt).getTime() : NaN;
    entries.push({
      sortMs: isNaN(t) ? -Infinity : t,
      item: {
        key: h.startedAt ? String(h.startedAt) : String(i),
        isLive: false,
        startedAt: h.startedAt || null,
        timeLabel: formatRunTime(h.startedAt, nowMs),
        durationLabel: formatDuration(h.durationMs),
        marker: runStatusMarker(h.status),
        summary: typeof h.summary === 'string' ? h.summary : '',
      },
    });
  }
  entries.sort(function (a, b) { return a.sortMs === b.sortMs ? 0 : (b.sortMs > a.sortMs ? 1 : -1); });
  var items = entries.map(function (e) { return e.item; });
  if (o.liveStartedAt) {
    var liveMs = new Date(o.liveStartedAt).getTime();
    items.unshift({
      key: 'live',
      isLive: true,
      startedAt: o.liveStartedAt,
      timeLabel: 'Live',
      durationLabel: isNaN(liveMs) ? '' : formatDuration(Math.max(0, nowMs - liveMs)),
      marker: runStatusMarker('running'),
      summary: '',
    });
  }
  return items;
}

/**
 * Which run the right pane shows on open: the live run if any, else the
 * newest, else nothing.
 * @param {Array<{key: string, isLive: boolean}>} items
 * @returns {?string}
 */
function pickDefaultRunKey(items) {
  var list = Array.isArray(items) ? items : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].isLive) return list[i].key;
  }
  return list.length && list[0] ? list[0].key : null;
}

/**
 * Count case-insensitive, non-overlapping occurrences of `query` in `text`
 * for the output Find box. 0 for an empty query.
 * @param {string} text
 * @param {string} query
 * @returns {{matchCount: number}}
 */
function filterOutputLines(text, query) {
  var t = typeof text === 'string' ? text.toLowerCase() : '';
  var q = typeof query === 'string' ? query.toLowerCase() : '';
  var count = 0;
  if (!t || !q) return { matchCount: 0 };
  var at = t.indexOf(q);
  while (at !== -1) {
    count++;
    at = t.indexOf(q, at + q.length);
  }
  return { matchCount: count };
}

function agentTabStatus(agent) {
  if (agent && agent.currentRunStartedAt) return 'running';
  if (agent && agent.lastRunStatus === 'error') return 'error';
  return 'idle';
}

function managerTabStatus(manager) {
  if (manager.lastRunStatus === 'running') return 'running';
  if (manager.needsHuman) return 'attention';
  if (manager.lastRunStatus === 'error') return 'error';
  return 'idle';
}

/**
 * Tab strip for the agent picker: one tab per agent plus a Manager tab when
 * the manager is enabled. Empty (no strip) for a lone agent without a manager.
 * @param {object} automation
 * @returns {Array<{key: string, label: string, isManager: boolean, status: 'running'|'error'|'attention'|'idle'}>}
 */
function buildAgentTabs(automation) {
  var a = automation && typeof automation === 'object' ? automation : {};
  var agents = Array.isArray(a.agents) ? a.agents : [];
  var managerOn = !!(a.manager && a.manager.enabled);
  if (agents.length <= 1 && !managerOn) return [];
  var tabs = agents.map(function (ag) {
    return { key: ag.id, label: ag.name || ag.id, isManager: false, status: agentTabStatus(ag) };
  });
  if (managerOn) tabs.push({ key: 'manager', label: 'Manager', isManager: true, status: managerTabStatus(a.manager) });
  return tabs;
}

/**
 * Which agent tab to open on: a running agent, else the one that ran most
 * recently, else the first. Null when there are no agents.
 * @param {object} automation
 * @returns {?string}
 */
function pickDefaultAgentKey(automation) {
  var agents = automation && Array.isArray(automation.agents) ? automation.agents : [];
  if (!agents.length) return null;
  for (var i = 0; i < agents.length; i++) {
    if (agents[i] && agents[i].currentRunStartedAt) return agents[i].id;
  }
  var best = null;
  var bestMs = -Infinity;
  for (var j = 0; j < agents.length; j++) {
    var ms = agents[j] && agents[j].lastRunAt ? new Date(agents[j].lastRunAt).getTime() : NaN;
    if (!isNaN(ms) && ms > bestMs) { bestMs = ms; best = agents[j]; }
  }
  return (best || agents[0]).id;
}

var FIND_MAX_CHARS = 2000000;
var FIND_MAX_MATCHES = 5000;

/**
 * Split output into plain and matching segments for the Find highlight. The
 * query is literal text and matches case-insensitively. matchCount is always
 * the full count (same rule as filterOutputLines); segments is null when there
 * is nothing to highlight or the text is longer than opts.maxChars (count
 * only), and stops marking after opts.maxMatches so a one-letter query on a
 * huge run cannot create a mark per character.
 * @param {string} text
 * @param {string} query
 * @param {{maxChars?: number, maxMatches?: number}} [opts]
 * @returns {{matchCount: number, segments: ?Array<{text: string, match: boolean}>}}
 */
function splitMatches(text, query, opts) {
  if (typeof text !== 'string' || typeof query !== 'string' || !query) return { matchCount: 0, segments: null };
  var o = opts && typeof opts === 'object' ? opts : {};
  var maxChars = typeof o.maxChars === 'number' ? o.maxChars : FIND_MAX_CHARS;
  var maxMatches = typeof o.maxMatches === 'number' ? o.maxMatches : FIND_MAX_MATCHES;
  var matchCount = filterOutputLines(text, query).matchCount;
  if (text.length > maxChars) return { matchCount: matchCount, segments: null };
  var re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  var segments = [];
  var last = 0;
  var marked = 0;
  var m;
  while (marked < maxMatches && (m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), match: false });
    segments.push({ text: m[0], match: true });
    last = m.index + m[0].length;
    marked++;
  }
  if (last < text.length) segments.push({ text: text.slice(last), match: false });
  return { matchCount: matchCount, segments: segments };
}

/**
 * Whether a scroll pane is close enough to its end that new output should keep
 * it pinned there. A user who has scrolled further up is left alone.
 * @param {number} scrollTop
 * @param {number} clientHeight
 * @param {number} scrollHeight
 * @param {number} [threshold] px, default 40
 * @returns {boolean}
 */
function isNearBottom(scrollTop, clientHeight, scrollHeight, threshold) {
  var limit = typeof threshold === 'number' ? threshold : 40;
  var gap = scrollHeight - scrollTop - clientHeight;
  return isFinite(gap) && gap <= limit;
}

var api = {
  splitMatches: splitMatches,
  isNearBottom: isNearBottom,
  buildAgentTabs: buildAgentTabs,
  pickDefaultAgentKey: pickDefaultAgentKey,
  filterOutputLines: filterOutputLines,
  pickDefaultRunKey: pickDefaultRunKey,
  buildRunListItems: buildRunListItems,
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
