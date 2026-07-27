// Selects and orders codex-companion job records for one Claude session.
//
// Job records live in <state-root>/<workspaceKey>/state.json. A single Claude
// session can own jobs in more than one state dir, because EnterWorktree moves
// the session's cwd and the plugin keys its state dir by git repo root — so
// callers pass every scanned dir and we filter by sessionId.

var ACTIVE = ['queued', 'running'];

function isActiveStatus(status) {
  return ACTIVE.indexOf(String(status || '')) !== -1;
}

function toMs(value) {
  if (!value) return null;
  var ms = Date.parse(value);
  return isNaN(ms) ? null : ms;
}

function selectSessionJobs(scans, sessionId, nowMs) {
  if (!Array.isArray(scans) || !sessionId) return [];

  var out = [];
  for (var i = 0; i < scans.length; i++) {
    var scan = scans[i] || {};
    var jobs = Array.isArray(scan.jobs) ? scan.jobs : [];
    for (var j = 0; j < jobs.length; j++) {
      var job = jobs[j] || {};
      if (job.sessionId !== sessionId) continue;

      var active = isActiveStatus(job.status);
      var startMs = toMs(job.createdAt);
      var endMs = active ? nowMs : (toMs(job.completedAt) || toMs(job.updatedAt) || nowMs);

      out.push({
        id: job.id,
        workspaceKey: scan.workspaceKey,
        title: job.title || job.kind || 'Codex job',
        status: job.status || 'unknown',
        phase: job.phase || null,
        createdAt: job.createdAt || null,
        elapsedMs: startMs === null ? null : Math.max(0, endMs - startMs),
        active: active
      });
    }
  }

  // Active first, then newest first. Jobs without a usable createdAt sort last.
  out.sort(function (a, b) {
    if (a.active !== b.active) return a.active ? -1 : 1;
    var am = toMs(a.createdAt);
    var bm = toMs(b.createdAt);
    if (am === null && bm === null) return 0;
    if (am === null) return 1;
    if (bm === null) return -1;
    return bm - am;
  });

  return out;
}

function summariseCounts(descriptors) {
  var list = Array.isArray(descriptors) ? descriptors : [];
  var running = 0;
  for (var i = 0; i < list.length; i++) if (list[i].active) running++;
  return { total: list.length, running: running };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { selectSessionJobs, summariseCounts, isActiveStatus };
}
if (typeof window !== 'undefined') {
  window.CodexWatchJobs = { selectSessionJobs, summariseCounts, isActiveStatus };
}
