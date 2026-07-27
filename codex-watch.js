// codex-watch.js — renderer script for the read-only Codex job-log viewer
// window. Plain classic script (no bundler, no `require`); everything comes
// in over `window.electronAPI` (see preload.js's codexWatch* bridge).
//
// Data model kept deliberately small:
//   - state.jobs        - the live job list as last reported by main.
//   - state.selection    - { workspaceKey, jobId } of the job currently shown.
//   - state.selectionEnded / state.endedSnapshot - when the selected job's
//     record disappears from the live list (SessionEnd cleanup), we keep
//     showing its tab and its already-rendered content rather than clearing
//     the pane. `endedSnapshot` is the last-known job descriptor, used only
//     to keep rendering its sidebar row.

(function () {
  'use strict';

  var state = {
    sessionId: '',
    title: '',
    jobs: [],
    selection: null,
    selectionEnded: false,
    endedSnapshot: null
  };

  function jobKeyOf(job) {
    return String(job.workspaceKey) + '::' + String(job.id);
  }

  function selectionKey() {
    if (!state.selection) return null;
    return String(state.selection.workspaceKey) + '::' + String(state.selection.jobId);
  }

  function formatElapsed(ms) {
    if (ms === null || ms === undefined || isNaN(ms)) return '—';
    var totalSec = Math.floor(ms / 1000);
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + ':' + (s < 10 ? '0' + s : String(s));
  }

  // --- Job sidebar -----------------------------------------------------

  function jobsForDisplay() {
    var list = state.jobs.slice();
    if (state.selectionEnded && state.endedSnapshot) {
      var sk = selectionKey();
      var present = list.some(function (j) { return jobKeyOf(j) === sk; });
      if (!present) list.push(state.endedSnapshot);
    }
    return list;
  }

  function buildJobRow(job) {
    var key = jobKeyOf(job);
    var isSelected = key === selectionKey();
    var isEndedRow = isSelected && state.selectionEnded;

    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'cw-job' + (isSelected ? ' cw-job-selected' : '') + (isEndedRow ? ' cw-job-ended' : '');

    var dot = document.createElement('span');
    dot.className = 'cw-job-dot' + (job.active ? ' cw-job-dot-active' : '');
    row.appendChild(dot);

    var titleEl = document.createElement('span');
    titleEl.className = 'cw-job-title';
    titleEl.textContent = job.title || 'Codex job';
    row.appendChild(titleEl);

    var elapsedEl = document.createElement('span');
    elapsedEl.className = 'cw-job-elapsed';
    elapsedEl.textContent = formatElapsed(job.elapsedMs);
    row.appendChild(elapsedEl);

    row.addEventListener('click', function () {
      if (isEndedRow) return; // frozen - nothing left to (re)fetch
      selectJob(job);
    });

    return row;
  }

  function renderJobList() {
    var container = document.getElementById('cwJobs');
    container.textContent = '';
    jobsForDisplay().forEach(function (job) {
      container.appendChild(buildJobRow(job));
    });
  }

  // --- Event pane --------------------------------------------------------

  var previewRowEl = null;

  function removePreviewRow() {
    if (previewRowEl && previewRowEl.parentNode) previewRowEl.parentNode.removeChild(previewRowEl);
    previewRowEl = null;
  }

  function buildEventRow(evt, isPreview) {
    var type = evt.type || 'status';
    var row = document.createElement('div');
    row.className = 'cw-event cw-event-' + type + (isPreview ? ' cw-event-preview' : '');

    var main = document.createElement('div');
    main.className = 'cw-event-main';

    if (type === 'command') {
      var prefix = document.createElement('span');
      prefix.className = 'cw-event-prefix';
      prefix.textContent = '$';
      main.appendChild(prefix);

      var cmdMsg = document.createElement('span');
      cmdMsg.className = 'cw-event-mono';
      cmdMsg.textContent = evt.message || '';
      main.appendChild(cmdMsg);
    } else if (type === 'command-result') {
      row.classList.add(evt.ok ? 'cw-event-ok' : 'cw-event-fail');

      var resultMsg = document.createElement('span');
      resultMsg.className = 'cw-event-mono';
      var codeSuffix = (evt.exitCode === null || evt.exitCode === undefined) ? '' : ' (exit ' + evt.exitCode + ')';
      resultMsg.textContent = (evt.message || '') + codeSuffix;
      main.appendChild(resultMsg);
    } else if (type === 'assistant') {
      var prose = document.createElement('div');
      prose.className = 'cw-event-prose';
      prose.textContent = evt.body ? evt.body : (evt.message || '');
      main.appendChild(prose);
    } else {
      var statusText = document.createElement('span');
      statusText.className = 'cw-event-status-text';
      statusText.textContent = evt.message || '';
      main.appendChild(statusText);
    }

    row.appendChild(main);

    if (evt.truncated) {
      var trunc = document.createElement('span');
      trunc.className = 'cw-event-truncated';
      trunc.textContent = '…';
      trunc.title = 'Truncated by the Codex logging plugin';
      row.appendChild(trunc);
    }

    return row;
  }

  function isPinnedToBottom() {
    var stream = document.getElementById('cwStream');
    return (stream.scrollHeight - stream.scrollTop - stream.clientHeight) <= 40;
  }

  function afterAppend(wasPinned) {
    var stream = document.getElementById('cwStream');
    if (wasPinned) {
      stream.scrollTop = stream.scrollHeight;
      hideJump();
    } else {
      showJump();
    }
  }

  function showJump() {
    document.getElementById('cwJump').classList.remove('cw-hidden');
  }

  function hideJump() {
    document.getElementById('cwJump').classList.add('cw-hidden');
  }

  function appendEvents(events) {
    if (!events || !events.length) return;
    var wasPinned = isPinnedToBottom();
    removePreviewRow(); // finalized events land before any updated preview row
    var container = document.getElementById('cwEvents');
    events.forEach(function (evt) {
      container.appendChild(buildEventRow(evt, false));
    });
    afterAppend(wasPinned);
  }

  function renderPreview(preview) {
    var wasPinned = isPinnedToBottom();
    removePreviewRow();
    if (!preview) return;
    var container = document.getElementById('cwEvents');
    previewRowEl = buildEventRow(preview, true);
    container.appendChild(previewRowEl);
    afterAppend(wasPinned);
  }

  function appendStatusRow(message) {
    var wasPinned = isPinnedToBottom();
    removePreviewRow();
    var container = document.getElementById('cwEvents');
    container.appendChild(buildEventRow({ type: 'status', message: message }, false));
    afterAppend(wasPinned);
  }

  function clearPane() {
    document.getElementById('cwEvents').textContent = '';
    previewRowEl = null;
    showStream();
  }

  function showEmpty() {
    document.getElementById('cwEmpty').classList.remove('cw-hidden');
    document.getElementById('cwEvents').classList.add('cw-hidden');
  }

  function showStream() {
    document.getElementById('cwEmpty').classList.add('cw-hidden');
    document.getElementById('cwEvents').classList.remove('cw-hidden');
  }

  // --- Selection / streaming ----------------------------------------------

  function selectJob(job) {
    var newKey = jobKeyOf(job);
    if (newKey === selectionKey()) return;

    var prevSelection = state.selection;
    if (prevSelection) {
      window.electronAPI.codexWatchCloseStream({
        workspaceKey: prevSelection.workspaceKey,
        jobId: prevSelection.jobId
      });
    }

    state.selection = { workspaceKey: job.workspaceKey, jobId: job.id };
    state.selectionEnded = false;
    state.endedSnapshot = null;
    clearPane();
    renderJobList();

    window.electronAPI.codexWatchOpenStream({
      workspaceKey: job.workspaceKey,
      jobId: job.id
    }).then(function (res) {
      if (!res || !res.ok) return;
      if (jobKeyOf(job) !== selectionKey()) return; // superseded by another switch
      appendEvents(res.events || []);
      renderPreview(res.preview || null);
    }).catch(function (err) {
      if (jobKeyOf(job) !== selectionKey()) return;
      appendStatusRow('Failed to open stream: ' + ((err && err.message) || err));
    });
  }

  function updateJobs(jobs) {
    var list = Array.isArray(jobs) ? jobs : [];
    var sk = selectionKey();

    if (sk && !state.selectionEnded) {
      var stillThere = list.some(function (j) { return jobKeyOf(j) === sk; });
      if (!stillThere) {
        var prevJob = null;
        for (var i = 0; i < state.jobs.length; i++) {
          if (jobKeyOf(state.jobs[i]) === sk) { prevJob = state.jobs[i]; break; }
        }
        state.endedSnapshot = prevJob || {
          workspaceKey: state.selection.workspaceKey,
          id: state.selection.jobId,
          title: 'Codex job',
          status: 'ended',
          active: false,
          elapsedMs: null
        };
        state.selectionEnded = true;
        appendStatusRow('Job record ended.');
      }
    }

    state.jobs = list;
    renderJobList();

    // Nothing selected yet (fresh window with no jobs at load time) - pick
    // one up as soon as the list is non-empty.
    if (!state.selection && list.length) selectJob(list[0]);
  }

  // --- Wiring ---------------------------------------------------------

  function init() {
    var params = new URLSearchParams(window.location.search);
    state.sessionId = params.get('sessionId') || '';
    state.title = params.get('title') || '';
    document.title = 'Codex · ' + state.title;

    document.getElementById('cwJump').addEventListener('click', function () {
      var stream = document.getElementById('cwStream');
      stream.scrollTop = stream.scrollHeight;
      hideJump();
    });

    window.electronAPI.codexWatchListJobs({ sessionId: state.sessionId }).then(function (res) {
      var jobs = (res && res.ok && res.jobs) || [];
      state.jobs = jobs;
      renderJobList();
      if (jobs.length) selectJob(jobs[0]);
      else if (!state.selection) showEmpty(); // a pushed codexwatch:jobs update may have already populated the pane
    }).catch(function (err) {
      if (state.selection) return; // a pushed codexwatch:jobs update already populated the pane
      showStream();
      appendStatusRow('Failed to load jobs: ' + ((err && err.message) || err));
    });

    window.electronAPI.onCodexWatchJobs(function (payload) {
      updateJobs(payload && payload.jobs);
    });

    window.electronAPI.onCodexWatchDelta(function (payload) {
      if (!payload || !state.selection) return;
      if (payload.workspaceKey !== state.selection.workspaceKey || payload.jobId !== state.selection.jobId) return;
      appendEvents(payload.events);
      renderPreview(payload.preview);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
