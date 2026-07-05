/* global Terminal, FitAddon, WebglAddon */

var columnsContainer = document.getElementById('columns-container');
var btnAdd = document.getElementById('btn-add');
var btnAddRow = document.getElementById('btn-add-row');
var btnAddProject = document.getElementById('btn-add-project');
var btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
var projectListEl = document.getElementById('project-list');
var activeProjectNameEl = document.getElementById('active-project-name');
var sidebar = document.getElementById('sidebar');

var btnClaudeMd = document.getElementById('btn-claude-md');
var claudeMdModal = document.getElementById('claudemd-modal');
var claudeMdEditor = document.getElementById('claudemd-editor');
var claudeMdPath = document.getElementById('claudemd-path');
var claudeMdClose = document.getElementById('claudemd-close');
var claudeMdSave = document.getElementById('claudemd-save');
var claudeMdStatus = document.getElementById('claudemd-status');

var themeSelect = document.getElementById('theme-select');

var btnAddOptions = document.getElementById('btn-add-options');
var spawnDropdown = document.getElementById('spawn-dropdown');
var optPermissionMode = document.getElementById('opt-permission-mode');
var optRemoteControl = document.getElementById('opt-remote-control');
var optBare = document.getElementById('opt-bare');
var optStripMcps = document.getElementById('opt-strip-mcps');
var optHeadless = document.getElementById('opt-headless');
var optModel = document.getElementById('opt-model');
var optModelRow = document.getElementById('opt-model-row');
var optEndpoint = document.getElementById('opt-endpoint');
var optEndpointModelRow = document.getElementById('opt-endpoint-model-row');
var optEndpointModel = document.getElementById('opt-endpoint-model');
var optEndpointModelRefresh = document.getElementById('opt-endpoint-model-refresh');
var optWorktree = document.getElementById('opt-worktree');
var optCustomArgs = document.getElementById('opt-custom-args');
var optDefaultEffortCloud = document.getElementById('opt-default-effort-cloud');
var optDefaultEffortLocal = document.getElementById('opt-default-effort-local');
var btnManageEndpoints = document.getElementById('btn-manage-endpoints');

// Headroom spawn toggle. GLOBAL (config.useHeadroom), not per-project — it wraps
// every default-Claude spawn through `headroom wrap claude --` until turned off.
var optUseHeadroom = document.getElementById('opt-use-headroom');
var headroomLabel = document.getElementById('opt-headroom-label');
var headroomDashboardLink = document.getElementById('headroom-dashboard-link');
var headroomRequiredNote = document.getElementById('headroom-required-note');
var headroomInstallLink = document.getElementById('headroom-install-link');
var optHeadroom1m = document.getElementById('opt-headroom-1m');
var optHeadroomMemory = document.getElementById('opt-headroom-memory');
var optHeadroomShaper = document.getElementById('opt-headroom-shaper');
var optHeadroomAutostart = document.getElementById('opt-headroom-autostart');
var headroomSubs = document.getElementById('opt-headroom-subs');
var headroomInstalled = false;  // resolved async from main; gates wrapping + UI
var headroomProbed = false;     // true once main's post-probe status has landed (gates the not-installed prompt so it doesn't flash before the probe)

// Per-endpoint-class default effort applied at spawn. User-configurable in the
// spawn options panel; persisted in config.defaultEffortCloud/Local.
var defaultEffortCloud = 'high';
var defaultEffortLocal = 'medium';
function isValidEffort(v) {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max';
}
// 'ultracode' is selectable in the UI but is NOT a valid --effort value — it's
// enabled via --settings (xhigh + dynamic workflows). Keep it out of
// isValidEffort so it can never be passed as --effort; gate UI acceptance here.
function isSelectableEffort(v) {
  return isValidEffort(v) || v === 'ultracode';
}

// Endpoint preset state. Cached in renderer so spawn paths can attach the env
// block synchronously without waiting on an IPC round-trip per spawn.
var endpointPresets = [];        // [{ id, name, baseUrl, model, hasToken }]
var currentEndpointId = null;    // active project's selected preset id (null = Anthropic)
var currentEndpointModel = null; // user-selected model override for active project (null = use preset default)
var currentEndpointEnv = null;   // env block returned by endpoint:getEnv, or null
var firstSpawnLoadComplete = false;  // gate for cloud-default-on-boot
// Cache of fetched models per endpoint id to avoid refetching on every selection.
// { [endpointId]: { models: string[], fetchedAt: number, ok: boolean } }
var endpointModelsCache = {};


// Each window has its own counter for new column/pty ids. Give popouts a high
// offset so they can't collide with main when both windows spawn after a
// transfer. Reattached ids from a transfer bump the counter above themselves
// in addColumn; this just sets the initial floor.
var globalColumnId = 0;
var globalRowId = 0;
var ws = null;

// All pty columns keyed by global id (for routing WS messages)
var allColumns = new Map();

// Track which columns currently hold a live xterm WebGL context. Chromium caps
// concurrent WebGL contexts at ~16 per process; past that the oldest get killed
// and the terminal canvas goes blank. We log create/loss and expose
// window.webglStatus() so users can see which columns are eating slots.
var __webglContexts = new Set();
var __WEBGL_SOFT_LIMIT = 14;
function releaseWebglForColumn(id) {
  var col = allColumns.get(id);
  if (col && col.webglAddon) {
    try { col.webglAddon.dispose(); } catch (e) { /* ignore */ }
    col.webglAddon = null;
  }
  __webglContexts.delete(id);
}
window.webglStatus = function () {
  var rows = [];
  __webglContexts.forEach(function (cid) {
    var c = allColumns.get(cid);
    if (!c) return;
    rows.push({
      column: cid,
      project: c.projectKey,
      title: c.customTitle || '',
      sessionId: c.sessionId || '',
      cmd: c.cmd || 'claude'
    });
  });
  if (console.table) console.table(rows); else console.log(rows);
  console.log('[WebGL] ' + rows.length + ' / ~16 contexts in use');
  return rows;
};

// Activity state tracking per column: 'working' | 'attention' | 'idle' | 'exited'
var activityTimers = new Map(); // columnId -> setTimeout handle
var ACTIVITY_IDLE_MS = 3000; // after 3s of no substantial data, consider Claude "waiting"
var resizeSuppressed = new Set(); // columnIds temporarily suppressed after resize

// Per-project state: projectKey -> { containerEl, rows: [], columns: Map, focusedColumnId }
var projectStates = new Map();
var activeProjectKey = null;
// Global (per-window) tracker of the single column the user is actually on, or
// null. Unlike each project's own state.focusedColumnId (which is never cleared
// when focus moves to a DIFFERENT project), this names exactly one column window-
// wide, so voice "active" modes only auto-speak the column in view.
var lastFocusedColumnId = null;

// Which column the user is ATTENDING to right now for voice auto-play, or null.
// Unlike lastFocusedColumnId (which stays put when you click non-column UI in the
// same window), this is set when a mousedown/focusin lands INSIDE a column and
// CLEARED when it lands on the sidebar/explorer/toolbar/modal. "active" voice
// modes auto-speak only while this names the replying column, so a reply that
// finishes while you're in the sidebar is held for click catch-up instead.
var voiceAttentionColumnId = null;

// Live automation/headless/manager session ids (mirrored from main's
// backgroundSessionIds). An interactive column must never adopt one of these as
// its own sessionId — see getClaimedSessionIds. Kept fresh via IPC broadcast.
var backgroundSessionIdsCache = new Set();

var config = { projects: [], activeProjectIndex: -1 };
var projectDragFromIndex = -1; // For sidebar drag-to-reorder
var workspaceDragFromIndex = -1; // Drag-reorder within a project's sub-workspaces
var workspaceDragFromProjectPath = null; // Same-project check during drop

var popoutMode = false;
var popoutProjectKey = null;
(function detectPopoutMode() {
  try {
    var params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'popout') {
      popoutMode = true;
      popoutProjectKey = params.get('projectKey');
      document.body.classList.add('mode-popout');
      // Separate id space from main to avoid post-transfer collisions on pty-server.
      globalColumnId = 100000;
    }
  } catch {}
})();

// Automations state
var automationsForProject = [];
var allAutomationsData = null;
var importInProgress = false;

// ============================================================
// Headless Runs
// ============================================================
var headlessChipEl = document.getElementById('headless-chip');
var headlessChipLabelEl = document.getElementById('headless-chip-label');
var headlessDockEl = document.getElementById('headless-dock');
var headlessDockListEl = document.getElementById('headless-dock-list');
var headlessDockDetailEl = document.getElementById('headless-dock-detail');
var headlessDockPromptEl = document.getElementById('headless-dock-prompt');
var headlessDockRunBtn = document.getElementById('headless-dock-run');
var headlessDockCloseBtn = document.getElementById('headless-dock-close');
var headlessDockResizeEl = document.getElementById('headless-dock-resize');

// State: per-project cache of runs (index entries) + per-run output buffer (for selected)
var headlessRunsByProject = {}; // projectPath -> Array<entry>
var headlessSelectedRunId = null;
var headlessOutputBuffer = ''; // buffer for currently selected run
var headlessSeen = new Set(); // runIds whose completion the user has seen (cleared when dock opens)

function getActiveProjectPath() {
  if (!config || !Array.isArray(config.projects)) return null;
  var p = config.projects[config.activeProjectIndex];
  return p ? p.path : null;
}

function updateHeadlessChip() {
  var projectPath = getActiveProjectPath();
  if (!projectPath) { headlessChipEl.classList.add('hidden'); return; }
  var runs = headlessRunsByProject[projectPath] || [];
  if (runs.length === 0) { headlessChipEl.classList.add('hidden'); return; }

  var running = runs.filter(function (r) { return r.status === 'running'; }).length;
  var newlyDone = runs.filter(function (r) {
    return r.status !== 'running' && !headlessSeen.has(r.runId);
  }).length;
  var errored = runs.filter(function (r) { return r.status === 'error'; }).length;

  headlessChipEl.classList.remove('hidden', 'state-running', 'state-done', 'state-new', 'state-error');
  if (running > 0) {
    headlessChipEl.classList.add('state-running');
    headlessChipLabelEl.textContent = running + ' running';
  } else if (newlyDone > 0) {
    headlessChipEl.classList.add(errored > 0 ? 'state-error' : 'state-new');
    headlessChipLabelEl.textContent = runs.length + ' · ' + newlyDone + ' new';
  } else {
    headlessChipEl.classList.add('state-done');
    headlessChipLabelEl.textContent = String(runs.length);
  }
}

function loadHeadlessRunsForActiveProject() {
  var projectPath = getActiveProjectPath();
  if (!projectPath) { updateHeadlessChip(); return; }
  window.electronAPI.headlessList(projectPath).then(function (index) {
    headlessRunsByProject[projectPath] = (index && index.runs) || [];
    // Mark already-completed runs as seen on initial load, so old results don't
    // show as "new" after an app restart.
    for (var i = 0; i < headlessRunsByProject[projectPath].length; i++) {
      var r = headlessRunsByProject[projectPath][i];
      if (r.status !== 'running') headlessSeen.add(r.runId);
    }
    updateHeadlessChip();
    if (!headlessDockEl.classList.contains('hidden')) renderHeadlessDock();
  });
}

function renderHeadlessDock() {
  var projectPath = getActiveProjectPath();
  var runs = (projectPath && headlessRunsByProject[projectPath]) || [];

  // List pane
  headlessDockListEl.innerHTML = '';
  if (runs.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'headless-dock-empty';
    empty.textContent = 'No runs yet';
    headlessDockListEl.appendChild(empty);
  } else {
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      var row = document.createElement('div');
      row.className = 'headless-dock-row' + (r.runId === headlessSelectedRunId ? ' selected' : '');
      row.dataset.runId = r.runId;

      var status = document.createElement('div');
      status.className = 'headless-dock-row-status ' + r.status;
      row.appendChild(status);

      var title = document.createElement('div');
      title.className = 'headless-dock-row-title';
      title.textContent = r.title || '(untitled)';
      row.appendChild(title);

      if (r.connectionName && endpointPresets.length > 0) {
        var conn = document.createElement('span');
        conn.className = 'headless-dock-row-conn ' + (r.connectionName === 'Cloud' ? 'headless-dock-row-conn--cloud' : 'headless-dock-row-conn--local');
        conn.textContent = r.connectionName;
        row.appendChild(conn);
      }

      var time = document.createElement('div');
      time.className = 'headless-dock-row-time';
      time.textContent = formatRelativeTime(r.startedAt);
      row.appendChild(time);

      (function (runId) {
        row.addEventListener('click', function () { selectHeadlessRun(runId); });
      })(r.runId);
      headlessDockListEl.appendChild(row);
    }
  }

  // Detail pane
  renderHeadlessDetail();
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  var then = new Date(iso).getTime();
  var diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return diffSec + 's ago';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm ago';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h ago';
  return Math.floor(diffSec / 86400) + 'd ago';
}

function selectHeadlessRun(runId) {
  headlessSelectedRunId = runId;
  headlessOutputBuffer = '';
  renderHeadlessDock();
  var projectPath = getActiveProjectPath();
  if (!projectPath || !runId) return;
  window.electronAPI.headlessGet(projectPath, runId).then(function (res) {
    if (res && res.output != null && headlessSelectedRunId === runId) {
      headlessOutputBuffer = res.output;
      renderHeadlessDetail();
    }
  });
}

function renderHeadlessDetail() {
  var projectPath = getActiveProjectPath();
  var runs = (projectPath && headlessRunsByProject[projectPath]) || [];
  var entry = runs.find(function (r) { return r.runId === headlessSelectedRunId; });
  headlessDockDetailEl.innerHTML = '';
  if (!entry) {
    var empty = document.createElement('div');
    empty.className = 'headless-dock-empty';
    empty.textContent = 'Select a run to view output';
    headlessDockDetailEl.appendChild(empty);
    return;
  }

  var header = document.createElement('div');
  header.className = 'headless-dock-detail-header';

  var preview = document.createElement('div');
  preview.className = 'headless-dock-prompt-preview';
  preview.textContent = entry.prompt;
  preview.title = 'Click to expand';
  preview.addEventListener('click', function () { preview.classList.toggle('expanded'); });
  header.appendChild(preview);

  var meta = document.createElement('div');
  meta.textContent = entry.status + (entry.durationMs ? ' · ' + Math.round(entry.durationMs / 100) / 10 + 's' : '');
  header.appendChild(meta);

  if (entry.status === 'running') {
    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () {
      window.electronAPI.headlessCancel(entry.runId);
    });
    header.appendChild(cancelBtn);
  }

  var copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', function () {
    window.electronAPI.clipboardWriteText(headlessOutputBuffer);
  });
  header.appendChild(copyBtn);

  // Re-run: fire a fresh headless run with the same prompt and switch the
  // detail pane to the new entry. Disabled mid-stream so a still-running
  // task can't be queued twice by accident.
  var rerunBtn = document.createElement('button');
  rerunBtn.textContent = 'Re-run';
  rerunBtn.disabled = entry.status === 'running';
  rerunBtn.addEventListener('click', function () {
    if (!projectPath || !entry.prompt) return;
    rerunBtn.disabled = true;
    window.electronAPI.headlessRun(projectPath, entry.prompt).then(function (res) {
      if (res && res.error) {
        alert('Headless re-run failed: ' + res.error);
        rerunBtn.disabled = false;
        return;
      }
      if (res && res.runId) {
        headlessSelectedRunId = res.runId;
        headlessOutputBuffer = '';
        renderHeadlessDock();
      }
    });
  });
  header.appendChild(rerunBtn);

  var deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', function () {
    window.electronAPI.headlessDelete(projectPath, entry.runId).then(function () {
      headlessRunsByProject[projectPath] = (headlessRunsByProject[projectPath] || []).filter(function (r) { return r.runId !== entry.runId; });
      if (headlessSelectedRunId === entry.runId) headlessSelectedRunId = null;
      updateHeadlessChip();
      renderHeadlessDock();
    });
  });
  header.appendChild(deleteBtn);

  headlessDockDetailEl.appendChild(header);

  var output = document.createElement('div');
  output.className = 'headless-dock-output';
  output.id = 'headless-dock-output-body';
  output.textContent = headlessOutputBuffer || (entry.status === 'running' ? '(streaming...)' : '(no output)');
  headlessDockDetailEl.appendChild(output);
}

function openHeadlessDock() {
  headlessDockEl.classList.remove('hidden');
  // Mark all current runs as seen
  var projectPath = getActiveProjectPath();
  var runs = (projectPath && headlessRunsByProject[projectPath]) || [];
  for (var i = 0; i < runs.length; i++) {
    if (runs[i].status !== 'running') headlessSeen.add(runs[i].runId);
  }
  updateHeadlessChip();
  renderHeadlessDock();
  headlessDockPromptEl.focus();
}

function closeHeadlessDock() {
  headlessDockEl.classList.add('hidden');
}

function toggleHeadlessDock() {
  if (headlessDockEl.classList.contains('hidden')) openHeadlessDock();
  else closeHeadlessDock();
}

headlessChipEl.addEventListener('click', toggleHeadlessDock);
headlessDockCloseBtn.addEventListener('click', closeHeadlessDock);

(function wireHeadlessDockResize() {
  var dragging = false;
  var startY = 0;
  var startHeight = 0;
  headlessDockResizeEl.addEventListener('mousedown', function (e) {
    dragging = true;
    startY = e.clientY;
    startHeight = headlessDockEl.getBoundingClientRect().height;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var dy = startY - e.clientY;
    var newHeight = Math.max(180, Math.min(window.innerHeight * 0.85, startHeight + dy));
    headlessDockEl.style.height = newHeight + 'px';
  });
  document.addEventListener('mouseup', function () {
    if (dragging) {
      dragging = false;
      document.body.style.userSelect = '';
    }
  });
})();

function submitHeadlessRun() {
  var prompt = headlessDockPromptEl.value;
  if (!prompt || !prompt.trim()) return;
  var projectPath = getActiveProjectPath();
  if (!projectPath) return;
  headlessDockRunBtn.disabled = true;
  window.electronAPI.headlessRun(projectPath, prompt).then(function (res) {
    headlessDockRunBtn.disabled = false;
    if (res && res.error) {
      alert('Headless run failed: ' + res.error);
      return;
    }
    headlessDockPromptEl.value = '';
    // The onHeadlessStarted handler below will insert the entry; also select it.
    if (res && res.runId) {
      headlessSelectedRunId = res.runId;
      headlessOutputBuffer = '';
    }
  }).catch(function (err) {
    headlessDockRunBtn.disabled = false;
    alert('Headless run failed: ' + (err && err.message ? err.message : err));
  });
}

headlessDockRunBtn.addEventListener('click', submitHeadlessRun);
headlessDockPromptEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitHeadlessRun();
  }
});

window.electronAPI.onHeadlessStarted(function (data) {
  var list = headlessRunsByProject[data.projectPath] || [];
  // Prepend
  list = [data.entry].concat(list.filter(function (r) { return r.runId !== data.entry.runId; }));
  headlessRunsByProject[data.projectPath] = list;
  updateHeadlessChip();
  if (!headlessDockEl.classList.contains('hidden') && getActiveProjectPath() === data.projectPath) {
    renderHeadlessDock();
  }
});

window.electronAPI.onHeadlessOutput(function (data) {
  if (headlessSelectedRunId === data.runId) {
    headlessOutputBuffer += data.chunk;
    var outEl = document.getElementById('headless-dock-output-body');
    if (outEl) {
      outEl.textContent = headlessOutputBuffer;
      outEl.scrollTop = outEl.scrollHeight;
    }
  }
});

window.electronAPI.onHeadlessCompleted(function (data) {
  var runs = headlessRunsByProject[data.projectPath] || [];
  var entry = runs.find(function (r) { return r.runId === data.runId; });
  if (entry) {
    entry.status = data.status;
    entry.exitCode = data.exitCode;
    entry.completedAt = data.completedAt;
    entry.durationMs = data.durationMs;
  }
  updateHeadlessChip();
  if (!headlessDockEl.classList.contains('hidden') && getActiveProjectPath() === data.projectPath) {
    renderHeadlessDock();
  }
});

window.electronAPI.onHeadlessFocusRun(function (data) {
  // Switch to that project if needed, open dock, select run.
  if (getActiveProjectPath() !== data.projectPath) {
    var idx = (config.projects || []).findIndex(function (p) { return p && p.path === data.projectPath; });
    if (idx >= 0) setActiveProject(idx, true);
  }
  openHeadlessDock();
  selectHeadlessRun(data.runId);
});

var darkTermTheme = {
  background: '#1a1a2e',
  foreground: '#e0e0e0',
  cursor: '#e94560',
  cursorAccent: '#1a1a2e',
  selectionBackground: '#0f3460',
  selectionForeground: '#e0e0e0',
  black: '#1a1a2e',
  red: '#e94560',
  green: '#53d769',
  yellow: '#ffd60a',
  blue: '#0a84ff',
  magenta: '#bf5af2',
  cyan: '#64d2ff',
  white: '#e0e0e0',
  brightBlack: '#636366',
  brightRed: '#ff6b6b',
  brightGreen: '#34c759',
  brightYellow: '#ffd60a',
  brightBlue: '#64d2ff',
  brightMagenta: '#bf5af2',
  brightCyan: '#70d7ff',
  brightWhite: '#ffffff'
};

var lightTermTheme = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#d1304a',
  cursorAccent: '#ffffff',
  selectionBackground: '#b6d7ff',
  selectionForeground: '#1f2328',
  black: '#24292f',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#0550ae',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#116329',
  brightYellow: '#7d4e00',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f'
};

var termTheme = darkTermTheme;
var currentTheme = 'dark';

var fontSize = 14;
var FONT_SIZE_MIN = 8;

// Track which projects have pending attention (survives renderProjectList rebuilds)
var projectsNeedingAttention = new Set();
var FONT_SIZE_MAX = 28;
var FONT_SIZE_DEFAULT = 14;

// ============================================================
// WebSocket
// ============================================================

var wsPort = 3456;
var wsAuthToken = null;
var wsHasConnectedBefore = false;

function connectWS() {
  // Per-launch token presented as a subprotocol. pty-server rejects the WS
  // handshake if the token is missing or wrong, so a drive-by browser page
  // pointed at ws://127.0.0.1:<port> can't open a connection.
  var protocols = wsAuthToken ? ['claudes-auth-' + wsAuthToken] : undefined;
  ws = new WebSocket('ws://127.0.0.1:' + wsPort, protocols);
  ws.onopen = function () {
    if (wsHasConnectedBefore) {
      reattachAllColumns();
    } else {
      wsHasConnectedBefore = true;
      loadProjects();
    }
  };
  ws.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.type === 'data') {
      var col = allColumns.get(msg.id);
      if (col) {
        col.terminal.write(msg.data);
          if (!resizeSuppressed.has(msg.id) && msg.data && col.hasUserInput) {
          // Detect Claude's input prompt: line starting with > or ❯ followed by cursor/space at end of chunk
          var trimmed = msg.data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trimEnd();
          // "Interrupted" with or without the middle-dot — the chunk can
          // arrive partial, so match permissively. This must work on a
          // resumed session that hasn't seen a user keystroke yet, so it
          // runs OUTSIDE the col.hasUserInput gate below.
          var wasInterrupted = /Interrupted/.test(trimmed) &&
            (/What should Claude do/.test(trimmed) || /\bEsc\b/.test(trimmed));
          if (wasInterrupted && window.Clawd && window.Clawd.setColumnAnimation) {
            window.Clawd.setColumnAnimation(msg.id, 'idle');
          }
          if (col.hasUserInput) {
            // Detect Claude's input prompt: line starting with > or ❯ followed by cursor/space at end of chunk
            var endsWithPrompt = /\n\s*[>❯]\s*$/.test(trimmed) || /^\s*[>❯]\s*$/.test(trimmed) ||
              /Do you want to proceed/.test(trimmed) || /Esc to cancel/.test(trimmed) ||
              /\d\.\s*(Yes|No)\s*$/.test(trimmed);
            if (endsWithPrompt && col.activityState === 'working') {
              setColumnActivity(msg.id, 'waiting');
              notifyAttentionNeeded(msg.id);
            } else if (msg.data.length > 10 && !endsWithPrompt) {
              setColumnActivity(msg.id, 'working');
            }
            // Safety net for Clawd: whenever a prompt is visible, the column
            // is awaiting input — flip the widget to idle regardless of the
            // tracked activityState.
            if (endsWithPrompt && window.Clawd && window.Clawd.setColumnAnimation) {
              window.Clawd.setColumnAnimation(msg.id, 'idle');
            }
          }
        }
        // Auto-open browser when server starts listening. Parse the actual
        // URL out of the dotnet/asp.net log line ("Now listening on:
        // https://localhost:7142") rather than using the configured
        // applicationUrl — .NET's launchSettings.json stores the latter as a
        // semicolon-separated list (e.g. "https://...;http://..."), which
        // shell.openExternal can't interpret as a URL on Windows and falls
        // through to opening File Explorer.
        if (col.launchUrl && !col.launchUrlOpened) {
          var nlMatch = msg.data.match(/Now listening on:\s*(https?:\/\/[^\s\r\n]+)/i);
          if (nlMatch) {
            col.launchUrlOpened = true;
            // Kestrel often binds to "any address" (e.g. http://[::]:8080,
            // http://0.0.0.0:8080, http://+:8080, http://*:8080) and logs that
            // verbatim. Browsers can't navigate to those — rewrite to
            // localhost so the auto-open lands on a connectable URL.
            var openUrl = nlMatch[1].replace(
              /^(https?:\/\/)(\[::\]|\[::0\]|0\.0\.0\.0|\+|\*)(:|\/|$)/i,
              '$1localhost$3'
            );
            window.electronAPI.openExternal(openUrl);
          }
        }
      }
    } else if (msg.type === 'exit') {
      var col2 = allColumns.get(msg.id);
      if (col2) {
        // Endpoint failover: if this is a Claude column that died early with a
        // non-zero exit code, and the column was spawned with an endpoint that
        // has a fallback configured, transparently respawn with the fallback
        // before showing the user an exit overlay.
        var lifetime = (typeof msg.lifetime_ms === 'number') ? msg.lifetime_ms : Infinity;
        var earlyExit = lifetime < 5000;
        var nonZero = msg.exitCode !== 0 && msg.exitCode != null;
        if (!col2.cmd && earlyExit && nonZero && col2.endpointId && !col2.failedOver) {
          tryEndpointFailover(msg.id);
          return;  // skip the default exit overlay; respawn replaces the column in place
        }
        col2.element.appendChild(createExitOverlay(msg.id, msg.exitCode, col2));
        setColumnActivity(msg.id, 'exited');
        // Refresh run configs to update stop/restart controls
        if (col2.cmd) setTimeout(refreshRunConfigs, 300);
      }
    } else if (msg.type === 'reattach-failed') {
      // Pty died during sleep — auto-respawn with --resume if we have a session,
      // otherwise fall back to the exit overlay so the user can decide.
      var col3 = allColumns.get(msg.id);
      if (col3 && !col3.element.querySelector('.exit-overlay')) {
        if (!col3.cmd && col3.sessionId) {
          fitTerminal(col3.terminal, col3.fitAddon);
          var respawnMsg = {
            type: 'create',
            id: msg.id,
            cols: col3.terminal.cols,
            rows: col3.terminal.rows,
            cwd: col3.cwd,
            args: buildResumeArgs(col3)
          };
          if (col3.cmd) respawnMsg.cmd = col3.cmd;
          if (col3.env) respawnMsg.env = col3.env;
          // Bind to the app-managed Headroom proxy by env var (no `headroom wrap`).
          // Re-derived from the live global flag; never persisted on the column.
          maybeBindHeadroom(respawnMsg, { hasEndpoint: !!(col3.endpointId || col3.env), isClaude: !col3.cmd });
          col3.terminal.clear();
          wsSend(respawnMsg);
          setColumnActivity(msg.id, 'working');
        } else {
          col3.element.appendChild(createExitOverlay(msg.id, null, col3));
          setColumnActivity(msg.id, 'exited');
        }
      }
    }
  };
  ws.onclose = function () { setTimeout(connectWS, 2000); };
}

if (window.electronAPI && window.electronAPI.onPowerResume) {
  window.electronAPI.onPowerResume(function () {
    // System just woke — proactively reattach all live ptys before any stale
    // socket state trips a disconnect.
    if (ws && ws.readyState === WebSocket.OPEN) {
      reattachAllColumns();
    } else if (ws) {
      try { ws.close(); } catch (e) { /* ignore */ }
    }
  });
}

function reattachAllColumns() {
  allColumns.forEach(function (col, id) {
    // Skip columns that already have an exit overlay (already dead)
    if (col.element.querySelector('.exit-overlay')) return;
    // Skip columns that are marked as exited
    if (col.activityState === 'exited') return;

    fitTerminal(col.terminal, col.fitAddon);
    wsSend({
      type: 'reattach',
      id: id,
      cols: col.terminal.cols,
      rows: col.terminal.rows
    });
  });
}

// Ensure the app-owned Headroom proxy is up before sending a wrapped ('headroom')
// spawn/respawn wire message. On failure, rewrite `msg` in place to an unwrapped
// spawn (using `plainArgs`) so the column still works instead of exiting (code 1)
// with ConnectionRefused. `send` runs exactly once with the final `msg`. Every
// spawn/respawn path routes through here so they all self-heal identically.
function maybeBindHeadroom(msg, ctx) {
  if (!msg || !window.HeadroomEnv) return;
  var env = window.HeadroomEnv.buildHeadroomEnv({
    enabled: !!(headroomInstalled && config && config.useHeadroom),
    hasEndpoint: !!(ctx && ctx.hasEndpoint),
    isClaude: !(ctx && ctx.isClaude === false),
    oneM: !!(config && config.useHeadroom1m !== false),
    oneMModel: (config && config.headroom1mModel) || 'claude-opus-4-8'
  });
  if (env) msg.env = Object.assign({}, msg.env, env);
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ============================================================
// Activity Pulse Tracking
// ============================================================

function setColumnActivity(id, state) {
  var col = allColumns.get(id);
  if (!col) return;

  var prevState = col.activityState;

  // Clear any pending timer
  var timer = activityTimers.get(id);
  if (timer) clearTimeout(timer);

  if (state === 'working') {
    // Only update DOM if transitioning into working
    if (prevState !== 'working') {
      col.activityState = 'working';
      updateActivityIndicator(id);
      updateSidebarActivity();
    }
    // Fallback idle timer — fires notification if prompt detection didn't catch it
    activityTimers.set(id, setTimeout(function () {
      var c = allColumns.get(id);
      if (c && c.activityState === 'working') {
        c.activityState = 'attention';
        updateActivityIndicator(id);
        updateSidebarActivity();
        notifyAttentionNeeded(id);
      }
    }, ACTIVITY_IDLE_MS));
  } else {
    col.activityState = state; // 'exited' | 'waiting' | 'idle' | 'attention'
    activityTimers.delete(id);
    updateActivityIndicator(id);
    updateSidebarActivity();
    if (window.Clawd && window.Clawd.setColumnAnimation) {
      if (state === 'exited') {
        window.Clawd.setColumnAnimation(id, 'disconnected');
      } else if (state === 'waiting' || state === 'idle') {
        // Prompt detected (could be Claude finished normally or the user
        // interrupted mid-turn). Claude CLI emits Stop for normal completion
        // but not for user interrupts, so we use the prompt-detection signal
        // as a safety net to keep Clawd from stranding on 'thinking'/working.
        window.Clawd.setColumnAnimation(id, 'idle');
      }
    }
  }

  // Mirror the new activity state onto the dock chip if this column is minimised.
  if (col.minimized) updateMinimizedChipActivity(id);
}

function updateActivityIndicator(id) {
  var col = allColumns.get(id);
  if (!col || !col.headerEl) return;

  var dot = col.headerEl.querySelector('.activity-dot');
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'activity-dot';
    var titleEl = col.headerEl.querySelector('.col-title');
    col.headerEl.insertBefore(dot, titleEl);
  }

  dot.className = 'activity-dot';
  if (col.activityState === 'working') {
    dot.classList.add('activity-working');
    dot.title = 'Working...';
  } else if (col.activityState === 'attention') {
    dot.classList.add('activity-attention');
    dot.title = 'Needs attention';
  } else if (col.activityState === 'idle') {
    dot.classList.add('activity-idle');
    dot.title = 'Idle';
  } else {
    dot.classList.add('activity-exited');
    dot.title = 'Exited';
  }
}

function updateSidebarActivity() {
  if (popoutMode) return; // sidebar not rendered in popout windows
  // Bucket counts by (projectKey, workspaceId) — no cross-workspace rollup.
  // Project card badge reflects Primary-only; each workspace sub-row badge
  // reflects only its own columns.
  var attentionByKey = {};
  var workingByKey = {};
  allColumns.forEach(function (col) {
    var k = stateKey(col.projectKey, col.workspaceId);
    if (col.activityState === 'attention') {
      attentionByKey[k] = (attentionByKey[k] || 0) + 1;
    }
    if (col.activityState === 'working') {
      workingByKey[k] = (workingByKey[k] || 0) + 1;
    }
  });

  function applyBadge(badge, attention, working) {
    if (!badge) return;
    badge.classList.remove('badge-attention', 'badge-working');
    if (attention > 0) {
      badge.classList.add('badge-attention');
      badge.title = attention + ' needs attention';
    } else if (working > 0) {
      badge.classList.add('badge-working');
      badge.title = working + ' working';
    } else {
      badge.title = '';
    }
  }

  config.projects.forEach(function (project) {
    var projKey = project.path;
    var item = projectListEl.querySelector(
      '.project-item[data-project-path="' + CSS.escape(projKey) + '"]');
    if (item) {
      var primaryK = stateKey(projKey, null);
      applyBadge(item.querySelector('.project-badge'),
        attentionByKey[primaryK] || 0,
        workingByKey[primaryK] || 0);
    }
    if (Array.isArray(project.workspaces)) {
      project.workspaces.forEach(function (ws) {
        if (!ws) return;
        var wsItem = projectListEl.querySelector(
          '.workspace-item[data-workspace-id="' + CSS.escape(ws.id) + '"]');
        if (!wsItem) return;
        var wsK = stateKey(projKey, ws.id);
        applyBadge(wsItem.querySelector('.workspace-badge'),
          attentionByKey[wsK] || 0,
          workingByKey[wsK] || 0);
      });
    }
  });
}

// Notification settings (defaults: all on)
var notifSettings = { taskbar: true, sidebar: true, header: true, limits70: true, limits90: true, limitsPause: true };

function loadNotifSettings() {
  if (config.notifications) {
    notifSettings = Object.assign({ taskbar: true, sidebar: true, header: true, limits70: true, limits90: true, limitsPause: true }, config.notifications);
  }
  var el1 = document.getElementById('setting-notif-taskbar');
  var el2 = document.getElementById('setting-notif-sidebar');
  var el3 = document.getElementById('setting-notif-header');
  var el4 = document.getElementById('setting-notif-limits-70');
  var el5 = document.getElementById('setting-notif-limits-90');
  var el6 = document.getElementById('setting-notif-limits-pause');
  if (el1) el1.checked = notifSettings.taskbar;
  if (el2) el2.checked = notifSettings.sidebar;
  if (el3) el3.checked = notifSettings.header;
  if (el4) el4.checked = notifSettings.limits70 !== false;
  if (el5) el5.checked = notifSettings.limits90 !== false;
  if (el6) el6.checked = notifSettings.limitsPause !== false;
}

function saveNotifSettings() {
  notifSettings.taskbar = document.getElementById('setting-notif-taskbar').checked;
  notifSettings.sidebar = document.getElementById('setting-notif-sidebar').checked;
  notifSettings.header = document.getElementById('setting-notif-header').checked;
  notifSettings.limits70 = document.getElementById('setting-notif-limits-70').checked;
  notifSettings.limits90 = document.getElementById('setting-notif-limits-90').checked;
  notifSettings.limitsPause = document.getElementById('setting-notif-limits-pause').checked;
  config.notifications = notifSettings;
  saveConfig();
}

function loadStartWithOS() {
  if (!window.electronAPI || !window.electronAPI.getStartWithOS) return;
  window.electronAPI.getStartWithOS().then(function (enabled) {
    var el = document.getElementById('setting-start-with-os');
    if (el) el.checked = !!enabled;
  });
}

function saveStartWithOS() {
  if (!window.electronAPI || !window.electronAPI.setStartWithOS) return;
  var enabled = document.getElementById('setting-start-with-os').checked;
  window.electronAPI.setStartWithOS(enabled);
}

function notifyAttentionNeeded(columnId) {
  var col = allColumns.get(columnId);
  if (!col) return;

  // Don't flash if user hasn't interacted, or already notified for this cycle
  if (!col.hasUserInput || col.notified) return;
  col.notified = true;

  // Flash taskbar only if window is not focused (check renderer side too)
  if (notifSettings.taskbar && !document.hasFocus() && window.electronAPI && window.electronAPI.flashFrame) {
    window.electronAPI.flashFrame();
  }

  // Flash the column header
  if (notifSettings.header) {
    var header = col.headerEl;
    if (header) {
      header.classList.add('attention-flash');
    }
  }

  // Track attention by (projectKey, workspaceId). Flash the project card when
  // the column is Primary, the workspace sub-row when it's a sub-workspace —
  // no cross-workspace rollup.
  if (notifSettings.sidebar) {
    var attnKey = stateKey(col.projectKey, col.workspaceId);
    projectsNeedingAttention.add(attnKey);
    var sel;
    if (col.workspaceId == null) {
      sel = '.project-item[data-project-path="' + CSS.escape(col.projectKey) + '"]';
    } else {
      sel = '.workspace-item[data-workspace-id="' + CSS.escape(col.workspaceId) + '"]';
    }
    var item = projectListEl.querySelector(sel);
    if (item) item.classList.add('attention-flash');
  }

  // Surface attention on the dock chip if this column is minimised.
  if (col.minimized) updateMinimizedChipActivity(columnId);
}

function clearProjectAttention(projectKey, workspaceId) {
  var changed = false;
  allColumns.forEach(function (col, id) {
    if (col.projectKey === projectKey
        && (col.workspaceId == null ? null : col.workspaceId) === workspaceId
        && col.activityState === 'attention') {
      col.activityState = 'idle';
      updateActivityIndicator(id);
      changed = true;
    }
  });
  projectsNeedingAttention.delete(stateKey(projectKey, workspaceId));
  if (changed) updateSidebarActivity();
}

// ============================================================
// Per-project state helpers
// ============================================================

// Map key for projectStates. Primary context (workspaceId null/undefined)
// keys on projectPath alone so existing single-project code keeps working.
// Sub-workspace contexts append '::<workspaceId>' so each workspace owns its
// own columns/rows/containerEl entry in projectStates.
function stateKey(projectPath, workspaceId) {
  return (workspaceId == null) ? projectPath : (projectPath + '::' + workspaceId);
}

function getOrCreateProjectState(projectKey) {
  if (projectStates.has(projectKey)) return projectStates.get(projectKey);

  var containerEl = document.createElement('div');
  containerEl.className = 'project-columns';
  containerEl.style.display = 'none';
  columnsContainer.appendChild(containerEl);

  var state = {
    containerEl: containerEl,
    rows: [],         // array of { id, el, columnIds: [] }
    columns: new Map(),
    focusedColumnId: null,
    minimized: []     // array of column ids currently minimised, in minimise order
  };
  projectStates.set(projectKey, state);
  return state;
}

function getActiveState() {
  if (!activeProjectKey) return null;
  var project = config.projects[config.activeProjectIndex];
  var wsId = project ? project.activeWorkspaceId : null;
  return projectStates.get(stateKey(activeProjectKey, wsId)) || null;
}

// ============================================================
// Named layouts (save / restore)
// ============================================================

// Snapshot the project's current row/column shape into a serialisable layout
// payload. Sessions deliberately aren't captured — restoring spawns fresh
// columns; the user can then use the recent-sessions picker per column to
// reattach if desired.
function snapshotProjectLayout(projectPath) {
  var state = projectStates.get(projectPath);
  if (!state) return { rows: [] };
  return {
    rows: state.rows.map(function (row) {
      return {
        columns: row.columnIds.map(function (id) {
          var c = state.columns.get(id);
          if (!c) return null;
          return {
            cmd: c.cmd || null,
            cmdArgs: Array.isArray(c.cmdArgs) ? c.cmdArgs.filter(function (a) {
              // Drop any resume arg pair — we want a fresh spawn.
              return a !== '--resume' && (typeof a !== 'string' || !/^[0-9a-f-]{32,}$/i.test(a));
            }) : [],
            env: c.env || null,
            endpointId: c.endpointId || null,
            title: c.customTitle || null
          };
        }).filter(Boolean)
      };
    })
  };
}

function saveCurrentLayout(projectPath) {
  if (!window.electronAPI || !window.electronAPI.saveLayout) return;
  var snap = snapshotProjectLayout(projectPath);
  if (snap.rows.length === 0) { showToast('No columns to save', { kind: 'warn' }); return; }
  // window.prompt() is disabled in Electron, use the inline modal that
  // promptForValue() implements. Returns null on cancel.
  promptForValue('Save current layout as:').then(function (name) {
    if (!name) return;
    name = name.trim();
    if (!name) return;
    window.electronAPI.saveLayout(projectPath, name, snap).then(function (r) {
      if (!r || !r.ok) showToast('Save failed: ' + (r && r.error || 'unknown'), { kind: 'error' });
      else showToast('Saved layout "' + name + '"', { kind: 'success' });
    });
  });
}

function chooseLayoutToRestore(projectPath) {
  if (!window.electronAPI || !window.electronAPI.listLayouts) return;
  window.electronAPI.listLayouts(projectPath).then(function (layouts) {
    if (!layouts || layouts.length === 0) {
      showToast('No saved layouts yet — use "Save current layout…" first.', { kind: 'warn', duration: 5000 });
      return;
    }
    showLayoutPickerModal(projectPath, layouts);
  });
}

// Lightweight picker for saved layouts. List of names with Restore + Delete
// buttons per row; Esc / click-outside closes.
function showLayoutPickerModal(projectPath, layouts) {
  var existing = document.querySelector('.layout-picker-overlay');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay layout-picker-overlay';
  overlay.innerHTML = '<div class="modal-dialog" style="max-width:480px;"><div class="modal-header"><span class="modal-title">Restore layout</span><span class="modal-close">&times;</span></div><div class="modal-body" id="layout-picker-body" style="padding:8px 0 16px;"></div></div>';
  document.body.appendChild(overlay);
  var body = overlay.querySelector('#layout-picker-body');
  layouts.forEach(function (l) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 20px;border-bottom:1px solid var(--border-primary);';
    var label = document.createElement('div');
    label.style.flex = '1';
    label.innerHTML = '<div style="font-size:13px;">' + escapeHtml(l.name) + '</div>' +
      '<div style="font-size:11px;color:#6b7280;">' + escapeHtml(new Date(l.savedAt).toLocaleString()) + ' · ' + (l.layout && l.layout.rows ? l.layout.rows.reduce(function (acc, r) { return acc + r.columns.length; }, 0) : 0) + ' column(s)</div>';
    var restoreBtn = document.createElement('button');
    restoreBtn.className = 'settings-browse-btn';
    restoreBtn.style.padding = '4px 12px';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', function () {
      close();
      restoreLayout(projectPath, l.layout);
      showToast('Restoring "' + l.name + '"…', { kind: 'info', duration: 2000 });
    });
    var delBtn = document.createElement('button');
    delBtn.className = 'settings-browse-btn';
    delBtn.style.padding = '4px 10px';
    delBtn.style.color = '#f87171';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete this layout';
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      confirmDialog('Delete layout "' + l.name + '"?', { okLabel: 'Delete', dangerous: true }).then(function (ok) {
        if (!ok) return;
        window.electronAPI.deleteLayout(projectPath, l.name).then(function () {
          row.remove();
          showToast('Deleted layout "' + l.name + '"', { kind: 'success' });
          if (!body.querySelector('div[style*="border-bottom"]')) close();
        });
      });
    });
    row.appendChild(label);
    row.appendChild(restoreBtn);
    row.appendChild(delBtn);
    body.appendChild(row);
  });
  function close() { overlay.remove(); }
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (!overlay.parentNode) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape') { e.preventDefault(); close(); document.removeEventListener('keydown', onKey); }
  });
}

function restoreLayout(projectPath, layout) {
  if (!layout || !Array.isArray(layout.rows)) return;
  // Make sure we're operating on the target project's state.
  var idx = -1;
  for (var i = 0; i < config.projects.length; i++) {
    if (config.projects[i].path === projectPath) { idx = i; break; }
  }
  if (idx < 0) return;
  if (config.activeProjectIndex !== idx) {
    setActiveProject(idx, false, true);
  }
  var state = getOrCreateProjectState(projectPath);
  // Kill existing columns first so the restore yields exactly the saved shape.
  var existingIds = [];
  state.rows.forEach(function (r) { r.columnIds.forEach(function (cid) { existingIds.push(cid); }); });
  existingIds.forEach(function (cid) { try { removeColumn(cid); } catch (e) { /* */ } });
  // Spawn rows + columns. addColumn(args, row, opts) — with row=null it goes
  // into the current row; with addRow() we create a new one.
  layout.rows.forEach(function (rowSpec, rIdx) {
    var row = rIdx === 0 ? null : addRow();
    rowSpec.columns.forEach(function (colSpec) {
      var opts = {
        title: colSpec.title || null,
        cmd: colSpec.cmd || null,
        env: colSpec.env || null,
        endpointId: colSpec.endpointId || null
      };
      var argList = colSpec.cmd ? (colSpec.cmdArgs || []) : null;
      addColumn(argList, row, opts);
    });
  });
}

// Run FitAddon.fit(), then trim the row count down to what the renderer can
// actually paint at the device-pixel-rounded cell height. FitAddon sizes rows
// from the ideal fractional cell height, which overshoots the wrapper's bottom
// padding and clips the last row (the bypass-permissions hint). We feed the
// correction the wrapper's TRUE content height (clientHeight minus vertical
// padding) — under box-sizing:border-box getComputedStyle(...).height includes
// the padding and would overcount rows. Best-effort: any failure leaves the
// plain fit() result in place.
function fitTerminal(terminal, fitAddon) {
  if (!terminal || !fitAddon) return;
  fitAddon.fit();
  try {
    var rs = terminal._core && terminal._core._renderService;
    var dev = rs && rs.dimensions && rs.dimensions.device && rs.dimensions.device.cell;
    var wrap = terminal.element && terminal.element.parentElement;
    if (!dev || !dev.height || !wrap) return;
    var cs = window.getComputedStyle(wrap);
    var padTop = parseFloat(cs.getPropertyValue('padding-top'));
    var padBottom = parseFloat(cs.getPropertyValue('padding-bottom'));
    var availH = window.TerminalFit.contentHeightPx(wrap.clientHeight, padTop, padBottom);
    var corrected = window.TerminalFit.correctRows({
      availableHeightCss: availH,
      deviceCellHeightPx: dev.height,
      devicePixelRatio: window.devicePixelRatio || 1,
      proposedRows: terminal.rows
    });
    if (corrected !== terminal.rows) terminal.resize(terminal.cols, corrected);
  } catch (e) { /* correction is best-effort; fit() already applied */ }
}

function refocusActiveTerminal() {
  var state = getActiveState();
  if (state && state.focusedColumnId !== null) {
    var col = allColumns.get(state.focusedColumnId);
    if (col && col.terminal) col.terminal.focus();
  }
}

// Snippet expansion: when the user types "\\trigger" + Enter/Tab in a Claude
// column, look up the snippet, prompt for any {{variables}}, then erase the
// typed trigger and send the expanded body via the pty.
//
// Returns true if the keystroke was consumed (caller must NOT forward to pty),
// or false if the keystroke should pass through normally.
function handleSnippetExpansion(colId, data) {
  var col = allColumns.get(colId);
  if (!col) return false;
  if (typeof col.snippetBuffer !== 'string') col.snippetBuffer = '';

  // Backspace handling: pop one char off our buffer; let the pty handle echo
  if (data === '\x7f' || data === '\b') {
    col.snippetBuffer = col.snippetBuffer.slice(0, -1);
    return false;
  }

  // Enter / Tab — try to expand. xterm may send '\r', '\n', '\r\n', or '\t';
  // accept any input that contains an Enter/Tab char.
  var isEnterTab = data === '\r' || data === '\n' || data === '\t' ||
                   data === '\r\n' || data === '\n\r';
  if (isEnterTab) {
    var m = /\\\\([a-zA-Z0-9_-]+)\s*$/.exec(col.snippetBuffer);
    if (m) {
      var trig = m[1];
      var cache = window.__snippetsCache || [];
      var snip = cache.find(function (s) { return s.trigger === trig; });
      if (snip) {
        // Eat the keystroke now; run the async expansion separately. We can't
        // use window.prompt() — Electron disables it. promptForValue() is an
        // inline DOM modal that returns Promise<string|null>.
        var triggerLen = m[0].length;
        var trailing = (data === '\r' || data === '\n' || data === '\r\n' || data === '\n\r') ? '\r' : '';
        col.snippetBuffer = '';
        runSnippetExpansion(colId, snip, triggerLen, trailing);
        return true;
      }
    }
    // No match — clear buffer and let the keystroke pass through
    col.snippetBuffer = '';
    return false;
  }

  // Accumulate single printable chars (length 1, >= space) into the buffer.
  // Bigger chunks (paste) reset rather than accumulate, since multi-char
  // pastes don't represent typed triggers.
  if (data.length === 1 && data >= ' ') {
    col.snippetBuffer += data;
    if (col.snippetBuffer.length > 200) col.snippetBuffer = col.snippetBuffer.slice(-200);
  } else if (data.length > 1) {
    col.snippetBuffer = '';
  }
  return false;
}

// Async snippet expansion: collects {{var}} values one-by-one via an inline
// modal, then erases the typed trigger and sends the expanded body to the
// column's pty. Cancel aborts cleanly.
function runSnippetExpansion(colId, snip, triggerLen, trailing) {
  var body = snip.body || '';
  var varNames = [];
  body.replace(/\{\{(\w+)\}\}/g, function (_, n) {
    if (varNames.indexOf(n) === -1) varNames.push(n);
    return _;
  });
  var values = {};
  function next(i) {
    if (i >= varNames.length) {
      var expanded = body.replace(/\{\{(\w+)\}\}/g, function (_, n) { return values[n] || ''; });
      var eraseStr = '';
      for (var ei = 0; ei < triggerLen; ei++) eraseStr += '\b \b';
      wsSend({ type: 'write', id: colId, data: eraseStr + expanded + trailing });
      return;
    }
    promptForValue('Value for {{' + varNames[i] + '}}:').then(function (v) {
      if (v === null) return;  // cancelled — abort the whole expansion
      values[varNames[i]] = v;
      next(i + 1);
    });
  }
  next(0);
}

// Inline async prompt: returns Promise<string|null>. null = cancelled.
// Replacement for window.prompt() which Electron disables.
function promptForValue(message) {
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'snippet-prompt-overlay';
    var dialog = document.createElement('div');
    dialog.className = 'snippet-prompt-dialog';
    var label = document.createElement('div');
    label.className = 'snippet-prompt-label';
    label.textContent = message;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'snippet-prompt-input';
    var actions = document.createElement('div');
    actions.className = 'snippet-prompt-actions';
    var cancel = document.createElement('button');
    cancel.className = 'snippet-prompt-cancel';
    cancel.textContent = 'Cancel';
    var ok = document.createElement('button');
    ok.className = 'snippet-prompt-ok';
    ok.textContent = 'OK';
    actions.appendChild(cancel);
    actions.appendChild(ok);
    dialog.appendChild(label);
    dialog.appendChild(input);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    setTimeout(function () { input.focus(); }, 0);

    function done(value) {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(value);
    }
    ok.addEventListener('click', function () { done(input.value); });
    cancel.addEventListener('click', function () { done(null); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) done(null);
    });
  });
}

// Inline async confirm: returns Promise<boolean>. Non-blocking replacement
// for window.confirm() which is fine but the OS-level dialog blocks the
// entire renderer thread (and looks out of place on macOS where it pulls
// system focus).
function confirmDialog(message, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'snippet-prompt-overlay';
    var dialog = document.createElement('div');
    dialog.className = 'snippet-prompt-dialog';
    var label = document.createElement('div');
    label.className = 'snippet-prompt-label';
    label.textContent = message;
    var actions = document.createElement('div');
    actions.className = 'snippet-prompt-actions';
    var cancel = document.createElement('button');
    cancel.className = 'snippet-prompt-cancel';
    cancel.textContent = opts.cancelLabel || 'Cancel';
    var ok = document.createElement('button');
    ok.className = 'snippet-prompt-ok';
    ok.textContent = opts.okLabel || 'OK';
    if (opts.dangerous) ok.style.background = '#dc2626';
    actions.appendChild(cancel);
    actions.appendChild(ok);
    dialog.appendChild(label);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    setTimeout(function () { ok.focus(); }, 0);
    function done(v) {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(v);
    }
    ok.addEventListener('click', function () { done(true); });
    cancel.addEventListener('click', function () { done(false); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', function onKey(e) {
      if (!overlay.parentNode) { document.removeEventListener('keydown', onKey); return; }
      if (e.key === 'Escape') { e.preventDefault(); done(false); document.removeEventListener('keydown', onKey); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); document.removeEventListener('keydown', onKey); }
    });
  });
}

// Lightweight toast. Stacks at top-right; auto-dismisses unless duration: 0.
function showToast(message, opts) {
  opts = opts || {};
  var container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + (opts.kind || 'info');
  toast.textContent = message;
  if (opts.action && opts.action.label) {
    var actionBtn = document.createElement('button');
    actionBtn.className = 'toast-action';
    actionBtn.textContent = opts.action.label;
    actionBtn.addEventListener('click', function () {
      try { if (typeof opts.action.onClick === 'function') opts.action.onClick(); }
      finally { if (toast.parentNode) toast.parentNode.removeChild(toast); }
    });
    toast.appendChild(actionBtn);
  }
  container.appendChild(toast);
  if (opts.duration !== 0) {
    setTimeout(function () {
      toast.classList.add('toast-out');
      setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 200);
    }, opts.duration || 3500);
  }
  return toast;
}

function saveColumnCounts() {
  for (var i = 0; i < config.projects.length; i++) {
    var key = config.projects[i].path;
    var state = projectStates.get(key);
    config.projects[i].columnCount = state ? state.columns.size : 0;
  }
  saveConfig();
}

function updateProjectBadges() {
  if (popoutMode) return; // sidebar not rendered in popout windows
  config.projects.forEach(function (project) {
    // Match by path, not positional index: pinned/grouped projects reorder the
    // DOM, so items[index] would target the wrong project's row.
    var item = projectListEl.querySelector('.project-item[data-project-path="' + CSS.escape(project.path) + '"]');
    if (!item) return;
    var middle = item.querySelector('.project-right-middle');
    if (!middle) return;
    var existingBadge = middle.querySelector('.project-badge');
    // Primary badge reflects Primary columns only (stateKey with null ws id).
    var state = projectStates.get(stateKey(project.path, null));
    var count = state ? state.columns.size : 0;
    if (count > 0 && !existingBadge) {
      var badge = document.createElement('span');
      badge.className = 'project-badge';
      var icon = document.createElement('img');
      icon.className = 'claude-icon';
      icon.src = './claude-small.png';
      icon.alt = '';
      badge.appendChild(icon);
      middle.insertBefore(badge, middle.firstChild);
    } else if (count === 0 && existingBadge) {
      existingBadge.remove();
    }
  });
}

// Find which row a column belongs to
function findRowForColumn(state, columnId) {
  for (var i = 0; i < state.rows.length; i++) {
    if (state.rows[i].columnIds.indexOf(columnId) !== -1) return state.rows[i];
  }
  return null;
}

// Get the row containing the focused column, or the last row
function getActiveRow(state) {
  if (state.focusedColumnId !== null) {
    var row = findRowForColumn(state, state.focusedColumnId);
    if (row) return row;
  }
  if (state.rows.length > 0) return state.rows[state.rows.length - 1];
  return null;
}

// ============================================================
// Row Management
// ============================================================

function addRowToProject(state) {
  var rowId = ++globalRowId;

  // Add row resize handle if there are existing rows
  if (state.rows.length > 0) {
    var handle = document.createElement('div');
    handle.className = 'row-resize-handle';
    handle.dataset.topRowId = String(state.rows[state.rows.length - 1].id);
    handle.dataset.bottomRowId = String(rowId);
    state.containerEl.appendChild(handle);
    setupRowResizeHandle(handle);
  }

  var rowEl = document.createElement('div');
  rowEl.className = 'row';
  rowEl.dataset.rowId = String(rowId);
  state.containerEl.appendChild(rowEl);

  var row = { id: rowId, el: rowEl, columnIds: [] };
  state.rows.push(row);
  return row;
}

function removeRowIfEmpty(state, row) {
  if (row.columnIds.length > 0) return;

  var idx = state.rows.indexOf(row);
  if (idx === -1) return;

  // Remove the row element
  var rowEl = row.el;
  var prevSibling = rowEl.previousElementSibling;
  var nextSibling = rowEl.nextElementSibling;

  rowEl.remove();

  // Remove adjacent row resize handle
  if (prevSibling && prevSibling.classList.contains('row-resize-handle')) {
    prevSibling.remove();
  } else if (nextSibling && nextSibling.classList.contains('row-resize-handle')) {
    nextSibling.remove();
  }

  state.rows.splice(idx, 1);

  // Surviving rows may carry stuck inline `flex: none; height: <px>` left over from a prior
  // row-resize drag — without redistribution they stay locked at pre-collapse pixel heights.
  if (state.rows.length > 0) {
    var hidden = !!(state.containerEl && state.containerEl.offsetParent === null);
    var heights = [];
    for (var i = 0; i < state.rows.length; i++) {
      var h;
      if (hidden) {
        h = (typeof state.rows[i].lastHeightRatio === 'number' && state.rows[i].lastHeightRatio > 0)
          ? state.rows[i].lastHeightRatio
          : 1;
      } else {
        h = state.rows[i].el.getBoundingClientRect().height;
      }
      heights.push(h);
    }
    var ratios = window.RowLayout.computeProportionalRowRatios(heights);
    for (var j = 0; j < state.rows.length; j++) {
      state.rows[j].el.style.flex = ratios[j] + ' 1 0';
      state.rows[j].el.style.height = '';
      state.rows[j].lastHeightRatio = ratios[j];
    }
  }
}

function applyLayoutRatios(state, entries, rowHeightByIdx, rowsByIdx) {
  // Group entries by row index in spawn order so we can pair with row.columnIds[].
  var byRow = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    (byRow[e.rowIdx] = byRow[e.rowIdx] || []).push(e);
  }

  // Column widths.
  for (var rIdx in byRow) {
    if (!Object.prototype.hasOwnProperty.call(byRow, rIdx)) continue;
    var row = (rowsByIdx && rowsByIdx[rIdx]) || state.rows[rIdx];
    if (!row) continue;
    var rowEntries = byRow[rIdx];
    var allHaveRatio = rowEntries.every(function (e) { return e.widthRatio !== null; });
    var persistableCount = 0;
    for (var pc = 0; pc < row.columnIds.length; pc++) {
      var pcCol = state.columns.get(row.columnIds[pc]);
      if (pcCol && pcCol.sessionId) persistableCount++;
    }
    if (!allHaveRatio || rowEntries.length !== persistableCount) continue;
    var sum = rowEntries.reduce(function (s, e) { return s + e.widthRatio; }, 0);
    if (!(sum > 0)) continue;
    var entryIdx = 0;
    for (var c = 0; c < row.columnIds.length; c++) {
      var col = state.columns.get(row.columnIds[c]);
      if (!col) continue;
      if (col.sessionId && entryIdx < rowEntries.length) {
        var ratio = rowEntries[entryIdx].widthRatio / sum;
        col.element.style.flex = ratio + ' 1 0';
        col.element.style.width = '';
        col.lastWidthRatio = ratio;
        entryIdx++;
      } else {
        col.element.style.flex = '1 1 0';
        col.element.style.width = '';
      }
    }
  }

  // Row heights — only apply if every actual row maps back to an original index with a heightRatio.
  if (rowsByIdx) {
    var ratiosForActualRows = [];
    for (var ri = 0; ri < state.rows.length; ri++) {
      var matched = null;
      for (var origIdx in rowsByIdx) {
        if (rowsByIdx[origIdx] === state.rows[ri] && typeof rowHeightByIdx[origIdx] === 'number') {
          matched = rowHeightByIdx[origIdx];
          break;
        }
      }
      if (matched === null) { ratiosForActualRows = null; break; }
      ratiosForActualRows.push(matched);
    }
    if (ratiosForActualRows && ratiosForActualRows.length > 0) {
      var hSum = ratiosForActualRows.reduce(function (s, v) { return s + v; }, 0);
      if (hSum > 0) {
        for (var ri2 = 0; ri2 < state.rows.length; ri2++) {
          var rRatio = ratiosForActualRows[ri2] / hSum;
          state.rows[ri2].el.style.flex = rRatio + ' 1 0';
          state.rows[ri2].el.style.height = '';
          state.rows[ri2].lastHeightRatio = rRatio;
        }
      }
    }
  }
  refitAll();
}

function applyLayoutRatios(state, entries, rowHeightByIdx, rowsByIdx) {
  // Group entries by row index in spawn order so we can pair with row.columnIds[].
  var byRow = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    (byRow[e.rowIdx] = byRow[e.rowIdx] || []).push(e);
  }

  // Column widths.
  for (var rIdx in byRow) {
    if (!Object.prototype.hasOwnProperty.call(byRow, rIdx)) continue;
    var row = (rowsByIdx && rowsByIdx[rIdx]) || state.rows[rIdx];
    if (!row) continue;
    var rowEntries = byRow[rIdx];
    var allHaveRatio = rowEntries.every(function (e) { return e.widthRatio !== null; });
    var persistableCount = 0;
    for (var pc = 0; pc < row.columnIds.length; pc++) {
      var pcCol = state.columns.get(row.columnIds[pc]);
      if (pcCol && pcCol.sessionId) persistableCount++;
    }
    if (!allHaveRatio || rowEntries.length !== persistableCount) continue;
    var sum = rowEntries.reduce(function (s, e) { return s + e.widthRatio; }, 0);
    if (!(sum > 0)) continue;
    var entryIdx = 0;
    for (var c = 0; c < row.columnIds.length; c++) {
      var col = state.columns.get(row.columnIds[c]);
      if (!col) continue;
      if (col.sessionId && entryIdx < rowEntries.length) {
        var ratio = rowEntries[entryIdx].widthRatio / sum;
        col.element.style.flex = ratio + ' 1 0';
        col.element.style.width = '';
        col.lastWidthRatio = ratio;
        entryIdx++;
      } else {
        col.element.style.flex = '1 1 0';
        col.element.style.width = '';
      }
    }
  }

  // Row heights — only apply if every actual row maps back to an original index with a heightRatio.
  if (rowsByIdx) {
    var ratiosForActualRows = [];
    for (var ri = 0; ri < state.rows.length; ri++) {
      var matched = null;
      for (var origIdx in rowsByIdx) {
        if (rowsByIdx[origIdx] === state.rows[ri] && typeof rowHeightByIdx[origIdx] === 'number') {
          matched = rowHeightByIdx[origIdx];
          break;
        }
      }
      if (matched === null) { ratiosForActualRows = null; break; }
      ratiosForActualRows.push(matched);
    }
    if (ratiosForActualRows && ratiosForActualRows.length > 0) {
      var hSum = ratiosForActualRows.reduce(function (s, v) { return s + v; }, 0);
      if (hSum > 0) {
        for (var ri2 = 0; ri2 < state.rows.length; ri2++) {
          var rRatio = ratiosForActualRows[ri2] / hSum;
          state.rows[ri2].el.style.flex = rRatio + ' 1 0';
          state.rows[ri2].el.style.height = '';
          state.rows[ri2].lastHeightRatio = rRatio;
        }
      }
    }
  }
  refitAll();
}

// ============================================================
// Project Management
// ============================================================

function loadProjects() {
  if (!window.electronAPI) return;
  window.electronAPI.getProjects().then(function (cfg) {
    config = cfg || { projects: [], activeProjectIndex: -1 };
    // Drop any corrupt null entries (can appear from a failed drag-reorder splice).
    if (Array.isArray(config.projects)) {
      config.projects = config.projects.filter(function (p) { return p && typeof p === 'object'; });
    } else {
      config.projects = [];
    }
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].columnCount === undefined) {
        config.projects[i].columnCount = 1;
      }
      if (config.projects[i].poppedOut === undefined) {
        config.projects[i].poppedOut = false;
      }
      if (config.projects[i].popoutBounds === undefined) {
        config.projects[i].popoutBounds = null;
      }
      if (!Array.isArray(config.projects[i].workspaces)) {
        config.projects[i].workspaces = [];
      }
      if (config.projects[i].activeWorkspaceId === undefined) {
        config.projects[i].activeWorkspaceId = null;
      }
    }
    if (config.fontSize) {
      fontSize = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, config.fontSize));
    }
    if (isValidEffort(config.defaultEffortCloud)) defaultEffortCloud = config.defaultEffortCloud;
    if (isValidEffort(config.defaultEffortLocal)) defaultEffortLocal = config.defaultEffortLocal;
    if (optDefaultEffortCloud) optDefaultEffortCloud.value = defaultEffortCloud;
    if (optDefaultEffortLocal) optDefaultEffortLocal.value = defaultEffortLocal;
    // Default to 'auto' so the app follows the OS theme out of the box.
    // Legacy/unset configs land here too.
    setThemePreference(config.theme || 'auto');
    if (config.sidebarWidth) {
      applySidebarWidth(config.sidebarWidth);
    }
    syncPanelToggleStates();
    loadNotifSettings();
    updateSortButton();

    if (popoutMode) {
      var idx = config.projects.findIndex(function (p) { return p.path === popoutProjectKey; });
      if (idx < 0) {
        document.title = 'Claudes \u2013 (project missing)';
        showEmptyState();
        return;
      }
      // Prefer a live pty transfer from the other window (preserves running
      // claude processes) over rehydrating from sessions.json.
      if (window.electronAPI && window.electronAPI.popoutTakeTransfer) {
        window.electronAPI.popoutTakeTransfer(popoutProjectKey).then(function (transfer) {
          if (transfer && transfer.length > 0) {
            applyTransferredColumns(idx, transfer);
          } else {
            activatePopoutProject(idx);
          }
        });
      } else {
        activatePopoutProject(idx);
      }
      return;
    }

    renderProjectList();
    if (config.activeProjectIndex >= 0
        && config.projects[config.activeProjectIndex]
        && !config.projects[config.activeProjectIndex].poppedOut) {
      setActiveProject(config.activeProjectIndex, true);
    } else {
      var firstAvailable = config.projects.findIndex(function (p) { return !p.poppedOut; });
      if (firstAvailable >= 0) {
        setActiveProject(firstAvailable, true);
      } else {
        showEmptyState();
      }
    }
    loadHeadlessRunsForActiveProject();
  });
}
if (window.electronAPI && window.electronAPI.onConfigUpdated) {
  window.electronAPI.onConfigUpdated(function (newCfg) {
    if (!newCfg) return;
    // Detect pop-in transitions (poppedOut true -> false) so main can rehydrate
    // the project from sessions.json. Pop-outs are handled proactively in
    // prepareAndPopOut (so sessions.json is already correct when the popout
    // reads it); we don't need a reactive dispose here.
    var justPoppedIn = [];
    var oldMap = {};
    (config.projects || []).forEach(function (p) { if (p) oldMap[p.path] = !!p.poppedOut; });
    (newCfg.projects || []).forEach(function (p) {
      if (!p) return;
      if (oldMap[p.path] === true && p.poppedOut === false) justPoppedIn.push(p.path);
    });

    config = newCfg;
    if (popoutMode) {
      var p = config.projects.find(function (x) { return x.path === popoutProjectKey; });
      if (p) {
        activeProjectNameEl.textContent = p.name;
        document.title = 'Claudes \u2013 ' + p.name;
      }
    } else {
      renderProjectList();
      if (config.activeProjectIndex >= 0) {
        var cur = config.projects[config.activeProjectIndex];
        if (cur && cur.poppedOut) {
          var prevKey = activeProjectKey;
          var prevState = prevKey ? projectStates.get(prevKey) : null;
          if (prevState) prevState.containerEl.style.display = 'none';
          var next = config.projects.findIndex(function (p) { return !p.poppedOut; });
          if (next >= 0) {
            setActiveProject(next, false);
          } else {
            activeProjectKey = null;
            activeProjectNameEl.textContent = '';
            showEmptyState();
          }
        }
      }
      justPoppedIn.forEach(function (projectPath) {
        handleProjectPoppedIn(projectPath);
      });
    }
  });
}

function prepareAndPopOut(projectPath) {
  // Hand this project's columns off to a popout window. Doing it proactively
  // (before the popout opens) avoids a race: the popout's renderer starts
  // loading as soon as main.js creates the window, and it reads sessions.json
  // on boot. If we relied on a reactive dispose in onConfigUpdated, the
  // popout could read sessions.json before the snapshot-restore IPC was
  // written to disk, and spawn a single blank column instead of resuming.
  //
  // Order:
  //   1. Snapshot the current session list for the project.
  //   2. Tear down main's DOM/xterms/ptys (removeColumn re-writes sessions
  //      .json as it runs, ending at []).
  //   3. Await saveSessions(snapshot) — IPCs are FIFO, so this lands after
  //      every removeColumn's persistSessions has flushed.
  //   4. Only then tell main.js to create the popout window.
  if (!window.electronAPI || !window.electronAPI.saveSessions || !window.electronAPI.popOutProject) {
    return;
  }
  var state = projectStates.get(projectPath);
  var transfer = [];
  if (state) {
    state.columns.forEach(function (col, id) {
      transfer.push({
        ptyId: id,
        cols: col.terminal ? col.terminal.cols : 120,
        rows: col.terminal ? col.terminal.rows : 30,
        cwd: col.cwd || projectPath,
        cwdSource: col.cwdSource || null,
        cmd: col.cmd || null,
        cmdArgs: col.cmdArgs || [],
        env: col.env || null,
        sessionId: col.sessionId || null,
        title: col.customTitle || null,
        isDiff: !!col.isDiff
      });
    });

    var ids = Array.from(state.columns.keys());
    ids.forEach(function (id) { disposeColumnLocalOnly(id); });

    if (state.containerEl) state.containerEl.remove();
    projectStates.delete(projectPath);
    if (activeProjectKey === projectPath) {
      activeProjectKey = null;
    }
  }
  window.electronAPI.popoutSetTransfer(projectPath, transfer).then(function () {
    return window.electronAPI.popOutProject(projectPath);
  });
}

// Invoked from main.js via webContents.executeJavaScript during popout close.
// Collects this window's columns for the active project so main can reattach.
window.collectPopoutTransferForClose = function () {
  if (!popoutMode || !popoutProjectKey) return [];
  var state = projectStates.get(popoutProjectKey);
  if (!state) return [];
  var list = [];
  state.columns.forEach(function (col, id) {
    list.push({
      ptyId: id,
      cols: col.terminal ? col.terminal.cols : 120,
      rows: col.terminal ? col.terminal.rows : 30,
      cwd: col.cwd || popoutProjectKey,
      cwdSource: col.cwdSource || null,
      cmd: col.cmd || null,
      cmdArgs: col.cmdArgs || [],
      env: col.env || null,
      sessionId: col.sessionId || null,
      title: col.customTitle || null,
      isDiff: !!col.isDiff
    });
  });
  return list;
};

function applyTransferredColumns(projIdx, transfer) {
  // Called when a window receives a pty transfer from another window.
  // Creates the project's columns by reattaching to the existing pty ids
  // instead of spawning fresh claude processes — preserves running state.
  //
  // Populate state first, THEN call setActiveProject. Doing it in that order
  // means setActiveProject sees state.columns.size > 0 and skips its default
  // "spawn a blank column" path for empty projects.
  var project = config.projects[projIdx];
  if (!project) return;

  var prevActive = activeProjectKey;
  activeProjectKey = project.path; // addColumn targets activeProjectKey
  getOrCreateProjectState(project.path);

  transfer.forEach(function (entry) {
    addColumn(entry.cmdArgs || [], null, {
      reattachPtyId: entry.ptyId,
      sessionId: entry.sessionId,
      title: entry.title,
      cmd: entry.cmd,
      env: entry.env,
      cwd: entry.cwd,
      cwdSource: entry.cwdSource || null,
      isDiff: entry.isDiff,
      workspaceId: null // popouts are Primary-only
    });
  });

  activeProjectKey = prevActive;
  if (popoutMode) {
    activatePopoutProject(projIdx);
  } else {
    setActiveProject(projIdx, false);
  }
  persistSessions(project.path, null);
}

function disposeColumnLocalOnly(id) {
  // Like removeColumn, but keeps the pty alive in pty-server (no kill) and
  // does not rewrite sessions.json. Used when transferring a column to another
  // window: the popout will reattach to the same pty id.
  var col = allColumns.get(id);
  if (!col) return;
  if (maximizedColumnId === id) toggleMaximizeColumn(id);
  var timer = activityTimers.get(id);
  if (timer) clearTimeout(timer);
  activityTimers.delete(id);
  stopSessionSync(id);

  var colElement = col.element;
  var prevSibling = colElement.previousElementSibling;
  var nextSibling = colElement.nextElementSibling;
  colElement.remove();
  if (prevSibling && prevSibling.classList.contains('resize-handle')) {
    prevSibling.remove();
  } else if (nextSibling && nextSibling.classList.contains('resize-handle')) {
    nextSibling.remove();
  }

  if (col.wrapResizeDisconnect) col.wrapResizeDisconnect();
  releaseWebglForColumn(id);
  if (col.terminal) col.terminal.dispose();
  allColumns.delete(id);

  var state = projectStates.get(stateKey(col.projectKey, col.workspaceId));
  if (state) {
    state.columns.delete(id);
    for (var r = 0; r < state.rows.length; r++) {
      var idx = state.rows[r].columnIds.indexOf(id);
      if (idx !== -1) {
        state.rows[r].columnIds.splice(idx, 1);
        removeRowIfEmpty(state, state.rows[r]);
        break;
      }
    }
    if (state.focusedColumnId === id) state.focusedColumnId = null;
    if (lastFocusedColumnId === id) lastFocusedColumnId = null;
    if (window.Clawd && typeof window.Clawd.forgetColumn === 'function') {
      window.Clawd.forgetColumn(id);
    }
    if (window.electronAPI && window.electronAPI.clawdStopTail) {
      window.electronAPI.clawdStopTail(id);
    }
  }
}

function handleProjectPoppedIn(projectPath) {
  // Popout window for this project just closed. Bring its content back to main:
  // if the popout handed over a pty transfer, reattach those ptys in main
  // (preserves running claude processes). Otherwise fall back to rehydrating
  // from sessions.json.
  var idx = -1;
  for (var i = 0; i < config.projects.length; i++) {
    if (config.projects[i].path === projectPath) { idx = i; break; }
  }
  if (idx < 0) return;

  if (window.electronAPI && window.electronAPI.popoutTakeTransfer) {
    window.electronAPI.popoutTakeTransfer(projectPath).then(function (transfer) {
      if (transfer && transfer.length > 0) {
        applyTransferredColumns(idx, transfer);
      } else {
        setActiveProject(idx, true);
      }
    });
  } else {
    setActiveProject(idx, true);
  }
}

function saveConfig() {
  if (!window.electronAPI) return;
  window.electronAPI.saveProjects(config);
}

function projectGroupKey(project) {
  if (!project || project.ungrouped) return null;
  var name = project.name || '';
  if (!name) return null;
  var i = name.indexOf('-');
  return i <= 0 ? name : name.slice(0, i);
}

function computeProjectGroups() {
  var counts = Object.create(null);
  config.projects.forEach(function (p) {
    var k = projectGroupKey(p);
    if (k) counts[k] = (counts[k] || 0) + 1;
  });
  return counts;
}

// Create a new sub-workspace under `config.projects[projectIndex]`, immediately
// activate it, and enter inline-rename mode on the new row's name element.
function addWorkspace(projectIndex) {
  var project = config.projects[projectIndex];
  if (!project) return;
  if (!Array.isArray(project.workspaces)) project.workspaces = [];

  // Retry on (astronomically unlikely) id collision within the same project.
  var ws = null;
  for (var attempt = 0; attempt < 5; attempt++) {
    var id = 'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 10);
    if (!project.workspaces.some(function (w) { return w && w.id === id; })) {
      ws = { id: id, name: 'New workspace', createdAt: Date.now() };
      break;
    }
  }
  if (!ws) return;
  project.workspaces.push(ws);
  saveConfig();
  renderProjectList();
  setActiveWorkspace(projectIndex, ws.id, false);

  // Focus the new name element and start inline-rename so the placeholder
  // text is selected for immediate replacement.
  var nameEl = projectListEl.querySelector(
    '.workspace-item[data-workspace-id="' + CSS.escape(ws.id) + '"] .workspace-name'
  );
  if (nameEl) {
    startInlineRename(nameEl, {
      onCommit: function (text) {
        ws.name = text;
        saveConfig();
        renderProjectList();
      }
    });
  }
}

// Delete a sub-workspace from a project. Order matters — we splice from
// project.workspaces FIRST so persistSessions' deletion guard short-circuits
// any in-flight column-level writes that might race, then tear down the
// columns (which kills PTYs), then scrub the disk blob, then switch active
// back to Primary if needed.
function deleteWorkspace(projectIndex, workspaceId) {
  var project = config.projects[projectIndex];
  if (!project) return;
  if (!Array.isArray(project.workspaces)) return;
  var wsIdx = -1;
  for (var i = 0; i < project.workspaces.length; i++) {
    if (project.workspaces[i] && project.workspaces[i].id === workspaceId) {
      wsIdx = i; break;
    }
  }
  if (wsIdx === -1) return;

  var wasActive = project.activeWorkspaceId === workspaceId;
  project.workspaces.splice(wsIdx, 1); // (1) guard trips for any late persist

  // (2) Collect column ids for this workspace and remove each. removeColumn
  //     calls persistSessions, whose guard now no-ops thanks to step (1).
  var state = projectStates.get(stateKey(project.path, workspaceId));
  var colIds = state ? Array.from(state.columns.keys()) : [];
  colIds.forEach(function (id) { removeColumn(id); });

  // (3) Drop the workspace's state bucket entirely — its containerEl/rows are
  //     now gone anyway, but the Map entry would otherwise leak.
  if (state && state.containerEl) state.containerEl.remove();
  projectStates.delete(stateKey(project.path, workspaceId));

  // (4) Scrub the disk blob.
  if (window.electronAPI) {
    window.electronAPI.loadSessions(project.path).then(function (blob) {
      if (!blob || typeof blob !== 'object') return;
      if (blob.workspaces && blob.workspaces[workspaceId]) {
        delete blob.workspaces[workspaceId];
        window.electronAPI.saveSessions(project.path, blob);
      }
    });
  }

  projectsNeedingAttention.delete(stateKey(project.path, workspaceId));

  // (5) Route active back to Primary if we just deleted the active ws.
  if (wasActive) {
    setActiveWorkspace(projectIndex, null, false);
  }

  if (window.electronAPI && window.electronAPI.scrubWorkspaceArtifacts) {
    window.electronAPI.scrubWorkspaceArtifacts(project.path, workspaceId);
  }

  saveConfig();
  renderProjectList();
  updateSidebarActivity();
}

function buildWorkspaceItem(project, projectIndex, ws, wsIndex) {
  var wsItem = document.createElement('div');
  wsItem.className = 'workspace-item';
  wsItem.dataset.projectPath = project.path;
  wsItem.dataset.workspaceId = ws.id;
  if (projectIndex === config.activeProjectIndex && project.activeWorkspaceId === ws.id) {
    wsItem.className += ' active';
  }
  if (projectsNeedingAttention.has(stateKey(project.path, ws.id))) {
    wsItem.className += ' attention-flash';
  }

  var nameEl = document.createElement('div');
  nameEl.className = 'workspace-name';
  nameEl.textContent = ws.name;
  nameEl.addEventListener('dblclick', function (e) {
    e.stopPropagation();
    startInlineRename(nameEl, {
      onCommit: function (text) {
        ws.name = text;
        saveConfig();
        renderProjectList();
      }
    });
  });

  var right = document.createElement('div');
  right.className = 'workspace-right';

  var wsState = projectStates.get(stateKey(project.path, ws.id));
  var wsCount = wsState ? wsState.columns.size : 0;
  if (wsCount > 0) {
    var wsBadge = document.createElement('span');
    wsBadge.className = 'workspace-badge';
    var wsIcon = document.createElement('img');
    wsIcon.className = 'claude-icon';
    wsIcon.src = './claude-small.png';
    wsIcon.alt = '';
    wsBadge.appendChild(wsIcon);
    right.appendChild(wsBadge);
  }

  var wsRemove = document.createElement('span');
  wsRemove.className = 'workspace-remove';
  wsRemove.textContent = '×';
  wsRemove.title = 'Delete workspace';
  wsRemove.addEventListener('click', function (e) {
    e.stopPropagation();
    if (confirm('Delete workspace "' + ws.name + '"? This will kill its terminals.')) {
      deleteWorkspace(projectIndex, ws.id);
    }
  });
  right.appendChild(wsRemove);

  wsItem.appendChild(nameEl);
  wsItem.appendChild(right);

  wsItem.addEventListener('click', function () {
    setActiveWorkspace(projectIndex, ws.id, false);
  });

  // Suppress the default browser context menu (would otherwise surface inside
  // the app chrome on right-click). A minimal Rename/Delete menu can land here
  // in a later phase.
  wsItem.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  });

  // Drag-reorder within the same project only. Cross-project drops are
  // discarded (dropEffect='none') — out of scope for this feature.
  wsItem.setAttribute('draggable', 'true');
  wsItem.addEventListener('dragstart', function (e) {
    workspaceDragFromIndex = wsIndex;
    workspaceDragFromProjectPath = project.path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    setTimeout(function () { wsItem.classList.add('dragging'); }, 0);
  });
  wsItem.addEventListener('dragend', function () {
    wsItem.classList.remove('dragging');
    workspaceDragFromIndex = -1;
    workspaceDragFromProjectPath = null;
    document.querySelectorAll('.workspace-item.drag-over').forEach(function (el) {
      el.classList.remove('drag-over');
    });
  });
  wsItem.addEventListener('dragover', function (e) {
    if (workspaceDragFromIndex === -1
        || workspaceDragFromProjectPath !== project.path) {
      // Wrong-project or non-workspace drag — refuse silently.
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (workspaceDragFromIndex !== wsIndex) {
      wsItem.classList.add('drag-over');
    }
  });
  wsItem.addEventListener('dragleave', function () {
    wsItem.classList.remove('drag-over');
  });
  wsItem.addEventListener('drop', function (e) {
    if (workspaceDragFromProjectPath !== project.path) return;
    e.preventDefault();
    wsItem.classList.remove('drag-over');
    var fromIdx = workspaceDragFromIndex;
    workspaceDragFromIndex = -1;
    workspaceDragFromProjectPath = null;
    if (fromIdx === -1 || fromIdx === wsIndex) return;
    var moved = project.workspaces.splice(fromIdx, 1)[0];
    project.workspaces.splice(wsIndex, 0, moved);
    saveConfig();
    renderProjectList();
  });

  return wsItem;
}

function buildProjectItem(project, index) {
  var key = project.path;
  // Primary badge count = only columns in Primary's state bucket.
  var primaryState = projectStates.get(stateKey(key, null));
  var count = primaryState ? primaryState.columns.size : 0;

  var item = document.createElement('div');
  item.className = 'project-item';
  item.dataset.projectPath = key;
  // Project card is highlighted only when Primary is the active workspace.
  // When a sub-workspace is active, the .workspace-item gets .active instead.
  if (index === config.activeProjectIndex && !project.poppedOut
      && project.activeWorkspaceId == null) {
    item.className += ' active';
  }
  if (projectsNeedingAttention.has(stateKey(key, null))) item.className += ' attention-flash';
  if (project.pinned) item.className += ' is-pinned';
  if (project.poppedOut) {
    item.className += ' popped-out';
    item.title = 'Open in separate window (click to focus)';
  }

  var info = document.createElement('div');
  info.style.overflow = 'hidden';
  info.style.flex = '1';

  var name = document.createElement('div');
  name.className = 'project-name';
  name.textContent = project.name;
  name.addEventListener('dblclick', function (e) {
    e.stopPropagation();
    var existingBadge = name.querySelector('.project-popout-badge');
    if (existingBadge) existingBadge.remove();
    var trailing = name.lastChild;
    if (trailing && trailing.nodeType === 3 && trailing.data === ' ') trailing.remove();
    name.textContent = config.projects[index].name || '';
    startInlineRename(name, {
      onCommit: function (text) {
        config.projects[index].name = text;
        saveConfig();
        renderProjectList();
      }
    });
  });
  if (project.poppedOut) {
    var badge = document.createElement('span');
    badge.className = 'project-popout-badge';
    badge.textContent = '\u29C9'; // two joined squares
    badge.title = 'In separate window';
    name.appendChild(document.createTextNode(' '));
    name.appendChild(badge);
  }

  var pathEl = document.createElement('div');
  pathEl.className = 'project-path';
  pathEl.textContent = project.path;

  var branchEl = document.createElement('div');
  branchEl.className = 'project-branch';
  branchEl.textContent = '';

  if (window.electronAPI && window.electronAPI.gitBranch) {
    (function (el, projectPath) {
      window.electronAPI.gitBranch(projectPath).then(function (branch) {
        if (branch) el.textContent = '\u2387 ' + branch.trim();
      }).catch(function () {});
    })(branchEl, project.path);
  }

  info.appendChild(name);
  info.appendChild(branchEl);
  info.appendChild(pathEl);

  // Right-side zones: × (top), badge+pin (middle), + (bottom). Flex-column
  // layout — see styles.css `.project-right`.
  var rightSide = document.createElement('div');
  rightSide.className = 'project-right';

  var middleRow = document.createElement('div');
  middleRow.className = 'project-right-middle';

  if (count > 0) {
    var badge = document.createElement('span');
    badge.className = 'project-badge';
    var claudeIcon = document.createElement('img');
    claudeIcon.className = 'claude-icon';
    claudeIcon.src = './claude-small.png';
    claudeIcon.alt = '';
    badge.appendChild(claudeIcon);
    middleRow.appendChild(badge);
  }

  var pinBtn = document.createElement('span');
  pinBtn.className = 'project-pin';
  pinBtn.textContent = '\uD83D\uDCCC'; // pushpin glyph — distinct from the Claude starburst badge
  pinBtn.title = project.pinned ? 'Unpin' : 'Pin to top';
  pinBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    togglePinProject(index);
  });
  middleRow.appendChild(pinBtn);

  // Add-workspace button (bottom-right). Click creates a new sub-workspace
  // and immediately enters inline-rename mode.
  var addWsBtn = document.createElement('span');
  addWsBtn.className = 'project-add-workspace';
  addWsBtn.textContent = '+';
  addWsBtn.title = 'New workspace';
  addWsBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (addWsBtn.classList.contains('disabled')) return;
    addWsBtn.classList.add('disabled');
    addWorkspace(index);
  });

  var removeBtn = document.createElement('span');
  removeBtn.className = 'project-remove';
  removeBtn.textContent = '\u00d7';
  removeBtn.title = 'Remove project';

  removeBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    removeProject(index);
  });

  if (project.hidden) {
    item.style.opacity = '0.4';
  }

  item.addEventListener('click', function () {
    if (project.poppedOut && window.electronAPI && window.electronAPI.focusPopoutWindow) {
      window.electronAPI.focusPopoutWindow(project.path);
      return;
    }
    // Clicking the project card always routes to Primary, even if the user
    // was previously on a sub-workspace.
    setActiveWorkspace(index, null, false);
  });

  var sortMode = config.projectSortMode || 'manual';
  if (sortMode === 'manual') item.setAttribute('draggable', 'true');
  item.addEventListener('dragstart', function (e) {
    projectDragFromIndex = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    setTimeout(function () { item.classList.add('dragging'); }, 0);
  });
  item.addEventListener('dragend', function () {
    item.classList.remove('dragging');
    projectDragFromIndex = -1;
    document.querySelectorAll('.project-item.drag-over').forEach(function (el) {
      el.classList.remove('drag-over');
    });
  });
  item.addEventListener('dragover', function (e) {
    // Don't paint the project-drop cursor over project cards while a workspace
    // drag is in flight — workspace drags are same-parent-only.
    if (workspaceDragFromIndex !== -1) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (projectDragFromIndex !== -1 && projectDragFromIndex !== index) {
      item.classList.add('drag-over');
    }
  });
  item.addEventListener('dragleave', function () {
    item.classList.remove('drag-over');
  });
  item.addEventListener('drop', function (e) {
    // Same guard — do not accept a workspace being dropped onto a project
    // card. The workspace's own drop handler will have fired on its row, or
    // the drop is simply discarded.
    if (workspaceDragFromIndex !== -1) return;
    e.preventDefault();
    item.classList.remove('drag-over');
    var fromIdx = projectDragFromIndex;
    projectDragFromIndex = -1;
    if (fromIdx === -1 || fromIdx === index) return;
    var moved = config.projects.splice(fromIdx, 1)[0];
    config.projects.splice(index, 0, moved);
    if (config.activeProjectIndex === fromIdx) {
      config.activeProjectIndex = index;
    } else if (fromIdx < config.activeProjectIndex && index >= config.activeProjectIndex) {
      config.activeProjectIndex--;
    } else if (fromIdx > config.activeProjectIndex && index <= config.activeProjectIndex) {
      config.activeProjectIndex++;
    }
    window.electronAPI.saveProjects(config);
    renderProjectList();
  });

  item.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var menu = document.getElementById('project-context-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'project-context-menu';
      menu.className = 'project-context-menu';
      document.body.appendChild(menu);
    }
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    var projIndex = index;
    var isHidden = project.hidden || false;
    var groupKey = projectGroupKey(project);
    var groupCounts = computeProjectGroups();
    var inGroup = groupKey && groupCounts[groupKey] >= 2;

    function addMenuItem(label, action) {
      var mi = document.createElement('div');
      mi.className = 'project-context-item';
      mi.dataset.action = action;
      mi.textContent = label;
      menu.appendChild(mi);
    }
    addMenuItem(project.pinned ? 'Unpin' : 'Pin to top', 'toggle-pin');
    addMenuItem(isHidden ? 'Show Project' : 'Hide Project', 'toggle-hide');
    addMenuItem(config.projects[projIndex].voiceMuted ? 'Unmute voice' : 'Mute voice', 'toggle-voice-mute');
    if (inGroup) {
      addMenuItem('Remove from "' + groupKey + '" group', 'ungroup');
    } else if (project.ungrouped && groupKey) {
      addMenuItem('Re-add to "' + groupKey + '" group', 'regroup');
    }
    if (project.poppedOut) {
      addMenuItem('Close separate window', 'pop-in');
    } else {
      addMenuItem('Open in new window', 'pop-out');
    }
    // "Open in external editor" lives on the per-file context menu in the
    // Explorer tree — at project level it's just a folder-open, which the
    // user can also reach via "Reveal in Explorer" and the file-tree menu.
    addMenuItem('Manage MCP servers…', 'manage-mcp');
    addMenuItem('Skills / agents / commands…', 'manage-ext');
    addMenuItem('Save current layout…', 'layout-save');
    addMenuItem('Restore layout…', 'layout-restore');
    var liveState = projectStates.get(project.path);
    var liveCount = liveState ? liveState.columns.size : 0;
    if (liveCount > 0) {
      addMenuItem('Kill all instances (' + liveCount + ')', 'kill-all');
    }

    // Sync entries — populated async so the labels reflect the current state.
    var syncDivider = document.createElement('div');
    syncDivider.className = 'project-context-item project-context-divider';
    syncDivider.style.cssText = 'border-top:1px solid var(--border-primary); padding:0; margin:4px 0; cursor:default;';
    menu.appendChild(syncDivider);
    var syncPlaceholder = document.createElement('div');
    syncPlaceholder.className = 'project-context-item';
    syncPlaceholder.textContent = 'Sync…';
    syncPlaceholder.style.opacity = '0.5';
    menu.appendChild(syncPlaceholder);

    if (window.electronAPI && window.electronAPI.syncGetProjectStatus) {
      window.electronAPI.syncGetProjectStatus(project.path).then(function (status) {
        if (menu.contains(syncPlaceholder)) menu.removeChild(syncPlaceholder);
        var exportLabel = status && status.syncExport ? '✓ Sync convos (on)' : 'Sync convos';
        addMenuItem(exportLabel, 'sync-toggle-export');
        var imports = (status && status.syncImports) || [];
        // Single entry-point: opens a modal that lists existing imports
        // with Remove buttons and includes an "Add import…" action. No
        // separate Manage item — pre-existing imports show in the same
        // modal as the add action.
        var importsLabel = imports.length > 0
          ? 'Import syncs… (' + imports.length + ')'
          : 'Import syncs…';
        addMenuItem(importsLabel, 'sync-imports');
        // Force sync: only useful once something is actually being synced.
        if ((status && status.syncExport) || imports.length > 0) {
          addMenuItem('Force sync now', 'sync-force');
        }
      });
    }

    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.style.display = 'block';

    menu.onclick = function (ev) {
      var action = ev.target.dataset.action;
      if (action === 'toggle-pin') {
        togglePinProject(projIndex);
      } else if (action === 'toggle-hide') {
        config.projects[projIndex].hidden = !config.projects[projIndex].hidden;
        window.electronAPI.saveProjects(config);
        renderProjectList();
      } else if (action === 'ungroup') {
        config.projects[projIndex].ungrouped = true;
        window.electronAPI.saveProjects(config);
        renderProjectList();
      } else if (action === 'regroup') {
        delete config.projects[projIndex].ungrouped;
        window.electronAPI.saveProjects(config);
        renderProjectList();
      } else if (action === 'pop-out') {
        prepareAndPopOut(config.projects[projIndex].path);
      } else if (action === 'pop-in') {
        if (window.electronAPI && window.electronAPI.popInProject) {
          window.electronAPI.popInProject(config.projects[projIndex].path);
        }
      } else if (action === 'sync-toggle-export') {
        handleSyncToggleExport(config.projects[projIndex].path);
      } else if (action === 'sync-imports') {
        handleSyncImports(config.projects[projIndex].path);
      } else if (action === 'sync-force') {
        handleSyncForce(config.projects[projIndex].path);
      } else if (action === 'manage-mcp') {
        openMcpModal(config.projects[projIndex].path);
      } else if (action === 'manage-ext') {
        openExtensionsModal(config.projects[projIndex].path);
      } else if (action === 'layout-save') {
        saveCurrentLayout(config.projects[projIndex].path);
      } else if (action === 'layout-restore') {
        chooseLayoutToRestore(config.projects[projIndex].path);
      } else if (action === 'kill-all') {
        killAllInstancesForProject(config.projects[projIndex].path);
      } else if (action === 'toggle-voice-mute') {
        config.projects[projIndex].voiceMuted = !config.projects[projIndex].voiceMuted;
        saveConfig();
      }
      menu.style.display = 'none';
    };

    setTimeout(function () {
      document.addEventListener('click', function closeMenu() {
        menu.style.display = 'none';
        document.removeEventListener('click', closeMenu);
      });
    }, 0);
  });

  // Top → middle → bottom assembly.
  rightSide.appendChild(removeBtn);
  rightSide.appendChild(middleRow);
  rightSide.appendChild(addWsBtn);
  item.appendChild(info);
  item.appendChild(rightSide);
  return item;
}

function renderProjectEntries(entries, parent, sectionSuffix) {
  var groupCounts = Object.create(null);
  entries.forEach(function (e) {
    var k = projectGroupKey(e.project);
    if (k) groupCounts[k] = (groupCounts[k] || 0) + 1;
  });
  var renderedGroups = Object.create(null);
  var groupContainers = Object.create(null);
  var collapseKeyOf = function (k) { return sectionSuffix ? k + sectionSuffix : k; };

  entries.forEach(function (entry) {
    var project = entry.project;
    var index = entry.index;
    var groupKey = projectGroupKey(project);
    var inGroup = groupKey && groupCounts[groupKey] >= 2;

    if (inGroup && !renderedGroups[groupKey]) {
      renderedGroups[groupKey] = true;
      var hasActiveChild = false;
      entries.forEach(function (e2) {
        if (projectGroupKey(e2.project) === groupKey && e2.index === config.activeProjectIndex) {
          hasActiveChild = true;
        }
      });
      var collapseKey = collapseKeyOf(groupKey);
      var collapsed = !!config.collapsedGroups[collapseKey] && !hasActiveChild;

      var header = document.createElement('div');
      header.className = 'project-group-header';
      if (collapsed) header.className += ' collapsed';
      if (sectionSuffix === '::pinned') header.className += ' pinned-group';

      var chev = document.createElement('span');
      chev.className = 'project-group-chevron';
      chev.textContent = '\u25BE';
      header.appendChild(chev);

      var nameEl = document.createElement('span');
      nameEl.className = 'project-group-name';
      nameEl.textContent = groupKey;
      header.appendChild(nameEl);

      var countEl = document.createElement('span');
      countEl.className = 'project-group-count';
      countEl.textContent = String(groupCounts[groupKey]);
      header.appendChild(countEl);

      header.addEventListener('click', function () {
        config.collapsedGroups[collapseKey] = !config.collapsedGroups[collapseKey];
        saveConfig();
        renderProjectList();
      });

      (function (gk) {
        header.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          e.stopPropagation();
          showGroupContextMenu(e, gk);
        });
      })(groupKey);

      parent.appendChild(header);

      var children = document.createElement('div');
      children.className = 'project-group-children';
      if (collapsed) children.className += ' collapsed';
      parent.appendChild(children);
      groupContainers[groupKey] = children;
    }

    var item = buildProjectItem(project, index);
    var targetParent = parent;
    if (inGroup) {
      item.classList.add('in-group');
      var container = groupContainers[groupKey];
      if (container) targetParent = container;
    }
    targetParent.appendChild(item);

    // Sub-workspaces render as peer indented rows directly under the project
    // card. Each has its own active state, badge, and name.
    if (Array.isArray(project.workspaces) && project.workspaces.length > 0) {
      project.workspaces.forEach(function (ws, wsIndex) {
        var wsItem = buildWorkspaceItem(project, index, ws, wsIndex);
        if (inGroup) wsItem.classList.add('in-group');
        targetParent.appendChild(wsItem);
      });
    }
  });
}

function renderProjectList() {
  while (projectListEl.firstChild) {
    projectListEl.removeChild(projectListEl.firstChild);
  }

  if (!config.collapsedGroups) config.collapsedGroups = {};
  var sortMode = config.projectSortMode || 'manual';

  var allEntries = config.projects.map(function (p, i) { return { project: p, index: i }; });
  var pinnedEntries = allEntries.filter(function (e) { return e.project.pinned; });
  var unpinnedEntries = allEntries.filter(function (e) { return !e.project.pinned; });

  function byName(a, b) {
    return (a.project.name || '').toLowerCase().localeCompare((b.project.name || '').toLowerCase());
  }
  if (sortMode === 'alpha') {
    pinnedEntries.sort(byName);
    unpinnedEntries.sort(byName);
  }

  if (pinnedEntries.length > 0) {
    var pinnedHeader = document.createElement('div');
    pinnedHeader.className = 'project-pinned-header';
    pinnedHeader.textContent = '\uD83D\uDCCC Pinned';
    projectListEl.appendChild(pinnedHeader);
    renderProjectEntries(pinnedEntries, projectListEl, '::pinned');
  }

  if (pinnedEntries.length > 0 && unpinnedEntries.length > 0) {
    var otherCollapsed = !!config.unpinnedCollapsed;
    var otherHeader = document.createElement('div');
    otherHeader.className = 'project-section-header';
    if (otherCollapsed) otherHeader.className += ' collapsed';

    var otherChev = document.createElement('span');
    otherChev.className = 'project-section-chevron';
    otherChev.textContent = '\u25BE';
    otherHeader.appendChild(otherChev);

    var otherLabel = document.createElement('span');
    otherLabel.textContent = 'Other';
    otherHeader.appendChild(otherLabel);

    var otherCount = document.createElement('span');
    otherCount.className = 'project-section-count';
    otherCount.textContent = String(unpinnedEntries.length);
    otherHeader.appendChild(otherCount);

    otherHeader.addEventListener('click', function () {
      config.unpinnedCollapsed = !config.unpinnedCollapsed;
      saveConfig();
      renderProjectList();
    });
    projectListEl.appendChild(otherHeader);

    if (!otherCollapsed) {
      renderProjectEntries(unpinnedEntries, projectListEl, '');
    }
  } else {
    renderProjectEntries(unpinnedEntries, projectListEl, '');
  }

  updateAutomationSidebarBadges();
}

// Respect the persisted activeWorkspaceId on first route-in. If the id points
// at a workspace that no longer exists, silently fall through to Primary (and
// clear the stale id). Clicking the project card directly calls
// setActiveWorkspace(index, null) explicitly \u2014 this wrapper is the startup /
// restore-index path.
function setActiveProject(index, isStartup) {
  var project = config.projects[index];
  if (!project) return;
  var wsId = project.activeWorkspaceId;
  if (wsId != null) {
    var stillThere = Array.isArray(project.workspaces)
      && project.workspaces.some(function (w) { return w && w.id === wsId; });
    if (!stillThere) {
      project.activeWorkspaceId = null;
      wsId = null;
    }
  }
  setActiveWorkspace(index, wsId, isStartup);
}

function setActiveWorkspace(projectIndex, workspaceId, isStartup) {
  if (popoutMode) return;
  var project = config.projects[projectIndex];
  if (!project) return;

  // Programmatic project/workspace switch: the user is no longer attending the
  // old project's column. Null voice attention so a reply that lands on a still-
  // live background column does NOT auto-speak; it re-arms only when the user
  // clicks or types in the now-visible column. Every visible switch (sidebar
  // click, config-redirect, popout take-back, notification headless-focus-run)
  // funnels through here, so this is the single chokepoint.
  voiceAttentionColumnId = null;

  // Compute the outgoing state key BEFORE mutating config, so we can hide
  // its container cleanly.
  var prevStateKey = null;
  if (config.activeProjectIndex >= 0 && config.projects[config.activeProjectIndex]) {
    var prevProject = config.projects[config.activeProjectIndex];
    prevStateKey = stateKey(prevProject.path, prevProject.activeWorkspaceId);
  }
  var newStateKey = stateKey(project.path, workspaceId);

  // If a maximized column belongs to a different (project, workspace), restore
  // the layout first so hiding the previous container doesn't leave it stuck.
  if (maximizedColumnId != null) {
    var maxCol = allColumns.get(maximizedColumnId);
    if (maxCol && (maxCol.projectKey !== project.path
        || (maxCol.workspaceId == null ? null : maxCol.workspaceId) !== workspaceId)) {
      toggleMaximizeColumn(maximizedColumnId);
    }
  }

  if (prevStateKey && prevStateKey !== newStateKey) {
    var prevState = projectStates.get(prevStateKey);
    if (prevState) prevState.containerEl.style.display = 'none';
    var commitInput = document.getElementById('git-commit-msg');
    if (commitInput) commitInput.value = '';
    if (window.electronAPI && window.electronAPI.stopFsWatch) {
      window.electronAPI.stopFsWatch(prevProject.path).catch(function () {});
    }
  }

  config.activeProjectIndex = projectIndex;
  project.activeWorkspaceId = workspaceId; // null clears, restores Primary
  activeProjectKey = project.path;
  activeProjectNameEl.textContent = project.name;
  // Start watching the new project root so the Explorer can refresh on disk
  // changes (file creation/deletion/rename from other tools).
  if (window.electronAPI && window.electronAPI.startFsWatch) {
    window.electronAPI.startFsWatch(project.path).catch(function () {});
  }
  if (typeof window.__rerenderHookList === 'function') window.__rerenderHookList();

  if (window.electronAPI && window.electronAPI.gitBranch) {
    window.electronAPI.gitBranch(project.path).then(function (branch) {
      if (activeProjectKey === project.path) {
        updateActiveProjectBranchLabels(branch);
      }
    }).catch(function () {});
  }

  saveConfig();
  // Active accent: project card highlighted iff Primary is active for this
  // project; each workspace row highlighted iff it's the active workspace.
  document.querySelectorAll('.project-item').forEach(function (el) {
    var isThisProject = el.dataset.projectPath === project.path;
    el.classList.toggle('active', isThisProject && workspaceId == null);
  });
  document.querySelectorAll('.workspace-item').forEach(function (el) {
    var matches = el.dataset.projectPath === project.path
      && el.dataset.workspaceId === (workspaceId == null ? '' : workspaceId);
    el.classList.toggle('active', matches);
  });

  var emptyState = columnsContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  lastGitRaw = null;
  var state = getOrCreateProjectState(newStateKey);
  state.containerEl.style.display = 'flex';
  refreshExplorer();
  if (activeAutomationDetailId) closeAutomationDetail();
  refreshAutomations();
  loadSpawnOptions();

  if (state.columns.size === 0) {
    if (state.suppressAutoSpawn) {
      // User explicitly killed all instances for this project/workspace —
      // don't surprise them by spawning a new one when they navigate back.
      // Show a hint pointing to the Spawn button instead.
      showProjectEmptyHint(state);
    } else if (window.electronAPI) {
      // Always restore from disk when we have no in-memory columns for this
      // (project, workspace). restoreSessions internally falls back to a
      // default spawn when no sessions are saved.
      restoreSessions(project.path, workspaceId);
    } else {
      var spawnArgs = buildSpawnArgs();
      addColumn(spawnArgs.length > 0 ? spawnArgs : null, null, { workspaceId: workspaceId });
    }
  } else {
    if (state.focusedColumnId !== null) {
      setFocusedColumn(state.focusedColumnId);
    }
    refitAll();
  }
  loadHeadlessRunsForActiveProject();
  if (typeof window.__renderStickyNotesForActiveProject === 'function') {
    window.__renderStickyNotesForActiveProject();
  }
  if (typeof window.__repositionStickyNotesForActiveProject === 'function') {
    window.__repositionStickyNotesForActiveProject();
  }
}

// Popout windows display exactly one project's Primary columns. The normal
// activation path (setActiveProject -> setActiveWorkspace) early-returns in
// popout mode — and also persists shared config + does sidebar/workspace
// routing we don't want here — so popouts get a dedicated, Primary-only
// activation that reveals the container and fits the terminals. Without this
// the columns container stays display:none and the window renders blank even
// though the columns/ptys are live.
function activatePopoutProject(index) {
  var project = config.projects[index];
  if (!project) return;
  // Programmatic activation (popout reveal / take-back): drop voice attention so
  // a background column can't auto-speak; re-arms when the user focuses a column.
  voiceAttentionColumnId = null;
  config.activeProjectIndex = index;
  // Popouts are Primary-only; align in-memory config so getActiveState()/
  // refitAll()/persistSessions resolve to the Primary state we reveal below.
  // In-memory only — no saveConfig(), so we don't clobber the shared config.
  project.activeWorkspaceId = null;
  activeProjectKey = project.path;
  if (activeProjectNameEl) activeProjectNameEl.textContent = project.name;
  if (window.electronAPI && window.electronAPI.gitBranch) {
    window.electronAPI.gitBranch(project.path).then(function (branch) {
      if (activeProjectKey === project.path) {
        updateActiveProjectBranchLabels(branch);
      }
    }).catch(function () {});
  }
  if (window.electronAPI && window.electronAPI.startFsWatch) {
    window.electronAPI.startFsWatch(project.path).catch(function () {});
  }
  var emptyState = columnsContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();
  var state = getOrCreateProjectState(stateKey(project.path, null));
  state.containerEl.style.display = 'flex';
  refreshExplorer();
  loadSpawnOptions();
  if (state.columns.size === 0) {
    restoreSessions(project.path, null);
  } else {
    if (state.focusedColumnId !== null) setFocusedColumn(state.focusedColumnId);
    refitAll();
  }
  loadHeadlessRunsForActiveProject();
}

function restoreSessions(projectPath, workspaceId) {
  window.electronAPI.loadSessions(projectPath).then(async function (blob) {
    var spawnArgs = buildSpawnArgs();
    var state = projectStates.get(stateKey(projectPath, workspaceId));

    // Build endpoint-aware resume args + row opts for a saved entry. Shared by
    // the grid restore loop and the minimised restore loop so the endpoint /
    // cloud-vs-local logic lives in one place. `baseRowOpts` already carries
    // workspaceId + (resolved) title/cwd handling from the caller.
    async function buildResumeForEntry(e, baseRowOpts) {
      // Don't --resume a session that no longer exists on disk — Claude errors
      // "No conversation found with session ID …". Verify it exists; if not,
      // planResumeArgs omits --resume and the column spawns fresh (the downstream
      // spawn pins a fresh --session-id). Mirrors the respawn-path guard.
      var exists = false;
      if (e.sessionId && window.electronAPI && window.electronAPI.sessionExists) {
        try {
          exists = await window.electronAPI.sessionExists(e.cwd || projectPath, e.sessionId);
        } catch (_) { exists = false; }
      }
      if (e.sessionId && !exists) {
        console.warn("Column '" + (e.title || e.sessionId) + "' session " + e.sessionId + " no longer exists; restoring fresh.");
      }

      var resumeArgs;
      var resumeRowOpts = baseRowOpts;
      if (e.endpointId && window.electronAPI && window.electronAPI.endpointGetEnv) {
        var envBlock = null;
        try { envBlock = await window.electronAPI.endpointGetEnv(e.endpointId); } catch (_) { envBlock = null; }
        if (envBlock) {
          resumeArgs = rewriteArgsForEndpoint(spawnArgs, /* isLocal */ true);
          resumeRowOpts = Object.assign({}, baseRowOpts, { endpointId: e.endpointId, env: envBlock });
        } else {
          resumeArgs = rewriteArgsForEndpoint(spawnArgs, /* isLocal */ false);
        }
      } else {
        resumeArgs = rewriteArgsForEndpoint(spawnArgs, /* isLocal */ false);
      }
      resumeArgs = window.SpawnSession.planResumeArgs({ baseArgs: resumeArgs, sessionId: e.sessionId, exists: exists });
      return { resumeArgs: resumeArgs, resumeRowOpts: resumeRowOpts };
    }

    // Pick the slice for the active workspace plus its row-height ratios. The
    // synthesized v2 shape carries ratios per workspace; older shapes are
    // promoted into the same `entries`/`rowHeightByIdx` pair below.
    var slice = null;
    var rowHeightRatios = null;
    if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
      if (workspaceId == null) {
        slice = Array.isArray(blob.sessions) ? blob.sessions : null;
        if (Array.isArray(blob.rowHeightRatios)) rowHeightRatios = blob.rowHeightRatios;
      } else if (blob.workspaces && blob.workspaces[workspaceId]) {
        var wsBlob = blob.workspaces[workspaceId];
        slice = Array.isArray(wsBlob.sessions) ? wsBlob.sessions : null;
        if (Array.isArray(wsBlob.rowHeightRatios)) rowHeightRatios = wsBlob.rowHeightRatios;
      }
    }

    var entries = [];
    var minimizedEntries = [];
    var rowHeightByIdx = {};

    if (blob && typeof blob === 'object' && blob.version === 2 && Array.isArray(blob.rows) && workspaceId == null) {
      // Legacy HEAD-only v2 shape (pre-workspace): rows/columns nested. Promote
      // to primary-workspace entries.
      for (var r = 0; r < blob.rows.length; r++) {
        var srow = blob.rows[r] || {};
        var srowCols = Array.isArray(srow.columns) ? srow.columns : [];
        if (typeof srow.heightRatio === 'number' && isFinite(srow.heightRatio) && srow.heightRatio > 0) {
          rowHeightByIdx[r] = srow.heightRatio;
        }
        for (var c = 0; c < srowCols.length; c++) {
          var lcol = srowCols[c] || {};
          if (!lcol.sessionId) continue;
          var legacyEntry = {
            rowIdx: r,
            sessionId: lcol.sessionId,
            title: lcol.title || null,
            widthRatio: (typeof lcol.widthRatio === 'number' && isFinite(lcol.widthRatio) && lcol.widthRatio > 0) ? lcol.widthRatio : null
          };
          entries.push(legacyEntry);
        }
      }
    } else if (slice && slice.length > 0) {
      // Synthesized shape OR personal/main flat list. Each entry may carry
      // rowIdx/widthRatio (synthesized) or be a bare string / {sessionId,title}
      // (legacy personal/main fallback — single row, default ratios).
      for (var i = 0; i < slice.length; i++) {
        var entry = slice[i];
        var sid = typeof entry === 'string' ? entry : entry && entry.sessionId;
        if (!sid) continue;
        var rowIdx = (typeof entry === 'object' && entry && typeof entry.rowIdx === 'number' && isFinite(entry.rowIdx)) ? entry.rowIdx : 0;
        var widthRatio = (typeof entry === 'object' && entry && typeof entry.widthRatio === 'number' && isFinite(entry.widthRatio) && entry.widthRatio > 0) ? entry.widthRatio : null;
        var title = (typeof entry === 'object' && entry && entry.title) ? entry.title : null;
        var cwd = (typeof entry === 'object' && entry && typeof entry.cwd === 'string' && entry.cwd) ? entry.cwd : null;
        var cwdSource = (typeof entry === 'object' && entry && typeof entry.cwdSource === 'string' && entry.cwdSource) ? entry.cwdSource : null;
        var endpointId = (typeof entry === 'object' && entry && entry.endpointId) ? entry.endpointId : null;
        // Minimised entries are not part of the grid — route them to a separate
        // list so they don't create rows/affect rowHeightRatios. They restore
        // live-but-minimised into the dock after the grid is built.
        if (typeof entry === 'object' && entry && entry.minimized === true) {
          var minEntry = { sessionId: sid, title: title };
          if (cwd) minEntry.cwd = cwd;
          if (cwdSource) minEntry.cwdSource = cwdSource;
          if (endpointId) minEntry.endpointId = endpointId;
          minimizedEntries.push(minEntry);
          continue;
        }
        var pushedEntry = { rowIdx: rowIdx, sessionId: sid, title: title, widthRatio: widthRatio };
        if (cwd) pushedEntry.cwd = cwd;
        if (cwdSource) pushedEntry.cwdSource = cwdSource;
        if (endpointId) pushedEntry.endpointId = endpointId;
        entries.push(pushedEntry);
      }
      if (rowHeightRatios) {
        for (var rh = 0; rh < rowHeightRatios.length; rh++) {
          var rhv = rowHeightRatios[rh];
          if (typeof rhv === 'number' && isFinite(rhv) && rhv > 0) rowHeightByIdx[rh] = rhv;
        }
      }
    } else if (Array.isArray(blob) && blob.length > 0 && workspaceId == null) {
      // Very old shape: bare array. Treat as primary workspace, single row, no ratios.
      for (var bi = 0; bi < blob.length; bi++) {
        var bentry = blob[bi];
        var bsid = typeof bentry === 'string' ? bentry : bentry && bentry.sessionId;
        if (!bsid) continue;
        entries.push({
          rowIdx: 0,
          sessionId: bsid,
          title: (typeof bentry === 'object' && bentry && bentry.title) ? bentry.title : null,
          widthRatio: null
        });
      }
    }

    // Mark restore in progress so background timers (session-sync, title-edit) don't overwrite
    // sessions.json with default-flex ratios before applyLayoutRatios runs.
    if (state) state.restoringLayout = true;

    try {
      if (entries.length === 0 && minimizedEntries.length === 0) {
        addColumn(spawnArgs.length > 0 ? spawnArgs : null, null, { workspaceId: workspaceId });
        return;
      }

      var rowsByIdx = {};
      for (var k = 0; k < entries.length; k++) {
        var e = entries[k];
        var targetRow = rowsByIdx[e.rowIdx];
        if (!targetRow) {
          while (state.rows.length <= e.rowIdx) {
            var newRow = addRowToProject(state);
            rowsByIdx[state.rows.length - 1] = newRow;
          }
          targetRow = rowsByIdx[e.rowIdx];
        }
        var rowOpts = { workspaceId: workspaceId };
        if (e.title) rowOpts.title = e.title;
        if (e.cwd) {
          var stillExists = await window.electronAPI.pathExists(e.cwd);
          if (stillExists) {
            rowOpts.cwd = e.cwd;
            rowOpts.cwdSource = e.cwdSource || 'manual';
          } else {
            console.warn("Column '" + (e.title || e.sessionId) + "' had cwd " + e.cwd + " which no longer exists; restored at project root.");
          }
        }

        // Endpoint-aware resume: if this column was spawned against a non-cloud
        // endpoint preset, look up the preset's env block and rewrite args. If
        // the preset is gone (envBlock null) or no endpointId is recorded,
        // fall back to a cloud-style resume (args stripped of any local-only
        // flags, no env injected). Sessions saved without endpointId are
        // treated as Cloud and explicitly do NOT inherit the dropdown's
        // currentEndpointEnv — otherwise a cloud column would silently get a
        // local server's URL injected.
        var built = await buildResumeForEntry(e, rowOpts);
        addColumn(built.resumeArgs, targetRow, built.resumeRowOpts);
      }

      for (var rr = state.rows.length - 1; rr >= 0; rr--) {
        removeRowIfEmpty(state, state.rows[rr]);
      }

      applyLayoutRatios(state, entries, rowHeightByIdx, rowsByIdx);

      // Restore minimised columns live-but-minimised. Spawn each as a normal
      // resume (so its pty runs), then immediately minimise it into the dock.
      // Cross-restart origin row is intentionally dropped (v1) — a later
      // restore lands the chip in a new bottom row when re-restored.
      for (var me = 0; me < minimizedEntries.length; me++) {
        var ment = minimizedEntries[me];
        var minRowOpts = { workspaceId: workspaceId };
        if (ment.title) minRowOpts.title = ment.title;
        if (ment.cwd) {
          var mExists = await window.electronAPI.pathExists(ment.cwd);
          if (mExists) {
            minRowOpts.cwd = ment.cwd;
            minRowOpts.cwdSource = ment.cwdSource || 'manual';
          } else {
            console.warn("Minimised column '" + (ment.title || ment.sessionId) + "' had cwd " + ment.cwd + " which no longer exists; restored at project root.");
          }
        }
        var mBuilt = await buildResumeForEntry(ment, minRowOpts);
        addColumn(mBuilt.resumeArgs, null, mBuilt.resumeRowOpts);
        // addColumn assigns id = ++globalColumnId and registers it synchronously.
        var newId = globalColumnId;
        minimizeColumn(newId);
        var mc = allColumns.get(newId);
        if (mc) mc.minimizeOrigin = null;
      }
    } finally {
      // Always clear the flag — even if a synchronous call above threw — so background
      // persists are not silently disabled for the rest of the session. persistSessions
      // runs after the reset so the canonicalising write actually happens.
      if (state) state.restoringLayout = false;
      persistSessions(projectPath, workspaceId);
    }

    if (typeof window.__renderStickyNotesForActiveProject === 'function') {
      window.__renderStickyNotesForActiveProject();
    }
  });
}

// Strip args that don't apply to the target column's endpoint kind.
// - --effort 'xhigh' is a Claude-Code-only extension and 400s on local servers.
// - When restoring a cloud column while the global dropdown points at a local
//   preset (or vice-versa), we must rewrite the effort to the kind appropriate
//   for the column's actual endpoint, not the dropdown's.
function rewriteArgsForEndpoint(args, isLocal) {
  var out = [];
  var sawEffort = false;
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--effort' && i + 1 < args.length) {
      var raw = args[i + 1];
      var safeEffort;
      if (isLocal) {
        safeEffort = isValidLocalEffort(raw) ? raw : defaultEffortLocal;
      } else {
        // Cloud accepts everything; just pass through unless it's empty.
        safeEffort = raw && isValidEffort(raw) ? raw : defaultEffortCloud;
      }
      out.push('--effort', safeEffort);
      sawEffort = true;
      i++;
      continue;
    }
    // --model is owned by the endpoint env block on local presets; skip any
    // explicit cloud-side --model flag so we don't override the env model.
    if (args[i] === '--model' && i + 1 < args.length && isLocal) {
      i++;
      continue;
    }
    // --bare is an API-key/proxy-auth flag: it tells Claude to trust
    // ANTHROPIC_API_KEY without prompting, which suppresses the OAuth
    // credential lookup. On cloud restores we have neither an API key nor
    // an auth token in env, so --bare leaves the CLI with no credentials
    // and it errors with "Not logged in · Please run /login". Strip it.
    if (args[i] === '--bare' && !isLocal) {
      continue;
    }
    out.push(args[i]);
  }
  // If --effort wasn't in the global args at all, append the kind-appropriate
  // default so the column at least uses its own type's preference.
  if (!sawEffort) {
    var def = isLocal ? defaultEffortLocal : defaultEffortCloud;
    if (isValidEffort(def)) out.push('--effort', def);
  }
  return out;
}

// Build the args to (re)launch a column, preserving its current effort. Claude
// Code has no non-interactive mid-session effort setter (--effort is spawn-only,
// /effort is an interactive TUI picker whose result the app can't observe), so
// the effort dropdown and every respawn re-launch the session with --resume +
// --effort. That keeps the app the source of truth for effort, so the header
// badge stays truthful. Endpoint-aware so local presets never get an effort
// value they'd 400 on (xhigh/max → safe local default).
function buildResumeArgs(col) {
  var isLocal = !!(col.endpointId || (col.env && col.env.ANTHROPIC_BASE_URL));
  // Preserve the flags the column was spawned with (permission mode, --bare,
  // --strict-mcp-config, --remote-control, --model, custom args); only
  // --effort/--resume/--worktree and the ultracode --settings are rebuilt. See
  // the pure, unit-tested lib/effort-relaunch.js. rewriteArgsForEndpoint then
  // enforces endpoint correctness (strips --bare/--model on the wrong endpoint
  // kind, clamps effort to a value that kind accepts).
  var args = EffortRelaunch.buildResumeArgsBase(col, isLocal, defaultEffortLocal);
  return rewriteArgsForEndpoint(args, isLocal);
}

// Local Anthropic-compat servers (LM Studio etc.) accept low/medium/high/max
// for output_config.effort — 'xhigh' is a Claude-Code-only extension that 400s.
function isValidLocalEffort(e) {
  return e === 'low' || e === 'medium' || e === 'high' || e === 'max';
}

function addProject(folderPath) {
  var parts = folderPath.replace(/\\/g, '/').split('/');
  var name = parts[parts.length - 1] || folderPath;

  for (var i = 0; i < config.projects.length; i++) {
    if (config.projects[i].path === folderPath) {
      if (config.projects[i].poppedOut && window.electronAPI && window.electronAPI.focusPopoutWindow) {
        window.electronAPI.focusPopoutWindow(config.projects[i].path);
      } else {
        setActiveProject(i, false);
      }
      return;
    }
  }

  config.projects.push({ name: name, path: folderPath, columnCount: 1 });
  var newIndex = config.projects.length - 1;
  saveConfig();
  renderProjectList();
  setActiveProject(newIndex, false);
}

function togglePinProject(index) {
  var project = config.projects[index];
  if (!project) return;
  project.pinned = !project.pinned;
  saveConfig();
  renderProjectList();
}

// --- Cross-device session sync ---
//
// All persistence and watcher orchestration lives in main; these helpers
// just nudge it via IPC and surface result toasts via alert() for now.

function handleSyncToggleExport(projectPath) {
  if (!window.electronAPI || !window.electronAPI.syncSetProjectExport) return;
  window.electronAPI.syncGetProjectStatus(projectPath).then(function (status) {
    var nowEnabled = !(status && status.syncExport);
    // Refuse to enable if the global sync source isn't set yet — otherwise
    // toggling silently does nothing and users wonder why.
    if (nowEnabled) {
      return window.electronAPI.syncGetSettings().then(function (s) {
        if (!s || !s.sourcePath) {
          alert('Set a sync source path in Settings → Sync first, then toggle "Sync convos" on this project.');
          return null;
        }
        return s;
      }).then(function (s) {
        if (!s) return;
        return window.electronAPI.syncSetProjectExport(projectPath, true);
      });
    }
    return window.electronAPI.syncSetProjectExport(projectPath, false);
  });
}

// One entry point. If no imports yet, open the folder picker directly.
// Otherwise open the modal so the user can see what's configured and
// add another / remove one.
function handleSyncImports(projectPath) {
  if (!window.electronAPI || !window.electronAPI.syncGetProjectStatus) return;
  window.electronAPI.syncGetProjectStatus(projectPath).then(function (status) {
    var imports = (status && status.syncImports) || [];
    if (imports.length === 0) {
      pickAndAddImport(projectPath);
    } else {
      showSyncImportsModal(projectPath, imports);
    }
  });
}

function pickAndAddImport(projectPath) {
  if (!window.electronAPI || !window.electronAPI.syncBrowseFolder) return Promise.resolve(null);
  return window.electronAPI.syncGetSettings().then(function (s) {
    var defaultPath = (s && s.sourcePath) || undefined;
    return window.electronAPI.syncBrowseFolder({ defaultPath: defaultPath });
  }).then(function (chosen) {
    if (!chosen) return null;
    return window.electronAPI.syncAddProjectImport(projectPath, chosen).then(function (res) {
      if (res && res.error) { console.warn('[sync] add import failed:', res.error); return null; }
      return chosen;
    });
  });
}

function handleSyncForce(projectPath) {
  if (!window.electronAPI || !window.electronAPI.syncForceProject) return;
  // Optimistic feedback in console; the IPC promise resolves once mirroring
  // is done in main, which can take a moment for big sessions.
  console.log('[sync] forcing sync for', projectPath);
  window.electronAPI.syncForceProject(projectPath).then(function (res) {
    if (res && res.error) {
      console.warn('[sync] force failed:', res.error);
    } else {
      console.log('[sync] force complete');
    }
  });
}

// Renderer-side modal — Electron's window.prompt is a no-op so we build
// our own. Plain DOM with a backdrop so it can't drift behind the dock.
// `.modal-body` defaults to flex-row in this app's CSS, hence the explicit
// `flex-direction: column` here — otherwise import rows render side-by-side.
function showSyncImportsModal(projectPath, imports) {
  var existing = document.getElementById('sync-imports-modal');
  if (existing) existing.remove();

  var backdrop = document.createElement('div');
  backdrop.id = 'sync-imports-modal';
  backdrop.className = 'modal-overlay';
  backdrop.style.zIndex = '10000';

  var dialog = document.createElement('div');
  dialog.className = 'modal-dialog';
  dialog.style.cssText = 'max-width: 720px; width: 90%;';

  var header = document.createElement('div');
  header.className = 'modal-header';
  var title = document.createElement('span');
  title.className = 'modal-title';
  title.textContent = 'Sync Imports';
  var close = document.createElement('span');
  close.className = 'modal-close';
  close.textContent = '×';
  close.addEventListener('click', function () { backdrop.remove(); });
  header.appendChild(title);
  header.appendChild(close);

  var body = document.createElement('div');
  body.className = 'modal-body';
  body.style.cssText = 'padding: 16px; display: flex; flex-direction: column; gap: 0;';

  var list = document.createElement('div');
  list.style.cssText = 'display: flex; flex-direction: column;';
  body.appendChild(list);

  function renderRows(rows) {
    list.innerHTML = '';
    if (!rows || rows.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'opacity:0.7; padding: 12px 0;';
      empty.textContent = 'No imports configured for this project.';
      list.appendChild(empty);
      return;
    }
    rows.forEach(function (p) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:12px; padding: 8px 0; border-bottom: 1px solid var(--border-primary);';
      var pathEl = document.createElement('div');
      pathEl.style.cssText = 'flex:1; min-width:0; font-family: monospace; font-size: 12px; word-break: break-all;';
      pathEl.textContent = p;
      var rm = document.createElement('button');
      rm.textContent = 'Remove';
      rm.style.cssText = 'padding: 4px 10px; cursor: pointer; flex-shrink: 0;';
      rm.addEventListener('click', function () {
        rm.disabled = true;
        window.electronAPI.syncRemoveProjectImport(projectPath, p).then(function (res) {
          renderRows((res && res.imports) || []);
        });
      });
      row.appendChild(pathEl);
      row.appendChild(rm);
      list.appendChild(row);
    });
  }
  renderRows(imports);

  var addBtn = document.createElement('button');
  addBtn.textContent = '+ Add import…';
  addBtn.style.cssText = 'margin-top: 12px; padding: 6px 14px; align-self: flex-start; cursor: pointer;';
  addBtn.addEventListener('click', function () {
    addBtn.disabled = true;
    pickAndAddImport(projectPath).then(function () {
      addBtn.disabled = false;
      // Refresh the list from authoritative state.
      window.electronAPI.syncGetProjectStatus(projectPath).then(function (status) {
        renderRows((status && status.syncImports) || []);
      });
    });
  });
  body.appendChild(addBtn);

  dialog.appendChild(header);
  dialog.appendChild(body);
  backdrop.appendChild(dialog);
  backdrop.addEventListener('click', function (e) {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
}

function setGroupPinned(groupKey, pinned) {
  var changed = false;
  config.projects.forEach(function (p) {
    if (projectGroupKey(p) === groupKey && !!p.pinned !== pinned) {
      p.pinned = pinned;
      changed = true;
    }
  });
  if (changed) {
    saveConfig();
    renderProjectList();
  }
}

function showGroupContextMenu(event, groupKey) {
  var menu = document.getElementById('project-context-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'project-context-menu';
    menu.className = 'project-context-menu';
    document.body.appendChild(menu);
  }
  while (menu.firstChild) menu.removeChild(menu.firstChild);

  var members = config.projects.filter(function (p) { return projectGroupKey(p) === groupKey; });
  var allPinned = members.length > 0 && members.every(function (p) { return p.pinned; });

  function addItem(label, action) {
    var mi = document.createElement('div');
    mi.className = 'project-context-item';
    mi.dataset.action = action;
    mi.textContent = label;
    menu.appendChild(mi);
  }
  addItem(allPinned ? 'Unpin group' : 'Pin group to top', 'toggle-group-pin');

  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
  menu.style.display = 'block';

  menu.onclick = function (ev) {
    var action = ev.target.dataset.action;
    if (action === 'toggle-group-pin') {
      setGroupPinned(groupKey, !allPinned);
    }
    menu.style.display = 'none';
  };

  setTimeout(function () {
    document.addEventListener('click', function closeMenu() {
      menu.style.display = 'none';
      document.removeEventListener('click', closeMenu);
    });
  }, 0);
}

function toggleProjectSortMode() {
  var current = config.projectSortMode || 'manual';
  config.projectSortMode = current === 'alpha' ? 'manual' : 'alpha';
  saveConfig();
  updateSortButton();
  renderProjectList();
}

function updateSortButton() {
  var btn = document.getElementById('btn-toggle-sort');
  var icon = document.getElementById('sort-icon');
  if (!btn || !icon) return;
  var mode = config.projectSortMode || 'manual';
  if (mode === 'alpha') {
    btn.classList.add('active');
    btn.title = 'Sorted A-Z (click for manual order)';
    icon.textContent = 'A\u2193';
  } else {
    btn.classList.remove('active');
    btn.title = 'Manual order (click to sort A-Z)';
    icon.textContent = '\u21C5';
  }
}

function removeProject(index) {
  var project = config.projects[index];
  if (!confirm('Remove project "' + project.name + '"? This will also delete its automations.')) return;
  if (project.poppedOut && window.electronAPI && window.electronAPI.closePopoutWindow) {
    window.electronAPI.closePopoutWindow(project.path);
  }
  var key = project.path;

  var state = projectStates.get(key);
  if (state) {
    var ids = Array.from(state.columns.keys());
    for (var i = 0; i < ids.length; i++) {
      removeColumn(ids[i]);
    }
    state.containerEl.remove();
    projectStates.delete(key);
  }

  // Clean up automations for this project
  window.electronAPI.deleteAllAutomations(key);

  config.projects.splice(index, 1);

  if (config.activeProjectIndex === index) {
    var nextAvail = -1;
    for (var n = Math.min(index, config.projects.length - 1); n >= 0; n--) {
      if (!config.projects[n].poppedOut) { nextAvail = n; break; }
    }
    if (nextAvail < 0) {
      nextAvail = config.projects.findIndex(function (p) { return !p.poppedOut; });
    }
    if (nextAvail >= 0) {
      config.activeProjectIndex = nextAvail;
      activeProjectKey = null;
      saveConfig();
      renderProjectList();
      setActiveProject(nextAvail, false);
    } else {
      config.activeProjectIndex = -1;
      activeProjectKey = null;
      activeProjectNameEl.textContent = '';
      saveConfig();
      renderProjectList();
      showEmptyState();
    }
  } else {
    if (index < config.activeProjectIndex) config.activeProjectIndex--;
    saveConfig();
    renderProjectList();
  }
}

function showEmptyState() {
  projectStates.forEach(function (state) {
    state.containerEl.style.display = 'none';
  });
  var empty = document.createElement('div');
  empty.className = 'empty-state';
  var hasProjects = config && Array.isArray(config.projects) && config.projects.length > 0;
  if (hasProjects) {
    var msg = document.createElement('div');
    msg.textContent = 'No project selected';
    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Click a project on the left to start';
    empty.appendChild(msg);
    empty.appendChild(hint);
  } else {
    // First-run state — give a clear, prominent CTA so the user doesn't stare
    // at empty space wondering what to do.
    var hero = document.createElement('div');
    hero.className = 'empty-state-hero';
    hero.innerHTML =
      '<div class="empty-state-icon" aria-hidden="true">⌨</div>' +
      '<div class="empty-state-title">Welcome to Claudes</div>' +
      '<div class="empty-state-subtitle">Multi-pane terminal for running Claude Code side-by-side.</div>' +
      '<button class="empty-state-cta" id="empty-state-add-project">+ Add your first project</button>' +
      '<div class="empty-state-shortcuts">Tip: press <kbd>?</kbd> any time to see shortcuts.</div>';
    empty.appendChild(hero);
    setTimeout(function () {
      var btn = document.getElementById('empty-state-add-project');
      if (btn) btn.addEventListener('click', function () {
        var addBtn = document.getElementById('btn-add-project');
        if (addBtn) addBtn.click();
      });
    }, 0);
  }
  columnsContainer.appendChild(empty);
}

// ============================================================
// DOM helpers
// ============================================================

function createColumnHeader(id, customTitle, opts) {
  opts = opts || {};
  var header = document.createElement('div');
  header.className = 'column-header';
  var title = document.createElement('span');
  title.className = 'col-title';
  title.textContent = customTitle || ('Claude #' + id);
  title.addEventListener('dblclick', function () {
    startTitleEdit(id, title);
  });
  var actions = document.createElement('span');
  actions.className = 'col-actions';

  if (!opts.isDiff) {
    var compactBtn = document.createElement('span');
    compactBtn.className = 'col-action';
    compactBtn.title = 'Compact context (/compact)';
    compactBtn.textContent = '\u229C';
    compactBtn.addEventListener('click', function () {
      wsSend({ type: 'write', id: id, data: '/compact\n' });
    });

    var teleportBtn = document.createElement('span');
    teleportBtn.className = 'col-action';
    teleportBtn.title = 'Teleport to claude.ai (/teleport)';
    teleportBtn.textContent = '\u21F1';
    teleportBtn.addEventListener('click', function () {
      wsSend({ type: 'write', id: id, data: '/teleport\n' });
    });

    var effortSelect = document.createElement('select');
    effortSelect.className = 'col-effort';
    effortSelect.title = 'Effort level. Changing it resumes the session at the new level — Claude Code has no non-interactive mid-session setter, so the app re-launches with --resume --effort, keeping this badge truthful.';
    effortSelect.innerHTML = '<option value="">Effort</option><option value="low">Low</option><option value="medium">Med</option><option value="high">High</option><option value="xhigh">XHigh</option><option value="max">Max</option><option value="ultracode">Ultra</option>';
    // Let the native dropdown open, but don't let it steal column focus/drag.
    effortSelect.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    // Changing effort re-launches the session at the new level (the only way to
    // keep the badge truthful — see buildResumeArgs). If a turn is in flight the
    // resume interrupts it, so confirm first in that case.
    effortSelect.addEventListener('change', function (e) {
      e.stopPropagation();
      var col = allColumns.get(id);
      if (!col || col.cmd) return;
      var next = effortSelect.value;
      if (!next || !isSelectableEffort(next)) { effortSelect.value = col.effort || ''; return; }
      if (next === col.effort) return;
      if (next === 'ultracode' && (col.endpointId || (col.env && col.env.ANTHROPIC_BASE_URL))) {
        window.alert('Ultracode (xhigh + workflows) is only available on Claude Code / cloud columns, not local-endpoint columns.');
        effortSelect.value = col.effort || '';
        return;
      }
      if (col.activityState === 'working' &&
          !window.confirm('Change effort to "' + next + '"?\n\nThis resumes the session at the new effort and interrupts the current turn.')) {
        effortSelect.value = col.effort || '';
        return;
      }
      col.effort = next;
      restartColumn(id);
    });

    actions.appendChild(compactBtn);
    actions.appendChild(teleportBtn);
    actions.appendChild(effortSelect);
  }

  if (!opts.isDiff) {
    var deltaPill = document.createElement('span');
    deltaPill.className = 'col-delta-pill';
    deltaPill.dataset.colDelta = '';
    deltaPill.setAttribute('hidden', '');
    deltaPill.textContent = 'Δ —';
    actions.appendChild(deltaPill);

    var ctxMeter = document.createElement('div');
    ctxMeter.className = 'col-ctx-meter';
    ctxMeter.dataset.colCtx = '';
    ctxMeter.setAttribute('hidden', '');
    ctxMeter.title = 'Context window usage';
    var ctxFill = document.createElement('div');
    ctxFill.className = 'col-ctx-fill';
    var ctxText = document.createElement('span');
    ctxText.className = 'col-ctx-text';
    ctxMeter.appendChild(ctxFill);
    ctxMeter.appendChild(ctxText);
    actions.appendChild(ctxMeter);

    var restartBtn = document.createElement('span');
    restartBtn.className = 'col-restart';
    restartBtn.dataset.id = String(id);
    restartBtn.title = 'Restart';
    restartBtn.textContent = '↻';
    actions.appendChild(restartBtn);

    // Clear scrollback — saves typing `clear` when triaging long sessions.
    var clearBtn = document.createElement('span');
    clearBtn.className = 'col-clear';
    clearBtn.dataset.id = String(id);
    clearBtn.title = 'Clear terminal';
    clearBtn.textContent = '⌫';
    clearBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var c = allColumns.get(id);
      if (c && c.terminal) c.terminal.clear();
    });
    actions.appendChild(clearBtn);

    // Recent sessions picker — opens a small floating menu of the project's
    // most-recent sessions; clicking one swaps this column to that session
    // via restartColumn().
    var sessionsBtn = document.createElement('span');
    sessionsBtn.className = 'col-sessions';
    sessionsBtn.dataset.id = String(id);
    sessionsBtn.title = 'Switch to a recent session';
    sessionsBtn.textContent = '⏳';
    sessionsBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      showColumnSessionPicker(id, e.clientX, e.clientY);
    });
    actions.appendChild(sessionsBtn);

    // Voice playback — speak the column's latest reply on demand. Full reads the
    // whole reply; summary reads a condensed version. Both work regardless of the
    // voice enable toggle (explicit user action), needing only a configured voice.
    var playFullBtn = document.createElement('span');
    playFullBtn.className = 'col-play-full';
    playFullBtn.dataset.id = String(id);
    playFullBtn.title = 'Play reply';
    playFullBtn.textContent = '🔊';
    actions.appendChild(playFullBtn);

    var playSummaryBtn = document.createElement('span');
    playSummaryBtn.className = 'col-play-summary';
    playSummaryBtn.dataset.id = String(id);
    playSummaryBtn.title = 'Play summary';
    playSummaryBtn.textContent = '❝';
    actions.appendChild(playSummaryBtn);
  }

  var minimizeBtn = document.createElement('span');
  minimizeBtn.className = 'col-minimize';
  minimizeBtn.title = 'Minimise';
  minimizeBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" y1="9" x2="10" y2="9"/></svg>';
  minimizeBtn.addEventListener('click', function () {
    minimizeColumn(id);
  });
  actions.appendChild(minimizeBtn);

  var maximizeBtn = document.createElement('span');
  maximizeBtn.className = 'col-maximize';
  maximizeBtn.title = 'Maximize';
  maximizeBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/></svg>';
  maximizeBtn.addEventListener('click', function () {
    toggleMaximizeColumn(id);
  });
  actions.appendChild(maximizeBtn);

  var closeBtn = document.createElement('span');
  closeBtn.className = 'col-close';
  closeBtn.dataset.id = String(id);
  closeBtn.title = opts.isDiff ? 'Close' : 'Kill';
  closeBtn.textContent = '\u00d7';
  actions.appendChild(closeBtn);

  header.appendChild(title);
  header.appendChild(actions);

  if (!popoutMode && !opts.isDiff) {
    header.addEventListener('contextmenu', function (e) {
      if (header.querySelector('[contenteditable="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      showColumnContextMenu(id, e.clientX, e.clientY);
    });
  }

  header.addEventListener('dblclick', function (e) {
    if (e.target === title || title.contains(e.target)) return;
    toggleMaximizeColumn(id);
  });

  if (!opts.isDiff) setupColumnDrag(header, id);

  return header;
}

var columnContextMenuDocClick = null;

function showColumnContextMenu(colId, x, y) {
  var col = allColumns.get(colId);
  if (!col) return;
  var project = config.projects.find(function (p) { return p.path === col.projectKey; });
  if (!project) return;

  var candidates = [];
  if (col.workspaceId !== null) candidates.push({ wsId: null, label: 'Primary' });
  (project.workspaces || []).forEach(function (ws) {
    if (ws.id !== col.workspaceId) candidates.push({ wsId: ws.id, label: ws.name });
  });

  // Tear down any prior column context menu/submenu before opening a new one.
  if (columnContextMenuDocClick) {
    document.removeEventListener('click', columnContextMenuDocClick);
    columnContextMenuDocClick = null;
  }
  var prior = document.getElementById('column-context-menu');
  if (prior) prior.remove();
  var priorSub = document.getElementById('column-context-submenu');
  if (priorSub) priorSub.remove();

  var menu = document.createElement('div');
  menu.id = 'column-context-menu';
  menu.className = 'project-context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.display = 'block';

  var parentItem = document.createElement('div');
  parentItem.className = 'project-context-item has-submenu';
  parentItem.textContent = 'Send to workspace';
  if (candidates.length === 0) parentItem.classList.add('disabled');
  menu.appendChild(parentItem);

  function closeAll() {
    var m = document.getElementById('column-context-menu');
    if (m) m.remove();
    var s = document.getElementById('column-context-submenu');
    if (s) s.remove();
    if (columnContextMenuDocClick) {
      document.removeEventListener('click', columnContextMenuDocClick);
      columnContextMenuDocClick = null;
    }
  }

  function openSubmenu() {
    if (candidates.length === 0) return;
    if (document.getElementById('column-context-submenu')) return;
    var sub = document.createElement('div');
    sub.id = 'column-context-submenu';
    sub.className = 'project-context-menu column-context-submenu';
    var rect = parentItem.getBoundingClientRect();
    sub.style.left = rect.right + 'px';
    sub.style.top = rect.top + 'px';
    sub.style.display = 'block';
    candidates.forEach(function (cand) {
      var item = document.createElement('div');
      item.className = 'project-context-item';
      item.textContent = cand.label;
      item.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeAll();
        migrateColumnToWorkspace(colId, cand.wsId);
      });
      sub.appendChild(item);
    });
    document.body.appendChild(sub);
  }

  parentItem.addEventListener('mouseenter', openSubmenu);
  parentItem.addEventListener('click', function (e) {
    e.stopPropagation();
    openSubmenu();
  });

  document.body.appendChild(menu);

  // Defer outside-click teardown by one tick so the originating right-click
  // doesn't immediately fire it.
  setTimeout(function () {
    function onDocClick(ev) {
      var m = document.getElementById('column-context-menu');
      var s = document.getElementById('column-context-submenu');
      if (m && m.contains(ev.target)) return;
      if (s && s.contains(ev.target)) return;
      closeAll();
    }
    columnContextMenuDocClick = onDocClick;
    document.addEventListener('click', onDocClick);
  }, 0);
}

// Shared contenteditable inline-rename helper. Used by column title, project
// name, and workspace name rename. On Enter or blur, commits with trimmed text
// by calling onCommit(text). On Escape, reverts to the prior text (no commit).
// If committed text is empty, the element's textContent is set to onEmpty() when
// provided (else reverted to prior text) and onCommit is NOT called. Paste is
// forced to plain text to prevent clipboard HTML from landing in the DOM.
function startInlineRename(el, opts) {
  if (!el || el.contentEditable === 'true') return;
  opts = opts || {};
  var onCommit = opts.onCommit || function () {};
  var onEmpty = opts.onEmpty || null;
  var priorText = el.textContent;

  el.contentEditable = 'true';
  el.classList.add('editing');
  el.focus();
  var range = document.createRange();
  range.selectNodeContents(el);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  function stopClick(e) { e.stopPropagation(); }
  function onPaste(e) {
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
    document.execCommand('insertText', false, text);
  }
  function onKeydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') {
      escaped = true;
      el.textContent = priorText;
      el.blur();
    }
  }
  var escaped = false;

  el.addEventListener('mousedown', stopClick);
  el.addEventListener('click', stopClick);
  el.addEventListener('paste', onPaste);
  el.addEventListener('keydown', onKeydown);

  function finishEdit() {
    el.contentEditable = 'false';
    el.classList.remove('editing');
    el.removeEventListener('mousedown', stopClick);
    el.removeEventListener('click', stopClick);
    el.removeEventListener('paste', onPaste);
    el.removeEventListener('keydown', onKeydown);
    if (escaped) return;
    var next = el.textContent.trim();
    if (!next) {
      el.textContent = onEmpty ? onEmpty() : priorText;
      return;
    }
    el.textContent = next;
    onCommit(next);
  }
  el.addEventListener('blur', finishEdit, { once: true });
}

function startTitleEdit(id, titleEl) {
  startInlineRename(titleEl, {
    onCommit: function (text) {
      var col = allColumns.get(id);
      if (!col) return;
      col.customTitle = text;
      persistSessions(col.projectKey, col.workspaceId);
    },
    onEmpty: function () { return 'Claude #' + id; }
  });
}

function createExitOverlay(id, exitCode, col) {
  var overlay = document.createElement('div');
  overlay.className = 'exit-overlay';
  var msg = document.createElement('div');
  msg.textContent = (col.cmd || 'Claude') + ' exited (code ' + exitCode + ')';
  var restartBtn = document.createElement('button');
  restartBtn.className = 'restart-btn';
  restartBtn.textContent = col.cmd ? 'Restart' : 'Respawn';
  var closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.textContent = 'Close';

  restartBtn.addEventListener('click', function () {
    overlay.remove();
    fitTerminal(col.terminal, col.fitAddon);
    var sendMsg = { type: 'create', id: id, cols: col.terminal.cols, rows: col.terminal.rows, cwd: col.cwd };
    if (col.cmd) {
      sendMsg.cmd = col.cmd;
      sendMsg.args = col.cmdArgs || [];
    } else {
      sendMsg.args = buildResumeArgs(col);
    }
    if (col.env) sendMsg.env = col.env;
    // Bind to the app-managed Headroom proxy by env var (no `headroom wrap`).
    // Re-derived from the live global flag; passthrough for endpoint/arbitrary cmd.
    maybeBindHeadroom(sendMsg, { hasEndpoint: !!(col.endpointId || col.env), isClaude: !col.cmd });
    wsSend(sendMsg);
    col.terminal.clear();
    setColumnActivity(id, 'working');
    // Run-tab launches: the previous exit fired refreshRunConfigs and set the
    // config row back to "stopped". Now that we've re-spawned the same column
    // (col.cmd / customTitle unchanged → findRunningColumn matches again),
    // refresh so the UI flips back to the playing/stop state. Without this
    // the user's only signal that the restart worked is terminal output.
    if (col.cmd) setTimeout(refreshRunConfigs, 300);
  });
  closeBtn.addEventListener('click', function () {
    var hadCmd = !!col.cmd;
    removeColumn(id);
    // Sync the run tab — without this, closing a finished run leaves the
    // config showing as "playing" (the column was the only thing pinning
    // findRunningColumn's result, and removeColumn doesn't itself notify).
    if (hadCmd) setTimeout(refreshRunConfigs, 0);
  });

  overlay.appendChild(msg);
  overlay.appendChild(restartBtn);
  overlay.appendChild(closeBtn);
  return overlay;
}

// ============================================================
// Column Management
// ============================================================

function addColumn(args, targetRow, opts) {
  opts = opts || {};
  if (!activeProjectKey) return;

  var state = getActiveState();
  if (!state) return;
  // User is spawning a column — clear the post-killAll suppression and hide
  // the empty-state hint.
  state.suppressAutoSpawn = false;
  hideProjectEmptyHint(state);

  // Get or create the target row
  var row = targetRow || getActiveRow(state);
  if (!row) {
    row = addRowToProject(state);
  }

  var id;
  if (opts.reattachPtyId != null) {
    id = opts.reattachPtyId;
    if (id > globalColumnId) globalColumnId = id;
  } else {
    id = ++globalColumnId;
  }

  // Add column resize handle if there are existing columns in this row
  if (row.columnIds.length > 0) {
    var lastId = row.columnIds[row.columnIds.length - 1];
    var handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.dataset.leftColumnId = String(lastId);
    handle.dataset.rightColumnId = String(id);
    row.el.appendChild(handle);
    setupResizeHandle(handle);
  }

  var col = document.createElement('div');
  col.className = 'column';
  col.dataset.id = String(id);
  // Also expose the DOM id as `col-<n>` (diff columns already do this) so any
  // helper that derives a column's id via element.id parses a real number
  // rather than parseInt('') === NaN.
  col.id = 'col-' + id;

  var header = createColumnHeader(id, opts.title);

  // Drop a banner above the terminal so the user can see at a glance which
  // backend each column is talking to. Two flavours:
  //   - Orange "Local" banner when an endpoint preset is active, with a
  //     capability caveat (the prompt-caching warning claude prints on
  //     startup gets drowned out by claude's own UI redraws; this banner
  //     stays visible).
  //   - Green "Cloud" banner when no preset is active, only shown if the
  //     user has at least one preset configured (so cloud-only users don't
  //     get a banner cluttering every column).
  var endpointBanner = null;
  var hasLocalEnv = opts.env && opts.env.ANTHROPIC_BASE_URL;
  if (hasLocalEnv) {
    var preset = currentEndpointId
      ? endpointPresets.find(function (p) { return p.id === currentEndpointId; })
      : null;
    var presetName = preset ? preset.name : 'Local endpoint';
    // Banner shows the model the column was *actually* spawned with — read
    // it from the env block rather than the preset's default, so per-spawn
    // model overrides surface correctly.
    var presetModel = opts.env.ANTHROPIC_MODEL || (preset && preset.model) || 'unknown';
    endpointBanner = document.createElement('div');
    endpointBanner.className = 'endpoint-banner endpoint-banner--local';
    endpointBanner.innerHTML =
      '<span class="endpoint-banner-tag endpoint-banner-tag--local">Local</span>' +
      '<span class="endpoint-banner-name">' + escapeHtml(presetName) + '</span>' +
      '<span class="endpoint-banner-sep">·</span>' +
      '<span class="endpoint-banner-model">' + escapeHtml(presetModel) + '</span>' +
      '<span class="endpoint-banner-caveat">Suitable for simple bug fixes and investigation only</span>';
  } else if (endpointPresets.length > 0 && !opts.cmd) {
    // Only show cloud banner if user has presets configured (otherwise it's
    // noise) and only for actual claude columns (not custom-cmd columns).
    // Cloud + Headroom-on + no local endpoint = this column is wrapped through
    // the Headroom proxy (matches applyHeadroomWrap's condition), so surface an
    // HR badge. The "CLOUD" tag alone only means cloud-vs-local, not Headroom.
    var __hrWrapped = !!(headroomInstalled && config && config.useHeadroom);
    endpointBanner = document.createElement('div');
    endpointBanner.className = 'endpoint-banner endpoint-banner--cloud';
    endpointBanner.innerHTML =
      '<span class="endpoint-banner-tag endpoint-banner-tag--cloud">Cloud</span>' +
      '<span class="endpoint-banner-name">Anthropic</span>' +
      (__hrWrapped ? '<span class="endpoint-banner-tag endpoint-banner-tag--headroom" role="button" title="Routed through the Headroom proxy — click to open the dashboard">HR &#8599;</span>' : '') +
      '<span class="endpoint-banner-caveat">Suitable for any tasks</span>';
  }
  if (endpointBanner) {
    var __hrTag = endpointBanner.querySelector('.endpoint-banner-tag--headroom');
    if (__hrTag) __hrTag.addEventListener('click', function () {
      if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal('http://127.0.0.1:8787/dashboard');
    });
  }

  var termWrapper = document.createElement('div');
  termWrapper.className = 'terminal-wrapper';

  // Accept drops from the Explorer file tree. The dragstart handler stores the
  // path in application/x-claudes-file; we write the path (quoted if it
  // contains whitespace) into the pty. No effect for general HTML drag types,
  // so DOM drag-and-drop elsewhere keeps working.
  termWrapper.addEventListener('dragover', function (e) {
    if (!e.dataTransfer) return;
    var types = e.dataTransfer.types;
    if (types && Array.prototype.indexOf.call(types, 'application/x-claudes-file') >= 0) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  termWrapper.addEventListener('drop', function (e) {
    if (!e.dataTransfer) return;
    var raw = e.dataTransfer.getData('application/x-claudes-file');
    if (!raw) return;
    e.preventDefault();
    var quoted = /\s/.test(raw) ? '"' + raw + '"' : raw;
    wsSend({ type: 'write', id: id, data: quoted });
  });

  // Scroll-to-bottom button
  var scrollBtn = document.createElement('button');
  scrollBtn.className = 'scroll-to-bottom hidden';
  scrollBtn.textContent = '\u2193'; // down arrow
  scrollBtn.title = 'Scroll to bottom';
  scrollBtn.addEventListener('click', function () {
    var c = allColumns.get(id);
    if (c && c.terminal) {
      c.terminal.scrollToBottom();
      scrollBtn.classList.add('hidden');
    }
  });

  // In-terminal find overlay (Ctrl/Cmd+F). Built once per column; hidden by
  // default. Wired below once SearchAddon is loaded.
  var searchOverlay = document.createElement('div');
  searchOverlay.className = 'term-search-overlay hidden';
  searchOverlay.innerHTML =
    '<input type="text" class="term-search-input" placeholder="Find..." autocomplete="off" spellcheck="false">' +
    '<span class="term-search-count">0/0</span>' +
    '<button type="button" class="term-search-btn term-search-prev" title="Previous (Shift+Enter)">↑</button>' +
    '<button type="button" class="term-search-btn term-search-next" title="Next (Enter)">↓</button>' +
    '<button type="button" class="term-search-btn term-search-close" title="Close (Esc)">✕</button>';
  termWrapper.appendChild(searchOverlay);

  col.appendChild(header);
  if (endpointBanner) col.appendChild(endpointBanner);
  col.appendChild(termWrapper);
  col.appendChild(scrollBtn);

  // Default the effort dropdown immediately so the visible state matches the
  // auto-injected slash command that fires later in detectSession. Without
  // this, the dropdown shows the empty placeholder for ~3s after spawn —
  // looks like it ignored the change. Per-class defaults are user-configurable
  // in the spawn options panel (defaultEffortCloud/Local).
  if (hasLocalEnv) {
    var effortDropdown = col.querySelector('.col-effort');
    if (effortDropdown) effortDropdown.value = defaultEffortLocal;
  } else if (!opts.cmd) {
    var effortDropdownCloud = col.querySelector('.col-effort');
    if (effortDropdownCloud) effortDropdownCloud.value = defaultEffortCloud;
  }
  setupColumnDropTarget(col);
  row.el.appendChild(col);

  // Layer user-chosen colours (if non-default) on top of the active theme so
  // theme switching still works for any prop the user didn't override.
  var themeForThisCol = termTheme;
  var overrides = {};
  if (termSettings && termSettings.background && termSettings.background !== '#1a1a2e') overrides.background = termSettings.background;
  if (termSettings && termSettings.foreground && termSettings.foreground !== '#e0e0e0') overrides.foreground = termSettings.foreground;
  if (Object.keys(overrides).length) themeForThisCol = Object.assign({}, termTheme, overrides);
  var terminal = new Terminal({
    theme: themeForThisCol,
    // Per-platform font fallback: Cascadia/Consolas exist on Windows; JetBrains
    // Mono / Menlo on macOS; DejaVu Sans Mono / Liberation Mono on most Linux
    // distros. The closing 'monospace' is a guaranteed final fallback. A user
    // setting takes precedence when set.
    fontFamily: (termSettings && termSettings.fontFamily) ||
      "'Cascadia Code', 'Consolas', 'JetBrains Mono', 'Menlo', 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace",
    fontSize: fontSize,
    scrollback: (termSettings && termSettings.scrollback) || 5000,
    cursorStyle: (termSettings && termSettings.cursorStyle) || 'block',
    cursorBlink: true,
    allowProposedApi: true
  });

  var fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  // Unicode 11 width table. xterm defaults to Unicode 6, which measures many
  // emoji / wide chars (e.g. 🔊 U+1F50A) as width 1. Claude Code's TUI renders
  // them as width 2 and updates the screen differentially with cursor-forward
  // (CUF) moves; a width mismatch leaves the cursor one cell off, so stale cells
  // show through the gaps and the line garbles starting at the emoji. Activating
  // v11 aligns xterm's widths with Claude Code's, eliminating the garble.
  try {
    if (typeof Unicode11Addon !== 'undefined' && Unicode11Addon.Unicode11Addon) {
      terminal.loadAddon(new Unicode11Addon.Unicode11Addon());
      terminal.unicode.activeVersion = '11';
    }
  } catch (e) { /* addon optional; falls back to Unicode 6 widths */ }
  var searchAddon = null;
  try {
    if (typeof SearchAddon !== 'undefined' && SearchAddon.SearchAddon) {
      searchAddon = new SearchAddon.SearchAddon();
      terminal.loadAddon(searchAddon);
    }
  } catch (e) { /* addon optional */ }
  try {
    if (typeof WebLinksAddon !== 'undefined' && WebLinksAddon.WebLinksAddon) {
      terminal.loadAddon(new WebLinksAddon.WebLinksAddon(function (event, uri) {
        if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(uri);
      }));
    }
  } catch (e) { /* addon optional */ }
  terminal.open(termWrapper);
  // WebGL renderer is fast but Chromium caps WebGL contexts at ~16 per process.
  // When exceeded, Chromium silently kills the oldest context and that
  // terminal's canvas goes blank. Subscribe to onContextLoss so we dispose the
  // addon (xterm falls back to the DOM renderer) and re-render visible content.
  var webglAddon = null;
  try {
    webglAddon = new WebglAddon.WebglAddon();
    terminal.loadAddon(webglAddon);
    if (typeof webglAddon.onContextLoss === 'function') {
      webglAddon.onContextLoss(function () {
        var c = allColumns.get(id);
        console.warn('[WebGL] context lost for column', id,
          'project=' + (c && c.projectKey),
          'title=' + ((c && c.customTitle) || opts.title || ''),
          '— falling back to DOM renderer');
        releaseWebglForColumn(id);
        try { terminal.refresh(0, terminal.rows - 1); } catch (e) { /* ignore */ }
      });
    }
    __webglContexts.add(id);
    if (__webglContexts.size >= __WEBGL_SOFT_LIMIT) {
      console.warn('[WebGL] ' + __webglContexts.size +
        ' active contexts — approaching Chromium\'s ~16 limit. ' +
        'Run window.webglStatus() to see which columns hold them.');
    }
  } catch (e) {
    webglAddon = null;
    console.warn('WebGL addon failed, using DOM renderer:', e);
  }

  // File:line link provider — clicking e.g. `src/foo.js:42` (or an absolute
  // path) opens the file in the inline editor, focused on that line. Skipped
  // when the terminal is hosting a custom command (cmd) since the matched
  // text may not refer to a local file.
  if (terminal.registerLinkProvider) {
    try {
      var fileLineRe = /(?:^|[\s"'`(\[<])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?[\w.\-+]+(?:[\\/][\w.\-+]+)*)\s*:(\d+)(?::(\d+))?/g;
      terminal.registerLinkProvider({
        provideLinks: function (lineNo, callback) {
          var line = terminal.buffer.active.getLine(lineNo - 1);
          if (!line) return callback(undefined);
          var text = line.translateToString(true);
          var links = [];
          var m;
          fileLineRe.lastIndex = 0;
          while ((m = fileLineRe.exec(text)) !== null) {
            // Skip matches that look like ratios (e.g. "1:1000" inside word context)
            var p = m[1]; var ln = m[2];
            if (!p || p.length > 260) continue;
            var startCol = m.index + (m[0].length - p.length - (':' + ln + (m[3] ? ':' + m[3] : '')).length) + 1;
            var range = {
              start: { x: startCol, y: lineNo },
              end:   { x: startCol + p.length + (':' + ln).length + (m[3] ? ':' + m[3] : '').length - 1, y: lineNo }
            };
            links.push({
              range: range,
              text: p + ':' + ln + (m[3] ? ':' + m[3] : ''),
              activate: (function (relPath, lineN) {
                return function () { openFileAtLine(relPath, parseInt(lineN, 10)); };
              })(p, ln)
            });
          }
          callback(links.length ? links : undefined);
        }
      });
    } catch (e) { /* link provider optional */ }
  }

  // Show/hide scroll-to-bottom button based on scroll position
  terminal.onScroll(function () {
    var buf = terminal.buffer.active;
    var atBottom = buf.viewportY >= buf.baseY;
    if (atBottom) {
      scrollBtn.classList.add('hidden');
    } else {
      scrollBtn.classList.remove('hidden');
    }
  });

  // Handle Cmd/Ctrl+V paste and Shift+Enter newline
  terminal.attachCustomKeyEventHandler(function (e) {
    // Cmd/Ctrl+F: open the column's in-terminal find overlay. We intercept it
    // here (rather than relying on the document-level keydown) because xterm
    // consumes the keystroke before the bubble-phase listener sees it.
    if (e.type === 'keydown' && cmdOrCtrl(e) && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      var c = allColumns.get(id);
      if (c && typeof c._showSearch === 'function') c._showSearch();
      return false;
    }
    // Cmd/Ctrl+V: paste from clipboard
    if (e.type === 'keydown' && cmdOrCtrl(e) && !e.shiftKey && e.key === 'v') {
      e.preventDefault();
      window.electronAPI.clipboardReadText().then(function (text) {
        if (text) {
          terminal.paste(text);
        }
      });
      return false;
    }
    // Cmd/Ctrl+Shift+V: also paste
    if (e.type === 'keydown' && cmdOrCtrl(e) && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
      e.preventDefault();
      window.electronAPI.clipboardReadText().then(function (text) {
        if (text) {
          terminal.paste(text);
        }
      });
      return false;
    }
    // Cmd/Ctrl+Shift+C: copy the RAW selection verbatim (no reflow) — the
    // escape hatch for when you need the terminal's exact wrapping. Clean
    // (reflowed) copy is now the default on plain Cmd/Ctrl+C below. Always
    // preventDefault so no stray 'c' is inserted when there's no selection.
    if (e.type === 'keydown' && cmdOrCtrl(e) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      var selRaw = terminal.getSelection();
      if (selRaw) {
        window.electronAPI.clipboardWriteText(selRaw);
        terminal.clearSelection();
      }
      e.preventDefault();
      return false;
    }
    // Copy: Cmd+C on darwin always (no SIGINT semantics for Cmd+C), Ctrl+C
    // on others — when there's a selection, copy a cleaned-up version
    // (dedented, wrapped prose reflowed into paragraphs; code/lists preserved)
    // for pasting into Slack/docs. Raw verbatim copy lives on Cmd/Ctrl+Shift+C
    // above. With no selection, pass through so xterm forwards the SIGINT.
    if (e.type === 'keydown' && cmdOrCtrl(e) && !e.shiftKey && e.key === 'c') {
      var sel = terminal.getSelection();
      if (sel) {
        var cleanCopy = (window.ReflowText && window.ReflowText.reflowSelection) ? window.ReflowText.reflowSelection(sel) : sel;
        window.electronAPI.clipboardWriteText(cleanCopy);
        terminal.clearSelection();
        return false;
      }
      // No selection — on darwin swallow (Cmd+C with no selection is a no-op,
      // we don't want to insert a literal 'c'). On other platforms, let xterm
      // send SIGINT as normal.
      return !IS_DARWIN;
    }
    // Shift+Enter: send CSI u sequence so Claude CLI sees it as newline
    if (e.type === 'keydown' && e.shiftKey && !cmdOrCtrl(e) && !e.altKey && e.key === 'Enter') {
      e.preventDefault();
      // CSI u encoding: ESC [ 13 ; 2 u  (keycode 13, modifier 2=Shift)
      wsSend({ type: 'write', id: id, data: '\x1b[13;2u' });
      return false;
    }
    return true;
  });

  var cwd = opts.cwd || activeProjectKey;
  var claudeArgs = args || [];
  var cmd = opts.cmd || null;

  // Pin a deterministic session id for fresh local Claude spawns by injecting
  // --session-id, so voice/attribution resolves to the exact JSONL the CLI
  // creates (no ambiguity when a project has multiple sessions/columns). Skips
  // arbitrary-cmd, endpoint/remote, resume/continue, and already-pinned spawns.
  // Only the wire args (sendMsg.args) carry --session-id; the column's stored
  // cmdArgs stays ORIGINAL so respawn rebuilds as original + --resume <id>
  // (never --session-id <existing-id>, which the CLI rejects) and popout
  // transfer / saved-layout never see an orphan --session-id flag.
  var __origArgs = claudeArgs;
  var __plan = window.SpawnSession.planFreshSessionId(
    { args: claudeArgs, cmd: cmd, hasEndpoint: !!(opts.endpointId || opts.env) },
    window.SpawnSession.randomUuidV4);
  claudeArgs = __plan.args;

  var preSpawnSessionsPromise = (!cmd && window.electronAPI)
    ? window.electronAPI.getRecentSessions(cwd)
    : Promise.resolve([]);

  requestAnimationFrame(function () {
    fitTerminal(terminal, fitAddon);
    if (opts.reattachPtyId != null) {
      // Pty already exists in pty-server — just rebind it to this window's WS.
      // Claude CLI hides xterm's cursor at startup via DECTCEM (\e[?25l) and
      // enables focus reporting via \e[?1004h so it can animate its own
      // block cursor only on the focused terminal. Reattach creates a fresh
      // xterm with both modes at defaults, but running Claude won't re-send
      // the init sequences — re-apply them here so the reattached terminal
      // matches what Claude expects.
      terminal.write('\x1b[?25l\x1b[?1004h');
      wsSend({ type: 'reattach', id: id, cols: terminal.cols, rows: terminal.rows });
      return;
    }
    // Bind this column to the app-managed Headroom proxy by env var (no fragile
    // `headroom wrap` subprocess). maybeBindHeadroom no-ops unless the global
    // toggle is on AND this is a plain default-Claude spawn (no endpoint, no
    // arbitrary cmd). We keep `cmd`/`claudeArgs`/session-id pinning intact — the
    // detectSession guard below relies on `cmd` staying falsy for default cols.
    var sendMsg = { type: 'create', id: id, cols: terminal.cols, rows: terminal.rows, cwd: cwd, args: claudeArgs };
    if (cmd) sendMsg.cmd = cmd;
    if (opts.env) sendMsg.env = opts.env;
    maybeBindHeadroom(sendMsg, { hasEndpoint: !!(opts.endpointId || opts.env), isClaude: !cmd });

    vlog('spawn', { colId: id, cwd: cwd, cmd: sendMsg.cmd || 'claude', args: sendMsg.args });
    wsSend(sendMsg);

    var isResume = claudeArgs.indexOf('--resume') !== -1;
    if (!cmd && !isResume && !__plan.sessionId && window.electronAPI) {
      preSpawnSessionsPromise.then(function (preSessions) {
        var preIds = {};
        for (var i = 0; i < preSessions.length; i++) {
          preIds[preSessions[i].sessionId] = true;
        }
        detectSession(id, cwd, preIds, 0);
      });
    }
  });

  terminal.onData(function (data) {
    if (handleSnippetExpansion(id, data)) return;  // consumed by snippet expansion
    wsSend({ type: 'write', id: id, data: data });
    var c = allColumns.get(id);
    if (c && data.length > 0 && data.charCodeAt(0) !== 0x1b) {
      c.lastInputAt = Date.now();
      // Typing is attention on this column for voice auto-play, even if a prior
      // sidebar click cleared it (typing fires no focus event, so the click/
      // refocus catch-up paths never run). Catch up the unspoken reply too, with
      // the same guards as the click catch-up. The voiceUnspoken flag clears on
      // the first relevant keystroke, so this is a no-op after that (no storm),
      // and escape sequences are already filtered out above.
      voiceAttentionColumnId = id;
      try {
        if (c.voiceUnspoken && voiceSettings && voiceSettings.enabled && voiceSettings.focusCatchUp !== false && voiceWindowFocused && !isProjectVoiceMuted(c.projectKey)) {
          c.voiceUnspoken = false;
          vlog('catchup typing', { colId: id });
          playColumnReply(id, voiceSettings.readingMode || 'auto');
        }
      } catch (e) {}
      // Stop attention flash when the user types — clearly they're responding
      if (c.activityState === 'attention') {
        c.hasUserInput = false;
        c.notified = true;
        if (c.headerEl) c.headerEl.classList.remove('attention-flash');
        var projKey = c.projectKey;
        if (projKey) {
          var sidebarItem = projectListEl.querySelector('.project-item[data-project-path="' + CSS.escape(projKey) + '"]');
          if (sidebarItem && sidebarItem.classList.contains('attention-flash')) {
            var otherFlashing = false;
            allColumns.forEach(function (other) {
              if (other !== c && other.projectKey === projKey && other.headerEl &&
                  other.headerEl.classList.contains('attention-flash')) {
                otherFlashing = true;
              }
            });
            if (!otherFlashing) {
              projectsNeedingAttention.delete(projKey);
              sidebarItem.classList.remove('attention-flash');
            }
          }
        }
        // Stop taskbar flash too (only if window is focused — clicking already stops it)
        if (window.electronAPI && window.electronAPI.stopFlashFrame && document.hasFocus()) {
          window.electronAPI.stopFlashFrame();
        }
      }
      // Only set hasUserInput when user actually submits (Enter key = \r or \n)
      // Not on typing/pasting, which happens before submission
      if (data.indexOf('\r') !== -1 || data.indexOf('\n') !== -1) {
        if (!c.hasUserInput && !c.contextEnabled) {
          // First submission on a brand-new column — enable the ctx meter
          // and lock a `since` timestamp so the synthetic system-prompt
          // assistant entry Claude wrote at startup is filtered out.
          c.contextEnabled = true;
          c.contextSinceMs = Date.now();
        }
        c.hasUserInput = true;
        c.notified = false;
        // Snap Clawd to thinking immediately on submit. UserPromptSubmit
        // hooks usually arrive within a few ms, but on freshly-spawned
        // columns the sessionId mapping may not be resolved yet so the
        // hook lands in the orphan bucket. This is a direct, race-free
        // path because we *know* the user just submitted. (Column id is
        // the closure variable `id`; the column object itself has no
        // `id` property — Map key only.)
        if (window.Clawd && window.Clawd.setColumnAnimation) {
          window.Clawd.setColumnAnimation(id, 'thinking');
        }
      }
    }
  });

  // Tears down whatever terminal context menu is currently open (node +
  // capture-phase document listeners). Hoisted into the per-column scope so
  // a second right-click can tear down the FIRST menu's listeners before
  // building a new menu — otherwise those closures reference a detached node
  // and leak (one capture-phase pair per extra right-click).
  var removeTerminalContextMenu = null;

  termWrapper.addEventListener('contextmenu', function (e) {
    e.preventDefault();

    // Capture the selection at menu-open time, before any focus/click changes
    // can clear it, so the item handlers operate on the correct text.
    var sel = terminal.getSelection();

    if (removeTerminalContextMenu) { removeTerminalContextMenu(); }

    var menu = document.createElement('div');
    menu.className = 'terminal-context-menu';

    var removed = false;
    function removeMenu() {
      if (removed) return;
      removed = true;
      menu.remove();
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      removeTerminalContextMenu = null;
    }
    function onMouseDown(ev) {
      if (!menu.contains(ev.target)) removeMenu();
    }
    function onKeyDown(ev) {
      if (ev.key === 'Escape') removeMenu();
    }
    removeTerminalContextMenu = removeMenu;

    if (sel) {
      var copyItem = document.createElement('div');
      copyItem.className = 'terminal-context-item';
      copyItem.textContent = 'Copy';
      var copyHint = document.createElement('span');
      copyHint.className = 'terminal-context-hint';
      copyHint.textContent = IS_DARWIN ? '⌘C' : 'Ctrl+C';
      copyItem.appendChild(copyHint);
      copyItem.addEventListener('click', function () {
        var clean = (window.ReflowText && window.ReflowText.reflowSelection) ? window.ReflowText.reflowSelection(sel) : sel;
        window.electronAPI.clipboardWriteText(clean);
        terminal.clearSelection();
        removeMenu();
      });
      menu.appendChild(copyItem);

      var rawItem = document.createElement('div');
      rawItem.className = 'terminal-context-item';
      rawItem.textContent = 'Copy raw text';
      var hint = document.createElement('span');
      hint.className = 'terminal-context-hint';
      hint.textContent = IS_DARWIN ? '⌘⇧C' : 'Ctrl+Shift+C';
      rawItem.appendChild(hint);
      rawItem.addEventListener('click', function () {
        window.electronAPI.clipboardWriteText(sel);
        terminal.clearSelection();
        removeMenu();
      });
      menu.appendChild(rawItem);
    }

    var pasteItem = document.createElement('div');
    pasteItem.className = 'terminal-context-item';
    pasteItem.textContent = 'Paste';
    pasteItem.addEventListener('click', function () {
      window.electronAPI.clipboardReadText().then(function (text) {
        if (text) {
          terminal.focus();
          terminal.paste(text);
        }
      });
      removeMenu();
    });
    menu.appendChild(pasteItem);

    document.body.appendChild(menu);

    // Position, guarding against the menu spilling off the right/bottom edge.
    var rect = menu.getBoundingClientRect();
    var x = e.clientX;
    var y = e.clientY;
    if (x + rect.width > window.innerWidth) x = Math.max(0, window.innerWidth - rect.width - 4);
    if (y + rect.height > window.innerHeight) y = Math.max(0, window.innerHeight - rect.height - 4);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    setTimeout(function () {
      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    }, 0);
  });

  // Capture phase: clicking directly into the xterm viewport (the text area where
  // the cursor blinks) doesn't reliably bubble a mousedown to termWrapper — xterm's
  // internal DOM can swallow it — so a bubble-phase listener misses text clicks and
  // the column never gets attended for voice catch-up. Capture fires parent→child,
  // before xterm consumes the event, so every click inside the column attends it.
  termWrapper.addEventListener('mousedown', function () {
    setFocusedColumn(id, { userFocus: true });
  }, true);

  // Clicking the bare header strip (not just the terminal body) also attends the
  // column for voice auto-play. The header is a sibling of termWrapper, so the
  // termWrapper listener above doesn't cover it. Action buttons inside the header
  // fire their own 'click' handlers regardless — this mousedown bubbling up and
  // marking the column attended is harmless and correct (e.g. pressing A's play
  // button should attend A).
  header.addEventListener('mousedown', function () {
    setFocusedColumn(id, { userFocus: true });
  });

  header.querySelector('.col-restart').addEventListener('click', function () {
    restartColumn(id);
  });
  header.querySelector('.col-play-full').addEventListener('click', function () {
    playColumnReply(id, 'full');
  });
  header.querySelector('.col-play-summary').addEventListener('click', function () {
    playColumnReply(id, 'summary');
  });
  header.querySelector('.col-close').addEventListener('click', function () {
    removeColumn(id);
  });

  // Extract session ID if resuming, or take from opts for a reattach transfer.
  var resumeSessionId = opts.sessionId || null;
  for (var ai = 0; ai < claudeArgs.length - 1; ai++) {
    if (claudeArgs[ai] === '--resume') { resumeSessionId = claudeArgs[ai + 1]; break; }
  }
  // Detect the model from --model flag or ANTHROPIC_MODEL env, so the ctx meter
  // can pick the correct limit (200k vs 1M). Falls back to 'sonnet' (200k).
  var detectedModel = null;
  for (var mi = 0; mi < claudeArgs.length - 1; mi++) {
    if (claudeArgs[mi] === '--model') { detectedModel = claudeArgs[mi + 1]; break; }
  }
  if (!detectedModel && opts.env && opts.env.ANTHROPIC_MODEL) {
    detectedModel = opts.env.ANTHROPIC_MODEL;
  }
  // Detect the effort this column was launched with, so the header badge and
  // every later respawn (buildResumeArgs) reflect/preserve it.
  var detectedEffort = null;
  for (var efi = 0; efi < claudeArgs.length - 1; efi++) {
    if (claudeArgs[efi] === '--effort') { detectedEffort = claudeArgs[efi + 1]; break; }
  }

  var colData = {
    element: col,
    terminal: terminal,
    fitAddon: fitAddon,
    webglAddon: webglAddon,
    searchAddon: searchAddon,
    searchOverlay: searchOverlay,
    headerEl: header,
    cwd: cwd,
    cwdSource: opts.cwdSource || null,
    projectKey: activeProjectKey,
    // Stamp the workspaceId so later persist/restore/focus-flow can route to
    // the right bucket. Honor explicit opts.workspaceId (popout transfers,
    // restoreSessions, setActiveWorkspace) otherwise read the active project's
    // currently-active workspace id. Primary columns settle on null.
    workspaceId: (opts.workspaceId !== undefined)
      ? opts.workspaceId
      : (function () {
          var p = config.projects[config.activeProjectIndex];
          return (p && p.activeWorkspaceId != null) ? p.activeWorkspaceId : null;
        })(),
    sessionId: resumeSessionId,
    sessionMtime: 0,
    customTitle: opts.title || null,
    cmd: cmd,
    cmdArgs: __origArgs,     // ORIGINAL args (no injected --session-id; see __plan above)
    model: detectedModel,    // for ctx meter limit (200k vs 1M)
    effort: detectedEffort,  // current effort; source of truth for the header badge + respawns
    env: opts.env || null,
    launchUrl: opts.launchUrl || null,
    launchUrlOpened: false,
    createdAt: Date.now(),
    lastInputAt: 0,
    hasUserInput: false,
    hookEverSeen: false,
    lastHookAt: 0,
    staleHintShown: false,
    notified: false,
    spawnSessionPct: null,    // (unused) five_hour.utilization at spawn — kept for backward compat
    spawnWeeklyPct: null,     // (unused) reserved
    spawnSessionTokens: null, // context-token count at spawn — set on first ctx poll
    // For resumed columns the meter is enabled immediately so the existing
    // context is shown. For brand-new columns it stays disabled until the
    // user actually submits — Claude CLI writes a synthetic assistant entry
    // with the system-prompt + CLAUDE.md usage at startup (~40k+) whose
    // timestamp lands just after spawn, so a pure timestamp filter doesn't
    // suppress it. Gating on real user interaction does.
    contextEnabled: !!resumeSessionId,
    contextSinceMs: null,
    deltaSessionEl: null,     // header element, captured below
    ctxMeterEl: null,
    ctxFillEl: null,
    ctxTextEl: null,
    ctxPollTimer: null,
    snippetBuffer: '',  // accumulates printable chars to detect "\\trigger" patterns
    endpointId: opts.endpointId || (typeof currentEndpointId !== 'undefined' ? currentEndpointId : null) || null,
    failedOver: false  // set true after one failover so we don't ping-pong
  };

  row.columnIds.push(id);
  state.columns.set(id, colData);
  allColumns.set(id, colData);

  // Re-fit when the wrapper settles to its final flex height. The create-time
  // fit() (above) runs before the column header + endpoint banner finish
  // laying out, so FitAddon picks one row too many; the layout then settles
  // ~17px shorter and the canvas overflows the (overflow:hidden) wrapper,
  // clipping the last row. Observing the wrapper catches that settle (and
  // later header-wrap / panel-toggle resizes) and re-fits — same per-column
  // logic as refitAll(). Debounced 100ms to match refitDebouncer.
  if (window.WrapperRefit) {
    colData.wrapResizeDisconnect = window.WrapperRefit.observeWrapperResize({
      wrapper: termWrapper,
      debounceMs: 100,
      onResize: function () {
        var live = allColumns.get(id);
        if (!live) return;
        if (live.minimized || live.isDiff) return;
        if (!live.element || live.element.offsetParent === null) return;
        try {
          fitTerminal(live.terminal, live.fitAddon);
          resizeSuppressed.add(id);
          setTimeout(function () { resizeSuppressed.delete(id); }, 500);
          wsSend({ type: 'resize', id: id, cols: live.terminal.cols, rows: live.terminal.rows });
        } catch (e) {}
      }
    });
  }

  attachTerminalSearchOverlay(colData);
  colData.deltaSessionEl = header.querySelector('[data-col-delta]');
  colData.ctxMeterEl = header.querySelector('[data-col-ctx]');
  colData.ctxFillEl = colData.ctxMeterEl ? colData.ctxMeterEl.querySelector('.col-ctx-fill') : null;
  colData.ctxTextEl = colData.ctxMeterEl ? colData.ctxMeterEl.querySelector('.col-ctx-text') : null;
  // Make the header effort badge reflect the column's actual launch effort.
  var effortBadgeEl = header.querySelector('.col-effort');
  if (effortBadgeEl && colData.effort && isValidEffort(colData.effort)) effortBadgeEl.value = colData.effort;
  startContextMeterPoll(id);
  setFocusedColumn(id);
  if (lastPlanLimitsResult && lastPlanLimitsResult.ok && lastPlanLimitsResult.data) {
    var d0 = lastPlanLimitsResult.data;
    colData.spawnSessionPct = d0.five_hour ? d0.five_hour.utilization : null;
    colData.spawnWeeklyPct = d0.seven_day ? d0.seven_day.utilization : null;
  }
  refitAll();
  saveColumnCounts();
  updateProjectBadges();

  // Render delta pill immediately (shows Δ 0.0% right away if we have data)
  if (lastPlanLimitsResult && lastPlanLimitsResult.ok && lastPlanLimitsResult.data) {
    updateColumnDeltaPills(lastPlanLimitsResult.data);
  }

  // Auto-fetch title from session if resuming without a saved title
  if (resumeSessionId && !opts.title && !cmd) {
    fetchAndSetSessionTitle(id, cwd, resumeSessionId);
  }

  // Start the Clawd JSONL tail for resumed sessions — for fresh spawns this
  // kicks in once detectSession discovers the new sessionId.
  if (resumeSessionId && !cmd) {
    ensureClawdTail(id);
  }

  // Start periodic session sync for Claude columns (not custom commands)
  if (!cmd) {
    startSessionSync(id, cwd);
  }

  // Fresh local spawn pinned to a deterministic --session-id: bind the column
  // to it immediately (no detectSession race). The JSONL won't exist until the
  // CLI writes it — the tail/title helpers retry/guard, so don't block on them.
  // Mirrors detectSession's success follow-ups.
  if (__plan.sessionId && !resumeSessionId && !cmd) {
    colData.sessionId = __plan.sessionId;
    colData.voiceTranscriptPath = null; colData.voicePreTurnUuid = undefined; colData.lastSpokenUuid = undefined; colData.lastSpokenText = undefined;
    persistSessions(colData.projectKey, colData.workspaceId);
    fetchAndSetSessionTitle(id, cwd, __plan.sessionId);
    ensureClawdTail(id);
  }
}

function addRow() {
  if (!activeProjectKey) return;
  var state = getActiveState();
  if (!state) return;

  var row = addRowToProject(state);
  addColumn(null, row, spawnOpts());
}

// ============================================================
// Diff Column
// ============================================================

function parseDiff(diffText) {
  var hunks = [];
  if (!diffText || !diffText.trim()) return { hunks: hunks };
  var lines = diffText.split('\n');
  var currentHunk = null;
  var oldLine = 0;
  var newLine = 0;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)/);
    if (hunkMatch) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1]),
        oldCount: parseInt(hunkMatch[2]) || 1,
        newStart: parseInt(hunkMatch[3]),
        newCount: parseInt(hunkMatch[4]) || 1,
        header: line,
        lines: []
      };
      oldLine = currentHunk.oldStart;
      newLine = currentHunk.newStart;
      hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue;
    if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'add', content: line.substring(1), oldLine: null, newLine: newLine++ });
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ type: 'del', content: line.substring(1), oldLine: oldLine++, newLine: null });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — skip
    } else {
      currentHunk.lines.push({ type: 'context', content: line.length > 0 ? line.substring(1) : '', oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return { hunks: hunks };
}

// Per-(workspace, slotKey) index for diffContent column reuse.
var diffSlotIndex = new Map(); // 'wsId::slotKey' -> columnId

function addDiffColumn(diffData, opts) {
  opts = opts || {};
  if (!activeProjectKey) return;

  var state = getOrCreateProjectState(activeProjectKey);
  if (!state) return;
  // Ensure container is visible
  state.containerEl.style.display = 'flex';

  // Two diff slots: one for file list (commit clicks), one for diff content (file clicks)
  // Determine which slot this is
  var isFileList = diffData.commitHash && !diffData.filePath;
  var slotType = isFileList ? 'diffFileList' : 'diffContent';

  // For diffContent, scope reuse to (session, file, scope) so each session +
  // file gets its own column. Resolve sessionId/workspaceId from focus.
  var scope = null;
  var sessionId = null;
  var workspaceIdForSlot = null;
  var slotKey = null;
  var fullKey = null;
  if (slotType === 'diffContent') {
    scope = (diffData.commitHash && diffData.filePath)
      ? ('commit-' + String(diffData.commitHash).substring(0, 7))
      : 'working';
    var focusState = getOrCreateProjectState(activeProjectKey);
    var focusedCol = (focusState && focusState.focusedColumnId != null)
      ? allColumns.get(focusState.focusedColumnId)
      : null;
    if (focusedCol) {
      if (focusedCol.sessionId) sessionId = focusedCol.sessionId;
      else if (focusedCol.isDiff && focusedCol.sessionId) sessionId = focusedCol.sessionId;
      workspaceIdForSlot = focusedCol.workspaceId || null;
    }
    slotKey = 'diffContent::' + (sessionId || '__noSession__') + '::' + scope + '::' + diffData.filePath;
    fullKey = (workspaceIdForSlot || '__primary__') + '::' + slotKey;
  }

  // Find existing column for reuse:
  //  - diffFileList: single slot per project state.
  //  - diffContent: keyed by (workspaceId, slotKey) so different sessions/files
  //    don't collide.
  var existingDiffId = null;
  if (slotType === 'diffFileList') {
    state.columns.forEach(function (col, id) {
      if (col.isDiff && col.diffSlot === slotType) existingDiffId = id;
    });
  } else if (slotType === 'diffContent' && fullKey != null) {
    var indexed = diffSlotIndex.get(fullKey);
    if (indexed != null && state.columns.has(indexed)) existingDiffId = indexed;
  }
  if (existingDiffId !== null) {
    var existingCol = allColumns.get(existingDiffId);
    if (existingCol) {
      existingCol.diffData = diffData;
      existingCol.diffMode = existingCol.diffMode || 'unified';
      existingCol.customTitle = opts.title || diffData.filePath || 'Diff';
      var titleEl = existingCol.headerEl.querySelector('.col-title');
      if (titleEl) titleEl.textContent = existingCol.customTitle;
      var diffBody = existingCol.element.querySelector('.diff-body');
      if (isFileList) {
        loadCommitDiff(diffBody, existingCol);
      } else if (diffData.diffText) {
        existingCol.diffData.parsed = parseDiff(diffData.diffText);
        renderDiffContent(diffBody, existingCol);
      } else if (diffData.commitHash) {
        loadCommitDiff(diffBody, existingCol);
      } else {
        loadWorkingDiff(diffBody, existingCol);
      }
      existingCol.element.scrollIntoView({ behavior: 'smooth' });
      setFocusedColumn(existingDiffId);
    }
    return;
  }

  var row = getActiveRow(state);
  if (!row) row = addRowToProject(state);

  var id = ++globalColumnId;
  var col = document.createElement('div');
  col.className = 'column diff-column';
  col.id = 'col-' + id;
  col.style.flex = '1';

  var title = opts.title || diffData.filePath || 'Diff';
  var header = createColumnHeader(id, title, { isDiff: true });

  // Diff mode toggle button
  var toggleBtn = document.createElement('span');
  toggleBtn.className = 'col-action diff-toggle';
  toggleBtn.title = 'Toggle unified/split view';
  toggleBtn.textContent = '\u2194';
  var headerActions = header.querySelector('.col-actions');
  headerActions.insertBefore(toggleBtn, headerActions.firstChild);

  var diffBody = document.createElement('div');
  diffBody.className = 'diff-body';

  col.appendChild(header);
  col.appendChild(diffBody);

  // Add resize handle if not the first column
  if (row.columnIds.length > 0) {
    var handle = document.createElement('div');
    handle.className = 'resize-handle';
    row.el.appendChild(handle);
    setupResizeHandle(handle);
  }

  row.el.appendChild(col);

  var colData = {
    element: col,
    terminal: null,
    isDiff: true,
    diffSlot: slotType,
    diffData: diffData,
    diffMode: 'unified',
    headerEl: header,
    cwd: opts.cwd || gitTargetCwd(),
    projectKey: activeProjectKey,
    customTitle: title,
    createdAt: Date.now()
  };

  if (slotType === 'diffContent') {
    colData.sessionId = sessionId;
    colData.filePath = diffData.filePath;
    colData.scope = scope;
    colData.workspaceId = workspaceIdForSlot;
    colData.diffSlotKey = slotKey;
    if (fullKey != null) diffSlotIndex.set(fullKey, id);
  }

  row.columnIds.push(id);
  state.columns.set(id, colData);
  allColumns.set(id, colData);

  // Toggle button handler
  toggleBtn.addEventListener('click', function () {
    colData.diffMode = colData.diffMode === 'unified' ? 'split' : 'unified';
    toggleBtn.textContent = colData.diffMode === 'unified' ? '\u2194' : '\u2016';
    renderDiffContent(diffBody, colData);
  });

  // Close button handler \u2014 diffSlotIndex cleanup is centralized in removeColumn
  // so all column-removal paths drop the slot entry.
  header.querySelector('.col-close').addEventListener('click', function () {
    removeColumn(id);
  });

  // Render diff content
  if (diffData.diffText) {
    renderDiffContent(diffBody, colData);
  } else if (diffData.commitHash) {
    loadCommitDiff(diffBody, colData);
  } else {
    loadWorkingDiff(diffBody, colData);
  }

  setFocusedColumn(id);
  saveColumnCounts();
  updateProjectBadges();
}

function loadWorkingDiff(diffBody, colData) {
  diffBody.textContent = 'Loading...';
  window.electronAPI.gitDiff(colData.cwd, colData.diffData.filePath, colData.diffData.staged || false).then(function (text) {
    colData.diffData.diffText = text;
    colData.diffData.parsed = parseDiff(text);
    renderDiffContent(diffBody, colData);
  });
}

function loadCommitDiff(diffBody, colData) {
  diffBody.textContent = 'Loading...';
  var hash = colData.diffData.commitHash;

  if (colData.diffData.filePath) {
    window.electronAPI.gitDiffCommit(colData.cwd, hash, colData.diffData.filePath).then(function (text) {
      colData.diffData.diffText = text;
      colData.diffData.parsed = parseDiff(text);
      renderDiffContent(diffBody, colData);
    });
  } else {
    // Full commit — show file list first, click to view individual diffs
    window.electronAPI.gitCommitDetail(colData.cwd, hash).then(function (detail) {
      colData.diffData.commitDetail = detail;
      colData.diffData.files = detail.files || [];
      renderCommitFileList(diffBody, colData);
    });
  }
}

function renderCommitFileList(diffBody, colData) {
  while (diffBody.firstChild) diffBody.removeChild(diffBody.firstChild);
  var detail = colData.diffData.commitDetail;
  var files = colData.diffData.files || [];

  // Commit info header
  var info = document.createElement('div');
  info.className = 'diff-commit-info';
  var msgEl = document.createElement('div');
  msgEl.className = 'diff-commit-msg';
  msgEl.textContent = detail.message;
  var metaEl = document.createElement('div');
  metaEl.className = 'diff-commit-meta';
  metaEl.textContent = detail.author + ' \u00B7 ' + detail.date;
  info.appendChild(msgEl);
  info.appendChild(metaEl);
  diffBody.appendChild(info);

  if (files.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'diff-empty';
    empty.textContent = '(no files changed)';
    diffBody.appendChild(empty);
    return;
  }

  // File list
  var fileList = document.createElement('div');
  fileList.className = 'diff-file-list';
  var listHeader = document.createElement('div');
  listHeader.className = 'diff-file-list-header';
  listHeader.textContent = files.length + ' file' + (files.length !== 1 ? 's' : '') + ' changed';
  fileList.appendChild(listHeader);

  for (var i = 0; i < files.length; i++) {
    (function (fileInfo) {
      var row = document.createElement('div');
      row.className = 'diff-file-list-item';
      row.addEventListener('click', function () {
        // Open this file's diff in the diff content column
        addDiffColumn({
          commitHash: colData.diffData.commitHash,
          filePath: fileInfo.file,
          status: 'M'
        }, { title: fileInfo.file.split('/').pop(), cwd: colData.cwd });
      });

      var nameEl = document.createElement('span');
      nameEl.className = 'diff-file-list-name';
      nameEl.textContent = fileInfo.file;

      var statsEl = document.createElement('span');
      statsEl.className = 'diff-file-list-stats';
      if (fileInfo.insertions > 0) {
        var addEl = document.createElement('span');
        addEl.className = 'git-stat-add';
        addEl.textContent = '+' + fileInfo.insertions;
        statsEl.appendChild(addEl);
      }
      if (fileInfo.deletions > 0) {
        var delEl = document.createElement('span');
        delEl.className = 'git-stat-del';
        delEl.textContent = '\u2212' + fileInfo.deletions;
        statsEl.appendChild(delEl);
      }

      row.appendChild(nameEl);
      row.appendChild(statsEl);
      fileList.appendChild(row);
    })(files[i]);
  }

  diffBody.appendChild(fileList);
}

function renderDiffContent(diffBody, colData) {
  colData._drag = null;
  while (diffBody.firstChild) diffBody.removeChild(diffBody.firstChild);
  var parsed = colData.diffData.parsed;
  if (!parsed || parsed.hunks.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'diff-empty';
    empty.textContent = '(no changes)';
    diffBody.appendChild(empty);
    return;
  }

  // Back button for commit diffs (return to file list)
  if (colData.diffData.commitDetail && colData.diffData.files) {
    var backBar = document.createElement('div');
    backBar.className = 'diff-back-bar';
    var backBtn = document.createElement('button');
    backBtn.className = 'diff-back-btn';
    backBtn.textContent = '\u2190 Back to files';
    backBtn.addEventListener('click', function () {
      colData.diffData.filePath = null;
      colData.diffData.activeFile = null;
      colData.diffData.diffText = null;
      colData.diffData.parsed = null;
      renderCommitFileList(diffBody, colData);
    });
    backBar.appendChild(backBtn);
    diffBody.appendChild(backBar);
  }

  // File tabs for multi-file commit diffs
  if (colData.diffData.commitDetail && colData.diffData.files && colData.diffData.files.length > 1) {
    var tabBar = document.createElement('div');
    tabBar.className = 'diff-file-tabs';
    for (var t = 0; t < colData.diffData.files.length; t++) {
      (function (fileInfo) {
        var tab = document.createElement('button');
        tab.className = 'diff-file-tab' + (fileInfo.file === colData.diffData.activeFile ? ' active' : '');
        tab.textContent = fileInfo.file.split('/').pop();
        tab.title = fileInfo.file;
        tab.addEventListener('click', function () {
          colData.diffData.activeFile = fileInfo.file;
          diffBody.textContent = 'Loading...';
          window.electronAPI.gitDiffCommit(colData.cwd, colData.diffData.commitHash, fileInfo.file).then(function (text) {
            colData.diffData.diffText = text;
            colData.diffData.parsed = parseDiff(text);
            renderDiffContent(diffBody, colData);
          });
        });
        tabBar.appendChild(tab);
      })(colData.diffData.files[t]);
    }
    diffBody.appendChild(tabBar);
  }

  var container = document.createElement('div');
  container.className = 'diff-content';
  if (colData.diffMode === 'split') {
    renderSplitDiff(container, parsed);
  } else {
    renderUnifiedDiff(container, parsed);
  }
  diffBody.appendChild(container);

  var totalLines = 0;
  for (var h = 0; h < parsed.hunks.length; h++) totalLines += parsed.hunks[h].lines.length;
  if (totalLines > 5000) {
    var warn = document.createElement('div');
    warn.className = 'diff-truncated';
    warn.textContent = 'Diff too large — showing first 5000 lines';
    diffBody.appendChild(warn);
  }
}

function renderUnifiedDiff(container, parsed) {
  for (var h = 0; h < parsed.hunks.length; h++) {
    var hunk = parsed.hunks[h];
    var hunkHeader = document.createElement('div');
    hunkHeader.className = 'diff-hunk-header';
    hunkHeader.textContent = hunk.header;
    container.appendChild(hunkHeader);

    for (var i = 0; i < hunk.lines.length && i < 5000; i++) {
      var lineData = hunk.lines[i];
      var row = document.createElement('div');
      row.className = 'diff-line diff-line-' + lineData.type;
      row.setAttribute('data-line-type', lineData.type);
      if (lineData.oldLine !== null) row.setAttribute('data-old-line', String(lineData.oldLine));
      if (lineData.newLine !== null) row.setAttribute('data-new-line', String(lineData.newLine));

      var oldNum = document.createElement('span');
      oldNum.className = 'diff-line-num';
      oldNum.textContent = lineData.oldLine !== null ? lineData.oldLine : '';

      var newNum = document.createElement('span');
      newNum.className = 'diff-line-num';
      newNum.textContent = lineData.newLine !== null ? lineData.newLine : '';

      var prefix = document.createElement('span');
      prefix.className = 'diff-line-prefix';
      prefix.textContent = lineData.type === 'add' ? '+' : lineData.type === 'del' ? '-' : ' ';

      var content = document.createElement('span');
      content.className = 'diff-line-content';
      content.textContent = lineData.content;

      row.appendChild(oldNum);
      row.appendChild(newNum);
      row.appendChild(prefix);
      row.appendChild(content);
      container.appendChild(row);
    }
  }
}

function renderSplitDiff(container, parsed) {
  var leftPanel = document.createElement('div');
  leftPanel.className = 'diff-split-panel diff-split-left';
  var rightPanel = document.createElement('div');
  rightPanel.className = 'diff-split-panel diff-split-right';

  for (var h = 0; h < parsed.hunks.length; h++) {
    var hunk = parsed.hunks[h];
    var lhdr = document.createElement('div');
    lhdr.className = 'diff-hunk-header';
    lhdr.textContent = hunk.header;
    leftPanel.appendChild(lhdr);
    var rhdr = document.createElement('div');
    rhdr.className = 'diff-hunk-header';
    rhdr.textContent = hunk.header;
    rightPanel.appendChild(rhdr);

    var delQueue = [];
    var addQueue = [];
    function flushQueues() {
      var maxLen = Math.max(delQueue.length, addQueue.length);
      for (var q = 0; q < maxLen; q++) {
        var ld = delQueue[q];
        var la = addQueue[q];
        var leftRow = document.createElement('div');
        leftRow.className = 'diff-line ' + (ld ? 'diff-line-del' : 'diff-line-empty');
        if (ld) {
          leftRow.setAttribute('data-line-type', 'del');
          if (ld.oldLine !== null) leftRow.setAttribute('data-old-line', String(ld.oldLine));
        }
        var leftNum = document.createElement('span');
        leftNum.className = 'diff-line-num';
        leftNum.textContent = ld ? ld.oldLine : '';
        var leftContent = document.createElement('span');
        leftContent.className = 'diff-line-content';
        leftContent.textContent = ld ? ld.content : '';
        leftRow.appendChild(leftNum);
        leftRow.appendChild(leftContent);
        leftPanel.appendChild(leftRow);

        var rightRow = document.createElement('div');
        rightRow.className = 'diff-line ' + (la ? 'diff-line-add' : 'diff-line-empty');
        if (la) {
          rightRow.setAttribute('data-line-type', 'add');
          if (la.newLine !== null) rightRow.setAttribute('data-new-line', String(la.newLine));
        }
        var rightNum = document.createElement('span');
        rightNum.className = 'diff-line-num';
        rightNum.textContent = la ? la.newLine : '';
        var rightContent = document.createElement('span');
        rightContent.className = 'diff-line-content';
        rightContent.textContent = la ? la.content : '';
        rightRow.appendChild(rightNum);
        rightRow.appendChild(rightContent);
        rightPanel.appendChild(rightRow);
      }
      delQueue = [];
      addQueue = [];
    }

    for (var i = 0; i < hunk.lines.length; i++) {
      var line = hunk.lines[i];
      if (line.type === 'del') {
        delQueue.push(line);
      } else if (line.type === 'add') {
        addQueue.push(line);
      } else {
        flushQueues();
        var cl = document.createElement('div');
        cl.className = 'diff-line diff-line-context';
        cl.setAttribute('data-line-type', 'context');
        if (line.oldLine !== null) cl.setAttribute('data-old-line', String(line.oldLine));
        var cln = document.createElement('span');
        cln.className = 'diff-line-num';
        cln.textContent = line.oldLine;
        var clc = document.createElement('span');
        clc.className = 'diff-line-content';
        clc.textContent = line.content;
        cl.appendChild(cln);
        cl.appendChild(clc);
        leftPanel.appendChild(cl);

        var cr = document.createElement('div');
        cr.className = 'diff-line diff-line-context';
        cr.setAttribute('data-line-type', 'context');
        if (line.newLine !== null) cr.setAttribute('data-new-line', String(line.newLine));
        var crn = document.createElement('span');
        crn.className = 'diff-line-num';
        crn.textContent = line.newLine;
        var crc = document.createElement('span');
        crc.className = 'diff-line-content';
        crc.textContent = line.content;
        cr.appendChild(crn);
        cr.appendChild(crc);
        rightPanel.appendChild(cr);
      }
    }
    flushQueues();
  }

  container.classList.add('diff-split-container');
  container.appendChild(leftPanel);
  container.appendChild(rightPanel);

  leftPanel.addEventListener('scroll', function () { rightPanel.scrollTop = leftPanel.scrollTop; });
  rightPanel.addEventListener('scroll', function () { leftPanel.scrollTop = rightPanel.scrollTop; });
}

// ---------- Clawd: drive per-column animation from real session activity ----------
// Tool → animation map. Started from clawd-tank/host/clawd_tank_daemon/daemon.py's
// TOOL_ANIMATION_MAP and expanded so under-used Claude Code tools land on
// distinct animations instead of all falling back to 'typing'.
var CLAWD_TOOL_ANIMATIONS = {
  // file edits → typing
  'edit': 'typing', 'write': 'typing', 'notebookedit': 'typing', 'multiedit': 'typing',
  'todowrite': 'typing',
  // file reads / search → debugger
  'read': 'debugger', 'grep': 'debugger', 'glob': 'debugger', 'ls': 'debugger',
  // shell execution → building
  'bash': 'building', 'bashoutput': 'building',
  // tearing things down → pushing (visually distinct from starting them up)
  'killshell': 'pushing', 'killbash': 'pushing',
  // orchestration → conducting
  'agent': 'conducting', 'task': 'conducting',
  // web access → wizard
  'websearch': 'wizard', 'webfetch': 'wizard',
  // skill / slash-command invocation → juggling (busy, many-balls feel)
  'skill': 'juggling', 'slashcommand': 'juggling',
  // plan mode → wake (Claude "wakes up" out of plan mode into action)
  'exitplanmode': 'wake',
  // LSP / language server → beacon
  'lsp': 'beacon',
  // notebook execution / IDE bridge → sweeping for cleanup-style work
  'notebookrun': 'sweeping',
};

function clawdAnimationForTool(toolName) {
  if (!toolName) return 'typing';
  var key = String(toolName).toLowerCase();
  if (CLAWD_TOOL_ANIMATIONS[key]) return CLAWD_TOOL_ANIMATIONS[key];
  // MCP server calls and IDE/MCP bridges → beacon (off-process comms)
  if (key.indexOf('mcp__') === 0) return 'beacon';
  if (key.indexOf('plugin_') === 0 || key.indexOf('plugin__') === 0) return 'beacon';
  // Read-shaped tools we don't know yet → default to debugger so they don't
  // collapse onto 'typing' alongside Edit/Write.
  if (key.indexOf('search') !== -1 || key.indexOf('find') !== -1 || key.indexOf('list') !== -1) return 'debugger';
  // Write-shaped tools we don't know yet stay on typing.
  return 'typing';
}

// Translate session-state → animation, following clawd-tank's
// _compute_display_state mapping.
function applyClawdEvent(columnId, evt) {
  if (!window.Clawd || !window.Clawd.setColumnAnimation) return;
  var animId = null;
  if (evt.kind === 'working') animId = clawdAnimationForTool(evt.tool);
  else if (evt.kind === 'thinking') animId = 'thinking';
  else if (evt.kind === 'confused') animId = 'confused';
  else if (evt.kind === 'error') animId = 'dizzy';
  else if (evt.kind === 'idle') animId = 'idle';
  if (window.Clawd.logJsonlEvent) {
    window.Clawd.logJsonlEvent({ col: columnId, kind: evt.kind, tool: evt.tool || '', anim: animId });
  }
  if (animId) window.Clawd.setColumnAnimation(columnId, animId);
}

if (window.electronAPI && window.electronAPI.onClawdEvent) {
  window.electronAPI.onClawdEvent(function (data) {
    if (!data || data.columnId == null) return;
    var col = allColumns.get(data.columnId);
    if (!col) return;
    applyClawdEvent(data.columnId, data);
  });
}

// Mirror main's live automation/headless session ids so interactive columns
// never adopt one (see getClaimedSessionIds). Fetch once, then stay in sync.
if (window.electronAPI && window.electronAPI.getBackgroundSessionIds) {
  window.electronAPI.getBackgroundSessionIds().then(function (ids) { backgroundSessionIdsCache = new Set(ids || []); }).catch(function () {});
}
if (window.electronAPI && window.electronAPI.onBackgroundSessionIds) {
  window.electronAPI.onBackgroundSessionIds(function (ids) { backgroundSessionIdsCache = new Set(ids || []); });
}

// Idempotent: start the tail for a column's current sessionId. If we already
// had a tail running for an older sessionId, stop it first. Safe to call as
// often as we like — called on every assignment site.
function ensureClawdTail(columnId) {
  if (!window.electronAPI || !window.electronAPI.clawdStartTail) return;
  var col = allColumns.get(columnId);
  if (!col || !col.sessionId || !col.projectKey) return;
  if (col.clawdTailSessionId === col.sessionId) return;
  col.clawdTailSessionId = col.sessionId;
  window.electronAPI.clawdStartTail(columnId, col.projectKey, col.sessionId);
}

function fetchAndSetSessionTitle(columnId, projectPath, sessionId) {
  if (!window.electronAPI || !window.electronAPI.getSessionTitle) return;
  var col = allColumns.get(columnId);
  if (!col || col.customTitle) return; // don't override manual rename
  window.electronAPI.getSessionTitle(projectPath, sessionId).then(function (title) {
    if (!title) return;
    var col2 = allColumns.get(columnId);
    if (!col2 || col2.customTitle) return;
    col2.customTitle = title;
    var titleEl = col2.headerEl.querySelector('.col-title');
    if (titleEl) titleEl.textContent = title;
    persistSessions(col2.projectKey, col2.workspaceId);
  });
}

// Collect session IDs already claimed by other columns in the same project
function getClaimedSessionIds(excludeColumnId) {
  var claimed = {};
  allColumns.forEach(function (col, colId) {
    if (colId !== excludeColumnId && col.sessionId) {
      claimed[col.sessionId] = true;
    }
  });
  // Background/automation sessions (live `claude --print` runs) must NEVER be
  // adopted by an interactive column — detectSession and the hook-rebind both
  // consult this map, so marking them claimed blocks both adoption paths and
  // keeps a column from latching onto an automation's transcript in the same dir.
  try { backgroundSessionIdsCache.forEach(function (sid) { if (sid) claimed[sid] = true; }); } catch (e) {}
  return claimed;
}

// Detect which session ID was created by a newly spawned Claude
function detectSession(columnId, projectPath, preExistingIds, attempt) {
  if (attempt > 15) {
    console.log('[detectSession] col=' + columnId + ' GAVE UP after 15 attempts. preIds count=' + Object.keys(preExistingIds).length);
    return;
  }
  setTimeout(function () {
    window.electronAPI.getRecentSessions(projectPath).then(function (sessions) {
      var claimed = getClaimedSessionIds(columnId);
      console.log('[detectSession] col=' + columnId + ' attempt=' + attempt + ' projectPath=' + projectPath + ' got ' + sessions.length + ' sessions, ' + Object.keys(preExistingIds).length + ' preIds, ' + Object.keys(claimed).length + ' claimed');
      for (var i = 0; i < sessions.length; i++) {
        var sid = sessions[i].sessionId;
        // Never bind to a 0-byte stray session — voice would read it as silence.
        if (!preExistingIds[sid] && !claimed[sid] && window.SessionTarget.isUsableSessionTarget(sessions[i])) {
          var col = allColumns.get(columnId);
          if (col) {
            console.log('[detectSession] col=' + columnId + ' MATCHED sessionId=' + sid);
            col.sessionId = sid;
            col.voiceTranscriptPath = null; col.voicePreTurnUuid = undefined; col.lastSpokenUuid = undefined; col.lastSpokenText = undefined;
            col.sessionMtime = sessions[i].modified || 0;
            persistSessions(col.projectKey, col.workspaceId);
            fetchAndSetSessionTitle(columnId, projectPath, sid);
            ensureClawdTail(columnId);
            // Sync the header effort badge to the column's actual effort (set
            // at spawn via --effort and tracked as col.effort, the source of
            // truth). Backfill from the kind-appropriate default only if it
            // wasn't captured, so the badge honestly reflects what claude runs on.
            if (!col.effortApplied) {
              col.effortApplied = true;
              if (!col.effort) {
                var isLocal = col.env && col.env.ANTHROPIC_BASE_URL;
                col.effort = isLocal ? defaultEffortLocal : defaultEffortCloud;
              }
              var effortEl = col.element && col.element.querySelector('.col-effort');
              if (effortEl && isValidEffort(col.effort)) effortEl.value = col.effort;
            }
          }
          return;
        }
      }
      detectSession(columnId, projectPath, preExistingIds, attempt + 1);
    });
  }, 2000);
}

// Periodically refresh a column's sessionMtime bookkeeping (used by other
// heuristics). This poll is READ-ONLY for sessionId — deterministic spawn-time
// --session-id pinning makes the spawn id authoritative, and hook-driven
// /clear-follow (clawdResolveHookColumnEx) handles session forks. The poll must
// never reassign col.sessionId, or an idle column can steal a sibling's live
// session and voice speaks the wrong column's reply.
var sessionSyncTimers = new Map();
var SESSION_SYNC_INTERVAL = 5000;

function startSessionSync(columnId, projectPath) {
  if (!window.electronAPI) return;
  stopSessionSync(columnId);

  var timer = setInterval(function () {
    var col = allColumns.get(columnId);
    if (!col) { stopSessionSync(columnId); return; }

    window.electronAPI.getRecentSessions(projectPath).then(function (sessions) {
      var col2 = allColumns.get(columnId);
      if (!col2 || !sessions.length) return;

      var currentEntry = null;
      for (var j = 0; j < sessions.length; j++) {
        if (sessions[j].sessionId === col2.sessionId) { currentEntry = sessions[j]; break; }
      }

      // Read-only bookkeeping: keep sessionMtime fresh, never reassign sessionId.
      if (currentEntry) {
        col2.sessionMtime = currentEntry.modified;
      }
    });
  }, SESSION_SYNC_INTERVAL);

  sessionSyncTimers.set(columnId, timer);
}

function stopSessionSync(columnId) {
  var timer = sessionSyncTimers.get(columnId);
  if (timer) {
    clearInterval(timer);
    sessionSyncTimers.delete(columnId);
  }
}

// Per-projectKey promise chain so concurrent persistSessions calls for the
// SAME file (different workspaces of the same project) serialize rather than
// race. Without this, two quick persists each load the same stale blob,
// mutate disjoint keys, and the later save overwrites the earlier save's
// mutation with its own cold-read copy — data loss for whichever workspace's
// update landed first.
var persistChain = new Map();

// Persist the current column layout for (projectKey, workspaceId) into the
// single sessions.json blob. Primary (workspaceId null) writes to
// blob.sessions + blob.rowHeightRatios; sub-workspaces write to
// blob.workspaces[workspaceId] = { sessions, rowHeightRatios }. Each session
// entry carries { sessionId, title, rowIdx, widthRatio } so the row-persist
// layout (rows + column widths) round-trips through workspace-scoped slices.
//
// Guard: if workspaceId refers to a workspace that's mid-delete (no longer in
// project.workspaces), skip the write so the delete path's in-memory mutation
// isn't overwritten by a late column-level persist.
//
// Returns a promise that resolves once the write lands — most callers don't
// await, but the gate uses it for deterministic assertions.
function persistSessions(projectKey, workspaceId) {
  if (!window.electronAPI) return Promise.resolve();
  if (workspaceId != null) {
    var project = config.projects.find(function (p) { return p && p.path === projectKey; });
    if (!project || !Array.isArray(project.workspaces) ||
        !project.workspaces.some(function (w) { return w && w.id === workspaceId; })) {
      return Promise.resolve(); // deletion in progress — bail
    }
  }

  // Snapshot the live row/column layout for this (projectKey, workspaceId)
  // synchronously so each queued persist captures its invocation-time view.
  var state = projectStates.get(stateKey(projectKey, workspaceId));
  var sessionData = [];
  var rowHeightRatios = [];
  if (state) {
    // Skip while restore is mid-flight — applyLayoutRatios will persist the correct shape on completion.
    if (state.restoringLayout) return Promise.resolve();

    // When the container is hidden (project not active), DOM measurements return 0. Use cached
    // ratios from the row/column objects instead so background session-sync persists still flush.
    var hidden = !!(state.containerEl && state.containerEl.offsetParent === null);

    var rowHeights = [];
    var totalRowHeight = 0;
    for (var r = 0; r < state.rows.length; r++) {
      var rh;
      if (hidden) {
        rh = (typeof state.rows[r].lastHeightRatio === 'number' && state.rows[r].lastHeightRatio > 0)
          ? state.rows[r].lastHeightRatio
          : (1 / state.rows.length);
      } else {
        rh = state.rows[r].el.getBoundingClientRect().height;
        if (!isFinite(rh) || rh <= 0) rh = 1; // defensive
      }
      rowHeights.push(rh);
      totalRowHeight += rh;
    }
    if (totalRowHeight <= 0) totalRowHeight = state.rows.length || 1;

    // Track post-compaction row index: empty rows are dropped from both
    // sessionData (via row.rowIdx) and rowHeightRatios (via positional index)
    // so the saved indices align on restore.
    var compactRowIdx = 0;
    for (var r2 = 0; r2 < state.rows.length; r2++) {
      var row = state.rows[r2];
      var colWidths = [];
      var totalColWidth = 0;
      for (var c = 0; c < row.columnIds.length; c++) {
        var col = state.columns.get(row.columnIds[c]);
        var cw;
        if (!col) {
          cw = 0;
        } else if (hidden) {
          cw = (typeof col.lastWidthRatio === 'number' && col.lastWidthRatio > 0)
            ? col.lastWidthRatio
            : (1 / row.columnIds.length);
        } else {
          cw = col.element.getBoundingClientRect().width;
          if (!isFinite(cw) || cw <= 0) cw = 1;
        }
        colWidths.push(cw);
        totalColWidth += cw;
      }
      if (totalColWidth <= 0) totalColWidth = row.columnIds.length || 1;

      var rowEntries = [];
      for (var c2 = 0; c2 < row.columnIds.length; c2++) {
        var col2 = state.columns.get(row.columnIds[c2]);
        if (!col2 || !col2.sessionId) continue;
        var widthRatio = colWidths[c2] / totalColWidth;
        if (!hidden) col2.lastWidthRatio = widthRatio;
        var entry = {
          sessionId: col2.sessionId,
          title: col2.customTitle || null,
          rowIdx: compactRowIdx,
          widthRatio: widthRatio
        };
        if (col2.cwd && col2.cwd !== projectKey) entry.cwd = col2.cwd;
        if (col2.cwd && col2.cwd !== projectKey && col2.cwdSource) entry.cwdSource = col2.cwdSource;
        // Persist endpoint association so restored columns come back on the
        // same local endpoint (LM Studio, Ollama, etc.) instead of defaulting
        // to whatever the global Spawn dropdown is currently pointing at.
        if (col2.endpointId) entry.endpointId = col2.endpointId;
        rowEntries.push(entry);
      }

      var heightRatio = rowHeights[r2] / totalRowHeight;
      if (!hidden) row.lastHeightRatio = heightRatio;
      if (rowEntries.length === 0) continue; // skip empty rows
      for (var re = 0; re < rowEntries.length; re++) sessionData.push(rowEntries[re]);
      rowHeightRatios.push(heightRatio);
      compactRowIdx++;
    }

    // Minimised columns are detached from the grid (the row-walk above skips
    // them), so persist them separately. They carry no rowIdx/widthRatio and
    // must not influence rowHeightRatios — they restore live-but-minimised.
    for (var mi = 0; mi < state.minimized.length; mi++) {
      var mid = state.minimized[mi];
      var mcol = state.columns.get(mid);
      if (!mcol || !mcol.sessionId) continue;
      var ment = {
        sessionId: mcol.sessionId,
        title: mcol.customTitle || null,
        minimized: true
      };
      if (mcol.cwd && mcol.cwd !== projectKey) ment.cwd = mcol.cwd;
      if (mcol.cwd && mcol.cwd !== projectKey && mcol.cwdSource) ment.cwdSource = mcol.cwdSource;
      if (mcol.endpointId) ment.endpointId = mcol.endpointId;
      sessionData.push(ment);
    }
  }

  var prev = persistChain.get(projectKey) || Promise.resolve();
  var next = prev.then(function () {
    return window.electronAPI.loadSessions(projectKey).then(function (blob) {
      if (!blob || typeof blob !== 'object' || Array.isArray(blob)) blob = { version: 2, sessions: [], rowHeightRatios: [], workspaces: {} };
      if (!Array.isArray(blob.sessions)) blob.sessions = [];
      if (!Array.isArray(blob.rowHeightRatios)) blob.rowHeightRatios = [];
      if (!blob.workspaces || typeof blob.workspaces !== 'object') blob.workspaces = {};
      blob.version = 2;
      if (workspaceId == null) {
        blob.sessions = sessionData;
        blob.rowHeightRatios = rowHeightRatios;
      } else {
        blob.workspaces[workspaceId] = { sessions: sessionData, rowHeightRatios: rowHeightRatios };
      }
      return window.electronAPI.saveSessions(projectKey, blob);
    });
  }).catch(function (err) {
    console.error('persistSessions failed:', err);
  });
  persistChain.set(projectKey, next);
  // Drop the entry once the tail of the chain resolves, so the Map doesn't
  // grow unbounded. Only delete if we're still the tail (a later call may
  // have extended the chain already).
  next.finally(function () {
    if (persistChain.get(projectKey) === next) persistChain.delete(projectKey);
  });
  return next;
}

function removeColumn(id) {
  var col = allColumns.get(id);
  if (!col) return;

  // Clean up diffSlotIndex entries pointing at this id (Critical fix: addDiffColumn
  // registered it, but only the inline close-button handler was deleting it —
  // other removeColumn callers leaked the entry).
  if (col && col.isDiff && col.diffSlotKey) {
    for (const [k, v] of diffSlotIndex.entries()) {
      if (v === id) diffSlotIndex.delete(k);
    }
  }

  // If this column is maximized, restore first
  if (maximizedColumnId === id) {
    toggleMaximizeColumn(id);
  }

  // Clean up timers
  var timer = activityTimers.get(id);
  if (timer) clearTimeout(timer);
  activityTimers.delete(id);
  stopSessionSync(id);
  stopContextMeterPoll(id);

  if (!col.isDiff) wsSend({ type: 'kill', id: id });

  var colElement = col.element;
  var prevSibling = colElement.previousElementSibling;
  var nextSibling = colElement.nextElementSibling;

  colElement.remove();

  if (prevSibling && prevSibling.classList.contains('resize-handle')) {
    prevSibling.remove();
  } else if (nextSibling && nextSibling.classList.contains('resize-handle')) {
    nextSibling.remove();
  }

  if (col.wrapResizeDisconnect) col.wrapResizeDisconnect();
  releaseWebglForColumn(id);
  if (col.terminal) col.terminal.dispose();
  allColumns.delete(id);

  var state = projectStates.get(stateKey(col.projectKey, col.workspaceId));
  if (state) {
    state.columns.delete(id);

    // Remove from row and reset remaining columns to fill space
    for (var r = 0; r < state.rows.length; r++) {
      var idx = state.rows[r].columnIds.indexOf(id);
      if (idx !== -1) {
        state.rows[r].columnIds.splice(idx, 1);
        // Reset remaining columns in this row to equal flex
        for (var ci = 0; ci < state.rows[r].columnIds.length; ci++) {
          var sibling = allColumns.get(state.rows[r].columnIds[ci]);
          if (sibling) {
            sibling.element.style.flex = '';
            sibling.element.style.width = '';
          }
        }
        removeRowIfEmpty(state, state.rows[r]);
        break;
      }
    }

    if (state.focusedColumnId === id) {
      var remaining = Array.from(state.columns.keys());
      if (remaining.length > 0) {
        setFocusedColumn(remaining[remaining.length - 1]);
      } else {
        state.focusedColumnId = null;
        if (lastFocusedColumnId === id) lastFocusedColumnId = null;
      }
    }
  }

  refitAll();
  saveColumnCounts();
  persistSessions(col.projectKey, col.workspaceId);
  updateProjectBadges();
  updateSidebarActivity();
}

function killAllInstancesForProject(projectPath) {
  var state = projectStates.get(projectPath);
  if (!state || state.columns.size === 0) return;
  var ids = Array.from(state.columns.keys());
  var n = ids.length;
  var label = n === 1 ? '1 Claude instance' : (n + ' Claude instances');
  if (!window.confirm('Kill ' + label + ' for this project? Any unsaved work in those columns will be lost.')) {
    return;
  }
  // Mark before removing so that if this is the active project, the empty-state
  // branch in setActiveProject doesn't auto-spawn when the user clicks back.
  state.suppressAutoSpawn = true;
  ids.forEach(function (id) { removeColumn(id); });
  // updateProjectBadges runs inside removeColumn, but force a full sidebar
  // re-render in case the badge patch missed (e.g. items index drift).
  renderProjectList();
  if (projectPath === activeProjectKey) {
    showProjectEmptyHint(state);
  }
}

function showProjectEmptyHint(state) {
  if (!state || !state.containerEl) return;
  if (state.containerEl.querySelector('.project-empty-hint')) return;
  var hint = document.createElement('div');
  hint.className = 'project-empty-hint';
  hint.innerHTML =
    '<div class="project-empty-hint-arrow">↑</div>' +
    '<div class="project-empty-hint-text">Click <strong>+ Spawn Claude</strong> to start a new instance.</div>';
  state.containerEl.appendChild(hint);
}

function hideProjectEmptyHint(state) {
  if (!state || !state.containerEl) return;
  var hint = state.containerEl.querySelector('.project-empty-hint');
  if (hint) hint.remove();
}
function migrateColumnToWorkspace(colId, targetWsId) {
  if (popoutMode) return;
  var col = allColumns.get(colId);
  if (!col) return;
  var sourceWsId = col.workspaceId;
  if (sourceWsId === targetWsId) return;

  var projIdx = config.projects.findIndex(function (p) { return p.path === col.projectKey; });
  if (projIdx < 0) return;

  if (targetWsId !== null
      && !config.projects[projIdx].workspaces.some(function (w) { return w.id === targetWsId; })) {
    return;
  }

  if (maximizedColumnId === colId) {
    toggleMaximizeColumn(colId);
  }

  var srcState = projectStates.get(stateKey(col.projectKey, sourceWsId));
  var srcRow = srcState ? findRowForColumn(srcState, colId) : null;
  if (!srcState || !srcRow) return;

  var targetState = getOrCreateProjectState(stateKey(col.projectKey, targetWsId));
  if (targetState.restoringLayout) return;

  var prev = col.element.previousElementSibling;
  var next = col.element.nextElementSibling;
  col.element.remove();
  if (prev && prev.classList.contains('resize-handle')) prev.remove();
  else if (next && next.classList.contains('resize-handle')) next.remove();

  srcState.columns.delete(colId);
  var srcIdx = srcRow.columnIds.indexOf(colId);
  if (srcIdx >= 0) srcRow.columnIds.splice(srcIdx, 1);
  srcRow.columnIds.forEach(function (rid) {
    var rcol = srcState.columns.get(rid);
    if (rcol && rcol.element) { rcol.element.style.flex = ''; rcol.element.style.width = ''; }
  });
  removeRowIfEmpty(srcState, srcRow);
  if (srcState.focusedColumnId === colId) srcState.focusedColumnId = null;
  if (lastFocusedColumnId === colId) lastFocusedColumnId = null;

  var targetRow = (targetState.rows.length > 0)
    ? targetState.rows[targetState.rows.length - 1]
    : addRowToProject(targetState);

  if (targetRow.columnIds.length > 0) {
    var leftId = targetRow.columnIds[targetRow.columnIds.length - 1];
    var handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.dataset.leftColumnId = String(leftId);
    handle.dataset.rightColumnId = String(colId);
    targetRow.el.appendChild(handle);
    setupResizeHandle(handle);
  }
  targetRow.el.appendChild(col.element);

  targetRow.columnIds.forEach(function (rid) {
    var rcol = targetState.columns.get(rid);
    if (rcol && rcol.element) { rcol.element.style.flex = ''; rcol.element.style.width = ''; }
  });
  col.element.style.flex = '';
  col.element.style.width = '';

  col.workspaceId = targetWsId;
  targetState.columns.set(colId, col);
  targetRow.columnIds.push(colId);

  persistSessions(col.projectKey, sourceWsId);
  persistSessions(col.projectKey, targetWsId);

  setActiveWorkspace(projIdx, targetWsId, false);
  refitAll();
  setFocusedColumn(colId);

  col.element.classList.add('migrated-flash');
  setTimeout(function () { col.element.classList.remove('migrated-flash'); }, 1500);

  saveColumnCounts();
}

async function restartColumn(id) {
  var col = allColumns.get(id);
  if (!col) return;
  if (col.isDiff) return;

  // Kill the current process
  wsSend({ type: 'kill', id: id });

  // Reset the per-column delta baseline so the Δ pill measures from this respawn,
  // not from the original spawn. The next ctx poll repopulates spawnSessionTokens.
  col.spawnSessionTokens = null;
  if (col.deltaSessionEl) col.deltaSessionEl.setAttribute('hidden', '');

  // Hide the context meter — the new session's first poll will repopulate it.
  if (col && col.ctxMeterEl) col.ctxMeterEl.setAttribute('hidden', '');

  // Remove any existing exit overlay
  var overlay = col.element.querySelector('.exit-overlay');
  if (overlay) overlay.remove();

  // Clear and respawn
  col.terminal.clear();
  fitTerminal(col.terminal, col.fitAddon);

  // Don't --resume a session that no longer exists on disk — Claude errors
  // "No conversation found with session ID …". Verify it exists; if not, clear
  // the id so buildResumeArgs omits --resume and starts a fresh session (the
  // session detection / hook self-heal then adopts the new id). Only for real
  // Claude columns (not custom `cmd` columns), and only when we have a checker.
  if (!col.cmd && col.sessionId && window.electronAPI && window.electronAPI.sessionExists) {
    try {
      var stillExists = await window.electronAPI.sessionExists(col.cwd || col.projectKey, col.sessionId);
      if (!stillExists) col.sessionId = null;
    } catch (e) { /* if the check fails, fall through and resume as before */ }
  }

  var sendMsg = { type: 'create', id: id, cols: col.terminal.cols, rows: col.terminal.rows, cwd: col.cwd };
  if (col.cmd) {
    sendMsg.cmd = col.cmd;
    sendMsg.args = col.cmdArgs || [];
  } else {
    sendMsg.args = buildResumeArgs(col);
  }
  if (col.env) sendMsg.env = col.env;
  // Bind to the app-managed Headroom proxy by env var (no `headroom wrap`).
  // Passthrough for arbitrary-cmd/endpoint columns; re-derived from live flag.
  maybeBindHeadroom(sendMsg, { hasEndpoint: !!(col.endpointId || col.env), isClaude: !col.cmd });
  wsSend(sendMsg);
  // Re-evaluate stale-hook health from a clean slate for the new session: if
  // hooks now reach the column it will never re-flag; if they still don't, the
  // sweep can surface the hint again after the grace window.
  col.hookEverSeen = false; col.lastHookAt = 0; col.staleHintShown = false;
  setColumnActivity(id, 'working');
}

function tryEndpointFailover(colId) {
  var col = allColumns.get(colId);
  if (!col || col.failedOver) return;
  if (!window.electronAPI || !window.electronAPI.endpointGet || !window.electronAPI.endpointGetEnv) return;
  window.electronAPI.endpointGet(col.endpointId).then(function (preset) {
    if (!preset || !preset.fallbackId) {
      // No fallback configured — fall through to the normal exit overlay path.
      col.element.appendChild(createExitOverlay(colId, null, col));
      setColumnActivity(colId, 'exited');
      return;
    }
    return window.electronAPI.endpointGetEnv(preset.fallbackId).then(function (envBlock) {
      if (!envBlock) {
        col.element.appendChild(createExitOverlay(colId, null, col));
        setColumnActivity(colId, 'exited');
        return;
      }
      col.failedOver = true;
      col.endpointId = preset.fallbackId;
      col.env = envBlock;

      // Header badge
      if (col.headerEl && !col.headerEl.querySelector('.col-failover-badge')) {
        var badge = document.createElement('span');
        badge.className = 'col-failover-badge';
        badge.textContent = '↺ failover';
        badge.title = 'Auto-failed-over to ' + preset.fallbackId;
        col.headerEl.appendChild(badge);
      }

      // Re-create the pty with the same column id and the fallback env.
      // Reuse existing args (--resume sessionId if present) so the user keeps their place.
      try { col.terminal.clear(); } catch (e) {}
      fitTerminal(col.terminal, col.fitAddon);
      var respawnMsg = {
        type: 'create',
        id: colId,
        cols: col.terminal.cols,
        rows: col.terminal.rows,
        cwd: col.cwd,
        args: col.sessionId ? buildResumeArgs(col) : (col.cmdArgs || [])
      };
      respawnMsg.env = envBlock;
      wsSend(respawnMsg);
      setColumnActivity(colId, 'working');
    });
  }).catch(function () {
    col.element.appendChild(createExitOverlay(colId, null, col));
    setColumnActivity(colId, 'exited');
  });
}

function setFocusedColumn(id, opts) {
  var col = allColumns.get(id);
  if (!col) return;
  var state = projectStates.get(stateKey(col.projectKey, col.workspaceId));
  if (!state) return;

  if (state.focusedColumnId !== null && state.focusedColumnId !== id) {
    var prev = allColumns.get(state.focusedColumnId);
    if (prev) prev.element.classList.remove('focused');
  }
  state.focusedColumnId = id;
  lastFocusedColumnId = id;
  col.element.classList.add('focused');
  if (col.terminal) col.terminal.focus();
  if (window.Clawd && typeof window.Clawd.setFocusedColumn === 'function') {
    window.Clawd.setFocusedColumn(id);
  }

  // Clear attention flash on this column's header
  if (col.headerEl) col.headerEl.classList.remove('attention-flash');

  // Only clear the sidebar flash if no other columns in the SAME (project,
  // workspace) bucket are still flashing — cross-workspace rollup is not
  // allowed per the "strictly per-workspace" alerts rule.
  var otherFlashing = false;
  allColumns.forEach(function (c, cid) {
    if (cid !== id
        && c.projectKey === col.projectKey
        && (c.workspaceId == null ? null : c.workspaceId) === (col.workspaceId == null ? null : col.workspaceId)
        && c.headerEl
        && c.headerEl.classList.contains('attention-flash')) {
      otherFlashing = true;
    }
  });
  if (!otherFlashing) {
    var attnKey = stateKey(col.projectKey, col.workspaceId);
    projectsNeedingAttention.delete(attnKey);
    var sel;
    if (col.workspaceId == null) {
      sel = '.project-item[data-project-path="' + CSS.escape(col.projectKey) + '"]';
    } else {
      sel = '.workspace-item[data-workspace-id="' + CSS.escape(col.workspaceId) + '"]';
    }
    var item = projectListEl.querySelector(sel);
    if (item) item.classList.remove('attention-flash');
  }

  invalidatePathExists(gitTargetCwd());
  invalidateProjectRootBranch(col.projectKey);
  if (isGitTabActive()) {
    refreshGitStatus(true);
    updateGitTargetIndicator();
  }
  autoBindColumnTarget(id).then(function () {
    if (isGitTabActive()) {
      refreshGitStatus(true);
      updateGitTargetIndicator();
    }
  });

  // A genuine user-initiated focus also makes this the attended column for
  // voice auto-play (so a reply that lands while you're typing here speaks).
  if (opts && opts.userFocus === true) voiceAttentionColumnId = id;

  // Focus catch-up: if this column's latest reply was never spoken (e.g. it
  // finished while another column was focused), speak its summary once on focus.
  // ONLY on genuine user focus AND while the window is focused — programmatic
  // focus (project/workspace switch, survivor refocus, maximize) and focus
  // arriving while the window is blurred must NOT auto-speak. Default (no opts)
  // is silent, so any caller we miss fails safe.
  try {
    var fcol = allColumns.get(id);
    if (opts && opts.userFocus === true && voiceWindowFocused
        && fcol && fcol.voiceUnspoken && voiceSettings && voiceSettings.enabled && voiceSettings.focusCatchUp !== false && !isProjectVoiceMuted(fcol.projectKey)) {
      fcol.voiceUnspoken = false;
      vlog('catchup focus', { colId: id });
      playColumnReply(id, voiceSettings.readingMode || 'auto');
    }
  } catch (e) {}
}

function navigateColumn(direction) {
  var state = getActiveState();
  if (!state) return;

  // Build a flat list of all column IDs across all rows (left-to-right, top-to-bottom)
  var ids = [];
  for (var r = 0; r < state.rows.length; r++) {
    for (var c = 0; c < state.rows[r].columnIds.length; c++) {
      ids.push(state.rows[r].columnIds[c]);
    }
  }
  if (ids.length < 2) return;

  var idx = ids.indexOf(state.focusedColumnId);
  var newIdx;
  if (direction === 'left') {
    newIdx = (idx - 1 + ids.length) % ids.length;
  } else if (direction === 'right') {
    newIdx = (idx + 1) % ids.length;
  } else if (direction === 'up' || direction === 'down') {
    // Find current row and column position
    var curRow = -1, curCol = -1;
    for (var ri = 0; ri < state.rows.length; ri++) {
      var ci = state.rows[ri].columnIds.indexOf(state.focusedColumnId);
      if (ci !== -1) { curRow = ri; curCol = ci; break; }
    }
    if (curRow === -1) return;
    var targetRow = direction === 'up'
      ? (curRow - 1 + state.rows.length) % state.rows.length
      : (curRow + 1) % state.rows.length;
    var targetColIdx = Math.min(curCol, state.rows[targetRow].columnIds.length - 1);
    setFocusedColumn(state.rows[targetRow].columnIds[targetColIdx], { userFocus: true });
    return;
  }

  setFocusedColumn(ids[newIdx], { userFocus: true });
}

// ============================================================
// Maximize / Restore Column
// ============================================================

var maximizedColumnId = null;
var savedMaximizedRowSnapshot = null;

function toggleMaximizeColumn(id) {
  var col = allColumns.get(id);
  if (!col) return;
  var state = projectStates.get(stateKey(col.projectKey, col.workspaceId));
  if (!state) return;
  var MaximizeLayoutAPI = (typeof window !== 'undefined' && window.MaximizeLayout) ? window.MaximizeLayout : null;

  if (maximizedColumnId === id) {
    // Restore
    maximizedColumnId = null;
    state.containerEl.classList.remove('has-maximized');
    state.columns.forEach(function (c) {
      c.element.classList.remove('col-maximized', 'col-hidden');
      c.element.style.flex = '';
      c.element.style.width = '';
    });
    // Restore previously-saved row inline flex/height before un-hiding rows
    if (MaximizeLayoutAPI && savedMaximizedRowSnapshot) {
      var restoreOp = MaximizeLayoutAPI.computeRestoreRowOp(savedMaximizedRowSnapshot);
      if (restoreOp) {
        for (var rr = 0; rr < state.rows.length; rr++) {
          if (state.rows[rr].id === restoreOp.rowId) {
            state.rows[rr].el.style.flex = restoreOp.flex;
            state.rows[rr].el.style.height = restoreOp.height;
            break;
          }
        }
      }
    }
    savedMaximizedRowSnapshot = null;
    // Show all rows and resize handles
    for (var r = 0; r < state.rows.length; r++) {
      state.rows[r].el.classList.remove('row-hidden');
    }
    state.containerEl.querySelectorAll('.resize-handle').forEach(function (h) {
      h.classList.remove('handle-hidden');
    });
    var btn = col.headerEl.querySelector('.col-maximize');
    if (btn) { btn.textContent = '\u25A1'; btn.title = 'Maximize'; }
  } else {
    // Maximize
    maximizedColumnId = id;
    state.containerEl.classList.add('has-maximized');
    var targetRow = findRowForColumn(state, id);
    if (MaximizeLayoutAPI && targetRow) {
      var rowsSnap = state.rows.map(function (r) {
        return { id: r.id, inlineFlex: r.el.style.flex, inlineHeight: r.el.style.height };
      });
      var maxOp = MaximizeLayoutAPI.computeMaximizeRowOp(rowsSnap, targetRow.id);
      savedMaximizedRowSnapshot = maxOp.snapshot;
      if (maxOp.expand) {
        targetRow.el.style.flex = maxOp.expand.flex;
        targetRow.el.style.height = maxOp.expand.height;
      }
    }
    for (var r2 = 0; r2 < state.rows.length; r2++) {
      if (state.rows[r2] !== targetRow) {
        state.rows[r2].el.classList.add('row-hidden');
      }
    }
    state.columns.forEach(function (c, cid) {
      if (cid === id) {
        c.element.classList.add('col-maximized');
        c.element.classList.remove('col-hidden');
        c.element.style.flex = '1';
        c.element.style.width = '';
      } else {
        c.element.classList.add('col-hidden');
        c.element.classList.remove('col-maximized');
      }
    });
    // Hide resize handles
    state.containerEl.querySelectorAll('.resize-handle').forEach(function (h) {
      h.classList.add('handle-hidden');
    });
    var btn2 = col.headerEl.querySelector('.col-maximize');
    if (btn2) { btn2.textContent = '\u25A7'; btn2.title = 'Restore'; }
    setFocusedColumn(id);
  }
  refitAll();
  window.__stickyNotesApplyMaximizeVisibility?.();
}

// ============================================================
// Minimise column → workspace dock
// ============================================================

// Lazily create the dock bar inside a state's columns container. The dock
// always renders at the BOTTOM of the flex-column container via CSS `order`,
// regardless of where new rows get appended.
function ensureMinimizeDock(state) {
  if (!state || !state.containerEl) return null;
  var dock = state.containerEl.querySelector('.minimize-dock');
  if (!dock) {
    dock = document.createElement('div');
    dock.className = 'minimize-dock';
    state.containerEl.appendChild(dock);
  }
  return dock;
}

// Read the title a column's header is currently showing (custom title wins).
function minimizedChipLabel(col) {
  if (col && col.customTitle) return col.customTitle;
  if (col && col.headerEl) {
    var t = col.headerEl.querySelector('.col-title');
    if (t) return t.textContent || '';
  }
  return '';
}

function renderMinimizedChip(state, id) {
  var dock = ensureMinimizeDock(state);
  if (!dock) return;
  var col = allColumns.get(id);
  if (!col) return;

  var chip = document.createElement('div');
  chip.className = 'minimize-chip';
  chip.dataset.id = String(id);
  chip.title = 'Restore';
  chip.setAttribute('aria-label', 'Restore column');

  var glyph = document.createElement('span');
  glyph.className = 'chip-glyph';
  // Match the header minimise button's bottom-line SVG for brand consistency.
  glyph.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" y1="9" x2="10" y2="9"/></svg>';

  var label = document.createElement('span');
  label.className = 'chip-label';
  label.textContent = minimizedChipLabel(col);

  var close = document.createElement('span');
  close.className = 'chip-close';
  close.textContent = '×';
  close.title = 'Kill';
  close.addEventListener('click', function (e) {
    e.stopPropagation();
    killMinimizedColumn(id);
  });

  chip.appendChild(glyph);
  chip.appendChild(label);
  chip.appendChild(close);
  chip.addEventListener('click', function () {
    restoreMinimizedColumn(id);
  });

  dock.appendChild(chip);
  // Reflect any current activity (attention/working) state immediately.
  updateMinimizedChipActivity(id);
}

function removeMinimizedChip(state, id) {
  if (!state || !state.containerEl) return;
  var dock = state.containerEl.querySelector('.minimize-dock');
  if (!dock) return;
  var chip = dock.querySelector('.minimize-chip[data-id="' + id + '"]');
  if (chip) chip.remove();
  if (dock.querySelectorAll('.minimize-chip').length === 0) {
    dock.remove();
  }
}

// Mirror the header's waiting/attention treatment onto a minimised chip.
function updateMinimizedChipActivity(id) {
  var col = allColumns.get(id);
  if (!col || !col.minimized) return;
  var state = projectStates.get(stateKey(col.projectKey, col.workspaceId));
  if (!state || !state.containerEl) return;
  var dock = state.containerEl.querySelector('.minimize-dock');
  if (!dock) return;
  var chip = dock.querySelector('.minimize-chip[data-id="' + id + '"]');
  if (!chip) return;
  // Attention (mirrors .activity-dot.activity-attention) and working are
  // mutually exclusive — attention wins. 'waiting' is the normal idle-at-prompt
  // state and must NOT pulse.
  if (col.activityState === 'attention') {
    chip.classList.add('attention');
    chip.classList.remove('working');
  } else if (col.activityState === 'working') {
    chip.classList.add('working');
    chip.classList.remove('attention');
  } else {
    chip.classList.remove('attention', 'working');
  }
}

function minimizeColumn(id) {
  var col = allColumns.get(id);
  if (!col) return;
  var state = projectStates.get(stateKey(col.projectKey, col.workspaceId));
  if (!state) return;

  // Un-maximize first so the layout is in its normal state before we detach.
  if (maximizedColumnId === id) {
    toggleMaximizeColumn(id);
  }

  var row = findRowForColumn(state, id);
  col.minimizeOrigin = {
    rowId: row ? row.id : null,
    index: row ? row.columnIds.indexOf(id) : 0
  };
  col.minimized = true;

  // Detach from the layout WITHOUT disposing (keep terminal + pty alive).
  var colElement = col.element;
  var prevSibling = colElement.previousElementSibling;
  var nextSibling = colElement.nextElementSibling;
  colElement.remove();
  if (prevSibling && prevSibling.classList.contains('resize-handle')) {
    prevSibling.remove();
  } else if (nextSibling && nextSibling.classList.contains('resize-handle')) {
    nextSibling.remove();
  }

  if (row) {
    var idx = row.columnIds.indexOf(id);
    if (idx !== -1) row.columnIds.splice(idx, 1);
    for (var ci = 0; ci < row.columnIds.length; ci++) {
      var sibling = allColumns.get(row.columnIds[ci]);
      if (sibling) {
        sibling.element.style.flex = '';
        sibling.element.style.width = '';
      }
    }
    removeRowIfEmpty(state, row);
  }

  state.minimized.push(id);
  ensureMinimizeDock(state);
  renderMinimizedChip(state, id);

  // Move focus off the minimised column to another live (non-minimised) one.
  if (state.focusedColumnId === id) {
    state.focusedColumnId = null;
    if (lastFocusedColumnId === id) lastFocusedColumnId = null;
    var nextFocus = null;
    state.columns.forEach(function (c, cid) {
      if (cid !== id && !c.minimized) nextFocus = cid;
    });
    if (nextFocus != null) setFocusedColumn(nextFocus);
  }

  refitAll();
  persistSessions(col.projectKey, col.workspaceId);
}

function restoreMinimizedColumn(id) {
  var col = allColumns.get(id);
  if (!col || !col.minimized) return;
  var state = projectStates.get(stateKey(col.projectKey, col.workspaceId));
  if (!state) return;

  var mi = state.minimized.indexOf(id);
  if (mi >= 0) state.minimized.splice(mi, 1);
  removeMinimizedChip(state, id);

  var t = window.MinimizeDock.resolveRestoreTarget(
    state.rows.map(function (r) { return { id: r.id, originRowId: r.originRowId, columnIds: r.columnIds }; }),
    col.minimizeOrigin
  );

  var row;
  if (t.mode === 'existing') {
    row = state.rows.find(function (r) { return r.id === t.rowId; });
  }
  if (!row) {
    row = addRowToProject(state);
    // Tag the recreated row so siblings from the same original row rejoin it.
    if (col.minimizeOrigin && col.minimizeOrigin.rowId != null) {
      row.originRowId = col.minimizeOrigin.rowId;
    }
  }

  // Re-attach the existing element by appending it to the target row, adding a
  // leading resize handle when the row already has visible columns.
  if (row.columnIds.length > 0) {
    var lastId = row.columnIds[row.columnIds.length - 1];
    var handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.dataset.leftColumnId = String(lastId);
    handle.dataset.rightColumnId = String(id);
    row.el.appendChild(handle);
    setupResizeHandle(handle);
  }
  // Clear any stale maximize/hide classes + inline sizing left over from before
  // minimise so the re-attached element flexes normally in its new row.
  col.element.classList.remove('col-hidden', 'col-maximized');
  col.element.style.flex = '';
  col.element.style.width = '';
  row.el.appendChild(col.element);
  row.columnIds.push(id);

  col.minimized = false;
  col.minimizeOrigin = null;

  for (var ci = 0; ci < row.columnIds.length; ci++) {
    var sibling = allColumns.get(row.columnIds[ci]);
    if (sibling) {
      sibling.element.style.flex = '';
      sibling.element.style.width = '';
    }
  }

  refitAll();
  setFocusedColumn(id);
  persistSessions(col.projectKey, col.workspaceId);
}

function killMinimizedColumn(id) {
  var col = allColumns.get(id);
  if (col) {
    var state = projectStates.get(stateKey(col.projectKey, col.workspaceId));
    if (state) {
      var mi = state.minimized.indexOf(id);
      if (mi >= 0) state.minimized.splice(mi, 1);
      removeMinimizedChip(state, id);
    }
  }
  removeColumn(id);
}

// ============================================================
// Recent sessions picker (per-column header)
// ============================================================

function showColumnSessionPicker(colId, clientX, clientY) {
  var col = allColumns.get(colId);
  if (!col || !window.electronAPI || !window.electronAPI.getRecentSessions) return;
  // Close any prior picker.
  var prior = document.querySelector('.col-session-picker');
  if (prior) prior.remove();

  var menu = document.createElement('div');
  menu.className = 'col-session-picker project-context-menu';
  menu.style.left = clientX + 'px';
  menu.style.top = clientY + 'px';
  var loading = document.createElement('div');
  loading.className = 'project-context-item';
  loading.style.opacity = '0.6';
  loading.textContent = 'Loading recent sessions…';
  menu.appendChild(loading);
  document.body.appendChild(menu);

  function close() { menu.remove(); document.removeEventListener('mousedown', outside, true); }
  function outside(ev) { if (!menu.contains(ev.target)) close(); }
  setTimeout(function () { document.addEventListener('mousedown', outside, true); }, 0);

  // Resolve the column's project path from activeProjectKey on the colData.
  var projectPath = col.projectKey || activeProjectKey;
  if (!projectPath) { loading.textContent = 'No project for this column.'; return; }

  window.electronAPI.getRecentSessions(projectPath).then(function (sessions) {
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    var others = (sessions || []).filter(function (s) { return s.sessionId !== col.sessionId; });
    if (others.length === 0) {
      var none = document.createElement('div');
      none.className = 'project-context-item';
      none.style.opacity = '0.6';
      none.textContent = 'No other recent sessions.';
      menu.appendChild(none);
      return;
    }
    others.slice(0, 12).forEach(function (s) {
      var item = document.createElement('div');
      item.className = 'project-context-item';
      var when = new Date(s.modified);
      item.textContent = s.sessionId.slice(0, 8) + '  ·  ' + when.toLocaleString();
      item.addEventListener('click', function () {
        // Swap to the chosen session and restart in place.
        col.sessionId = s.sessionId;
        restartColumn(colId);
        close();
      });
      menu.appendChild(item);
      // Title fetch is best-effort — the short id + date is informative enough
      // on first paint; refine asynchronously when available.
      window.electronAPI.getSessionTitle(projectPath, s.sessionId).then(function (title) {
        if (title) item.textContent = (title.length > 60 ? title.slice(0, 60) + '…' : title) + '  ·  ' + when.toLocaleString();
      }).catch(function () { /* keep id-based label */ });
    });
  }).catch(function () {
    loading.textContent = 'Failed to load sessions.';
  });
}

// ============================================================
// Per-terminal Ctrl/Cmd+F find overlay
// ============================================================

function attachTerminalSearchOverlay(col) {
  if (!col || !col.searchOverlay || !col.terminal) return;
  var overlay = col.searchOverlay;
  var input = overlay.querySelector('.term-search-input');
  var countEl = overlay.querySelector('.term-search-count');
  var prevBtn = overlay.querySelector('.term-search-prev');
  var nextBtn = overlay.querySelector('.term-search-next');
  var closeBtn = overlay.querySelector('.term-search-close');
  var addon = col.searchAddon;

  function show() {
    overlay.classList.remove('hidden');
    input.focus();
    input.select();
  }
  function hide() {
    overlay.classList.add('hidden');
    if (addon && addon.clearDecorations) addon.clearDecorations();
    try { col.terminal.focus(); } catch (e) { /* */ }
  }
  function search(dir) {
    var q = input.value;
    if (!q) { countEl.textContent = '0/0'; if (addon && addon.clearDecorations) addon.clearDecorations(); return; }
    if (!addon) return;
    var opts = {
      decorations: {
        matchBackground: '#3b82f680',
        matchBorder: '#60a5fa',
        matchOverviewRuler: '#60a5fa',
        activeMatchBackground: '#f59e0b80',
        activeMatchBorder: '#fbbf24',
        activeMatchColorOverviewRuler: '#fbbf24'
      },
      regex: false,
      wholeWord: false,
      caseSensitive: false
    };
    var found = dir === -1
      ? (addon.findPrevious ? addon.findPrevious(q, opts) : false)
      : (addon.findNext ? addon.findNext(q, opts) : false);
    countEl.textContent = found ? 'match' : 'no match';
  }

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); hide(); return; }
    if (e.key === 'Enter') { e.preventDefault(); search(e.shiftKey ? -1 : 1); return; }
  });
  input.addEventListener('input', function () { search(1); });
  prevBtn.addEventListener('click', function () { search(-1); });
  nextBtn.addEventListener('click', function () { search(1); });
  closeBtn.addEventListener('click', hide);

  col._showSearch = show;
  col._hideSearch = hide;
}

// ============================================================
// Resize Handles (columns)
// ============================================================

function setupResizeHandle(handle) {
  handle.addEventListener('mousedown', function (e) {
    e.preventDefault();
    var persistKey = activeProjectKey;
    var activeProj = config.projects[config.activeProjectIndex];
    var persistWsId = activeProj ? (activeProj.activeWorkspaceId != null ? activeProj.activeWorkspaceId : null) : null;
    handle.classList.add('active');

    var leftId = parseInt(handle.dataset.leftColumnId);
    var rightId = parseInt(handle.dataset.rightColumnId);
    var leftCol = allColumns.get(leftId);
    var rightCol = allColumns.get(rightId);
    if (!leftCol || !rightCol) return;

    var leftColEl = leftCol.element;
    var rightColEl = rightCol.element;
    var startX = e.clientX;
    var leftStartWidth = leftColEl.getBoundingClientRect().width;
    var rightStartWidth = rightColEl.getBoundingClientRect().width;

    leftColEl.style.flex = 'none';
    rightColEl.style.flex = 'none';
    leftColEl.style.width = leftStartWidth + 'px';
    rightColEl.style.width = rightStartWidth + 'px';
    document.body.style.cursor = 'col-resize';

    function onMouseMove(ev) {
      var delta = ev.clientX - startX;
      var newLeft = Math.max(200, leftStartWidth + delta);
      var newRight = Math.max(200, rightStartWidth - delta);
      if (newLeft >= 200 && newRight >= 200) {
        leftColEl.style.width = newLeft + 'px';
        rightColEl.style.width = newRight + 'px';
        refitDebouncer.schedule();
      }
    }
    function onMouseUp() {
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      refitDebouncer.flush();
      persistSessions(persistKey, persistWsId);
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ============================================================
// Resize Handles (rows)
// ============================================================

function setupRowResizeHandle(handle) {
  handle.addEventListener('mousedown', function (e) {
    e.preventDefault();
    var persistKey = activeProjectKey;
    var activeProj = config.projects[config.activeProjectIndex];
    var persistWsId = activeProj ? (activeProj.activeWorkspaceId != null ? activeProj.activeWorkspaceId : null) : null;
    handle.classList.add('active');

    var state = getActiveState();
    if (!state) return;

    var topRowId = parseInt(handle.dataset.topRowId);
    var bottomRowId = parseInt(handle.dataset.bottomRowId);
    var topRow = null, bottomRow = null;
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].id === topRowId) topRow = state.rows[i];
      if (state.rows[i].id === bottomRowId) bottomRow = state.rows[i];
    }
    if (!topRow || !bottomRow) return;

    var topEl = topRow.el;
    var bottomEl = bottomRow.el;
    var startY = e.clientY;
    var topStartHeight = topEl.getBoundingClientRect().height;
    var bottomStartHeight = bottomEl.getBoundingClientRect().height;

    topEl.style.flex = 'none';
    bottomEl.style.flex = 'none';
    topEl.style.height = topStartHeight + 'px';
    bottomEl.style.height = bottomStartHeight + 'px';
    document.body.style.cursor = 'row-resize';

    function onMouseMove(ev) {
      var delta = ev.clientY - startY;
      var newTop = Math.max(100, topStartHeight + delta);
      var newBottom = Math.max(100, bottomStartHeight - delta);
      if (newTop >= 100 && newBottom >= 100) {
        topEl.style.height = newTop + 'px';
        bottomEl.style.height = newBottom + 'px';
        refitDebouncer.schedule();
      }
    }
    function onMouseUp() {
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      refitDebouncer.flush();
      persistSessions(persistKey, persistWsId);
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ============================================================
// Column Drag-and-Drop Reordering
// ============================================================

var dragSourceColumnId = null;
var dropIndicatorEl = null;

function setupColumnDrag(headerEl, columnId) {
  headerEl.draggable = true;

  headerEl.addEventListener('dragstart', function (e) {
    // Don't drag if editing title or maximized
    if (headerEl.querySelector('[contenteditable="true"]')) { e.preventDefault(); return; }
    var state = getActiveState();
    if (state && state.maximizedColumnId) { e.preventDefault(); return; }

    dragSourceColumnId = columnId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(columnId));

    var col = allColumns.get(columnId);
    if (col) {
      setTimeout(function () { col.element.classList.add('dragging'); }, 0);
    }
  });

  headerEl.addEventListener('dragend', function () {
    var col = allColumns.get(columnId);
    if (col) col.element.classList.remove('dragging');
    dragSourceColumnId = null;
    removeDropIndicator();
  });
}

function setupColumnDropTarget(colEl) {
  colEl.addEventListener('dragover', function (e) {
    if (dragSourceColumnId === null) return;
    var targetId = parseInt(colEl.dataset.id);
    if (targetId === dragSourceColumnId) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    var rect = colEl.getBoundingClientRect();
    var midX = rect.left + rect.width / 2;
    var side = e.clientX < midX ? 'left' : 'right';
    showDropIndicator(colEl, side);
  });

  colEl.addEventListener('dragleave', function (e) {
    if (!colEl.contains(e.relatedTarget)) removeDropIndicator();
  });

  colEl.addEventListener('drop', function (e) {
    e.preventDefault();
    if (dragSourceColumnId === null) return;

    var targetId = parseInt(colEl.dataset.id);
    if (targetId === dragSourceColumnId) { removeDropIndicator(); return; }

    var state = getActiveState();
    if (!state) { removeDropIndicator(); return; }

    var targetRow = findRowForColumn(state, targetId);
    if (!targetRow) { removeDropIndicator(); return; }

    var rect = colEl.getBoundingClientRect();
    var midX = rect.left + rect.width / 2;
    var targetIdx = targetRow.columnIds.indexOf(targetId);
    var insertIdx = e.clientX < midX ? targetIdx : targetIdx + 1;

    moveColumnToPosition(dragSourceColumnId, targetRow, insertIdx);
    removeDropIndicator();
  });
}

function showDropIndicator(targetEl, side) {
  if (!dropIndicatorEl) {
    dropIndicatorEl = document.createElement('div');
    dropIndicatorEl.className = 'drop-indicator';
  }
  targetEl.style.position = 'relative';
  dropIndicatorEl.style.left = side === 'left' ? '-2px' : '';
  dropIndicatorEl.style.right = side === 'right' ? '-2px' : '';
  if (dropIndicatorEl.parentElement !== targetEl) {
    targetEl.appendChild(dropIndicatorEl);
  }
}

function removeDropIndicator() {
  if (dropIndicatorEl && dropIndicatorEl.parentElement) {
    dropIndicatorEl.parentElement.removeChild(dropIndicatorEl);
  }
}

function moveColumnToPosition(columnId, targetRow, insertIndex) {
  var state = getActiveState();
  if (!state) return;

  var sourceRow = findRowForColumn(state, columnId);
  if (!sourceRow) return;

  var srcIdx = sourceRow.columnIds.indexOf(columnId);
  if (srcIdx === -1) return;

  // Same row, same position — no-op
  if (sourceRow === targetRow) {
    if (insertIndex === srcIdx || insertIndex === srcIdx + 1) return;
    if (insertIndex > srcIdx) insertIndex--;
  }

  // Remove from source
  sourceRow.columnIds.splice(srcIdx, 1);

  // Insert into target
  targetRow.columnIds.splice(insertIndex, 0, columnId);

  // Rebuild DOM for affected rows
  rebuildRowDOM(targetRow);
  if (sourceRow !== targetRow) {
    rebuildRowDOM(sourceRow);
    removeRowIfEmpty(state, sourceRow);
  }

  // Reset flex/width on all columns in affected rows
  targetRow.columnIds.forEach(function (cid) {
    var c = allColumns.get(cid);
    if (c) { c.element.style.flex = ''; c.element.style.width = ''; }
  });
  if (sourceRow !== targetRow) {
    sourceRow.columnIds.forEach(function (cid) {
      var c = allColumns.get(cid);
      if (c) { c.element.style.flex = ''; c.element.style.width = ''; }
    });
  }

  refitAll();
  var activeProj = config.projects[config.activeProjectIndex];
  var activeWsId = activeProj ? (activeProj.activeWorkspaceId != null ? activeProj.activeWorkspaceId : null) : null;
  persistSessions(activeProjectKey, activeWsId);
}

function rebuildRowDOM(row) {
  // Remove all existing resize handles
  var handles = row.el.querySelectorAll('.resize-handle');
  handles.forEach(function (h) { h.remove(); });

  // Re-append columns in order with resize handles between them
  for (var i = 0; i < row.columnIds.length; i++) {
    var col = allColumns.get(row.columnIds[i]);
    if (!col) continue;

    if (i > 0) {
      var handle = document.createElement('div');
      handle.className = 'resize-handle';
      handle.dataset.leftColumnId = String(row.columnIds[i - 1]);
      handle.dataset.rightColumnId = String(row.columnIds[i]);
      row.el.appendChild(handle);
      setupResizeHandle(handle);
    }

    row.el.appendChild(col.element); // appendChild moves existing elements
  }
}

// ============================================================
// Fit / Resize
// ============================================================

function refitAll() {
  var state = getActiveState();
  if (!state) return;
  state.columns.forEach(function (col, id) {
    if (col.isDiff) return;
    if (col.minimized) return;
    try {
      fitTerminal(col.terminal, col.fitAddon);
      // Suppress activity tracking for redraw data after resize
      resizeSuppressed.add(id);
      setTimeout(function () { resizeSuppressed.delete(id); }, 500);
      wsSend({ type: 'resize', id: id, cols: col.terminal.cols, rows: col.terminal.rows });
    } catch (e) {}
  });
  if (typeof window.__repositionStickyNotesForActiveProject === 'function') {
    window.__repositionStickyNotesForActiveProject();
  }
}

// During a column/row drag the element widths/heights update live, but the
// xterm fit() + PTY resize must be coalesced so xterm.cols and the PTY width
// never mismatch mid-drag (which corrupts the terminal buffer). schedule() on
// each mousemove, flush() on mouseup for an immediate authoritative refit.
var refitDebouncer = (window.ResizeScheduler && window.ResizeScheduler.makeDebouncer)
  ? window.ResizeScheduler.makeDebouncer(refitAll, 100)
  : { schedule: refitAll, flush: refitAll, cancel: function () {} };

var resizeTimeout;
window.addEventListener('resize', function () {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(function () {
    var state = getActiveState();
    if (state && state.rows.length > 0 && maximizedColumnId == null &&
        !(state.containerEl && state.containerEl.offsetParent === null) &&
        !document.querySelector('.row-resize-handle.active')) {
      var heights = [];
      for (var i = 0; i < state.rows.length; i++) {
        heights.push(state.rows[i].el.getBoundingClientRect().height);
      }
      var ops = window.RowLayout.computeResizeRedistribution(heights);
      for (var j = 0; j < state.rows.length; j++) {
        state.rows[j].el.style.flex = ops[j].flex;
        state.rows[j].el.style.height = ops[j].height;
        var ratio = parseFloat(ops[j].flex);
        if (isFinite(ratio) && ratio > 0) {
          state.rows[j].lastHeightRatio = ratio;
        }
      }
    }
    refitAll();
  }, 100);
});

// On Windows, when the OS window loses focus mid-keypress (Alt-Tab, Win+arrow
// snap, foreground steal), the keyup for held modifiers never reaches xterm's
// hidden textarea — leaving Space/Shift "stuck" until the user manually
// refocuses. Bounce the active terminal's focus on every window focus change
// so xterm's input state resets cleanly.
window.addEventListener('blur', function () {
  var state = getActiveState();
  if (state && state.focusedColumnId !== null) {
    var col = allColumns.get(state.focusedColumnId);
    if (col && col.terminal) col.terminal.blur();
  }
});
window.addEventListener('focus', function () {
  refocusActiveTerminal();
});

// ============================================================
// Keyboard Shortcuts
// ============================================================

document.addEventListener('keydown', function (e) {
  var mod = cmdOrCtrl(e);
  if (mod && e.shiftKey && (e.key === 'T' || e.key === 't')) {
    e.preventDefault();
    addColumn(null, null, spawnOpts());
    return;
  }
  if (mod && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
    e.preventDefault();
    addRow();
    return;
  }
  if (mod && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
    e.preventDefault();
    var state = getActiveState();
    if (state && state.focusedColumnId !== null) removeColumn(state.focusedColumnId);
    return;
  }
  if (mod && !e.shiftKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    navigateColumn('left');
    return;
  }
  if (mod && !e.shiftKey && e.key === 'ArrowRight') {
    e.preventDefault();
    navigateColumn('right');
    return;
  }
  if (mod && !e.shiftKey && e.key === 'ArrowUp') {
    e.preventDefault();
    navigateColumn('up');
    return;
  }
  if (mod && !e.shiftKey && e.key === 'ArrowDown') {
    e.preventDefault();
    navigateColumn('down');
    return;
  }
  if (mod && !e.shiftKey && e.key === 'b') {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  if (mod && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
    e.preventDefault();
    toggleExplorer();
    return;
  }
  if (mod && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
    e.preventDefault();
    var state = getActiveState();
    if (state && state.focusedColumnId !== null) {
      toggleMaximizeColumn(state.focusedColumnId);
    }
    return;
  }
  if (mod && !e.shiftKey && e.key >= '1' && e.key <= '9') {
    var num = parseInt(e.key);
    var state = getActiveState();
    if (state) {
      var ids = [];
      for (var r = 0; r < state.rows.length; r++) {
        for (var c = 0; c < state.rows[r].columnIds.length; c++) {
          ids.push(state.rows[r].columnIds[c]);
        }
      }
      if (num <= ids.length) {
        e.preventDefault();
        setFocusedColumn(ids[num - 1], { userFocus: true });
      }
    }
    return;
  }
  if (mod && !e.shiftKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    changeFontSize(1);
    return;
  }
  if (mod && !e.shiftKey && e.key === '-') {
    e.preventDefault();
    changeFontSize(-1);
    return;
  }
  if (mod && !e.shiftKey && e.key === '0') {
    e.preventDefault();
    resetFontSize();
    return;
  }
  // Cmd/Ctrl+F: open in-terminal find. Falls through if any modal-bound
  // editor handler already consumed it (those run on the textarea, not
  // document, and stopPropagation in their listeners prevents re-entry here).
  if (mod && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
    var st = getActiveState();
    if (st && st.focusedColumnId !== null) {
      var c = allColumns.get(st.focusedColumnId);
      if (c && typeof c._showSearch === 'function') {
        e.preventDefault();
        c._showSearch();
        return;
      }
    }
  }
});

// ============================================================
// Sidebar toggle
// ============================================================

function toggleSidebar() {
  sidebar.classList.toggle('collapsed');
  var handle = document.getElementById('sidebar-resize-handle');
  if (handle) handle.classList.toggle('hidden', sidebar.classList.contains('collapsed'));
  syncPanelToggleStates();
  setTimeout(refitAll, 250);
}

function syncPanelToggleStates() {
  if (btnToggleSidebar) {
    btnToggleSidebar.classList.toggle('active-panel', !sidebar.classList.contains('collapsed'));
  }
  var btnExp = document.getElementById('btn-toggle-explorer');
  var explorerEl = document.getElementById('explorer-panel');
  if (btnExp && explorerEl) {
    btnExp.classList.toggle('active-panel', !explorerEl.classList.contains('collapsed'));
  }
}

function applySidebarWidth(width) {
  var w = Math.max(140, Math.min(400, width));
  sidebar.style.width = w + 'px';
  sidebar.style.setProperty('--sidebar-collapse-margin', '-' + w + 'px');
  sidebar.classList.toggle('compact', w < 180);
}

(function () {
  var handle = document.getElementById('sidebar-resize-handle');
  if (!handle) return;
  handle.addEventListener('mousedown', function (e) {
    e.preventDefault();
    handle.classList.add('active');
    var startX = e.clientX;
    var startWidth = sidebar.getBoundingClientRect().width;
    function onMouseMove(ev) {
      var delta = ev.clientX - startX;
      applySidebarWidth(startWidth + delta);
      refitAll();
    }
    function onMouseUp() {
      handle.classList.remove('active');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      config.sidebarWidth = sidebar.getBoundingClientRect().width;
      saveConfig();
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
})();

// ============================================================
// Explorer Panel
// ============================================================

var explorerPanel = document.getElementById('explorer-panel');
var explorerResizeHandle = document.getElementById('explorer-resize-handle');
var btnToggleExplorer = document.getElementById('btn-toggle-explorer');
var fileTreeEl = document.getElementById('file-tree');
var gitChangesEl = document.getElementById('git-changes');
var gitHeaderEl = document.getElementById('git-header');
var runConfigsEl = document.getElementById('run-configs');
var runListView = document.getElementById('run-list-view');
var runEditorView = document.getElementById('run-editor-view');
var runProfilesView = document.getElementById('run-profiles-view');
var runEditorForm = document.getElementById('run-editor-form');
var runEditorTitle = document.getElementById('run-editor-title');
var runProfilesList = document.getElementById('run-profiles-list');
var runProfileEditor = document.getElementById('run-profile-editor');
var runCachedData = null; // { configs, envProfiles }
var runEditingConfig = null; // config being edited, or null for new
var runEditingIndex = -1; // index in custom configs array, or -1 for new
var runEditingOriginalName = null; // original name at edit time, for matching on save
var runEditingOriginalType = null;

// Tab switching
document.querySelectorAll('.explorer-tab').forEach(function (tab) {
  tab.addEventListener('mousedown', function (e) { e.preventDefault(); }); // prevent focus steal
  tab.addEventListener('click', function () {
    var tabName = tab.dataset.tab;
    document.querySelectorAll('.explorer-tab').forEach(function (t) { t.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function (tc) { tc.classList.remove('active'); });
    tab.classList.add('active');
    document.getElementById('tab-' + tabName).classList.add('active');
    if (tabName === 'files') { stopGitPolling(); refreshFileTree(); }
    else if (tabName === 'git') { refreshGitStatus(true); startGitPolling(); }
    else if (tabName === 'run') { stopGitPolling(); showRunListView(); refreshRunConfigs(); }
    else if (tabName === 'automations') { stopGitPolling(); refreshAutomations(); }
    refocusActiveTerminal();
  });
});

// Prevent explorer panel and sidebar clicks from stealing terminal focus.
// Allow actual input/textarea/select elements to still receive focus.
[explorerPanel, sidebar, document.getElementById('toolbar')].forEach(function (panel) {
  if (!panel) return;
  panel.addEventListener('mousedown', function (e) {
    var tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // Allow drag on draggable elements (project reorder)
    var el = e.target;
    while (el && el !== panel) {
      if (el.getAttribute && el.getAttribute('draggable') === 'true') return;
      el = el.parentElement;
    }
    e.preventDefault();
  });
});

function toggleExplorer() {
  explorerPanel.classList.toggle('collapsed');
  explorerResizeHandle.classList.toggle('hidden');
  syncPanelToggleStates();
  setTimeout(refitAll, 200);
  if (isGitTabActive()) startGitPolling(); else stopGitPolling();
}

// Explorer resize handle
(function () {
  explorerResizeHandle.addEventListener('mousedown', function (e) {
    e.preventDefault();
    explorerResizeHandle.classList.add('active');
    var startX = e.clientX;
    var startWidth = explorerPanel.getBoundingClientRect().width;
    function onMouseMove(ev) {
      var delta = ev.clientX - startX;
      var newWidth = Math.max(150, Math.min(600, startWidth + delta));
      explorerPanel.style.width = newWidth + 'px';
      refitAll();
    }
    function onMouseUp() {
      explorerResizeHandle.classList.remove('active');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
})();

// ============================================================
// File Tree
// ============================================================

function showFileTreeContextMenu(e, entry) {
  var existing = document.querySelector('.file-tree-context-menu');
  if (existing) existing.remove();

  var menu = document.createElement('div');
  menu.className = 'file-tree-context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  var showInExplorer = document.createElement('div');
  showInExplorer.className = 'file-tree-context-item';
  showInExplorer.textContent = 'See in Explorer';
  showInExplorer.addEventListener('click', function () {
    window.electronAPI.showItemInFolder(entry.path);
    menu.remove();
  });
  menu.appendChild(showInExplorer);

  if (window.electronAPI && window.electronAPI.openInExternalEditor) {
    var openExt = document.createElement('div');
    openExt.className = 'file-tree-context-item';
    openExt.textContent = 'Open in external editor';
    openExt.addEventListener('click', function () {
      // Pass [project, file] so e.g. VS Code opens the project as a workspace
      // AND focuses the chosen file, instead of opening the file standalone.
      var args = entry.isDirectory ? [entry.path] : [activeProjectKey, entry.path];
      window.electronAPI.openInExternalEditor(args).then(function (r) {
        if (r && !r.ok && r.error) console.warn('[editor:openExternal]', r.error);
      });
      menu.remove();
    });
    menu.appendChild(openExt);
  }

  document.body.appendChild(menu);

  function closeMenu(ev) {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', closeMenu);
    }
  }
  setTimeout(function () {
    document.addEventListener('mousedown', closeMenu);
  }, 0);
}

function refreshFileTree() {
  if (!activeProjectKey || !window.electronAPI) return;
  // Clear search state on refresh
  fileSearchInput.value = '';
  fileSearchResults.style.display = 'none';
  fileTreeEl.style.display = '';
  while (fileTreeEl.firstChild) fileTreeEl.removeChild(fileTreeEl.firstChild);
  window.electronAPI.readDir(activeProjectKey).then(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      fileTreeEl.appendChild(createTreeItem(entries[i], 0));
    }
  });
}

// File search
var fileSearchInput = document.getElementById('file-search-input');
var fileSearchResults = document.getElementById('file-search-results');
var fileSearchTimer = null;

fileSearchInput.addEventListener('input', function () {
  clearTimeout(fileSearchTimer);
  var query = fileSearchInput.value.trim();
  if (!query) {
    fileSearchResults.style.display = 'none';
    fileTreeEl.style.display = '';
    return;
  }
  fileSearchTimer = setTimeout(function () {
    if (!activeProjectKey) return;
    window.electronAPI.searchFiles(activeProjectKey, query).then(function (results) {
      while (fileSearchResults.firstChild) fileSearchResults.removeChild(fileSearchResults.firstChild);
      fileTreeEl.style.display = 'none';
      fileSearchResults.style.display = '';
      if (results.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'search-no-results';
        empty.textContent = 'No files found';
        fileSearchResults.appendChild(empty);
        return;
      }
      for (var i = 0; i < results.length; i++) {
        (function (result) {
          var row = document.createElement('div');
          row.className = 'search-result-row';
          if (result.isDirectory) row.classList.add('search-result-folder');

          var nameEl = document.createElement('span');
          nameEl.className = 'search-result-name';
          nameEl.textContent = result.name;

          var pathEl = document.createElement('span');
          pathEl.className = 'search-result-path';
          pathEl.textContent = result.relativePath;

          row.appendChild(nameEl);
          row.appendChild(pathEl);

          row.addEventListener('click', function () {
            if (!result.isDirectory) {
              openFileEditor(result.path);
            }
          });

          row.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
            showFileTreeContextMenu(e, result);
          });

          fileSearchResults.appendChild(row);
        })(results[i]);
      }
    });
  }, 200);
});

fileSearchInput.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    fileSearchInput.value = '';
    fileSearchResults.style.display = 'none';
    fileTreeEl.style.display = '';
    fileSearchInput.blur();
  }
});

function createTreeItem(entry, level) {
  var item = document.createElement('div');
  item.className = 'tree-item';
  var row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = (8 + level * 16) + 'px';

  var arrow = document.createElement('span');
  arrow.className = 'tree-arrow';
  arrow.textContent = entry.isDirectory ? '\u25B8' : '';

  var name = document.createElement('span');
  name.className = 'tree-name';
  if (entry.isDirectory) name.classList.add('tree-folder');
  name.textContent = entry.name;

  row.appendChild(arrow);
  row.appendChild(name);
  item.appendChild(row);

  row.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    showFileTreeContextMenu(e, entry);
  });

  // Drag from Explorer into a terminal — drop pastes the file path. Picks up
  // a quoted form when the path contains spaces. Disabled for directories
  // since the common use case is `cmd /path/to/file`.
  if (!entry.isDirectory) {
    row.setAttribute('draggable', 'true');
    row.addEventListener('dragstart', function (e) {
      e.dataTransfer.effectAllowed = 'copy';
      var p = entry.path;
      var quoted = /\s/.test(p) ? '"' + p + '"' : p;
      e.dataTransfer.setData('text/plain', quoted);
      e.dataTransfer.setData('application/x-claudes-file', p);
    });
  }

  if (entry.isDirectory) {
    var children = document.createElement('div');
    children.className = 'tree-children';
    children.style.display = 'none';
    item.appendChild(children);

    var loaded = false;
    row.addEventListener('click', function () {
      var isExpanded = children.style.display !== 'none';
      if (isExpanded) {
        children.style.display = 'none';
        arrow.textContent = '\u25B8';
      } else {
        if (!loaded) {
          loaded = true;
          window.electronAPI.readDir(entry.path).then(function (childEntries) {
            for (var j = 0; j < childEntries.length; j++) {
              children.appendChild(createTreeItem(childEntries[j], level + 1));
            }
          });
        }
        children.style.display = 'block';
        arrow.textContent = '\u25BE';
      }
    });
  } else {
    row.addEventListener('click', function () {
      openFileEditor(entry.path);
    });
    row.classList.add('tree-file-row');
  }

  return item;
}

// ============================================================
// Git Status
// ============================================================

var gitCommitMsg = document.getElementById('git-commit-msg');
var gitStatusMsgEl = document.getElementById('git-status-msg');
var gitAmendCheckbox = document.getElementById('git-amend-checkbox');
var gitPollTimer = null;
var lastGitRaw = null;
var graphLaneState = null;
var gitPollInFlight = false;

function gitTargetCwd() {
  return window.GitTarget.getGitTargetCwd(getActiveState(), allColumns, activeProjectKey);
}

var projectRootBranchCache = new Map();

function invalidateProjectRootBranch(projectKey) {
  if (projectKey) projectRootBranchCache.delete(projectKey);
}

function autoBindColumnTarget(colId) {
  var col = allColumns.get(colId);
  if (!col || !col.sessionId || !col.projectKey) return Promise.resolve();
  // Skip auto-bind only when the user explicitly bound this column's cwd via
  // the spawn modal (Phase 1 manual). Phase 3 'auto-worktree' bindings remain
  // eligible for re-detection so a session that switches worktrees gets retracked.
  if (col.cwdSource === 'manual') return Promise.resolve();

  // Phase 3: try worktree detection from JSONL evidence first. When found,
  // pin col.cwd to the worktree path so the Git tab targets it directly with
  // full read+write functionality (the worktree HAS that branch checked out).
  return window.electronAPI.gitDetectSessionWorktree(col.projectKey, col.sessionId).then(function (worktree) {
    if (worktree && worktree.path) {
      var newCwd = worktree.path;
      var changed = false;
      if (col.cwd !== newCwd) { col.cwd = newCwd; changed = true; }
      if (col.cwdSource !== 'auto-worktree') { col.cwdSource = 'auto-worktree'; changed = true; }
      if (changed) persistSessions(col.projectKey, col.workspaceId);
      return;
    }

    // No dominant worktree detected. If a previous run pinned this column to
    // an auto-worktree but evidence is now gone, release back to project root
    // so we don't stay stuck.
    if (col.cwdSource === 'auto-worktree') {
      col.cwd = col.projectKey;
      col.cwdSource = undefined;
      persistSessions(col.projectKey, col.workspaceId);
    }
  }).catch(function () { /* best-effort */ });
}

function normalizePathForCompare(p) {
  if (!p) return '';
  var s = String(p).replace(/\\/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (/^[A-Za-z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}

var pathExistsCache = new Map();
async function isTargetPresent(p) {
  var now = Date.now();
  var hit = pathExistsCache.get(p);
  if (hit && hit.expiresAt > now) return hit.result;
  var result = await window.electronAPI.pathExists(p);
  pathExistsCache.set(p, { result: result, expiresAt: now + 30000 });
  return result;
}

function invalidatePathExists(p) {
  if (p) pathExistsCache.delete(p);
}

var lastGitTargetHint = { text: '', title: '' };

function updateGitTargetIndicator(opts) {
  opts = opts || {};
  if (!gitHeaderEl) return;
  var target = gitTargetCwd();
  var targetNorm = normalizePathForCompare(target);
  var rootNorm = normalizePathForCompare(activeProjectKey);

  var labelText = '';
  var titleText = target || '';

  if (target && targetNorm !== rootNorm) {
    // Phase 1: explicit non-root cwd (worktree column).
    if (rootNorm && targetNorm.indexOf(rootNorm + '/') === 0) {
      labelText = '→ ./' + targetNorm.slice(rootNorm.length + 1);
    } else {
      labelText = '→ ' + target;
    }
  }

  var suffix = '';
  if (opts.directoryMissing) {
    suffix = ' · directory missing';
  } else if (opts.notARepo) {
    suffix = ' · not a git repo';
  }

  var existing = gitHeaderEl.querySelector('.git-target-hint');

  if (!labelText && !suffix) {
    if (existing) existing.remove();
    lastGitTargetHint = { text: '', title: '' };
    return;
  }

  var fullText = (labelText || (target ? '→ ' + target : '')) + suffix;

  if (existing && existing.textContent === fullText && existing.getAttribute('title') === titleText) {
    lastGitTargetHint = { text: fullText, title: titleText };
    return;
  }

  if (existing) existing.remove();

  var hint = document.createElement('div');
  hint.className = 'git-target-hint';
  hint.textContent = fullText;
  if (titleText) hint.setAttribute('title', titleText);
  gitHeaderEl.appendChild(hint);
  lastGitTargetHint = { text: fullText, title: titleText };
}

function refreshGitStatus(force) {
  if (!activeProjectKey || !window.electronAPI) return;
  // Skip background polls if a previous batch is still running — prevents
  // backed-up git calls piling up on the main thread when the repo or disk is slow.
  if (gitPollInFlight && !force) return;

  // Fire-and-forget autoBind on the focused column so cwd/worktree following
  // stays current.
  var fState = getActiveState();
  var focusedId = fState ? fState.focusedColumnId : null;
  if (focusedId != null) {
    autoBindColumnTarget(focusedId);
  }

  var target = gitTargetCwd();

  gitPollInFlight = true;
  var done = function () { gitPollInFlight = false; };

  isTargetPresent(target).then(function (present) {
    if (!present) {
      lastGitRaw = null;
      while (gitHeaderEl.firstChild) gitHeaderEl.removeChild(gitHeaderEl.firstChild);
      while (gitChangesEl.firstChild) gitChangesEl.removeChild(gitChangesEl.firstChild);
      updateGitTargetIndicator({ directoryMissing: true });
      done();
      return;
    }

    var fetchAll = [
      window.electronAPI.gitStatus(target),
      window.electronAPI.gitBranch(target),
      window.electronAPI.gitAheadBehind(target),
      window.electronAPI.gitStashList(target),
      window.electronAPI.gitGraphLog(target, 50),
      window.electronAPI.gitDiffStat(target, false),
      window.electronAPI.gitDiffStat(target, true),
      window.electronAPI.gitIsInsideWorkTree(target),
      Promise.resolve(null)
    ];

    if (!force) {
      Promise.all(fetchAll).then(function (results) {
        var rawKey = JSON.stringify(results[0]) + '|' + results[1] + '|' + JSON.stringify(results[2]) + '|' + results[3].length + '|' + JSON.stringify(results[4]) + '|' + results[7] + '|' + JSON.stringify(results[8]);
        if (rawKey === lastGitRaw) return;
        lastGitRaw = rawKey;
        renderGitStatus(results[0], results[1], results[2], results[3], results[4], results[5], results[6], results[8]);
        updateGitTargetIndicator({ notARepo: !results[7] });
      }).then(done, done);
      return;
    }

    lastGitRaw = null;
    Promise.all(fetchAll).then(function (results) {
      lastGitRaw = JSON.stringify(results[0]) + '|' + results[1] + '|' + JSON.stringify(results[2]) + '|' + results[3].length + '|' + JSON.stringify(results[4]) + '|' + results[7] + '|' + JSON.stringify(results[8]);
      renderGitStatus(results[0], results[1], results[2], results[3], results[4], results[5], results[6], results[8]);
      updateGitTargetIndicator({ notARepo: !results[7] });
    }).then(done, done);
  }, done);
}

function showGitFileContextMenu(e, filePath) {
  var existing = document.querySelector('.git-file-ctx-menu');
  if (existing) existing.remove();
  var menu = document.createElement('div');
  menu.className = 'project-context-menu git-file-ctx-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  function add(label, fn) {
    var it = document.createElement('div');
    it.className = 'project-context-item';
    it.textContent = label;
    it.addEventListener('click', function () { menu.remove(); fn(); });
    menu.appendChild(it);
  }
  // filePath here is repo-relative — resolve against the active project root
  // for editor / shell IPCs that expect absolute paths.
  function absolutePath() {
    if (!activeProjectKey) return null;
    return activeProjectKey.replace(/[\\/]$/, '') + '/' + filePath;
  }
  add('Open in external editor', function () {
    var abs = absolutePath();
    if (!abs || !window.electronAPI || !window.electronAPI.openInExternalEditor) return;
    window.electronAPI.openInExternalEditor([activeProjectKey, abs]).then(function (r) {
      if (r && !r.ok && r.error) showToast('Open in editor failed: ' + r.error, { kind: 'error' });
    });
  });
  add('File history…', function () { showFileHistory(filePath); });
  add('Blame…', function () { showFileBlame(filePath); });
  document.body.appendChild(menu);
  setTimeout(function () {
    function out(ev) {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', out, true); }
    }
    document.addEventListener('mousedown', out, true);
  }, 0);
}

// Lightweight modal-less floating panels for blame / file history. They reuse
// the existing modal-overlay styling so layout is consistent with the rest
// of the app.
function showFileHistory(filePath) {
  var existing = document.querySelector('.git-history-overlay');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay git-history-overlay';
  overlay.innerHTML = '<div class="modal-dialog"><div class="modal-header"><span class="modal-title">File history</span><span class="modal-subtitle">' + escapeHtml(filePath) + '</span><span class="modal-close">&times;</span></div><div class="modal-body"><div class="git-history-list" style="max-height:60vh;overflow:auto;"></div></div></div>';
  document.body.appendChild(overlay);
  function close() { overlay.remove(); }
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  var listEl = overlay.querySelector('.git-history-list');
  listEl.textContent = 'Loading…';
  window.electronAPI.gitFileHistory(activeProjectKey, filePath, 100).then(function (rows) {
    listEl.innerHTML = '';
    if (!rows.length) { listEl.textContent = 'No history.'; return; }
    rows.forEach(function (r) {
      var item = document.createElement('div');
      item.className = 'git-history-item';
      item.style.cssText = 'padding:6px 8px;border-bottom:1px solid var(--border-primary);cursor:pointer;';
      item.innerHTML = '<div style="font-family:monospace;font-size:11px;color:#9ca3af;">' + escapeHtml(r.hash) + '  •  ' + escapeHtml(r.author) + '  •  ' + escapeHtml(new Date(r.date).toLocaleString()) + '</div>' +
        '<div style="font-size:13px;margin-top:2px;">' + escapeHtml(r.message) + '</div>' +
        '<div class="git-history-cp" style="margin-top:4px;"><button class="git-op-mini-btn">Cherry-pick onto current</button></div>';
      var cpBtn = item.querySelector('.git-op-mini-btn');
      cpBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!confirm('Cherry-pick ' + r.hash + ' onto current branch?')) return;
        window.electronAPI.gitCherryPick(activeProjectKey, r.hash).then(function (rr) {
          if (!rr.success) alert('Cherry-pick failed: ' + rr.error);
          refreshGitStatus(true);
        });
      });
      listEl.appendChild(item);
    });
  });
}

function showFileBlame(filePath) {
  var existing = document.querySelector('.git-blame-overlay');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay git-blame-overlay';
  overlay.innerHTML = '<div class="modal-dialog" style="max-width:90vw;width:90vw;"><div class="modal-header"><span class="modal-title">Blame</span><span class="modal-subtitle">' + escapeHtml(filePath) + '</span><span class="modal-close">&times;</span></div><div class="modal-body"><pre class="git-blame-pre" style="max-height:70vh;overflow:auto;font-size:12px;line-height:1.4;margin:0;"></pre></div></div>';
  document.body.appendChild(overlay);
  function close() { overlay.remove(); }
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  var pre = overlay.querySelector('.git-blame-pre');
  pre.textContent = 'Loading blame…';
  window.electronAPI.gitBlame(activeProjectKey, filePath).then(function (rows) {
    if (!rows.length) { pre.textContent = 'No blame data.'; return; }
    pre.innerHTML = '';
    rows.forEach(function (r, i) {
      var line = document.createElement('div');
      var meta = '<span style="color:#9ca3af;display:inline-block;width:80px;">' + escapeHtml(r.hash) + '</span>' +
                 '<span style="color:#6b7280;display:inline-block;width:120px;">' + escapeHtml((r.author || '').slice(0, 16)) + '</span>' +
                 '<span style="color:#52525b;display:inline-block;width:50px;">' + (i + 1) + '</span>';
      line.innerHTML = meta + '<span style="white-space:pre;">' + escapeHtml(r.content || '') + '</span>';
      pre.appendChild(line);
    });
  });
}

function renderGitOpBanner() {
  if (!window.electronAPI || !window.electronAPI.gitOpState) return;
  window.electronAPI.gitOpState(activeProjectKey).then(function (s) {
    if (!s || (!s.merging && !s.rebasing && !s.cherryPicking)) return;
    var op = s.merging ? 'merge' : s.rebasing ? 'rebase' : 'cherry-pick';
    var banner = document.createElement('div');
    banner.className = 'git-op-banner';
    var hdr = document.createElement('div');
    hdr.className = 'git-op-banner-header';
    hdr.textContent = 'In progress: ' + op + (s.conflictFiles.length ? '  •  ' + s.conflictFiles.length + ' conflict(s)' : '');
    banner.appendChild(hdr);
    s.conflictFiles.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'git-op-conflict-row';
      var name = document.createElement('span');
      name.textContent = f;
      name.style.flex = '1';
      var ours = document.createElement('button');
      ours.className = 'git-op-mini-btn';
      ours.textContent = 'use ours';
      ours.addEventListener('click', function () {
        window.electronAPI.gitResolveOurs(activeProjectKey, f).then(function (r) {
          if (!r.success) alert('Resolve failed: ' + r.error);
          refreshGitStatus(true);
        });
      });
      var theirs = document.createElement('button');
      theirs.className = 'git-op-mini-btn';
      theirs.textContent = 'use theirs';
      theirs.addEventListener('click', function () {
        window.electronAPI.gitResolveTheirs(activeProjectKey, f).then(function (r) {
          if (!r.success) alert('Resolve failed: ' + r.error);
          refreshGitStatus(true);
        });
      });
      var openIt = document.createElement('button');
      openIt.className = 'git-op-mini-btn';
      openIt.textContent = 'open';
      openIt.addEventListener('click', function () {
        var full = activeProjectKey.replace(/[\\/]$/, '') + '/' + f;
        openFileEditor(full);
      });
      row.appendChild(name); row.appendChild(ours); row.appendChild(theirs); row.appendChild(openIt);
      banner.appendChild(row);
    });
    var actions = document.createElement('div');
    actions.className = 'git-op-banner-actions';
    var continueBtn = document.createElement('button');
    continueBtn.className = 'git-op-mini-btn primary';
    continueBtn.textContent = s.conflictFiles.length === 0 ? 'Continue' : 'Continue (when staged)';
    continueBtn.addEventListener('click', function () {
      var p = s.rebasing
        ? window.electronAPI.gitRebaseContinue(activeProjectKey)
        : window.electronAPI.gitMergeContinue(activeProjectKey);
      p.then(function (r) {
        if (!r.success) alert('Continue failed: ' + r.error);
        refreshGitStatus(true);
      });
    });
    var abortBtn = document.createElement('button');
    abortBtn.className = 'git-op-mini-btn';
    abortBtn.textContent = 'Abort';
    abortBtn.addEventListener('click', function () {
      if (!confirm('Abort the in-progress ' + op + '?')) return;
      var p = s.rebasing
        ? window.electronAPI.gitRebaseAbort(activeProjectKey)
        : window.electronAPI.gitMergeAbort(activeProjectKey);
      p.then(function (r) {
        if (!r.success) alert('Abort failed: ' + r.error);
        refreshGitStatus(true);
      });
    });
    actions.appendChild(continueBtn);
    actions.appendChild(abortBtn);
    banner.appendChild(actions);
    gitChangesEl.insertBefore(banner, gitChangesEl.firstChild);
  });
}

function updateActiveProjectBranchLabels(branch) {
  if (!activeProjectKey) return;
  var project = config.projects.find(function (p) { return p.path === activeProjectKey; });
  if (!project) return;
  var trimmed = (branch || '').trim();

  if (activeProjectNameEl) {
    activeProjectNameEl.textContent = trimmed
      ? project.name + '  ⎇ ' + trimmed
      : project.name;
  }

  var item = document.querySelector('.project-item[data-project-path="' + CSS.escape(activeProjectKey) + '"]');
  if (item) {
    var tag = item.querySelector('.project-branch');
    if (tag) tag.textContent = trimmed ? '⎇ ' + trimmed : '';
  }
}

function renderGitStatus(files, branch, aheadBehind, stashes, graphLog, unstagedStats, stagedStats, diffVsBase) {
  graphLaneState = null;
  updateActiveProjectBranchLabels(branch);
  while (gitHeaderEl.firstChild) gitHeaderEl.removeChild(gitHeaderEl.firstChild);
  while (gitChangesEl.firstChild) gitChangesEl.removeChild(gitChangesEl.firstChild);
  // Conflict / mid-operation banner. Fired async; the banner is inserted at
  // the top of gitChangesEl when state shows merging/rebasing/cherry-picking.
  renderGitOpBanner();

  gitHeaderEl.classList.remove('git-readonly');

  // Branch row (clickable branch switcher + pull/push/stash buttons)
  var row = document.createElement('div');
  row.className = 'git-branch-row';
  row.style.position = 'relative';

  var branchLabel = document.createElement('span');
  branchLabel.className = 'git-branch-name git-branch-clickable';
  branchLabel.textContent = '\u2387 ' + (branch || 'detached') + ' \u25BE';
  branchLabel.title = 'Switch branch';
  branchLabel.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleBranchDropdown(row, branch);
  });
  row.appendChild(branchLabel);

  var actions = document.createElement('span');
  actions.className = 'git-branch-actions';

  // Stash button
  var stashBtn = document.createElement('button');
  stashBtn.className = 'git-action-btn';
  stashBtn.textContent = '\u2691 Stash';
  stashBtn.title = 'Stash changes';
  stashBtn.addEventListener('click', function () { gitStashPush(); });
  actions.appendChild(stashBtn);

  // Pop button with badge
  var popBtn = document.createElement('button');
  popBtn.className = 'git-action-btn';
  popBtn.title = 'Pop stash';
  popBtn.textContent = '\u2691 Pop';
  if (stashes.length > 0) {
    var badge = document.createElement('span');
    badge.className = 'git-badge';
    badge.textContent = stashes.length;
    popBtn.appendChild(badge);
  } else {
    popBtn.disabled = true;
    popBtn.style.opacity = '0.4';
  }
  popBtn.addEventListener('click', function () { gitStashPop(); });
  actions.appendChild(popBtn);

  // Pull button with behind count
  var pullBtn = document.createElement('button');
  pullBtn.className = 'git-action-btn';
  pullBtn.title = 'Pull';
  pullBtn.textContent = '\u2193 Pull';
  if (aheadBehind.behind > 0) {
    var pullBadge = document.createElement('span');
    pullBadge.className = 'git-badge';
    pullBadge.textContent = aheadBehind.behind;
    pullBtn.appendChild(pullBadge);
  }
  pullBtn.addEventListener('click', function () { gitPull(); });
  actions.appendChild(pullBtn);

  // Push button with ahead count
  var pushBtn = document.createElement('button');
  pushBtn.className = 'git-action-btn';
  pushBtn.title = 'Push';
  pushBtn.textContent = '\u2191 Push';
  if (aheadBehind.ahead > 0) {
    var pushBadge = document.createElement('span');
    pushBadge.className = 'git-badge';
    pushBadge.textContent = aheadBehind.ahead;
    pushBtn.appendChild(pushBadge);
  }
  pushBtn.addEventListener('click', function () { gitPush(); });
  actions.appendChild(pushBtn);

  row.appendChild(actions);
  gitHeaderEl.appendChild(row);

  // Parse status into staged vs unstaged
  var staged = [];
  var changes = [];

  for (var i = 0; i < files.length; i++) {
    var x = files[i].status.charAt(0);
    var y = files[i].status.charAt(1);
    var file = files[i].file;

    if (x !== ' ' && x !== '?') {
      staged.push({ status: x, file: file });
    }
    if (x === '?') {
      changes.push({ status: '?', file: file, untracked: true });
    } else if (y !== ' ') {
      changes.push({ status: y, file: file, untracked: false });
    }
  }

  if (staged.length === 0 && changes.length === 0 && graphLog.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'git-empty';
    empty.textContent = 'No changes';
    gitChangesEl.appendChild(empty);
    return;
  }

  if (staged.length > 0) {
    gitChangesEl.appendChild(createGitSection('Staged Changes', staged, true, stagedStats));
  }
  if (changes.length > 0) {
    gitChangesEl.appendChild(createGitSection('Changes', changes, false, unstagedStats));
  }

  // Commit graph section
  if (graphLog.length > 0) {
    gitChangesEl.appendChild(createGitGraphSection(graphLog));
  }
}

// Branch dropdown
function toggleBranchDropdown(parentRow, currentBranch) {
  var existing = parentRow.querySelector('.git-branch-dropdown');
  if (existing) { existing.remove(); return; }

  var dropdown = document.createElement('div');
  dropdown.className = 'git-branch-dropdown';

  // New branch option
  var newOpt = document.createElement('div');
  newOpt.className = 'git-branch-dropdown-item git-branch-new-option';
  newOpt.textContent = '+ New Branch...';
  newOpt.addEventListener('click', function (e) {
    e.stopPropagation();
    showBranchCreateInput(dropdown, currentBranch);
  });
  dropdown.appendChild(newOpt);

  window.electronAPI.gitBranches(gitTargetCwd()).then(function (branches) {
    for (var i = 0; i < branches.length; i++) {
      (function (b) {
        var item = document.createElement('div');
        item.className = 'git-branch-dropdown-item' + (b.isCurrent ? ' current' : '');
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '4px';
        var label = document.createElement('span');
        label.style.flex = '1';
        label.textContent = (b.isCurrent ? '\u2713 ' : '  ') + b.name;
        item.appendChild(label);
        if (!b.isCurrent) {
          label.style.cursor = 'pointer';
          label.addEventListener('click', function (e) {
            e.stopPropagation();
            dropdown.remove();
            gitCheckout(b.name);
          });
          // Quick merge / rebase actions per branch \u2014 operate on the current
          // branch, integrating the row's branch.
          var mergeBtn = document.createElement('button');
          mergeBtn.className = 'git-branch-mini-action';
          mergeBtn.textContent = 'merge';
          mergeBtn.title = 'Merge ' + b.name + ' into current branch';
          mergeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            dropdown.remove();
            if (!confirm('Merge "' + b.name + '" into current branch?')) return;
            window.electronAPI.gitMerge(activeProjectKey, b.name).then(function (r) {
              if (!r.success) alert('Merge failed: ' + r.error);
              refreshGit();
            });
          });
          var rebaseBtn = document.createElement('button');
          rebaseBtn.className = 'git-branch-mini-action';
          rebaseBtn.textContent = 'rebase';
          rebaseBtn.title = 'Rebase current branch onto ' + b.name;
          rebaseBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            dropdown.remove();
            if (!confirm('Rebase current branch onto "' + b.name + '"?')) return;
            window.electronAPI.gitRebase(activeProjectKey, b.name).then(function (r) {
              if (!r.success) alert('Rebase failed: ' + r.error);
              refreshGit();
            });
          });
          item.appendChild(mergeBtn);
          item.appendChild(rebaseBtn);
        }
        dropdown.appendChild(item);
      })(branches[i]);
    }
  });

  parentRow.appendChild(dropdown);

  // Close on outside click
  var closeHandler = function (e) {
    if (!dropdown.contains(e.target) && e.target !== parentRow.querySelector('.git-branch-name')) {
      dropdown.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(function () { document.addEventListener('click', closeHandler); }, 0);
}

function showBranchCreateInput(dropdown, currentBranch) {
  // Replace dropdown content with input
  while (dropdown.firstChild) dropdown.removeChild(dropdown.firstChild);
  var createRow = document.createElement('div');
  createRow.className = 'git-branch-create-row';
  var input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Branch name...';
  var createBtn = document.createElement('button');
  createBtn.textContent = 'Create';
  createBtn.addEventListener('click', function () {
    var name = input.value.trim();
    if (name) { dropdown.remove(); gitCreateBranch(name); }
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { createBtn.click(); }
    if (e.key === 'Escape') { dropdown.remove(); }
  });
  createRow.appendChild(input);
  createRow.appendChild(createBtn);
  dropdown.appendChild(createRow);
  input.focus();
}

var GRAPH_LANE_COLORS = ['var(--accent)', 'var(--color-green)', 'var(--color-cyan)', 'var(--accent)', 'var(--color-green)'];
var GRAPH_ROW_HEIGHT = 28;
var GRAPH_LANE_WIDTH = 10;
var GRAPH_PADDING = 8;

function computeGraphLanes(commits, existingState) {
  var lanes = existingState ? existingState.lanes.slice() : [];
  var commitLanes = existingState ? JSON.parse(JSON.stringify(existingState.commitLanes)) : {};

  function findFreeLane() {
    for (var i = 0; i < lanes.length; i++) {
      if (lanes[i] === null) return i;
    }
    lanes.push(null);
    return lanes.length - 1;
  }

  for (var c = 0; c < commits.length; c++) {
    var commit = commits[c];
    var myLane;
    commit.mergeFromLanes = [];

    if (commitLanes[commit.hash] !== undefined) {
      myLane = commitLanes[commit.hash];
    } else {
      myLane = findFreeLane();
      lanes[myLane] = commit.hash;
    }
    commit.lane = myLane;
    commit.activeLanes = lanes.slice();

    if (commit.parents.length === 0) {
      lanes[myLane] = null;
    } else if (commit.parents.length === 1) {
      lanes[myLane] = commit.parents[0];
      commitLanes[commit.parents[0]] = myLane;
    } else {
      lanes[myLane] = commit.parents[0];
      commitLanes[commit.parents[0]] = myLane;
      for (var p = 1; p < commit.parents.length; p++) {
        var parent = commit.parents[p];
        if (commitLanes[parent] !== undefined) {
          commit.mergeFromLanes.push(commitLanes[parent]);
        } else {
          var parentLane = findFreeLane();
          lanes[parentLane] = parent;
          commitLanes[parent] = parentLane;
          commit.mergeFromLanes.push(parentLane);
        }
      }
    }

    while (lanes.length > 5) {
      var last = lanes.length - 1;
      if (lanes[last] !== null) {
        if (commit.lane === last) commit.lane = 4;
        commitLanes[lanes[last]] = 4;
        lanes[4] = lanes[last];
      }
      lanes.pop();
    }
  }

  return { commits: commits, lanes: lanes, commitLanes: commitLanes };
}

function renderGraphSvg(commit) {
  var maxLanes = 0;
  for (var a = 0; a < commit.activeLanes.length; a++) {
    if (commit.activeLanes[a] !== null) maxLanes = a + 1;
  }
  maxLanes = Math.max(maxLanes, commit.lane + 1);
  var svgWidth = GRAPH_PADDING + maxLanes * GRAPH_LANE_WIDTH + GRAPH_PADDING;

  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', svgWidth);
  svg.setAttribute('height', GRAPH_ROW_HEIGHT);
  svg.style.flexShrink = '0';

  var cy = GRAPH_ROW_HEIGHT / 2;

  for (var i = 0; i < commit.activeLanes.length; i++) {
    if (commit.activeLanes[i] === null) continue;
    var lx = GRAPH_PADDING + i * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2;
    var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', lx);
    line.setAttribute('y1', 0);
    line.setAttribute('x2', lx);
    line.setAttribute('y2', GRAPH_ROW_HEIGHT);
    line.setAttribute('stroke', GRAPH_LANE_COLORS[i % GRAPH_LANE_COLORS.length]);
    line.setAttribute('stroke-width', '2');
    svg.appendChild(line);
  }

  for (var m = 0; m < commit.mergeFromLanes.length; m++) {
    var fromLane = commit.mergeFromLanes[m];
    var fromX = GRAPH_PADDING + fromLane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2;
    var toX = GRAPH_PADDING + commit.lane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2;
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M' + fromX + ' 0 C ' + fromX + ' ' + cy + ' ' + toX + ' ' + cy + ' ' + toX + ' ' + cy);
    path.setAttribute('stroke', GRAPH_LANE_COLORS[fromLane % GRAPH_LANE_COLORS.length]);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
  }

  var cx = GRAPH_PADDING + commit.lane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2;
  var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', cx);
  circle.setAttribute('cy', cy);
  circle.setAttribute('r', '3');
  circle.setAttribute('fill', GRAPH_LANE_COLORS[commit.lane % GRAPH_LANE_COLORS.length]);
  svg.appendChild(circle);

  return svg;
}

// Turn git's verbose "4 hours ago" into a tight "4h" so the date column
// stays narrow and the subject can breathe in a sidebar-width panel.
function compactRelativeDate(rel) {
  if (!rel || typeof rel !== 'string') return rel || '';
  var s = rel.trim().toLowerCase();
  if (s === 'just now' || s.indexOf('seconds') !== -1 || s.indexOf('second ') !== -1) return 'now';
  var m = s.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s*ago$/);
  if (!m) return rel;
  var unit = m[2][0];
  if (m[2] === 'month') unit = 'mo';
  return m[1] + unit;
}

function createGitGraphSection(graphLog) {
  var state = computeGraphLanes(graphLog, graphLaneState);
  graphLaneState = { lanes: state.lanes, commitLanes: state.commitLanes };

  var section = document.createElement('div');
  section.className = 'git-section git-graph-section';

  var header = document.createElement('div');
  header.className = 'git-section-header';
  var arrow = document.createElement('span');
  arrow.className = 'git-section-arrow';
  arrow.textContent = '\u25BE';
  var label = document.createElement('span');
  label.className = 'git-section-label';
  label.textContent = 'Commits (' + graphLog.length + ')';
  header.appendChild(arrow);
  header.appendChild(label);
  section.appendChild(header);

  var list = document.createElement('div');
  list.className = 'git-section-list git-graph-list';

  for (var i = 0; i < state.commits.length; i++) {
    (function (commit) {
      var row = document.createElement('div');
      row.className = 'git-graph-row';
      // Full info on hover (truncated subject + author + full date).
      row.title = commit.message + '\n\n' + commit.author + ' \u00b7 ' + commit.relativeDate;
      row.addEventListener('click', function () {
        addDiffColumn({
          commitHash: commit.hash,
          filePath: null
        }, { title: commit.abbrev + ' \u2014 ' + commit.message });
      });

      var svg = renderGraphSvg(commit);
      row.appendChild(svg);

      var hashEl = document.createElement('span');
      hashEl.className = 'git-graph-hash';
      hashEl.textContent = commit.abbrev.slice(0, 7);

      // Inline ref chips render before the subject so they don't get pushed
      // off-screen when the row is narrow.
      var msgEl = document.createElement('span');
      msgEl.className = 'git-graph-msg';
      for (var r = 0; r < commit.refs.length; r++) {
        var ref = commit.refs[r];
        var badge = document.createElement('span');
        badge.className = 'git-graph-ref' + (ref.startsWith('tag:') ? ' git-graph-tag' : '');
        badge.textContent = ref.replace(/^HEAD -> /, '').replace(/^tag: /, '');
        msgEl.appendChild(badge);
      }
      var subjectEl = document.createElement('span');
      subjectEl.className = 'git-graph-subject';
      subjectEl.textContent = commit.message;
      msgEl.appendChild(subjectEl);

      var dateEl = document.createElement('span');
      dateEl.className = 'git-graph-date';
      dateEl.textContent = compactRelativeDate(commit.relativeDate);

      row.appendChild(hashEl);
      row.appendChild(msgEl);
      row.appendChild(dateEl);
      list.appendChild(row);
    })(state.commits[i]);
  }

  section.appendChild(list);

  header.addEventListener('click', function () {
    var collapsed = list.style.display === 'none';
    list.style.display = collapsed ? '' : 'none';
    arrow.textContent = collapsed ? '\u25BE' : '\u25B8';
  });

  return section;
}

function startGitPolling() {
  stopGitPolling();
  gitPollTimer = setInterval(function () { refreshGitStatus(); }, 3000);
}

function stopGitPolling() {
  if (gitPollTimer) { clearInterval(gitPollTimer); gitPollTimer = null; }
}

function isGitTabActive() {
  var activeTab = document.querySelector('.explorer-tab.active');
  return activeTab && activeTab.dataset.tab === 'git' &&
    !explorerPanel.classList.contains('collapsed');
}

function buildFileTree(files) {
  var root = { folders: {}, files: [] };
  for (var i = 0; i < files.length; i++) {
    var parts = files[i].file.replace(/\\/g, '/').split('/');
    var node = root;
    for (var p = 0; p < parts.length - 1; p++) {
      if (!node.folders[parts[p]]) node.folders[parts[p]] = { folders: {}, files: [] };
      node = node.folders[parts[p]];
    }
    node.files.push(files[i]);
  }
  return root;
}

function countTreeFiles(node) {
  var count = node.files.length;
  for (var k in node.folders) count += countTreeFiles(node.folders[k]);
  return count;
}

function createGitSection(title, files, isStaged, stats, opts) {
  opts = opts || {};
  var readOnly = !!opts.readOnly;
  var section = document.createElement('div');
  section.className = 'git-section';

  var header = document.createElement('div');
  header.className = 'git-section-header';

  var arrow = document.createElement('span');
  arrow.className = 'git-section-arrow';
  arrow.textContent = '\u25BE';

  var label = document.createElement('span');
  label.className = 'git-section-label';
  label.textContent = title + ' (' + files.length + ')';

  var actions = document.createElement('span');
  actions.className = 'git-section-actions';

  if (!readOnly) {
    if (isStaged) {
      var unstageAllBtn = document.createElement('button');
      unstageAllBtn.className = 'git-file-action';
      unstageAllBtn.textContent = '\u2212';
      unstageAllBtn.title = 'Unstage All';
      unstageAllBtn.addEventListener('click', function (e) { e.stopPropagation(); gitUnstageAll(); });
      actions.appendChild(unstageAllBtn);
    } else {
      var stageAllBtn = document.createElement('button');
      stageAllBtn.className = 'git-file-action';
      stageAllBtn.textContent = '+';
      stageAllBtn.title = 'Stage All';
      stageAllBtn.addEventListener('click', function (e) { e.stopPropagation(); gitStageAll(); });
      actions.appendChild(stageAllBtn);
    }
  }

  header.appendChild(arrow);
  header.appendChild(label);
  header.appendChild(actions);
  section.appendChild(header);

  var list = document.createElement('div');
  list.className = 'git-section-list';

  var statsMap = {};
  if (stats) {
    for (var s = 0; s < stats.length; s++) {
      statsMap[stats[s].file] = stats[s];
    }
  }
  var tree = buildFileTree(files);
  renderFileTreeNode(list, tree, isStaged, statsMap, 0, readOnly);

  section.appendChild(list);

  header.addEventListener('click', function () {
    var collapsed = list.style.display === 'none';
    list.style.display = collapsed ? 'block' : 'none';
    arrow.textContent = collapsed ? '\u25BE' : '\u25B8';
  });

  return section;
}

function renderFileTreeNode(container, node, isStaged, statsMap, depth, readOnly) {
  var folderNames = Object.keys(node.folders).sort();
  for (var f = 0; f < folderNames.length; f++) {
    (function (folderName) {
      var folder = node.folders[folderName];
      var folderEl = document.createElement('div');
      folderEl.className = 'git-tree-folder';

      var folderHeader = document.createElement('div');
      folderHeader.className = 'git-tree-folder-header';
      folderHeader.style.paddingLeft = (8 + depth * 12) + 'px';

      var folderArrow = document.createElement('span');
      folderArrow.className = 'git-tree-arrow';
      folderArrow.textContent = '\u25BE';

      var folderLabel = document.createElement('span');
      folderLabel.className = 'git-tree-folder-name';
      folderLabel.textContent = folderName + '/';

      var folderCount = document.createElement('span');
      folderCount.className = 'git-tree-count';
      folderCount.textContent = countTreeFiles(folder);

      folderHeader.appendChild(folderArrow);
      folderHeader.appendChild(folderLabel);
      folderHeader.appendChild(folderCount);
      folderEl.appendChild(folderHeader);

      var folderContent = document.createElement('div');
      folderContent.className = 'git-tree-folder-content';
      renderFileTreeNode(folderContent, folder, isStaged, statsMap, depth + 1, readOnly);
      folderEl.appendChild(folderContent);

      folderHeader.addEventListener('click', function () {
        var collapsed = folderContent.style.display === 'none';
        folderContent.style.display = collapsed ? '' : 'none';
        folderArrow.textContent = collapsed ? '\u25BE' : '\u25B8';
      });

      container.appendChild(folderEl);
    })(folderNames[f]);
  }

  for (var i = 0; i < node.files.length; i++) {
    container.appendChild(createGitFileRow(node.files[i], isStaged, statsMap, depth, readOnly));
  }
}

function createGitFileRow(file, isStaged, statsMap, depth, readOnly) {
  var container = document.createElement('div');
  container.className = 'git-file-container';

  var row = document.createElement('div');
  row.className = 'git-file';
  row.style.paddingLeft = (8 + (depth || 0) * 12) + 'px';

  var statusEl = document.createElement('span');
  statusEl.className = 'git-status git-status-' + gitStatusClass(file.status);
  statusEl.textContent = file.status;

  var nameEl = document.createElement('span');
  nameEl.className = 'git-filename';
  var parts = file.file.replace(/\\/g, '/').split('/');
  nameEl.textContent = parts[parts.length - 1];
  nameEl.title = file.file + ' — Click to view diff';

  nameEl.addEventListener('click', function (e) {
    e.stopPropagation();
    addDiffColumn({
      filePath: file.file,
      staged: isStaged,
      status: file.status
    }, { title: parts[parts.length - 1] + ' (' + file.status + ')' });
  });
  // Right-click on the row (not just the filename span) gives Open in editor /
  // File History / Blame access — easier to hit, especially over the stat /
  // action columns where users instinctively right-click.
  row.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    showGitFileContextMenu(e, file.file);
  });

  var statEl = document.createElement('span');
  statEl.className = 'git-file-stat';
  var fileStat = statsMap ? statsMap[file.file] : null;
  if (fileStat) {
    if (fileStat.insertions > 0) {
      var addStat = document.createElement('span');
      addStat.className = 'git-stat-add';
      addStat.textContent = '+' + fileStat.insertions;
      statEl.appendChild(addStat);
    }
    if (fileStat.deletions > 0) {
      var delStat = document.createElement('span');
      delStat.className = 'git-stat-del';
      delStat.textContent = '\u2212' + fileStat.deletions;
      statEl.appendChild(delStat);
    }
  }

  var actions = document.createElement('span');
  actions.className = 'git-file-actions';

  if (!readOnly) {
    if (isStaged) {
      var unstageBtn = document.createElement('button');
      unstageBtn.className = 'git-file-action';
      unstageBtn.textContent = '\u2212';
      unstageBtn.title = 'Unstage';
      unstageBtn.addEventListener('click', function (e) { e.stopPropagation(); gitUnstageFile(file.file); });
      actions.appendChild(unstageBtn);
    } else {
      var stageBtn = document.createElement('button');
      stageBtn.className = 'git-file-action';
      stageBtn.textContent = '+';
      stageBtn.title = 'Stage';
      stageBtn.addEventListener('click', function (e) { e.stopPropagation(); gitStageFile(file.file); });
      actions.appendChild(stageBtn);

      if (!file.untracked) {
        var discardBtn = document.createElement('button');
        discardBtn.className = 'git-file-action git-discard';
        discardBtn.textContent = '\u21A9';
        discardBtn.title = 'Discard Changes';
        discardBtn.addEventListener('click', function (e) { e.stopPropagation(); gitDiscardFile(file.file); });
        actions.appendChild(discardBtn);
      }
    }
  }

  row.appendChild(statusEl);
  row.appendChild(nameEl);
  row.appendChild(statEl);
  row.appendChild(actions);
  container.appendChild(row);
  return container;
}

function gitStatusClass(status) {
  if (status === '?' || status === 'A') return 'added';
  if (status === 'D') return 'deleted';
  if (status === 'R') return 'renamed';
  return 'modified';
}

function gitStageFile(filePath) {
  if (!activeProjectKey || !window.electronAPI) return;
  window.electronAPI.gitStageFile(gitTargetCwd(), filePath).then(function () { refreshGitStatus(); });
}

function gitUnstageFile(filePath) {
  if (!activeProjectKey || !window.electronAPI) return;
  window.electronAPI.gitUnstageFile(gitTargetCwd(), filePath).then(function () { refreshGitStatus(); });
}

function gitStageAll() {
  if (!activeProjectKey || !window.electronAPI) return;
  window.electronAPI.gitStageAll(gitTargetCwd()).then(function () { refreshGitStatus(); });
}

function gitUnstageAll() {
  if (!activeProjectKey || !window.electronAPI) return;
  window.electronAPI.gitUnstageAll(gitTargetCwd()).then(function () { refreshGitStatus(); });
}

function gitDiscardFile(filePath) {
  if (!activeProjectKey || !window.electronAPI) return;
  window.electronAPI.gitDiscardFile(gitTargetCwd(), filePath).then(function () { refreshGitStatus(); });
}

function gitCommit() {
  if (!activeProjectKey || !window.electronAPI) return;
  var msg = gitCommitMsg.value.trim();
  if (!msg) return;
  var amend = gitAmendCheckbox && gitAmendCheckbox.checked;
  window.electronAPI.gitCommit(gitTargetCwd(), msg, amend).then(function (result) {
    if (result.success) {
      gitCommitMsg.value = '';
      if (gitAmendCheckbox) gitAmendCheckbox.checked = false;
      showGitStatus(amend ? 'Amended successfully' : 'Committed successfully');
      refreshGitStatus(true);
    } else {
      showGitStatus('Commit failed: ' + result.error, true);
    }
  });
}

function gitCheckout(branchName) {
  if (!activeProjectKey || !window.electronAPI) return;
  showGitStatus('Switching to ' + branchName + '...');
  window.electronAPI.gitCheckout(gitTargetCwd(), branchName).then(function (result) {
    if (result.success) {
      showGitStatus('Switched to ' + branchName);
      invalidateProjectRootBranch(activeProjectKey);
      refreshGitStatus(true);
    } else {
      showGitStatus('Checkout failed: ' + result.error, true);
    }
  });
}

function gitCreateBranch(branchName) {
  if (!activeProjectKey || !window.electronAPI) return;
  showGitStatus('Creating ' + branchName + '...');
  window.electronAPI.gitCreateBranch(gitTargetCwd(), branchName).then(function (result) {
    if (result.success) {
      showGitStatus('Created and switched to ' + branchName);
      invalidateProjectRootBranch(activeProjectKey);
      refreshGitStatus(true);
    } else {
      showGitStatus('Create branch failed: ' + result.error, true);
    }
  });
}

function gitStashPush() {
  if (!activeProjectKey || !window.electronAPI) return;
  showGitStatus('Stashing...');
  window.electronAPI.gitStashPush(gitTargetCwd()).then(function (result) {
    if (result.success) {
      showGitStatus('Changes stashed');
      refreshGitStatus(true);
    } else {
      showGitStatus('Stash failed: ' + result.error, true);
    }
  });
}

function gitStashPop() {
  if (!activeProjectKey || !window.electronAPI) return;
  showGitStatus('Popping stash...');
  window.electronAPI.gitStashPop(gitTargetCwd()).then(function (result) {
    if (result.success) {
      showGitStatus('Stash popped');
      refreshGitStatus(true);
    } else {
      showGitStatus('Stash pop failed: ' + result.error, true);
    }
  });
}

function gitPull() {
  if (!activeProjectKey || !window.electronAPI) return;
  showGitStatus('Pulling...');
  window.electronAPI.gitPull(gitTargetCwd()).then(function (result) {
    if (result.success) {
      showGitStatus(result.output || 'Pull complete');
      refreshGitStatus();
    } else {
      showGitStatus('Pull failed: ' + result.error, true);
    }
  });
}

function gitPush() {
  if (!activeProjectKey || !window.electronAPI) return;
  showGitStatus('Pushing...');
  window.electronAPI.gitPush(gitTargetCwd()).then(function (result) {
    if (result.success) {
      showGitStatus(result.output || 'Push complete');
    } else {
      showGitStatus('Push failed: ' + result.error, true);
    }
  });
}

function showGitStatus(text, isError) {
  gitStatusMsgEl.textContent = text;
  gitStatusMsgEl.className = 'git-status-msg' + (isError ? ' git-status-error' : '');
  if (!isError) {
    setTimeout(function () {
      if (gitStatusMsgEl.textContent === text) gitStatusMsgEl.textContent = '';
    }, 5000);
  }
}

// ============================================================
// Run Configs
// ============================================================

function refreshRunConfigs() {
  if (!activeProjectKey || !window.electronAPI) return;
  while (runConfigsEl.firstChild) runConfigsEl.removeChild(runConfigsEl.firstChild);
  window.electronAPI.getLaunchConfigs(activeProjectKey).then(function (data) {
    runCachedData = data;
    var configs = data.configs || [];
    if (configs.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'run-empty';
      empty.textContent = 'No launch configurations found. Click + to add one.';
      runConfigsEl.appendChild(empty);
      return;
    }
    // Build recent configs group from saved recent launches
    var recentLaunches = data.recentLaunches || [];
    var recentConfigs = [];
    for (var ri = 0; ri < recentLaunches.length && ri < 5; ri++) {
      var rKey = recentLaunches[ri];
      for (var ci = 0; ci < configs.length; ci++) {
        if (configs[ci].name === rKey.name && configs[ci].type === rKey.type) {
          recentConfigs.push(configs[ci]);
          break;
        }
      }
    }

    // Group by _source
    var groups = { recent: recentConfigs, custom: [], launchSettings: [], 'launch.json': [] };
    for (var i = 0; i < configs.length; i++) {
      var src = configs[i]._source || 'custom';
      if (!groups[src]) groups[src] = [];
      groups[src].push(configs[i]);
    }
    var groupLabels = { recent: 'Recent', custom: 'Custom', launchSettings: 'Launch Settings', 'launch.json': 'VS Code' };
    var groupOrder = ['recent', 'custom', 'launchSettings', 'launch.json'];
    for (var g = 0; g < groupOrder.length; g++) {
      var key = groupOrder[g];
      var items = groups[key];
      if (!items || items.length === 0) continue;
      var group = document.createElement('div');
      group.className = 'run-source-group';
      var hdr = document.createElement('div');
      hdr.className = 'run-source-header';
      // Recent and Custom start expanded, others start collapsed
      var startExpanded = (key === 'recent' || key === 'custom');
      var arrow = document.createElement('span');
      arrow.className = 'run-source-arrow' + (startExpanded ? ' expanded' : '');
      arrow.textContent = '\u25B8';
      var label = document.createElement('span');
      label.textContent = (groupLabels[key] || key) + ' (' + items.length + ')';
      hdr.appendChild(arrow);
      hdr.appendChild(label);
      group.appendChild(hdr);
      var list = document.createElement('div');
      list.className = 'run-source-items' + (startExpanded ? '' : ' collapsed');
      hdr.addEventListener('click', (function (a, l) {
        return function () {
          a.classList.toggle('expanded');
          l.classList.toggle('collapsed');
        };
      })(arrow, list));
      for (var j = 0; j < items.length; j++) {
        (function (config) {
          var item = document.createElement('div');
          item.className = 'run-config-item';
          var runningId = findRunningColumn(config.name);
          var isRunning = runningId !== null;

          // Run controls group
          var controls = document.createElement('div');
          controls.className = 'run-controls';

          var playBtn = document.createElement('button');
          playBtn.className = 'run-play-btn';
          playBtn.textContent = '\u25B6';
          playBtn.title = 'Run ' + config.name;
          if (isRunning) playBtn.classList.add('dimmed');
          playBtn.addEventListener('click', function () { launchConfig(config); });
          controls.appendChild(playBtn);

          if (isRunning) {
            var stopBtn = document.createElement('button');
            stopBtn.className = 'run-stop-btn';
            stopBtn.textContent = '\u25A0';
            stopBtn.title = 'Stop';
            stopBtn.addEventListener('click', function () {
              removeColumn(findRunningColumn(config.name));
              setTimeout(refreshRunConfigs, 300);
            });
            controls.appendChild(stopBtn);

            var restartBtn = document.createElement('button');
            restartBtn.className = 'run-restart-btn';
            restartBtn.textContent = '\u21bb';
            restartBtn.title = 'Restart';
            restartBtn.addEventListener('click', function () {
              var rid = findRunningColumn(config.name);
              if (rid !== null) removeColumn(rid);
              setTimeout(function () { launchConfig(config); }, 500);
            });
            controls.appendChild(restartBtn);
          }

          var nameEl = document.createElement('span');
          nameEl.className = 'run-config-name' + (isRunning ? ' running' : '');
          nameEl.textContent = config.name;
          nameEl.style.cursor = 'pointer';
          nameEl.addEventListener('click', function () {
            if (config._readonly) {
              openConfigViewer(config);
            } else {
              openConfigEditor(config);
            }
          });
          var typeEl = document.createElement('span');
          var knownTypes = ['dotnet-run', 'dotnet-exec', 'coreclr', 'node', 'pwa-node', 'python', 'custom'];
          var isUnknown = config.type && knownTypes.indexOf(config.type) === -1;
          typeEl.className = 'run-config-badge' + (isUnknown ? ' warning' : '');
          typeEl.textContent = config.type || '';
          var actions = document.createElement('div');
          actions.className = 'run-config-actions';
          if (config._readonly) {
            var cloneBtn = document.createElement('button');
            cloneBtn.className = 'run-config-action-btn';
            cloneBtn.textContent = '\u2398'; // clone icon
            cloneBtn.title = 'Clone to custom configs';
            cloneBtn.addEventListener('click', function () { cloneConfig(config); });
            actions.appendChild(cloneBtn);
          } else {
            var editBtn = document.createElement('button');
            editBtn.className = 'run-config-action-btn';
            editBtn.textContent = '\u270E'; // pencil
            editBtn.title = 'Edit';
            editBtn.addEventListener('click', function () { openConfigEditor(config); });
            actions.appendChild(editBtn);
          }
          item.appendChild(controls);
          item.appendChild(nameEl);
          item.appendChild(typeEl);
          item.appendChild(actions);
          list.appendChild(item);
        })(items[j]);
      }
      group.appendChild(list);
      runConfigsEl.appendChild(group);
    }
  });
}

function cloneConfig(config) {
  var cloned = JSON.parse(JSON.stringify(config));
  cloned.name = config.name + ' (Copy)';
  cloned._source = 'custom';
  cloned._readonly = false;
  openConfigEditor(cloned, true);
}

function showRunListView() {
  runListView.classList.remove('hidden');
  runEditorView.classList.add('hidden');
  runProfilesView.classList.add('hidden');
}

function showRunEditorView() {
  runListView.classList.add('hidden');
  runEditorView.classList.remove('hidden');
  runProfilesView.classList.add('hidden');
}

function showRunProfilesView() {
  runListView.classList.add('hidden');
  runEditorView.classList.add('hidden');
  runProfilesView.classList.remove('hidden');
}

function openConfigViewer(config) {
  runEditingConfig = JSON.parse(JSON.stringify(config));
  runEditingIndex = -1;
  runEditingOriginalName = null;
  runEditingOriginalType = null;
  runEditorTitle.textContent = config.name;
  document.getElementById('btn-run-delete').classList.add('hidden');
  document.getElementById('btn-run-save').classList.add('hidden');
  buildEditorForm(true); // true = read-only
  showRunEditorView();
}

function openConfigEditor(config, isNew) {
  runEditingConfig = config ? JSON.parse(JSON.stringify(config)) : {
    name: '',
    type: 'custom',
    command: '',
    args: [],
    cwd: '',
    env: {},
    envProfile: '',
    envFile: '',
    applicationUrl: '',
    openBrowserOnLaunch: false
  };
  if (isNew && !config) {
    runEditingIndex = -1;
    runEditingOriginalName = null;
  } else if (isNew && config) {
    runEditingIndex = -1;
    runEditingOriginalName = null;
  } else {
    runEditingIndex = findCustomConfigIndex(config);
    runEditingOriginalName = config ? config.name : null;
    runEditingOriginalType = config ? config.type : null;
  }
  runEditorTitle.textContent = isNew ? 'New Configuration' : 'Edit: ' + config.name;
  document.getElementById('btn-run-delete').classList.toggle('hidden', runEditingIndex < 0);
  document.getElementById('btn-run-save').classList.remove('hidden');
  buildEditorForm();
  showRunEditorView();
}

function findCustomConfigIndex(config) {
  if (!runCachedData) return -1;
  var customs = (runCachedData.configs || []).filter(function (c) { return c._source === 'custom'; });
  for (var i = 0; i < customs.length; i++) {
    if (customs[i].name === config.name && customs[i].type === config.type) return i;
  }
  return -1;
}

function buildEditorForm(readOnly) {
  var form = runEditorForm;
  while (form.firstChild) form.removeChild(form.firstChild);
  var cfg = runEditingConfig;

  // General section
  var general = createEditorSection('General', true);
  general.body.appendChild(createTextField('Name', cfg.name, function (v) { cfg.name = v; }));
  var typeOpts = [
    { value: 'dotnet-run', label: 'dotnet run' },
    { value: 'dotnet-exec', label: 'dotnet (exec)' },
    { value: 'node', label: 'Node.js' },
    { value: 'python', label: 'Python' },
    { value: 'custom', label: 'Custom Command' }
  ];
  general.body.appendChild(createSelectField('Type', cfg.type || 'custom', typeOpts, function (v) {
    cfg.type = v;
    buildEditorForm();
  }));
  form.appendChild(general.el);

  // Command section — type-specific
  var command = createEditorSection('Command', true);
  if (cfg.type === 'dotnet-run') {
    command.body.appendChild(createFileField('Project (.csproj)', cfg.project || '', function (v) { cfg.project = v; },
      [{ name: 'C# Project', extensions: ['csproj'] }]));
    command.body.appendChild(createTextField('Application URL', cfg.applicationUrl || '', function (v) { cfg.applicationUrl = v; }));
    command.body.appendChild(createTextField('Framework (TFM)', cfg.framework || '', function (v) { cfg.framework = v; }));
  } else if (cfg.type === 'dotnet-exec') {
    command.body.appendChild(createFileField('Program (.dll)', cfg.program || '', function (v) { cfg.program = v; },
      [{ name: 'DLL', extensions: ['dll'] }]));
  } else if (cfg.type === 'node') {
    command.body.appendChild(createTextField('Program', cfg.program || '', function (v) { cfg.program = v; }));
    command.body.appendChild(createTextField('Runtime Executable', cfg.runtimeExecutable || '', function (v) { cfg.runtimeExecutable = v; }));
    command.body.appendChild(createTextField('Runtime Args', (cfg.runtimeArgs || []).join(' '), function (v) { cfg.runtimeArgs = v ? v.split(/\s+/) : []; }));
  } else if (cfg.type === 'python') {
    command.body.appendChild(createTextField('Script', cfg.script || cfg.program || '', function (v) { cfg.script = v; }));
    command.body.appendChild(createTextField('Interpreter Path', cfg.interpreter || '', function (v) { cfg.interpreter = v; }));
  } else {
    command.body.appendChild(createTextField('Command', cfg.command || '', function (v) { cfg.command = v; }));
  }
  form.appendChild(command.el);

  // Arguments
  var argsSection = createEditorSection('Arguments', true);
  var argsVal = Array.isArray(cfg.args) ? cfg.args.join(' ') : (cfg.args || cfg.commandLineArgs || '');
  argsSection.body.appendChild(createTextField('Command Line Args', argsVal, function (v) {
    cfg.args = v ? v.split(/\s+/) : [];
    cfg.commandLineArgs = v;
  }));
  form.appendChild(argsSection.el);

  // Working Directory
  var cwdSection = createEditorSection('Working Directory', true);
  cwdSection.body.appendChild(createTextField('Path', cfg.cwd || '', function (v) { cfg.cwd = v; }));
  form.appendChild(cwdSection.el);

  // Environment
  var envSection = createEditorSection('Environment', true);
  var profiles = (runCachedData && runCachedData.envProfiles) ? runCachedData.envProfiles : {};
  var profileNames = Object.keys(profiles);
  var profileOpts = [{ value: '', label: 'None' }];
  for (var p = 0; p < profileNames.length; p++) {
    profileOpts.push({ value: profileNames[p], label: profileNames[p] });
  }
  envSection.body.appendChild(createSelectField('Env Profile', cfg.envProfile || '', profileOpts, function (v) { cfg.envProfile = v; }));
  var manageLink = document.createElement('button');
  manageLink.className = 'run-editor-link';
  manageLink.textContent = 'Manage Profiles';
  manageLink.addEventListener('click', function () { openProfileManager(); });
  envSection.body.appendChild(manageLink);
  envSection.body.appendChild(createEnvTable(cfg.env || {}, function (env) { cfg.env = env; }));
  envSection.body.appendChild(createTextField('Env File Path', cfg.envFile || '', function (v) { cfg.envFile = v; }));
  form.appendChild(envSection.el);

  // URL section (for web apps)
  if (cfg.type === 'dotnet-run' || cfg.type === 'node' || cfg.type === 'custom') {
    var urlSection = createEditorSection('URL', false);
    if (cfg.type !== 'dotnet-run') {
      urlSection.body.appendChild(createTextField('Application URL', cfg.applicationUrl || '', function (v) { cfg.applicationUrl = v; }));
    }
    var cbRow = document.createElement('div');
    cbRow.className = 'run-editor-checkbox-row';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = cfg.openBrowserOnLaunch || false;
    cb.addEventListener('change', function () { cfg.openBrowserOnLaunch = cb.checked; });
    var cbLabel = document.createElement('span');
    cbLabel.textContent = 'Open browser on launch';
    cbRow.appendChild(cb);
    cbRow.appendChild(cbLabel);
    urlSection.body.appendChild(cbRow);
    form.appendChild(urlSection.el);
  }

  // Disable all inputs in read-only mode
  if (readOnly) {
    var inputs = form.querySelectorAll('input, select, button');
    for (var ri = 0; ri < inputs.length; ri++) {
      inputs[ri].disabled = true;
    }
  }
}

function createEditorSection(title, startOpen) {
  var section = document.createElement('div');
  section.className = 'run-editor-section';
  var header = document.createElement('div');
  header.className = 'run-editor-section-header';
  var arrow = document.createElement('span');
  arrow.className = 'run-source-arrow' + (startOpen ? ' expanded' : '');
  arrow.textContent = '\u25B8';
  header.appendChild(arrow);
  var lbl = document.createElement('span');
  lbl.textContent = title;
  header.appendChild(lbl);
  section.appendChild(header);
  var body = document.createElement('div');
  body.className = 'run-editor-section-body' + (startOpen ? '' : ' collapsed');
  section.appendChild(body);
  header.addEventListener('click', function () {
    arrow.classList.toggle('expanded');
    body.classList.toggle('collapsed');
  });
  return { el: section, body: body };
}

function createTextField(label, value, onChange) {
  var field = document.createElement('div');
  field.className = 'run-editor-field';
  var lbl = document.createElement('label');
  lbl.className = 'run-editor-label';
  lbl.textContent = label;
  field.appendChild(lbl);
  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'run-editor-input';
  input.value = value;
  input.addEventListener('change', function () { onChange(input.value); });
  input.addEventListener('input', function () { onChange(input.value); });
  field.appendChild(input);
  return field;
}

function createSelectField(label, value, options, onChange) {
  var field = document.createElement('div');
  field.className = 'run-editor-field';
  var lbl = document.createElement('label');
  lbl.className = 'run-editor-label';
  lbl.textContent = label;
  field.appendChild(lbl);
  var select = document.createElement('select');
  select.className = 'run-editor-select';
  for (var i = 0; i < options.length; i++) {
    var opt = document.createElement('option');
    opt.value = options[i].value;
    opt.textContent = options[i].label;
    if (options[i].value === value) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', function () { onChange(select.value); });
  field.appendChild(select);
  return field;
}

function createFileField(label, value, onChange, filters) {
  var field = document.createElement('div');
  field.className = 'run-editor-field';
  var lbl = document.createElement('label');
  lbl.className = 'run-editor-label';
  lbl.textContent = label;
  field.appendChild(lbl);
  var row = document.createElement('div');
  row.className = 'run-editor-input-row';
  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'run-editor-input';
  input.value = value;
  input.addEventListener('change', function () { onChange(input.value); });
  input.addEventListener('input', function () { onChange(input.value); });
  row.appendChild(input);
  var btn = document.createElement('button');
  btn.className = 'run-editor-browse-btn';
  btn.textContent = 'Browse';
  btn.addEventListener('click', function () {
    window.electronAPI.browseFile(filters || []).then(function (path) {
      if (path) {
        input.value = path;
        onChange(path);
      }
    });
  });
  row.appendChild(btn);
  field.appendChild(row);
  return field;
}

function createEnvTable(env, onChange) {
  var wrapper = document.createElement('div');
  var entries = Object.entries(env);
  function rebuild() {
    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
    var table = document.createElement('table');
    table.className = 'run-env-table';
    if (entries.length > 0) {
      var thead = document.createElement('thead');
      var tr = document.createElement('tr');
      var th1 = document.createElement('th'); th1.textContent = 'Variable';
      var th2 = document.createElement('th'); th2.textContent = 'Value';
      var th3 = document.createElement('th'); th3.textContent = '';
      tr.appendChild(th1); tr.appendChild(th2); tr.appendChild(th3);
      thead.appendChild(tr);
      table.appendChild(thead);
    }
    var tbody = document.createElement('tbody');
    for (var i = 0; i < entries.length; i++) {
      (function (idx) {
        var row = document.createElement('tr');
        var td1 = document.createElement('td');
        var keyInput = document.createElement('input');
        keyInput.value = entries[idx][0];
        keyInput.placeholder = 'KEY';
        keyInput.addEventListener('change', function () {
          entries[idx][0] = keyInput.value;
          syncEnv();
        });
        td1.appendChild(keyInput);
        var td2 = document.createElement('td');
        var valInput = document.createElement('input');
        valInput.value = entries[idx][1];
        valInput.placeholder = 'value';
        valInput.addEventListener('change', function () {
          entries[idx][1] = valInput.value;
          syncEnv();
        });
        td2.appendChild(valInput);
        var td3 = document.createElement('td');
        var rmBtn = document.createElement('button');
        rmBtn.className = 'run-env-remove-btn';
        rmBtn.textContent = '\u00D7';
        rmBtn.addEventListener('click', function () {
          entries.splice(idx, 1);
          rebuild();
          syncEnv();
        });
        td3.appendChild(rmBtn);
        row.appendChild(td1); row.appendChild(td2); row.appendChild(td3);
        tbody.appendChild(row);
      })(i);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);
    var addBtn = document.createElement('button');
    addBtn.className = 'run-env-add-btn';
    addBtn.textContent = '+ Add Variable';
    addBtn.addEventListener('click', function () {
      entries.push(['', '']);
      rebuild();
    });
    wrapper.appendChild(addBtn);
  }
  function syncEnv() {
    var obj = {};
    for (var i = 0; i < entries.length; i++) {
      if (entries[i][0]) obj[entries[i][0]] = entries[i][1];
    }
    onChange(obj);
  }
  rebuild();
  return wrapper;
}

var activeProfileName = null;

function openProfileManager() {
  showRunProfilesView();
  renderProfileList();
}

function renderProfileList() {
  var list = runProfilesList;
  while (list.firstChild) list.removeChild(list.firstChild);
  var profiles = (runCachedData && runCachedData.envProfiles) ? runCachedData.envProfiles : {};
  var names = Object.keys(profiles);

  for (var i = 0; i < names.length; i++) {
    (function (name) {
      var item = document.createElement('div');
      item.className = 'run-profile-item' + (name === activeProfileName ? ' active' : '');
      var nameEl = document.createElement('span');
      nameEl.textContent = name;
      nameEl.style.flex = '1';
      item.appendChild(nameEl);
      var delBtn = document.createElement('button');
      delBtn.className = 'run-config-action-btn';
      delBtn.textContent = '\u00D7';
      delBtn.title = 'Delete profile';
      delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!confirm('Delete profile "' + name + '"?')) return;
        delete profiles[name];
        saveProfiles(profiles);
        if (activeProfileName === name) activeProfileName = null;
        renderProfileList();
        renderProfileEditor();
      });
      item.appendChild(delBtn);
      item.addEventListener('click', function () {
        activeProfileName = name;
        renderProfileList();
        renderProfileEditor();
      });
      list.appendChild(item);
    })(names[i]);
  }

  var actions = document.createElement('div');
  actions.className = 'run-profile-actions';
  var addBtn = document.createElement('button');
  addBtn.className = 'run-profile-add-btn';
  addBtn.textContent = '+ Add Profile';
  addBtn.addEventListener('click', function () {
    var name = prompt('Profile name:');
    if (!name) return;
    profiles[name] = {};
    saveProfiles(profiles);
    activeProfileName = name;
    renderProfileList();
    renderProfileEditor();
  });
  actions.appendChild(addBtn);
  list.appendChild(actions);

  if (!activeProfileName && names.length > 0) {
    activeProfileName = names[0];
  }
  renderProfileEditor();
}

function renderProfileEditor() {
  var editor = runProfileEditor;
  while (editor.firstChild) editor.removeChild(editor.firstChild);
  if (!activeProfileName) {
    var empty = document.createElement('div');
    empty.className = 'run-empty';
    empty.textContent = 'Select a profile to edit';
    editor.appendChild(empty);
    return;
  }
  var profiles = (runCachedData && runCachedData.envProfiles) ? runCachedData.envProfiles : {};
  var profileEnv = profiles[activeProfileName] || {};

  var renameField = createTextField('Profile Name', activeProfileName, function (v) {
    if (v && v !== activeProfileName && !profiles[v]) {
      profiles[v] = profiles[activeProfileName];
      delete profiles[activeProfileName];
      activeProfileName = v;
      saveProfiles(profiles);
      renderProfileList();
    }
  });
  editor.appendChild(renameField);

  var envFileVal = profileEnv._envFile || '';
  editor.appendChild(createTextField('Env File', envFileVal, function (v) {
    if (v) {
      profileEnv._envFile = v;
    } else {
      delete profileEnv._envFile;
    }
    profiles[activeProfileName] = profileEnv;
    saveProfiles(profiles);
  }));

  var envOnly = {};
  for (var k in profileEnv) {
    if (k !== '_envFile') envOnly[k] = profileEnv[k];
  }
  editor.appendChild(createEnvTable(envOnly, function (env) {
    var updated = {};
    if (profileEnv._envFile) updated._envFile = profileEnv._envFile;
    for (var key in env) updated[key] = env[key];
    profiles[activeProfileName] = updated;
    saveProfiles(profiles);
  }));
}

function saveProfiles(profiles) {
  if (!activeProjectKey) return;
  runCachedData.envProfiles = profiles;
  window.electronAPI.saveEnvProfiles(activeProjectKey, profiles);
}

function resolveConfigEnv(config) {
  var mergedEnv = {};
  var profile = null;
  if (runCachedData && config.envProfile && runCachedData.envProfiles) {
    profile = runCachedData.envProfiles[config.envProfile];
  }
  function resolveEnvPath(p) {
    if (!p) return p;
    return p.replace(/\$\{workspaceFolder\}/g, activeProjectKey);
  }

  var p1 = (profile && profile._envFile)
    ? window.electronAPI.readEnvFile(resolveEnvPath(profile._envFile))
    : Promise.resolve({});

  var p2 = config.envFile
    ? window.electronAPI.readEnvFile(resolveEnvPath(config.envFile))
    : Promise.resolve({});

  return Promise.all([p1, p2]).then(function (results) {
    var profileFileEnv = results[0];
    var configFileEnv = results[1];

    for (var k in profileFileEnv) mergedEnv[k] = profileFileEnv[k];
    if (profile) {
      for (var k2 in profile) {
        if (k2 !== '_envFile') mergedEnv[k2] = profile[k2];
      }
    }
    for (var k3 in configFileEnv) mergedEnv[k3] = configFileEnv[k3];
    var configEnv = config.env || {};
    for (var k4 in configEnv) mergedEnv[k4] = configEnv[k4];

    return mergedEnv;
  });
}

function launchConfig(config) {
  if (!activeProjectKey) return;
  function resolve(str) {
    if (!str) return str;
    return str.replace(/\$\{workspaceFolder\}/g, activeProjectKey);
  }

  var existing = findRunningColumn(config.name);
  if (existing) {
    if (!confirm('"' + config.name + '" is already running. Kill and restart?')) return;
    removeColumn(existing);
  }

  resolveConfigEnv(config).then(function (mergedEnv) {
    var cmd, cmdArgs, cwd, env;
    cwd = config.cwd ? resolve(config.cwd) : activeProjectKey;
    env = Object.keys(mergedEnv).length > 0 ? mergedEnv : null;

    if (config.type === 'dotnet-run') {
      cmd = 'dotnet';
      cmdArgs = ['run'];
      if (config.project) {
        cmdArgs.push('--project');
        cmdArgs.push(resolve(config.project));
      }
      if (config.framework) {
        cmdArgs.push('--framework');
        cmdArgs.push(config.framework);
      }
      if (config.applicationUrl) {
        cmdArgs.push('--urls');
        cmdArgs.push(config.applicationUrl);
      }
      var args = config.args || config.commandLineArgs;
      if (args) {
        cmdArgs.push('--');
        if (Array.isArray(args)) {
          cmdArgs = cmdArgs.concat(args);
        } else {
          cmdArgs = cmdArgs.concat(args.split(/\s+/));
        }
      }
    } else if (config.type === 'dotnet-exec' || config.type === 'coreclr') {
      cmd = 'dotnet';
      cmdArgs = [];
      if (config.program) cmdArgs.push(resolve(config.program));
      if (config.args) {
        cmdArgs = cmdArgs.concat(Array.isArray(config.args) ? config.args.map(resolve) : config.args.split(/\s+/));
      }
    } else if (config.type === 'node' || config.type === 'pwa-node') {
      cmd = config.runtimeExecutable || 'node';
      cmdArgs = [];
      if (config.runtimeArgs) cmdArgs = cmdArgs.concat(Array.isArray(config.runtimeArgs) ? config.runtimeArgs : config.runtimeArgs.split(/\s+/));
      if (config.program) cmdArgs.push(resolve(config.program));
      if (config.args) cmdArgs = cmdArgs.concat(Array.isArray(config.args) ? config.args.map(resolve) : config.args.split(/\s+/));
    } else if (config.type === 'python') {
      var script = config.script || config.program || '';
      cmd = config.interpreter || 'python';
      cmdArgs = [];
      if (script) cmdArgs.push(resolve(script));
      if (config.args) cmdArgs = cmdArgs.concat(Array.isArray(config.args) ? config.args : config.args.split(/\s+/));
    } else if (config.type === 'custom') {
      cmd = resolve(config.command);
      cmdArgs = [];
      if (config.args) {
        cmdArgs = Array.isArray(config.args) ? config.args.map(resolve) : config.args.split(/\s+/).map(resolve);
      }
    } else if (config.runtimeExecutable) {
      cmd = resolve(config.runtimeExecutable);
      cmdArgs = (config.args || []).map(resolve);
      if (config.program) cmdArgs.unshift(resolve(config.program));
    } else if (config.program) {
      cmd = resolve(config.program);
      cmdArgs = (config.args || []).map(resolve);
    } else if (config.command) {
      cmd = resolve(config.command);
      cmdArgs = Array.isArray(config.args) ? config.args : [];
    } else {
      return;
    }

    var launchUrl = (config.openBrowserOnLaunch !== false && config.applicationUrl) ? config.applicationUrl : null;
    // Run-tab launches share a dedicated row so multiple runs stack
    // alongside each other without shoving Claude columns around. If a row
    // already contains run columns (col.cmd set on any of its members),
    // append into that row; otherwise spawn a fresh one.
    var state = getActiveState();
    var row = null;
    if (state) {
      for (var ri = 0; ri < state.rows.length; ri++) {
        var ids = state.rows[ri].columnIds;
        for (var ci = 0; ci < ids.length; ci++) {
          var c = allColumns.get(ids[ci]);
          if (c && c.cmd) { row = state.rows[ri]; break; }
        }
        if (row) break;
      }
      if (!row) row = addRowToProject(state);
    }
    addColumn(cmdArgs, row, { cmd: cmd, title: config.name, cwd: cwd, env: env, launchUrl: launchUrl });

    // Track in recent launches and refresh list to show stop/restart controls
    trackRecentLaunch(config);
    setTimeout(refreshRunConfigs, 500);
  });
}

function trackRecentLaunch(config) {
  if (!activeProjectKey || !runCachedData) return;
  var entry = { name: config.name, type: config.type };
  var recent = runCachedData.recentLaunches || [];
  // Remove existing entry for this config
  recent = recent.filter(function (r) { return !(r.name === entry.name && r.type === entry.type); });
  // Add to front
  recent.unshift(entry);
  // Keep only last 10
  if (recent.length > 10) recent = recent.slice(0, 10);
  runCachedData.recentLaunches = recent;
  window.electronAPI.saveRecentLaunches(activeProjectKey, recent);
}

function findRunningColumn(configName) {
  var state = getActiveState();
  if (!state) return null;
  var found = null;
  state.columns.forEach(function (colData, id) {
    if (colData.customTitle === configName && colData.cmd) {
      found = id;
    }
  });
  return found;
}

function refreshExplorer() {
  var activeTab = document.querySelector('.explorer-tab.active');
  if (!activeTab) return;
  var tabName = activeTab.dataset.tab;
  if (tabName === 'files') refreshFileTree();
  else if (tabName === 'git') refreshGitStatus();
  else if (tabName === 'run') refreshRunConfigs();
  else if (tabName === 'automations') refreshAutomations();
}

btnToggleExplorer.addEventListener('click', toggleExplorer);
document.getElementById('btn-refresh-files').addEventListener('click', refreshFileTree);
document.getElementById('btn-reveal-explorer').addEventListener('click', function () {
  if (activeProjectKey) window.electronAPI.openPath(activeProjectKey);
});
document.getElementById('btn-refresh-git').addEventListener('click', function () { refreshGitStatus(true); });

document.getElementById('btn-refresh-run').addEventListener('click', refreshRunConfigs);
document.getElementById('btn-add-run-config').addEventListener('click', function () {
  openConfigEditor(null, true);
});
document.getElementById('btn-run-editor-back').addEventListener('click', function () {
  showRunListView();
});
document.getElementById('btn-run-cancel').addEventListener('click', function () {
  showRunListView();
  refreshRunConfigs();
});
document.getElementById('btn-profiles-back').addEventListener('click', function () {
  showRunEditorView();
});
document.getElementById('btn-run-save').addEventListener('click', function () {
  if (!activeProjectKey || !runEditingConfig) return;
  var cfg = runEditingConfig;
  if (!cfg.name) { alert('Name is required'); return; }
  if (cfg.type === 'dotnet-run' && !cfg.project) { alert('Project (.csproj) is required for dotnet-run'); return; }
  if (cfg.type === 'custom' && !cfg.command) { alert('Command is required for custom type'); return; }

  var toSave = JSON.parse(JSON.stringify(cfg));
  delete toSave._source;
  delete toSave._readonly;

  window.electronAPI.getLaunchConfigs(activeProjectKey).then(function (data) {
    var customs = (data.configs || []).filter(function (c) { return c._source === 'custom'; });
    customs = customs.map(function (c) {
      var copy = JSON.parse(JSON.stringify(c));
      delete copy._source;
      delete copy._readonly;
      return copy;
    });
    // Match by original name+type in fresh data to avoid stale index
    var matchIdx = -1;
    if (runEditingOriginalName) {
      for (var mi = 0; mi < customs.length; mi++) {
        if (customs[mi].name === runEditingOriginalName && customs[mi].type === runEditingOriginalType) {
          matchIdx = mi;
          break;
        }
      }
    }
    if (matchIdx >= 0) {
      customs[matchIdx] = toSave;
    } else {
      customs.push(toSave);
    }
    return window.electronAPI.saveLaunchConfigs(activeProjectKey, customs);
  }).then(function () {
    showRunListView();
    refreshRunConfigs();
  });
});
document.getElementById('btn-run-delete').addEventListener('click', function () {
  if (!activeProjectKey || runEditingIndex < 0) return;
  if (!confirm('Delete this configuration?')) return;
  window.electronAPI.getLaunchConfigs(activeProjectKey).then(function (data) {
    var customs = (data.configs || []).filter(function (c) { return c._source === 'custom'; });
    customs = customs.map(function (c) {
      var copy = JSON.parse(JSON.stringify(c));
      delete copy._source;
      delete copy._readonly;
      return copy;
    });
    // Match by original name+type in fresh data to avoid stale index
    var delIdx = -1;
    if (runEditingOriginalName) {
      for (var di = 0; di < customs.length; di++) {
        if (customs[di].name === runEditingOriginalName && customs[di].type === runEditingOriginalType) {
          delIdx = di;
          break;
        }
      }
    }
    if (delIdx < 0) return;
    customs.splice(delIdx, 1);
    return window.electronAPI.saveLaunchConfigs(activeProjectKey, customs);
  }).then(function () {
    showRunListView();
    refreshRunConfigs();
  });
});
document.getElementById('btn-git-commit').addEventListener('click', gitCommit);
gitCommitMsg.addEventListener('keydown', function (e) {
  if (cmdOrCtrl(e) && e.key === 'Enter') {
    e.preventDefault();
    gitCommit();
  }
  e.stopPropagation();
});

// ============================================================
// Font Size
// ============================================================

function applyFontSize(size) {
  fontSize = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
  allColumns.forEach(function (colData) {
    if (colData.terminal) {
      colData.terminal.options.fontSize = fontSize;
    }
  });
  refitAll();
}

function changeFontSize(delta) {
  applyFontSize(fontSize + delta);
  config.fontSize = fontSize;
  saveConfig();
}

function resetFontSize() {
  applyFontSize(FONT_SIZE_DEFAULT);
  config.fontSize = FONT_SIZE_DEFAULT;
  saveConfig();
}

// ============================================================
// Theme
// ============================================================

var themePreference = 'auto'; // 'dark' | 'light' | 'auto'

function applyVisualTheme(visual) {
  currentTheme = visual;
  termTheme = visual === 'light' ? lightTermTheme : darkTermTheme;
  if (visual === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  allColumns.forEach(function (colData) {
    if (colData.terminal) {
      colData.terminal.options.theme = termTheme;
    }
  });
  if (window.electronAPI && window.electronAPI.setTitleBarOverlay) {
    var overlayColors = visual === 'light'
      ? { color: '#e8ecf1', symbolColor: '#1f2328' }
      : { color: '#16213e', symbolColor: '#e0e0e0' };
    window.electronAPI.setTitleBarOverlay(overlayColors);
  }
}

function setThemePreference(pref) {
  themePreference = pref;
  themeSelect.value = pref;
  if (pref === 'auto') {
    if (window.electronAPI && window.electronAPI.getOsDark) {
      window.electronAPI.getOsDark().then(function (isDark) {
        applyVisualTheme(isDark ? 'dark' : 'light');
      });
    } else {
      applyVisualTheme('dark');
    }
  } else {
    applyVisualTheme(pref);
  }
}

// Listen for OS theme changes (only matters when set to auto)
if (window.electronAPI && window.electronAPI.onOsThemeChanged) {
  window.electronAPI.onOsThemeChanged(function (isDark) {
    if (themePreference === 'auto') {
      applyVisualTheme(isDark ? 'dark' : 'light');
    }
  });
}

// Auto-refresh the Explorer tree when files change on disk. Debounced in main;
// here we only refresh if the file tab is open and the change is for the
// active project.
if (window.electronAPI && window.electronAPI.onFsChanged) {
  window.electronAPI.onFsChanged(function (root) {
    if (!activeProjectKey || root !== activeProjectKey) return;
    var activeTab = document.querySelector('.explorer-tab.active');
    if (activeTab && activeTab.dataset.tab === 'files') {
      try { refreshFileTree(); } catch (e) { /* */ }
    }
  });
}

// ============================================================
// Hook Server Integration
// ============================================================

// Per-column flag: once a hook has fired for the column's current session,
// the JSONL tail is redundant. Stopping it eliminates ~7 fs.statSync per
// second per column and a curl-spawn-driven feedback loop on busy turns.
var clawdHookSeenBySession = Object.create(null);

// Pending PostToolUse → thinking transitions. Without this, a tool chain
// (Edit, Read, Edit) would flash 'thinking' between each tool. Any later
// hook event for the same column cancels the pending commit so the chain
// stays visually on a work animation.
var clawdPostToolPending = new Map(); // colId -> { timer }
function clearClawdPostTool(colId) {
  var p = clawdPostToolPending.get(colId);
  if (p) { clearTimeout(p.timer); clawdPostToolPending.delete(colId); }
}

// Resolve which column a hook event belongs to. Two cases:
//
//  1. sessionId match — the column owns this exact session. Normal path.
//  2. cwd fallback   — sessionId doesn't match any column, but the event's
//     cwd identifies an unambiguous column. Covers two real cases:
//       (a) the detectSession race on freshly-spawned columns, where the
//           sessionId mapping isn't resolved yet when the first hooks fire;
//       (b) subagent (Agent/Task) tool calls, which fire hooks under a
//           *different* sessionId than the parent column. They still happen
//           in the parent's cwd, so we route them to that column without
//           ever overwriting its real sessionId.
//
// We deliberately do NOT mutate col.sessionId here. Doing so caused an
// earlier bug where adopting a subagent's sessionId orphaned every
// subsequent parent-session hook.
// Resolve a hook event to a column AND report how it matched: 'sid' (exact
// session_id), 'cwd' (unambiguous single column for the project), or null.
// The `via` is what lets onHookEvent self-heal a stale col.sessionId — a cwd
// match means the event's session_id is the column's TRUE current session.
function clawdResolveHookColumnEx(event) {
  var sid = event && event.session_id;
  var cwd = event && event.cwd;
  var match = null;
  if (sid) {
    allColumns.forEach(function (col, id) {
      if (col.sessionId === sid) match = id;
    });
    if (match != null) return { colId: match, via: 'sid' };
  }
  if (cwd) {
    var found = null;
    var ambiguous = false;
    var cwdColumns = [];
    allColumns.forEach(function (col, id) {
      if (col.projectKey !== cwd) return;
      cwdColumns.push({ colId: id, lastInputAt: col.lastInputAt });
      if (found != null) ambiguous = true;
      else found = id;
    });
    if (!ambiguous && found != null) return { colId: found, via: 'cwd' };
    // Ambiguous cwd: multiple columns share this project. A /clear fork's first
    // UserPromptSubmit carries the new session_id; disambiguate to the column
    // that most recently received typed input (never guess on a tie).
    if (ambiguous) {
      var evtName = (event && (event.hook_event_name || event.event)) || '';
      if (evtName === 'UserPromptSubmit') {
        var picked = window.SessionTarget.resolveInputColumn(cwdColumns, Date.now(), { gapMs: 1500, windowMs: 5000 });
        if (picked != null) return { colId: picked, via: 'input' };
      }
    }
  }
  return { colId: null, via: null };
}

function clawdResolveHookColumn(event) {
  return clawdResolveHookColumnEx(event).colId;
}

if (window.electronAPI && window.electronAPI.onHookEvent) {
  window.electronAPI.onHookEvent(function (event) {
    var sid = event && event.session_id;
    var evtName = (event && (event.hook_event_name || event.event)) || '';
    var __resolved = clawdResolveHookColumnEx(event);
    var colId = __resolved.colId;
    if (colId == null) {
      // Truly orphan — different project, no claiming column. Log it so it
      // shows up in the debug overlay but don't act on it.
      if (window.Clawd && window.Clawd.logHookEvent) {
        window.Clawd.logHookEvent({
          col: null,
          event: evtName,
          tool: (event && event.tool_name) || '',
          matcher: (event && event.matcher) || '',
          anim: null,
        });
      }
      return;
    }
    // Route hooks for the resolved column's *primary* session through the
    // tail-stop path; subagent hooks (different sid, same cwd) skip it
    // because the primary tail is still useful for the parent.
    var col = allColumns.get(colId);
    var via = __resolved.via;
    // A background run (automation / headless / manager) shares the project cwd
    // with interactive columns, so its hooks resolve to a column via the cwd
    // fallback — drop them so the mascot never animates for work the column
    // isn't doing. Only when the event does NOT match the column's OWN session
    // id (a sid match means the column genuinely owns this turn).
    var sidMatchesColumn = !!(col && col.sessionId && col.sessionId === sid);
    if (window.VoiceBackground && window.VoiceBackground.shouldDropBackgroundEvent(event, sidMatchesColumn)) {
      if (window.Clawd && window.Clawd.logHookEvent) {
        window.Clawd.logHookEvent({
          col: colId,
          event: evtName + ' (bg-drop)',
          tool: (event && event.tool_name) || '',
          matcher: (event && event.matcher) || '',
          anim: null,
        });
      }
      return;
    }
    // Genuine column hook (not a dropped automation): record receipt so the
    // stale-hook sweep knows live hooks ARE reaching this column.
    if (col) { col.lastHookAt = Date.now(); col.hookEverSeen = true; }
    // Self-heal a /clear fork: a UserPromptSubmit that resolved by unambiguous
    // cwd OR by dominant-recent-input (ambiguous cwd) carries the column's TRUE
    // new session_id while col.sessionId is stuck on the pre-/clear id. Rebind
    // it so later hooks and voice extraction line up. The claimed-guard blocks
    // ever stealing a sibling's live session, and the sid/ambiguous/null cases
    // never reach here.
    if (col && window.SessionTarget.shouldBindHookSession({
      via: via,
      isUserPromptSubmit: evtName === 'UserPromptSubmit',
      eventSessionId: sid,
      colSessionId: col.sessionId,
      claimedBySibling: !!getClaimedSessionIds(colId)[sid],
    })) {
      col.sessionId = sid;
      col.sessionMtime = 0;
      if (typeof event.transcript_path === 'string' && event.transcript_path) {
        col.voiceTranscriptPath = event.transcript_path;
      } else {
        col.voiceTranscriptPath = null;
      }
      col.voicePreTurnUuid = undefined;
      col.lastSpokenUuid = undefined;
      col.lastSpokenText = undefined;
      persistSessions(col.projectKey, col.workspaceId);
      ensureClawdTail(colId);
      fetchAndSetSessionTitle(colId, col.projectKey, sid);
    }
    var sidMatchesColumn = !!(col && col.sessionId && col.sessionId === sid);
    if (sidMatchesColumn && sid && !clawdHookSeenBySession[sid]) {
      clawdHookSeenBySession[sid] = true;
      if (window.electronAPI && window.electronAPI.clawdStopTail) {
        window.electronAPI.clawdStopTail(colId);
      }
    }
    if (event.matcher === 'idle_prompt' || event.matcher === 'permission_prompt') {
      setActivity(colId, 'waiting');
    }
    // Any incoming event for this column supersedes a pending post-tool
    // transition — keeps tool chains from flashing 'thinking' between tools.
    clearClawdPostTool(colId);
    var animId = null;
    if (evtName === 'UserPromptSubmit') animId = 'thinking';
    else if (evtName === 'PreToolUse') animId = clawdAnimationForTool(event.tool_name);
    else if (evtName === 'PostToolUse') {
      // Deferred commit: if no other event arrives within 250ms, leave the
      // tool animation and park on 'thinking' (Claude is processing the
      // result). This is also the safety net for dropped Stop hooks — we
      // never get stuck on a work animation after a tool actually finished.
      var pendingTimer = setTimeout(function () {
        clawdPostToolPending.delete(colId);
        if (window.Clawd && window.Clawd.setColumnAnimation) {
          window.Clawd.setColumnAnimation(colId, 'thinking');
        }
        if (window.Clawd && window.Clawd.logHookEvent) {
          window.Clawd.logHookEvent({ col: colId, event: 'PostToolUse(commit)', tool: event.tool_name || '', matcher: '', anim: 'thinking' });
        }
      }, 250);
      clawdPostToolPending.set(colId, { timer: pendingTimer });
    }
    else if (evtName === 'Stop' || evtName === 'SubagentStop') {
      // Only the primary-session Stop ends a turn for the widget. A
      // subagent's SubagentStop firing while the parent is still working
      // would otherwise briefly flip Clawd to idle.
      if (sidMatchesColumn) animId = 'idle';
    }
    else if (evtName === 'Notification') {
      if (event.matcher === 'permission_prompt') animId = 'confused';
      else if (event.matcher === 'idle_prompt') animId = 'idle';
    }
    else if (evtName === 'SessionEnd') {
      if (sidMatchesColumn) animId = 'disconnected';
    }
    if (window.Clawd && window.Clawd.logHookEvent) {
      window.Clawd.logHookEvent({
        col: colId,
        event: evtName + (sidMatchesColumn ? '' : ' (cwd)'),
        tool: event.tool_name || '',
        matcher: event.matcher || '',
        anim: animId,
      });
    }
    if (animId && window.Clawd && window.Clawd.setColumnAnimation) {
      window.Clawd.setColumnAnimation(colId, animId);
    }
  });
}

// --- Voice / TTS playback ---
//
// Speaks finished replies aloud for this window's columns. Subscribes to the
// `voice:hookEvent` broadcast (fired to every window, incl. popouts) so a
// popped-out column drives its own playback. Eligibility honours the cached
// public voice settings (`mode`/`enabled`); the API key never reaches here.
//
// Globals exposed for the settings panel:
//   window.__refreshVoiceSettings() — reload the cached settings (call after save)
//   window.__playVoiceTest(result)  — play a {ok, mime, data} synth result (test button)
var VOICE_DEBUG = true; // dev: logs the voice pipeline to the DevTools console; set false to silence
function vlog() {
  var args = [].slice.call(arguments);
  if (VOICE_DEBUG) { try { console.log.apply(console, ['[voice]'].concat(args)); } catch (e) {} }
  try {
    if (voiceSettings && voiceSettings.debugLog && window.electronAPI && window.electronAPI.voiceLog) {
      var parts = args.map(function (a) {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      });
      window.electronAPI.voiceLog(parts.join(' '));
    }
  } catch (e) { /* logging must never break voice */ }
}
var voiceSettings = null;
var currentVoiceAudio = null;
// Bumped to supersede an in-flight streaming auto-play (a newer Stop, or a
// manual button press). Each streamSpeakColumn run captures its own generation
// and bails the moment this no longer matches.
var voiceStreamGen = 0;
// Auto-play single-slot queue: a new eligible reply that arrives while an auto
// stream is already speaking is queued (latest-wins) instead of interrupting it.
var voiceAutoBusy = false;     // true ONLY while an auto stream is in progress (single writer: runAutoStream)
var voiceAutoQueue = null;     // latest queued auto request { colId, readingMode, baselineUuid }

// True while a playback element is actively producing sound. Auto-play uses this
// (alongside voiceAutoBusy) to defer behind a MANUAL/catch-up clip too — that
// path plays via playVoiceAudio without ever setting voiceAutoBusy, so the busy
// flag alone can't see it (the talking-over bug).
function isVoicePlaying() { return !!(currentVoiceAudio && !currentVoiceAudio.paused && !currentVoiceAudio.ended); }

// Wraps streamSpeakColumn so auto-play never interrupts an in-progress utterance.
// Sets voiceAutoBusy synchronously, and on completion drains the latest queued
// reply (if any). Not awaited by callers — the busy flag is the guard.
async function runAutoStream(req) {
  var col = allColumns.get(req.colId);
  if (!col) return;
  vlog('runAutoStream start', { colId: req.colId, busy: voiceAutoBusy, fromTerminal: !!req.spokenText });
  voiceAutoBusy = true;
  try {
    if (req.spokenText) {
      // Real-time path: speak the mode-applied, already-cleaned reply text
      // extracted from the screen (the 🔊 summary logic was applied upstream).
      await streamSpeakText(col, req.spokenText, req.colId);
    } else {
      await streamSpeakColumn(col, req.readingMode, req.baselineUuid, req.colId);
    }
  } catch (e) {
    vlog('autostream error', { colId: req.colId, err: String(e && e.message || e) });
  } finally {
    voiceAutoBusy = false;
    vlog('runAutoStream end; drain=' + !!voiceAutoQueue);
    var q = voiceAutoQueue;
    voiceAutoQueue = null;
    if (q) Promise.resolve(runAutoStream(q)).catch(function () {});   // drain the latest queued reply once the current finishes
  }
}

window.__refreshVoiceSettings = async function () {
  if (window.electronAPI && window.electronAPI.getVoiceSettings) {
    voiceSettings = await window.electronAPI.getVoiceSettings();
  }
  return voiceSettings;
};

// Read a column's rendered terminal buffer as an array of right-trimmed line
// strings (what's actually on screen). Used for real-time voice: an interactive
// Claude Code column often hasn't flushed its reply to the transcript JSONL yet,
// but the reply IS rendered here. Guards a missing terminal -> [].
function readColumnTerminalLines(col) {
  try {
    var term = col && col.terminal;
    var buf = term && term.buffer && term.buffer.active;
    if (!buf) return [];
    var out = [];
    // The reply is always at the bottom; cap to the last ~2000 lines so a huge
    // scrollback doesn't blow up the (now bracket-capped) text cleaner downstream.
    var start = Math.max(0, buf.length - 2000);
    for (var i = start; i < buf.length; i++) {
      var ln = buf.getLine(i);
      out.push(ln ? ln.translateToString(true) : '');
    }
    return out;
  } catch (e) { return []; }
}

// Clean raw terminal-extracted prose into a speakable string, applying the
// Reading mode the same way the transcript path does (extractSpeakableText):
//   - 'full': speak the BODY only (🔊 summary line stripped), truncated.
//   - 'summary': speak the 🔊 line if present, else just the FIRST sentence of
//     the body (a concise fallback — the explicit Summary button should never
//     read the whole reply).
//   - 'auto' (default): if a 🔊 line is present speak ONLY it, else the body.
// A short summary line is never truncated; only a full body keeps maxChars.
// Returns '' when nothing speakable remains (incl. non-content turns).
function cleanTerminalSpoken(rawText, readingMode) {
  if (!rawText || !window.VoiceText || !window.TerminalReply) return '';
  var maxChars = (voiceSettings && voiceSettings.maxChars) || 600;
  var parts = window.TerminalReply.splitReplySummary(rawText || '');
  var pick;
  if (readingMode === 'full') {
    pick = parts.body;
  } else if (readingMode === 'summary') {
    // Explicit Summary: the 🔊 line, else just the first sentence of the body.
    pick = parts.hasSummary ? parts.summary : window.TerminalReply.firstSentence(parts.body);
  } else {
    // auto: 🔊 line if present, else the whole body.
    pick = parts.hasSummary ? parts.summary : parts.body;
  }
  // Only a full body keeps maxChars; the 🔊 line / single sentence / auto body
  // stay whole, matching the original terminal-path behavior.
  var cleaned = window.VoiceText.cleanSpokenText(pick, readingMode === 'full' ? maxChars : 100000);
  // Drop non-content turns ("No response requested." etc.) the same way the
  // transcript path does.
  var n = String(cleaned || '').trim().toLowerCase().replace(/^["'\s]+|["'.!…\s]+$/g, '');
  if (n === 'no response requested' || n === 'no response needed') return '';
  return cleaned || '';
}

// Speak already-cleaned, mode-applied terminal text, mirroring streamSpeakColumn's
// prefetch-one-ahead synth+play loop but sourcing the text from the screen
// instead of the transcript. `voiceStreamGen` lets a newer Stop or a manual
// press supersede us. Expects `spokenText` to be FINAL text (the caller has
// already run cleanTerminalSpoken with the reading mode) — this only splits it
// into sentences so the 🔊 summary line is never re-included here.
async function streamSpeakText(col, spokenText, colId) {
  if (!voiceSettings || !voiceSettings.voiceId) return;
  var spoken = (spokenText || '').trim();
  if (!spoken) return;
  var sentences = (window.VoiceText && window.VoiceText.splitSentences(spoken)) || [];
  if (!sentences.length) return;
  col.voiceUnspoken = false;
  var myGen = ++voiceStreamGen;                 // supersede any prior stream
  // Pass the adjacent chunks so ElevenLabs has prosody context across the
  // separate per-sentence calls (undefined at the ends is fine — skipped).
  var synthOne = function (t, prevText, nextText) { return window.electronAPI.synthesizeVoice({ text: t, voiceId: voiceSettings.voiceId, modelId: voiceSettings.modelId, auto: true, previousText: prevText, nextText: nextText }); };
  var nextP = synthOne(sentences[0], undefined, sentences[1]); // prefetch first
  for (var i = 0; i < sentences.length; i++) {
    if (myGen !== voiceStreamGen) return;         // superseded -> stop
    var result;
    try { result = await nextP; } catch (e) { return; }
    vlog('synth chunk ' + i, { ok: result && result.ok, error: result && result.error, status: result && result.status, hasB64: !!(result && result.base64) });
    if (i + 1 < sentences.length) nextP = synthOne(sentences[i + 1], sentences[i], sentences[i + 2]); // prefetch next while this plays
    if (myGen !== voiceStreamGen) return;
    if (result && result.ok && result.base64) {
      await new Promise(function (resolve) {
        var settled = false;
        var safetyTimer = null;
        var fin = function () { if (!settled) { settled = true; if (safetyTimer) clearTimeout(safetyTimer); resolve(); } };
        playVoiceAudio(result, fin, fin, null, colId);
        safetyTimer = setTimeout(fin, 120000); // safety: never let a missed end-event hang the stream / busy flag
      });
    }
  }
}

// Streaming auto-play: speak a finished reply sentence-by-sentence so audio
// starts almost immediately instead of waiting for the whole reply to synth.
// Extracts ordered sentence chunks (waiting only for a reply newer than the
// baseline), then synthesizes one chunk ahead while the current one plays.
// `voiceStreamGen` lets a newer Stop or a manual button press supersede us.
async function streamSpeakColumn(col, readingMode, baselineUuid, colId) {
  if (!voiceSettings || !voiceSettings.voiceId) return;
  var sres = await window.electronAPI.extractColumnSentences({
    transcriptPath: col.voiceTranscriptPath || '', projectKey: col.projectKey, cwd: col.cwd || col.projectKey, sessionId: col.sessionId,
    baselineUuid: baselineUuid || '', readingMode: readingMode, maxChars: voiceSettings.maxChars
  });
  vlog('extractSentences', { ok: sres && sres.ok, n: sres && sres.sentences && sres.sentences.length, error: sres && sres.error, uuid: sres && sres.uuid, diag: sres && sres.diag });
  if (!sres || !sres.ok || !sres.sentences || !sres.sentences.length) return;
  if (sres.uuid) col.lastSpokenUuid = sres.uuid;
  col.voiceUnspoken = false;
  var myGen = ++voiceStreamGen;                 // supersede any prior stream
  // Pass the adjacent chunks so ElevenLabs has prosody context across the
  // separate per-sentence calls (undefined at the ends is fine — skipped).
  var synthOne = function (t, prevText, nextText) { return window.electronAPI.synthesizeVoice({ text: t, voiceId: voiceSettings.voiceId, modelId: voiceSettings.modelId, auto: true, previousText: prevText, nextText: nextText }); };
  var nextP = synthOne(sres.sentences[0], undefined, sres.sentences[1]); // prefetch first
  for (var i = 0; i < sres.sentences.length; i++) {
    if (myGen !== voiceStreamGen) return;         // superseded -> stop
    var result;
    try { result = await nextP; } catch (e) { return; }
    vlog('synth chunk ' + i, { ok: result && result.ok, error: result && result.error, status: result && result.status, hasB64: !!(result && result.base64) });
    if (i + 1 < sres.sentences.length) nextP = synthOne(sres.sentences[i + 1], sres.sentences[i], sres.sentences[i + 2]); // prefetch next while this plays
    if (myGen !== voiceStreamGen) return;
    if (result && result.ok && result.base64) {
      await new Promise(function (resolve) {
        var settled = false;
        var safetyTimer = null;
        var fin = function () { if (!settled) { settled = true; if (safetyTimer) clearTimeout(safetyTimer); resolve(); } };
        playVoiceAudio(result, fin, fin, null, colId);
        safetyTimer = setTimeout(fin, 120000); // safety: never let a missed end-event hang the stream / busy flag
      });
    }
  }
}

// Manual per-column playback (header speaker buttons + focus catch-up). Reads
// the column's latest reply — `full` reads it verbatim, `summary` condenses it.
// Allowed regardless of the voice enable toggle (explicit user action); it only
// needs a configured voiceId.
async function playColumnReply(colId, readingMode) {
  var srcKey = colId + ':' + readingMode;
  // If audio is already playing for THIS column, treat the press as a control,
  // never a re-synth:
  //   - exact same source (same button/mode): pause/resume toggle.
  //   - different source for the same column (auto-play, or the OTHER mode
  //     button): stop it outright (no restart, no API call).
  if (currentVoiceAudio && currentVoiceAudio.__colId === colId) {
    if (currentVoiceAudio.__src === srcKey) {
      if (currentVoiceAudio.paused) { currentVoiceAudio.play().catch(function () {}); }
      else { currentVoiceAudio.pause(); }
    } else {
      stopAllVoice();
    }
    refreshVoiceButtonStates();
    return;
  }
  var col = allColumns.get(colId);
  vlog('manual play', { colId: colId, readingMode: readingMode, haveSettings: !!voiceSettings, voiceId: voiceSettings && voiceSettings.voiceId, sessionId: col && col.sessionId, projectKey: col && col.projectKey, cwd: col && col.cwd, transcriptPath: col && col.voiceTranscriptPath });
  if (!col) return;
  col.voiceCache = col.voiceCache || {};
  voiceStreamGen++; // a manual press supersedes any in-flight auto-play stream
  voiceAutoQueue = null; // a manual/catch-up play cancels any queued auto reply
  if (!voiceSettings && window.__refreshVoiceSettings) await window.__refreshVoiceSettings();
  if (!voiceSettings || !voiceSettings.voiceId) return; // no voice configured
  // Try the live screen first so Play works on fresh columns whose reply hasn't
  // been flushed to the transcript yet. All modes are handled here now — the 🔊
  // summary line IS present in the rendered prose, so cleanTerminalSpoken can
  // extract it for 'summary'/'auto'; the transcript fallback below covers the
  // case where the terminal yields nothing speakable.
  {
    var termLines = readColumnTerminalLines(col);
    var rawReply = (window.TerminalReply && window.TerminalReply.extractLastTerminalReply(termLines)) || '';
    var spokenTerm = cleanTerminalSpoken(rawReply, readingMode);
    vlog('manual terminal reply', { colId: colId, len: spokenTerm.length, head: spokenTerm.slice(0, 60) });
    if (spokenTerm) {
      // Cache hit: same column + mode + identical text -> replay without a new
      // ElevenLabs call. A new reply changes the text, so the comparison misses
      // and we re-synth naturally.
      var cachedT = col.voiceCache[srcKey];
      if (cachedT && cachedT.text === spokenTerm && cachedT.result) {
        vlog('manual cache hit (terminal)', { colId: colId, srcKey: srcKey });
        col.voiceUnspoken = false; col.lastSpokenText = spokenTerm;
        playVoiceAudio(cachedT.result, undefined, undefined, srcKey, colId); refreshVoiceButtonStates();
        return;
      }
      try {
        var tresult = await window.electronAPI.synthesizeVoice({ text: spokenTerm, voiceId: voiceSettings.voiceId, modelId: voiceSettings.modelId, auto: true });
        vlog('manual synth (terminal)', { ok: tresult && tresult.ok, error: tresult && tresult.error, status: tresult && tresult.status, hasB64: !!(tresult && tresult.base64) });
        if (tresult && tresult.ok) {
          col.voiceCache[srcKey] = { text: spokenTerm, result: tresult };
          col.voiceUnspoken = false; col.lastSpokenText = spokenTerm; playVoiceAudio(tresult, undefined, undefined, srcKey, colId); refreshVoiceButtonStates();
          // Advance the transcript baseline too, so a later auto Stop that falls
          // back to the transcript path doesn't re-speak this just-played reply.
          if (window.electronAPI.peekColumn) {
            window.electronAPI.peekColumn({ transcriptPath: col.voiceTranscriptPath || '', projectKey: col.projectKey, cwd: col.cwd || col.projectKey, sessionId: col.sessionId })
              .then(function (r) { if (r && r.ok && r.uuid) col.lastSpokenUuid = r.uuid; }).catch(function () {});
          }
        }
        return;
      } catch (e) {}
    }
  }
  // Transcript fallback: the spoken text is computed in main from the JSONL, so
  // the renderer can't pre-compare it — and keying on col.lastSpokenUuid is
  // unsafe (it lags: only advances after a synth/auto-play, not when a reply
  // arrives unspoken), which could replay a stale reply's audio. So this path is
  // intentionally NOT cached — it synthesizes and plays every time.
  try {
    var result = await window.electronAPI.synthesizeVoiceColumn({
      projectKey: col.projectKey, cwd: col.cwd || col.projectKey, sessionId: col.sessionId, transcriptPath: col.voiceTranscriptPath || '',
      readingMode: readingMode, voiceId: voiceSettings.voiceId, modelId: voiceSettings.modelId, maxChars: voiceSettings.maxChars
    });
    vlog('manual synth', { ok: result && result.ok, error: result && result.error, status: result && result.status, hasB64: !!(result && result.base64), diag: result && result.diag });
    if (result && result.ok) { col.voiceUnspoken = false; playVoiceAudio(result, undefined, undefined, srcKey, colId); refreshVoiceButtonStates(); if (result.uuid) col.lastSpokenUuid = result.uuid; }
  } catch (e) {}
}

function playVoiceAudio(result, onEnded, onError, srcKey, colId) {
  vlog('playVoiceAudio', { ok: result && result.ok, hasB64: !!(result && result.base64), srcKey: srcKey, colId: colId });
  if (!result || !result.ok || !result.base64) {
    vlog('playVoiceAudio SKIP (no audio/base64)');
    if (typeof onEnded === 'function') { try { onEnded(); } catch (e) {} }
    return;
  }
  // Single-flight per window: never overlap two utterances.
  if (currentVoiceAudio) {
    try { currentVoiceAudio.pause(); } catch (e) {}
    var prevOnEnded = currentVoiceAudio.__onEnded;
    if (prevOnEnded) { try { currentVoiceAudio.removeEventListener('ended', prevOnEnded); } catch (e) {} }
    currentVoiceAudio = null;
    if (typeof prevOnEnded === 'function') { try { prevOnEnded(); } catch (e) {} } // settle any awaiting stream so it can cancel cleanly
  }
  // Audio bytes arrive as base64 (binary over contextBridge is unreliable); play
  // via a data: URL so Chromium decodes the MP3 directly.
  var audio = new Audio('data:' + (result.mime || 'audio/mpeg') + ';base64,' + result.base64);
  // Source key (colId + ':' + readingMode) lets the header buttons toggle
  // play/pause/resume against the element. Non-button callers leave it null.
  audio.__src = srcKey || null;
  // Owning column id — set even for auto-play (which has no srcKey) so a manual
  // button press on the speaking column can recognise it as "this column" and
  // stop it rather than re-synthesizing. Falls back to the srcKey's colId.
  audio.__colId = colId || (srcKey ? String(srcKey).split(':')[0] : null);
  currentVoiceAudio = audio;
  var endedHandler = function () {
    if (currentVoiceAudio === audio) currentVoiceAudio = null;
    refreshVoiceButtonStates();
    if (typeof onEnded === 'function') { try { onEnded(); } catch (e) {} }
    // A manual/catch-up playback just ended (auto-play sets voiceAutoBusy and
    // drains via its own finally). If an auto reply deferred while this clip was
    // talking, play it now — auto-play waits its turn, never interrupts.
    try {
      if (!voiceAutoBusy && voiceAutoQueue && !isVoicePlaying()) {
        var _q = voiceAutoQueue; voiceAutoQueue = null;
        Promise.resolve(runAutoStream(_q)).catch(function () {});
      }
    } catch (e) {}
  };
  audio.__onEnded = endedHandler;
  audio.addEventListener('ended', endedHandler);
  audio.addEventListener('play', function () { refreshVoiceButtonStates(); });
  audio.addEventListener('pause', function () { refreshVoiceButtonStates(); });
  audio.addEventListener('error', function () {
    if (currentVoiceAudio === audio) currentVoiceAudio = null;
    try { refreshVoiceButtonStates(); } catch (e) {}
    if (typeof onError === 'function') { try { onError(audio.error || new Error('audio error')); } catch (e) {} }
    // Mirror endedHandler: a manual/catch-up clip that errored shouldn't strand a
    // deferred auto reply (auto-play waits behind active playback).
    try {
      if (!voiceAutoBusy && voiceAutoQueue && !isVoicePlaying()) {
        var _q = voiceAutoQueue; voiceAutoQueue = null;
        Promise.resolve(runAutoStream(_q)).catch(function () {});
      }
    } catch (e) {}
  });
  vlog('audio.play() ' + (result.mime || 'audio/mpeg') + ' b64len=' + (result.base64 ? result.base64.length : 0));
  audio.play().catch(function (err) {
    vlog('audio.play() rejected', String(err));
    if (typeof onError === 'function') { try { onError(err); } catch (e) {} }
  });
  refreshVoiceButtonStates();
}

// Reflect the current playback element's state on every column voice button.
// A button's source is `<colId>:full` / `<colId>:summary` (derived from its
// dataset.id). The button driving the current, non-paused element shows as
// "playing"; the same source while paused shows "paused"; all others reset.
function refreshVoiceButtonStates() {
  var src = currentVoiceAudio ? currentVoiceAudio.__src : null;
  var playingColId = currentVoiceAudio ? currentVoiceAudio.__colId : null;
  var paused = currentVoiceAudio ? currentVoiceAudio.paused : true;
  // Mark the column that is currently SPEAKING so its header shows an at-a-glance
  // indicator. Only while audio is actually producing sound (not paused/ended).
  var speakingNow = !!(currentVoiceAudio && !currentVoiceAudio.paused && !currentVoiceAudio.ended);
  try {
    allColumns.forEach(function (c, cid) {
      if (c && c.element) c.element.classList.toggle('voice-speaking', speakingNow && playingColId != null && String(cid) === String(playingColId));
    });
  } catch (e) {}
  // Toolbar Stop button lights up only while audio is actually playing.
  var stopBtn = document.getElementById('btn-voice-stop');
  if (stopBtn) {
    var speaking = !!(currentVoiceAudio && !currentVoiceAudio.paused && !currentVoiceAudio.ended);
    stopBtn.classList.toggle('speaking', speaking);
  }
  var btns = document.querySelectorAll('.col-play-full,.col-play-summary');
  for (var i = 0; i < btns.length; i++) {
    var btn = btns[i];
    var isSummary = btn.classList.contains('col-play-summary');
    var btnColId = btn.dataset.id || '';
    var btnSrc = btnColId + ':' + (isSummary ? 'summary' : 'full');
    var defaultTitle = isSummary ? 'Play summary' : 'Play reply';
    if (src && btnSrc === src && paused) {
      // Manual element for THIS exact button, paused -> resume affordance.
      btn.classList.remove('voice-playing');
      btn.classList.add('voice-paused');
      btn.title = 'Resume';
    } else if (playingColId != null && String(btnColId) === String(playingColId) && !paused) {
      // Anything playing for this column (manual OR auto-play, where __src may not
      // be a colId:mode key) -> the column's buttons act as Stop.
      btn.classList.add('voice-playing');
      btn.classList.remove('voice-paused');
      btn.title = 'Stop';
    } else {
      btn.classList.remove('voice-playing');
      btn.classList.remove('voice-paused');
      btn.title = defaultTitle;
    }
  }
}
window.__playVoiceTest = playVoiceAudio;

// Instantly silence current + queued speech without touching the `enabled`
// setting. Bumps the stream generation (cancels any in-flight auto-play),
// pauses the current element and settles its awaiting promise so the stream
// loop unwinds cleanly.
function stopAllVoice() {
  voiceStreamGen++;
  voiceAutoQueue = null;   // explicit stop clears any queued auto reply so the in-flight stream's finally drains nothing
  if (currentVoiceAudio) {
    try { currentVoiceAudio.pause(); } catch (e) {}
    var pe = currentVoiceAudio.__onEnded;
    if (pe) { try { currentVoiceAudio.removeEventListener('ended', pe); } catch (e) {} }
    currentVoiceAudio = null;
    if (typeof pe === 'function') { try { pe(); } catch (e) {} }
  }
}

// Reflect the cached global `enabled` flag on the toolbar toggle button.
function updateVoiceToggleUI() {
  var btn = document.getElementById('btn-voice-toggle');
  if (!btn) return;
  var on = !!(voiceSettings && voiceSettings.enabled);
  if (on) {
    btn.classList.remove('voice-off');
    btn.title = 'Voice output: on — click to disable';
  } else {
    btn.classList.add('voice-off');
    btn.title = 'Voice output: off — click to enable';
  }
}

// True when the project owning `projectKey` has its voice muted. Only gates
// auto-play + focus catch-up — manual per-column buttons ignore this.
function isProjectVoiceMuted(projectKey) {
  try {
    var p = config && config.projects && config.projects.find(function (x) { return x.path === projectKey; });
    return !!(p && p.voiceMuted);
  } catch (e) { return false; }
}

// When the window regains focus, replay the currently-focused column's unspoken
// reply — same catch-up the column-click path does. Defined before the focus
// listener references it (function declaration is hoisted regardless).
function onVoiceWindowRefocus() {
  try {
    if (!voiceSettings || !voiceSettings.enabled) return;
    // Catch up the ATTENDED column, not lastFocusedColumnId. lastFocusedColumnId
    // is rewritten by EVERY setFocusedColumn — including programmatic survivor-
    // refocus / maximize / minimize / restore — so using it could speak a column
    // the user never attended on alt-tab-back. voiceAttentionColumnId only tracks
    // genuine user focus/typing and is nulled on programmatic project switches,
    // so null here means "nothing the user was attending" -> no catch-up (safe).
    var foundId = voiceAttentionColumnId;
    if (foundId == null) return;
    var fcol = allColumns.get(foundId);
    if (fcol && fcol.voiceUnspoken && voiceSettings.focusCatchUp !== false && !isProjectVoiceMuted(fcol.projectKey)) {
      fcol.voiceUnspoken = false;
      vlog('catchup window-refocus', { colId: foundId });
      playColumnReply(foundId, voiceSettings.readingMode || 'auto');
    }
  } catch (e) {}
}

// Event-tracked window focus — more reliable than polling document.hasFocus()
// from inside the hook handler (which can return stale values in Electron).
var voiceWindowFocused = (typeof document !== 'undefined' && document.hasFocus && document.hasFocus());
window.addEventListener('focus', function () { voiceWindowFocused = true; onVoiceWindowRefocus(); });
window.addEventListener('blur', function () { voiceWindowFocused = false; });

// `voiceAttentionColumnId` is "the column the user last GENUINELY focused". It is
// set ONLY by a real user focus (setFocusedColumn with userFocus:true) or by
// typing into a column's terminal (onData real-input branch) — NOT by clicking
// the sidebar/explorer/toolbar. Glancing at the sidebar while a reply is pending
// therefore no longer mutes voice. It is nulled on a programmatic project/
// workspace switch (setActiveWorkspace / activatePopoutProject) so a still-live
// background column never auto-speaks once the user has navigated away; it
// re-arms when the user clicks or types in the now-visible column.

(function wireVoiceToolbar() {
  var stopBtn = document.getElementById('btn-voice-stop');
  if (stopBtn) stopBtn.addEventListener('click', function () { stopAllVoice(); });
  var toggleBtn = document.getElementById('btn-voice-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', async function () {
      var en = !(voiceSettings && voiceSettings.enabled);
      if (window.electronAPI && window.electronAPI.setVoiceSettings) {
        await window.electronAPI.setVoiceSettings({ enabled: en });
      }
      var enChk = document.getElementById('setting-voice-enabled');
      if (enChk) enChk.checked = en;
      if (window.__refreshVoiceSettings) await window.__refreshVoiceSettings();
      if (!en) stopAllVoice();
      updateVoiceToggleUI();
    });
  }
})();

if (window.electronAPI && window.electronAPI.onVoiceHookEvent) {
  window.electronAPI.onVoiceHookEvent(async function (event) {
    var colId = clawdResolveHookColumn(event);
    vlog('hook recv', { evt: (event && (event.hook_event_name || event.event)), sid: event && event.session_id, cwd: event && event.cwd, colId: colId });
    if (colId == null) return;  // not this window's column
    if (!voiceSettings) {
      try { await window.__refreshVoiceSettings(); } catch (e) {}
    }
    if (!voiceSettings || !voiceSettings.enabled) return;
    var evtName = (event && (event.hook_event_name || event.event)) || '';
    if (evtName === 'SubagentStop') return;  // subagent stops must never drive voice
    var col = allColumns.get(colId);
    if (!col) return;
    var sid = event && event.session_id;
    var sidMatchesColumn = !!(col && col.sessionId && col.sessionId === sid);
    // Background runs (automations / headless agents / managers) must NEVER drive
    // voice — not auto-play, and not the catch-up arming below (voiceUnspoken /
    // voiceTranscriptPath). They are tagged __claudesBackground by the main process
    // (their session_id is in backgroundSessionIds while the run is live). We drop
    // them even when they match a column's own session: a column can BE a live
    // automation's session (its reply is automation output the user clicked into),
    // and the v1.9.3 sid-match exception let that output speak via focus catch-up.
    // The explicit per-column Play button is a separate path and still works as the
    // user's deliberate escape hatch if they ever want to hear an automation column.
    if (event && event.__claudesBackground) {
      try { vlog && vlog('drop background event', { sid: sid, sidMatchesColumn: sidMatchesColumn }); } catch (e) {}
      return;
    }
    // A column whose sessionId hasn't been detected yet (null) owns the reply that
    // resolved to it via the unambiguous-cwd fallback (subagents fire only later,
    // after the parent session is established). Allow recording its path + unspoken
    // flag so focus catch-up can still speak the first reply — but keep AUTO-speak
    // eligibility strict (sidMatchesColumn) to avoid ever auto-speaking a subagent.
    var voiceOwnsReply = sidMatchesColumn || !col.sessionId;
    if (isProjectVoiceMuted(col.projectKey)) return;  // muted project: no auto-speak / catch-up flag
    var state = projectStates.get(stateKey(col.projectKey, col.workspaceId));
    if (!state) return;
    // "Active" for auto-play means this is the column the user is ATTENDING
    // (last clicked/typed in) — INDEPENDENT of whether the app window is focused,
    // so a reply that lands while they've tabbed away still speaks (the whole point
    // of voice: listen while doing something else). Attribution is gated by
    // sidMatchesColumn, so only the genuinely-attended column ever speaks — never a
    // random one. mode 'all' ignores this (handled below).
    var isActive = voiceAttentionColumnId === colId;
    var eligible = false;
    switch (voiceSettings.mode) {
      case 'all': eligible = (evtName === 'Stop' && sidMatchesColumn); break;
      case 'notify': eligible = (evtName === 'Notification'); break;
      case 'active+notify': eligible = (evtName === 'Stop' && sidMatchesColumn && isActive) || evtName === 'Notification'; break;
      case 'active':
      default: eligible = (evtName === 'Stop' && sidMatchesColumn && isActive); break;
    }
    // Remember where this reply lives so manual/catch-up playback can re-read it.
    // Only for the column's OWN session — a subagent/automation Stop shares the cwd
    // but has a different session_id, and must not overwrite the column's transcript.
    if (evtName === 'Stop' && event.transcript_path && voiceOwnsReply) col.voiceTranscriptPath = event.transcript_path;
    // An owned Stop has NOT been spoken yet at this point — mark it pending
    // (unspoken) unconditionally. The speak paths (streamSpeakText /
    // streamSpeakColumn / playColumnReply) clear it the moment they actually run.
    // Pre-clearing it to !eligible was a bug: when an eligible reply later bailed
    // the 250ms settle re-check, it stayed false and the catch-up paths (typing /
    // focus / window-refocus, all gated on voiceUnspoken===true) could never
    // replay it -> permanent silence until a manual press. Leaving it true means
    // eligible+speaks clears it (no double-speak, dedup on lastSpokenText also
    // guards), while eligible-but-settle-bails OR ineligible stays true so the
    // catch-up recovers it. Track only for the column's own session.
    if (evtName === 'Stop' && voiceOwnsReply) col.voiceUnspoken = true;
    // Capture the pre-turn message uuid the moment the user submits, so a later
    // Stop can poll for the FRESH reply (uuid !== baseline) instead of racing the
    // transcript flush and speaking the previous turn.
    if (evtName === 'UserPromptSubmit' && sidMatchesColumn && window.electronAPI.peekColumn) {
      window.electronAPI.peekColumn({ transcriptPath: col.voiceTranscriptPath || '', projectKey: col.projectKey, cwd: col.cwd || col.projectKey, sessionId: col.sessionId })
        .then(function (r) { if (r && r.ok) col.voicePreTurnUuid = r.uuid; }).catch(function () {});
    }
    vlog('hook decision', { evt: evtName, colId: colId, enabled: !!(voiceSettings && voiceSettings.enabled), mode: voiceSettings && voiceSettings.mode, voiceId: voiceSettings && voiceSettings.voiceId, focusedColumnId: state && state.focusedColumnId, winFocused: voiceWindowFocused, isActive: isActive, muted: isProjectVoiceMuted(col.projectKey), eligible: eligible, autoBusy: voiceAutoBusy, sidMatchesColumn: sidMatchesColumn, colSid: col && col.sessionId, evtSid: sid, unspoken: col && col.voiceUnspoken, bg: !!(event && event.__claudesBackground), attention: voiceAttentionColumnId, lastFocused: lastFocusedColumnId });
    if (!eligible) return;
    try {
      var result;
      if (evtName === 'Notification') {
        var msg = (event.message || '').trim();
        if (!msg) return;
        result = await window.electronAPI.synthesizeVoice({
          text: msg, voiceId: voiceSettings.voiceId, modelId: voiceSettings.modelId, auto: true,
        });
        if (result && result.ok) playVoiceAudio(result);
      } else {
        if (event.transcript_path && sidMatchesColumn) col.voiceTranscriptPath = event.transcript_path;
        // Real-time win: try reading the reply straight off the column's screen
        // BEFORE the transcript path. Interactive columns often haven't flushed
        // the reply to the JSONL yet, but it's already rendered. A short settle
        // delay lets the final line paint before we read the buffer.
        // Capture the stream generation BEFORE the settle await: a manual Play or
        // a newer Stop during the 250ms window must win, so bail if it advanced.
        var settleGen = voiceStreamGen;
        await new Promise(function (r) { setTimeout(r, 250); });
        if (voiceStreamGen !== settleGen) { vlog('settle bail', { colId: colId, reason: 'superseded' }); return; }  // superseded during settle (manual/newer Stop)
        if (!voiceSettings || !voiceSettings.enabled) { vlog('settle bail', { colId: colId, reason: 'disabled' }); return; }  // re-check after the await
        // Re-evaluate eligibility after the await — focus/mute can change in 250ms.
        if (isProjectVoiceMuted(col.projectKey)) { vlog('settle bail', { colId: colId, reason: 'muted' }); return; }
        var stillActive = voiceAttentionColumnId === colId;  // window focus no longer required (see isActive above)
        var stillEligible = false;
        switch (voiceSettings.mode) {
          case 'all': stillEligible = sidMatchesColumn; break;
          case 'active+notify': stillEligible = sidMatchesColumn && stillActive; break;
          case 'active':
          default: stillEligible = sidMatchesColumn && stillActive; break;
        }
        if (!stillEligible) { vlog('settle bail', { colId: colId, reason: 'not-still-eligible', stillActive: stillActive }); return; }  // user clicked away / muted during the settle
        vlog('settle ok', { colId: colId });
        var termLines = readColumnTerminalLines(col);
        var rawReply = (window.TerminalReply && window.TerminalReply.extractLastTerminalReply(termLines)) || '';
        // Apply the Reading mode here so the dedup string AND the spoken audio
        // are the exact same mode-applied text (in 'auto'/'summary' that's just
        // the 🔊 line when present; in 'full' it's the body without that line).
        var spokenTerm = cleanTerminalSpoken(rawReply, voiceSettings.readingMode);
        vlog('terminal reply', { colId: colId, len: spokenTerm.length, head: spokenTerm.slice(0, 60) });
        if (spokenTerm && spokenTerm !== col.lastSpokenText) {
          col.lastSpokenText = spokenTerm;  // dedup: never auto-speak the same reply twice
          var treq = { colId: colId, readingMode: voiceSettings.readingMode, spokenText: spokenTerm };
          vlog('auto eligible (terminal) -> ' + (voiceAutoBusy ? 'QUEUED (busy)' : 'run'), { colId: colId });
          if (voiceAutoBusy || isVoicePlaying()) { voiceAutoQueue = treq; return; }  // defer behind ANY active playback (auto OR manual/catch-up)
          // NOT awaited (sets voiceAutoBusy synchronously before returning); a
          // stray async throw is an intended best-effort no-op, not an unhandledrejection.
          Promise.resolve(runAutoStream(treq)).catch(function () {});
          return;                // terminal path handled it; skip the transcript fallback
        }
        // Fallback: terminal yielded nothing new -> use the transcript poll so
        // old/persisted replies still speak.
        var req = { colId: colId, readingMode: voiceSettings.readingMode, baselineUuid: col.voicePreTurnUuid || col.lastSpokenUuid || '' };
        vlog('auto eligible -> ' + (voiceAutoBusy ? 'QUEUED (busy)' : 'run'), req);
        if (voiceAutoBusy || isVoicePlaying()) { voiceAutoQueue = req; return; }  // guard: don't interrupt an in-progress utterance (auto OR manual/catch-up); queue the latest
        // NOT awaited (sets voiceAutoBusy synchronously before returning); swallow
        // a stray async throw so it stays a best-effort no-op, not an unhandledrejection.
        Promise.resolve(runAutoStream(req)).catch(function () {});
      }
    } catch (e) { /* best-effort playback */ }
  });
  window.__refreshVoiceSettings().then(updateVoiceToggleUI);
}

// Any window saving voice settings broadcasts `voice:settingsChanged`; every
// window re-reads its cache so popouts don't keep stale mode/voice/enabled.
if (window.electronAPI && window.electronAPI.onVoiceSettingsChanged) {
  window.electronAPI.onVoiceSettingsChanged(async function () {
    if (window.__refreshVoiceSettings) await window.__refreshVoiceSettings();
    updateVoiceToggleUI();
    var enChk = document.getElementById('setting-voice-enabled');
    if (enChk && voiceSettings) enChk.checked = !!voiceSettings.enabled;
    // Voice/model/tuning changed: drop cached audio so the next play re-synthesizes
    // with the new settings (the cache key is colId:readingMode, not voice-aware).
    try { allColumns.forEach(function (c) { if (c) c.voiceCache = {}; }); } catch (e) {}
  });
}

if (window.electronAPI && window.electronAPI.getHookServerPort) {
  window.electronAPI.getHookServerPort().then(function (port) {
    if (port) console.log('[hooks] Hook server at http://127.0.0.1:' + port + '/hook');
  });
}

// Manual recovery for the case where a hook gets dropped (e.g. PostToolUse
// never arrives) and Clawd is parked on a stale tool animation. Resets every
// column to idle as a safe baseline and re-arms the JSONL tail so the
// fallback resumes — the next real activity will set the correct state.
function clawdForceRefresh() {
  if (typeof allColumns === 'undefined' || !allColumns || !allColumns.forEach) return;
  var resetCount = 0;
  allColumns.forEach(function (col, id) {
    if (col && col.sessionId) clawdHookSeenBySession[col.sessionId] = false;
    if (col) col.clawdTailSessionId = null;
    if (window.Clawd && window.Clawd.setColumnAnimation) {
      window.Clawd.setColumnAnimation(id, 'idle');
    }
    if (typeof ensureClawdTail === 'function') ensureClawdTail(id);
    resetCount++;
  });
  if (window.Clawd && window.Clawd.logHookEvent) {
    window.Clawd.logHookEvent({ col: null, event: 'manual-refresh', tool: '', matcher: '', anim: 'idle (x' + resetCount + ')' });
  }
}

(function () {
  var btn = document.getElementById('clawd-debug-refresh');
  if (btn) btn.addEventListener('click', clawdForceRefresh);
})();

// ============================================================
// Init
// ============================================================

btnAdd.addEventListener('click', async function () {
  if (optHeadless.checked) {
    // Consume the transient flag immediately — don't persist it.
    optHeadless.checked = false;
    closeSpawnDropdown();
    openHeadlessDock();
    return;
  }
  if (btnAdd.disabled) return;
  btnAdd.disabled = true;
  try {
    var projectAtClick = activeProjectKey;
    var raw = optWorktree.value.trim();
    var resolved = { kind: 'none' };
    if (raw && projectAtClick) {
      resolved = await window.electronAPI.resolveWorktree(projectAtClick, raw);
    }
    if (activeProjectKey !== projectAtClick) return;
    var spawnOpts = {};
    if (resolved.kind === 'cwd') {
      spawnOpts.cwd = resolved.path;
      spawnOpts.cwdSource = 'manual';
    }
    var args = buildSpawnArgs(resolved);
    addColumn(args.length > 0 ? args : null, null, spawnOpts);
  } finally {
    btnAdd.disabled = false;
  }
});
btnAddRow.addEventListener('click', addRow);
btnToggleSidebar.addEventListener('click', toggleSidebar);
themeSelect.addEventListener('change', function () {
  setThemePreference(themeSelect.value);
  config.theme = themeSelect.value;
  saveConfig();
});

// Prevent theme select interactions from closing the toolbar menu
themeSelect.addEventListener('mousedown', function (e) { e.stopPropagation(); });
themeSelect.addEventListener('click', function (e) { e.stopPropagation(); });

// Keep toolbar menu visible while select is open
var themeSelectOpen = false;
themeSelect.addEventListener('focus', function () { themeSelectOpen = true; });
themeSelect.addEventListener('blur', function () {
  themeSelectOpen = false;
  // Close menu after a short delay to let change event fire
  setTimeout(function () {
    if (!themeSelectOpen) toolbarMenu.classList.add('hidden');
  }, 100);
});

btnAddProject.addEventListener('click', function () {
  if (!window.electronAPI) return;
  window.electronAPI.openDirectoryDialog().then(function (folderPath) {
    if (folderPath) addProject(folderPath);
  });
});

var btnToggleSort = document.getElementById('btn-toggle-sort');
if (btnToggleSort) {
  btnToggleSort.addEventListener('click', toggleProjectSortMode);
}

// ============================================================
// Spawn Options Dropdown
// ============================================================

function toggleSpawnDropdown() {
  spawnDropdown.classList.toggle('hidden');
}

function closeSpawnDropdown() {
  spawnDropdown.classList.add('hidden');
}

function buildSpawnArgs(resolved) {
  var args = [];
  // Permission mode -> flags. bypassPermissions emits the legacy
  // --dangerously-skip-permissions (the automation de-dupe guard and the
  // proxy-auth / --bare paths key on that exact string, and the CLI rejects
  // bypassPermissions as a --permission-mode choice); plan/acceptEdits/dontAsk/
  // auto emit --permission-mode <mode>; default emits nothing. Pure, unit-tested
  // mapping in lib/permission-mode.js.
  Array.prototype.push.apply(args, PermissionMode.permissionModeToArgs(optPermissionMode.value));
  if (optRemoteControl.checked) {
    args.push('--remote-control');
  }
  // Force --bare whenever the endpoint env carries an Authorization custom
  // header (set by main.js when the base URL has user:pass@). Reasoning:
  //   - ANTHROPIC_AUTH_TOKEN sends `Authorization: Bearer ...` which collides
  //     with our `Authorization: Basic ...` at the proxy and 401s ngrok.
  //   - The collision-free alternative is ANTHROPIC_API_KEY (sent as x-api-key,
  //     not Authorization), but Claude prompts to confirm any non-bare API key.
  //   - --bare trusts ANTHROPIC_API_KEY without prompting, so it's the only
  //     combo that actually communicates.
  var endpointEnv = currentEndpointEnv || {};
  var needsBareForProxyAuth = !!endpointEnv.ANTHROPIC_CUSTOM_HEADERS;
  if (optBare.checked || needsBareForProxyAuth) {
    args.push('--bare');
  }
  // --bare and --strict-mcp-config are independent: bare covers hooks/LSP/
  // plugins/CLAUDE.md, strip-mcps covers MCP servers. Locally you usually
  // want bare on (smaller startup) but MCPs available (otherwise the model
  // has no tools beyond bash/file ops). Toggle each independently.
  if (optStripMcps.checked) {
    args.push('--strict-mcp-config');
    args.push('--mcp-config', '{"mcpServers":{}}');
  }
  // The CLI's --model flag overrides ANTHROPIC_MODEL env, so when an endpoint
  // preset is active we skip it — the env block already pins every model tier
  // to the preset's model and CLI flags would override that.
  if (optModel.value && !currentEndpointId) {
    args.push('--model', optModel.value);
  }
  var worktree = optWorktree.value.trim();
  if (worktree) {
    if (!resolved || resolved.kind === 'flag' || resolved.kind === 'none') {
      args.push('--worktree', worktree);
    }
  }
  // --effort is the only non-interactive way to set reasoning effort. The
  // /effort slash command opens an interactive arrow-key picker and `/config
  // set effort` doesn't exist, so this flag is the lever. Cloud and local get
  // separate user-configurable defaults.
  var effort = currentEndpointId ? defaultEffortLocal : defaultEffortCloud;
  if (isValidEffort(effort)) {
    args.push('--effort', effort);
  }
  var custom = optCustomArgs.value.trim();
  if (custom) {
    var parts = custom.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    for (var i = 0; i < parts.length; i++) {
      args.push(parts[i].replace(/^"|"$/g, ''));
    }
  }
  return args;
}

function truncateLabel(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function updateSpawnButtonLabel() {
  var tags = [];
  var preset = currentEndpointId
    ? endpointPresets.find(function (p) { return p.id === currentEndpointId; })
    : null;
  if (preset) {
    tags.push(truncateLabel(preset.name || 'endpoint', 16));
  } else if (optModel && optModel.value) {
    tags.push(optModel.value);
  }
  var permMode = optPermissionMode.value;
  if (permMode === 'bypassPermissions') tags.push('yolo');
  else if (permMode && permMode !== 'default') tags.push(permMode);
  if (optRemoteControl.checked) tags.push('remote');
  if (optBare.checked || (currentEndpointEnv && currentEndpointEnv.ANTHROPIC_CUSTOM_HEADERS)) tags.push('bare');
  if (optStripMcps.checked) tags.push('no-mcp');
  if (optUseHeadroom && optUseHeadroom.checked) tags.push('headroom');
  if (optWorktree.value.trim()) tags.push('worktree');
  if (optCustomArgs.value.trim()) tags.push('custom');

  if (tags.length > 0) {
    btnAdd.textContent = '+ Spawn \u00b7 ' + tags.join(' \u00b7 ');
    btnAdd.classList.add('has-options');
    btnAddOptions.classList.add('has-options');
  } else {
    btnAdd.textContent = '+ Spawn Claude';
    btnAdd.classList.remove('has-options');
    btnAddOptions.classList.remove('has-options');
  }
}

function saveSpawnOptions() {
  if (config.activeProjectIndex == null || !config.projects[config.activeProjectIndex]) return;
  config.projects[config.activeProjectIndex].spawnOptions = {
    permissionMode: optPermissionMode.value,
    remoteControl: optRemoteControl.checked,
    bare: optBare.checked,
    stripMcps: optStripMcps.checked,
    model: optModel.value,
    worktree: optWorktree.value,
    customArgs: optCustomArgs.value,
    endpointId: currentEndpointId || null,
    endpointModel: currentEndpointModel || null
  };
  saveConfig();
}

function loadSpawnOptions() {
  var opts = {};
  if (config.activeProjectIndex != null && config.projects[config.activeProjectIndex]) {
    opts = config.projects[config.activeProjectIndex].spawnOptions || {};
  }
  optPermissionMode.value = PermissionMode.migratePermissionMode(opts);
  optRemoteControl.checked = !!opts.remoteControl;
  optBare.checked = !!opts.bare;
  optStripMcps.checked = !!opts.stripMcps;
  optModel.value = opts.model || '';
  optWorktree.value = opts.worktree || '';
  optCustomArgs.value = opts.customArgs || '';

  // First call on app boot always defaults to cloud (Anthropic), regardless of
  // what was saved. Subsequent calls (project switches within the session)
  // respect the saved endpointId.
  var endpointId;
  if (!firstSpawnLoadComplete) {
    endpointId = null;
    firstSpawnLoadComplete = true;
  } else {
    // If the persisted endpointId no longer refers to a known preset (deleted in
    // the meantime), silently fall back to the default Anthropic endpoint.
    endpointId = opts.endpointId || null;
    if (endpointId && !endpointPresets.find(function (p) { return p.id === endpointId; })) {
      endpointId = null;
    }
  }
  // Restore the per-project model selection BEFORE applyEndpointSelection so
  // populateEndpointModelDropdown can preselect it.
  currentEndpointModel = endpointId ? (opts.endpointModel || null) : null;
  applyEndpointSelection(endpointId, /* persist */ false);
  // Headroom is a GLOBAL toggle (not part of the per-project spawnOptions object).
  // Refresh the whole Headroom UI here — parent checkbox AND the sub-toggles
  // (1M/Memory/Output shaper) — so the subs never keep a stale enabled/disabled
  // state from an earlier boot pass when the async `headroom` probe hadn't resolved.
  applyHeadroomUiState();
  updateSpawnButtonLabel();
}

// Returns an opts object for addColumn, including the endpoint env if a preset
// is active. Spread any caller-supplied opts on top.
function spawnOpts(extra) {
  var o = {};
  if (extra) {
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
    }
  }
  if (currentEndpointEnv) o.env = currentEndpointEnv;
  return o;
}

btnAddOptions.addEventListener('click', function (e) {
  e.stopPropagation();
  toggleSpawnDropdown();
});

// Update button label and persist when any option changes
function onSpawnOptionChanged() { updateSpawnButtonLabel(); saveSpawnOptions(); }
optPermissionMode.addEventListener('change', onSpawnOptionChanged);
optRemoteControl.addEventListener('change', onSpawnOptionChanged);
optBare.addEventListener('change', onSpawnOptionChanged);
optStripMcps.addEventListener('change', onSpawnOptionChanged);
optModel.addEventListener('change', onSpawnOptionChanged);
optWorktree.addEventListener('input', onSpawnOptionChanged);
optCustomArgs.addEventListener('input', onSpawnOptionChanged);

// --- Headroom toggle wiring ---
// The checkbox reflects a GLOBAL flag (config.useHeadroom), and is only usable
// when the `headroom` binary is detected on the host. When it's missing we
// disable the toggle and surface an install hint instead of silently no-opping.
function applyHeadroomUiState() {
  if (!optUseHeadroom) return;
  if (headroomInstalled) {
    optUseHeadroom.disabled = false;
    if (headroomLabel) headroomLabel.classList.remove('is-disabled');
    optUseHeadroom.checked = !!(config && config.useHeadroom);
    if (headroomDashboardLink) headroomDashboardLink.classList.remove('hidden');
    if (headroomRequiredNote) headroomRequiredNote.classList.add('hidden');
  } else {
    optUseHeadroom.disabled = true;
    optUseHeadroom.checked = false;
    if (headroomLabel) headroomLabel.classList.add('is-disabled');
    if (headroomDashboardLink) headroomDashboardLink.classList.add('hidden');
    if (headroomRequiredNote) headroomRequiredNote.classList.remove('hidden');
  }
  // 1M is a per-column env toggle in the spawn dropdown — usable only when
  // Headroom is installed AND this column's parent "Use Headroom" is on. It
  // defaults ON (undefined !== false).
  var subsUsable = headroomInstalled && !!(config && config.useHeadroom);
  if (optHeadroom1m) { optHeadroom1m.disabled = !subsUsable; optHeadroom1m.checked = !!(config && config.useHeadroom1m !== false); }
  if (headroomSubs) headroomSubs.classList.toggle('is-disabled', !subsUsable);
  // Memory + Output shaper are PROXY-WIDE, so they live on the top-level service
  // control and are gated only on Headroom being installed — not on any single
  // column's binding. Both default off.
  if (optHeadroomMemory) { optHeadroomMemory.disabled = !headroomInstalled; optHeadroomMemory.checked = !!(config && config.useHeadroomMemory); }
  if (optHeadroomShaper) { optHeadroomShaper.disabled = !headroomInstalled; optHeadroomShaper.checked = !!(config && config.useHeadroomOutputShaper); }
  if (optHeadroomAutostart) { optHeadroomAutostart.disabled = !headroomInstalled; optHeadroomAutostart.checked = !!(config && config.headroomAutoStart); }
  try { if (typeof renderShaperNote === 'function') renderShaperNote('idle'); } catch (e) { /* ignore */ }
  // Show/refresh the top-level Headroom service control once the binary probe
  // resolves (renderHeadroomService is hoisted; refs assigned at module load).
  try { if (typeof renderHeadroomService === 'function') renderHeadroomService(); } catch (e) { /* ignore */ }
  updateSpawnButtonLabel();
}
function initHeadroomUI() {
  if (!window.electronAPI || !window.electronAPI.getHeadroomStatus) { applyHeadroomUiState(); return; }
  window.electronAPI.getHeadroomStatus().then(function (st) {
    headroomInstalled = !!(st && st.installed);
    applyHeadroomUiState();
  }).catch(function () { headroomInstalled = false; applyHeadroomUiState(); });
  // The initial fetch races the async probe in main and usually loses. Subscribe
  // so the probe's push-on-resolve re-renders the checkbox once it lands.
  if (window.electronAPI && window.electronAPI.onHeadroomStatus) {
    window.electronAPI.onHeadroomStatus(function (st) {
      headroomInstalled = !!(st && st.installed);
      headroomProbed = true;  // authoritative post-probe result — safe to show the install prompt now
      applyHeadroomUiState();
    });
  }
}

if (optUseHeadroom) {
  optUseHeadroom.addEventListener('change', function () {
    config.useHeadroom = optUseHeadroom.checked;
    saveConfig();
    applyHeadroomUiState();
  });
}
if (optHeadroom1m) {
  optHeadroom1m.addEventListener('change', function () {
    config.useHeadroom1m = optHeadroom1m.checked;
    saveConfig();
    updateSpawnButtonLabel();
  });
}
if (optHeadroomMemory) {
  optHeadroomMemory.addEventListener('change', function () {
    config.useHeadroomMemory = optHeadroomMemory.checked;
    saveConfig();
    // main.js applies --memory the next time it starts the app-owned proxy.
    if (optHeadroomMemory.checked && typeof showToast === 'function') {
      showToast('Headroom memory enabled — Stop then Start the proxy to apply', { kind: 'info' });
    }
  });
}
if (optHeadroomAutostart) {
  optHeadroomAutostart.addEventListener('change', function () {
    config.headroomAutoStart = optHeadroomAutostart.checked;
    saveConfig();
    // main.js reads this on launch (post binary-probe) and starts the proxy.
    if (typeof showToast === 'function') {
      showToast(optHeadroomAutostart.checked
        ? 'Headroom will start automatically when Claudes opens'
        : 'Headroom auto-start off', { kind: 'info' });
    }
  });
}
// Persistent instructions/status under the Output-shaper toggle. The shaper is
// inert until `headroom learn --verbosity --apply` builds a verbosity baseline
// (~2 min, one-time), so a bare checkbox leaves the user guessing. This line
// spells out what it needs, shows calibration progress, and — if calibration
// fails — gives the exact command to run by hand.
var headroomShaperNote = document.getElementById('headroom-shaper-note');
function renderShaperNote(state, detail) {
  if (!headroomShaperNote) return;
  var on = !!(config && config.useHeadroomOutputShaper);
  var calibrated = !!(config && config.headroomShaperCalibrated);
  var cls = 'headroom-shaper-note', text = '';
  if (state === 'calibrating') {
    cls += ' is-busy';
    text = 'Calibrating your verbosity baseline… ~2 min, one-time. Leave it running.';
  } else if (state === 'error') {
    cls += ' is-error';
    text = 'Calibration failed' + (detail ? ' (' + detail + ')' : '') + '. Run this in a terminal, then re-toggle: headroom learn --verbosity --apply';
  } else if (on && calibrated) {
    cls += ' is-ok';
    text = 'Active — trimming output to your learned verbosity.';
  } else if (on && !calibrated) {
    text = 'Turning on runs a one-time ~2 min calibration to learn your verbosity.';
  } else {
    text = 'Off. Turn on to cut output tokens — first enable calibrates once (~2 min).';
  }
  headroomShaperNote.className = cls;
  headroomShaperNote.textContent = text;
}
if (optHeadroomShaper) {
  optHeadroomShaper.addEventListener('change', function () {
    config.useHeadroomOutputShaper = optHeadroomShaper.checked;
    saveConfig();
    // The shaper is a live runtime toggle on the running proxy — no restart.
    // But enabling it runs `headroom learn --verbosity --apply` first, which
    // takes ~2 minutes to build the verbosity baseline the shaper needs; until
    // that finishes the shaper is inert. Tell the user so the wait isn't silent.
    if (window.electronAPI && window.electronAPI.setHeadroomOutputShaper) {
      if (optHeadroomShaper.checked) {
        renderShaperNote('calibrating');
        if (typeof showToast === 'function') showToast('Output shaper: learning your verbosity baseline (~2 min)…', { kind: 'info' });
      } else {
        renderShaperNote('idle');
      }
      window.electronAPI.setHeadroomOutputShaper(optHeadroomShaper.checked).then(function (res) {
        if (res && res.ok === false) {
          if (optHeadroomShaper.checked) renderShaperNote('error', res.error);
          if (typeof showToast === 'function') showToast('Output shaper: ' + (res.error || 'could not apply'), { kind: 'warn' });
        } else {
          if (optHeadroomShaper.checked) { config.headroomShaperCalibrated = true; saveConfig(); }
          renderShaperNote('idle');
          if (optHeadroomShaper.checked && typeof showToast === 'function') showToast('Output shaper active', { kind: 'info' });
        }
      });
    } else {
      renderShaperNote('idle');
    }
  });
}
if (headroomDashboardLink) headroomDashboardLink.addEventListener('click', function (e) { e.preventDefault(); window.electronAPI.openExternal('http://127.0.0.1:8787/dashboard'); });
if (headroomInstallLink) headroomInstallLink.addEventListener('click', function (e) { e.preventDefault(); window.electronAPI.openExternal('https://github.com/headroomlabs-ai/headroom'); });
var headroomInstallDocs = document.getElementById('headroom-install-docs');
if (headroomInstallDocs) headroomInstallDocs.addEventListener('click', function (e) { e.preventDefault(); window.electronAPI.openExternal('https://github.com/headroomlabs-ai/headroom'); });
var headroomInstallCmd = document.getElementById('headroom-install-cmd');
if (headroomInstallCmd) headroomInstallCmd.addEventListener('click', function () {
  var cmd = headroomInstallCmd.textContent || '';
  try {
    navigator.clipboard.writeText(cmd);
    if (typeof showToast === 'function') showToast('Install command copied', { kind: 'info' });
  } catch (e) { /* clipboard unavailable — the text is still selectable */ }
});

// --- Top-level Headroom persistent-service control (sidebar) ---
var headroomServiceEl = document.getElementById('headroom-service');
var headroomServiceDot = document.getElementById('headroom-service-dot');
var headroomServiceLabel = document.getElementById('headroom-service-label');
var headroomServiceBtn = document.getElementById('headroom-service-btn');
var headroomServiceLog = document.getElementById('headroom-service-log');
var headroomServiceDash = document.getElementById('headroom-service-dash');
var headroomServiceState = { running: false, busy: false };

var headroomServiceMain = document.getElementById('headroom-service-main');
var headroomServiceInstall = document.getElementById('headroom-service-install');
function renderHeadroomService() {
  if (!headroomServiceEl) return;
  // Not installed: once the probe has resolved, show the install prompt instead
  // of the running-state controls. Before the probe lands, stay hidden (no flash).
  if (!headroomInstalled) {
    if (!headroomProbed) { headroomServiceEl.classList.add('hidden'); return; }
    headroomServiceEl.classList.remove('hidden');
    if (headroomServiceMain) headroomServiceMain.classList.add('hidden');
    if (headroomServiceInstall) headroomServiceInstall.classList.remove('hidden');
    return;
  }
  headroomServiceEl.classList.remove('hidden');
  if (headroomServiceInstall) headroomServiceInstall.classList.add('hidden');
  if (headroomServiceMain) headroomServiceMain.classList.remove('hidden');
  var s = headroomServiceState;
  var dotClass = s.busy ? 'busy' : (s.running ? 'running' : 'stopped');
  if (headroomServiceDot) headroomServiceDot.className = 'headroom-service-dot ' + dotClass;
  if (headroomServiceLabel) headroomServiceLabel.textContent = s.busy ? 'Headroom · starting…' : (s.running ? 'Headroom · running' : 'Headroom · stopped');
  if (headroomServiceBtn) {
    headroomServiceBtn.textContent = s.busy ? '…' : (s.running ? 'Stop' : 'Start');
    headroomServiceBtn.disabled = !!s.busy;
  }
  if (headroomServiceDash) headroomServiceDash.classList.toggle('hidden', !s.running);
}

function refreshHeadroomService() {
  if (!window.electronAPI || !window.electronAPI.getHeadroomServiceStatus) return;
  window.electronAPI.getHeadroomServiceStatus().then(function (st) {
    if (st && st.ok) headroomServiceState.running = !!st.running;
    renderHeadroomService();
  }).catch(function () {});
}

function initHeadroomServiceUI() {
  if (!headroomServiceEl) return;
  if (headroomServiceBtn) {
    headroomServiceBtn.addEventListener('click', function () {
      if (headroomServiceState.busy || !window.electronAPI) return;
      if (headroomServiceState.running) {
        headroomServiceState.busy = true; renderHeadroomService();
        window.electronAPI.stopHeadroomService().then(function (r) {
          headroomServiceState.busy = false;
          headroomServiceState.running = !!(r && r.running);
          renderHeadroomService();
        }).catch(function () { headroomServiceState.busy = false; renderHeadroomService(); });
      } else {
        headroomServiceState.busy = true;
        if (headroomServiceLog) { headroomServiceLog.classList.remove('hidden'); headroomServiceLog.textContent = 'Starting…'; }
        renderHeadroomService();
        window.electronAPI.startHeadroomService().then(function (r) {
          headroomServiceState.busy = false;
          headroomServiceState.running = !!(r && r.running);
          renderHeadroomService();
          if (r && r.ok === false && typeof showToast === 'function') showToast('Headroom: ' + (r.error || 'could not start'), { kind: 'warn' });
        }).catch(function () { headroomServiceState.busy = false; renderHeadroomService(); });
      }
    });
  }
  if (headroomServiceDash) headroomServiceDash.addEventListener('click', function (e) {
    e.preventDefault();
    if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal('http://127.0.0.1:8787/dashboard');
  });
  if (window.electronAPI && window.electronAPI.onHeadroomServiceLog) {
    window.electronAPI.onHeadroomServiceLog(function (line) {
      if (headroomServiceLog) { headroomServiceLog.classList.remove('hidden'); headroomServiceLog.textContent = line; }
      // Keep the dot in sync when the proxy is driven from main (e.g. launch
      // auto-start), not just the Start button. The button flow owns its own
      // busy state, so only nudge when a background transition is signalled.
      if (/ready on port/i.test(line)) { headroomServiceState.running = true; headroomServiceState.busy = false; renderHeadroomService(); }
      else if (/^Starting Headroom proxy/i.test(line)) { if (!headroomServiceState.running) { headroomServiceState.busy = true; renderHeadroomService(); } }
      else if (/^Failed to start/i.test(line)) { headroomServiceState.busy = false; renderHeadroomService(); }
    });
  }
  refreshHeadroomService();
}

initHeadroomUI();
initHeadroomServiceUI();

// Default-effort selectors are app-global (not per-project), so they bypass
// saveSpawnOptions and persist straight to config root.
if (optDefaultEffortCloud) {
  optDefaultEffortCloud.addEventListener('change', function () {
    if (!isValidEffort(optDefaultEffortCloud.value)) return;
    defaultEffortCloud = optDefaultEffortCloud.value;
    config.defaultEffortCloud = defaultEffortCloud;
    saveConfig();
  });
  optDefaultEffortCloud.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  optDefaultEffortCloud.addEventListener('click', function (e) { e.stopPropagation(); });
}
if (optDefaultEffortLocal) {
  optDefaultEffortLocal.addEventListener('change', function () {
    if (!isValidEffort(optDefaultEffortLocal.value)) return;
    defaultEffortLocal = optDefaultEffortLocal.value;
    config.defaultEffortLocal = defaultEffortLocal;
    saveConfig();
  });
  optDefaultEffortLocal.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  optDefaultEffortLocal.addEventListener('click', function (e) { e.stopPropagation(); });
}

// --- Endpoint preset wiring ---

function renderEndpointDropdown() {
  // Preserve current value across rebuild.
  var prev = optEndpoint.value;
  while (optEndpoint.firstChild) optEndpoint.removeChild(optEndpoint.firstChild);
  var defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Anthropic (cloud)';
  optEndpoint.appendChild(defaultOpt);
  endpointPresets.forEach(function (p) {
    var o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name || '(unnamed)';
    optEndpoint.appendChild(o);
  });
  // Restore selection if still valid; otherwise fall back to current state.
  if (prev && endpointPresets.find(function (p) { return p.id === prev; })) {
    optEndpoint.value = prev;
  } else {
    optEndpoint.value = currentEndpointId || '';
  }
}

function applyEndpointSelection(endpointId, persist) {
  var wasNoPreset = !currentEndpointId;
  var idChanged = currentEndpointId !== (endpointId || null);
  currentEndpointId = endpointId || null;
  optEndpoint.value = currentEndpointId || '';

  // Auto-toggle Bare Mode on user-initiated cloud↔local transitions:
  //   cloud → preset: tick bare (local models can't fit the full system prompt)
  //   preset → cloud: untick bare (cloud has no reason to strip MCPs/hooks)
  // persist=true marks user-initiated changes; loadSpawnOptions on app load
  // passes persist=false so saved bare preferences are honoured across restarts.
  if (persist) {
    if (wasNoPreset && currentEndpointId && !optBare.checked) {
      optBare.checked = true;
    } else if (!wasNoPreset && !currentEndpointId && optBare.checked) {
      optBare.checked = false;
    }
  }

  var preset = currentEndpointId
    ? endpointPresets.find(function (p) { return p.id === currentEndpointId; })
    : null;

  // Toggle which "Model" row is shown: cloud uses the Sonnet/Opus/Haiku
  // dropdown; local uses an endpoint-specific dropdown populated from
  // /v1/models on the active server (with the preset's chosen model as the
  // default fallback).
  if (preset) {
    optModelRow.classList.add('hidden');
    optEndpointModelRow.classList.remove('hidden');
    if (idChanged) {
      // Only reset the dropdown when the endpoint identity changed; switching
      // back to the same preset shouldn't wipe an in-progress selection.
      populateEndpointModelDropdown(preset);
    }
  } else {
    optModelRow.classList.remove('hidden');
    optEndpointModelRow.classList.add('hidden');
  }

  refreshEndpointEnv();

  if (persist) {
    saveSpawnOptions();
  }
  updateSpawnButtonLabel();
}

// Refresh the cached env block (async — main process decrypts the token and
// resolves the model override). Shared between selection changes and per-spawn
// model picks, so all callsites stay in sync.
function refreshEndpointEnv() {
  if (currentEndpointId && window.electronAPI && window.electronAPI.endpointGetEnv) {
    var capturedId = currentEndpointId;
    var capturedModel = currentEndpointModel;
    window.electronAPI.endpointGetEnv(capturedId, capturedModel).then(function (env) {
      // Guard against a later selection arriving before this resolves.
      if (currentEndpointId === capturedId) {
        currentEndpointEnv = env || null;
        // Refresh the spawn button label so the auto-forced 'bare' tag
        // appears as soon as a URL-cred endpoint is picked.
        updateSpawnButtonLabel();
      }
    }).catch(function () { currentEndpointEnv = null; updateSpawnButtonLabel(); });
  } else {
    currentEndpointEnv = null;
    updateSpawnButtonLabel();
  }
}

// Populate the local-model dropdown: render whatever's in cache immediately
// (so the UI doesn't sit on "(loading…)" if we just looked at this endpoint
// a moment ago), then fire a background refresh from /v1/models.
function populateEndpointModelDropdown(preset) {
  var defaultModel = preset && preset.model ? preset.model : '';
  var cached = endpointModelsCache[preset.id];
  if (cached && cached.ok && cached.models && cached.models.length > 0) {
    renderEndpointModelOptions(cached.models, defaultModel);
  } else {
    // Show the default while we wait, so the user can spawn immediately
    // without staring at "(loading…)".
    renderEndpointModelOptions(defaultModel ? [defaultModel] : [], defaultModel);
    fetchEndpointModels(preset, /* force */ false);
  }
}

function renderEndpointModelOptions(models, defaultModel) {
  while (optEndpointModel.firstChild) optEndpointModel.removeChild(optEndpointModel.firstChild);
  // Preference: project's saved override → preset default → first available.
  var preferred = currentEndpointModel || defaultModel || (models && models[0]) || '';
  var preferredFound = false;
  models.forEach(function (m) {
    var opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (m === preferred) { opt.selected = true; preferredFound = true; }
    optEndpointModel.appendChild(opt);
  });
  // If the preferred (saved) model isn't in the fetched list, prepend it as
  // a stale entry so the user can see why their setting isn't applying.
  if (preferred && !preferredFound) {
    var stale = document.createElement('option');
    stale.value = preferred;
    stale.textContent = preferred + ' (not loaded)';
    stale.selected = true;
    optEndpointModel.insertBefore(stale, optEndpointModel.firstChild);
  }
  // Keep currentEndpointModel in sync with the visible selection so spawnOpts
  // builds the right env even if the user never opens the dropdown.
  currentEndpointModel = optEndpointModel.value || null;
  refreshEndpointEnv();
  updateSpawnButtonLabel();
}

function fetchEndpointModels(preset, force) {
  if (!preset || !window.electronAPI || !window.electronAPI.endpointFetchModels) return;
  // Skip refetch within 5 minutes unless forced.
  var cached = endpointModelsCache[preset.id];
  if (!force && cached && cached.ok && (Date.now() - cached.fetchedAt) < 5 * 60 * 1000) return;

  // Need the auth token for the fetch — main has it, ask via endpointGet.
  window.electronAPI.endpointGet(preset.id).then(function (full) {
    if (!full) return;
    return window.electronAPI.endpointFetchModels({
      baseUrl: full.baseUrl,
      authToken: full.authToken
    });
  }).then(function (result) {
    if (!result) return;
    if (result.ok && Array.isArray(result.models)) {
      endpointModelsCache[preset.id] = {
        ok: true,
        models: result.models,
        fetchedAt: Date.now()
      };
      // Only re-render if this preset is still the active one.
      if (currentEndpointId === preset.id) {
        renderEndpointModelOptions(result.models, preset.model || '');
      }
    } else {
      endpointModelsCache[preset.id] = { ok: false, models: [], fetchedAt: Date.now() };
    }
  }).catch(function () {
    endpointModelsCache[preset.id] = { ok: false, models: [], fetchedAt: Date.now() };
  });
}

optEndpoint.addEventListener('change', function () {
  // Reset model selection on endpoint change — the new endpoint will likely
  // have different model identifiers than the old one.
  currentEndpointModel = null;
  applyEndpointSelection(optEndpoint.value || null, /* persist */ true);
});
// Don't let the select's mouse interactions close the spawn dropdown.
optEndpoint.addEventListener('mousedown', function (e) { e.stopPropagation(); });
optEndpoint.addEventListener('click', function (e) { e.stopPropagation(); });
var endpointSelectOpen = false;
optEndpoint.addEventListener('focus', function () { endpointSelectOpen = true; });
optEndpoint.addEventListener('blur', function () { endpointSelectOpen = false; });

// Per-project model override dropdown. Selecting a different model rebuilds
// the env block and persists the choice in spawnOptions.endpointModel.
optEndpointModel.addEventListener('change', function () {
  currentEndpointModel = optEndpointModel.value || null;
  refreshEndpointEnv();
  saveSpawnOptions();
  updateSpawnButtonLabel();
});
// Refresh the model list when the user opens the dropdown — local models can
// be loaded/swapped in LM Studio without restarting Claudes, so the cached
// list goes stale fast. mousedown fires before the native picker opens.
optEndpointModel.addEventListener('mousedown', function (e) {
  e.stopPropagation();
  var preset = currentEndpointId
    ? endpointPresets.find(function (p) { return p.id === currentEndpointId; })
    : null;
  if (preset) fetchEndpointModels(preset, /* force */ true);
});
optEndpointModel.addEventListener('click', function (e) { e.stopPropagation(); });
var endpointModelSelectOpen = false;
optEndpointModel.addEventListener('focus', function () { endpointModelSelectOpen = true; });
optEndpointModel.addEventListener('blur', function () { endpointModelSelectOpen = false; });

if (optEndpointModelRefresh) {
  optEndpointModelRefresh.addEventListener('click', function (e) {
    e.stopPropagation();
    var preset = currentEndpointId
      ? endpointPresets.find(function (p) { return p.id === currentEndpointId; })
      : null;
    if (preset) fetchEndpointModels(preset, /* force */ true);
  });
}

function loadEndpointPresets() {
  if (!window.electronAPI || !window.electronAPI.endpointList) return Promise.resolve();
  return window.electronAPI.endpointList().then(function (list) {
    endpointPresets = Array.isArray(list) ? list : [];
    // Invalidate the cached effective limit on every column so the next ctx
    // poll re-resolves it against the freshly-loaded preset data. Cheap, and
    // it means saving a new contextWindow takes effect on existing columns.
    if (typeof allColumns !== 'undefined') {
      allColumns.forEach(function (c) { if (c) c.effectiveLimit = null; });
    }
    renderEndpointDropdown();
    // Re-load spawn options so the active project's persisted endpointId can
    // be validated and applied. Without this, app startup races —
    // setActiveProject runs before this IPC resolves, so loadSpawnOptions
    // validates against an empty cache, decides the id is unknown, and zeros
    // out the in-memory selection. Re-running here picks it back up.
    if (typeof config !== 'undefined' && config && config.activeProjectIndex != null
        && config.projects && config.projects[config.activeProjectIndex]) {
      loadSpawnOptions();
    } else if (currentEndpointId && !endpointPresets.find(function (p) { return p.id === currentEndpointId; })) {
      applyEndpointSelection(null, /* persist */ true);
    } else {
      applyEndpointSelection(currentEndpointId, /* persist */ false);
    }
  });
}

if (window.electronAPI && window.electronAPI.onEndpointsUpdated) {
  window.electronAPI.onEndpointsUpdated(function () {
    loadEndpointPresets();
  });
}

// Kick off initial load. If electronAPI isn't ready yet (popout windows
// sometimes initialize the bridge late), this is a no-op and a later
// loadSpawnOptions call will trigger applyEndpointSelection without env.
if (window.electronAPI && window.electronAPI.endpointList) {
  loadEndpointPresets();
}

// Prevent model select interactions from closing the spawn dropdown
optModel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
optModel.addEventListener('click', function (e) { e.stopPropagation(); });

// Keep spawn dropdown open while model select is focused
var modelSelectOpen = false;
optModel.addEventListener('focus', function () { modelSelectOpen = true; });
optModel.addEventListener('blur', function () {
  modelSelectOpen = false;
});

// Close dropdown when clicking outside
document.addEventListener('click', function (e) {
  if (!spawnDropdown.classList.contains('hidden') &&
      !spawnDropdown.contains(e.target) &&
      e.target !== btnAddOptions &&
      !modelSelectOpen &&
      !endpointSelectOpen &&
      !endpointModelSelectOpen) {
    closeSpawnDropdown();
  }
});

// Prevent dropdown clicks from closing it
spawnDropdown.addEventListener('click', function (e) {
  e.stopPropagation();
});

// ============================================================
// Endpoint Presets Modal
// ============================================================

var endpointsModal = document.getElementById('endpoints-modal');
var endpointsCloseBtn = document.getElementById('endpoints-close');
var endpointsListEl = document.getElementById('endpoints-list');
var endpointsNewBtn = document.getElementById('endpoints-new');
var endpointsForm = document.getElementById('endpoints-form');
var endpointsEmpty = document.getElementById('endpoints-empty');
var epName = document.getElementById('ep-name');
var epBaseUrl = document.getElementById('ep-base-url');
var epAuthToken = document.getElementById('ep-auth-token');
var epTokenToggle = document.getElementById('ep-token-toggle');
var epModelInput = document.getElementById('ep-model');
var epModelSelect = document.getElementById('ep-model-select');
var epModelFetchBtn = document.getElementById('ep-model-fetch');
var epFallback = document.getElementById('ep-fallback');
var epContextWindow = document.getElementById('ep-context-window');
var epContextFetchBtn = document.getElementById('ep-context-fetch');
var epStatus = document.getElementById('ep-status');
var epTestBtn = document.getElementById('ep-test');
var epDeleteBtn = document.getElementById('ep-delete');
var epSaveBtn = document.getElementById('ep-save');

// Editing state. null = no preset selected (form hidden); a string id =
// editing an existing preset; the sentinel '__new__' = unsaved new preset.
var editingPresetId = null;

function setEpStatus(text, kind) {
  epStatus.textContent = text || '';
  epStatus.classList.remove('ok', 'error');
  if (kind === 'ok') epStatus.classList.add('ok');
  else if (kind === 'error') epStatus.classList.add('error');
}

function showEndpointForm(show) {
  if (show) {
    endpointsForm.classList.remove('hidden');
    endpointsEmpty.classList.add('hidden');
  } else {
    endpointsForm.classList.add('hidden');
    endpointsEmpty.classList.remove('hidden');
  }
}

function clearEndpointForm() {
  epName.value = '';
  epBaseUrl.value = '';
  epAuthToken.value = '';
  epAuthToken.type = 'password';
  epModelInput.value = '';
  epModelInput.classList.remove('hidden');
  epModelSelect.classList.add('hidden');
  if (epContextWindow) epContextWindow.value = '';
  while (epModelSelect.firstChild) epModelSelect.removeChild(epModelSelect.firstChild);
  if (epFallback) {
    while (epFallback.firstChild) epFallback.removeChild(epFallback.firstChild);
    var noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(none)';
    epFallback.appendChild(noneOpt);
  }
  setEpStatus('');
}

function populateFallbackOptions(currentEditingId, currentFallbackId) {
  if (!epFallback) return;
  while (epFallback.firstChild) epFallback.removeChild(epFallback.firstChild);
  var none = document.createElement('option');
  none.value = '';
  none.textContent = '(none)';
  epFallback.appendChild(none);
  for (var i = 0; i < endpointPresets.length; i++) {
    var p = endpointPresets[i];
    if (p.id === currentEditingId) continue;  // can't fallback to self
    var opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || '(unnamed)';
    if (p.id === currentFallbackId) opt.selected = true;
    epFallback.appendChild(opt);
  }
}

function renderEndpointsListUI() {
  while (endpointsListEl.firstChild) endpointsListEl.removeChild(endpointsListEl.firstChild);
  if (endpointPresets.length === 0) {
    var empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No presets yet — click + to add one.';
    endpointsListEl.appendChild(empty);
    return;
  }
  endpointPresets.forEach(function (p) {
    var li = document.createElement('li');
    li.textContent = p.name || '(unnamed)';
    li.dataset.id = p.id;
    if (p.id === editingPresetId) li.classList.add('active');
    li.addEventListener('click', function () { selectEndpointForEdit(p.id); });
    endpointsListEl.appendChild(li);
  });
}

function selectEndpointForEdit(id) {
  editingPresetId = id;
  if (!window.electronAPI || !window.electronAPI.endpointGet) return;
  window.electronAPI.endpointGet(id).then(function (preset) {
    if (!preset) {
      // Stale list; refresh and clear.
      editingPresetId = null;
      showEndpointForm(false);
      loadEndpointPresets();
      return;
    }
    epName.value = preset.name || '';
    epBaseUrl.value = preset.baseUrl || '';
    epAuthToken.value = preset.authToken || '';
    epAuthToken.type = 'password';
    epModelInput.value = preset.model || '';
    epModelInput.classList.remove('hidden');
    epModelSelect.classList.add('hidden');
    if (epContextWindow) epContextWindow.value = preset.contextWindow || '';
    populateFallbackOptions(preset.id, preset.fallbackId || '');
    setEpStatus('');
    showEndpointForm(true);
    renderEndpointsListUI();
    epName.focus();
  });
}

function startNewEndpoint() {
  editingPresetId = '__new__';
  clearEndpointForm();
  populateFallbackOptions(null, '');
  showEndpointForm(true);
  renderEndpointsListUI();
  epName.focus();
}

function openEndpointsModal() {
  closeSpawnDropdown();
  // One-time-per-session check: on Linux without a keyring (or in headless
  // WSL), Electron's safeStorage falls back to plaintext for endpoint tokens.
  // The user should know so they can install a keyring or avoid storing
  // tokens here.
  maybeShowSafeStorageWarning();
  loadEndpointPresets().then(function () {
    endpointsModal.classList.remove('hidden');
    // Auto-select something so the user isn't staring at an empty form:
    // prefer the active project's selected preset, otherwise the first one,
    // otherwise show the empty-state with the "+" hint.
    var preferred = currentEndpointId
      || (endpointPresets[0] && endpointPresets[0].id)
      || null;
    if (preferred) {
      selectEndpointForEdit(preferred);
    } else {
      editingPresetId = null;
      clearEndpointForm();
      showEndpointForm(false);
      renderEndpointsListUI();
    }
  });
}

function closeEndpointsModal() {
  endpointsModal.classList.add('hidden');
  editingPresetId = null;
}

var safeStorageWarningShown = false;
function maybeShowSafeStorageWarning() {
  if (safeStorageWarningShown) return;
  if (!window.electronAPI || !window.electronAPI.isTokenStorageEncrypted) return;
  window.electronAPI.isTokenStorageEncrypted().then(function (ok) {
    if (ok) return;
    safeStorageWarningShown = true;
    var body = endpointsModal.querySelector('.modal-body') || endpointsModal;
    if (body.querySelector('.endpoints-safestorage-warning')) return;
    var warn = document.createElement('div');
    warn.className = 'endpoints-safestorage-warning';
    warn.textContent = '⚠  OS keyring unavailable — endpoint auth tokens will be saved in plaintext under ~/.claudes/. Install gnome-keyring / libsecret (Linux) for encrypted storage.';
    body.insertBefore(warn, body.firstChild);
  }).catch(function () { /* IPC missing in dev — ignore */ });
}

function collectFormPayload() {
  var ctx = epContextWindow ? parseInt(epContextWindow.value, 10) : NaN;
  return {
    id: editingPresetId === '__new__' ? null : editingPresetId,
    name: epName.value.trim(),
    baseUrl: epBaseUrl.value.trim(),
    authToken: epAuthToken.value, // pass as-is; main encrypts
    model: epModelInput.classList.contains('hidden')
      ? epModelSelect.value
      : epModelInput.value.trim(),
    fallbackId: (epFallback && epFallback.value) || null,
    contextWindow: Number.isFinite(ctx) && ctx > 0 ? ctx : null
  };
}

function saveCurrentPreset() {
  console.log('[ep-save] clicked');
  var payload = collectFormPayload();
  console.log('[ep-save] payload', JSON.stringify(payload));
  if (!payload.name) { setEpStatus('Name is required', 'error'); return; }
  if (!payload.baseUrl) { setEpStatus('Base URL is required', 'error'); return; }
  if (!payload.model) { setEpStatus('Model is required', 'error'); return; }
  setEpStatus('Saving…');
  window.electronAPI.endpointSave(payload).then(function (result) {
    console.log('[ep-save] result', result);
    if (result && result.ok === false) {
      setEpStatus(result.error || 'Save failed', 'error');
      return;
    }
    setEpStatus('Saved ✓', 'ok');
    // Also flash the save button briefly so the success is unmissable.
    if (epSaveBtn) {
      epSaveBtn.classList.add('save-flash');
      setTimeout(function () { epSaveBtn.classList.remove('save-flash'); }, 1200);
    }
    var newId = (result && result.id) || payload.id;
    return loadEndpointPresets().then(function () {
      if (newId) {
        editingPresetId = newId;
        renderEndpointsListUI();
        // Auto-apply the saved preset to the active project when nothing
        // valid is currently selected. This catches: (a) the very first
        // preset being created, (b) the active project's stored id pointing
        // at a deleted/renamed preset, (c) user editing a preset and
        // expecting it to "just work" without a separate dropdown click.
        var hasValidCurrent = currentEndpointId
          && endpointPresets.some(function (p) { return p.id === currentEndpointId; });
        if (!hasValidCurrent) {
          applyEndpointSelection(newId, /* persist */ true);
        } else if (newId === currentEndpointId) {
          // Refresh the cached env block when the active preset is edited.
          applyEndpointSelection(newId, /* persist */ false);
        }
      }
    });
  }).catch(function (err) {
    setEpStatus('Save failed: ' + (err && err.message ? err.message : err), 'error');
  });
}

function deleteCurrentPreset() {
  if (!editingPresetId || editingPresetId === '__new__') {
    // Nothing persisted to delete — just clear the form.
    editingPresetId = null;
    clearEndpointForm();
    showEndpointForm(false);
    renderEndpointsListUI();
    return;
  }
  if (!confirm('Delete this preset? Projects using it will fall back to Anthropic (cloud).')) return;
  window.electronAPI.endpointDelete(editingPresetId).then(function () {
    editingPresetId = null;
    clearEndpointForm();
    showEndpointForm(false);
    return loadEndpointPresets();
  }).catch(function (err) {
    setEpStatus('Delete failed: ' + (err && err.message ? err.message : err), 'error');
  });
}

function fetchModelsFromForm() {
  var baseUrl = epBaseUrl.value.trim();
  var authToken = epAuthToken.value;
  if (!baseUrl) { setEpStatus('Base URL is required to fetch models', 'error'); return; }
  setEpStatus('Fetching models…');
  window.electronAPI.endpointFetchModels({ baseUrl: baseUrl, authToken: authToken }).then(function (result) {
    if (!result || !result.ok) {
      setEpStatus('Fetch failed: ' + ((result && result.error) || 'unknown'), 'error');
      return;
    }
    if (!result.models || result.models.length === 0) {
      setEpStatus('No models reported by endpoint', 'error');
      return;
    }
    // Switch to the select dropdown, populate, preselect current value if present.
    while (epModelSelect.firstChild) epModelSelect.removeChild(epModelSelect.firstChild);
    var current = epModelInput.value.trim();
    var foundCurrent = false;
    result.models.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      if (m === current) { o.selected = true; foundCurrent = true; }
      epModelSelect.appendChild(o);
    });
    if (!foundCurrent && current) {
      // Keep the user's current value as a manual option at the top.
      var manual = document.createElement('option');
      manual.value = current;
      manual.textContent = current + ' (manual)';
      manual.selected = true;
      epModelSelect.insertBefore(manual, epModelSelect.firstChild);
    }
    epModelInput.classList.add('hidden');
    epModelSelect.classList.remove('hidden');
    // Auto-fill context window from the selected model's metadata when present.
    if (epContextWindow && Array.isArray(result.modelInfo)) {
      var sel = epModelSelect.value;
      var info = result.modelInfo.find(function (m) { return m.id === sel; });
      if (info && info.context && !epContextWindow.value) {
        epContextWindow.value = info.context;
      }
    }
    setEpStatus('Loaded ' + result.models.length + ' model' + (result.models.length === 1 ? '' : 's'), 'ok');
  }).catch(function (err) {
    setEpStatus('Fetch failed: ' + (err && err.message ? err.message : err), 'error');
  });
}

function fetchContextLengthOnly() {
  var baseUrl = epBaseUrl.value.trim();
  var authToken = epAuthToken.value;
  var modelName = epModelInput.classList.contains('hidden') ? epModelSelect.value : epModelInput.value.trim();
  if (!baseUrl) { setEpStatus('Base URL is required', 'error'); return; }
  setEpStatus('Probing context length…');
  window.electronAPI.endpointFetchModels({ baseUrl: baseUrl, authToken: authToken }).then(function (result) {
    if (!result || !result.ok) {
      setEpStatus('Fetch failed: ' + ((result && result.error) || 'unknown'), 'error');
      return;
    }
    var info = (result.modelInfo || []).find(function (m) { return m.id === modelName; });
    if (info && info.context) {
      if (epContextWindow) epContextWindow.value = info.context;
      setEpStatus('Set context length to ' + info.context.toLocaleString(), 'ok');
    } else {
      // Fall back to the largest reported across models if our model isn't matched.
      var max = (result.modelInfo || []).reduce(function (acc, m) { return m.context && m.context > acc ? m.context : acc; }, 0);
      if (max && epContextWindow) {
        epContextWindow.value = max;
        setEpStatus('Endpoint did not report context length for that model; used largest seen (' + max.toLocaleString() + ')', 'ok');
      } else {
        setEpStatus('Endpoint did not report a context length — enter manually', 'error');
      }
    }
  }).catch(function (err) {
    setEpStatus('Fetch failed: ' + (err && err.message ? err.message : err), 'error');
  });
}

function testConnection() {
  var baseUrl = epBaseUrl.value.trim();
  var authToken = epAuthToken.value;
  if (!baseUrl) { setEpStatus('Base URL is required to test', 'error'); return; }
  setEpStatus('Testing…');
  window.electronAPI.endpointFetchModels({ baseUrl: baseUrl, authToken: authToken }).then(function (result) {
    if (result && result.ok) {
      setEpStatus('Connection OK (' + (result.models ? result.models.length : 0) + ' models)', 'ok');
    } else {
      setEpStatus('Failed: ' + ((result && result.error) || 'unknown'), 'error');
    }
  }).catch(function (err) {
    setEpStatus('Failed: ' + (err && err.message ? err.message : err), 'error');
  });
}

if (btnManageEndpoints) {
  btnManageEndpoints.addEventListener('click', function (e) {
    e.stopPropagation();
    openEndpointsModal();
  });
}
endpointsCloseBtn.addEventListener('click', closeEndpointsModal);
endpointsNewBtn.addEventListener('click', startNewEndpoint);
epSaveBtn.addEventListener('click', saveCurrentPreset);
epDeleteBtn.addEventListener('click', deleteCurrentPreset);
epModelFetchBtn.addEventListener('click', fetchModelsFromForm);
if (epContextFetchBtn) epContextFetchBtn.addEventListener('click', fetchContextLengthOnly);
epTestBtn.addEventListener('click', testConnection);
epTokenToggle.addEventListener('click', function () {
  epAuthToken.type = epAuthToken.type === 'password' ? 'text' : 'password';
});

// Click on backdrop (outside dialog) closes the modal.
endpointsModal.addEventListener('click', function (e) {
  if (e.target === endpointsModal) closeEndpointsModal();
});

// ============================================================
// Toolbar Menu (three-dot)
// ============================================================

var toolbarMenu = document.getElementById('toolbar-menu');
var btnToolbarMenu = document.getElementById('btn-toolbar-menu');

btnToolbarMenu.addEventListener('click', function (e) {
  e.stopPropagation();
  toolbarMenu.classList.toggle('hidden');
  // Close spawn dropdown if open
  closeSpawnDropdown();
});

toolbarMenu.addEventListener('click', function (e) {
  // Close menu when a button item is clicked (not the theme row)
  if (e.target.classList.contains('toolbar-menu-item') && !e.target.classList.contains('toolbar-menu-row')) {
    toolbarMenu.classList.add('hidden');
  }
});

// Close toolbar menu when clicking outside (but not while theme select is open)
document.addEventListener('click', function (e) {
  if (!toolbarMenu.classList.contains('hidden') &&
      !toolbarMenu.contains(e.target) &&
      e.target !== btnToolbarMenu &&
      !themeSelectOpen) {
    toolbarMenu.classList.add('hidden');
  }
});

// ============================================================
// CLAUDE.md Modal
// ============================================================

// Tracks whether the CLAUDE.md modal is showing the project-scoped file or
// the global ~/.claude/CLAUDE.md. The same modal is reused for both — only the
// root path the read/save IPCs are asked to operate on differs.
var claudeMdEditingGlobal = false;
var GLOBAL_CLAUDE_DIR_KEY = '__GLOBAL__';

function openClaudeMdModal(opts) {
  if (!window.electronAPI) return;
  var global = !!(opts && opts.global);
  // Project-scoped variant still requires an active project (current behaviour).
  if (!global && !activeProjectKey) return;
  claudeMdEditingGlobal = global;
  var root = global
    ? (window.__claudesHome || '~/.claude')   // resolved in main; this is a label only
    : activeProjectKey;
  claudeMdPath.textContent = root + '/CLAUDE.md';
  claudeMdStatus.textContent = 'Loading...';
  claudeMdEditor.value = '';
  claudeMdModal.classList.remove('hidden');
  // The IPC expects a real path; for global we pass a sentinel that main
  // resolves to os.homedir()/.claude.
  var rootArg = global ? GLOBAL_CLAUDE_DIR_KEY : activeProjectKey;
  window.electronAPI.readClaudeMd(rootArg).then(function (result) {
    claudeMdEditor.value = result.content;
    claudeMdStatus.textContent = result.exists ? '' : 'File does not exist yet — will be created on save';
  });
}

function closeClaudeMdModal() {
  claudeMdModal.classList.add('hidden');
}

function saveClaudeMd() {
  if (!window.electronAPI) return;
  if (!claudeMdEditingGlobal && !activeProjectKey) return;

  claudeMdStatus.textContent = 'Saving...';
  var rootArg = claudeMdEditingGlobal ? GLOBAL_CLAUDE_DIR_KEY : activeProjectKey;
  window.electronAPI.saveClaudeMd(rootArg, claudeMdEditor.value).then(function (result) {
    if (result.success) {
      claudeMdStatus.textContent = 'Saved';
      setTimeout(function () {
        if (claudeMdStatus.textContent === 'Saved') claudeMdStatus.textContent = '';
      }, 2000);
    } else {
      claudeMdStatus.textContent = 'Error: ' + result.error;
    }
  });
}

// ============================================================
// Settings Modal
// ============================================================

var settingsModal = document.getElementById('settings-modal');

document.getElementById('btn-settings').addEventListener('click', function () {
  loadNotifSettings();
  loadStartWithOS();
  var ctxSel = document.getElementById('setting-ctx-default');
  if (ctxSel) ctxSel.value = getCtxDefaultPref();
  window.electronAPI.getAutomationSettings().then(function (settings) {
    document.getElementById('setting-agent-repos-dir').value = settings.agentReposBaseDir || '';
  });
  loadVoiceSettings();
  // Sync settings: pulled lazily so changes in main.js persist round-trip.
  if (window.electronAPI && window.electronAPI.syncGetSettings) {
    window.electronAPI.syncGetSettings().then(function (s) {
      var nameEl = document.getElementById('setting-sync-device-name');
      var pathEl = document.getElementById('setting-sync-source-path');
      if (nameEl) nameEl.value = (s && s.deviceName) || '';
      if (pathEl) pathEl.value = (s && s.sourcePath) || '';
      var status = document.getElementById('sync-save-status');
      if (status) status.textContent = '';
    });
  }
  settingsModal.classList.remove('hidden');
});

(function wireSyncSettings() {
  var browseBtn = document.getElementById('btn-browse-sync-source');
  var saveBtn = document.getElementById('btn-sync-save');
  var pathEl = document.getElementById('setting-sync-source-path');
  var nameEl = document.getElementById('setting-sync-device-name');
  var status = document.getElementById('sync-save-status');
  if (!browseBtn || !saveBtn || !pathEl || !nameEl) return;

  browseBtn.addEventListener('click', function () {
    window.electronAPI.syncBrowseFolder({ defaultPath: pathEl.value || undefined }).then(function (chosen) {
      if (chosen) pathEl.value = chosen;
    });
  });

  saveBtn.addEventListener('click', function () {
    saveBtn.disabled = true;
    if (status) status.textContent = 'Saving…';
    window.electronAPI.syncSetSettings({
      sourcePath: pathEl.value.trim(),
      deviceName: nameEl.value.trim()
    }).then(function (saved) {
      saveBtn.disabled = false;
      if (status) {
        if (saved && saved.sourcePath) status.textContent = 'Saved. Watchers will pick up enabled projects.';
        else status.textContent = 'Saved (no source path → sync inactive).';
      }
    }).catch(function (err) {
      saveBtn.disabled = false;
      if (status) status.textContent = 'Save failed: ' + (err && err.message || err);
    });
  });
})();

(function wireClawdSettings() {
  function attach() {
    var enabledEl = document.getElementById('setting-clawd-enabled');
    var sizeEl = document.getElementById('setting-clawd-size');
    var sizeValEl = document.getElementById('setting-clawd-size-val');
    var debugEl = document.getElementById('setting-clawd-debug');
    if (!enabledEl || !sizeEl || !window.Clawd) return;

    var hookIndicator = document.getElementById('clawd-hooks-indicator');
    var hookLabel = document.getElementById('clawd-hooks-label');
    var hookConnectBtn = document.getElementById('btn-clawd-hooks-connect');

    function setHookStatus(connected, msg) {
      if (hookIndicator) {
        hookIndicator.textContent = connected ? '✓' : '!';
        hookIndicator.classList.toggle('connected', !!connected);
        hookIndicator.classList.toggle('disconnected', !connected);
      }
      if (hookLabel) hookLabel.textContent = msg;
      if (hookConnectBtn) hookConnectBtn.classList.toggle('hidden', !!connected);
    }

    function refreshHooks() {
      var api = window.electronAPI || {};
      if (api.getHooksStatus) {
        api.getHooksStatus().then(function (status) {
          if (!status) {
            setHookStatus(false, 'Couldn’t read hook status.');
            return;
          }
          var wired = (status.wired && status.wired.length) || 0;
          var total = status.total || 0;
          if (wired === total) {
            setHookStatus(true, 'Hooks connected (' + wired + '/' + total + ') — Clawd reacts in real time.');
          } else if (wired === 0) {
            setHookStatus(false, 'Hooks not connected — Clawd may lag or stick on stale states.');
          } else {
            setHookStatus(false,
              'Partial coverage (' + wired + '/' + total + '). Missing: ' +
              (status.missing || []).join(', ') + '. Click Connect to top up.');
          }
        }).catch(function () { setHookStatus(false, 'Couldn’t read hook status.'); });
      } else if (api.isHooksConfigured) {
        api.isHooksConfigured().then(function (configured) {
          if (configured) setHookStatus(true, 'Hooks connected — Clawd reacts in real time.');
          else setHookStatus(false, 'Hooks not connected — Clawd may lag or stick on stale states.');
        }).catch(function () { setHookStatus(false, 'Couldn’t read hook status.'); });
      } else {
        setHookStatus(false, 'Hooks API unavailable.');
      }
    }

    function refresh() {
      enabledEl.checked = window.Clawd.isEnabled();
      var size = window.Clawd.getSize();
      sizeEl.value = String(size);
      if (sizeValEl) sizeValEl.textContent = size + 'px';
      if (debugEl && window.Clawd.isDebugEnabled) debugEl.checked = window.Clawd.isDebugEnabled();
      refreshHooks();
    }
    refresh();

    enabledEl.addEventListener('change', function () {
      if (enabledEl.checked) window.Clawd.enable();
      else window.Clawd.disable();
    });
    sizeEl.addEventListener('input', function () {
      var n = parseInt(sizeEl.value, 10);
      if (isNaN(n)) return;
      window.Clawd.setSize(n);
      if (sizeValEl) sizeValEl.textContent = n + 'px';
    });
    if (debugEl) {
      debugEl.addEventListener('change', function () {
        if (debugEl.checked) window.Clawd.enableDebug();
        else window.Clawd.disableDebug();
      });
    }

    if (hookConnectBtn && window.electronAPI && window.electronAPI.configureHooks) {
      hookConnectBtn.addEventListener('click', function () {
        hookConnectBtn.disabled = true;
        if (hookLabel) hookLabel.textContent = 'Connecting…';
        window.electronAPI.configureHooks().then(function (result) {
          hookConnectBtn.disabled = false;
          if (result && result.ok) {
            setHookStatus(true, 'Hooks connected. Respawn open Claude columns to start receiving events.');
          } else {
            setHookStatus(false, 'Connect failed: ' + ((result && result.error) || 'unknown error'));
          }
        }).catch(function (err) {
          hookConnectBtn.disabled = false;
          setHookStatus(false, 'Connect failed: ' + (err && err.message || err));
        });
      });
    }

    var btn = document.getElementById('btn-settings');
    if (btn) btn.addEventListener('click', refresh);

    var upstreamLink = document.getElementById('clawd-upstream-link');
    if (upstreamLink && window.electronAPI && window.electronAPI.openExternal) {
      upstreamLink.addEventListener('click', function (e) {
        e.preventDefault();
        window.electronAPI.openExternal(upstreamLink.href);
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }
})();

(function wireCtxDefaultSetting() {
  var sel = document.getElementById('setting-ctx-default');
  if (!sel) return;
  sel.addEventListener('change', function () {
    setCtxDefaultPref(sel.value);
    // Apply immediately to live columns: clear cached effectiveLimit so the
    // next poll picks up the new pref. (Heuristic still promotes if tokens > 200k.)
    if (typeof allColumns !== 'undefined') {
      allColumns.forEach(function (c) { c.effectiveLimit = null; });
    }
  });
})();

document.getElementById('settings-close').addEventListener('click', function () {
  settingsModal.classList.add('hidden');
});

settingsModal.addEventListener('click', function (e) {
  if (e.target === settingsModal) settingsModal.classList.add('hidden');
});

settingsModal.querySelectorAll('.settings-tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    var key = tab.getAttribute('data-settings-tab');
    settingsModal.querySelectorAll('.settings-tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
    settingsModal.querySelectorAll('.settings-pane').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-settings-pane') === key);
    });
  });
});

document.getElementById('setting-notif-taskbar').addEventListener('change', saveNotifSettings);
document.getElementById('setting-notif-sidebar').addEventListener('change', saveNotifSettings);
document.getElementById('setting-notif-header').addEventListener('change', saveNotifSettings);
document.getElementById('setting-start-with-os').addEventListener('change', saveStartWithOS);

document.getElementById('btn-browse-agent-repos').addEventListener('click', function () {
  window.electronAPI.openDirectoryDialog().then(function (result) {
    if (result) {
      document.getElementById('setting-agent-repos-dir').value = result;
      window.electronAPI.updateAutomationSettings({ agentReposBaseDir: result });
    }
  });
});

document.getElementById('setting-agent-repos-dir').addEventListener('change', function () {
  window.electronAPI.updateAutomationSettings({ agentReposBaseDir: this.value.trim() });
});

document.getElementById('setting-agent-repos-dir').addEventListener('keydown', function (e) {
  e.stopPropagation();
});

// --- Tools tab wiring ---
(function wireToolsTab() {
  var editorInput = document.getElementById('setting-external-editor');
  var editorBtn = document.getElementById('btn-edit-global-claudemd');
  var autoUpdEl = document.getElementById('setting-auto-update-claude');
  if (!editorInput) return;
  if (window.electronAPI && window.electronAPI.getExternalEditorCommand) {
    window.electronAPI.getExternalEditorCommand().then(function (cmd) {
      editorInput.value = cmd || '';
    });
  }
  if (window.electronAPI && window.electronAPI.getAutoUpdateClaude && autoUpdEl) {
    window.electronAPI.getAutoUpdateClaude().then(function (v) { autoUpdEl.checked = !!v; });
  }
  editorInput.addEventListener('change', function () {
    if (window.electronAPI && window.electronAPI.setExternalEditorCommand) {
      window.electronAPI.setExternalEditorCommand(editorInput.value.trim());
    }
  });
  editorInput.addEventListener('keydown', function (e) { e.stopPropagation(); });
  if (autoUpdEl) {
    autoUpdEl.addEventListener('change', function () {
      if (window.electronAPI && window.electronAPI.setAutoUpdateClaude) {
        window.electronAPI.setAutoUpdateClaude(autoUpdEl.checked);
      }
    });
  }
  if (editorBtn) {
    editorBtn.addEventListener('click', function () {
      settingsModal.classList.add('hidden');
      openClaudeMdModal({ global: true });
    });
  }
})();

// --- Voice tab wiring ---
// The ElevenLabs API key is write-only from the UI: getVoiceSettings never
// returns it, so we only show a saved/placeholder state and only send a new
// key when the user has actually typed one (i.e. the field differs from the
// saved placeholder).
var VOICE_SAVED_PLACEHOLDER = '•••••••• (saved)';

// Voice tuning defaults — mirror the backend defaults in getVoiceSettings().
var VOICE_TUNING_DEFAULTS = { stability: 0.5, style: 0, speed: 1.0, similarityBoost: 0.75, speakerBoost: true };

function voiceTuningReadout(id, value, isSpeed) {
  var el = document.getElementById(id);
  if (!el) return;
  var n = parseFloat(value);
  if (isNaN(n)) n = 0;
  el.textContent = isSpeed ? (n.toFixed(2) + '×') : n.toFixed(2);
}

function updateVoiceTuningReadouts() {
  var stab = document.getElementById('setting-voice-stability');
  var sty = document.getElementById('setting-voice-style');
  var spd = document.getElementById('setting-voice-speed');
  var sim = document.getElementById('setting-voice-similarity');
  if (stab) voiceTuningReadout('setting-voice-stability-val', stab.value);
  if (sty) voiceTuningReadout('setting-voice-style-val', sty.value);
  if (spd) voiceTuningReadout('setting-voice-speed-val', spd.value, true);
  if (sim) voiceTuningReadout('setting-voice-similarity-val', sim.value);
}

function voiceTypedApiKey() {
  // Returns the freshly-typed key, or '' when the field is empty. The saved
  // placeholder never lives in .value, so a simple read suffices.
  var el = document.getElementById('setting-voice-apikey');
  return el ? el.value.trim() : '';
}

function voiceFriendlyError(err) {
  var s = String(err == null ? '' : err).toLowerCase();
  if (s.indexOf('no_api_key') !== -1 || s.indexOf('no api key') !== -1) {
    return 'Enter your API key first.';
  }
  if (s.indexOf('subscription') !== -1 ||
      s.indexOf('not available on your current plan') !== -1 ||
      s.indexOf('ivc_not_permitted') !== -1 ||
      s.indexOf('subscription_required') !== -1) {
    return 'This voice needs a paid ElevenLabs plan — pick a premade voice or upgrade.';
  }
  if (s.indexOf('key') !== -1 || s.indexOf('auth') !== -1 ||
      s.indexOf('401') !== -1 || s.indexOf('unauthor') !== -1) {
    return 'Invalid API key — check your ElevenLabs account.';
  }
  return 'Voice request failed. Check your key and try again.';
}

function voiceKeyStatus(msg) {
  var el = document.getElementById('setting-voice-key-status');
  if (el) el.textContent = msg || '';
}

function loadVoiceSettings() {
  if (!window.electronAPI || !window.electronAPI.getVoiceSettings) return;
  var enabledEl = document.getElementById('setting-voice-enabled');
  var keyEl = document.getElementById('setting-voice-apikey');
  var modeEl = document.getElementById('setting-voice-mode');
  var voiceEl = document.getElementById('setting-voice-voiceid');
  var modelEl = document.getElementById('setting-voice-model');
  var readingModeEl = document.getElementById('setting-voice-readingmode');
  var maxEl = document.getElementById('setting-voice-maxchars');
  var warnEl = document.getElementById('setting-voice-encryption-warning');
  var statusEl = document.getElementById('setting-voice-test-status');
  if (!enabledEl) return;
  if (statusEl) statusEl.textContent = '';
  window.electronAPI.getVoiceSettings().then(function (v) {
    v = v || {};
    enabledEl.checked = !!v.enabled;
    if (modeEl) modeEl.value = v.mode || 'active';
    if (modelEl) modelEl.value = v.modelId || 'eleven_flash_v2_5';
    if (readingModeEl) readingModeEl.value = v.readingMode || 'auto';
    if (maxEl) maxEl.value = (v.maxChars != null ? v.maxChars : 600);
    var stabEl = document.getElementById('setting-voice-stability');
    var styEl = document.getElementById('setting-voice-style');
    var spdEl = document.getElementById('setting-voice-speed');
    var simEl = document.getElementById('setting-voice-similarity');
    var spkEl = document.getElementById('setting-voice-speakerboost');
    if (stabEl) stabEl.value = (v.stability != null ? v.stability : VOICE_TUNING_DEFAULTS.stability);
    if (styEl) styEl.value = (v.style != null ? v.style : VOICE_TUNING_DEFAULTS.style);
    if (spdEl) spdEl.value = (v.speed != null ? v.speed : VOICE_TUNING_DEFAULTS.speed);
    if (simEl) simEl.value = (v.similarityBoost != null ? v.similarityBoost : VOICE_TUNING_DEFAULTS.similarityBoost);
    if (spkEl) spkEl.checked = v.speakerBoost !== false;
    updateVoiceTuningReadouts();
    if (keyEl) {
      keyEl.value = '';
      keyEl.placeholder = v.hasApiKey ? VOICE_SAVED_PLACEHOLDER : 'Paste your ElevenLabs API key';
    }
    if (warnEl) warnEl.classList.toggle('hidden', v.encryptionAvailable !== false);
    var fcEl = document.getElementById('setting-voice-focuscatchup'); if (fcEl) fcEl.checked = v.focusCatchUp !== false;
    var dlEl = document.getElementById('setting-voice-debuglog'); if (dlEl) dlEl.checked = !!v.debugLog;
    var presetEl = document.getElementById('setting-voice-personality-preset');
    if (presetEl) presetEl.value = v.personalityPreset || '';
    var personaTextEl = document.getElementById('setting-voice-personality-text');
    if (personaTextEl) {
      if (window.electronAPI && window.electronAPI.getPersonality) {
        window.electronAPI.getPersonality().then(function (res) {
          personaTextEl.value = (res && res.ok ? res.personality : '') || v.personality || '';
        }).catch(function () { personaTextEl.value = v.personality || ''; });
      } else {
        personaTextEl.value = v.personality || '';
      }
    }
    // Voice dropdown: show the saved choice immediately, then try to load the
    // full list if we have a stored key.
    if (voiceEl) {
      while (voiceEl.firstChild) voiceEl.removeChild(voiceEl.firstChild);
      if (v.voiceId) {
        var saved = document.createElement('option');
        saved.value = v.voiceId;
        saved.textContent = v.voiceName || v.voiceId;
        saved.selected = true;
        voiceEl.appendChild(saved);
      } else {
        var none = document.createElement('option');
        none.value = '';
        none.textContent = v.hasApiKey ? 'Click Refresh to load voices' : 'Enter API key first';
        voiceEl.appendChild(none);
      }
      if (v.hasApiKey) {
        while (voiceEl.firstChild) voiceEl.removeChild(voiceEl.firstChild);
        var loading = document.createElement('option');
        loading.value = v.voiceId || '';
        loading.textContent = 'Loading…';
        loading.selected = true;
        voiceEl.appendChild(loading);
        window.electronAPI.listVoices().then(function (res) {
          if (res && res.ok) {
            populateVoiceOptions(res.voices, v.voiceId);
            var ve = document.getElementById('setting-voice-voiceid');
            if (ve && ve.value && ve.value !== v.voiceId) {
              saveVoiceSettings(); // persist the auto-selected voice so auto-play has a voiceId
            }
          }
        }).catch(function () { /* leave saved-name fallback */ });
      }
    }
  }).catch(function () { /* IPC missing in dev — leave defaults */ });
}

function populateVoiceOptions(voices, selectedId) {
  var voiceEl = document.getElementById('setting-voice-voiceid');
  if (!voiceEl || !voices) return;
  while (voiceEl.firstChild) voiceEl.removeChild(voiceEl.firstChild);
  voices.forEach(function (vo) {
    var opt = document.createElement('option');
    opt.value = vo.id;
    opt.textContent = (vo.category && vo.category !== 'premade')
      ? (vo.name || vo.id) + ' — ' + vo.category
      : (vo.name || vo.id);
    if (vo.id === selectedId) opt.selected = true;
    voiceEl.appendChild(opt);
  });
}

function saveVoiceSettings() {
  if (!window.electronAPI || !window.electronAPI.setVoiceSettings) return Promise.resolve();
  var keyEl = document.getElementById('setting-voice-apikey');
  var modeEl = document.getElementById('setting-voice-mode');
  var voiceEl = document.getElementById('setting-voice-voiceid');
  var modelEl = document.getElementById('setting-voice-model');
  var readingModeEl = document.getElementById('setting-voice-readingmode');
  var maxEl = document.getElementById('setting-voice-maxchars');
  var opt = voiceEl && voiceEl.options[voiceEl.selectedIndex];
  var payload = {
    mode: modeEl ? modeEl.value : 'active',
    voiceId: opt ? opt.value : '',
    voiceName: opt ? opt.textContent : '',
    modelId: modelEl ? modelEl.value : 'eleven_flash_v2_5',
    readingMode: readingModeEl ? readingModeEl.value : 'auto',
    maxChars: maxEl ? parseInt(maxEl.value, 10) || 600 : 600,
    focusCatchUp: (document.getElementById('setting-voice-focuscatchup') || {}).checked !== false,
    debugLog: (document.getElementById('setting-voice-debuglog') || {}).checked === true
  };
  var stabEl = document.getElementById('setting-voice-stability');
  var styEl = document.getElementById('setting-voice-style');
  var spdEl = document.getElementById('setting-voice-speed');
  var simEl = document.getElementById('setting-voice-similarity');
  var spkEl = document.getElementById('setting-voice-speakerboost');
  payload.stability = stabEl ? (parseFloat(stabEl.value)) : VOICE_TUNING_DEFAULTS.stability;
  if (isNaN(payload.stability)) payload.stability = VOICE_TUNING_DEFAULTS.stability;
  payload.style = styEl ? (parseFloat(styEl.value)) : VOICE_TUNING_DEFAULTS.style;
  if (isNaN(payload.style)) payload.style = VOICE_TUNING_DEFAULTS.style;
  payload.speed = spdEl ? (parseFloat(spdEl.value)) : VOICE_TUNING_DEFAULTS.speed;
  if (isNaN(payload.speed)) payload.speed = VOICE_TUNING_DEFAULTS.speed;
  payload.similarityBoost = simEl ? (parseFloat(simEl.value)) : VOICE_TUNING_DEFAULTS.similarityBoost;
  if (isNaN(payload.similarityBoost)) payload.similarityBoost = VOICE_TUNING_DEFAULTS.similarityBoost;
  payload.speakerBoost = spkEl ? spkEl.checked : VOICE_TUNING_DEFAULTS.speakerBoost;
  var typed = voiceTypedApiKey();
  if (typed) payload.apiKey = typed;
  var sentKey = !!typed;
  return window.electronAPI.setVoiceSettings(payload).then(function () {
    if (keyEl && sentKey) { keyEl.value = ''; keyEl.placeholder = VOICE_SAVED_PLACEHOLDER; }
    if (sentKey) voiceKeyStatus('API key saved.');
    return window.__refreshVoiceSettings && window.__refreshVoiceSettings();
  }).catch(function (err) {
    // Surface key-save failures so a first-time user isn't left guessing.
    if (sentKey) voiceKeyStatus(voiceFriendlyError(err && err.message || err));
  });
}

(function wireVoiceTab() {
  var enabledEl = document.getElementById('setting-voice-enabled');
  var keyEl = document.getElementById('setting-voice-apikey');
  var clearKeyEl = document.getElementById('setting-voice-clearkey');
  var modeEl = document.getElementById('setting-voice-mode');
  var voiceEl = document.getElementById('setting-voice-voiceid');
  var modelEl = document.getElementById('setting-voice-model');
  var readingModeEl = document.getElementById('setting-voice-readingmode');
  var maxEl = document.getElementById('setting-voice-maxchars');
  var refreshBtn = document.getElementById('setting-voice-refresh');
  var testBtn = document.getElementById('setting-voice-test');
  var statusEl = document.getElementById('setting-voice-test-status');
  var clearStatusEl = document.getElementById('setting-voice-clearkey-status');
  if (!enabledEl) return;

  if (enabledEl) enabledEl.addEventListener('change', function () {
    if (!window.electronAPI || !window.electronAPI.setVoiceSettings) return;
    window.electronAPI.setVoiceSettings({ enabled: enabledEl.checked })
      .then(function () { return window.__refreshVoiceSettings && window.__refreshVoiceSettings(); })
      .then(function () { if (typeof updateVoiceToggleUI === 'function') updateVoiceToggleUI(); })
      .catch(function () {});
  });
  if (modeEl) modeEl.addEventListener('change', saveVoiceSettings);
  if (modelEl) modelEl.addEventListener('change', saveVoiceSettings);
  if (readingModeEl) readingModeEl.addEventListener('change', saveVoiceSettings);
  if (maxEl) {
    maxEl.addEventListener('change', saveVoiceSettings);
    maxEl.addEventListener('keydown', function (e) { e.stopPropagation(); });
  }
  if (voiceEl) voiceEl.addEventListener('change', saveVoiceSettings);

  // Voice tuning sliders: update the live readout on input, persist on change
  // (merge-safe backend). Reset restores the documented defaults and saves.
  ['setting-voice-stability', 'setting-voice-style', 'setting-voice-speed', 'setting-voice-similarity'].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', updateVoiceTuningReadouts);
    el.addEventListener('change', saveVoiceSettings);
  });
  var speakerBoostEl = document.getElementById('setting-voice-speakerboost');
  if (speakerBoostEl) speakerBoostEl.addEventListener('change', saveVoiceSettings);
  var tuningResetEl = document.getElementById('setting-voice-tuning-reset');
  if (tuningResetEl) {
    tuningResetEl.addEventListener('click', function () {
      var stabEl = document.getElementById('setting-voice-stability');
      var styEl = document.getElementById('setting-voice-style');
      var spdEl = document.getElementById('setting-voice-speed');
      var simEl = document.getElementById('setting-voice-similarity');
      var spkEl = document.getElementById('setting-voice-speakerboost');
      if (stabEl) stabEl.value = VOICE_TUNING_DEFAULTS.stability;
      if (styEl) styEl.value = VOICE_TUNING_DEFAULTS.style;
      if (spdEl) spdEl.value = VOICE_TUNING_DEFAULTS.speed;
      if (simEl) simEl.value = VOICE_TUNING_DEFAULTS.similarityBoost;
      if (spkEl) spkEl.checked = VOICE_TUNING_DEFAULTS.speakerBoost;
      updateVoiceTuningReadouts();
      saveVoiceSettings();
    });
  }

  var focusCatchUpEl = document.getElementById('setting-voice-focuscatchup');
  if (focusCatchUpEl) focusCatchUpEl.addEventListener('change', saveVoiceSettings);

  var debugLogEl = document.getElementById('setting-voice-debuglog');
  if (debugLogEl) debugLogEl.addEventListener('change', saveVoiceSettings);
  var openLogEl = document.getElementById('setting-voice-openlog');
  if (openLogEl) openLogEl.addEventListener('click', function () {
    try { if (window.electronAPI && window.electronAPI.revealVoiceLog) window.electronAPI.revealVoiceLog(); } catch (e) {}
  });

  var personaPresetEl = document.getElementById('setting-voice-personality-preset');
  var personaTextEl = document.getElementById('setting-voice-personality-text');
  var personaApplyEl = document.getElementById('setting-voice-personality-apply');
  var personaStatusEl = document.getElementById('setting-voice-personality-status');
  function selectedPersonaText() {
    if (!personaPresetEl) return '';
    var opt = personaPresetEl.options[personaPresetEl.selectedIndex];
    return opt ? (opt.getAttribute('data-persona') || '') : '';
  }
  if (personaPresetEl) {
    personaPresetEl.addEventListener('change', function () {
      if (personaPresetEl.value && personaTextEl) personaTextEl.value = selectedPersonaText();
    });
  }
  if (personaTextEl) {
    personaTextEl.addEventListener('keydown', function (e) { e.stopPropagation(); });
    personaTextEl.addEventListener('input', function () {
      if (personaPresetEl && personaPresetEl.value && personaTextEl.value !== selectedPersonaText()) {
        personaPresetEl.value = '';
      }
    });
  }
  if (personaApplyEl) {
    personaApplyEl.addEventListener('click', function () {
      if (!window.electronAPI || !window.electronAPI.setPersonality) return;
      var text = (document.getElementById('setting-voice-personality-text') || {}).value || '';
      var preset = (document.getElementById('setting-voice-personality-preset') || {}).value || '';
      var statusEl2 = document.getElementById('setting-voice-personality-status');
      window.electronAPI.setPersonality(text).then(function (res) {
        if (res && res.ok) {
          if (statusEl2) statusEl2.textContent = text.trim() ? 'Personality applied.' : 'Personality cleared.';
          return window.electronAPI.setVoiceSettings({ personality: text, personalityPreset: preset }).then(function () { if (window.__refreshVoiceSettings) return window.__refreshVoiceSettings(); });
        }
        if (statusEl2) statusEl2.textContent = 'Could not update CLAUDE.md.';
      }).catch(function () { if (statusEl2) statusEl2.textContent = 'Could not update CLAUDE.md.'; });
    });
  }

  if (keyEl) {
    keyEl.addEventListener('keydown', function (e) { e.stopPropagation(); });
    // Persist a freshly-typed key on commit (change) or focus-loss (blur) —
    // only when text is present, so closing the tab with an empty field is a no-op.
    var saveTypedKey = function () { if (voiceTypedApiKey()) saveVoiceSettings(); };
    keyEl.addEventListener('change', saveTypedKey);
    keyEl.addEventListener('blur', saveTypedKey);
  }

  if (clearKeyEl) {
    clearKeyEl.addEventListener('click', function () {
      if (!window.electronAPI || !window.electronAPI.setVoiceSettings) return;
      window.electronAPI.setVoiceSettings({ apiKey: '', clearApiKey: true }).then(function () {
        if (keyEl) { keyEl.value = ''; keyEl.placeholder = 'Paste your ElevenLabs API key'; }
        if (clearStatusEl) clearStatusEl.textContent = 'Key cleared.';
        return window.__refreshVoiceSettings && window.__refreshVoiceSettings();
      }).catch(function (err) {
        if (clearStatusEl) clearStatusEl.textContent = voiceFriendlyError(err && err.message || err);
      });
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      if (!window.electronAPI || !window.electronAPI.listVoices) return;
      if (statusEl) statusEl.textContent = 'Loading voices…';
      var typed = voiceTypedApiKey();
      window.electronAPI.listVoices(typed ? { apiKeyOverride: typed } : {}).then(function (res) {
        if (res && res.ok) {
          var cur = voiceEl && voiceEl.value;
          populateVoiceOptions(res.voices, cur);
          if (statusEl) statusEl.textContent = '';
          return;
        }
        if (statusEl) statusEl.textContent = voiceFriendlyError(res && res.error);
      }).catch(function (err) {
        if (statusEl) statusEl.textContent = voiceFriendlyError(err && err.message || err);
      });
    });
  }

  if (testBtn) {
    testBtn.addEventListener('click', function () {
      if (!window.electronAPI || !window.electronAPI.synthesizeVoice) return;
      var apikeyEl = document.getElementById('setting-voice-apikey');
      var hasKey = voiceTypedApiKey() || (apikeyEl && apikeyEl.placeholder === VOICE_SAVED_PLACEHOLDER);
      if (!hasKey) {
        if (statusEl) statusEl.textContent = 'Enter an API key first.';
        return;
      }
      var opt = voiceEl && voiceEl.options[voiceEl.selectedIndex];
      if (!opt || !opt.value) {
        if (statusEl) statusEl.textContent = 'Choose a voice first — click Refresh.';
        return;
      }
      var typed = voiceTypedApiKey();
      var req = {
        text: 'Hello from Claudes. Your voice output is working correctly.',
        voiceId: opt ? opt.value : '',
        modelId: modelEl ? modelEl.value : 'eleven_flash_v2_5'
      };
      if (typed) req.apiKeyOverride = typed;
      if (statusEl) statusEl.textContent = 'Synthesizing…';
      window.electronAPI.synthesizeVoice(req).then(function (result) {
        if (result && result.ok) {
          if (statusEl) statusEl.textContent = 'Playing…';
          if (window.__playVoiceTest) {
            window.__playVoiceTest(result, function () {
              if (statusEl && statusEl.textContent === 'Playing…') statusEl.textContent = '';
            }, function (err) {
              var name = (err && (err.name || err.message)) ? (err.name || err.message) : 'playback failed';
              if (statusEl) statusEl.textContent = 'Could not play audio (' + name + ').';
            });
          }
        } else {
          if (statusEl) statusEl.textContent = voiceFriendlyError(result && result.error);
        }
      }).catch(function (err) {
        if (statusEl) statusEl.textContent = voiceFriendlyError(err && err.message || err);
      });
    });
  }
})();

// --- Terminal tab wiring ---
var TERM_DEFAULTS = { fontFamily: '', scrollback: 5000, cursorStyle: 'block', background: '#1a1a2e', foreground: '#e0e0e0' };
var termSettings = Object.assign({}, TERM_DEFAULTS);
(function wireTerminalTab() {
  var fontEl = document.getElementById('setting-term-font');
  var sbEl = document.getElementById('setting-term-scrollback');
  var cursorEl = document.getElementById('setting-term-cursor');
  var bgEl = document.getElementById('setting-term-bg');
  var fgEl = document.getElementById('setting-term-fg');
  var resetBtn = document.getElementById('setting-term-reset');
  if (!fontEl) return;
  function applyToUi() {
    fontEl.value = termSettings.fontFamily || '';
    sbEl.value = String(termSettings.scrollback || 5000);
    cursorEl.value = termSettings.cursorStyle || 'block';
    bgEl.value = termSettings.background || TERM_DEFAULTS.background;
    if (fgEl) fgEl.value = termSettings.foreground || TERM_DEFAULTS.foreground;
  }
  if (window.electronAPI && window.electronAPI.getTerminalSettings) {
    window.electronAPI.getTerminalSettings().then(function (s) {
      termSettings = Object.assign({}, TERM_DEFAULTS, s || {});
      applyToUi();
    });
  }
  function save(partial) {
    termSettings = Object.assign(termSettings, partial);
    if (window.electronAPI && window.electronAPI.setTerminalSettings) {
      window.electronAPI.setTerminalSettings(termSettings);
    }
  }
  fontEl.addEventListener('change', function () { save({ fontFamily: fontEl.value }); });
  sbEl.addEventListener('change', function () { save({ scrollback: parseInt(sbEl.value, 10) || 5000 }); });
  cursorEl.addEventListener('change', function () { save({ cursorStyle: cursorEl.value }); });
  bgEl.addEventListener('change', function () { save({ background: bgEl.value }); });
  if (fgEl) fgEl.addEventListener('change', function () { save({ foreground: fgEl.value }); });
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      termSettings = Object.assign({}, TERM_DEFAULTS);
      applyToUi();
      if (window.electronAPI && window.electronAPI.setTerminalSettings) {
        window.electronAPI.setTerminalSettings(termSettings);
      }
      if (typeof showToast === 'function') showToast('Terminal settings reset to defaults', { kind: 'success' });
    });
  }
  [fontEl, sbEl, cursorEl, bgEl, fgEl].forEach(function (el) {
    if (!el) return;
    el.addEventListener('keydown', function (e) { e.stopPropagation(); });
  });
})();

btnClaudeMd.addEventListener('click', openClaudeMdModal);

document.getElementById('btn-claude-config').addEventListener('click', function () {
  if (!window.electronAPI || !window.electronAPI.getClaudeConfigPath) return;
  window.electronAPI.getClaudeConfigPath().then(function (configPath) {
    openFileEditor(configPath);
  });
});

(function wireCheckForUpdates() {
  var btn = document.getElementById('btn-check-updates');
  if (!btn || !window.electronAPI || !window.electronAPI.checkForUpdates) return;
  btn.addEventListener('click', function () {
    btn.disabled = true;
    var origLabel = btn.textContent;
    btn.textContent = 'Checking…';
    window.electronAPI.checkForUpdates().then(function (res) {
      btn.disabled = false;
      btn.textContent = origLabel;
      // We rely on the existing update banner events (update:available /
      // update:downloaded / update:none) for visible feedback, so nothing
      // more to do here. Errors get surfaced via update:error.
      if (res && res.error) console.warn('[update] check failed:', res.error);
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = origLabel;
      console.warn('[update] check threw:', err && err.message);
    });
  });

  // "You're up to date" toast — surfaced as a transient update bar
  // message so we don't add a new UI element.
  if (window.electronAPI.onUpdateNone) {
    window.electronAPI.onUpdateNone(function (info) {
      var bar = document.getElementById('update-bar');
      var msg = document.getElementById('update-message');
      var action = document.getElementById('update-action');
      var notes = document.getElementById('update-notes-toggle');
      if (!bar || !msg) return;
      msg.textContent = "You're on the latest version (v" + (info && info.version) + ').';
      if (action) action.style.display = 'none';
      if (notes) notes.classList.add('hidden');
      bar.classList.remove('hidden');
      setTimeout(function () { bar.classList.add('hidden'); }, 4000);
    });
  }
})();
claudeMdClose.addEventListener('click', closeClaudeMdModal);
claudeMdSave.addEventListener('click', saveClaudeMd);

claudeMdModal.addEventListener('click', function (e) {
  if (e.target === claudeMdModal) closeClaudeMdModal();
});

claudeMdEditor.addEventListener('keydown', function (e) {
  // Cmd/Ctrl+S to save
  if (cmdOrCtrl(e) && e.key === 's') {
    e.preventDefault();
    saveClaudeMd();
  }
  // Escape to close
  if (e.key === 'Escape') {
    e.preventDefault();
    closeClaudeMdModal();
  }
  // Prevent shortcuts from bubbling to terminal
  e.stopPropagation();
});

// ============================================================
// File Editor Modal
// ============================================================

var fileEditorModal = document.getElementById('fileeditor-modal');
var fileEditorEditor = document.getElementById('fileeditor-editor');
var fileEditorFilename = document.getElementById('fileeditor-filename');
var fileEditorPath = document.getElementById('fileeditor-path');
var fileEditorClose = document.getElementById('fileeditor-close');
var fileEditorSave = document.getElementById('fileeditor-save');
var fileEditorStatus = document.getElementById('fileeditor-status');
var fileEditorCurrentPath = null;
var fileEditorOriginal = '';

// Map file extensions to Prism language identifiers. Anything not mapped
// falls back to no highlight (the preview just shows uncolored monospace).
var PRISM_LANG_BY_EXT = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'jsx', '.ts': 'typescript', '.tsx': 'tsx',
  '.json': 'json', '.html': 'markup', '.xml': 'markup', '.svg': 'markup',
  '.css': 'css', '.scss': 'css', '.less': 'css',
  '.py': 'python', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.rs': 'rust', '.go': 'go',
  '.md': 'markdown', '.markdown': 'markdown'
};
function prismLanguageFor(filePath) {
  var i = (filePath || '').lastIndexOf('.');
  if (i < 0) return null;
  return PRISM_LANG_BY_EXT[filePath.slice(i).toLowerCase()] || null;
}
function syncFileEditorPreview() {
  var pre = document.getElementById('fileeditor-preview');
  if (!pre) return;
  var code = pre.querySelector('code');
  code.className = '';
  var lang = prismLanguageFor(fileEditorCurrentPath || '');
  if (lang) code.className = 'language-' + lang;
  code.textContent = fileEditorEditor.value;
  if (typeof Prism !== 'undefined' && lang && Prism.languages && Prism.languages[lang]) {
    try { Prism.highlightElement(code); } catch (e) { /* */ }
  }
}

function openFileEditor(filePath, jumpToLine) {
  if (!window.electronAPI) return;

  var name = filePath.replace(/\\/g, '/').split('/').pop();
  fileEditorFilename.textContent = name;
  fileEditorPath.textContent = filePath;
  fileEditorStatus.textContent = 'Loading...';
  fileEditorEditor.value = '';
  fileEditorCurrentPath = filePath;
  fileEditorModal.classList.remove('hidden');

  window.electronAPI.readFile(filePath).then(function (result) {
    if (result.error) {
      fileEditorStatus.textContent = result.error;
      fileEditorEditor.value = '';
      fileEditorEditor.disabled = true;
      fileEditorSave.disabled = true;
    } else {
      fileEditorEditor.value = result.content;
      fileEditorOriginal = result.content;
      fileEditorEditor.disabled = false;
      fileEditorSave.disabled = false;
      fileEditorStatus.textContent = '';
      updateFileEditorGutter();
      updateCursorPos();
      fileEditorEditor.scrollTop = 0;
      syncGutterScroll();
      if (jumpToLine && jumpToLine > 1) jumpEditorToLine(jumpToLine);
    }
  });
}

// Place the textarea cursor at the start of the requested 1-based line and
// scroll the line into view. Used by terminal link clicks like `foo.js:42`.
function jumpEditorToLine(line) {
  var text = fileEditorEditor.value;
  var idx = 0;
  var current = 1;
  while (current < line) {
    var nl = text.indexOf('\n', idx);
    if (nl === -1) break;
    idx = nl + 1;
    current++;
  }
  fileEditorEditor.focus();
  fileEditorEditor.setSelectionRange(idx, idx);
  // Approximate scroll: textarea rows aren't directly addressable, but
  // setSelectionRange + a small scroll bump pulls the cursor into view.
  var lineHeight = parseInt(getComputedStyle(fileEditorEditor).lineHeight, 10) || 18;
  fileEditorEditor.scrollTop = Math.max(0, (line - 3) * lineHeight);
  if (typeof syncGutterScroll === 'function') syncGutterScroll();
}

// Resolve a terminal-emitted file:line click against the column's cwd, then
// open the inline editor focused on that line. Skips absolute paths that
// fall outside the project (main rejects them anyway).
function openFileAtLine(relPath, line) {
  if (!relPath) return;
  // Find the focused column's cwd to resolve relative paths.
  var cwd = null;
  try {
    var st = getActiveState();
    if (st && st.focusedColumnId !== null) {
      var c = allColumns.get(st.focusedColumnId);
      if (c) cwd = c.cwd || null;
    }
  } catch (e) { /* no focused column */ }
  var isAbsolute = /^([A-Za-z]:[\\/]|[\\/])/.test(relPath);
  var full = isAbsolute ? relPath : (cwd ? (cwd.replace(/[\\/]$/, '') + '/' + relPath) : relPath);
  openFileEditor(full, line);
}

function closeFileEditor() {
  if (fileEditorEditor.value !== fileEditorOriginal && fileEditorCurrentPath) {
    if (!confirm('You have unsaved changes. Close anyway?')) return;
  }
  fileEditorModal.classList.add('hidden');
  fileEditorCurrentPath = null;
  fileEditorOriginal = '';
  if (typeof findBar !== 'undefined' && findBar) findBar.classList.add('hidden');
  // Reset preview state so the next file opens in edit mode.
  var pre = document.getElementById('fileeditor-preview');
  if (pre) pre.classList.add('hidden');
  fileEditorEditor.style.display = '';
  var pbtn = document.getElementById('fileeditor-preview-btn');
  if (pbtn) pbtn.textContent = 'Preview';
}

function saveFileEditor() {
  if (!fileEditorCurrentPath || !window.electronAPI) return;

  fileEditorStatus.textContent = 'Saving...';
  window.electronAPI.writeFile(fileEditorCurrentPath, fileEditorEditor.value).then(function (result) {
    if (result.success) {
      fileEditorOriginal = fileEditorEditor.value;
      fileEditorStatus.textContent = 'Saved';
      setTimeout(function () {
        if (fileEditorStatus.textContent === 'Saved') fileEditorStatus.textContent = '';
      }, 2000);
    } else {
      fileEditorStatus.textContent = 'Error: ' + result.error;
    }
  });
}

// Preview toggle — swap the textarea for a syntax-highlighted readonly view.
var fileEditorPreviewBtn = document.getElementById('fileeditor-preview-btn');
if (fileEditorPreviewBtn) {
  fileEditorPreviewBtn.addEventListener('click', function () {
    var pre = document.getElementById('fileeditor-preview');
    if (!pre) return;
    var isPreviewing = !pre.classList.contains('hidden');
    if (isPreviewing) {
      pre.classList.add('hidden');
      fileEditorEditor.style.display = '';
      fileEditorPreviewBtn.textContent = 'Preview';
    } else {
      syncFileEditorPreview();
      pre.classList.remove('hidden');
      fileEditorEditor.style.display = 'none';
      fileEditorPreviewBtn.textContent = 'Edit';
    }
  });
}

fileEditorClose.addEventListener('click', closeFileEditor);
fileEditorSave.addEventListener('click', saveFileEditor);

fileEditorModal.addEventListener('click', function (e) {
  if (e.target === fileEditorModal) closeFileEditor();
});

fileEditorEditor.addEventListener('keydown', function (e) {
  var mod = cmdOrCtrl(e);
  // Cmd/Ctrl+S to save
  if (mod && e.key === 's') {
    e.preventDefault();
    saveFileEditor();
  }
  // Cmd/Ctrl+F to open find bar
  if (mod && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    openFindBar(false);
  }
  // Cmd/Ctrl+H to open find+replace
  if (mod && (e.key === 'h' || e.key === 'H')) {
    e.preventDefault();
    openFindBar(true);
  }
  // Escape to close
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!findBar.classList.contains('hidden')) closeFindBar();
    else closeFileEditor();
  }
  // Tab inserts spaces instead of changing focus
  if (e.key === 'Tab') {
    e.preventDefault();
    var start = fileEditorEditor.selectionStart;
    var end = fileEditorEditor.selectionEnd;
    fileEditorEditor.value = fileEditorEditor.value.substring(0, start) + '  ' + fileEditorEditor.value.substring(end);
    fileEditorEditor.selectionStart = fileEditorEditor.selectionEnd = start + 2;
    updateFileEditorGutter();
  }
  e.stopPropagation();
});

// ─────────────────────────────────────────────────────────
// File editor: line-number gutter + find/replace
// ─────────────────────────────────────────────────────────
var fileEditorGutter = document.getElementById('fileeditor-gutter');
var fileEditorCursorPos = document.getElementById('fileeditor-cursor-pos');
var findBar = document.getElementById('fileeditor-find-bar');
var findInput = document.getElementById('fileeditor-find-input');
var findCount = document.getElementById('fileeditor-find-count');
var findPrev = document.getElementById('fileeditor-find-prev');
var findNext = document.getElementById('fileeditor-find-next');
var findCase = document.getElementById('fileeditor-find-case');
var replaceInput = document.getElementById('fileeditor-replace-input');
var replaceOne = document.getElementById('fileeditor-replace-one');
var replaceAll = document.getElementById('fileeditor-replace-all');
var findClose = document.getElementById('fileeditor-find-close');

var findMatches = [];
var findCurrentIdx = -1;

function updateFileEditorGutter() {
  if (!fileEditorGutter) return;
  var lines = fileEditorEditor.value.split('\n').length;
  // Cap is generous; assembling huge strings is still cheap (<200k lines is fine).
  var nums = '';
  for (var i = 1; i <= lines; i++) nums += (i === 1 ? '' : '\n') + i;
  fileEditorGutter.textContent = nums;
}

function syncGutterScroll() {
  if (!fileEditorGutter) return;
  fileEditorGutter.scrollTop = fileEditorEditor.scrollTop;
}

function updateCursorPos() {
  if (!fileEditorCursorPos) return;
  var pos = fileEditorEditor.selectionStart;
  var before = fileEditorEditor.value.substring(0, pos);
  var line = before.split('\n').length;
  var col = pos - before.lastIndexOf('\n');
  fileEditorCursorPos.textContent = 'Ln ' + line + ', Col ' + col;
}

fileEditorEditor.addEventListener('input', function () {
  updateFileEditorGutter();
  updateCursorPos();
  // Re-run search if find bar is open
  if (!findBar.classList.contains('hidden')) runFind(false);
});
fileEditorEditor.addEventListener('scroll', syncGutterScroll);
fileEditorEditor.addEventListener('keyup', updateCursorPos);
fileEditorEditor.addEventListener('click', updateCursorPos);

function openFindBar(focusReplace) {
  findBar.classList.remove('hidden');
  // Pre-fill with selected text if any
  var start = fileEditorEditor.selectionStart;
  var end = fileEditorEditor.selectionEnd;
  if (start !== end) findInput.value = fileEditorEditor.value.substring(start, end);
  runFind(false);
  if (focusReplace) replaceInput.focus();
  else { findInput.focus(); findInput.select(); }
}

function closeFindBar() {
  findBar.classList.add('hidden');
  findMatches = [];
  findCurrentIdx = -1;
  fileEditorEditor.focus();
}

function runFind(advance) {
  var needle = findInput.value;
  if (!needle) {
    findMatches = [];
    findCurrentIdx = -1;
    findCount.textContent = '0 / 0';
    return;
  }
  var hay = fileEditorEditor.value;
  var caseSensitive = findCase.checked;
  if (!caseSensitive) { hay = hay.toLowerCase(); needle = needle.toLowerCase(); }
  findMatches = [];
  var idx = 0;
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    findMatches.push(idx);
    idx += needle.length || 1;
  }
  if (!findMatches.length) {
    findCurrentIdx = -1;
    findCount.textContent = '0 / 0';
    return;
  }
  // Pick the match nearest to (or after) the current caret
  var caret = fileEditorEditor.selectionStart;
  var pick = 0;
  for (var i = 0; i < findMatches.length; i++) {
    if (findMatches[i] >= caret) { pick = i; break; }
    pick = i;
  }
  findCurrentIdx = advance ? (pick + 1) % findMatches.length : pick;
  highlightCurrentMatch();
}

function highlightCurrentMatch() {
  if (findCurrentIdx < 0 || !findMatches.length) {
    findCount.textContent = '0 / 0';
    return;
  }
  findCount.textContent = (findCurrentIdx + 1) + ' / ' + findMatches.length;
  var pos = findMatches[findCurrentIdx];
  var len = findInput.value.length;
  fileEditorEditor.focus();
  fileEditorEditor.setSelectionRange(pos, pos + len);
  // Scroll the selection into view (textarea has no native scroll-to-selection)
  scrollSelectionIntoView();
  updateCursorPos();
}

function scrollSelectionIntoView() {
  // Approximate: put the selection's line at the centre of the visible area.
  var pos = fileEditorEditor.selectionStart;
  var line = fileEditorEditor.value.substring(0, pos).split('\n').length;
  var lineHeight = parseFloat(getComputedStyle(fileEditorEditor).lineHeight) || 21;
  var target = Math.max(0, line * lineHeight - fileEditorEditor.clientHeight / 2);
  fileEditorEditor.scrollTop = target;
}

function findNextMatch() {
  if (!findMatches.length) { runFind(false); if (!findMatches.length) return; }
  findCurrentIdx = (findCurrentIdx + 1) % findMatches.length;
  highlightCurrentMatch();
}

function findPrevMatch() {
  if (!findMatches.length) { runFind(false); if (!findMatches.length) return; }
  findCurrentIdx = (findCurrentIdx - 1 + findMatches.length) % findMatches.length;
  highlightCurrentMatch();
}

function replaceCurrent() {
  if (findCurrentIdx < 0 || !findMatches.length) return;
  var needle = findInput.value;
  var replacement = replaceInput.value;
  var pos = findMatches[findCurrentIdx];
  var content = fileEditorEditor.value;
  fileEditorEditor.value = content.substring(0, pos) + replacement + content.substring(pos + needle.length);
  fileEditorEditor.setSelectionRange(pos + replacement.length, pos + replacement.length);
  updateFileEditorGutter();
  runFind(false);
  // Re-locate to the next match after this position
  for (var i = 0; i < findMatches.length; i++) {
    if (findMatches[i] >= pos + replacement.length) { findCurrentIdx = i; highlightCurrentMatch(); return; }
  }
  if (findMatches.length) { findCurrentIdx = 0; highlightCurrentMatch(); }
}

function replaceAllMatches() {
  if (!findInput.value) return;
  var needle = findInput.value;
  var replacement = replaceInput.value;
  var caseSensitive = findCase.checked;
  var content = fileEditorEditor.value;
  var out = '';
  var i = 0;
  var hay = caseSensitive ? content : content.toLowerCase();
  var n = caseSensitive ? needle : needle.toLowerCase();
  var count = 0;
  while (i < hay.length) {
    var found = hay.indexOf(n, i);
    if (found === -1) { out += content.substring(i); break; }
    out += content.substring(i, found) + replacement;
    i = found + n.length;
    count++;
  }
  if (count === 0) return;
  fileEditorEditor.value = out;
  updateFileEditorGutter();
  runFind(false);
  findCount.textContent = count + ' replaced';
}

findInput.addEventListener('input', function () { runFind(false); });
findInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? findPrevMatch() : findNextMatch(); }
  if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); }
  e.stopPropagation();
});
replaceInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
  if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); }
  e.stopPropagation();
});
findCase.addEventListener('change', function () { runFind(false); });
findNext.addEventListener('click', findNextMatch);
findPrev.addEventListener('click', findPrevMatch);
replaceOne.addEventListener('click', replaceCurrent);
replaceAll.addEventListener('click', replaceAllMatches);
findClose.addEventListener('click', closeFindBar);

// ============================================================
// Usage Modal
// ============================================================

var btnUsage = document.getElementById('btn-usage');
var usageModal = document.getElementById('usage-modal');
var usageClose = document.getElementById('usage-close');
var usageLoading = document.getElementById('usage-loading');
var usageContent = document.getElementById('usage-content');
var usageSubtitle = document.getElementById('usage-subtitle');

var usageData = null;

function escHtml(str) {
  var el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function formatTokenCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatDate(ts) {
  var d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function formatDateTime(ts) {
  var d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function projectKeyToName(key) {
  var parts = key.replace(/^[A-Z]--/, '').split('-');
  return parts[parts.length - 1] || key;
}

function projectPathToKey(p) {
  if (!p) return '';
  // Claude encodes the project directory by replacing every non-alphanumeric
  // character with '-' (this includes ':', '\', '/', spaces, and underscores).
  return String(p).replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+/, '');
}

function fmtResetsIn(iso) {
  if (!iso) return '—';
  var diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  var hr = Math.floor(diff / 3600000);
  var min = Math.floor((diff % 3600000) / 60000);
  if (hr === 0) return min + ' min';
  return hr + ' hr ' + min + ' min';
}

function buildPlanLimitRow(label, sub, pct) {
  var row = document.createElement('div');
  row.className = 'plan-limit-row';

  var meta = document.createElement('div');
  meta.className = 'plan-limit-meta';
  var lbl = document.createElement('div');
  lbl.className = 'plan-limit-label';
  lbl.textContent = label;
  var subEl = document.createElement('div');
  subEl.className = 'plan-limit-sub';
  subEl.textContent = sub;
  meta.appendChild(lbl);
  meta.appendChild(subEl);

  var bar = document.createElement('div');
  bar.className = 'plan-limit-bar';
  var fill = document.createElement('div');
  fill.className = 'plan-limit-bar-fill';
  fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
  if (pct >= 90) fill.classList.add('critical');
  else if (pct >= 70) fill.classList.add('warning');
  bar.appendChild(fill);

  var pctEl = document.createElement('div');
  pctEl.className = 'plan-limit-pct';
  pctEl.textContent = Math.round(pct) + '% used';

  row.appendChild(meta);
  row.appendChild(bar);
  row.appendChild(pctEl);
  return row;
}

function renderPlanLimits(result) {
  var container = document.getElementById('plan-limits-section');
  if (!container) return;
  container.innerHTML = '';

  var header = document.createElement('div');
  header.className = 'plan-limits-header';
  var title = document.createElement('div');
  title.className = 'plan-limits-title';
  title.textContent = 'Plan limits';
  var refreshBtn = document.createElement('button');
  refreshBtn.className = 'plan-limits-refresh';
  refreshBtn.title = 'Refresh';
  refreshBtn.textContent = '↻';
  refreshBtn.addEventListener('click', function () { loadPlanLimits(true); });
  header.appendChild(title);
  header.appendChild(refreshBtn);
  container.appendChild(header);

  if (!result || !result.ok) {
    var msg = document.createElement('div');
    msg.className = 'plan-limits-error';
    msg.textContent = (result && result.message) || 'Plan limits unavailable.';
    container.appendChild(msg);
    return;
  }

  var d = result.data || {};
  var rows = [];
  if (d.five_hour) {
    rows.push(['Current session', 'Resets in ' + fmtResetsIn(d.five_hour.resets_at), d.five_hour.utilization || 0]);
  }
  if (d.seven_day) {
    rows.push(['All models (weekly)', 'Resets in ' + fmtResetsIn(d.seven_day.resets_at), d.seven_day.utilization || 0]);
  }
  if (d.seven_day_opus) {
    rows.push(['Opus only (weekly)', 'Resets in ' + fmtResetsIn(d.seven_day_opus.resets_at), d.seven_day_opus.utilization || 0]);
  }
  if (d.seven_day_sonnet) {
    rows.push(['Sonnet only (weekly)', 'Resets in ' + fmtResetsIn(d.seven_day_sonnet.resets_at), d.seven_day_sonnet.utilization || 0]);
  }
  if (d.seven_day_omelette) {
    rows.push(['Claude Design (weekly)', d.seven_day_omelette.resets_at ? 'Resets in ' + fmtResetsIn(d.seven_day_omelette.resets_at) : 'Not used yet', d.seven_day_omelette.utilization || 0]);
  }

  if (rows.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'plan-limits-error';
    empty.textContent = 'No plan limits returned.';
    container.appendChild(empty);
    return;
  }

  var list = document.createElement('div');
  list.className = 'plan-limits-list';
  for (var i = 0; i < rows.length; i++) {
    list.appendChild(buildPlanLimitRow(rows[i][0], rows[i][1], rows[i][2]));
  }
  container.appendChild(list);

  if (result.fetchedAt) {
    var foot = document.createElement('div');
    foot.className = 'plan-limits-footer';
    var ago = Math.max(0, Math.round((Date.now() - result.fetchedAt) / 1000));
    foot.textContent = 'Last updated: ' + (ago < 5 ? 'just now' : ago + 's ago') + (result.cached ? ' (cached)' : '');
    container.appendChild(foot);
  }
}

// Most recent plan-limits result (used by both the Usage modal panel and the
// persistent sidebar mini-bar). Refreshed by loadPlanLimits().
var lastPlanLimitsResult = null;
var prevPlanLimitsData = null;  // last successful data, used for crossing detection
// Stickiness: hold on to the last *successful* render so transient API failures
// during background polls don't make the sidebar bar vanish. Persisted to
// localStorage so a cold start during a server-issued cooldown still shows
// data (greyed) instead of an empty sidebar.
var lastGoodPlanLimitsData = null;
var lastGoodPlanLimitsAtMs = 0;
var PLAN_LIMITS_LASTGOOD_KEY = 'claudes.planLimitsLastGood';
var PLAN_LIMITS_LASTGOOD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

(function restoreLastGoodPlanLimits() {
  try {
    var raw = window.localStorage && window.localStorage.getItem(PLAN_LIMITS_LASTGOOD_KEY);
    if (!raw) return;
    var saved = JSON.parse(raw);
    if (!saved || !saved.data || !saved.fetchedAt) return;
    if (Date.now() - saved.fetchedAt > PLAN_LIMITS_LASTGOOD_MAX_AGE_MS) return;
    lastGoodPlanLimitsData = saved.data;
    lastGoodPlanLimitsAtMs = saved.fetchedAt;
  } catch { /* corrupt entry — ignore */ }
})();

function persistLastGoodPlanLimits(data, fetchedAt) {
  try {
    if (window.localStorage) {
      window.localStorage.setItem(PLAN_LIMITS_LASTGOOD_KEY, JSON.stringify({ data, fetchedAt }));
    }
  } catch { /* quota / privacy mode — ignore */ }
}

function renderPlanLimitsMini(result) {
  var el = document.getElementById('plan-limits-mini');
  if (!el) return;
  var ok = result && result.ok && result.data;
  if (!ok) {
    // No live data this poll. If we have a last-good snapshot (in-memory from
    // a prior poll, or restored from localStorage at startup), keep showing
    // it — flagged stale when the failure was a server cooldown — instead of
    // hiding the bar silently.
    if (lastGoodPlanLimitsData) {
      var stale = result && result.error === 'rate-limited';
      renderPlanLimitsMiniFrom(el, lastGoodPlanLimitsData, stale);
    } else {
      el.classList.add('hidden');
    }
    return;
  }
  var d = result.data;
  lastGoodPlanLimitsData = d;
  lastGoodPlanLimitsAtMs = result.fetchedAt || Date.now();
  persistLastGoodPlanLimits(d, lastGoodPlanLimitsAtMs);
  // Hide if the API returned nothing useful (e.g. API-key user).
  if (!d.five_hour && !d.seven_day) {
    el.classList.add('hidden');
    return;
  }
  renderPlanLimitsMiniFrom(el, d, false);
}

function renderPlanLimitsMiniFrom(el, d, stale) {
  if (!d.five_hour && !d.seven_day) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.classList.toggle('stale', !!stale);
  el.innerHTML = '';

  function row(label, slot) {
    if (!slot) return null;
    var pct = slot.utilization || 0;
    var r = document.createElement('div');
    r.className = 'plan-limits-mini-row';
    var lbl = document.createElement('span');
    lbl.className = 'plan-limits-mini-label';
    lbl.textContent = label;
    var bar = document.createElement('div');
    bar.className = 'plan-limits-mini-bar';
    var fill = document.createElement('div');
    fill.className = 'plan-limits-mini-fill';
    fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
    if (pct >= 90) fill.classList.add('critical');
    else if (pct >= 70) fill.classList.add('warning');
    bar.appendChild(fill);
    var pctEl = document.createElement('span');
    pctEl.className = 'plan-limits-mini-pct';
    pctEl.textContent = Math.round(pct) + '%';
    r.appendChild(lbl);
    r.appendChild(bar);
    r.appendChild(pctEl);
    return r;
  }

  var sessionRow = row('Session', d.five_hour);
  var weekRow = row('Week', d.seven_day);
  if (sessionRow) el.appendChild(sessionRow);
  if (weekRow) el.appendChild(weekRow);
  // Re-attach the hover popover after innerHTML wipe.
  if (typeof updatePlanLimitsPopover === 'function') updatePlanLimitsPopover();
}

function loadPlanLimits(force) {
  var container = document.getElementById('plan-limits-section');
  // Only show the modal's loading state when the modal is actually open and
  // we don't already have data to display from a prior background poll.
  if (container && !force && !usageModal.classList.contains('hidden') && !lastPlanLimitsResult) {
    container.innerHTML = '<div class="plan-limits-loading">Loading plan limits…</div>';
  }
  if (!window.electronAPI || !window.electronAPI.getPlanLimits) {
    var miss = { ok: false, message: 'Plan limits API not available.' };
    lastPlanLimitsResult = miss;
    renderPlanLimits(miss);
    renderPlanLimitsMini(miss);
    return Promise.resolve(miss);
  }
  return window.electronAPI.getPlanLimits(!!force).then(function (r) {
    lastPlanLimitsResult = r;
    if (!usageModal.classList.contains('hidden')) renderPlanLimits(r);
    renderPlanLimitsMini(r);
    if (r && r.ok && r.data) {
      if (prevPlanLimitsData) {
        window.electronAPI.detectThresholdCrossings(prevPlanLimitsData, r.data).then(function (crossings) {
          if (crossings && crossings.length) handleThresholdCrossings(crossings);
        });
      }
      prevPlanLimitsData = r.data;
      updateColumnDeltaPills(r.data);
    }
    return r;
  }).catch(function (e) {
    var err = { ok: false, message: e && e.message ? e.message : String(e) };
    lastPlanLimitsResult = err;
    if (!usageModal.classList.contains('hidden')) renderPlanLimits(err);
    renderPlanLimitsMini(err);
    return err;
  });
}

function handleThresholdCrossings(crossings) {
  for (var i = 0; i < crossings.length; i++) {
    var c = crossings[i];
    var enabled70 = !notifSettings || notifSettings.limits70 !== false;
    var enabled90 = !notifSettings || notifSettings.limits90 !== false;
    if (c.threshold === 70 && !enabled70) continue;
    if (c.threshold === 90 && !enabled90) continue;
    showThresholdNotification(c);
    if (c.threshold === 90 && c.window === 'seven_day' && (!notifSettings || notifSettings.limitsPause !== false)) {
      promptPauseAutomations(c);
    }
  }
}

var CTX_POLL_MS = 10000;  // 10s — JSONL grows on every assistant turn
var CTX_LIMIT_CACHE = new Map();  // model -> max tokens, populated lazily

// User preference for the meter's denominator. Persisted in config.ctxDefault
// so it survives across launches in the same place as other app settings.
// 'auto' (default) | '200000' | '1000000'
function getCtxDefaultPref() {
  return (config && config.ctxDefault) ? config.ctxDefault : 'auto';
}
function setCtxDefaultPref(v) {
  if (!config) return;
  config.ctxDefault = v;
  saveConfig();
}

function showCtxMeterPlaceholder(col, label) {
  if (!col || !col.ctxMeterEl) return;
  col.ctxMeterEl.removeAttribute('hidden');
  if (col.ctxFillEl) col.ctxFillEl.style.width = '0%';
  if (col.ctxTextEl) col.ctxTextEl.textContent = label;
  col.ctxMeterEl.title = label;
}

function showDeltaPillPlaceholder(col) {
  if (!col || !col.deltaSessionEl) return;
  col.deltaSessionEl.removeAttribute('hidden');
  col.deltaSessionEl.textContent = 'Δ —';
  col.deltaSessionEl.title = 'Waiting for first assistant turn…';
}

function startContextMeterPoll(colId) {
  var c = allColumns.get(colId);
  if (!c || c.cmd) return;  // skip non-Claude columns (custom commands)
  // Show placeholders immediately so the user can see the widgets exist.
  showCtxMeterPlaceholder(c, '—');
  showDeltaPillPlaceholder(c);
  function tick() {
    var ts = new Date().toISOString().slice(11, 19);
    var col = allColumns.get(colId);
    if (!col || !col.ctxMeterEl) return;
    console.log('[ctx-meter ' + ts + '] tick col=' + colId + ' sessionId=' + col.sessionId + ' projectKey=' + col.projectKey + ' cmd=' + col.cmd);
    if (!col.sessionId) {
      showCtxMeterPlaceholder(col, '…');
      return;
    }
    if (!col.contextEnabled) {
      // Brand-new column, no user submission yet — don't surface Claude's
      // startup system-prompt entry as if it were live conversation context.
      showCtxMeterPlaceholder(col, '—');
      return;
    }
    if (!window.electronAPI || !window.electronAPI.getSessionContextTokens) {
      console.log('[ctx-meter] electronAPI.getSessionContextTokens missing');
      return;
    }
    window.electronAPI.getSessionContextTokens(col.projectKey, col.sessionId, col.contextSinceMs).then(function (tokens) {
      console.log('[ctx-meter ' + ts + '] col=' + colId + ' → tokens=' + tokens);
      if (tokens == null) {
        showCtxMeterPlaceholder(col, '0');
        return;
      }
      if (col.spawnSessionTokens == null) {
        col.spawnSessionTokens = tokens;
      } else if (tokens < col.spawnSessionTokens * 0.6) {
        // Tokens dropped sharply → compaction (or /clear). Reset baseline so the
        // delta starts counting from the post-compaction state.
        console.log('[ctx-meter] col=' + colId + ' detected compaction (' + col.spawnSessionTokens + ' → ' + tokens + '); resetting baseline');
        col.spawnSessionTokens = tokens;
      }
      updateColumnDeltaFromTokens(col, tokens);
      var modelKey = col.model || 'sonnet';
      var limit = CTX_LIMIT_CACHE.get(modelKey);
      // Endpoint-aware: if this column is on a local-endpoint preset that
      // declares a context window, use that as the limit. Beats the global pref.
      if (!col.effectiveLimit && col.endpointId) {
        var ep = (typeof endpointPresets !== 'undefined' ? endpointPresets : [])
          .find(function (p) { return p && p.id === col.endpointId; });
        console.log('[ctx-meter] col=' + colId + ' endpoint lookup: id=' + col.endpointId + ' ep=' + (ep ? ep.name : 'NOT FOUND') + ' contextWindow=' + (ep ? ep.contextWindow : 'n/a'));
        if (ep && ep.contextWindow && ep.contextWindow > 0) {
          col.effectiveLimit = ep.contextWindow;
        }
      }
      // Pref-driven baseline: user can lock 200k or 1M via Settings.
      if (!col.effectiveLimit) {
        var pref = getCtxDefaultPref();
        if (pref === '1000000') col.effectiveLimit = 1000000;
        else if (pref === '200000') col.effectiveLimit = 200000;
      }
      // Heuristic fallback: if observed tokens exceed 200k, the session must be
      // on 1M-context (otherwise the API would error). Promote regardless of pref.
      if (tokens > 200000 && (!col.effectiveLimit || col.effectiveLimit < 1000000)) {
        console.log('[ctx-meter] col=' + colId + ' tokens=' + tokens + ' exceed 200k → promoting to 1M');
        col.effectiveLimit = 1000000;
      }
      function draw() {
        var effLim = col.effectiveLimit || limit;
        col.ctxMeterEl.removeAttribute('hidden');
        var pct = Math.min(100, (tokens / effLim) * 100);
        col.ctxFillEl.style.width = pct + '%';
        col.ctxFillEl.classList.toggle('warning', pct >= 70 && pct < 90);
        col.ctxFillEl.classList.toggle('critical', pct >= 90);
        function k(n) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }
        function kLim(n) {
          if (n >= 1000000) return (n / 1000000) + 'M';
          if (n >= 1000) return Math.round(n / 1000) + 'k';
          return String(n);
        }
        col.ctxTextEl.textContent = k(tokens) + '/' + kLim(effLim);
        col.ctxMeterEl.title =
          'Context window: ' + tokens.toLocaleString() + ' / ' + effLim.toLocaleString() + ' tokens (' + Math.round(pct) + '%)\n' +
          'Cumulative tokens currently held in this session\'s context.';
      }
      if (limit) { draw(); return; }
      window.electronAPI.getModelContextLimit(modelKey).then(function (lim) {
        CTX_LIMIT_CACHE.set(modelKey, lim);
        limit = lim;
        draw();
      }).catch(function () { /* fall back silently — pill stays hidden */ });
    }).catch(function (err) { console.debug('[ctx-meter] error', err); });
  }
  tick();  // immediate first poll
  c.ctxPollTimer = setInterval(tick, CTX_POLL_MS);
}

function stopContextMeterPoll(colId) {
  var c = allColumns.get(colId);
  if (c && c.ctxPollTimer) {
    clearInterval(c.ctxPollTimer);
    c.ctxPollTimer = null;
  }
}

// Per-column delta: tokens added to this session's context since the column spawned.
// Driven from the same JSONL read as the context-meter poll, so it's truly per-column
// (not the global plan-limits 5h utilisation, which mixes all concurrent sessions).
function updateColumnDeltaFromTokens(col, tokens) {
  if (!col || !col.deltaSessionEl) return;
  if (col.spawnSessionTokens == null || typeof tokens !== 'number') return;
  var delta = tokens - col.spawnSessionTokens;
  if (delta < 0) delta = 0;  // compaction can shrink context — clamp to 0
  function k(n) {
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return String(n);
  }
  col.deltaSessionEl.removeAttribute('hidden');
  col.deltaSessionEl.textContent = 'Δ ' + k(delta);
  col.deltaSessionEl.title =
    'Δ — context growth in THIS column since you opened it.\n' +
    'Different from the bar, which shows TOTAL context tokens currently in the session.\n\n' +
    'Spawn baseline: ' + col.spawnSessionTokens.toLocaleString() + '\n' +
    'Now:            ' + tokens.toLocaleString() + '\n' +
    'Δ (clamped ≥0): ' + delta.toLocaleString() + '\n\n' +
    'Resets after /compact or /clear.';
}

// Kept as a no-op shim for the old global-plan-limits trigger sites.
// Per-column delta is now driven by updateColumnDeltaFromTokens via the ctx poll.
function updateColumnDeltaPills(_data) { /* no-op */ }

function promptPauseAutomations(c) {
  if (!window.electronAPI || !window.electronAPI.getAutomationSettings || !window.electronAPI.toggleAutomationsGlobal) return;
  // Non-blocking inline confirm (replaces the renderer-blocking window.confirm).
  confirmDialog(
    'You\'ve crossed 90% of your weekly limit (' + Math.round(c.value) + '%).\n\n' +
    'Pause all your automations? You can re-enable them any time from the Automations panel.',
    { okLabel: 'Pause all', cancelLabel: 'Not now' }
  ).then(function (ok) {
    if (!ok) return;
    // toggleAutomationsGlobal flips state; only call if currently enabled, otherwise we'd re-enable.
    window.electronAPI.getAutomationSettings().then(function (settings) {
      if (settings && settings.globalEnabled) {
        window.electronAPI.toggleAutomationsGlobal();
      }
    }).catch(function () { /* ignore — silent failure is acceptable here */ });
  });
}

function showThresholdNotification(c) {
  var label = ({
    five_hour: 'Current session',
    seven_day: 'Weekly (all models)',
    seven_day_sonnet: 'Weekly (Sonnet)',
    seven_day_opus: 'Weekly (Opus)',
    seven_day_omelette: 'Weekly (Claude Design)'
  })[c.window] || c.window;
  var msg = label + ' just crossed ' + c.threshold + '% (' + Math.round(c.value) + '% used).';
  if (!document.hasFocus() && window.electronAPI && window.electronAPI.flashFrame) {
    window.electronAPI.flashFrame();
  }
  if (window.electronAPI && window.electronAPI.showSystemNotification) {
    window.electronAPI.showSystemNotification({ title: 'Claude usage limit', body: msg });
  }
}

// Background polling for the sidebar mini-bar.
//   - Refresh on window focus if data is older than 2 minutes
//   - Poll every 5 minutes while window is focused
//   - Pause polling while window is blurred (no token noise when away)
var PLAN_LIMITS_POLL_MS = 60 * 1000;
var PLAN_LIMITS_FOCUS_STALE_MS = 60 * 1000;
var planLimitsPollTimer = null;

function startPlanLimitsPolling() {
  if (planLimitsPollTimer) return;
  planLimitsPollTimer = setInterval(function () { loadPlanLimits(false); }, PLAN_LIMITS_POLL_MS);
}
function stopPlanLimitsPolling() {
  if (planLimitsPollTimer) { clearInterval(planLimitsPollTimer); planLimitsPollTimer = null; }
}

// Stale-hook sweep: when voice is enabled, a column that has done genuine user
// work but never received a single hook event was almost certainly orphaned by
// an app restart rotating the hook endpoint out from under its running session.
// Surface a one-time toast offering a respawn that reconnects it.
setInterval(function () {
  try {
    if (!voiceSettings || !voiceSettings.enabled) return;
    allColumns.forEach(function (col, id) {
      if (!col || col.staleHintShown) return;
      var stale = window.StaleHooks && window.StaleHooks.shouldFlagStaleHooks(col, Date.now(), {
        voiceEnabled: !!(voiceSettings && voiceSettings.enabled),
        muted: isProjectVoiceMuted(col.projectKey)
      });
      if (stale) {
        col.staleHintShown = true;
        var name = (col.customTitle || ('Claude #' + id));
        showToast(name + ' isn’t receiving live updates — respawn to reconnect voice.', {
          kind: 'warn',
          duration: 12000,
          action: { label: 'Respawn', onClick: function () { restartColumn(id); } }
        });
      }
    });
  } catch (e) {}
}, 10000);

window.addEventListener('focus', function () {
  var age = lastPlanLimitsResult && lastPlanLimitsResult.fetchedAt
    ? Date.now() - lastPlanLimitsResult.fetchedAt
    : Infinity;
  if (age > PLAN_LIMITS_FOCUS_STALE_MS) loadPlanLimits(false);
  startPlanLimitsPolling();
});
window.addEventListener('blur', stopPlanLimitsPolling);

// When any non-xterm input/textarea/select gains focus, blur every xterm
// terminal so they release keystroke capture. Without this, freshly-focused
// inputs (rename inline edit, settings fields, modal inputs) sometimes don't
// receive keystrokes until the user alt-tabs to break xterm's capture.
document.addEventListener('focusin', function (e) {
  var t = e.target;
  if (!t || !t.tagName) return;
  var tag = t.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
  // Don't blur if the focused element IS xterm's own helper textarea.
  if (t.classList && t.classList.contains('xterm-helper-textarea')) return;
  if (typeof allColumns === 'undefined') return;
  allColumns.forEach(function (c) {
    if (c.terminal && typeof c.terminal.blur === 'function') c.terminal.blur();
  });
});

// Show the restored last-good snapshot (if any) right away so the bar isn't
// blank during the initial IPC roundtrip — especially important when the
// endpoint is under a multi-minute server cooldown.
if (lastGoodPlanLimitsData) {
  var miniEl0 = document.getElementById('plan-limits-mini');
  if (miniEl0) renderPlanLimitsMiniFrom(miniEl0, lastGoodPlanLimitsData, true);
}

// Initial fetch on app start. Previously gated behind document.hasFocus(),
// which meant a backgrounded launch (auto-start, taskbar click) left the
// mini-bar empty until focus returned. Just fire the fetch — it's cheap.
loadPlanLimits(false);
startPlanLimitsPolling();

// Click the mini-bar to open the full Usage modal.
(function () {
  var mini = document.getElementById('plan-limits-mini');
  if (mini) mini.addEventListener('click', openUsageModal);
})();

// Live-update the hover popover's content whenever new plan-limits data
// arrives. Popover is a child of #plan-limits-mini and is shown via CSS
// :hover. Shows only the usage details (Session/Week + reset times) — no
// "Click for full usage" hint or refresh button, per UX preference.
function updatePlanLimitsPopover() {
  var mini = document.getElementById('plan-limits-mini');
  if (!mini) return;
  var pop = mini.querySelector('.plan-limits-mini-popover');
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'plan-limits-mini-popover';
    mini.appendChild(pop);
  }
  function fmtSlot(label, slot) {
    if (!slot) return '';
    var pct = Math.round(slot.utilization || 0);
    var html = '<div class="plan-limits-popover-slot">' +
      '<div class="plan-limits-popover-row">' +
        '<span class="plan-limits-popover-label">' + label + '</span>' +
        '<span class="plan-limits-popover-pct">' + pct + '%</span>' +
      '</div>';
    if (slot.resets_at) {
      var when = new Date(slot.resets_at);
      var hhmm = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      var datePart = when.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      html += '<div class="plan-limits-popover-sub">Resets ' + datePart +
        ' at ' + hhmm + ' (in ' + fmtResetsIn(slot.resets_at) + ')</div>';
    }
    html += '</div>';
    return html;
  }
  var d = lastGoodPlanLimitsData;
  var slots = '';
  if (d) {
    slots += fmtSlot('Session', d.five_hour);
    slots += fmtSlot('Week', d.seven_day);
  }
  if (!slots) slots = '<div class="plan-limits-popover-sub">Loading usage…</div>';
  var inner = slots;
  // Surface why the bar might look frozen — rate-limited polls keep the
  // last-good values on screen with a `.stale` class on the mini bar.
  var lr = lastPlanLimitsResult;
  if (lr && !lr.ok && lr.error === 'rate-limited' && d) {
    var ageMin = lastGoodPlanLimitsAtMs ? Math.round((Date.now() - lastGoodPlanLimitsAtMs) / 60000) : null;
    var ageLabel = ageMin == null ? '' : (ageMin < 1 ? 'just now' : ageMin + ' min ago');
    inner += '<div class="plan-limits-popover-sub">Rate-limited' +
      (ageLabel ? ' — last good ' + ageLabel : '') + '</div>';
  }
  inner += '<div class="plan-limits-popover-hint">Click for full usage</div>';
  pop.innerHTML = inner;
}

function openUsageModal() {
  usageModal.classList.remove('hidden');
  usageLoading.style.display = '';
  usageContent.classList.add('hidden');
  usageSubtitle.textContent = '';

  loadPlanLimits(false);

  window.electronAPI.getUsage().then(function (data) {
    usageData = data;
    usageLoading.style.display = 'none';
    usageContent.classList.remove('hidden');
    // Show session count and data date range
    var subtitleText = data.length + ' sessions';
    if (data.length > 0) {
      var earliest = Infinity;
      for (var i = 0; i < data.length; i++) {
        if (data[i].firstTimestamp && data[i].firstTimestamp < earliest) earliest = data[i].firstTimestamp;
      }
      if (earliest < Infinity) {
        var d = new Date(earliest);
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var days = Math.ceil((Date.now() - earliest) / (24 * 60 * 60 * 1000));
        subtitleText += ' \u00b7 ' + days + ' days of data (since ' + months[d.getMonth()] + ' ' + d.getDate() + ')';
      }
    }
    usageSubtitle.textContent = subtitleText;
    renderUsageSummary(data);
    renderUsageDaily(data);
    renderUsageSessions(data);
    if (window.electronAPI && window.electronAPI.getUsageCosts) {
      // Default to whatever filter button is currently active (defaults to 'all' on first open)
      var activeBtn = document.querySelector('.cost-filter-btn.active');
      var filter = activeBtn ? activeBtn.dataset.costFilter : 'all';
      window.electronAPI.getUsageCosts(filter).then(renderCostTab).catch(function () {});
    }
  });
}

function closeUsageModal() {
  usageModal.classList.add('hidden');
}

function buildUsageCard(label, value, sub) {
  var card = document.createElement('div');
  card.className = 'usage-card';
  var lbl = document.createElement('div');
  lbl.className = 'usage-card-label';
  lbl.textContent = label;
  var val = document.createElement('div');
  val.className = 'usage-card-value';
  val.textContent = value;
  card.appendChild(lbl);
  card.appendChild(val);
  if (sub) {
    var s = document.createElement('div');
    s.className = 'usage-card-sub';
    s.textContent = sub;
    card.appendChild(s);
  }
  return card;
}

function renderUsageSummary(data) {
  var totalApiProcessed = 0, totalInput = 0, totalOutput = 0, totalCacheRead = 0;
  var totalConversation = 0;
  var last7dMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  var week7Api = 0, week7Input = 0, week7Output = 0, week7Cache = 0, week7Sessions = 0;
  var week7Conversation = 0;
  var projectSet7 = new Set(), projectSetAll = new Set();
  var earliestTs = Infinity, latestTs = 0;

  function emptyModelTokens() {
    return { opus: {input:0,output:0,cache:0}, sonnet: {input:0,output:0,cache:0}, haiku: {input:0,output:0,cache:0}, unknown: {input:0,output:0,cache:0} };
  }
  var allModelTokens = emptyModelTokens();
  var week7ModelTokens = emptyModelTokens();

  for (var i = 0; i < data.length; i++) {
    var s = data[i];
    // API input here bundles cache reads + cache creation, because that's what
    // Anthropic processed and what drives the energy estimate. It over-counts
    // "content" on long sessions (cache reads grow turn-over-turn) — that's
    // why Conversation Tokens below is shown separately.
    var sessionApiInput = s.inputTokens + s.cacheReadTokens + s.cacheCreationTokens;
    totalApiProcessed += sessionApiInput + s.outputTokens;
    totalInput += sessionApiInput;
    totalOutput += s.outputTokens;
    totalCacheRead += s.cacheReadTokens;
    // Conversation tokens = final assistant turn's full context + its reply.
    // Falls back to zero for sessions that never produced an assistant message.
    var conv = s.lastTurn ? s.lastTurn.total : 0;
    totalConversation += conv;
    projectSetAll.add(s.projectKey);

    var modelClass = classifyModel(s.model);
    allModelTokens[modelClass].input += sessionApiInput;
    allModelTokens[modelClass].output += s.outputTokens;
    allModelTokens[modelClass].cache += s.cacheReadTokens;

    if (s.firstTimestamp && s.firstTimestamp < earliestTs) earliestTs = s.firstTimestamp;
    if (s.lastTimestamp && s.lastTimestamp > latestTs) latestTs = s.lastTimestamp;

    if (s.lastTimestamp >= last7dMs) {
      week7Api += sessionApiInput + s.outputTokens;
      week7Input += sessionApiInput;
      week7Output += s.outputTokens;
      week7Cache += s.cacheReadTokens;
      week7Conversation += conv;
      week7Sessions++;
      projectSet7.add(s.projectKey);
      week7ModelTokens[modelClass].input += sessionApiInput;
      week7ModelTokens[modelClass].output += s.outputTokens;
      week7ModelTokens[modelClass].cache += s.cacheReadTokens;
    }
  }

  // Calculate actual data span in days
  var dataSpanDays = earliestTs < Infinity ? Math.ceil((Date.now() - earliestTs) / (24 * 60 * 60 * 1000)) : 0;

  var periods = {
    '7d':  { api: week7Api,           input: week7Input,  output: week7Output,  cache: week7Cache,    conversation: week7Conversation, sessions: week7Sessions,   projects: projectSet7.size,   modelTokens: week7ModelTokens },
    'all': { api: totalApiProcessed,  input: totalInput,  output: totalOutput,  cache: totalCacheRead, conversation: totalConversation, sessions: data.length,    projects: projectSetAll.size, modelTokens: allModelTokens }
  };

  // Format earliest date for display
  var dataRangeStr = '';
  if (earliestTs < Infinity) {
    var earliest = new Date(earliestTs);
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    dataRangeStr = months[earliest.getMonth()] + ' ' + earliest.getDate();
  }

  var periodLabels = {
    '7d': 'Last 7 Days',
    'all': dataRangeStr ? 'All Time (since ' + dataRangeStr + ')' : 'All Time'
  };
  var chartDays = { '7d': 7, 'all': Math.max(dataSpanDays, 30) };

  function buildCardWithTooltip(label, value, sub, tooltip) {
    var card = buildUsageCard(label, value, sub);
    if (tooltip) card.title = tooltip;
    return card;
  }

  function renderPeriod(period) {
    var p = periods[period];

    var container = document.getElementById('usage-summary-cards');
    container.textContent = '';
    container.appendChild(buildCardWithTooltip(
      'API Tokens Processed',
      formatTokenCount(p.api),
      'incl. cached re-reads \u00b7 drives energy estimate',
      'Every token Anthropic processed across all turns. Includes the conversation history re-sent (and cached) on each turn, so it grows faster than the actual content. This is what billing and energy costs scale with.'
    ));
    container.appendChild(buildCardWithTooltip(
      'Conversation Tokens',
      formatTokenCount(p.conversation),
      'actual content across your chats',
      'Sum of each session\u2019s final-turn context + reply. Counts each token of conversation once. Rough proxy for \u201chow much text actually flowed through the model\u201d.'
    ));
    container.appendChild(buildUsageCard(
      'Input / Output',
      formatTokenCount(p.input) + ' / ' + formatTokenCount(p.output),
      String(p.sessions) + ' sessions \u00b7 ' + p.projects + ' projects'
    ));

    var chartTitle = document.getElementById('usage-chart-title');
    if (chartTitle) chartTitle.textContent = periodLabels[period];
    renderBarChart('usage-chart-30d', data, chartDays[period]);
    renderTokensPerspective(p.conversation, periodLabels[period]);
    renderEnvironmentalImpact(p.modelTokens, periodLabels[period]);
  }

  // Wire up period toggle buttons (clone to remove prior listeners)
  var oldBtns = document.querySelectorAll('.usage-period-btn');
  var btns = [];
  for (var b = 0; b < oldBtns.length; b++) {
    var clone = oldBtns[b].cloneNode(true);
    oldBtns[b].parentNode.replaceChild(clone, oldBtns[b]);
    btns.push(clone);
  }
  for (var b = 0; b < btns.length; b++) {
    btns[b].addEventListener('click', function() {
      for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
      this.classList.add('active');
      renderPeriod(this.getAttribute('data-period'));
    });
  }

  renderPeriod('all');
}

// Model energy profiles (Wh per million tokens)
// Estimated from published LLM inference research (Luccioni et al. 2024, IEA 2024),
// scaled between model tiers using Anthropic API pricing ratios as a compute proxy.
// Output tokens cost ~5x input (autoregressive generation vs parallel input processing).
// Cache reads skip most model computation — estimated at ~10% of input energy.
// PUE (Power Usage Effectiveness) of 1.1 included to account for cooling/networking overhead.
var MODEL_ENERGY_PROFILES = {
  opus:    { input: 60,  output: 300, cache: 6   },
  sonnet:  { input: 12,  output: 60,  cache: 1.2 },
  haiku:   { input: 4,   output: 20,  cache: 0.4 },
  unknown: { input: 12,  output: 60,  cache: 1.2 }  // default to sonnet
};

function classifyModel(modelStr) {
  if (!modelStr) return 'unknown';
  var m = modelStr.toLowerCase();
  if (m.indexOf('opus') !== -1) return 'opus';
  if (m.indexOf('sonnet') !== -1) return 'sonnet';
  if (m.indexOf('haiku') !== -1) return 'haiku';
  return 'unknown';
}

// ============================================================
// Humour pools — used by renderTokensPerspective and renderEnvironmentalImpact.
// Each entry has a `per` (how much metric equals 1 of this unit), a `unit`
// display label, and a `tone` tag so the picker can balance the grid.
// Numbers for the serious equivalents come from ballpark public estimates;
// numbers for the silly ones are deliberately silly and tagged "estimated".
// ============================================================
var TOKEN_EQUIVALENTS = [
  // nerdy
  { unit: 'complete Lord of the Rings trilogies (text)', per: 576000, tone: 'nerdy' },
  { unit: 'full Shakespeare plays',                     per: 30000,  tone: 'nerdy' },
  { unit: 'Hitchhiker\u2019s Guide paperbacks',         per: 65000,  tone: 'nerdy' },
  { unit: 'PhD theses (~80k words each)',               per: 107000, tone: 'nerdy' },
  { unit: 'entire Wikipedia articles on cheese',        per: 12000,  tone: 'nerdy' },
  { unit: 'Kernighan & Ritchie \u201CC\u201D books',    per: 80000,  tone: 'nerdy' },
  // mundane
  { unit: 'IKEA instruction manuals end-to-end',        per: 2000,   tone: 'mundane' },
  { unit: 'old-school 280-char tweets',                 per: 50,     tone: 'mundane' },
  { unit: 'cereal-box ingredient lists',                per: 180,    tone: 'mundane' },
  { unit: 'average LinkedIn humblebrags',               per: 90,     tone: 'mundane' },
  { unit: 'fridge-magnet haikus',                       per: 20,     tone: 'mundane' },
  { unit: 'local-council planning notices',             per: 450,    tone: 'mundane' },
  // absurd
  { unit: 'regretful voicemails left by a sentient toaster',        per: 300,  tone: 'absurd' },
  { unit: 'suicide notes written by a surprisingly articulate moth', per: 800,  tone: 'absurd' },
  { unit: 'pages of minutes from an imaginary goose AGM',           per: 500,  tone: 'absurd' },
  { unit: 'love letters between two rival kitchen sponges',         per: 400,  tone: 'absurd' },
  { unit: 'motivational speeches delivered by a bored swan',        per: 650,  tone: 'absurd' },
  { unit: 'villainous monologues from a mildly annoyed pigeon',     per: 900,  tone: 'absurd' },
  // deadpan
  { unit: 'slightly embarrassed British apologies',                 per: 12,   tone: 'deadpan' },
  { unit: 'Ofsted reports for a school that definitely exists',     per: 8000, tone: 'deadpan' },
  { unit: 'strongly worded letters to the council',                 per: 180,  tone: 'deadpan' },
  { unit: 'passive-aggressive kitchen sticky notes',                per: 35,   tone: 'deadpan' },
  { unit: '\u201Creply all\u201D apology emails',                   per: 120,  tone: 'deadpan' },
  { unit: 'notes left on windscreens about parking',                per: 80,   tone: 'deadpan' }
];

var ENV_EQUIVALENTS = [
  // mundane-specific (the flavour the user asked for)
  { unit: 'electric shavers fully charged',                 gCO2Per: 0.8,  tone: 'mundane' },
  { unit: 'hair dryers run for 1 minute',                   gCO2Per: 2,    tone: 'mundane' },
  { unit: 'electric toothbrushes charged',                  gCO2Per: 0.4,  tone: 'mundane' },
  { unit: 'Roombas woken up unnecessarily',                 gCO2Per: 1,    tone: 'mundane' },
  { unit: 'air fryers preheating to no purpose',            gCO2Per: 4,    tone: 'mundane' },
  { unit: 'kettles boiled for one cup and forgotten',       gCO2Per: 18,   tone: 'mundane' },
  { unit: 'microwaves reheating leftover curry',            gCO2Per: 7,    tone: 'mundane' },
  { unit: 'phone chargers left plugged in overnight',       gCO2Per: 5,    tone: 'mundane' },
  { unit: 'smart fridges sending pointless notifications',  gCO2Per: 0.3,  tone: 'mundane' },
  // absurd
  { unit: 'tears boiled off a single disappointed octopus', gCO2Per: 0.5,  tone: 'absurd' },
  { unit: 'gerbils levitated for 3 seconds',                gCO2Per: 0.9,  tone: 'absurd' },
  { unit: 'Bluetooth speakers forced to play \u201CDespacito\u201D once', gCO2Per: 1.2, tone: 'absurd' },
  { unit: 'lighthouses lit for one melancholy moment',      gCO2Per: 200,  tone: 'absurd' },
  { unit: 'Tamagotchis kept alive for 24 hours',            gCO2Per: 0.02, tone: 'absurd' },
  { unit: 'seagulls briefly contemplating a chip',          gCO2Per: 0.01, tone: 'absurd' },
  { unit: 'ducks warmed to exactly room temperature',       gCO2Per: 35,   tone: 'absurd' },
  // nerdy
  { unit: 'seconds of a DeLorean at 88 mph',                gCO2Per: 85,   tone: 'nerdy' },
  { unit: 'Big Ben chime-ticks',                            gCO2Per: 12,   tone: 'nerdy' },
  { unit: 'frames of a 4K Blu-ray played',                  gCO2Per: 0.004, tone: 'nerdy' },
  { unit: 'HDDs spun up just to find one JPEG',             gCO2Per: 0.9,  tone: 'nerdy' },
  // deadpan
  { unit: 'mildly awkward silences in a Zoom meeting',      gCO2Per: 0.3,  tone: 'deadpan' },
  { unit: 'Google searches for \u201Cweather\u201D',        gCO2Per: 0.3,  tone: 'deadpan' },
  { unit: '5-minute hot showers',                           gCO2Per: 500,  tone: 'deadpan' },
  { unit: 'miles driven in a petrol car',                   gCO2Per: 404,  tone: 'deadpan' },
  { unit: 'London\u2013New York flights',                   gCO2Per: 255000, tone: 'deadpan' }
];

// Pick `count` equivalents whose resulting number-of-units falls in a plausible
// range. Prefers tone variety (no tone more than twice). `excludeSet` lets
// reroll skip entries currently shown.
function pickEquivalents(pool, metric, perKey, count, seed, excludeSet) {
  if (!metric || metric <= 0) return [];
  // First pass: filter to entries with a sensible count range.
  var viable = [];
  for (var i = 0; i < pool.length; i++) {
    var entry = pool[i];
    if (excludeSet && excludeSet[entry.unit]) continue;
    var n = metric / entry[perKey];
    if (n >= 0.3 && n <= 5000) {
      viable.push({ entry: entry, n: n });
    }
  }
  if (viable.length === 0) {
    // Relax: just use all pool entries regardless of range.
    for (var j = 0; j < pool.length; j++) {
      if (excludeSet && excludeSet[pool[j].unit]) continue;
      viable.push({ entry: pool[j], n: metric / pool[j][perKey] });
    }
  }
  // Seeded shuffle (tiny LCG is fine here).
  var rng = seed >>> 0;
  function next() { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 0xffffffff; }
  for (var k = viable.length - 1; k > 0; k--) {
    var swap = Math.floor(next() * (k + 1));
    var tmp = viable[k]; viable[k] = viable[swap]; viable[swap] = tmp;
  }
  // Greedy pick honouring tone variety.
  var picked = [];
  var toneCounts = {};
  for (var m = 0; m < viable.length && picked.length < count; m++) {
    var t = viable[m].entry.tone || 'other';
    if ((toneCounts[t] || 0) >= 2) continue;
    picked.push(viable[m]);
    toneCounts[t] = (toneCounts[t] || 0) + 1;
  }
  // If we couldn't hit `count` under the tone cap, relax and top up.
  for (var n2 = 0; n2 < viable.length && picked.length < count; n2++) {
    if (picked.indexOf(viable[n2]) === -1) picked.push(viable[n2]);
  }
  return picked;
}

function formatEquivalentCount(n) {
  if (n < 0.01) return '< 0.01';
  if (n < 1) return n.toFixed(2);
  if (n < 10) return n.toFixed(1);
  return Math.round(n).toLocaleString();
}

function buildEquivalentTile(value, unit) {
  var tile = document.createElement('div');
  tile.className = 'usage-equiv-tile';
  tile.dataset.unit = unit;
  var v = document.createElement('div');
  v.className = 'usage-equiv-tile-value';
  v.textContent = value;
  var u = document.createElement('div');
  u.className = 'usage-equiv-tile-unit';
  u.textContent = unit;
  tile.appendChild(v);
  tile.appendChild(u);
  return tile;
}

function buildEquivBlockHeader(container, titleText) {
  var header = document.createElement('div');
  header.className = 'usage-equiv-header';
  var h = document.createElement('span');
  h.className = 'usage-equiv-title';
  h.textContent = titleText;
  var reroll = document.createElement('button');
  reroll.className = 'usage-equiv-reroll';
  reroll.type = 'button';
  reroll.title = 'Re-roll equivalents';
  reroll.setAttribute('aria-label', 'Re-roll equivalents');
  reroll.textContent = '\u21BB'; // clockwise arrow
  header.appendChild(h);
  header.appendChild(reroll);
  container.appendChild(header);
  return reroll;
}

function renderEquivalentGrid(gridEl, entries, metric, perKey) {
  gridEl.textContent = '';
  if (entries.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'usage-equiv-empty';
    empty.textContent = 'Not enough data yet to find a comparison.';
    gridEl.appendChild(empty);
    return;
  }
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var n = metric / e.entry[perKey];
    gridEl.appendChild(buildEquivalentTile(formatEquivalentCount(n), e.entry.unit));
  }
}

function renderTokensPerspective(totalConversation, periodLabel) {
  var container = document.getElementById('usage-tokens-perspective');
  if (!container) return;
  container.textContent = '';

  var reroll = buildEquivBlockHeader(container, 'Tokens in perspective \u2014 ' + (periodLabel || 'All Time'));

  var grid = document.createElement('div');
  grid.className = 'usage-equiv-grid';
  container.appendChild(grid);

  var shown = {};
  var state = { seed: (totalConversation & 0xffff) ^ 0x9E37 };

  function draw() {
    var picks = pickEquivalents(TOKEN_EQUIVALENTS, totalConversation, 'per', 4, state.seed, shown);
    shown = {};
    picks.forEach(function (p) { shown[p.entry.unit] = true; });
    renderEquivalentGrid(grid, picks, totalConversation, 'per');
  }
  draw();
  reroll.addEventListener('click', function () {
    state.seed = (state.seed * 1103515245 + 12345) >>> 0;
    draw();
  });

  var foot = document.createElement('div');
  foot.className = 'usage-equiv-footnote';
  foot.textContent = '\u2248 0.75 English words per token. Silly units calibrated to taste.';
  container.appendChild(foot);
}

function renderEnvironmentalImpact(modelTokens, periodLabel) {
  // Carbon intensity: Google Cloud / AWS average (kg CO2 per kWh)
  var KG_CO2_PER_KWH = 0.12;

  var energyWh = 0;
  var modelBreakdown = [];
  var modelNames = ['opus', 'sonnet', 'haiku', 'unknown'];
  for (var mi = 0; mi < modelNames.length; mi++) {
    var name = modelNames[mi];
    var tokens = modelTokens[name];
    var profile = MODEL_ENERGY_PROFILES[name];
    if (!tokens || (tokens.input === 0 && tokens.output === 0 && tokens.cache === 0)) continue;
    var mWh = (tokens.input / 1e6) * profile.input
            + (tokens.output / 1e6) * profile.output
            + (tokens.cache / 1e6) * profile.cache;
    energyWh += mWh;
    modelBreakdown.push({
      name: name === 'unknown' ? 'Unknown' : name.charAt(0).toUpperCase() + name.slice(1),
      wh: mWh,
      pct: 0,
      totalTokens: tokens.input + tokens.output
    });
  }
  for (var bi = 0; bi < modelBreakdown.length; bi++) {
    modelBreakdown[bi].pct = energyWh > 0 ? Math.round(modelBreakdown[bi].wh / energyWh * 100) : 0;
  }

  var energyKwh = energyWh / 1000;
  var co2Kg = energyKwh * KG_CO2_PER_KWH;
  var co2G = co2Kg * 1000;

  var energyStr, energyUnit;
  if (energyWh < 1) { energyStr = (energyWh * 1000).toFixed(1); energyUnit = 'mWh'; }
  else if (energyWh < 1000) { energyStr = energyWh.toFixed(1); energyUnit = 'Wh'; }
  else { energyStr = energyKwh.toFixed(2); energyUnit = 'kWh'; }

  var co2Str, co2Unit;
  if (co2G < 1) { co2Str = (co2G * 1000).toFixed(1); co2Unit = 'mg'; }
  else if (co2G < 1000) { co2Str = co2G.toFixed(1); co2Unit = 'g'; }
  else { co2Str = co2Kg.toFixed(2); co2Unit = 'kg'; }

  var container = document.getElementById('usage-environmental');
  container.textContent = '';

  var reroll = buildEquivBlockHeader(
    container,
    'Environmental impact \u2014 ' + (periodLabel || 'All Time') + ' (estimated)'
  );

  // Stats row (energy + CO2)
  var stats = document.createElement('div');
  stats.className = 'usage-env-stats';
  function buildEnvStat(label, val, unit, sub) {
    var stat = document.createElement('div');
    stat.className = 'usage-env-stat';
    var lbl = document.createElement('span');
    lbl.className = 'usage-env-stat-label';
    lbl.textContent = label;
    var valEl = document.createElement('span');
    valEl.className = 'usage-env-stat-value';
    valEl.textContent = val + ' ';
    var unitEl = document.createElement('span');
    unitEl.style.fontSize = '12px';
    unitEl.style.fontWeight = '400';
    unitEl.textContent = unit;
    valEl.appendChild(unitEl);
    var subEl = document.createElement('span');
    subEl.className = 'usage-env-stat-sub';
    subEl.textContent = sub;
    stat.appendChild(lbl);
    stat.appendChild(valEl);
    stat.appendChild(subEl);
    return stat;
  }
  var modelMixParts = [];
  for (var mi2 = 0; mi2 < modelBreakdown.length; mi2++) {
    modelMixParts.push(modelBreakdown[mi2].name + ' ' + modelBreakdown[mi2].pct + '%');
  }
  var modelMixStr = modelMixParts.length > 0 ? modelMixParts.join(', ') : 'no model data';
  stats.appendChild(buildEnvStat('Energy Used', energyStr, energyUnit, modelMixStr));
  stats.appendChild(buildEnvStat('CO\u2082 Emissions', co2Str, co2Unit, KG_CO2_PER_KWH * 1000 + ' g/kWh cloud avg'));
  container.appendChild(stats);

  // Equivalents grid
  var grid = document.createElement('div');
  grid.className = 'usage-equiv-grid';
  container.appendChild(grid);

  var shown = {};
  var state = { seed: (Math.round(co2G * 1000) & 0xffff) ^ 0x4E22 };
  function draw() {
    var picks = pickEquivalents(ENV_EQUIVALENTS, co2G, 'gCO2Per', 4, state.seed, shown);
    shown = {};
    picks.forEach(function (p) { shown[p.entry.unit] = true; });
    renderEquivalentGrid(grid, picks, co2G, 'gCO2Per');
  }
  draw();
  reroll.addEventListener('click', function () {
    state.seed = (state.seed * 1103515245 + 12345) >>> 0;
    draw();
  });

  // Disclaimer
  var disc = document.createElement('div');
  disc.className = 'usage-env-disclaimer';
  disc.textContent = 'Energy estimated per model tier using published inference research (Luccioni et al. 2024, IEA 2024), scaled by API pricing ratios. Includes 1.1\u00D7 PUE. Equivalents are ballpark for serious units, intentionally playful for silly ones.';
  container.appendChild(disc);
}

function renderBarChart(containerId, data, days) {
  var container = document.getElementById(containerId);
  container.innerHTML = '';
  var now = new Date();
  now.setHours(23,59,59,999);
  var dayBuckets = {};

  for (var d = 0; d < days; d++) {
    var date = new Date(now);
    date.setDate(date.getDate() - d);
    var key = date.toISOString().substring(0, 10);
    dayBuckets[key] = { input: 0, output: 0 };
  }

  for (var i = 0; i < data.length; i++) {
    var s = data[i];
    if (!s.lastTimestamp) continue;
    var dateKey = new Date(s.lastTimestamp).toISOString().substring(0, 10);
    if (dayBuckets[dateKey]) {
      dayBuckets[dateKey].input += s.inputTokens + s.cacheReadTokens + s.cacheCreationTokens;
      dayBuckets[dateKey].output += s.outputTokens;
    }
  }

  var sortedKeys = Object.keys(dayBuckets).sort();
  var maxTotal = 0;
  for (var k = 0; k < sortedKeys.length; k++) {
    var b = dayBuckets[sortedKeys[k]];
    if (b.input + b.output > maxTotal) maxTotal = b.input + b.output;
  }

  for (var j = 0; j < sortedKeys.length; j++) {
    var bucket = dayBuckets[sortedKeys[j]];
    var totalTokens = bucket.input + bucket.output;
    var inputPct = maxTotal > 0 ? (bucket.input / maxTotal * 100) : 0;
    var outputPct = maxTotal > 0 ? (bucket.output / maxTotal * 100) : 0;

    var row = document.createElement('div');
    row.className = 'usage-bar-row';

    var label = document.createElement('span');
    label.className = 'usage-bar-label';
    label.textContent = formatDate(new Date(sortedKeys[j]));

    var track = document.createElement('div');
    track.className = 'usage-bar-track';
    var fillIn = document.createElement('div');
    fillIn.className = 'usage-bar-fill-input';
    fillIn.style.width = inputPct + '%';
    var fillOut = document.createElement('div');
    fillOut.className = 'usage-bar-fill-output';
    fillOut.style.width = outputPct + '%';
    track.appendChild(fillIn);
    track.appendChild(fillOut);

    var val = document.createElement('span');
    val.className = 'usage-bar-value';
    val.textContent = totalTokens > 0 ? formatTokenCount(totalTokens) : '';

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(val);
    container.appendChild(row);
  }

  var legend = document.createElement('div');
  legend.className = 'usage-chart-legend';
  var dotIn = document.createElement('span');
  dotIn.className = 'usage-legend-dot';
  dotIn.style.background = 'var(--bg-button)';
  var dotOut = document.createElement('span');
  dotOut.className = 'usage-legend-dot';
  dotOut.style.background = 'var(--accent)';
  var spanIn = document.createElement('span');
  spanIn.appendChild(dotIn);
  spanIn.appendChild(document.createTextNode(' Input'));
  var spanOut = document.createElement('span');
  spanOut.appendChild(dotOut);
  spanOut.appendChild(document.createTextNode(' Output'));
  legend.appendChild(spanIn);
  legend.appendChild(spanOut);
  container.appendChild(legend);
}

function renderUsageDaily(data) {
  var dayMap = {};
  for (var i = 0; i < data.length; i++) {
    var s = data[i];
    if (!s.lastTimestamp) continue;
    var key = new Date(s.lastTimestamp).toISOString().substring(0, 10);
    if (!dayMap[key]) dayMap[key] = { input: 0, output: 0, cacheRead: 0, sessions: 0 };
    dayMap[key].input += s.inputTokens + s.cacheReadTokens + s.cacheCreationTokens;
    dayMap[key].output += s.outputTokens;
    dayMap[key].cacheRead += s.cacheReadTokens;
    dayMap[key].sessions++;
  }

  var sortedDays = Object.keys(dayMap).sort().reverse();

  renderBarChart('usage-chart-daily', data, Math.min(sortedDays.length, 90));

  var tableContainer = document.getElementById('usage-daily-table');
  tableContainer.innerHTML = '';

  var table = document.createElement('table');
  table.className = 'usage-table';

  var thead = document.createElement('thead');
  var headerRow = document.createElement('tr');
  ['Date', 'Input', 'Output', 'Total', 'Cache Read', 'Sessions'].forEach(function (h, idx) {
    var th = document.createElement('th');
    th.textContent = h;
    if (idx > 0) th.className = 'num';
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  for (var j = 0; j < sortedDays.length; j++) {
    var day = dayMap[sortedDays[j]];
    var tr = document.createElement('tr');
    var cells = [
      sortedDays[j],
      formatTokenCount(day.input),
      formatTokenCount(day.output),
      formatTokenCount(day.input + day.output),
      formatTokenCount(day.cacheRead),
      String(day.sessions)
    ];
    cells.forEach(function (text, idx) {
      var td = document.createElement('td');
      td.textContent = text;
      if (idx > 0) td.className = 'num';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tableContainer.appendChild(table);
}

function renderUsageSessions(data, filterProject) {
  var projectFilter = document.getElementById('usage-project-filter');
  var projectSet = new Set();
  for (var i = 0; i < data.length; i++) projectSet.add(data[i].projectKey);
  var projects = Array.from(projectSet).sort();

  if (projectFilter.options.length !== projects.length + 1) {
    projectFilter.innerHTML = '';
    var allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All Projects';
    projectFilter.appendChild(allOpt);
    for (var p = 0; p < projects.length; p++) {
      var opt = document.createElement('option');
      opt.value = projects[p];
      opt.textContent = projectKeyToName(projects[p]);
      projectFilter.appendChild(opt);
    }
  }

  var filtered = filterProject
    ? data.filter(function (s) { return s.projectKey === filterProject; })
    : data;

  filtered = filtered.slice().sort(function (a, b) { return (b.lastTimestamp || 0) - (a.lastTimestamp || 0); });

  var tableContainer = document.getElementById('usage-sessions-table');
  tableContainer.innerHTML = '';

  var table = document.createElement('table');
  table.className = 'usage-table';

  var thead = document.createElement('thead');
  var headerRow = document.createElement('tr');
  ['Project', 'Session', 'Model', 'Input', 'Output', 'Total', 'Messages', 'Last Active'].forEach(function (h, idx) {
    var th = document.createElement('th');
    th.textContent = h;
    if (idx >= 3 && idx <= 6) th.className = 'num';
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  for (var j = 0; j < filtered.length; j++) {
    var s = filtered[j];
    var tr = document.createElement('tr');

    var tdProject = document.createElement('td');
    tdProject.textContent = projectKeyToName(s.projectKey);
    tr.appendChild(tdProject);

    var tdSession = document.createElement('td');
    tdSession.textContent = s.sessionId.substring(0, 8);
    tdSession.style.maxWidth = '100px';
    tdSession.style.overflow = 'hidden';
    tdSession.style.textOverflow = 'ellipsis';
    tr.appendChild(tdSession);

    var tdModel = document.createElement('td');
    if (s.model) {
      var badge = document.createElement('span');
      badge.className = 'usage-model-badge';
      badge.textContent = s.model.replace('claude-', '').split('-').slice(0, 2).join('-');
      tdModel.appendChild(badge);
    }
    tr.appendChild(tdModel);

    var sessInput = s.inputTokens + s.cacheReadTokens + s.cacheCreationTokens;
    [formatTokenCount(sessInput), formatTokenCount(s.outputTokens), formatTokenCount(sessInput + s.outputTokens), String(s.messageCount)].forEach(function (text) {
      var td = document.createElement('td');
      td.className = 'num';
      td.textContent = text;
      tr.appendChild(td);
    });

    var tdActive = document.createElement('td');
    tdActive.textContent = s.lastTimestamp ? formatDateTime(s.lastTimestamp) : '-';
    tr.appendChild(tdActive);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tableContainer.appendChild(table);
}

function fmtUsd(n) {
  if (!n) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

function renderCostTab(c) {
  if (!c) return;
  var totalEl = document.getElementById('cost-total');
  if (totalEl) totalEl.textContent = fmtUsd(c.total);
  var opusEl = document.getElementById('cost-opus');
  if (opusEl) opusEl.textContent = fmtUsd(c.byModel && c.byModel.opus);
  var sonnetEl = document.getElementById('cost-sonnet');
  if (sonnetEl) sonnetEl.textContent = fmtUsd(c.byModel && c.byModel.sonnet);
  var haikuEl = document.getElementById('cost-haiku');
  if (haikuEl) haikuEl.textContent = fmtUsd(c.byModel && c.byModel.haiku);
  var bucket = c.byBucket || {};
  var crEl = document.getElementById('cost-bucket-cache-read');
  if (crEl) crEl.textContent = fmtUsd(bucket.cacheRead);
  var ccEl = document.getElementById('cost-bucket-cache-creation');
  if (ccEl) ccEl.textContent = fmtUsd(bucket.cacheCreation);
  var inEl = document.getElementById('cost-bucket-input');
  if (inEl) inEl.textContent = fmtUsd(bucket.input);
  var outEl = document.getElementById('cost-bucket-output');
  if (outEl) outEl.textContent = fmtUsd(bucket.output);

  var byProj = document.getElementById('cost-by-project');
  if (byProj) {
    byProj.innerHTML = '';
    var keys = c.byProject ? Object.keys(c.byProject) : [];
    var rows = keys.map(function (k) { return [k, c.byProject[k]]; });
    rows.sort(function (a, b) { return b[1] - a[1]; });
    if (!rows.length) {
      byProj.innerHTML = '<div class="cost-row" style="opacity:.6">No usage recorded.</div>';
    } else {
      rows.forEach(function (r) {
        var d = document.createElement('div');
        d.className = 'cost-row';
        var name = document.createElement('span');
        name.className = 'cost-row-name';
        name.textContent = r[0];
        var val = document.createElement('span');
        val.className = 'cost-row-val';
        val.textContent = fmtUsd(r[1]);
        d.appendChild(name);
        d.appendChild(val);
        byProj.appendChild(d);
      });
    }
  }

  var byDayEl = document.getElementById('cost-by-day');
  if (byDayEl) {
    byDayEl.innerHTML = '';
    var dayKeys = c.byDay ? Object.keys(c.byDay) : [];
    var days = dayKeys.sort().slice(-30);
    if (!days.length) {
      byDayEl.innerHTML = '<div class="cost-row" style="opacity:.6">No daily data.</div>';
    } else {
      var max = 0;
      for (var di = 0; di < days.length; di++) if (c.byDay[days[di]] > max) max = c.byDay[days[di]];
      if (!max) max = 1;
      days.forEach(function (d) {
        var row = document.createElement('div');
        row.className = 'cost-day-row';
        var label = document.createElement('span');
        label.className = 'cost-day-label';
        label.textContent = d;
        var bar = document.createElement('div');
        bar.className = 'cost-day-bar';
        var fill = document.createElement('div');
        fill.className = 'cost-day-fill';
        fill.style.width = ((c.byDay[d] / max) * 100) + '%';
        bar.appendChild(fill);
        var val = document.createElement('span');
        val.className = 'cost-day-val';
        val.textContent = fmtUsd(c.byDay[d]);
        row.appendChild(label);
        row.appendChild(bar);
        row.appendChild(val);
        byDayEl.appendChild(row);
      });
    }
  }
}

btnUsage.addEventListener('click', openUsageModal);
usageClose.addEventListener('click', closeUsageModal);

usageModal.addEventListener('click', function (e) {
  if (e.target === usageModal) closeUsageModal();
});

document.querySelectorAll('.usage-tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    document.querySelectorAll('.usage-tab').forEach(function (t) { t.classList.remove('active'); });
    document.querySelectorAll('.usage-tab-content').forEach(function (c) { c.classList.remove('active'); });
    tab.classList.add('active');
    document.getElementById('usage-tab-' + tab.dataset.usageTab).classList.add('active');
  });
});

document.getElementById('usage-project-filter').addEventListener('change', function () {
  if (usageData) renderUsageSessions(usageData, this.value);
});

// Fetch PTY port + per-launch auth token before connecting. The token must
// be in hand before connectWS so the WebSocket handshake includes it as a
// subprotocol — without it, pty-server refuses the connection.
if (window.electronAPI && window.electronAPI.getPtyPort) {
  Promise.all([
    window.electronAPI.getPtyPort(),
    window.electronAPI.getPtyAuthToken ? window.electronAPI.getPtyAuthToken() : Promise.resolve(null)
  ]).then(function (results) {
    if (results[0]) wsPort = results[0];
    if (results[1]) wsAuthToken = results[1];
    connectWS();
  });
} else {
  connectWS();
}

// --- App Version ---

window.electronAPI.getVersion().then(function(v) {
  var versionEl = document.getElementById('app-version');
  versionEl.textContent = 'v' + v;
  versionEl.title = 'View release history';
  versionEl.style.cursor = 'pointer';
  versionEl.addEventListener('click', function () {
    if (window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal('https://github.com/paulallington/Claudes/releases');
    }
  });

  // First-launch-after-update walkthrough. We only show it when the previous
  // app version (cached in localStorage) is older than the current. Pickers
  // for highlight text live in WHATS_NEW_BY_VERSION below — only versions
  // listed there ever trigger an overlay.
  try {
    var seenKey = 'claudes.lastSeenAppVersion';
    var prev = window.localStorage && window.localStorage.getItem(seenKey);
    if (prev !== v) {
      window.localStorage && window.localStorage.setItem(seenKey, v);
      if (prev) showWhatsNewOverlay(prev, v);
    }
  } catch { /* localStorage unavailable in private modes — skip */ }
});

// A tiny catalogue of "things worth pointing at" per release. Keep entries
// short — the overlay should be a glance, not a wall of text. If a version
// isn't listed here we just silently mark the user as up-to-date.
var WHATS_NEW_BY_VERSION = {
  '1.7.47': [
    'Cmd/Ctrl+F finds inside the focused terminal.',
    'File paths like src/foo.js:42 are now clickable links.',
    'Cmd/Ctrl+P quick-open and Cmd/Ctrl+Shift+G project content grep.',
    'Settings → Terminal: font, scrollback, cursor style, background.',
    'Git tab: merge / rebase / conflict resolution + file history + blame.',
    'Project context menu: Manage MCP servers, Skills/agents/commands, Layouts.'
  ]
};
function showWhatsNewOverlay(prev, current) {
  var highlights = WHATS_NEW_BY_VERSION[current];
  if (!highlights || highlights.length === 0) return;
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = '<div class="modal-dialog" style="max-width:560px;"><div class="modal-header"><span class="modal-title">What\'s new in ' + escapeHtml(current) + '</span><span class="modal-subtitle">Upgrading from ' + escapeHtml(prev) + '</span><span class="modal-close">&times;</span></div><div class="modal-body" style="padding:16px 24px 24px;"><ul class="shortcuts-features" id="wn-list" style="margin:0;padding-left:20px;"></ul><div style="margin-top:16px;text-align:right;"><button class="modal-btn-save" id="wn-ok">Got it</button></div></div></div>';
  document.body.appendChild(overlay);
  var list = overlay.querySelector('#wn-list');
  highlights.forEach(function (h) {
    var li = document.createElement('li');
    li.textContent = h;
    list.appendChild(li);
  });
  function close() { overlay.remove(); }
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('#wn-ok').addEventListener('click', close);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
}

// ============================================================
// Utility: escapeHtml
// ============================================================

function escapeHtml(str) {
  // Coerce so 0 / false / numbers serialise correctly; only null/undefined skip.
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Defence-in-depth for numeric fields that come from disk-loaded JSON
// (automations.json, imports). Forces anything non-numeric to 0 so a crafted
// payload like `{ count: '"><img src=x onerror=...>' }` can't break out of
// surrounding HTML when interpolated.
function safeNum(n) {
  var v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

// Cmd on darwin, Ctrl elsewhere. Every shortcut in the app should route through
// here so the binding works the way users expect on their platform — without
// this, macOS users have no way to trigger Ctrl-only shortcuts (Cmd is the
// natural modifier, Ctrl is rarely typed and clashes with system bindings).
var IS_DARWIN = (typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || ''));
function cmdOrCtrl(e) {
  return IS_DARWIN ? !!e.metaKey : !!e.ctrlKey;
}

function runWindowBadgeHtml(auto) {
  if (!auto || !auto.runWindow || !auto.runWindow.enabled) return '';
  var w = auto.runWindow;
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var days = (w.days || []).join(', ');
  var title = 'Runs ' + pad(w.startHour) + ':' + pad(w.startMinute || 0) + '–' + pad(w.endHour) + ':' + pad(w.endMinute || 0) + ' on ' + days;
  return '<span class="automation-runwindow-badge" title="' + title + '">⏰</span>';
}

// ============================================================
// Automations Tab
// ============================================================

function refreshAutomations() {
  if (importInProgress) return; // Don't overwrite import progress panel
  var listEl = document.getElementById('automations-list');
  var noProjectEl = document.getElementById('automations-no-project');
  var searchBar = document.getElementById('automations-search-bar');
  if (!listEl) return;

  if (!activeProjectKey) {
    listEl.innerHTML = '';
    if (noProjectEl) noProjectEl.style.display = '';
    if (searchBar) searchBar.style.display = 'none';
    document.getElementById('btn-pause-all-automations').style.display = 'none';
    document.getElementById('btn-resume-all-automations').style.display = 'none';
    return;
  }
  if (noProjectEl) noProjectEl.style.display = 'none';

  window.electronAPI.getAutomationsForProject(activeProjectKey).then(function (automations) {
    automationsForProject = automations;
    if (searchBar) searchBar.style.display = automations.length > 0 ? '' : 'none';

    var pauseBtn = document.getElementById('btn-pause-all-automations');
    var resumeBtn = document.getElementById('btn-resume-all-automations');
    if (automations.length === 0) {
      pauseBtn.style.display = 'none';
      resumeBtn.style.display = 'none';
    } else {
      var allDisabled = automations.every(function (a) { return !a.enabled; });
      var anyDisabled = automations.some(function (a) { return !a.enabled; });
      pauseBtn.style.display = allDisabled ? 'none' : '';
      resumeBtn.style.display = anyDisabled ? '' : 'none';
    }

    var query = document.getElementById('automations-search-input').value.toLowerCase().trim();
    if (query) {
      automations = automations.filter(function (a) {
        var nameMatch = a.name.toLowerCase().indexOf(query) !== -1;
        var agentMatch = a.agents.some(function (ag) {
          return ag.name.toLowerCase().indexOf(query) !== -1 || ag.prompt.toLowerCase().indexOf(query) !== -1;
        });
        return nameMatch || agentMatch;
      });
    }
    renderAutomationCards(automations, listEl);
  });
  updateAutomationsTabIndicator();
}

function formatTimeHHMM(h, m) {
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function formatScheduleText(agent) {
  if (agent.schedule.type === 'manual') {
    return 'Manual';
  }
  if (agent.schedule.type === 'interval') {
    var mins = agent.schedule.minutes;
    return mins >= 60 ? 'Every ' + (mins / 60) + 'h' : 'Every ' + mins + 'm';
  }
  if (agent.schedule.type === 'app_startup') {
    return agent.firstStartOnly ? 'First start of day' : 'App startup';
  }
  // time_of_day with multiple times
  var times = agent.schedule.times || [{ hour: agent.schedule.hour, minute: agent.schedule.minute || 0 }];
  if (times.length === 1) {
    return 'Daily ' + formatTimeHHMM(times[0].hour, times[0].minute);
  }
  var labels = times.map(function (t) { return formatTimeHHMM(t.hour, t.minute); });
  return labels.join(', ');
}

function isManualAutomation(automation) {
  // An automation is "manual" if ALL its independent agents have manual schedule
  var independentAgents = automation.agents.filter(function (ag) { return ag.runMode === 'independent'; });
  if (independentAgents.length === 0) return false;
  return independentAgents.every(function (ag) { return ag.schedule && ag.schedule.type === 'manual'; });
}

function renderAutomationCards(automations, container) {
  container.innerHTML = '';
  if (automations.length === 0) {
    container.innerHTML = '<p style="opacity:0.5;text-align:center;padding:2rem 1rem;font-size:12px;">No automations configured.<br>Click + to create one.</p>';
    return;
  }

  // Sort: manual automations first, then scheduled
  var manualAutomations = automations.filter(isManualAutomation);
  var scheduledAutomations = automations.filter(function (a) { return !isManualAutomation(a); });

  if (manualAutomations.length > 0 && scheduledAutomations.length > 0) {
    var manualHeader = document.createElement('div');
    manualHeader.className = 'automation-section-header';
    manualHeader.textContent = 'Manual';
    container.appendChild(manualHeader);
  }

  var allSorted = manualAutomations.concat(scheduledAutomations);
  var addedDivider = false;

  allSorted.forEach(function (automation) {
    // Add divider between manual and scheduled sections
    if (!addedDivider && !isManualAutomation(automation) && manualAutomations.length > 0 && scheduledAutomations.length > 0) {
      addedDivider = true;
      var schedHeader = document.createElement('div');
      schedHeader.className = 'automation-section-header';
      schedHeader.textContent = 'Scheduled';
      container.appendChild(schedHeader);
    }
    var card = document.createElement('div');
    card.className = 'automation-card';
    var isSimple = automation.agents.length === 1;

    var anyRunning = automation.agents.some(function (ag) { return !!ag.currentRunStartedAt; });
    var anyError = automation.agents.some(function (ag) { return ag.lastRunStatus === 'error'; });

    var statusClass = 'automation-idle';
    var badgeClass = 'badge-idle';
    var badgeText = 'idle';

    if (!automation.enabled) {
      statusClass = 'automation-disabled'; badgeClass = 'badge-disabled'; badgeText = 'disabled';
    } else if (anyRunning) {
      statusClass = 'automation-running'; badgeClass = 'badge-running'; badgeText = 'running...';
    } else if (anyError) {
      statusClass = 'automation-error'; badgeClass = 'badge-error'; badgeText = 'error';
    }
    card.classList.add(statusClass);

    if (isSimple) {
      var agent = automation.agents[0];
      var schedText = formatScheduleText(agent);
      var lastRunText = '';
      if (agent.lastRunAt) {
        var elapsed = Date.now() - new Date(agent.lastRunAt).getTime();
        if (elapsed < 60000) lastRunText = 'Last: just now';
        else if (elapsed < 3600000) lastRunText = 'Last: ' + Math.floor(elapsed / 60000) + 'm ago';
        else if (elapsed < 86400000) lastRunText = 'Last: ' + Math.floor(elapsed / 3600000) + 'h ago';
        else lastRunText = 'Last: ' + Math.floor(elapsed / 86400000) + 'd ago';
      } else { lastRunText = 'Never run'; }

      var summaryHtml = '';
      if (agent.currentRunStartedAt) {
        summaryHtml = '<div class="automation-card-summary automation-card-summary-running">Running...</div>';
      } else if (agent.lastSummary) {
        summaryHtml = '<div class="automation-card-summary">' + escapeHtml(agent.lastSummary) + '</div>';
      }

      var attentionHtml = '';
      if (agent.lastAttentionItems && agent.lastAttentionItems.length > 0) {
        attentionHtml = '<div class="automation-card-attention-summary">';
        agent.lastAttentionItems.forEach(function (item) {
          attentionHtml += '<div class="automation-card-attention-item">&#9888; ' + escapeHtml(item.summary) + '</div>';
        });
        attentionHtml += '</div>';
      }

      var toggleIcon = automation.enabled ? '&#10074;&#10074;' : '&#9654;';
      var actionsHtml = '<span class="automation-card-actions">' +
        '<button class="automation-btn-toggle" title="' + (automation.enabled ? 'Pause' : 'Enable') + '">' + toggleIcon + '</button>';
      if (!agent.currentRunStartedAt && automation.enabled) actionsHtml += '<button class="automation-btn-run" title="Run Now">&#9655;</button>';
      actionsHtml += '<button class="automation-btn-export" title="Export">&#8613;</button>' +
        '<button class="automation-btn-edit" title="Edit">&#9998;</button>' +
        '<button class="automation-btn-delete" title="Delete">&times;</button></span>';

      var connTag = '';
      if (endpointPresets.length > 0) {
        if (!agent.endpointId) {
          connTag = '<span class="automation-card-conn-tag automation-card-conn-tag--cloud">Cloud</span>';
        } else {
          var preset = endpointPresets.find(function (p) { return p.id === agent.endpointId; });
          connTag = '<span class="automation-card-conn-tag automation-card-conn-tag--local">' + escapeHtml(preset ? preset.name : 'local') + '</span>';
        }
      }

      card.innerHTML = '<div class="automation-card-header">' +
        '<span class="automation-card-name">' + escapeHtml(agent.name) + '</span>' +
        connTag +
        '<span class="automation-card-schedule">' + schedText + '</span>' +
        '</div>' +
        '<div class="automation-card-status">' + lastRunText + '</div>' +
        summaryHtml + attentionHtml +
        '<div class="automation-card-footer">' +
          '<span class="automation-status-badge ' + badgeClass + '">' + badgeText + '</span>' +
          runWindowBadgeHtml(automation) +
          actionsHtml +
        '</div>';
    } else {
      var independentCount = automation.agents.filter(function (ag) { return ag.runMode === 'independent'; }).length;
      var chainedCount = automation.agents.length - independentCount;
      var agentSummary = automation.agents.length + ' agents, ' + independentCount + ' independent' + (chainedCount > 0 ? ', ' + chainedCount + ' chained' : '');

      var dotsHtml = '<div class="automation-pipeline-mini">';
      automation.agents.forEach(function (ag) {
        var dotClass = 'pipeline-dot-idle';
        if (ag.currentRunStartedAt) dotClass = 'pipeline-dot-running';
        else if (ag.lastRunStatus === 'error') dotClass = 'pipeline-dot-error';
        else if (ag.lastRunStatus === 'skipped' || !ag.enabled) dotClass = 'pipeline-dot-waiting';
        dotsHtml += '<span class="pipeline-dot ' + dotClass + '" title="' + escapeHtml(ag.name) + '"></span>';
      });
      dotsHtml += '</div>';

      var toggleIcon2 = automation.enabled ? '&#10074;&#10074;' : '&#9654;';
      var actionsHtml2 = '<span class="automation-card-actions">' +
        '<button class="automation-btn-toggle" title="' + (automation.enabled ? 'Pause' : 'Enable') + '">' + toggleIcon2 + '</button>' +
        (automation.enabled ? '<button class="automation-btn-run" title="Run All">&#9655;</button>' : '') +
        '<button class="automation-btn-export" title="Export">&#8613;</button>' +
        '<button class="automation-btn-edit" title="Edit">&#9998;</button>' +
        '<button class="automation-btn-delete" title="Delete">&times;</button></span>';

      var connTagsHtml = '';
      if (endpointPresets.length > 0) {
        var connNames = {};
        automation.agents.forEach(function (ag) {
          if (!ag.endpointId) connNames['Cloud'] = 'cloud';
          else {
            var p = endpointPresets.find(function (pp) { return pp.id === ag.endpointId; });
            if (p) connNames[p.name] = 'local';
          }
        });
        Object.keys(connNames).forEach(function (n) {
          connTagsHtml += '<span class="automation-card-conn-tag automation-card-conn-tag--' + connNames[n] + '">' + escapeHtml(n) + '</span>';
        });
      }

      card.innerHTML = '<div class="automation-card-header">' +
        '<span class="automation-card-name">' + escapeHtml(automation.name) + '</span>' +
        connTagsHtml +
        '<span class="automation-card-schedule">' + agentSummary + '</span>' +
        '</div>' + dotsHtml +
        '<div class="automation-card-footer">' +
          '<span class="automation-status-badge ' + badgeClass + '">' + badgeText + '</span>' +
          runWindowBadgeHtml(automation) +
          actionsHtml2 +
        '</div>';
    }

    card.style.cursor = 'pointer';
    card.addEventListener('click', function () { openAutomationDetail(automation); });

    card.querySelector('.automation-btn-toggle').addEventListener('click', function (e) {
      e.stopPropagation();
      window.electronAPI.toggleAutomation(automation.id).then(function () { refreshAutomations(); });
    });
    var runBtn = card.querySelector('.automation-btn-run');
    if (runBtn) {
      runBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (isSimple) window.electronAPI.runAgentNow(automation.id, automation.agents[0].id);
        else window.electronAPI.runAutomationNow(automation.id);
        refreshAutomations();
      });
    }
    card.querySelector('.automation-btn-export').addEventListener('click', function (e) {
      e.stopPropagation();
      window.electronAPI.exportAutomation(automation.id);
    });
    card.querySelector('.automation-btn-edit').addEventListener('click', function (e) {
      e.stopPropagation();
      openAutomationModal(automation);
    });
    card.querySelector('.automation-btn-delete').addEventListener('click', function (e) {
      e.stopPropagation();
      if (confirm('Delete automation "' + (automation.name || automation.agents[0].name) + '"?')) {
        window.electronAPI.deleteAutomation(automation.id).then(function () { refreshAutomations(); });
      }
    });

    container.appendChild(card);
  });
}

// ============================================================
// Automation Detail Panel
// ============================================================

var activeAutomationDetailId = null;
var activeDetailAutomation = null;
var activeAgentDetailId = null;
var agentDetailViewingLive = false;
var viewingAgentInPipeline = false;

function openAutomationDetail(automation) {
  activeAutomationDetailId = automation.id;
  activeDetailAutomation = automation;
  var listEl = document.getElementById('automations-list');
  var detailEl = document.getElementById('automation-detail-panel');
  var searchBar = document.getElementById('automations-search-bar');
  if (listEl) listEl.style.display = 'none';
  if (searchBar) searchBar.style.display = 'none';
  detailEl.style.display = '';

  if (automation.agents.length === 1) {
    renderSimpleDetail(automation, automation.agents[0]);
  } else {
    renderMultiAgentDetail(automation);
  }
}

function renderSimpleDetail(automation, agent) {
  var outputHeader = document.querySelector('.automation-detail-output-header');
  if (outputHeader) outputHeader.style.display = '';

  // Reset output element styles (pipeline view changes these)
  var outputEl = document.getElementById('automation-detail-output');
  outputEl.style.background = '';
  outputEl.style.fontFamily = '';
  outputEl.style.whiteSpace = '';

  document.getElementById('automation-detail-name').textContent = agent.name;
  var badge = document.getElementById('automation-detail-status-badge');
  badge.className = 'automation-status-badge';
  if (agent.currentRunStartedAt) { badge.classList.add('badge-running'); badge.textContent = 'running...'; }
  else if (agent.lastRunStatus === 'error') { badge.classList.add('badge-error'); badge.textContent = 'error'; }
  else { badge.classList.add('badge-idle'); badge.textContent = 'idle'; }

  var metaEl = document.getElementById('automation-detail-meta');
  var metaText = formatScheduleText(agent) + (agent.lastRunAt ? ' \u00b7 Last: ' + new Date(agent.lastRunAt).toLocaleString() : '');

  // Add manager status for single-agent automations
  if (automation.manager && automation.manager.enabled) {
    var mgrBtnHtml = '';
    if (automation.manager.needsHuman) {
      mgrBtnHtml = '<button class="automation-detail-manager-btn needs-you" title="Manager needs your attention">Needs You &#9888;</button>';
    } else if (automation.manager.lastRunStatus === 'running') {
      mgrBtnHtml = '<button class="automation-detail-manager-btn running" title="Manager is investigating">Investigating...</button>';
    } else if (automation.manager.lastRunStatus === 'resolved' || automation.manager.lastRunStatus === 'acted' || automation.manager.lastRunStatus === 'error' || automation.manager.lastRunStatus === 'escalated') {
      mgrBtnHtml = '<button class="automation-detail-manager-btn resolved" title="' + escapeHtml(automation.manager.lastSummary || '') + '">Manager: ' + automation.manager.lastRunStatus + '</button>';
    } else {
      mgrBtnHtml = '<button class="automation-detail-manager-btn idle" title="Run manager">Manager</button>';
    }
    metaEl.innerHTML = metaText + mgrBtnHtml;
    var mgrBtn = metaEl.querySelector('.automation-detail-manager-btn');
    if (mgrBtn) {
      mgrBtn.addEventListener('click', function () {
        if (automation.manager.needsHuman) {
          launchManagerTerminal(automation);
        } else if (automation.manager.lastRunStatus === 'running') {
          showManagerLiveOutput(automation);
        } else if (automation.manager.lastRunStatus === 'resolved' || automation.manager.lastRunStatus === 'acted' || automation.manager.lastRunStatus === 'error' || automation.manager.lastRunStatus === 'escalated') {
          showManagerOutput(automation);
        } else {
          window.electronAPI.runManager(automation.id);
        }
      });
    }
  } else {
    metaEl.textContent = metaText;
  }

  if (agent.isolation && agent.isolation.enabled && agent.lastError && agent.lastError.indexOf('Working directory not found') !== -1) {
    var recloneBtn = document.createElement('button');
    recloneBtn.className = 'automation-detail-run-all';
    recloneBtn.textContent = 'Re-clone';
    recloneBtn.title = 'Re-clone repository';
    recloneBtn.addEventListener('click', function () {
      window.electronAPI.setupAgentClone(automation.id, agent.id).then(function (result) {
        if (result.error) alert('Re-clone failed: ' + result.error);
        else { refreshAutomations(); openAutomationDetail(automation); }
      });
    });
    metaEl.appendChild(document.createTextNode(' '));
    metaEl.appendChild(recloneBtn);
  }

  activeAgentDetailId = agent.id;
  var runSelect = document.getElementById('automation-detail-run-select');
  runSelect.style.display = '';

  window.electronAPI.getAgentHistory(automation.id, agent.id, 10).then(function (history) {
    runSelect.innerHTML = '';
    if (agent.currentRunStartedAt) {
      var opt = document.createElement('option');
      opt.value = 'live'; opt.textContent = 'Live';
      runSelect.appendChild(opt);
    }
    history.forEach(function (run) {
      var opt = document.createElement('option');
      opt.value = run.startedAt;
      opt.textContent = new Date(run.startedAt).toLocaleString() + ' - ' + run.status;
      runSelect.appendChild(opt);
    });

    if (agent.currentRunStartedAt) {
      switchToAgentLiveView(automation.id, agent);
    } else if (history.length > 0) {
      switchToAgentRunView(automation.id, agent.id, history[0].startedAt);
    } else {
      document.getElementById('automation-detail-output').textContent = 'No runs yet.';
      document.getElementById('automation-detail-summary').style.display = 'none';
      document.getElementById('automation-detail-attention').style.display = 'none';
    }
  });
}

var managerTerminals = {};

function launchManagerTerminal(automation) {
  if (!automation.manager) return;

  var context = 'You are the Automation Manager for "' + automation.name + '".\n\n';
  context += 'PIPELINE STATUS:\n';
  automation.agents.forEach(function (ag) {
    context += '- ' + ag.name + ': ' + (ag.lastRunStatus || 'not run') +
      (ag.lastSummary ? ' — ' + ag.lastSummary : '') + '\n';
  });
  if (automation.manager.humanContext) {
    context += '\nMANAGER INVESTIGATION FINDINGS:\n' + automation.manager.humanContext + '\n';
  }
  context += '\nThe user is here to help. Explain what you need and work together to resolve the issue.';
  context += '\nTo re-run agents, ask the user to use the Re-run buttons above this terminal.';

  var spawnArgs = buildSpawnArgs();
  if (automation.manager.skipPermissions && spawnArgs.indexOf('--dangerously-skip-permissions') === -1) {
    spawnArgs.push('--dangerously-skip-permissions');
  }
  spawnArgs.push('--append-system-prompt', context);

  addColumn(spawnArgs, null, spawnOpts({ title: automation.name + ' Manager' }));

  window.electronAPI.dismissManager(automation.id);
  refreshAutomations();
}

var viewingManagerLive = false;
var viewingManagerAutomationId = null;

function showManagerLiveOutput(automation) {
  viewingAgentInPipeline = true;
  viewingManagerLive = true;
  viewingManagerAutomationId = automation.id;
  var outputHeader = document.querySelector('.automation-detail-output-header');
  if (outputHeader) outputHeader.style.display = '';
  document.getElementById('automation-detail-name').textContent = automation.name + ' — Manager';
  document.getElementById('automation-detail-run-select').style.display = 'none';
  document.getElementById('automation-detail-summary').style.display = 'none';
  document.getElementById('automation-detail-attention').style.display = 'none';

  var outputEl = document.getElementById('automation-detail-output');
  outputEl.style.background = '';
  outputEl.style.fontFamily = '';
  outputEl.style.whiteSpace = '';
  outputEl.innerHTML = '<div class="automation-processing-indicator">Manager is investigating...</div>';

  window.electronAPI.getManagerLiveOutput(automation.id).then(function (text) {
    if (text) { outputEl.textContent = text; outputEl.scrollTop = outputEl.scrollHeight; }
  });

  var metaEl = document.getElementById('automation-detail-meta');
  metaEl.textContent = 'Manager is running — live output';
}

function showManagerOutput(automation) {
  viewingManagerLive = false;
  viewingManagerAutomationId = null;
  viewingAgentInPipeline = true; // So back button returns to pipeline
  var outputHeader = document.querySelector('.automation-detail-output-header');
  if (outputHeader) outputHeader.style.display = '';
  document.getElementById('automation-detail-name').textContent = automation.name + ' — Manager';
  document.getElementById('automation-detail-run-select').style.display = 'none';

  var metaEl = document.getElementById('automation-detail-meta');
  metaEl.textContent = 'Manager last ran: ' + (automation.manager.lastRunAt ? new Date(automation.manager.lastRunAt).toLocaleString() : 'never') +
    ' · Status: ' + (automation.manager.lastRunStatus || 'idle');

  window.electronAPI.getManagerHistory(automation.id, 1).then(function (history) {
    var outputEl = document.getElementById('automation-detail-output');
    var summaryEl = document.getElementById('automation-detail-summary');
    var attentionEl = document.getElementById('automation-detail-attention');

    if (history.length > 0) {
      var run = history[0];
      outputEl.textContent = run.output || 'No output recorded.';
      if (run.summary) { summaryEl.textContent = run.summary; summaryEl.style.display = ''; }
      else { summaryEl.style.display = 'none'; }
      if (run.actions && run.actions.length > 0) {
        attentionEl.innerHTML = '';
        run.actions.forEach(function (action) {
          var div = document.createElement('div');
          div.className = 'automation-detail-attention-item';
          div.innerHTML = '<strong>Action: ' + escapeHtml(action.type) + '</strong>' +
            (action.agentId ? '<div>Agent: ' + escapeHtml(action.agentId) + '</div>' : '');
          attentionEl.appendChild(div);
        });
        if (run.attentionItems && run.attentionItems.length > 0) {
          run.attentionItems.forEach(function (item) {
            var div = document.createElement('div');
            div.className = 'automation-detail-attention-item';
            div.innerHTML = '<strong>&#9888; ' + escapeHtml(item.summary) + '</strong>' +
              (item.detail ? '<div>' + escapeHtml(item.detail) + '</div>' : '');
            attentionEl.appendChild(div);
          });
        }
        attentionEl.style.display = '';
      } else {
        attentionEl.style.display = 'none';
      }
    } else {
      outputEl.textContent = 'No manager runs recorded.';
      summaryEl.style.display = 'none';
      attentionEl.style.display = 'none';
    }
  });
}

function renderMultiAgentDetail(automation) {
  // Reset state so live output events don't corrupt the pipeline view
  activeAgentDetailId = null;
  viewingManagerLive = false;
  viewingManagerAutomationId = null;
  agentDetailViewingLive = false;
  viewingAgentInPipeline = false;

  var outputHeader = document.querySelector('.automation-detail-output-header');
  if (outputHeader) outputHeader.style.display = 'none';

  document.getElementById('automation-detail-name').textContent = automation.name;
  var badge = document.getElementById('automation-detail-status-badge');
  badge.className = 'automation-status-badge';
  var anyRunning = automation.agents.some(function (ag) { return !!ag.currentRunStartedAt; });
  if (anyRunning) { badge.classList.add('badge-running'); badge.textContent = 'running...'; }
  else {
    badge.classList.add('badge-idle');
    var badgeLabel = automation.agents.length + ' agents';
    if (automation.manager && automation.manager.enabled) badgeLabel += ' + manager';
    badge.textContent = badgeLabel;
  }

  var metaEl = document.getElementById('automation-detail-meta');

  var managerHtml = '';
  if (automation.manager && automation.manager.enabled) {
    var mgrStatus = automation.manager.lastRunStatus || 'idle';
    if (automation.manager.needsHuman) {
      managerHtml = '<button class="automation-detail-manager-btn needs-you" title="Manager needs your attention">Needs You &#9888;</button>';
    } else if (mgrStatus === 'resolved') {
      managerHtml = '<button class="automation-detail-manager-btn resolved" title="' + escapeHtml(automation.manager.lastSummary || 'Resolved') + '">Manager: resolved &#10003;</button>';
    } else if (mgrStatus === 'acted') {
      managerHtml = '<button class="automation-detail-manager-btn acted" title="Manager took action">Manager: acted</button>';
    } else if (mgrStatus === 'running') {
      managerHtml = '<button class="automation-detail-manager-btn running" title="Manager is investigating">Investigating...</button>';
    } else {
      managerHtml = '<button class="automation-detail-manager-btn idle" title="Run manager manually">Manager</button>';
    }
  }

  metaEl.innerHTML = '<button class="automation-detail-run-all" title="Run All">&#9655; Run All</button>' +
    '<button class="automation-detail-pause-all" title="Pause">&#10074;&#10074; Pause</button>' +
    managerHtml;
  metaEl.querySelector('.automation-detail-run-all').addEventListener('click', function () {
    window.electronAPI.runAutomationNow(automation.id);
  });
  metaEl.querySelector('.automation-detail-pause-all').addEventListener('click', function () {
    window.electronAPI.toggleAutomation(automation.id).then(function () { refreshAutomations(); });
  });

  var mgrBtn = metaEl.querySelector('.automation-detail-manager-btn');
  if (mgrBtn) {
    mgrBtn.addEventListener('click', function () {
      if (automation.manager.needsHuman) {
        launchManagerTerminal(automation);
      } else if (automation.manager.lastRunStatus === 'running') {
        showManagerLiveOutput(automation);
      } else if (automation.manager.lastRunStatus === 'resolved' || automation.manager.lastRunStatus === 'acted' || automation.manager.lastRunStatus === 'error' || automation.manager.lastRunStatus === 'escalated') {
        showManagerOutput(automation);
      } else {
        window.electronAPI.runManager(automation.id);
      }
    });
  }

  var outputEl = document.getElementById('automation-detail-output');
  outputEl.innerHTML = '';
  outputEl.style.background = 'transparent';
  outputEl.style.fontFamily = 'inherit';
  outputEl.style.whiteSpace = 'normal';
  document.getElementById('automation-detail-summary').style.display = 'none';
  document.getElementById('automation-detail-attention').style.display = 'none';
  document.getElementById('automation-detail-run-select').style.display = 'none';

  var pipelineEl = document.createElement('div');
  pipelineEl.className = 'automation-pipeline-view';

  automation.agents.forEach(function (agent) {
    var borderColor = '#666';
    if (agent.currentRunStartedAt) borderColor = '#3b82f6';
    else if (agent.lastRunStatus === 'completed') borderColor = '#22c55e';
    else if (agent.lastRunStatus === 'error') borderColor = '#ef4444';

    if (agent.runMode === 'run_after' && agent.runAfter && agent.runAfter.length > 0) {
      var connector = document.createElement('div');
      connector.className = 'pipeline-connector';
      var upstreamNames = agent.runAfter.map(function (id) {
        var up = automation.agents.find(function (ag) { return ag.id === id; });
        return up ? up.name : 'unknown';
      });
      connector.textContent = 'waits for: ' + upstreamNames.join(', ');
      pipelineEl.appendChild(connector);
    }

    var row = document.createElement('div');
    row.className = 'automation-pipeline-agent';
    row.style.borderLeftColor = borderColor;
    var statusText = agent.currentRunStartedAt ? 'running...' : (agent.lastRunStatus || 'pending');
    var schedText = agent.runMode === 'run_after' ? 'Waits for upstream' : formatScheduleText(agent);

    var recloneHtml = '';
    if (agent.isolation && agent.isolation.enabled && agent.lastError && agent.lastError.indexOf('Working directory not found') !== -1) {
      recloneHtml = '<button class="pipeline-btn-reclone" title="Re-clone repository">Re-clone</button>';
    }

    row.innerHTML = '<div class="pipeline-agent-header">' +
      '<span class="pipeline-agent-name">' + escapeHtml(agent.name) + '</span>' +
      '<span class="pipeline-agent-status" style="color:' + borderColor + '">' + statusText + '</span>' +
      '</div>' +
      '<div class="pipeline-agent-meta">' + schedText + (agent.isolation && agent.isolation.enabled ? ' \u00b7 Isolated' : '') + '</div>' +
      (agent.lastSummary ? '<div class="pipeline-agent-summary">' + escapeHtml(agent.lastSummary) + '</div>' : '') +
      '<div class="pipeline-agent-actions">' +
        '<button class="pipeline-btn-run" title="Run agent">&#9655;</button>' +
        '<button class="pipeline-btn-view-output" title="View Output">Output</button>' +
        '<button class="pipeline-btn-open-claude" title="Open in Claude">&#8599;</button>' +
        '<button class="pipeline-btn-history" title="History">History</button>' +
        recloneHtml +
      '</div>';

    row.querySelector('.pipeline-btn-run').addEventListener('click', function () {
      window.electronAPI.runAgentNow(automation.id, agent.id);
    });
    row.querySelector('.pipeline-btn-view-output').addEventListener('click', function () {
      viewingAgentInPipeline = true;
      activeAgentDetailId = agent.id;
      document.getElementById('automation-detail-run-select').style.display = '';
      renderSimpleDetail(automation, agent);
    });
    row.querySelector('.pipeline-btn-open-claude').addEventListener('click', function () {
      var agentName = agent.name || 'Agent';
      var output = agent.lastSummary || '';
      if (agent.lastAttentionItems && agent.lastAttentionItems.length > 0) {
        output += '\nAttention items: ' + agent.lastAttentionItems.map(function (i) { return i.summary; }).join('; ');
      }
      if (!output) {
        alert('No output to continue with.');
        return;
      }
      var context = 'You are continuing work from a background agent called "' + agentName + '". ' +
        'Below is the output from the most recent run. The user wants to discuss, investigate, or action these findings.\n\n' +
        '--- AGENT OUTPUT ---\n' + output + '\n--- END AGENT OUTPUT ---';
      var spawnArgs = buildSpawnArgs();
      spawnArgs.push('--append-system-prompt', context);
      addColumn(spawnArgs, null, spawnOpts({ title: agentName }));
    });
    row.querySelector('.pipeline-btn-history').addEventListener('click', function () {
      viewingAgentInPipeline = true;
      activeAgentDetailId = agent.id;
      document.getElementById('automation-detail-run-select').style.display = '';
      renderSimpleDetail(automation, agent);
    });
    var recloneBtn = row.querySelector('.pipeline-btn-reclone');
    if (recloneBtn) {
      recloneBtn.addEventListener('click', function () {
        window.electronAPI.setupAgentClone(automation.id, agent.id).then(function (result) {
          if (result.error) alert('Re-clone failed: ' + result.error);
          else refreshAutomations();
        });
      });
    }

    pipelineEl.appendChild(row);
  });

  outputEl.appendChild(pipelineEl);
}

function switchToAgentLiveView(automationId, agent) {
  agentDetailViewingLive = true;
  var outputEl = document.getElementById('automation-detail-output');
  outputEl.innerHTML = '<div class="automation-processing-indicator">Processing...</div>';
  document.getElementById('automation-detail-summary').style.display = 'none';
  document.getElementById('automation-detail-attention').style.display = 'none';
  window.electronAPI.getAgentLiveOutput(automationId, agent.id).then(function (text) {
    if (text) { outputEl.textContent = text; outputEl.scrollTop = outputEl.scrollHeight; }
  });
}

function switchToAgentRunView(automationId, agentId, startedAt) {
  agentDetailViewingLive = false;
  window.electronAPI.getAgentRunDetail(automationId, agentId, startedAt).then(function (run) {
    if (run) {
      document.getElementById('automation-detail-output').textContent = run.output || 'No output recorded.';
      showAgentRunSummary(run);
    }
  });
}

function showAgentRunSummary(run) {
  var summaryEl = document.getElementById('automation-detail-summary');
  var attentionEl = document.getElementById('automation-detail-attention');
  if (run.summary) { summaryEl.textContent = run.summary; summaryEl.style.display = ''; }
  else { summaryEl.style.display = 'none'; }
  if (run.attentionItems && run.attentionItems.length > 0) {
    attentionEl.innerHTML = '';
    run.attentionItems.forEach(function (item) {
      var div = document.createElement('div');
      div.className = 'automation-detail-attention-item';
      div.innerHTML = '<strong>&#9888; ' + escapeHtml(item.summary) + '</strong>' + (item.detail ? '<div>' + escapeHtml(item.detail) + '</div>' : '');
      attentionEl.appendChild(div);
    });
    attentionEl.style.display = '';
  } else { attentionEl.style.display = 'none'; }
}

function closeAutomationDetail() {
  activeAutomationDetailId = null;
  activeDetailAutomation = null;
  activeAgentDetailId = null;
  agentDetailViewingLive = false;
  viewingAgentInPipeline = false;
  viewingManagerLive = false;
  viewingManagerAutomationId = null;
  document.getElementById('automation-detail-panel').style.display = 'none';
  document.getElementById('automations-list').style.display = '';
  document.getElementById('automation-detail-run-select').style.display = '';
  var outputHeader = document.querySelector('.automation-detail-output-header');
  if (outputHeader) outputHeader.style.display = '';
}

document.getElementById('btn-automation-detail-back').addEventListener('click', function () {
  if (viewingAgentInPipeline && activeDetailAutomation && activeDetailAutomation.agents.length > 1) {
    viewingAgentInPipeline = false;
    // Re-fetch fresh data and show pipeline
    window.electronAPI.getAutomationsForProject(activeProjectKey).then(function (automations) {
      var auto = automations.find(function (a) { return a.id === activeAutomationDetailId; });
      if (auto) {
        activeDetailAutomation = auto;
        renderMultiAgentDetail(auto);
      } else {
        closeAutomationDetail();
      }
    });
  } else {
    closeAutomationDetail();
  }
});

document.getElementById('automation-detail-run-select').addEventListener('change', function () {
  if (this.value === 'live') {
    var auto = activeDetailAutomation;
    if (auto) {
      var agent = auto.agents.find(function (ag) { return ag.id === activeAgentDetailId; });
      if (agent) switchToAgentLiveView(auto.id, agent);
    }
  } else {
    switchToAgentRunView(activeAutomationDetailId, activeAgentDetailId, this.value);
  }
});

// ============================================================
// Automation Modal (New / Edit) — Multi-Agent Support
// ============================================================

var automationEditingId = null;
var automationEditingData = null; // Store the existing automation for preserving clone paths
var modalAgents = []; // Tracks agent data for the modal
var activeCloneAutomationId = null;

// Check if adding upstreamIdx as a dependency of agentIdx would create a cycle
function wouldCreateCycle(agentIdx, upstreamIdx) {
  // Build a temporary dependency graph with this hypothetical edge
  var visited = {};
  var inStack = {};
  function getIdForIdx(idx) { return modalAgents[idx] ? (modalAgents[idx].id || 'temp_' + idx) : 'temp_' + idx; }

  function dfs(idx) {
    var id = getIdForIdx(idx);
    if (inStack[id]) return true;
    if (visited[id]) return false;
    visited[id] = true;
    inStack[id] = true;

    var ag = modalAgents[idx];
    if (ag && ag.runAfter) {
      for (var i = 0; i < ag.runAfter.length; i++) {
        // Find the index of this upstream agent
        var upIdx = modalAgents.findIndex(function (a) { return (a.id || 'temp_' + modalAgents.indexOf(a)) === ag.runAfter[i]; });
        if (upIdx !== -1 && dfs(upIdx)) return true;
      }
    }
    // Also check the hypothetical edge
    if (idx === agentIdx && dfs(upstreamIdx)) return true;

    delete inStack[id];
    return false;
  }
  return dfs(agentIdx);
}

// Update disabled state on all runAfter chips across all cards
function updateRunAfterChipStates() {
  document.querySelectorAll('#automation-agents-list .agent-card').forEach(function (card) {
    var idx = parseInt(card.dataset.agentIndex);
    var ag = modalAgents[idx];
    if (!ag || ag.runMode !== 'run_after') return;

    card.querySelectorAll('.agent-runafter-chip').forEach(function (chip) {
      var cb = chip.querySelector('input[type="checkbox"]');
      if (!cb) return;
      var targetIdx = parseInt(cb.value);
      if (cb.checked) {
        chip.classList.remove('disabled');
        return; // Already selected — don't disable
      }
      // Check if selecting this would create a cycle
      if (wouldCreateCycle(idx, targetIdx)) {
        chip.classList.add('disabled');
        cb.disabled = true;
      } else {
        chip.classList.remove('disabled');
        cb.disabled = false;
      }
    });
  });
}

function openAutomationModal(existingAutomation) {
  automationEditingId = existingAutomation ? existingAutomation.id : null;
  automationEditingData = existingAutomation || null;
  var title = existingAutomation ? 'Edit Automation' : 'New Automation';
  document.getElementById('automation-modal-title').textContent = title;
  document.getElementById('btn-automation-save').textContent = existingAutomation ? 'Save Changes' : 'Create Automation';
  document.getElementById('btn-automation-save').disabled = false;
  document.getElementById('btn-automation-save').onclick = null;

  // Hide setup panel, show form
  document.getElementById('automation-setup-panel').style.display = 'none';
  document.getElementById('automation-agents-list').style.display = '';
  document.getElementById('automation-add-agent-row').style.display = '';

  if (existingAutomation) {
    modalAgents = existingAutomation.agents.map(function (ag) { return Object.assign({}, ag); });
  } else {
    modalAgents = [{ name: '', prompt: '', schedule: { type: 'interval', minutes: 60 }, runMode: 'independent', runAfter: [], runOnUpstreamFailure: false, isolation: { enabled: false, clonePath: null }, skipPermissions: false, dbConnectionString: null, dbReadOnly: true, firstStartOnly: false, endpointId: null, endpointModel: null }];
  }

  var isMulti = modalAgents.length > 1;
  document.getElementById('automation-name-group').style.display = isMulti ? '' : 'none';
  document.getElementById('automation-name').value = existingAutomation ? existingAutomation.name : '';

  renderModalAgentCards();

  // Manager section — available for all automations (single or multi-agent)
  var managerSection = document.getElementById('automation-manager-section');
  var managerEnabled = document.getElementById('automation-manager-enabled');
  var managerFields = document.getElementById('automation-manager-fields');
  managerSection.style.display = '';
  var mgr = existingAutomation && existingAutomation.manager ? existingAutomation.manager : {};
  managerEnabled.checked = mgr.enabled || false;
  managerFields.style.display = mgr.enabled ? '' : 'none';
  document.getElementById('automation-manager-prompt').value = mgr.prompt || '';
  document.getElementById('automation-manager-trigger').value = mgr.triggerOn || 'failure';
  document.getElementById('automation-manager-retries').value = mgr.maxRetries || 1;
  document.getElementById('automation-manager-full-output').checked = mgr.includeFullOutput || false;
  document.getElementById('automation-manager-db').value = mgr.dbConnectionString || '';
  document.getElementById('automation-manager-db-readonly').checked = mgr.dbReadOnly !== false;
  document.getElementById('automation-manager-skip-permissions').checked = mgr.skipPermissions || false;
  document.getElementById('automation-manager-isolation').checked = mgr.isolation ? mgr.isolation.enabled : false;

  // Populate per-automation runWindow section
  var rwSection = document.getElementById('automation-runwindow-section');
  var rwBody = document.getElementById('automation-runwindow-body');
  var rwEnabled = document.getElementById('automation-runwindow-enabled');
  var rwFields = document.getElementById('automation-runwindow-fields');
  var rwStart = document.getElementById('automation-runwindow-start');
  var rwEnd = document.getElementById('automation-runwindow-end');
  var rwErr = document.getElementById('automation-runwindow-error');
  var w = existingAutomation && existingAutomation.runWindow;
  var pad2 = function (n) { return String(n).padStart(2, '0'); };
  if (w && w.enabled) {
    rwSection.classList.add('expanded');
    rwBody.style.display = 'block';
    rwEnabled.checked = true;
    rwFields.style.display = 'block';
    rwStart.value = pad2(w.startHour) + ':' + pad2(w.startMinute || 0);
    rwEnd.value = pad2(w.endHour) + ':' + pad2(w.endMinute || 0);
    var dayEls = document.querySelectorAll('#automation-runwindow-days input[type="checkbox"]');
    var days = w.days || [];
    dayEls.forEach(function (el) { el.checked = days.indexOf(el.getAttribute('data-day')) !== -1; });
  } else {
    rwSection.classList.remove('expanded');
    rwBody.style.display = 'none';
    rwEnabled.checked = false;
    rwFields.style.display = 'none';
    rwStart.value = '09:00';
    rwEnd.value = '17:00';
    var dayEls2 = document.querySelectorAll('#automation-runwindow-days input[type="checkbox"]');
    dayEls2.forEach(function (el) {
      var d = el.getAttribute('data-day');
      el.checked = (d !== 'sat' && d !== 'sun');
    });
  }
  rwErr.style.display = 'none';

  document.getElementById('automation-modal-overlay').classList.remove('hidden');
  var firstNameInput = document.querySelector('.agent-name');
  if (firstNameInput) firstNameInput.focus();
}

function closeAutomationModal() {
  document.getElementById('automation-modal-overlay').classList.add('hidden');
  document.getElementById('automation-agents-list').style.display = '';
  document.getElementById('automation-add-agent-row').style.display = '';
  document.getElementById('automation-setup-panel').style.display = 'none';
  document.getElementById('automation-manager-section').style.display = 'none';
  document.getElementById('automation-manager-fields').style.display = 'none';
  document.getElementById('btn-automation-save').disabled = false;
  document.getElementById('btn-automation-save').onclick = null;
  automationEditingId = null;
  automationEditingData = null;
  modalAgents = [];
  activeCloneAutomationId = null;
}

function renderModalAgentCards() {
  var container = document.getElementById('automation-agents-list');
  var isMulti = modalAgents.length > 1;
  document.getElementById('automation-name-group').style.display = isMulti ? '' : 'none';
  container.innerHTML = '';
  modalAgents.forEach(function (agent, index) {
    var html = createAgentCardHtml(index, agent, false, modalAgents);
    var div = document.createElement('div');
    div.innerHTML = html;
    container.appendChild(div.firstElementChild);
  });
  container.querySelectorAll('.agent-card').forEach(function (card) {
    var idx = parseInt(card.dataset.agentIndex);
    bindAgentCardEvents(card, idx);
  });
  // After all cards rendered & bound, update chip disabled states
  updateRunAfterChipStates();
}

function renderAgentConnectionSection(agent) {
  var selectedId = (agent && agent.endpointId) || '';
  var selectedModel = (agent && agent.endpointModel) || '';

  var connOpts = '<option value=""' + (selectedId === '' ? ' selected' : '') + '>Cloud (Anthropic)</option>';
  endpointPresets.forEach(function (p) {
    connOpts += '<option value="' + escapeHtml(p.id) + '"' + (selectedId === p.id ? ' selected' : '') + '>' + escapeHtml(p.name || '(unnamed)') + '</option>';
  });

  var modelOpts;
  var refreshBtn = '';
  if (!selectedId) {
    var cloudModels = [
      { v: '', t: 'Default' },
      { v: 'sonnet', t: 'Sonnet (latest)' },
      { v: 'opus', t: 'Opus (latest)' },
      { v: 'haiku', t: 'Haiku (latest)' }
    ];
    modelOpts = cloudModels.map(function (m) {
      return '<option value="' + m.v + '"' + (selectedModel === m.v ? ' selected' : '') + '>' + m.t + '</option>';
    }).join('');
  } else {
    var cached = endpointModelsCache[selectedId];
    var preset = endpointPresets.find(function (p) { return p.id === selectedId; });
    var defaultModel = preset ? (preset.model || '') : '';
    var models = (cached && cached.models) ? cached.models.slice() : [];
    if (defaultModel && models.indexOf(defaultModel) === -1) models.unshift(defaultModel);
    if (selectedModel && models.indexOf(selectedModel) === -1) models.unshift(selectedModel);
    if (models.length === 0) models = [defaultModel || ''];
    modelOpts = models.map(function (m) {
      var isSel = selectedModel ? (m === selectedModel) : (m === defaultModel);
      return '<option value="' + escapeHtml(m) + '"' + (isSel ? ' selected' : '') + '>' + escapeHtml(m || '(default)') + '</option>';
    }).join('');
    refreshBtn = '<button type="button" class="agent-endpoint-model-refresh spawn-icon-btn" title="Re-fetch loaded models from endpoint">&#8634;</button>';
  }

  return '<div class="automation-form-group agent-connection-group">' +
    '<label>Connection</label>' +
    '<div class="automation-schedule-row">' +
      '<select class="agent-endpoint">' + connOpts + '</select>' +
    '</div>' +
    '</div>' +
    '<div class="automation-form-group agent-model-group">' +
    '<label>Model</label>' +
    '<div class="automation-schedule-row">' +
      '<select class="agent-endpoint-model">' + modelOpts + '</select>' +
      refreshBtn +
    '</div>' +
    '</div>';
}

function createAgentCardHtml(agentIndex, agent, isCollapsed, allAgents) {
  var isMulti = allAgents.length > 1;
  var cardId = 'agent-card-' + agentIndex;
  var name = agent ? (agent.name || '') : '';
  var prompt = agent ? (agent.prompt || '') : '';
  var schedType = agent && agent.schedule ? agent.schedule.type : 'interval';
  var checkedDays = agent && agent.schedule && agent.schedule.days ? agent.schedule.days : ['mon', 'tue', 'wed', 'thu', 'fri'];
  var runMode = agent ? (agent.runMode || 'independent') : 'independent';

  var header = '';
  if (isMulti) {
    var badges = '';
    if (runMode === 'run_after') badges += '<span class="agent-badge agent-badge-chained">Chained</span>';
    if (agent && agent.isolation && agent.isolation.enabled) badges += '<span class="agent-badge agent-badge-isolated">Isolated</span>';

    var schedSummary = (agent && runMode !== 'run_after') ? formatScheduleText(agent) : '';

    header = '<div class="agent-card-header" data-agent-index="' + agentIndex + '">' +
      '<span class="agent-card-collapse-icon">' + (isCollapsed ? '&#9654;' : '&#9660;') + '</span>' +
      '<span class="agent-card-title">' + escapeHtml(name || 'Agent ' + (agentIndex + 1)) + '</span>' +
      badges +
      (schedSummary ? '<span class="agent-card-schedule-summary">' + schedSummary + '</span>' : '') +
      '<button type="button" class="agent-card-remove" data-agent-index="' + agentIndex + '" title="Remove agent">&times;</button>' +
      '</div>';
  }

  var runAfterHtml = '';
  if (isMulti) {
    var otherAgents = allAgents.filter(function (_, i) { return i !== agentIndex; });
    var chipOptions = otherAgents.map(function (ag) {
      var originalIndex = allAgents.indexOf(ag);
      var agId = ag.id || ('temp_' + originalIndex);
      var selected = agent && agent.runAfter && agent.runAfter.indexOf(agId) !== -1;
      return '<label class="agent-runafter-chip' + (selected ? ' selected' : '') + '">' +
        '<input type="checkbox" value="' + originalIndex + '"' + (selected ? ' checked' : '') + '> ' +
        escapeHtml(ag.name || 'Agent ' + (originalIndex + 1)) +
        '</label>';
    }).join('');

    runAfterHtml = '<div class="automation-form-group agent-runafter-group" style="' + (runMode === 'run_after' ? '' : 'display:none;') + '">' +
      '<label>Run after</label>' +
      '<div class="agent-runafter-chips">' + chipOptions + '</div>' +
      '<div class="automation-permission-hint" style="margin-top:4px;">Select only direct dependencies — chains are followed automatically</div>' +
      '<label class="automation-permission-option" style="margin-top:6px;">' +
        '<input type="checkbox" class="agent-run-on-failure"' + (agent && agent.runOnUpstreamFailure ? ' checked' : '') + '>' +
        '<span>Run even if upstream fails <span class="automation-permission-hint">(skip if unchecked)</span></span>' +
      '</label>' +
      '</div>';
  }

  // Pass upstream context — available for all agents in multi-agent mode
  var passContextHtml = '';
  if (isMulti) {
    passContextHtml = '<div class="automation-form-group">' +
      '<label class="automation-permission-option">' +
        '<input type="checkbox" class="agent-pass-context"' + (agent && agent.passUpstreamContext ? ' checked' : '') + '>' +
        '<span>Pass output as context to downstream agents <span class="automation-permission-hint">(summary prepended to chained agent prompts)</span></span>' +
      '</label>' +
      '</div>';
  }

  var isolationEnabled = agent && agent.isolation && agent.isolation.enabled;
  var predictedPath = '';
  if (isolationEnabled) {
    predictedPath = agent.isolation && agent.isolation.clonePath ? agent.isolation.clonePath : '~/.claudes/agents/<project>/<agent-name>/';
  }
  var isolationHtml = '<div class="automation-form-group">' +
    '<label class="automation-permission-option">' +
    '<input type="checkbox" class="agent-isolation-checkbox"' + (isolationEnabled ? ' checked' : '') + '>' +
    '<span>Repo isolation <span class="automation-permission-hint">(clone into separate directory — prevents branch conflicts)</span></span>' +
    '</label>' +
    '<div class="agent-isolation-path" style="' + (isolationEnabled ? '' : 'display:none;') + '">' +
    '<span class="automation-permission-hint">Clone path: ' + escapeHtml(predictedPath) + '</span>' +
    '</div>' +
    '</div>';

  var sessionMaxPct = agent && agent.usageGate && (typeof agent.usageGate.sessionMaxPct === 'number') ? agent.usageGate.sessionMaxPct : '';
  var weeklyMaxPct = agent && agent.usageGate && (typeof agent.usageGate.weeklyMaxPct === 'number') ? agent.usageGate.weeklyMaxPct : '';
  var usageGateHtml = '<div class="automation-form-group">' +
    '<label>Skip if session usage above ' +
      '<input type="number" class="automation-input agent-usage-gate-session" min="0" max="100" step="1" value="' + escapeHtml(String(sessionMaxPct)) + '" placeholder="e.g. 80" style="width:80px;display:inline-block;margin:0 6px;"> ' +
      '%' +
      ' <span class="automation-permission-hint">(blank to always run)</span>' +
    '</label>' +
    '<label style="margin-top:6px;display:block;">Skip if weekly usage above ' +
      '<input type="number" class="automation-input agent-usage-gate-weekly" min="0" max="100" step="1" value="' + escapeHtml(String(weeklyMaxPct)) + '" placeholder="e.g. 80" style="width:80px;display:inline-block;margin:0 6px;"> ' +
      '%' +
      ' <span class="automation-permission-hint">(blank to always run)</span>' +
    '</label>' +
    '</div>';

  var scheduleDisplay = runMode === 'run_after' ? 'display:none;' : '';
  var bodyStyle = isCollapsed ? 'display:none;' : '';

  var intervalMins = agent && agent.schedule && agent.schedule.minutes ? agent.schedule.minutes : 60;
  var intervalVal = intervalMins >= 60 && intervalMins % 60 === 0 ? intervalMins / 60 : intervalMins;
  var intervalUnit = intervalMins >= 60 && intervalMins % 60 === 0 ? 'hours' : 'minutes';
  var firstStartOnly = agent && agent.firstStartOnly;

  var html = '<div class="agent-card" id="' + cardId + '" data-agent-index="' + agentIndex + '">' +
    header +
    '<div class="agent-card-body" style="' + bodyStyle + '">' +
      '<div class="automation-form-group">' +
        '<label>Name</label>' +
        '<input type="text" class="automation-input agent-name" value="' + escapeHtml(name) + '" placeholder="e.g. Bug Resolution Agent" spellcheck="false">' +
      '</div>' +
      '<div class="automation-form-group">' +
        '<label>Prompt</label>' +
        '<textarea class="automation-textarea agent-prompt" rows="6" placeholder="What should Claude do each time this runs?" spellcheck="false">' + escapeHtml(prompt) + '</textarea>' +
      '</div>' +
      (isMulti ? '<div class="automation-form-group">' +
        '<label>Run Mode</label>' +
        '<select class="agent-run-mode">' +
          '<option value="independent"' + (runMode === 'independent' ? ' selected' : '') + '>Independent (own schedule)</option>' +
          '<option value="run_after"' + (runMode === 'run_after' ? ' selected' : '') + '>Run after (wait for other agents)</option>' +
        '</select>' +
      '</div>' : '') +
      runAfterHtml +
      passContextHtml +
      isolationHtml +
      usageGateHtml +
      '<div class="agent-schedule-section" style="' + scheduleDisplay + '">' +
        '<div class="automation-form-group">' +
          '<label>Schedule</label>' +
          '<div class="automation-schedule-row">' +
            '<select class="agent-schedule-type">' +
              '<option value="manual"' + (schedType === 'manual' ? ' selected' : '') + '>Manual</option>' +
              '<option value="interval"' + (schedType === 'interval' ? ' selected' : '') + '>Every</option>' +
              '<option value="time_of_day"' + (schedType === 'time_of_day' ? ' selected' : '') + '>At specific times</option>' +
              '<option value="app_startup"' + (schedType === 'app_startup' ? ' selected' : '') + '>On app startup</option>' +
            '</select>' +
            '<div class="agent-interval-fields" style="' + (schedType === 'interval' ? '' : 'display:none;') + '">' +
              '<input type="number" class="agent-interval-value" min="1" value="' + intervalVal + '" style="width:60px">' +
              '<select class="agent-interval-unit">' +
                '<option value="minutes"' + (intervalUnit === 'minutes' ? ' selected' : '') + '>minutes</option>' +
                '<option value="hours"' + (intervalUnit === 'hours' ? ' selected' : '') + '>hours</option>' +
              '</select>' +
            '</div>' +
            '<div class="agent-startup-fields" style="' + (schedType === 'app_startup' ? '' : 'display:none;') + '">' +
              '<label class="automation-permission-option" style="margin-top:4px;">' +
                '<input type="checkbox" class="agent-first-start-only"' + (firstStartOnly ? ' checked' : '') + '>' +
                '<span>Only on first start of the day</span>' +
              '</label>' +
            '</div>' +
            '<div class="agent-tod-fields" style="' + (schedType === 'time_of_day' ? '' : 'display:none;') + '">' +
              '<div class="automation-time-add-row">' +
                '<input type="time" class="agent-tod-time" value="09:00">' +
                '<button type="button" class="agent-btn-add-time" title="Add time">+</button>' +
              '</div>' +
              '<div class="agent-tod-times-list automation-times-chips"></div>' +
              '<div class="automation-days-row agent-tod-days">' +
                '<label><input type="checkbox" value="mon"' + (checkedDays.indexOf("mon") !== -1 ? ' checked' : '') + '> Mon</label>' +
                '<label><input type="checkbox" value="tue"' + (checkedDays.indexOf("tue") !== -1 ? ' checked' : '') + '> Tue</label>' +
                '<label><input type="checkbox" value="wed"' + (checkedDays.indexOf("wed") !== -1 ? ' checked' : '') + '> Wed</label>' +
                '<label><input type="checkbox" value="thu"' + (checkedDays.indexOf("thu") !== -1 ? ' checked' : '') + '> Thu</label>' +
                '<label><input type="checkbox" value="fri"' + (checkedDays.indexOf("fri") !== -1 ? ' checked' : '') + '> Fri</label>' +
                '<label><input type="checkbox" value="sat"' + (checkedDays.indexOf("sat") !== -1 ? ' checked' : '') + '> Sat</label>' +
                '<label><input type="checkbox" value="sun"' + (checkedDays.indexOf("sun") !== -1 ? ' checked' : '') + '> Sun</label>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      renderAgentConnectionSection(agent) +
      '<div class="automation-form-group">' +
        '<label>Database <span class="automation-permission-hint">(optional)</span></label>' +
        '<div class="automation-db-row">' +
          '<input type="text" class="automation-input agent-db-connection" value="' + escapeHtml(agent && agent.dbConnectionString ? agent.dbConnectionString : '') + '" placeholder="mongodb+srv://..." spellcheck="false" autocomplete="off">' +
        '</div>' +
        '<div class="automation-permissions" style="margin-top:6px;">' +
          '<label class="automation-permission-option"><input type="checkbox" class="agent-db-readonly"' + (agent && agent.dbReadOnly === false ? '' : ' checked') + '><span>Read-only <span class="automation-permission-hint">(agent cannot write, update, insert, or delete data)</span></span></label>' +
        '</div>' +
      '</div>' +
      '<div class="automation-form-group">' +
        '<label>Permissions</label>' +
        '<div class="automation-permissions">' +
          '<label class="automation-permission-option"><input type="checkbox" class="agent-skip-permissions"' + (agent && agent.skipPermissions ? ' checked' : '') + '><span>Skip permissions</span></label>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '</div>';

  return html;
}

function updateCardHeaderBadges(card, agentIndex) {
  var header = card.querySelector('.agent-card-header');
  if (!header) return;
  var ag = modalAgents[agentIndex];
  if (!ag) return;
  // Remove existing badges
  header.querySelectorAll('.agent-badge').forEach(function (b) { b.remove(); });
  // Insert new badges after the title
  var title = header.querySelector('.agent-card-title');
  if (!title) return;
  var frag = document.createDocumentFragment();
  if (ag.runMode === 'run_after') {
    var b1 = document.createElement('span');
    b1.className = 'agent-badge agent-badge-chained';
    b1.textContent = 'Chained';
    frag.appendChild(b1);
  }
  if (ag.isolation && ag.isolation.enabled) {
    var b2 = document.createElement('span');
    b2.className = 'agent-badge agent-badge-isolated';
    b2.textContent = 'Isolated';
    frag.appendChild(b2);
  }
  title.after(frag);
}

function refreshAgentModelDropdown(card, endpointId) {
  var modelGroup = card.querySelector('.agent-model-group');
  if (!modelGroup) return;
  var stub = { endpointId: endpointId || null, endpointModel: null };
  var temp = document.createElement('div');
  temp.innerHTML = renderAgentConnectionSection(stub);
  var newModelGroup = temp.querySelector('.agent-model-group');
  if (newModelGroup) modelGroup.replaceWith(newModelGroup);
}

function bindAgentCardEvents(card, agentIndex) {
  var header = card.querySelector('.agent-card-header');
  if (header) {
    header.addEventListener('click', function (e) {
      if (e.target.classList.contains('agent-card-remove')) return;
      var body = card.querySelector('.agent-card-body');
      var icon = card.querySelector('.agent-card-collapse-icon');
      if (body.style.display === 'none') {
        body.style.display = '';
        icon.innerHTML = '&#9660;';
      } else {
        syncAgentFromCard(card, agentIndex);
        body.style.display = 'none';
        icon.innerHTML = '&#9654;';
        var title = header.querySelector('.agent-card-title');
        if (title) title.textContent = modalAgents[agentIndex].name || 'Agent ' + (agentIndex + 1);
      }
    });
  }

  var removeBtn = card.querySelector('.agent-card-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (modalAgents.length <= 1) { alert('Cannot remove the only agent.'); return; }
      syncAllAgentsFromCards();
      var removedAgent = modalAgents[agentIndex];
      var removedId = removedAgent.id || ('temp_' + agentIndex);
      // Check if other agents depend on this one
      var dependents = modalAgents.filter(function (ag, i) {
        return i !== agentIndex && ag.runMode === 'run_after' && ag.runAfter && ag.runAfter.indexOf(removedId) !== -1;
      });
      if (dependents.length > 0) {
        var names = dependents.map(function (ag) { return ag.name || 'unnamed'; }).join(', ');
        if (!confirm('Agent "' + (removedAgent.name || 'unnamed') + '" is depended on by: ' + names + '. They will become independent. Continue?')) return;
      }
      // Clean up runAfter references
      modalAgents.forEach(function (ag) {
        if (ag.runAfter) {
          ag.runAfter = ag.runAfter.filter(function (id) { return id !== removedId; });
          if (ag.runAfter.length === 0 && ag.runMode === 'run_after') {
            ag.runMode = 'independent';
          }
        }
      });
      modalAgents.splice(agentIndex, 1);
      renderModalAgentCards();
    });
  }

  // RunAfter chip click handlers — sync state and update disabled chips across all cards
  card.querySelectorAll('.agent-runafter-chip').forEach(function (chip) {
    chip.addEventListener('click', function (e) {
      var cb = chip.querySelector('input[type="checkbox"]');
      if (!cb || cb.disabled) { e.preventDefault(); return; }
      // Toggle is handled by the checkbox default behavior, just sync after
      setTimeout(function () {
        chip.classList.toggle('selected', cb.checked);
        syncAgentFromCard(card, agentIndex);
        updateRunAfterChipStates();
      }, 0);
    });
  });

  var runModeSelect = card.querySelector('.agent-run-mode');
  if (runModeSelect) {
    runModeSelect.addEventListener('change', function () {
      modalAgents[agentIndex].runMode = this.value;
      var runAfterGroup = card.querySelector('.agent-runafter-group');
      var schedSection = card.querySelector('.agent-schedule-section');
      if (runAfterGroup) runAfterGroup.style.display = this.value === 'run_after' ? '' : 'none';
      if (schedSection) schedSection.style.display = this.value === 'run_after' ? 'none' : '';
      updateCardHeaderBadges(card, agentIndex);
      // When switching to run_after, update chip disabled states
      if (this.value === 'run_after') {
        setTimeout(updateRunAfterChipStates, 0);
      }
    });
  }

  var schedSelect = card.querySelector('.agent-schedule-type');
  if (schedSelect) {
    schedSelect.addEventListener('change', function () {
      var type = this.value;
      var intervalFields = card.querySelector('.agent-interval-fields');
      var todFields = card.querySelector('.agent-tod-fields');
      var startupFields = card.querySelector('.agent-startup-fields');
      if (intervalFields) intervalFields.style.display = type === 'interval' ? '' : 'none';
      if (todFields) todFields.style.display = type === 'time_of_day' ? '' : 'none';
      if (startupFields) startupFields.style.display = type === 'app_startup' ? '' : 'none';
    });
  }

  // Connection picker — change swaps the model dropdown to that connection's
  // model list. Refresh button is delegated because it's re-created on swap.
  var epSelect = card.querySelector('.agent-endpoint');
  if (epSelect) {
    epSelect.addEventListener('change', function () {
      refreshAgentModelDropdown(card, epSelect.value);
    });
  }
  card.addEventListener('click', function (e) {
    if (!e.target.classList || !e.target.classList.contains('agent-endpoint-model-refresh')) return;
    var ep = card.querySelector('.agent-endpoint');
    if (!ep || !ep.value) return;
    var preset = endpointPresets.find(function (p) { return p.id === ep.value; });
    if (!preset || !window.electronAPI || !window.electronAPI.endpointFetchModels) return;
    var btn = e.target;
    var origHtml = btn.innerHTML;
    btn.textContent = '…';
    window.electronAPI.endpointFetchModels({ baseUrl: preset.baseUrl, authToken: '' }).then(function (result) {
      btn.innerHTML = origHtml;
      if (!result || !result.ok || !result.models || result.models.length === 0) return;
      endpointModelsCache[preset.id] = { models: result.models, fetchedAt: Date.now(), ok: true };
      refreshAgentModelDropdown(card, ep.value);
    }).catch(function () { btn.innerHTML = origHtml; });
  });

  // Update chip labels and header when agent name changes
  var nameInput = card.querySelector('.agent-name');
  if (nameInput) {
    nameInput.addEventListener('input', function () {
      modalAgents[agentIndex].name = this.value;
      // Update own collapsed header title
      var headerTitle = card.querySelector('.agent-card-title');
      if (headerTitle) headerTitle.textContent = this.value || 'Agent ' + (agentIndex + 1);
      // Update this agent's name in runAfter chips across all other cards
      document.querySelectorAll('#automation-agents-list .agent-card').forEach(function (otherCard) {
        var otherIdx = parseInt(otherCard.dataset.agentIndex);
        if (otherIdx === agentIndex) return;
        otherCard.querySelectorAll('.agent-runafter-chip').forEach(function (chip) {
          var cb = chip.querySelector('input[type="checkbox"]');
          if (cb && parseInt(cb.value) === agentIndex) {
            var label = chip.childNodes[chip.childNodes.length - 1];
            if (label && label.nodeType === 3) {
              label.textContent = ' ' + (nameInput.value || 'Agent ' + (agentIndex + 1));
            }
          }
        });
      });
    });
  }

  var isoCheckbox = card.querySelector('.agent-isolation-checkbox');
  if (isoCheckbox) {
    isoCheckbox.addEventListener('change', function () {
      modalAgents[agentIndex].isolation = modalAgents[agentIndex].isolation || {};
      modalAgents[agentIndex].isolation.enabled = this.checked;
      var pathEl = card.querySelector('.agent-isolation-path');
      if (pathEl) pathEl.style.display = this.checked ? '' : 'none';
      updateCardHeaderBadges(card, agentIndex);
    });
  }

  var addTimeBtn = card.querySelector('.agent-btn-add-time');
  if (addTimeBtn) {
    addTimeBtn.addEventListener('click', function () {
      var timeInput = card.querySelector('.agent-tod-time');
      if (!timeInput || !timeInput.value) return;
      var parts = timeInput.value.split(':');
      var h = parseInt(parts[0]);
      var m = parseInt(parts[1]);
      if (!modalAgents[agentIndex]._modalTimes) modalAgents[agentIndex]._modalTimes = [];
      var exists = modalAgents[agentIndex]._modalTimes.some(function (t) { return t.hour === h && t.minute === m; });
      if (exists) return;
      modalAgents[agentIndex]._modalTimes.push({ hour: h, minute: m });
      modalAgents[agentIndex]._modalTimes.sort(function (a, b) { return (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute); });
      renderAgentTimeChipsInCard(card, agentIndex);
    });
  }

  card.querySelectorAll('input, textarea, select').forEach(function (el) {
    el.addEventListener('keydown', function (e) { e.stopPropagation(); });
  });

  if (modalAgents[agentIndex].schedule && modalAgents[agentIndex].schedule.times) {
    modalAgents[agentIndex]._modalTimes = modalAgents[agentIndex].schedule.times.slice();
    renderAgentTimeChipsInCard(card, agentIndex);
  }
}

function renderAgentTimeChipsInCard(card, agentIndex) {
  var container = card.querySelector('.agent-tod-times-list');
  if (!container) return;
  var times = modalAgents[agentIndex]._modalTimes || [];
  container.innerHTML = '';
  if (times.length === 0) {
    container.innerHTML = '<span style="opacity:0.4;font-size:11px;">No times added yet</span>';
    return;
  }
  times.forEach(function (t, i) {
    var chip = document.createElement('span');
    chip.className = 'automation-time-chip';
    var label = (t.hour < 10 ? '0' : '') + t.hour + ':' + (t.minute < 10 ? '0' : '') + t.minute;
    chip.innerHTML = label + '<button type="button" class="automation-time-chip-remove" title="Remove">&times;</button>';
    chip.querySelector('.automation-time-chip-remove').addEventListener('click', function () {
      times.splice(i, 1);
      renderAgentTimeChipsInCard(card, agentIndex);
    });
    container.appendChild(chip);
  });
}

function syncAgentFromCard(card, agentIndex) {
  var agent = modalAgents[agentIndex];
  if (!agent) return;
  agent.name = (card.querySelector('.agent-name') || {}).value || '';
  agent.prompt = (card.querySelector('.agent-prompt') || {}).value || '';

  var runModeEl = card.querySelector('.agent-run-mode');
  if (runModeEl) agent.runMode = runModeEl.value;

  var runAfterChecks = card.querySelectorAll('.agent-runafter-chips input:checked');
  agent.runAfter = [];
  runAfterChecks.forEach(function (cb) {
    var targetIdx = parseInt(cb.value);
    var targetAgent = modalAgents[targetIdx];
    if (targetAgent) agent.runAfter.push(targetAgent.id || 'temp_' + targetIdx);
  });

  var runOnFailureEl = card.querySelector('.agent-run-on-failure');
  if (runOnFailureEl) agent.runOnUpstreamFailure = runOnFailureEl.checked;

  var passContextEl = card.querySelector('.agent-pass-context');
  if (passContextEl) agent.passUpstreamContext = passContextEl.checked;

  var isoCheckbox = card.querySelector('.agent-isolation-checkbox');
  if (isoCheckbox) {
    agent.isolation = agent.isolation || {};
    agent.isolation.enabled = isoCheckbox.checked;
  }

  var usageGateSessionEl = card.querySelector('.agent-usage-gate-session');
  var usageGateWeeklyEl = card.querySelector('.agent-usage-gate-weekly');
  if (usageGateSessionEl || usageGateWeeklyEl) {
    function readPct(el) {
      if (!el) return null;
      var raw = (el.value || '').trim();
      if (raw === '' || isNaN(parseFloat(raw))) return null;
      return Math.max(0, Math.min(100, parseFloat(raw)));
    }
    agent.usageGate = {
      sessionMaxPct: readPct(usageGateSessionEl),
      weeklyMaxPct: readPct(usageGateWeeklyEl)
    };
  }

  var schedTypeEl = card.querySelector('.agent-schedule-type');
  if (schedTypeEl) {
    var schedType = schedTypeEl.value;
    if (schedType === 'manual') {
      agent.schedule = { type: 'manual' };
    } else if (schedType === 'interval') {
      var val = parseInt((card.querySelector('.agent-interval-value') || {}).value) || 60;
      var unit = (card.querySelector('.agent-interval-unit') || {}).value || 'minutes';
      agent.schedule = { type: 'interval', minutes: unit === 'hours' ? val * 60 : val };
    } else if (schedType === 'app_startup') {
      agent.schedule = { type: 'app_startup' };
      agent.firstStartOnly = (card.querySelector('.agent-first-start-only') || {}).checked || false;
    } else if (schedType === 'time_of_day') {
      var days = [];
      card.querySelectorAll('.agent-tod-days input:checked').forEach(function (cb) { days.push(cb.value); });
      agent.schedule = { type: 'time_of_day', times: (agent._modalTimes || []).slice(), days: days };
    }
  }

  agent.skipPermissions = (card.querySelector('.agent-skip-permissions') || {}).checked || false;
  agent.dbConnectionString = (card.querySelector('.agent-db-connection') || {}).value.trim() || null;
  agent.dbReadOnly = (card.querySelector('.agent-db-readonly') || {}).checked !== false;

  var epEl = card.querySelector('.agent-endpoint');
  agent.endpointId = (epEl && epEl.value) ? epEl.value : null;
  var epModelEl = card.querySelector('.agent-endpoint-model');
  agent.endpointModel = (epModelEl && epModelEl.value) ? epModelEl.value : null;
}

function syncAllAgentsFromCards() {
  document.querySelectorAll('#automation-agents-list .agent-card').forEach(function (card) {
    var idx = parseInt(card.dataset.agentIndex);
    syncAgentFromCard(card, idx);
  });
}

function saveAutomation() {
  if (modalAgents.length === 0) return;
  syncAllAgentsFromCards();

  var isMulti = modalAgents.length > 1;
  var automationName = isMulti ? document.getElementById('automation-name').value.trim() : (modalAgents[0].name || '');

  if (isMulti && !automationName) { alert('Automation name is required.'); return; }
  for (var i = 0; i < modalAgents.length; i++) {
    if (!modalAgents[i].name || !modalAgents[i].prompt) {
      alert('Agent ' + (i + 1) + ' needs a name and prompt.'); return;
    }
  }
  if (!activeProjectKey) { alert('Select a project first.'); return; }

  // Validate dependencies for circular references
  var hasRunAfter = modalAgents.some(function (ag) { return ag.runMode === 'run_after' && ag.runAfter && ag.runAfter.length > 0; });
  if (hasRunAfter) {
    // Build agent objects with temp IDs for validation
    var validationAgents = modalAgents.map(function (ag, idx) {
      return { id: ag.id || ('temp_' + idx), runAfter: (ag.runAfter || []).slice() };
    });
    // Synchronous cycle check (same logic as backend)
    var hasCycle = (function () {
      var visited = {};
      var inStack = {};
      function dfs(agentId) {
        if (inStack[agentId]) return true;
        if (visited[agentId]) return false;
        visited[agentId] = true;
        inStack[agentId] = true;
        var agent = validationAgents.find(function (a) { return a.id === agentId; });
        if (agent && agent.runAfter) {
          for (var i = 0; i < agent.runAfter.length; i++) {
            if (dfs(agent.runAfter[i])) return true;
          }
        }
        delete inStack[agentId];
        return false;
      }
      for (var i = 0; i < validationAgents.length; i++) {
        if (dfs(validationAgents[i].id)) return true;
      }
      return false;
    })();
    if (hasCycle) {
      alert('Circular dependency detected in agent run-after chain. Please fix before saving.');
      return;
    }
  }

  // Build per-automation runWindow
  var rwErrEl = document.getElementById('automation-runwindow-error');
  rwErrEl.style.display = 'none';
  var rwEnabledV = document.getElementById('automation-runwindow-enabled').checked;
  var automationRunWindow = null;
  if (rwEnabledV) {
    var rwStartStr = document.getElementById('automation-runwindow-start').value;
    var rwEndStr = document.getElementById('automation-runwindow-end').value;
    if (!rwStartStr || !rwEndStr) { rwErrEl.textContent = 'Pick a start and end time'; rwErrEl.style.display = 'block'; return; }
    var sP = rwStartStr.split(':').map(Number);
    var eP = rwEndStr.split(':').map(Number);
    if (sP[0] === eP[0] && sP[1] === eP[1]) { rwErrEl.textContent = 'Start and end must differ'; rwErrEl.style.display = 'block'; return; }
    var rwDays = Array.prototype.slice.call(document.querySelectorAll('#automation-runwindow-days input:checked'))
      .map(function (el) { return el.getAttribute('data-day'); });
    if (rwDays.length === 0) { rwErrEl.textContent = 'Pick at least one day'; rwErrEl.style.display = 'block'; return; }
    automationRunWindow = { enabled: true, startHour: sP[0], startMinute: sP[1], endHour: eP[0], endMinute: eP[1], days: rwDays };
  }

  // Only trigger clone setup for NEW isolation — agents/managers that need isolation but don't have a clonePath yet
  var needsNewClone = modalAgents.some(function (ag) {
    return ag.isolation && ag.isolation.enabled && !ag.isolation.clonePath;
  });
  var needsManagerClone = managerConfig && managerConfig.isolation && managerConfig.isolation.enabled && !managerConfig.isolation.clonePath;
  var needsCloneSetup = needsNewClone || needsManagerClone;

  var agents = modalAgents.map(function (ag) {
    var clean = Object.assign({}, ag);
    delete clean._modalTimes;
    return clean;
  });

  // Build manager config
  var managerConfig = null;
  if (document.getElementById('automation-manager-enabled').checked) {
    managerConfig = {
      enabled: true,
      prompt: document.getElementById('automation-manager-prompt').value.trim(),
      triggerOn: document.getElementById('automation-manager-trigger').value,
      includeFullOutput: document.getElementById('automation-manager-full-output').checked,
      skipPermissions: document.getElementById('automation-manager-skip-permissions').checked,
      dbConnectionString: document.getElementById('automation-manager-db').value.trim() || null,
      dbReadOnly: document.getElementById('automation-manager-db-readonly').checked,
      maxRetries: parseInt(document.getElementById('automation-manager-retries').value) || 1,
      isolation: { enabled: document.getElementById('automation-manager-isolation').checked, clonePath: (automationEditingData && automationEditingData.manager && automationEditingData.manager.isolation ? automationEditingData.manager.isolation.clonePath : null) },
      lastRunAt: null,
      lastRunStatus: null,
      lastSummary: null,
      needsHuman: false,
      humanContext: null
    };
  }

  if (automationEditingId) {
    // Get current automation to find agents that were removed
    window.electronAPI.getAutomationsForProject(activeProjectKey).then(function (automations) {
      var existing = automations.find(function (a) { return a.id === automationEditingId; });
      var existingAgentIds = existing ? existing.agents.map(function (ag) { return ag.id; }) : [];
      var currentAgentIds = agents.filter(function (ag) { return ag.id && ag.id.indexOf('temp_') !== 0; }).map(function (ag) { return ag.id; });

      // Remove agents that were deleted in the modal
      var removePromises = existingAgentIds
        .filter(function (id) { return currentAgentIds.indexOf(id) === -1; })
        .map(function (id) { return window.electronAPI.removeAgent(automationEditingId, id); });

      return Promise.all(removePromises);
    }).then(function () {
      return window.electronAPI.updateAutomation(automationEditingId, { name: automationName, manager: managerConfig, runWindow: automationRunWindow });
    }).then(function () {
      var promises = agents.map(function (ag) {
        if (ag.id && ag.id.indexOf('temp_') !== 0) {
          return window.electronAPI.updateAgent(automationEditingId, ag.id, ag);
        } else {
          return window.electronAPI.addAgent(automationEditingId, ag);
        }
      });
      return Promise.all(promises);
    }).then(function () {
      if (needsCloneSetup) {
        startCloneSetup(automationEditingId);
      } else {
        closeAutomationModal();
        refreshAutomations();
        refreshAutomationsFlyout();
      }
    });
  } else {
    var config = {
      name: automationName,
      projectPath: activeProjectKey,
      agents: agents,
      manager: managerConfig,
      runWindow: automationRunWindow
    };
    window.electronAPI.createAutomation(config).then(function (automation) {
      if (needsCloneSetup) {
        automationEditingId = automation.id;
        startCloneSetup(automation.id);
      } else {
        closeAutomationModal();
        refreshAutomations();
        refreshAutomationsFlyout();
      }
    });
  }
}

function finishCloneSetup() {
  document.getElementById('btn-automation-save').textContent = 'Done';
  document.getElementById('btn-automation-save').disabled = false;
  document.getElementById('btn-automation-save').onclick = function () {
    var autoId = automationEditingId;
    closeAutomationModal();
    refreshAutomations();
    refreshAutomationsFlyout();
    if (autoId) {
      window.electronAPI.getAutomationsForProject(activeProjectKey).then(function (automations) {
        var auto = automations.find(function (a) { return a.id === autoId; });
        if (auto) openAutomationDetail(auto);
      });
    }
  };
}

function startCloneSetup(automationId) {
  var setupPanel = document.getElementById('automation-setup-panel');
  var setupAgents = document.getElementById('automation-setup-agents');
  var setupLog = document.getElementById('automation-setup-log');

  document.getElementById('automation-agents-list').style.display = 'none';
  document.getElementById('automation-add-agent-row').style.display = 'none';
  document.getElementById('automation-name-group').style.display = 'none';
  setupPanel.style.display = '';
  setupLog.textContent = '';

  document.getElementById('btn-automation-save').textContent = 'Setting up...';
  document.getElementById('btn-automation-save').disabled = true;

  window.electronAPI.getAutomationsForProject(activeProjectKey).then(function (automations) {
    var automation = automations.find(function (a) { return a.id === automationId; });
    if (!automation) return;

    var isolatedAgents = automation.agents.filter(function (ag) { return ag.isolation && ag.isolation.enabled; });
    var hasManagerIso = automation.manager && automation.manager.isolation && automation.manager.isolation.enabled;
    setupAgents.innerHTML = '';
    isolatedAgents.forEach(function (ag) {
      var row = document.createElement('div');
      row.className = 'automation-setup-agent-row';
      row.id = 'setup-agent-' + ag.id;
      row.innerHTML = '<span class="automation-setup-agent-icon">&#9711;</span> ' + escapeHtml(ag.name);
      setupAgents.appendChild(row);
    });
    if (hasManagerIso) {
      var mgrRow = document.createElement('div');
      mgrRow.className = 'automation-setup-agent-row';
      mgrRow.id = 'setup-agent-_manager';
      mgrRow.innerHTML = '<span class="automation-setup-agent-icon">&#9711;</span> Manager';
      setupAgents.appendChild(mgrRow);
    }

    activeCloneAutomationId = automationId;

    var cloneNext = function (index) {
      if (index >= isolatedAgents.length) {
        // After all agents, clone manager if needed
        if (hasManagerIso) {
          var mgrRowEl = document.getElementById('setup-agent-_manager');
          if (mgrRowEl) mgrRowEl.querySelector('.automation-setup-agent-icon').innerHTML = '&#8987;';
          window.electronAPI.setupManagerClone(automationId).then(function (result) {
            if (mgrRowEl) {
              mgrRowEl.querySelector('.automation-setup-agent-icon').innerHTML = result.error ? '&#10007;' : '&#10003;';
              if (result.error) mgrRowEl.style.color = '#ef4444';
              else mgrRowEl.style.color = '#22c55e';
            }
            if (result.error) setupLog.textContent += '\nManager clone ERROR: ' + result.error + '\n';
            finishCloneSetup();
          });
          return; // Don't call finishCloneSetup yet — wait for manager clone
        }
        finishCloneSetup();
        return;
      }
      var ag = isolatedAgents[index];
      var row = document.getElementById('setup-agent-' + ag.id);
      if (row) row.querySelector('.automation-setup-agent-icon').innerHTML = '&#8987;';

      window.electronAPI.setupAgentClone(automationId, ag.id).then(function (result) {
        if (row) {
          row.querySelector('.automation-setup-agent-icon').innerHTML = result.error ? '&#10007;' : '&#10003;';
          if (result.error) row.style.color = '#ef4444';
          else row.style.color = '#22c55e';
        }
        if (result.error) {
          setupLog.textContent += '\nERROR: ' + result.error + '\n';
        }
        cloneNext(index + 1);
      });
    };
    cloneNext(0);
  });
}

document.getElementById('btn-automation-modal-close').addEventListener('click', closeAutomationModal);
document.getElementById('btn-automation-cancel').addEventListener('click', closeAutomationModal);
document.getElementById('btn-automation-save').addEventListener('click', saveAutomation);
window.electronAPI.onCloneProgress(function (data) {
  if (activeCloneAutomationId && data.automationId === activeCloneAutomationId) {
    var setupLog = document.getElementById('automation-setup-log');
    if (setupLog) {
      setupLog.textContent += data.line;
      setupLog.scrollTop = setupLog.scrollHeight;
    }
  }
});
document.getElementById('btn-add-automation').addEventListener('click', function () {
  if (!activeProjectKey) { alert('Select a project first.'); return; }
  openAutomationModal(null);
});
document.getElementById('btn-add-agent').addEventListener('click', function () {
  syncAllAgentsFromCards();
  if (modalAgents.length === 1 && !document.getElementById('automation-name').value) {
    document.getElementById('automation-name').value = modalAgents[0].name || '';
  }
  modalAgents.push({
    name: '', prompt: '', schedule: { type: 'interval', minutes: 60 },
    runMode: 'independent', runAfter: [], runOnUpstreamFailure: false, isolation: { enabled: false, clonePath: null },
    skipPermissions: false, dbConnectionString: null, dbReadOnly: true, firstStartOnly: false,
    endpointId: null, endpointModel: null
  });
  renderModalAgentCards();
  document.getElementById('automation-manager-section').style.display = '';
});
document.getElementById('automation-manager-enabled').addEventListener('change', function () {
  document.getElementById('automation-manager-fields').style.display = this.checked ? '' : 'none';
});
['automation-manager-prompt', 'automation-manager-db', 'automation-manager-retries'].forEach(function (id) {
  document.getElementById(id).addEventListener('keydown', function (e) { e.stopPropagation(); });
});
document.getElementById('btn-refresh-automations').addEventListener('click', refreshAutomations);

document.getElementById('btn-pause-all-automations').addEventListener('click', function () {
  if (!activeProjectKey) { alert('Select a project first.'); return; }
  if (automationsForProject.length === 0) return;
  window.electronAPI.setAllAutomationsEnabled(activeProjectKey, false).then(function () { refreshAutomations(); });
});

document.getElementById('btn-resume-all-automations').addEventListener('click', function () {
  if (!activeProjectKey) { alert('Select a project first.'); return; }
  if (automationsForProject.length === 0) return;
  window.electronAPI.setAllAutomationsEnabled(activeProjectKey, true).then(function () { refreshAutomations(); });
});

document.getElementById('btn-export-automations').addEventListener('click', function () {
  if (!activeProjectKey) { alert('Select a project first.'); return; }
  if (automationsForProject.length === 0) { alert('No automations to export.'); return; }
  window.electronAPI.exportAutomations(activeProjectKey);
});

document.getElementById('btn-import-automations').addEventListener('click', function () {
  if (!activeProjectKey) { alert('Select a project first.'); return; }

  // Step 1: Select file and preview
  window.electronAPI.previewImport().then(function (preview) {
    if (!preview || preview.cancelled) return;
    if (preview.error) { alert(preview.error); return; }

    // Step 2: Show preview panel in the automations list area
    showImportPreview(preview);
  });
});

function showImportPreview(preview) {
  importInProgress = true;
  var listEl = document.getElementById('automations-list');
  var searchBar = document.getElementById('automations-search-bar');
  var noProject = document.getElementById('automations-no-project');
  if (searchBar) searchBar.style.display = 'none';
  if (noProject) noProject.style.display = 'none';
  listEl.innerHTML = '';

  var panel = document.createElement('div');
  panel.className = 'import-progress-panel';

  // Header
  var headerHtml = '<div class="import-progress-header">' +
    '<strong>Import Preview</strong>' +
    '<div style="font-size:11px;opacity:0.6;margin-top:4px;">' +
    safeNum(preview.automationCount) + ' automations, ' + safeNum(preview.totalAgents) + ' agents';
  if (safeNum(preview.totalManagers) > 0) headerHtml += ', ' + safeNum(preview.totalManagers) + ' managers';
  headerHtml += '</div>';
  if (safeNum(preview.totalIsolated) > 0) {
    headerHtml += '<div style="font-size:11px;color:#f59e0b;margin-top:2px;">' + safeNum(preview.totalIsolated) + ' repo clone(s) will be set up after import</div>';
  }
  headerHtml += '</div>';

  // Automation list
  var listHtml = '<div class="import-progress-list">';
  preview.automations.forEach(function (a) {
    var badges = '';
    if (a.hasManager) badges += '<span class="agent-badge agent-badge-chained" style="margin-left:6px;">Manager</span>';
    if (a.hasChaining) badges += '<span class="agent-badge agent-badge-isolated" style="margin-left:4px;">Chained</span>';
    if (safeNum(a.isolatedCount) > 0) badges += '<span class="agent-badge" style="margin-left:4px;background:rgba(59,130,246,0.15);color:#60a5fa;">' + safeNum(a.isolatedCount) + ' clone(s)</span>';

    listHtml += '<div class="import-progress-row">' +
      '<span class="import-progress-icon">&#9711;</span>' +
      '<span class="import-progress-name">' + escapeHtml(a.name) + '</span>' +
      '<span style="font-size:11px;opacity:0.5;">' + safeNum(a.agentCount) + ' agent' + (safeNum(a.agentCount) > 1 ? 's' : '') + '</span>' +
      badges +
      '</div>';
  });
  listHtml += '</div>';

  // Footer with confirm/cancel
  var footerHtml = '<div class="import-progress-footer" style="display:flex;gap:8px;justify-content:center;margin-top:16px;">' +
    '<button class="modal-btn-save import-confirm-btn">Confirm Import</button>' +
    '<button class="modal-btn-save import-cancel-btn" style="background:transparent;border:1px solid #444;">Cancel</button>' +
    '</div>' +
    '<div style="text-align:center;font-size:10px;opacity:0.4;margin-top:6px;">Automations will be imported as paused</div>';

  panel.innerHTML = headerHtml + listHtml + footerHtml;
  listEl.appendChild(panel);

  // Cancel — go back to normal list
  panel.querySelector('.import-cancel-btn').addEventListener('click', function () {
    importInProgress = false;
    refreshAutomations();
  });

  // Confirm — run the import
  panel.querySelector('.import-confirm-btn').addEventListener('click', function () {
    // Disable buttons
    panel.querySelector('.import-confirm-btn').disabled = true;
    panel.querySelector('.import-confirm-btn').textContent = 'Importing...';
    panel.querySelector('.import-cancel-btn').style.display = 'none';

    window.electronAPI.importAutomations(activeProjectKey, preview.filePath).then(function (result) {
      if (result && result.error) { alert(result.error); refreshAutomations(); return; }
      if (!result || !result.count) { refreshAutomations(); return; }

      refreshAutomationsFlyout();

      var needsClone = (result.importedIds || []).filter(function (a) { return a.needsClone; });
      if (needsClone.length > 0) {
        // Transition the preview panel into progress mode
        showImportProgress(result, needsClone);
      } else {
        // No clones needed — show done
        panel.querySelector('.import-progress-header').innerHTML = '<strong>Import Complete</strong>' +
          '<div style="font-size:11px;opacity:0.6;margin-top:4px;">' + safeNum(result.count) + ' automations imported (paused)</div>';
        // Mark all rows as ready
        panel.querySelectorAll('.import-progress-icon').forEach(function (icon) {
          icon.innerHTML = '&#10003;';
          icon.style.color = '#22c55e';
        });
        panel.querySelector('.import-confirm-btn').textContent = 'Done';
        panel.querySelector('.import-confirm-btn').disabled = false;
        panel.querySelector('.import-confirm-btn').onclick = function () { refreshAutomations(); };
      }
    });
  });
}

function showImportProgress(importResult, needsClone) {
  importInProgress = true;
  var listEl = document.getElementById('automations-list');
  listEl.innerHTML = '';

  var panel = document.createElement('div');
  panel.className = 'import-progress-panel';
  panel.innerHTML = '<div class="import-progress-header">' +
    '<strong>Imported ' + safeNum(importResult.count) + ' automations (paused)</strong>' +
    '<div class="import-progress-subtitle">Setting up ' + safeNum(needsClone.length) + ' repo clone(s)...</div>' +
    '</div>' +
    '<div class="import-progress-list"></div>' +
    '<pre class="import-progress-log"></pre>' +
    '<div class="import-progress-footer" style="display:none;">' +
    '<button class="automation-detail-run-all import-progress-done">Done</button>' +
    '</div>';

  var progressList = panel.querySelector('.import-progress-list');
  var logEl = panel.querySelector('.import-progress-log');

  // Build rows for ALL imported automations
  importResult.importedIds.forEach(function (auto) {
    var row = document.createElement('div');
    row.className = 'import-progress-row';
    row.id = 'import-row-' + auto.id;
    var statusIcon = auto.needsClone ? '&#9711;' : '&#10003;';
    var statusColor = auto.needsClone ? '' : 'color:#22c55e;';
    row.innerHTML = '<span class="import-progress-icon" style="' + statusColor + '">' + statusIcon + '</span>' +
      '<span class="import-progress-name">' + escapeHtml(auto.name) + '</span>' +
      '<span class="import-progress-status">' + (auto.needsClone ? 'Pending clone...' : 'Ready') + '</span>';
    progressList.appendChild(row);
  });

  listEl.appendChild(panel);

  // Listen for clone progress events and show in the log
  var importCloneHandler = function (data) {
    if (logEl) {
      logEl.textContent += data.line;
      logEl.scrollTop = logEl.scrollHeight;
    }
  };
  window.electronAPI.onCloneProgress(importCloneHandler);

  // Process clones sequentially
  var cloneNext = function (idx) {
    if (idx >= needsClone.length) {
      // All done
      importInProgress = false;
      panel.querySelector('.import-progress-subtitle').textContent = 'All clones complete. Automations are paused — enable them when ready.';
      panel.querySelector('.import-progress-footer').style.display = '';
      panel.querySelector('.import-progress-done').addEventListener('click', function () {
        importInProgress = false;
        refreshAutomations();
      });
      return;
    }

    var auto = needsClone[idx];
    var row = document.getElementById('import-row-' + auto.id);
    if (row) {
      row.querySelector('.import-progress-icon').innerHTML = '&#8987;';
      row.querySelector('.import-progress-icon').style.color = '#3b82f6';
      row.querySelector('.import-progress-status').textContent = 'Cloning...';
    }
    // Show which automation is being cloned in the log
    if (logEl) logEl.textContent += '\n--- Cloning: ' + auto.name + ' ---\n';

    window.electronAPI.getAutomationsForProject(activeProjectKey).then(function (automations) {
      var automation = automations.find(function (a) { return a.id === auto.id; });
      if (!automation) { cloneNext(idx + 1); return; }

      var isolatedAgents = automation.agents.filter(function (ag) { return ag.isolation && ag.isolation.enabled; });
      var hasManagerIso = automation.manager && automation.manager.isolation && automation.manager.isolation.enabled;
      var totalSteps = isolatedAgents.length + (hasManagerIso ? 1 : 0);
      var stepsDone = 0;

      var updateRowStatus = function () {
        if (row) row.querySelector('.import-progress-status').textContent = 'Cloning (' + stepsDone + '/' + totalSteps + ')...';
      };

      var cloneAgentStep = function (agIdx) {
        if (agIdx >= isolatedAgents.length) {
          if (hasManagerIso) {
            updateRowStatus();
            window.electronAPI.setupManagerClone(auto.id).then(function (result) {
              stepsDone++;
              if (row) {
                row.querySelector('.import-progress-icon').innerHTML = result && result.error ? '&#10007;' : '&#10003;';
                row.querySelector('.import-progress-icon').style.color = result && result.error ? '#ef4444' : '#22c55e';
                row.querySelector('.import-progress-status').textContent = result && result.error ? 'Error: ' + result.error : 'Ready';
              }
              cloneNext(idx + 1);
            });
          } else {
            if (row) {
              row.querySelector('.import-progress-icon').innerHTML = '&#10003;';
              row.querySelector('.import-progress-icon').style.color = '#22c55e';
              row.querySelector('.import-progress-status').textContent = 'Ready';
            }
            cloneNext(idx + 1);
          }
          return;
        }
        updateRowStatus();
        window.electronAPI.setupAgentClone(auto.id, isolatedAgents[agIdx].id).then(function (result) {
          stepsDone++;
          if (result && result.error && row) {
            row.querySelector('.import-progress-status').textContent = 'Error: ' + result.error;
          }
          cloneAgentStep(agIdx + 1);
        });
      };

      cloneAgentStep(0);
    });
  };

  cloneNext(0);
}

document.getElementById('btn-clear-automations').addEventListener('click', function () {
  if (!activeProjectKey) { alert('Select a project first.'); return; }
  if (automationsForProject.length === 0) { alert('No automations to clear.'); return; }
  if (!confirm('Delete ALL ' + automationsForProject.length + ' automations for this project? This cannot be undone.')) return;
  window.electronAPI.deleteAllAutomations(activeProjectKey).then(function (result) {
    if (result && result.deleted) refreshAutomations();
    refreshAutomationsFlyout();
  });
});

document.getElementById('automations-search-input').addEventListener('input', function () {
  var query = this.value.toLowerCase().trim();
  var listEl = document.getElementById('automations-list');
  var filtered = automationsForProject;
  if (query) {
    filtered = automationsForProject.filter(function (a) {
      var nameMatch = a.name.toLowerCase().indexOf(query) !== -1;
      var agentMatch = a.agents.some(function (ag) {
        return ag.name.toLowerCase().indexOf(query) !== -1 || ag.prompt.toLowerCase().indexOf(query) !== -1;
      });
      return nameMatch || agentMatch;
    });
  }
  renderAutomationCards(filtered, listEl);
});

document.getElementById('automations-search-input').addEventListener('keydown', function (e) {
  e.stopPropagation();
});

// ============================================================
// Automations Flyout Dashboard
// ============================================================

function toggleAutomationsFlyout() {
  var flyout = document.getElementById('automations-flyout');
  flyout.classList.toggle('hidden');
  if (!flyout.classList.contains('hidden')) {
    refreshAutomationsFlyout();
  }
}

function refreshAutomationsFlyout() {
  var flyout = document.getElementById('automations-flyout');
  if (!flyout || flyout.classList.contains('hidden')) return;

  window.electronAPI.getAutomations().then(function (data) {
    allAutomationsData = data;
    var listEl = document.getElementById('automations-flyout-list');
    var countsEl = document.getElementById('automations-flyout-counts');

    var globalBtn = document.getElementById('btn-automations-global-toggle');
    globalBtn.innerHTML = data.globalEnabled ? '&#10074;&#10074;' : '&#9654;';
    globalBtn.title = data.globalEnabled ? 'Pause all automations' : 'Resume all automations';

    var activeCount = 0;
    var attentionCount = 0;
    data.automations.forEach(function (auto) {
      if (auto.enabled) activeCount++;
      auto.agents.forEach(function (ag) {
        if (ag.lastRunStatus === 'error' || ag.lastError) attentionCount++;
      });
    });
    countsEl.textContent = activeCount + ' active' + (attentionCount > 0 ? ' \u00b7 ' + attentionCount + ' need attention' : '');

    var flyoutBtn = document.getElementById('btn-automations-flyout');
    if (flyoutBtn) {
      if (attentionCount > 0) flyoutBtn.classList.add('has-attention');
      else flyoutBtn.classList.remove('has-attention');
    }

    var byProject = {};
    data.automations.forEach(function (auto) {
      var projName = auto.projectPath.split('/').pop().split('\\').pop();
      if (!byProject[projName]) byProject[projName] = { path: auto.projectPath, automations: [] };
      byProject[projName].automations.push(auto);
    });

    listEl.innerHTML = '';
    if (data.automations.length === 0) {
      listEl.innerHTML = '<p style="opacity:0.5;text-align:center;padding:2rem;font-size:12px;">No automations configured yet.</p>';
      return;
    }

    Object.keys(byProject).forEach(function (projName) {
      var group = byProject[projName];
      var header = document.createElement('div');
      header.className = 'automations-flyout-project-header';
      header.textContent = projName;
      listEl.appendChild(header);

      group.automations.forEach(function (auto) {
        var row = document.createElement('div');
        row.className = 'automations-flyout-row';
        var isSimple = auto.agents.length === 1;

        var statusText = '';
        var statusColor = '#22c55e';
        var anyRunning = auto.agents.some(function (ag) { return !!ag.currentRunStartedAt; });
        var anyError = auto.agents.some(function (ag) { return ag.lastRunStatus === 'error'; });

        if (!auto.enabled) { statusText = 'disabled'; statusColor = '#888'; }
        else if (anyRunning) { statusText = 'running...'; }
        else if (anyError) { statusText = '\u2717 error'; statusColor = '#ef4444'; }
        else if (auto.manager && auto.manager.needsHuman) { statusText = '\u26a0 needs you'; statusColor = '#f59e0b'; }
        else { statusText = '\u2713 ok'; }

        var displayName = isSimple ? auto.agents[0].name : auto.name;

        var pipelineDotsHtml = '';
        if (!isSimple) {
          pipelineDotsHtml = '<div class="automation-pipeline-mini" style="padding:2px 0 0 0;">';
          auto.agents.forEach(function (ag) {
            var dotClass = 'pipeline-dot-idle';
            if (ag.currentRunStartedAt) dotClass = 'pipeline-dot-running';
            else if (ag.lastRunStatus === 'error') dotClass = 'pipeline-dot-error';
            else if (ag.lastRunStatus === 'skipped' || !ag.enabled) dotClass = 'pipeline-dot-waiting';
            pipelineDotsHtml += '<span class="pipeline-dot ' + dotClass + '" title="' + escapeHtml(ag.name) + '"></span>';
          });
          pipelineDotsHtml += '</div>';
        }

        row.innerHTML = '<div class="automations-flyout-row-header">' +
          '<span>' + escapeHtml(displayName) + (isSimple ? '' : ' <span style="opacity:0.5">(' + auto.agents.length + ' agents)</span>') + '</span>' +
          '<span class="automations-flyout-row-status" style="color:' + statusColor + '">' + statusText + '</span>' +
          runWindowBadgeHtml(auto) +
          '</div>' +
          pipelineDotsHtml +
          '<div class="automations-flyout-row-expanded">' +
            '<div class="automations-flyout-row-summary">Loading...</div>' +
            '<div class="automations-flyout-history"></div>' +
          '</div>';

        row.addEventListener('click', function () {
          var wasExpanded = row.classList.contains('expanded');
          listEl.querySelectorAll('.automations-flyout-row').forEach(function (r) { r.classList.remove('expanded'); });
          if (!wasExpanded) {
            row.classList.add('expanded');
            var summaryEl = row.querySelector('.automations-flyout-row-summary');
            if (isSimple) {
              var ag = auto.agents[0];
              window.electronAPI.getAgentHistory(auto.id, ag.id, 5).then(function (history) {
                if (history.length > 0) { summaryEl.textContent = history[0].summary || 'No summary'; }
                else { summaryEl.textContent = 'No runs yet'; }
              });
            } else {
              summaryEl.innerHTML = '';
              auto.agents.forEach(function (ag) {
                summaryEl.innerHTML += '<div><strong>' + escapeHtml(ag.name) + ':</strong> ' + escapeHtml(ag.lastSummary || 'No runs') + '</div>';
              });
            }
          }
        });

        listEl.appendChild(row);
      });
    });
  });
}

// ============================================================
// Run Window Popover
// ============================================================

var currentRunWindowDraft = null;

var runWindowPopoverAnchor = null;

function positionRunWindowPopover() {
  var pop = document.getElementById('automations-runwindow-popover');
  if (!pop || !runWindowPopoverAnchor) return;
  var rect = runWindowPopoverAnchor.getBoundingClientRect();
  var popWidth = pop.offsetWidth || 260;
  var left = Math.min(Math.max(rect.left, 8), window.innerWidth - popWidth - 8);
  var top = rect.bottom + 4;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  pop.style.right = 'auto';
}

function openRunWindowPopover(anchor) {
  var pop = document.getElementById('automations-runwindow-popover');
  if (anchor) runWindowPopoverAnchor = anchor;
  window.electronAPI.getAutomationSettings().then(function (settings) {
    var w = settings.runWindow || { enabled: false, startHour: 9, startMinute: 0, endHour: 17, endMinute: 0, days: ['mon','tue','wed','thu','fri'] };
    document.getElementById('runwindow-enabled').checked = !!w.enabled;
    document.getElementById('runwindow-fields').style.display = w.enabled ? 'block' : 'none';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    document.getElementById('runwindow-start').value = pad(w.startHour) + ':' + pad(w.startMinute || 0);
    document.getElementById('runwindow-end').value = pad(w.endHour) + ':' + pad(w.endMinute || 0);
    var days = w.days || [];
    var dayEls = pop.querySelectorAll('.runwindow-days input[type="checkbox"]');
    dayEls.forEach(function (el) {
      el.checked = days.indexOf(el.getAttribute('data-day')) !== -1;
    });
    document.getElementById('runwindow-error').style.display = 'none';
    pop.classList.remove('hidden');
    positionRunWindowPopover();
  });
}

function closeRunWindowPopover() {
  document.getElementById('automations-runwindow-popover').classList.add('hidden');
}

function saveRunWindowPopover() {
  var enabled = document.getElementById('runwindow-enabled').checked;
  var errEl = document.getElementById('runwindow-error');
  var payload;

  if (!enabled) {
    payload = null;
  } else {
    var startStr = document.getElementById('runwindow-start').value;
    var endStr = document.getElementById('runwindow-end').value;
    if (!startStr || !endStr) { errEl.textContent = 'Pick a start and end time'; errEl.style.display = 'block'; return; }
    var sParts = startStr.split(':').map(Number);
    var eParts = endStr.split(':').map(Number);
    var days = Array.prototype.slice.call(document.querySelectorAll('#automations-runwindow-popover .runwindow-days input:checked'))
      .map(function (el) { return el.getAttribute('data-day'); });
    if (days.length === 0) { errEl.textContent = 'Pick at least one day'; errEl.style.display = 'block'; return; }
    if (sParts[0] === eParts[0] && sParts[1] === eParts[1]) {
      errEl.textContent = 'Start and end must differ';
      errEl.style.display = 'block';
      return;
    }
    payload = { enabled: true, startHour: sParts[0], startMinute: sParts[1], endHour: eParts[0], endMinute: eParts[1], days: days };
  }

  window.electronAPI.updateAutomationSettings({ runWindow: payload }).then(function () {
    closeRunWindowPopover();
    refreshAutomationsRunWindowIndicator();
    if (typeof refreshAutomationsStatusStrip === 'function') refreshAutomationsStatusStrip();
  });
}

var runWindowStripTimer = null;

function formatRunWindowSummary(w) {
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var dayLabels = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  var order = ['mon','tue','wed','thu','fri','sat','sun'];
  var sel = order.filter(function (d) { return w.days.indexOf(d) !== -1; }).map(function (d) { return dayLabels[d]; });
  var dayStr;
  if (sel.length === 5 && w.days.indexOf('mon') !== -1 && w.days.indexOf('fri') !== -1 && w.days.indexOf('sat') === -1 && w.days.indexOf('sun') === -1) dayStr = 'Mon–Fri';
  else if (sel.length === 7) dayStr = 'Every day';
  else dayStr = sel.join(', ');
  return pad(w.startHour) + ':' + pad(w.startMinute || 0) + '–' + pad(w.endHour) + ':' + pad(w.endMinute || 0) + ' · ' + dayStr;
}

// Renderer-side copy of isWithinRunWindow (keep behavior identical to main.js)
function isWithinRunWindow(w, now) {
  if (!w || !w.enabled) return true;
  if (!w.days || w.days.length === 0) return false;
  var names = ['sun','mon','tue','wed','thu','fri','sat'];
  var today = names[now.getDay()];
  var yest = names[(now.getDay() + 6) % 7];
  var nm = now.getHours() * 60 + now.getMinutes();
  var sm = w.startHour * 60 + (w.startMinute || 0);
  var em = w.endHour * 60 + (w.endMinute || 0);
  if (em > sm) return w.days.indexOf(today) !== -1 && nm >= sm && nm < em;
  if (w.days.indexOf(today) !== -1 && nm >= sm) return true;
  if (w.days.indexOf(yest) !== -1 && nm < em) return true;
  return false;
}

function nextOpenMoment(w, from) {
  var names = ['sun','mon','tue','wed','thu','fri','sat'];
  var dayLabel = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var pad = function (n) { return String(n).padStart(2, '0'); };
  for (var i = 0; i < 8; i++) {
    var d = new Date(from.getTime() + i * 86400000);
    var key = names[d.getDay()];
    if (w.days.indexOf(key) === -1) continue;
    var scheduled = new Date(d.getFullYear(), d.getMonth(), d.getDate(), w.startHour, w.startMinute || 0, 0, 0);
    if (scheduled > from) return dayLabel[d.getDay()] + ' ' + pad(w.startHour) + ':' + pad(w.startMinute || 0);
  }
  return '';
}

function refreshAutomationsStatusStrip() {
  var strip = document.getElementById('automations-runwindow-strip');
  if (!strip) return;
  window.electronAPI.getAutomationSettings().then(function (settings) {
    var w = settings.runWindow;
    if (!w || !w.enabled) {
      strip.classList.add('hidden');
      strip.classList.remove('active', 'paused');
      return;
    }
    strip.classList.remove('hidden');
    var now = new Date();
    var open = isWithinRunWindow(w, now);
    var summary = formatRunWindowSummary(w);
    var textEl = document.getElementById('automations-runwindow-strip-text');
    if (open) {
      strip.classList.add('active'); strip.classList.remove('paused');
      textEl.textContent = '⏰ Active · ' + summary;
    } else {
      strip.classList.add('paused'); strip.classList.remove('active');
      var next = nextOpenMoment(w, now);
      textEl.textContent = '⏰ Paused until ' + next + ' · ' + summary;
    }
  });
}

function startAutomationsStatusStripTimer() {
  if (runWindowStripTimer) return;
  refreshAutomationsStatusStrip();
  runWindowStripTimer = setInterval(refreshAutomationsStatusStrip, 60000);
}

function stopAutomationsStatusStripTimer() {
  if (runWindowStripTimer) {
    clearInterval(runWindowStripTimer);
    runWindowStripTimer = null;
  }
}

function refreshAutomationsRunWindowIndicator() {
  var ind = document.getElementById('automations-runwindow-indicator');
  if (!ind) return;
  window.electronAPI.getAutomationSettings().then(function (settings) {
    if (settings.runWindow && settings.runWindow.enabled) ind.classList.remove('hidden');
    else ind.classList.add('hidden');
  });
}

document.getElementById('btn-automations-flyout').addEventListener('click', toggleAutomationsFlyout);
document.getElementById('btn-automations-flyout-close').addEventListener('click', toggleAutomationsFlyout);
document.getElementById('btn-automations-global-toggle').addEventListener('click', function () {
  window.electronAPI.toggleAutomationsGlobal().then(function () {
    refreshAutomationsFlyout();
  });
});

(function setupRunWindowPopover() {
  var enabledEl = document.getElementById('runwindow-enabled');
  if (enabledEl) {
    enabledEl.addEventListener('change', function () {
      document.getElementById('runwindow-fields').style.display = this.checked ? 'block' : 'none';
    });
  }
  function togglePopoverFrom(anchor) {
    var pop = document.getElementById('automations-runwindow-popover');
    if (pop.classList.contains('hidden')) openRunWindowPopover(anchor);
    else closeRunWindowPopover();
  }

  var openBtn = document.getElementById('btn-automations-runwindow');
  if (openBtn) openBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    togglePopoverFrom(openBtn);
  });
  var panelBtn = document.getElementById('btn-automations-runwindow-panel');
  if (panelBtn) panelBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    togglePopoverFrom(panelBtn);
  });
  var cancelBtn = document.getElementById('btn-runwindow-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeRunWindowPopover);
  var saveBtn = document.getElementById('btn-runwindow-save');
  if (saveBtn) saveBtn.addEventListener('click', saveRunWindowPopover);

  document.addEventListener('click', function (e) {
    var pop = document.getElementById('automations-runwindow-popover');
    if (!pop || pop.classList.contains('hidden')) return;
    if (pop.contains(e.target)) return;
    if (openBtn && openBtn.contains(e.target)) return;
    if (panelBtn && panelBtn.contains(e.target)) return;
    closeRunWindowPopover();
  });

  window.addEventListener('resize', function () {
    var pop = document.getElementById('automations-runwindow-popover');
    if (pop && !pop.classList.contains('hidden')) positionRunWindowPopover();
  });

  var strip = document.getElementById('automations-runwindow-strip');
  if (strip) strip.addEventListener('click', function () {
    openRunWindowPopover(strip);
  });

  startAutomationsStatusStripTimer();

  refreshAutomationsRunWindowIndicator();

  var autoRwToggle = document.getElementById('automation-runwindow-toggle');
  if (autoRwToggle) autoRwToggle.addEventListener('click', function () {
    var section = document.getElementById('automation-runwindow-section');
    var body = document.getElementById('automation-runwindow-body');
    var isOpen = section.classList.toggle('expanded');
    body.style.display = isOpen ? 'block' : 'none';
  });

  var autoRwEnabled = document.getElementById('automation-runwindow-enabled');
  if (autoRwEnabled) autoRwEnabled.addEventListener('change', function () {
    document.getElementById('automation-runwindow-fields').style.display = this.checked ? 'block' : 'none';
  });
})();

// ============================================================
// Automation Events & Sidebar Integration
// ============================================================

window.electronAPI.onAgentStarted(function (data) {
  refreshAutomations();
  refreshAutomationsFlyout();
  updateAutomationsTabIndicator();
  updateAutomationSidebarBadges();
  if (activeAutomationDetailId === data.automationId) {
    window.electronAPI.getAutomationsForProject(activeProjectKey).then(function (automations) {
      var auto = automations.find(function (a) { return a.id === data.automationId; });
      if (auto) openAutomationDetail(auto);
    });
  }
});

window.electronAPI.onAgentOutput(function (data) {
  if (activeAutomationDetailId === data.automationId && activeAgentDetailId === data.agentId && agentDetailViewingLive) {
    var outputEl = document.getElementById('automation-detail-output');
    if (outputEl) {
      var indicator = outputEl.querySelector('.automation-processing-indicator');
      if (indicator) outputEl.textContent = '';
      outputEl.textContent += data.chunk;
      outputEl.scrollTop = outputEl.scrollHeight;
    }
  }
});

window.electronAPI.onAgentCompleted(function (data) {
  refreshAutomations();
  refreshAutomationsFlyout();
  updateAutomationSidebarBadges();
  updateAutomationsTabIndicator();
  if (activeAutomationDetailId === data.automationId) {
    window.electronAPI.getAutomationsForProject(activeProjectKey).then(function (automations) {
      var auto = automations.find(function (a) { return a.id === data.automationId; });
      if (auto) openAutomationDetail(auto);
    });
  }
  if (data.attentionItems && data.attentionItems.length > 0) {
    var flyoutBtn = document.getElementById('btn-automations-flyout');
    if (flyoutBtn) flyoutBtn.classList.add('has-attention');
  }
});

window.electronAPI.onManagerStarted(function (data) {
  refreshAutomations();
  refreshAutomationsFlyout();
  if (activeAutomationDetailId === data.automationId && activeDetailAutomation) {
    window.electronAPI.getAutomationsForProject(activeProjectKey).then(function (automations) {
      var auto = automations.find(function (a) { return a.id === data.automationId; });
      if (auto) { activeDetailAutomation = auto; renderMultiAgentDetail(auto); }
    });
  }
});

window.electronAPI.onManagerCompleted(function (data) {
  refreshAutomations();
  refreshAutomationsFlyout();
  updateAutomationSidebarBadges();
  if (activeAutomationDetailId === data.automationId && activeDetailAutomation) {
    window.electronAPI.getAutomationsForProject(activeProjectKey).then(function (automations) {
      var auto = automations.find(function (a) { return a.id === data.automationId; });
      if (auto) { activeDetailAutomation = auto; renderMultiAgentDetail(auto); }
    });
  }
});

window.electronAPI.onManagerOutput(function (data) {
  if (viewingManagerLive && viewingManagerAutomationId === data.automationId) {
    var outputEl = document.getElementById('automation-detail-output');
    if (outputEl) {
      var indicator = outputEl.querySelector('.automation-processing-indicator');
      if (indicator) outputEl.textContent = '';
      outputEl.textContent += data.chunk;
      outputEl.scrollTop = outputEl.scrollHeight;
    }
  }
});

window.electronAPI.onFocusManager(function (data) {
  var tab = document.querySelector('.explorer-tab[data-tab="automations"]');
  if (tab) tab.click();
  window.electronAPI.getAutomationsForProject(activeProjectKey).then(function (automations) {
    var auto = automations.find(function (a) { return a.id === data.automationId; });
    if (auto) openAutomationDetail(auto);
  });
});

function updateAutomationsTabIndicator() {
  if (!activeProjectKey) return;
  window.electronAPI.getAutomationsForProject(activeProjectKey).then(function (automations) {
    var hasAutomations = automations.length > 0;
    var anyRunning = automations.some(function (auto) {
      return auto.agents.some(function (ag) { return !!ag.currentRunStartedAt; });
    });
    var tab = document.querySelector('.explorer-tab[data-tab="automations"]');
    if (tab) {
      if (anyRunning) { tab.classList.add('has-running'); tab.classList.remove('has-automations'); }
      else if (hasAutomations) { tab.classList.remove('has-running'); tab.classList.add('has-automations'); }
      else { tab.classList.remove('has-running'); tab.classList.remove('has-automations'); }
    }
  });
}

function updateAutomationSidebarBadges() {
  window.electronAPI.getAutomations().then(function (data) {
    var projectsWithAttention = new Set();
    data.automations.forEach(function (auto) {
      auto.agents.forEach(function (ag) {
        if (ag.lastRunStatus === 'error' || ag.lastError) {
          projectsWithAttention.add(auto.projectPath.replace(/\\/g, '/'));
        }
      });
      if (auto.manager && auto.manager.needsHuman) {
        projectsWithAttention.add(auto.projectPath.replace(/\\/g, '/'));
      }
    });
    var items = document.querySelectorAll('.project-item');
    items.forEach(function (item) {
      var existing = item.querySelector('.project-automation-badge');
      if (existing) existing.remove();
    });
    if (config && config.projects) {
      config.projects.forEach(function (project) {
        var normalizedPath = project.path.replace(/\\/g, '/');
        if (!projectsWithAttention.has(normalizedPath)) return;
        // Match by path, not positional index — pinned/grouped projects
        // reorder the DOM relative to config.projects order.
        var item = projectListEl.querySelector('.project-item[data-project-path="' + CSS.escape(project.path) + '"]');
        if (!item) return;
        var badge = document.createElement('span');
        badge.className = 'project-automation-badge';
        badge.title = 'Automation needs attention';
        var nameEl = item.querySelector('.project-name');
        if (nameEl) nameEl.appendChild(badge);
      });
    }
  });
}

// ============================================================
// Conversational Automation Setup
// ============================================================

// Copy output button
document.getElementById('btn-automation-open-claude').addEventListener('click', function () {
  if (!activeAutomationDetailId) return;
  var outputEl = document.getElementById('automation-detail-output');
  var nameEl = document.getElementById('automation-detail-name');
  var automationName = nameEl ? nameEl.textContent : 'Automation';
  var output = outputEl.textContent || '';

  if (!output || output === 'Loading...' || output.indexOf('Processing...') === 0) {
    alert('No output to continue with.');
    return;
  }

  var context = 'You are continuing work from a background automation called "' + automationName + '". ' +
    'Below is the output from the most recent run. The user wants to discuss, investigate, or action these findings.\n\n' +
    '--- AUTOMATION OUTPUT ---\n' + output + '\n--- END AUTOMATION OUTPUT ---';

  var spawnArgs = buildSpawnArgs();
  spawnArgs.push('--append-system-prompt', context);
  addColumn(spawnArgs, null, spawnOpts({ title: automationName }));
});

document.getElementById('btn-automation-copy-output').addEventListener('click', function () {
  var outputEl = document.getElementById('automation-detail-output');
  var text = outputEl.textContent;
  if (!text) return;
  window.electronAPI.clipboardWriteText(text);
  var btn = this;
  btn.classList.add('copied');
  btn.textContent = 'Copied!';
  setTimeout(function () {
    btn.classList.remove('copied');
    btn.innerHTML = '&#128203;';
  }, 2000);
});

// --- Auto Update Notifications ---

(function setupUpdateNotifications() {
  var updateBar = document.getElementById('update-bar');
  var updateMessage = document.getElementById('update-message');
  var updateAction = document.getElementById('update-action');
  var updateDismiss = document.getElementById('update-dismiss');
  var updateNotesToggle = document.getElementById('update-notes-toggle');
  var updateNotesEl = document.getElementById('update-notes');

  var updateVersion = '';
  var updateReleaseNotes = '';

  function setReleaseNotes(notes) {
    updateReleaseNotes = notes || '';
    if (updateReleaseNotes) {
      updateNotesToggle.classList.remove('hidden');
    } else {
      updateNotesToggle.classList.add('hidden');
    }
  }

  window.electronAPI.onUpdateAvailable(function(info) {
    updateVersion = info.version;
    setReleaseNotes(info.releaseNotes);
    updateMessage.textContent = 'Downloading update v' + info.version + '...';
    updateAction.style.display = 'none';
    updateBar.classList.remove('hidden');
  });

  window.electronAPI.onUpdateProgress(function(info) {
    var pct = Math.round(info.percent);
    updateMessage.textContent = 'Downloading update v' + updateVersion + '... ' + pct + '%';
  });

  window.electronAPI.onUpdateDownloaded(function(info) {
    setReleaseNotes(info.releaseNotes);
    updateMessage.textContent = 'Update v' + info.version + ' ready to install';
    updateAction.style.display = '';
    updateBar.classList.remove('hidden');
  });

  window.electronAPI.onUpdateError(function(info) {
    updateMessage.textContent = 'Update failed: ' + (info.message || 'unknown error');
    updateAction.style.display = 'none';
    updateNotesToggle.classList.add('hidden');
    setTimeout(function() { updateBar.classList.add('hidden'); }, 8000);
  });

  updateNotesToggle.addEventListener('click', function () {
    if (updateNotesEl.classList.contains('hidden')) {
      // Release notes come from the GitHub release feed via electron-updater.
      // Render as text only — never as HTML — so a poisoned release (or any
      // future change to how the feed is fetched) can't inject script via
      // `<img onerror>`-style payloads in this Electron renderer.
      updateNotesEl.textContent = updateReleaseNotes || '';
      updateNotesEl.classList.remove('hidden');
      updateNotesToggle.textContent = 'Hide notes';
    } else {
      updateNotesEl.classList.add('hidden');
      updateNotesToggle.textContent = "What's new?";
    }
  });

  updateAction.addEventListener('click', function() {
    window.electronAPI.installUpdate();
  });

  updateDismiss.addEventListener('click', function() {
    updateBar.classList.add('hidden');
    updateNotesEl.classList.add('hidden');
  });

  // Dev-only: expose test function to simulate update notification
  // Usage in DevTools console: window.__testUpdate()
  window.__testUpdate = function () {
    setReleaseNotes('## What\'s new in v1.2.0\n\n- Theme dropdown with dark/light/auto OS sync\n- Column maximize/restore\n- Font size control (Ctrl+=/-)  \n- Notification settings\n- Toolbar menu reorganization\n- Scroll-to-bottom button');
    updateMessage.textContent = 'Update v1.2.0 ready to install';
    updateAction.style.display = '';
    updateBar.classList.remove('hidden');
  };
})();

// ============================================================
// Sticky Notes
// ============================================================
(function setupStickyNotes() {
  var container = document.getElementById('sticky-notes-container');
  var columnsContainerEl = document.getElementById('columns-container');
  var btn = document.getElementById('btn-sticky-notes');
  if (!container || !columnsContainerEl || !btn) return;

  var STICKY_COLORS = ['yellow', 'pink', 'green', 'blue', 'purple', 'gray'];
  var DEFAULT_COLOR = 'yellow';
  var DEFAULT_FONT_SIZE = 15;
  var FONT_MIN = 10;
  var FONT_MAX = 24;
  var MIN_W = 120;
  var MIN_H = 80;
  var HEADER_VISIBLE = 24; // px of header that must stay within columns-container

  var notesByProject = new Map();   // storeKey (stateKey) -> notes[]
  var loadedProjects = new Set();   // storeKeys we've already fetched from disk
  var loadingProjects = new Map();  // storeKey -> Promise (in-flight load)
  var openPopoverNoteId = null;
  var noteIsDragging = false;       // true while a drag or resize gesture is in progress

  function genId() {
    return 'note_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
  }

  // personal-only: sticky-notes now track a (projectPath, workspaceId) pair so
  // each workspace has its own overlay. Internal Map keys are the composite
  // stateKey; each save/load IPC passes the two components separately so main
  // can derive the on-disk filename.
  function currentStickyKey() {
    if (typeof activeProjectKey !== 'string' || !activeProjectKey) return null;
    var proj = (typeof config !== 'undefined' && config.projects) ? config.projects[config.activeProjectIndex] : null;
    var wsId = (proj && proj.activeWorkspaceId != null) ? proj.activeWorkspaceId : null;
    var store = (typeof stateKey === 'function') ? stateKey(activeProjectKey, wsId) : activeProjectKey;
    return { projectPath: activeProjectKey, workspaceId: wsId, store: store };
  }

  // Retained as an alias so any existing call sites keep working — returns
  // the composite store key (string) rather than the bare projectPath.
  function currentProjectKey() {
    var k = currentStickyKey();
    return k ? k.store : null;
  }

  function getNotes(storeKey) {
    if (!storeKey) return [];
    var arr = notesByProject.get(storeKey);
    if (!arr) {
      arr = [];
      notesByProject.set(storeKey, arr);
    }
    return arr;
  }

  function save(storeKey) {
    if (!storeKey) return;
    if (!window.electronAPI || !window.electronAPI.saveStickyNotes) return;
    var notes = getNotes(storeKey);
    var k = currentStickyKey();
    if (!k || k.store !== storeKey) {
      // Project/workspace switched between change and flush — re-decompose from storeKey.
      var sep = storeKey.indexOf('::');
      var p = (sep < 0) ? storeKey : storeKey.slice(0, sep);
      var w = (sep < 0) ? null : storeKey.slice(sep + 2);
      window.electronAPI.saveStickyNotes(p, w, notes);
      return;
    }
    window.electronAPI.saveStickyNotes(k.projectPath, k.workspaceId, notes);
  }

  function ensureLoaded(storeKey) {
    if (!storeKey) return Promise.resolve([]);
    if (loadedProjects.has(storeKey)) return Promise.resolve(getNotes(storeKey));
    if (loadingProjects.has(storeKey)) return loadingProjects.get(storeKey);
    if (!window.electronAPI || !window.electronAPI.loadStickyNotes) {
      loadedProjects.add(storeKey);
      return Promise.resolve([]);
    }
    // Decompose storeKey → (projectPath, workspaceId) for the IPC call.
    var sep = storeKey.indexOf('::');
    var projPath = (sep < 0) ? storeKey : storeKey.slice(0, sep);
    var wsId = (sep < 0) ? null : storeKey.slice(sep + 2);
    var p = window.electronAPI.loadStickyNotes(projPath, wsId).then(function (notes) {
      var arr = Array.isArray(notes) ? notes.slice() : [];
      // Normalize defaults defensively (main.js also defaults them, but belt-and-braces).
      for (var i = 0; i < arr.length; i++) {
        if (!arr[i].id) arr[i].id = genId();
        if (typeof arr[i].content !== 'string') arr[i].content = '';
        if (typeof arr[i].x !== 'number') arr[i].x = 20;
        if (typeof arr[i].y !== 'number') arr[i].y = 20;
        if (typeof arr[i].width !== 'number') arr[i].width = 240;
        if (typeof arr[i].height !== 'number') arr[i].height = 180;
        if (STICKY_COLORS.indexOf(arr[i].color) < 0) arr[i].color = DEFAULT_COLOR;
        if (typeof arr[i].fontSize !== 'number') arr[i].fontSize = DEFAULT_FONT_SIZE;
      }
      notesByProject.set(storeKey, arr);
      loadedProjects.add(storeKey);
      loadingProjects.delete(storeKey);
      return arr;
    }).catch(function (err) {
      console.error('loadStickyNotes failed:', err);
      notesByProject.set(storeKey, []);
      loadedProjects.add(storeKey);
      loadingProjects.delete(storeKey);
      return [];
    });
    loadingProjects.set(storeKey, p);
    return p;
  }

  function clampPosition(note) {
    var rect = columnsContainerEl.getBoundingClientRect();
    var maxX = Math.max(0, rect.width - HEADER_VISIBLE);
    var minX = -(note.width - HEADER_VISIBLE);
    var maxY = Math.max(0, rect.height - HEADER_VISIBLE);
    var minY = 0; // keep above top edge of columns-container (toolbar stays clear)
    if (note.x > maxX) note.x = maxX;
    if (note.x < minX) note.x = minX;
    if (note.y > maxY) note.y = maxY;
    if (note.y < minY) note.y = minY;
  }

  function applyNoteStyle(noteEl, note) {
    noteEl.style.left = note.x + 'px';
    noteEl.style.top = note.y + 'px';
    noteEl.style.width = note.width + 'px';
    noteEl.style.height = note.height + 'px';
    noteEl.style.fontSize = note.fontSize + 'px';
    noteEl.setAttribute('data-color', note.color);
  }

  function findColumnAtPoint(clientX, clientY) {
    var state = typeof getActiveState === 'function' ? getActiveState() : null;
    if (!state || !state.rows) return null;
    for (var rowIdx = 0; rowIdx < state.rows.length; rowIdx++) {
      var row = state.rows[rowIdx];
      if (!row || !row.columnIds) continue;
      for (var colIdx = 0; colIdx < row.columnIds.length; colIdx++) {
        var col = allColumns.get(row.columnIds[colIdx]);
        if (!col || !col.element) continue;
        var rect = col.element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (clientX >= rect.left && clientX <= rect.right &&
            clientY >= rect.top && clientY <= rect.bottom) {
          return { rowIdx: rowIdx, colIdx: colIdx, rect: rect };
        }
      }
    }
    return null;
  }

  function computeAbsolutePosition(note) {
    var containerRect = columnsContainerEl.getBoundingClientRect();
    var a = note.anchor;
    if (a && a.type === 'column') {
      var state = typeof getActiveState === 'function' ? getActiveState() : null;
      var row = state && state.rows ? state.rows[a.rowIdx] : null;
      var colId = row && row.columnIds ? row.columnIds[a.colIdx] : undefined;
      var col = (typeof colId !== 'undefined') ? allColumns.get(colId) : null;
      if (col && col.element) {
        var rect = col.element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return {
            x: (rect.left - containerRect.left) + a.ratioX * rect.width,
            y: (rect.top - containerRect.top) + a.ratioY * rect.height
          };
        }
        // Column exists but has zero rect (transient layout) — hold position.
        return { x: note.x, y: note.y };
      }
      // Column not found (killed / row removed): degrade to container anchor in-memory.
      var rx = containerRect.width > 0 ? (note.x / containerRect.width) : 0.05;
      var ry = containerRect.height > 0 ? (note.y / containerRect.height) : 0.05;
      note.anchor = { type: 'container', ratioX: rx, ratioY: ry };
      return {
        x: rx * containerRect.width,
        y: ry * containerRect.height
      };
    }
    if (a && a.type === 'container') {
      return {
        x: a.ratioX * containerRect.width,
        y: a.ratioY * containerRect.height
      };
    }
    return { x: note.x, y: note.y };
  }

  function createNoteElement(note) {
    var el = document.createElement('div');
    el.className = 'sticky-note';
    el.setAttribute('data-note-id', note.id);
    applyNoteStyle(el, note);

    var header = document.createElement('div');
    header.className = 'sticky-note-header';

    var settingsBtn = document.createElement('button');
    settingsBtn.className = 'sticky-note-settings';
    settingsBtn.title = 'Color and size';
    settingsBtn.innerHTML = '&#9881;';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'sticky-note-close';
    closeBtn.title = 'Delete';
    closeBtn.innerHTML = '&times;';

    header.appendChild(settingsBtn);
    header.appendChild(closeBtn);

    var body = document.createElement('textarea');
    body.className = 'sticky-note-body';
    body.setAttribute('spellcheck', 'false');
    body.value = note.content || '';

    el.appendChild(header);
    el.appendChild(body);

    var dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (var i = 0; i < dirs.length; i++) {
      var h = document.createElement('div');
      h.className = 'sticky-note-resize ' + dirs[i];
      h.setAttribute('data-dir', dirs[i]);
      el.appendChild(h);
    }

    var popover = buildPopover(note);
    el.appendChild(popover);

    wireNote(el, note, header, settingsBtn, closeBtn, body, popover);
    return el;
  }

  function buildPopover(note) {
    var pop = document.createElement('div');
    pop.className = 'sticky-note-popover';

    var swatches = document.createElement('div');
    swatches.className = 'sticky-note-swatches';
    for (var i = 0; i < STICKY_COLORS.length; i++) {
      var c = STICKY_COLORS[i];
      var sw = document.createElement('button');
      sw.className = 'sticky-swatch' + (note.color === c ? ' selected' : '');
      sw.setAttribute('data-color', c);
      sw.setAttribute('aria-label', c.charAt(0).toUpperCase() + c.slice(1));
      swatches.appendChild(sw);
    }

    var fs = document.createElement('div');
    fs.className = 'sticky-note-fontsize';
    var dec = document.createElement('button');
    dec.className = 'sticky-font-dec';
    dec.title = 'Smaller';
    dec.innerHTML = '&minus;';
    var val = document.createElement('span');
    val.className = 'sticky-font-value';
    val.textContent = note.fontSize + 'px';
    var inc = document.createElement('button');
    inc.className = 'sticky-font-inc';
    inc.title = 'Larger';
    inc.textContent = '+';
    fs.appendChild(dec);
    fs.appendChild(val);
    fs.appendChild(inc);

    pop.appendChild(swatches);
    pop.appendChild(fs);
    return pop;
  }

  function closeAllPopovers() {
    var opens = container.querySelectorAll('.sticky-note-popover.open');
    for (var i = 0; i < opens.length; i++) opens[i].classList.remove('open');
    openPopoverNoteId = null;
  }

  function bringToFront(note) {
    var projectKey = currentProjectKey();
    if (!projectKey) return;
    var arr = getNotes(projectKey);
    var idx = arr.indexOf(note);
    if (idx < 0) return;
    if (idx === arr.length - 1) return; // already on top
    arr.splice(idx, 1);
    arr.push(note);
    var el = container.querySelector('.sticky-note[data-note-id="' + note.id + '"]');
    if (el) container.appendChild(el); // re-append moves to end of DOM (top of stack)
    save(projectKey);
  }

  function deleteNote(note) {
    var projectKey = currentProjectKey();
    if (!projectKey) return;
    var arr = getNotes(projectKey);
    var idx = arr.indexOf(note);
    if (idx < 0) return;
    arr.splice(idx, 1);
    var el = container.querySelector('.sticky-note[data-note-id="' + note.id + '"]');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    if (openPopoverNoteId === note.id) openPopoverNoteId = null;
    save(projectKey);
  }

  function wireNote(el, note, header, settingsBtn, closeBtn, body, popover) {
    // Bring-to-front on any mousedown inside the note (except the gear/close buttons —
    // they still bring to front, but drag bail-early needs to happen first).
    el.addEventListener('mousedown', function () {
      bringToFront(note);
    });

    // Textarea input → update + save.
    body.addEventListener('input', function () {
      note.content = body.value;
      var projectKey = currentProjectKey();
      if (projectKey) save(projectKey);
    });

    // Drag on header.
    header.addEventListener('mousedown', function (e) {
      if (e.target.closest('.sticky-note-settings, .sticky-note-close')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      var startX = e.clientX;
      var startY = e.clientY;
      var startLeft = note.x;
      var startTop = note.y;
      noteIsDragging = true;
      document.body.style.userSelect = 'none';
      function move(ev) {
        note.x = startLeft + (ev.clientX - startX);
        note.y = startTop + (ev.clientY - startY);
        clampPosition(note);
        el.style.left = note.x + 'px';
        el.style.top = note.y + 'px';
      }
      function up(ev) {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.userSelect = '';
        noteIsDragging = false;
        var cR = columnsContainerEl.getBoundingClientRect();
        var hit = findColumnAtPoint(ev.clientX, ev.clientY);
        if (hit) {
          note.anchor = {
            type: 'column',
            rowIdx: hit.rowIdx,
            colIdx: hit.colIdx,
            ratioX: (ev.clientX - hit.rect.left) / hit.rect.width,
            ratioY: (ev.clientY - hit.rect.top) / hit.rect.height
          };
        } else {
          note.anchor = {
            type: 'container',
            ratioX: cR.width > 0 ? (ev.clientX - cR.left) / cR.width : 0,
            ratioY: cR.height > 0 ? (ev.clientY - cR.top) / cR.height : 0
          };
        }
        note.x = parseFloat(el.style.left) || 0;
        note.y = parseFloat(el.style.top) || 0;
        var projectKey = currentProjectKey();
        if (projectKey) save(projectKey);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    // Resize on each handle.
    var handles = el.querySelectorAll('.sticky-note-resize');
    for (var i = 0; i < handles.length; i++) {
      (function (handle) {
        handle.addEventListener('mousedown', function (e) {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          var dir = handle.getAttribute('data-dir');
          var startX = e.clientX;
          var startY = e.clientY;
          var startLeft = note.x;
          var startTop = note.y;
          var startWidth = note.width;
          var startHeight = note.height;
          noteIsDragging = true;
          document.body.style.userSelect = 'none';
          function move(ev) {
            var dx = ev.clientX - startX;
            var dy = ev.clientY - startY;
            var newX = startLeft, newY = startTop, newW = startWidth, newH = startHeight;
            if (dir.indexOf('e') >= 0) newW = Math.max(MIN_W, startWidth + dx);
            if (dir.indexOf('w') >= 0) {
              newW = Math.max(MIN_W, startWidth - dx);
              newX = startLeft + (startWidth - newW);
            }
            if (dir.indexOf('s') >= 0) newH = Math.max(MIN_H, startHeight + dy);
            if (dir.indexOf('n') >= 0) {
              newH = Math.max(MIN_H, startHeight - dy);
              newY = startTop + (startHeight - newH);
            }
            note.x = newX; note.y = newY; note.width = newW; note.height = newH;
            clampPosition(note);
            applyNoteStyle(el, note);
          }
          function up() {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.body.style.userSelect = '';
            noteIsDragging = false;
            var elRect = el.getBoundingClientRect();
            var cR = columnsContainerEl.getBoundingClientRect();
            var hit = findColumnAtPoint(elRect.left, elRect.top);
            if (hit) {
              note.anchor = {
                type: 'column',
                rowIdx: hit.rowIdx,
                colIdx: hit.colIdx,
                ratioX: (elRect.left - hit.rect.left) / hit.rect.width,
                ratioY: (elRect.top - hit.rect.top) / hit.rect.height
              };
            } else {
              note.anchor = {
                type: 'container',
                ratioX: cR.width > 0 ? (elRect.left - cR.left) / cR.width : 0,
                ratioY: cR.height > 0 ? (elRect.top - cR.top) / cR.height : 0
              };
            }
            note.x = parseFloat(el.style.left) || 0;
            note.y = parseFloat(el.style.top) || 0;
            var projectKey = currentProjectKey();
            if (projectKey) save(projectKey);
          }
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', up);
        });
      })(handles[i]);
    }

    // Close button.
    closeBtn.addEventListener('mousedown', function (e) {
      e.stopPropagation();
    });
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      deleteNote(note);
    });

    // Settings button opens popover.
    settingsBtn.addEventListener('mousedown', function (e) {
      e.stopPropagation();
    });
    settingsBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var wasOpen = popover.classList.contains('open');
      closeAllPopovers();
      if (!wasOpen) {
        popover.classList.add('open');
        openPopoverNoteId = note.id;
        // Refresh the selected swatch marker in case color changed elsewhere.
        var swatches = popover.querySelectorAll('.sticky-swatch');
        for (var i = 0; i < swatches.length; i++) {
          swatches[i].classList.toggle('selected', swatches[i].getAttribute('data-color') === note.color);
        }
        var val = popover.querySelector('.sticky-font-value');
        if (val) val.textContent = note.fontSize + 'px';
      }
    });

    // Popover swatches.
    var swatches = popover.querySelectorAll('.sticky-swatch');
    for (var j = 0; j < swatches.length; j++) {
      (function (sw) {
        sw.addEventListener('mousedown', function (e) { e.stopPropagation(); });
        sw.addEventListener('click', function (e) {
          e.stopPropagation();
          var c = sw.getAttribute('data-color');
          if (!c || STICKY_COLORS.indexOf(c) < 0) return;
          note.color = c;
          el.setAttribute('data-color', c);
          var others = popover.querySelectorAll('.sticky-swatch');
          for (var k = 0; k < others.length; k++) {
            others[k].classList.toggle('selected', others[k].getAttribute('data-color') === c);
          }
          var projectKey = currentProjectKey();
          if (projectKey) save(projectKey);
        });
      })(swatches[j]);
    }

    // Font size +/-.
    var decBtn = popover.querySelector('.sticky-font-dec');
    var incBtn = popover.querySelector('.sticky-font-inc');
    var valEl = popover.querySelector('.sticky-font-value');
    function bumpFont(delta) {
      var next = note.fontSize + delta;
      if (next < FONT_MIN) next = FONT_MIN;
      if (next > FONT_MAX) next = FONT_MAX;
      if (next === note.fontSize) return;
      note.fontSize = next;
      el.style.fontSize = next + 'px';
      if (valEl) valEl.textContent = next + 'px';
      var projectKey = currentProjectKey();
      if (projectKey) save(projectKey);
    }
    if (decBtn) {
      decBtn.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      decBtn.addEventListener('click', function (e) { e.stopPropagation(); bumpFont(-1); });
    }
    if (incBtn) {
      incBtn.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      incBtn.addEventListener('click', function (e) { e.stopPropagation(); bumpFont(1); });
    }
  }

  // Resolve the column id a note's anchor targets in the given state, or null
  // if the anchor doesn't resolve to a live column (container-anchored, missing
  // row/column, or unknown anchor type).
  function resolveAnchorColId(note, state) {
    if (!note || !note.anchor || !state || !state.rows) return null;
    var a = note.anchor;
    if (a.type !== 'column') return null;
    var row = state.rows[a.rowIdx];
    if (!row || !row.columnIds) return null;
    var colId = row.columnIds[a.colIdx];
    return (typeof colId === 'undefined') ? null : colId;
  }

  // While a column is maximized, hide every sticky note whose anchor doesn't
  // resolve to that column. On restore (maximizedColumnId === null), unhide
  // every note.
  function applyMaximizeVisibility() {
    var projectKey = currentProjectKey();
    if (!projectKey) return;
    var notes = getNotes(projectKey);
    var state = typeof getActiveState === 'function' ? getActiveState() : null;
    for (var i = 0; i < notes.length; i++) {
      var note = notes[i];
      var el = container.querySelector('.sticky-note[data-note-id="' + note.id + '"]');
      if (!el) continue;
      if (maximizedColumnId === null) {
        el.classList.remove('sticky-note--hidden-by-maximize');
      } else {
        var colId = resolveAnchorColId(note, state);
        if (colId === maximizedColumnId) {
          el.classList.remove('sticky-note--hidden-by-maximize');
        } else {
          el.classList.add('sticky-note--hidden-by-maximize');
        }
      }
    }
  }

  function renderForActiveProject() {
    while (container.firstChild) container.removeChild(container.firstChild);
    openPopoverNoteId = null;
    var projectKey = currentProjectKey();
    if (!projectKey) return;
    ensureLoaded(projectKey).then(function () {
      // Re-check in case project switched during the load.
      if (currentProjectKey() !== projectKey) return;
      while (container.firstChild) container.removeChild(container.firstChild);
      var notes = getNotes(projectKey);
      for (var i = 0; i < notes.length; i++) {
        var pos = computeAbsolutePosition(notes[i]);
        notes[i].x = pos.x;
        notes[i].y = pos.y;
        var el = createNoteElement(notes[i]);
        container.appendChild(el);
      }
      applyMaximizeVisibility();
    });
  }

  function repositionStickyNotesForActiveProject() {
    if (noteIsDragging) return;
    var projectKey = currentProjectKey();
    if (!projectKey) return;
    var notes = getNotes(projectKey);
    var els = container.querySelectorAll('.sticky-note[data-note-id]');
    for (var i = 0; i < els.length; i++) {
      var id = els[i].getAttribute('data-note-id');
      var note = null;
      for (var j = 0; j < notes.length; j++) {
        if (notes[j].id === id) { note = notes[j]; break; }
      }
      if (!note) continue;
      var pos = computeAbsolutePosition(note);
      els[i].style.left = pos.x + 'px';
      els[i].style.top = pos.y + 'px';
    }
    applyMaximizeVisibility();
  }

  function createNewNote() {
    var projectKey = currentProjectKey();
    if (!projectKey) return;
    ensureLoaded(projectKey).then(function () {
      if (currentProjectKey() !== projectKey) return;
      var arr = getNotes(projectKey);
      var state = typeof getActiveState === 'function' ? getActiveState() : null;

      // Determine target column for anchor.
      var rowIdx = -1, colIdx = -1;
      if (state && state.focusedColumnId !== null && typeof state.focusedColumnId !== 'undefined') {
        var focusedRow = findRowForColumn(state, state.focusedColumnId);
        if (focusedRow) {
          rowIdx = state.rows.indexOf(focusedRow);
          colIdx = focusedRow.columnIds.indexOf(state.focusedColumnId);
        }
      }
      if (rowIdx < 0 && state && state.rows) {
        for (var r = 0; r < state.rows.length; r++) {
          if (state.rows[r] && state.rows[r].columnIds && state.rows[r].columnIds.length > 0) {
            rowIdx = r;
            colIdx = 0;
            break;
          }
        }
      }

      // Stagger against existing notes sharing the same anchor.
      var staggerCount = 0;
      for (var k = 0; k < arr.length; k++) {
        var aa = arr[k].anchor;
        if (rowIdx >= 0) {
          if (aa && aa.type === 'column' && aa.rowIdx === rowIdx && aa.colIdx === colIdx) staggerCount++;
        } else {
          if (!aa || aa.type === 'container') staggerCount++;
        }
      }
      var stagger = staggerCount % 10;
      var ratio = 0.05 + stagger * 0.02;

      var anchor;
      if (rowIdx >= 0) {
        anchor = { type: 'column', rowIdx: rowIdx, colIdx: colIdx, ratioX: ratio, ratioY: ratio };
      } else {
        anchor = { type: 'container', ratioX: ratio, ratioY: ratio };
      }

      var note = {
        id: genId(),
        content: '',
        x: 20,
        y: 20,
        width: 240,
        height: 180,
        color: DEFAULT_COLOR,
        fontSize: DEFAULT_FONT_SIZE,
        anchor: anchor
      };
      arr.push(note);
      var el = createNoteElement(note);
      container.appendChild(el);
      var pos = computeAbsolutePosition(note);
      note.x = pos.x;
      note.y = pos.y;
      el.style.left = note.x + 'px';
      el.style.top = note.y + 'px';
      save(projectKey);
      applyMaximizeVisibility();
    });
  }

  btn.addEventListener('click', createNewNote);

  // Document-level dismiss for the open popover. Registered once at init.
  // Exempts both .sticky-note-popover (clicks inside the popover) and
  // .sticky-note-settings (the gear's own click handler opens/closes it; we
  // don't want the document listener to also fire and immediately re-close).
  document.addEventListener('mousedown', function (e) {
    if (!openPopoverNoteId) return;
    if (e.target.closest('.sticky-note-popover, .sticky-note-settings')) return;
    closeAllPopovers();
  });

  // Expose the render hook so setActiveProject can call it.
  window.__renderStickyNotesForActiveProject = renderForActiveProject;
  window.__repositionStickyNotesForActiveProject = repositionStickyNotesForActiveProject;
  window.__stickyNotesApplyMaximizeVisibility = applyMaximizeVisibility;

  // Initial render in case setActiveProject already fired before this IIFE executed.
  renderForActiveProject();
})();

(function setupBroadcast() {
  var btn = document.getElementById('btn-broadcast');
  var popover = document.getElementById('broadcast-popover');
  var closeBtn = document.getElementById('broadcast-close');
  var sendBtn = document.getElementById('broadcast-send');
  var textEl = document.getElementById('broadcast-text');
  var targetsEl = document.getElementById('broadcast-targets');
  var pressEnterEl = document.getElementById('broadcast-press-enter');
  if (!btn || !popover) return;

  function refreshTargets() {
    targetsEl.innerHTML = '';
    var ordinalByProject = new Map();  // projectKey -> running count
    var any = false;
    allColumns.forEach(function (c, id) {
      if (c.cmd) return;       // skip custom-command columns
      if (c.isDiff) return;    // skip diff columns
      any = true;
      var ord = (ordinalByProject.get(c.projectKey) || 0) + 1;
      ordinalByProject.set(c.projectKey, ord);
      var proj = (config && config.projects)
        ? config.projects.find(function (p) { return p.path === c.projectKey; })
        : null;
      var projName = (proj && proj.name)
        || (typeof projectKeyToName === 'function' ? projectKeyToName(c.projectKey) : c.projectKey);
      var label = document.createElement('label');
      label.className = 'broadcast-target';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.colId = id;
      cb.checked = true;
      var span = document.createElement('span');
      span.textContent = c.customTitle
        ? projName + ' — ' + c.customTitle
        : projName + ' — Claude #' + ord;
      label.appendChild(cb);
      label.appendChild(span);
      targetsEl.appendChild(label);
    });
    if (!any) {
      var empty = document.createElement('div');
      empty.className = 'broadcast-target';
      empty.style.opacity = '0.6';
      empty.textContent = 'No Claude columns open.';
      targetsEl.appendChild(empty);
    }
  }

  btn.addEventListener('click', function () {
    refreshTargets();
    popover.classList.remove('hidden');
    // Blur all xterm terminals so they release keyboard capture; the textarea
    // can then receive keystrokes without needing an OS-level focus bounce.
    allColumns.forEach(function (c) {
      if (c.terminal && typeof c.terminal.blur === 'function') c.terminal.blur();
    });
    setTimeout(function () { textEl.focus(); }, 0);
  });
  closeBtn.addEventListener('click', function () {
    popover.classList.add('hidden');
    if (typeof refocusActiveTerminal === 'function') refocusActiveTerminal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !popover.classList.contains('hidden')) {
      popover.classList.add('hidden');
      if (typeof refocusActiveTerminal === 'function') refocusActiveTerminal();
    }
  });

  sendBtn.addEventListener('click', function () {
    var text = textEl.value;
    if (!text) return;
    var checks = targetsEl.querySelectorAll('input[type=checkbox]:checked');
    var pressEnter = pressEnterEl.checked;
    checks.forEach(function (cb) {
      var id = parseInt(cb.dataset.colId, 10);
      var col = allColumns.get(id);
      if (!col) return;
      wsSend({ type: 'write', id: id, data: text + (pressEnter ? '\r' : '') });
    });
    popover.classList.add('hidden');
    if (typeof refocusActiveTerminal === 'function') refocusActiveTerminal();
    textEl.value = '';
  });
})();

(function setupSessionSearch() {
  var btn = document.getElementById('btn-session-search');
  var modal = document.getElementById('session-search-modal');
  var closeBtn = document.getElementById('session-search-close');
  var input = document.getElementById('session-search-input');
  var resultsEl = document.getElementById('session-search-results');
  if (!btn || !modal) return;

  function open() {
    modal.classList.remove('hidden');
    input.focus();
    input.select();
  }
  function close() { modal.classList.add('hidden'); }

  btn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  document.addEventListener('keydown', function (e) {
    if (cmdOrCtrl(e) && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); open(); }
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }

  function highlight(text, q) {
    var safe = escapeHtml(text);
    var idx = safe.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return safe;
    return safe.slice(0, idx) + '<mark>' + safe.slice(idx, idx + q.length) + '</mark>' + safe.slice(idx + q.length);
  }

  var debounceTimer = null;
  input.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    var q = input.value.trim();
    if (q.length < 2) { resultsEl.innerHTML = ''; return; }
    debounceTimer = setTimeout(function () { runSearch(q); }, 200);
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || (t.name !== 'search-mode' && t.name !== 'search-scope')) return;
    var input2 = document.getElementById('session-search-input');
    if (!input2) return;
    var modeRadio = document.querySelector('input[name=search-mode]:checked');
    var scopeRadio = document.querySelector('input[name=search-scope]:checked');
    var mode = (modeRadio && modeRadio.value) || 'transcripts';
    var scope = (scopeRadio && scopeRadio.value) || 'all';
    var scopeLabel = (scope === 'current') ? 'current project' : 'all projects';
    if (mode === 'prompts') {
      input2.placeholder = 'Search your past prompts (' + scopeLabel + ')…';
    } else {
      input2.placeholder = 'Search session transcripts (' + scopeLabel + ')…';
    }
    var q = input2.value.trim();
    if (q.length >= 2) runSearch(q);
  });

  function runSearch(q) {
    resultsEl.innerHTML = '<div style="opacity:.6;font-size:12px">Searching…</div>';
    var modeRadio = document.querySelector('input[name=search-mode]:checked');
    var mode = (modeRadio && modeRadio.value) || 'transcripts';
    var scopeRadio = document.querySelector('input[name=search-scope]:checked');
    var scope = (scopeRadio && scopeRadio.value) || 'all';
    // Scope to the focused project's path when "current". When no project is
    // active, fall back to all-projects so the search still produces results.
    var scopedPath = (scope === 'current' && activeProjectKey) ? activeProjectKey : null;
    var apiCall;
    if (mode === 'prompts') {
      if (!window.electronAPI || !window.electronAPI.searchHistory) {
        resultsEl.innerHTML = '<div style="opacity:.6;font-size:12px">Search API not available.</div>';
        return;
      }
      apiCall = window.electronAPI.searchHistory(q, 100, scopedPath).then(function (hits) {
        // Normalize prompt hits to the same shape transcript hits use:
        // { projectKey, sessionId, snippet }. sessionId is empty for prompts —
        // openHit treats empty sessionId as "no resume; copy text instead".
        return (hits || []).map(function (h) {
          return {
            projectKey: h.project || '',
            sessionId: '',
            snippet: h.snippet || h.text || '',
            text: h.text || ''
          };
        });
      });
    } else {
      if (!window.electronAPI || !window.electronAPI.searchSessions) {
        resultsEl.innerHTML = '<div style="opacity:.6;font-size:12px">Search API not available.</div>';
        return;
      }
      apiCall = window.electronAPI.searchSessions(q, 50, scopedPath);
    }
    apiCall.then(function (hits) {
      resultsEl.innerHTML = '';
      if (!hits || !hits.length) {
        resultsEl.innerHTML = '<div style="opacity:.6;font-size:12px">No matches.</div>';
        return;
      }
      hits.forEach(function (h) {
        var div = document.createElement('div');
        div.className = 'session-search-hit';
        var meta = document.createElement('div');
        meta.className = 'session-search-hit-meta';
        var metaParts = [h.projectKey || ''];
        if (h.sessionId) metaParts.push(h.sessionId.slice(0, 8));
        meta.textContent = metaParts.filter(Boolean).join('  •  ');
        var snip = document.createElement('div');
        snip.className = 'session-search-hit-snippet';
        snip.innerHTML = highlight(h.snippet || '', q);
        div.appendChild(meta);
        div.appendChild(snip);
        div.addEventListener('click', function () { openHit(h); });
        resultsEl.appendChild(div);
      });
    }).catch(function () {
      resultsEl.innerHTML = '<div style="opacity:.6;font-size:12px">Search failed.</div>';
    });
  }

  function openHit(h) {
    if (!h.sessionId) {
      // Prompt-mode hit — copy the full prompt text to the clipboard.
      if (window.electronAPI && window.electronAPI.clipboardWriteText) {
        window.electronAPI.clipboardWriteText(h.text || h.snippet || '');
      }
      close();
      return;
    }
    if (!config || !config.projects) return;
    var idx = -1;
    for (var i = 0; i < config.projects.length; i++) {
      if (projectPathToKey(config.projects[i].path) === h.projectKey) { idx = i; break; }
    }
    if (idx < 0) {
      alert('That session\'s project is not in your project list. Add it first.');
      return;
    }
    setActiveProject(idx, false, true);
    addColumn(['--resume', h.sessionId], null, spawnOpts({ sessionId: h.sessionId }));
    close();
  }
})();

(function setupCostFilters() {
  var btns = document.querySelectorAll('.cost-filter-btn');
  if (!btns.length) return;
  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      btns.forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      if (window.electronAPI && window.electronAPI.getUsageCosts) {
        window.electronAPI.getUsageCosts(b.dataset.costFilter).then(renderCostTab).catch(function () {});
      }
    });
  });
})();

(function setupPalette() {
  var overlay = document.getElementById('palette-overlay');
  var input = document.getElementById('palette-input');
  var results = document.getElementById('palette-results');
  if (!overlay) return;

  var SLASH_COMMANDS = [
    '/help', '/clear', '/compact', '/cost', '/usage', '/model', '/agents',
    '/mcp', '/release', '/review', '/security-review', '/init'
  ];

  function buildCommands() {
    var cmds = [];
    if (config && config.projects) {
      config.projects.forEach(function (p) {
        cmds.push({
          label: 'Switch to ' + (p.name || projectKeyToName(p.path)),
          kind: 'project',
          run: function () { setActiveProject(config.projects.indexOf(p), false); }
        });
        cmds.push({
          label: 'Spawn in ' + (p.name || projectKeyToName(p.path)),
          kind: 'spawn',
          run: function () {
            setActiveProject(config.projects.indexOf(p), false, true);
            addColumn(null, null, spawnOpts());
          }
        });
      });
    }
    SLASH_COMMANDS.forEach(function (s) {
      cmds.push({
        label: s,
        kind: 'slash',
        run: function () {
          var st = getActiveState();
          if (st && st.focusedColumnId != null) {
            wsSend({ type: 'write', id: st.focusedColumnId, data: s + '\r' });
          }
        }
      });
    });
    cmds.push({ label: 'Open Usage', kind: 'action', run: openUsageModal });
    cmds.push({ label: 'Open snippet library', kind: 'action', run: function () {
      if (typeof window.openSnippetsManager === 'function') window.openSnippetsManager();
    }});
    cmds.push({ label: 'Add project…', kind: 'action', run: function () {
      var btn = document.getElementById('btn-add-project');
      if (btn) btn.click();
    }});
    cmds.push({ label: 'Toggle sidebar', kind: 'action', run: function () {
      var btn = document.getElementById('btn-toggle-sidebar');
      if (btn) btn.click();
    }});
    cmds.push({ label: 'Kill focused column', kind: 'action', run: function () {
      var st = getActiveState();
      if (st && st.focusedColumnId != null) removeColumn(st.focusedColumnId);
    }});
    cmds.push({ label: 'Respawn focused column', kind: 'action', run: function () {
      var st = getActiveState();
      if (st && st.focusedColumnId != null) restartColumn(st.focusedColumnId);
    }});
    return cmds;
  }

  var commands = [];
  var lastFiltered = [];
  var selectedIdx = 0;

  function open() {
    commands = buildCommands();
    lastFiltered = commands;
    selectedIdx = 0;
    overlay.classList.remove('hidden');
    input.value = '';
    // Blur active xterm so the input receives keystrokes immediately
    if (typeof allColumns !== 'undefined') {
      allColumns.forEach(function (c) {
        if (c.terminal && typeof c.terminal.blur === 'function') c.terminal.blur();
      });
    }
    setTimeout(function () { input.focus(); }, 0);
    render(lastFiltered);
  }
  function close() {
    overlay.classList.add('hidden');
    if (typeof refocusActiveTerminal === 'function') refocusActiveTerminal();
  }

  function render(list) {
    results.innerHTML = '';
    list.slice(0, 50).forEach(function (cmd, i) {
      var row = document.createElement('div');
      row.className = 'palette-row' + (i === selectedIdx ? ' active' : '');
      row.dataset.idx = String(i);
      var label = document.createElement('span');
      label.textContent = cmd.label;
      var kind = document.createElement('span');
      kind.className = 'palette-row-kind';
      kind.textContent = cmd.kind;
      row.appendChild(label);
      row.appendChild(kind);
      row.addEventListener('click', function () { runAt(i, list); });
      results.appendChild(row);
    });
  }

  function runAt(i, list) {
    var cmd = list[i];
    if (!cmd) return;
    close();
    try { cmd.run(); } catch (e) { console.error('palette command failed', e); }
  }

  // Register Cmd/Ctrl+K in capture phase so xterm can't swallow it.
  document.addEventListener('keydown', function (e) {
    if (cmdOrCtrl(e) && (e.key === 'k' || e.key === 'K') && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  }, true);

  // Navigation / dismissal handler — only acts when palette is open, so it can
  // stay in normal bubble phase and not interfere with anything else.
  document.addEventListener('keydown', function (e) {
    if (overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    var rendered = results.querySelectorAll('.palette-row');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(rendered.length - 1, selectedIdx + 1);
      updateActive(rendered);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(0, selectedIdx - 1);
      updateActive(rendered);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(selectedIdx, lastFiltered);
    }
  });

  function updateActive(rows) {
    rows.forEach(function (r, i) { r.classList.toggle('active', i === selectedIdx); });
    var active = rows[selectedIdx];
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  input.addEventListener('input', function () {
    var q = input.value;
    if (!window.electronAPI || !window.electronAPI.paletteRank) {
      lastFiltered = commands;
      selectedIdx = 0;
      render(lastFiltered);
      return;
    }
    window.electronAPI.paletteRank(commands.map(function (c) {
      return { label: c.label, kind: c.kind };
    }), q).then(function (rankedShallow) {
      // Map back to full commands by label::kind composite key
      var byLabel = new Map();
      commands.forEach(function (c) { byLabel.set(c.label + '::' + c.kind, c); });
      lastFiltered = rankedShallow.map(function (s) {
        return byLabel.get(s.label + '::' + s.kind);
      }).filter(Boolean);
      selectedIdx = 0;
      render(lastFiltered);
    }).catch(function () {
      lastFiltered = commands;
      selectedIdx = 0;
      render(lastFiltered);
    });
  });

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) close();
  });
})();

(function setupHooks() {
  var listEl = document.getElementById('hooks-list');
  var filterEl = document.getElementById('hooks-filter');
  var clearBtn = document.getElementById('hooks-clear');
  var pauseEl = document.getElementById('hooks-pause');
  if (!listEl) return;

  var MAX_EVENTS = 1000;  // ring buffer
  var hintEl = document.getElementById('hooks-empty-hint');
  var events = [];
  var filterQuery = '';
  var paused = false;

  function fmtTime(ts) {
    var d = new Date(ts);
    return d.toTimeString().slice(0, 8);
  }

  function summarize(input) {
    if (!input) return '';
    if (typeof input === 'string') return input.slice(0, 80);
    if (input.command) return String(input.command).slice(0, 80);
    if (input.file_path) return input.file_path;
    if (input.path) return input.path;
    if (input.pattern) return input.pattern;
    return '';
  }

  function normPath(p) {
    return typeof p === 'string' ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
  }

  function eventMatchesActiveProject(ev) {
    if (!activeProjectKey) return true;  // no project active — show everything
    var evCwd = normPath(ev.cwd);
    if (!evCwd) return false;  // no cwd on event — can't scope, hide
    return evCwd === normPath(activeProjectKey);
  }

  function eventMatchesFilter(ev) {
    if (!eventMatchesActiveProject(ev)) return false;
    if (!filterQuery) return true;
    var q = filterQuery.toLowerCase();
    var hay = (ev.event || '') + ' ' + (ev.tool_name || '') + ' ' + (ev.session_id || '') + ' ' + JSON.stringify(ev.tool_input || {});
    return hay.toLowerCase().indexOf(q) !== -1;
  }

  // Primary fields render full-width stacked (label above value).
  var HOOK_PRIMARY = [
    'last_assistant_message', 'tool_name', 'tool_input', 'tool_response', 'reason'
  ];
  // Metadata fields render as a compact 2-col grid at the bottom.
  var HOOK_META = [
    'hook_event_name', 'permission_mode', 'stop_hook_active', 'matcher',
    'cwd', 'transcript_path', 'session_id'
  ];
  // Pure noise — already represented in the collapsed row.
  var HOOK_FIELD_HIDE = { received_at: 1, event: 1 };

  function shortPath(p) {
    if (typeof p !== 'string') return p;
    if (p.length <= 64) return p;
    var parts = p.replace(/\\/g, '/').split('/');
    return '…/' + parts.slice(-3).join('/');
  }

  function prettyLabel(key) {
    return key.replace(/_/g, ' ');
  }

  function renderHookFieldValue(key, value) {
    var el = document.createElement('div');
    el.className = 'hook-field-value';
    if (value == null) { el.textContent = '(null)'; el.classList.add('muted'); return el; }
    if (typeof value === 'boolean' || typeof value === 'number') {
      el.textContent = String(value);
      el.classList.add('mono');
      return el;
    }
    if (typeof value === 'string') {
      if (key === 'transcript_path' || key === 'cwd') {
        el.textContent = shortPath(value);
        el.title = value;
        el.classList.add('mono', 'truncate');
        return el;
      }
      if (value.indexOf('\n') !== -1 || value.length > 80) {
        var pre = document.createElement('pre');
        pre.className = 'hook-message';
        pre.textContent = value;
        el.appendChild(pre);
        return el;
      }
      el.textContent = value;
      return el;
    }
    var pre2 = document.createElement('pre');
    pre2.className = 'hook-json';
    try { pre2.textContent = JSON.stringify(value, null, 2); }
    catch { pre2.textContent = String(value); }
    el.appendChild(pre2);
    return el;
  }

  function renderHookDetail(container, ev) {
    container.innerHTML = '';
    var seen = {};

    // Primary fields — stacked, full width.
    HOOK_PRIMARY.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(ev, k)) return;
      if (HOOK_FIELD_HIDE[k]) return;
      seen[k] = 1;
      var row = document.createElement('div');
      row.className = 'hook-field';
      var label = document.createElement('div');
      label.className = 'hook-field-label';
      label.textContent = prettyLabel(k);
      row.appendChild(label);
      row.appendChild(renderHookFieldValue(k, ev[k]));
      container.appendChild(row);
    });

    // Anything not declared primary/meta but present (custom fields) → primary.
    Object.keys(ev).forEach(function (k) {
      if (seen[k] || HOOK_FIELD_HIDE[k]) return;
      if (HOOK_META.indexOf(k) !== -1) return;
      seen[k] = 1;
      var row = document.createElement('div');
      row.className = 'hook-field';
      var label = document.createElement('div');
      label.className = 'hook-field-label';
      label.textContent = prettyLabel(k);
      row.appendChild(label);
      row.appendChild(renderHookFieldValue(k, ev[k]));
      container.appendChild(row);
    });

    // Meta — compact 2-col grid.
    var meta = null;
    HOOK_META.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(ev, k)) return;
      if (HOOK_FIELD_HIDE[k]) return;
      if (!meta) {
        meta = document.createElement('div');
        meta.className = 'hook-meta';
        container.appendChild(meta);
      }
      var lab = document.createElement('div');
      lab.className = 'hook-meta-label';
      lab.textContent = prettyLabel(k);
      var val = document.createElement('div');
      val.className = 'hook-meta-value';
      var v = ev[k];
      if (k === 'transcript_path' || k === 'cwd') {
        val.textContent = shortPath(typeof v === 'string' ? v : String(v));
        val.title = String(v);
        val.classList.add('truncate');
      } else if (k === 'session_id' && typeof v === 'string') {
        val.textContent = v.slice(0, 8) + '…';
        val.title = v;
      } else {
        val.textContent = String(v);
      }
      meta.appendChild(lab);
      meta.appendChild(val);
    });
  }

  function renderEvent(ev) {
    var row = document.createElement('div');
    row.className = 'hook-row';
    var time = document.createElement('span');
    time.className = 'hook-time';
    time.textContent = fmtTime(ev.received_at || Date.now());
    var name = document.createElement('span');
    name.className = 'hook-event';
    name.textContent = ev.event || '?';
    var tool = document.createElement('span');
    tool.className = 'hook-tool';
    tool.textContent = ev.tool_name || '';
    var summary = document.createElement('span');
    summary.textContent = ev.tool_input ? summarize(ev.tool_input) : (ev.session_id ? ev.session_id.slice(0, 8) : '');
    row.appendChild(time);
    row.appendChild(name);
    row.appendChild(tool);
    row.appendChild(summary);

    var detail = document.createElement('div');
    detail.className = 'hook-detail';
    detail.style.display = 'none';
    renderHookDetail(detail, ev);
    row.appendChild(detail);

    row.addEventListener('click', function () {
      row.classList.toggle('expanded');
      detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
    });
    return row;
  }

  function rerender() {
    listEl.innerHTML = '';
    events.filter(eventMatchesFilter).slice(-200).forEach(function (ev) {
      listEl.appendChild(renderEvent(ev));
    });
    listEl.scrollTop = listEl.scrollHeight;
  }

  // Re-scope the visible list when the user switches projects — same as
  // the Files / Git / Run / Automations tabs do.
  window.__rerenderHookList = rerender;

  filterEl.addEventListener('input', function () {
    filterQuery = filterEl.value.trim();
    rerender();
  });
  clearBtn.addEventListener('click', function () {
    events = [];
    rerender();
    if (hintEl) hintEl.classList.remove('hidden');
  });
  pauseEl.addEventListener('change', function () { paused = pauseEl.checked; });

  if (window.electronAPI && window.electronAPI.onHookEvent) {
    window.electronAPI.onHookEvent(function (ev) {
      if (paused) return;
      ev.received_at = Date.now();
      events.push(ev);
      if (events.length > MAX_EVENTS) events.shift();
      if (hintEl && !hintEl.classList.contains('hidden')) hintEl.classList.add('hidden');
      // Append-only when the new event passes the current filter
      if (eventMatchesFilter(ev)) {
        var row = renderEvent(ev);
        listEl.appendChild(row);
        // Trim DOM to last 200 to keep things responsive
        while (listEl.children.length > 200) listEl.removeChild(listEl.firstChild);
        listEl.scrollTop = listEl.scrollHeight;
      }
    });
  }

  // Hooks auto-config wiring
  var connectBtn = document.getElementById('btn-hooks-connect');
  var disconnectBtn = document.getElementById('btn-hooks-disconnect');
  var statusEl = document.getElementById('hooks-config-status');

  function refreshConfigState() {
    if (!window.electronAPI || !window.electronAPI.isHooksConfigured) return;
    window.electronAPI.isHooksConfigured().then(function (configured) {
      if (configured) {
        if (connectBtn) connectBtn.classList.add('hidden');
        if (disconnectBtn) disconnectBtn.classList.remove('hidden');
        if (statusEl) {
          statusEl.textContent = 'Connected. Restart any open Claude sessions to start receiving events.';
          statusEl.classList.remove('error');
          statusEl.classList.add('ok');
        }
      } else {
        if (connectBtn) connectBtn.classList.remove('hidden');
        if (disconnectBtn) disconnectBtn.classList.add('hidden');
        if (statusEl) {
          statusEl.textContent = '';
          statusEl.classList.remove('ok', 'error');
        }
      }
    }).catch(function () {});
  }

  if (connectBtn) connectBtn.addEventListener('click', function () {
    if (!window.electronAPI || !window.electronAPI.configureHooks) return;
    if (statusEl) {
      statusEl.textContent = 'Configuring…';
      statusEl.classList.remove('ok', 'error');
    }
    window.electronAPI.configureHooks().then(function (result) {
      if (result && result.ok) {
        refreshConfigState();
      } else {
        if (statusEl) {
          statusEl.textContent = (result && result.error) ? ('Failed: ' + result.error) : 'Failed to configure hooks.';
          statusEl.classList.add('error');
        }
      }
    });
  });

  if (disconnectBtn) disconnectBtn.addEventListener('click', function () {
    if (!window.electronAPI || !window.electronAPI.disconnectHooks) return;
    if (!confirm('Remove Claudes hook entries from your ~/.claude/settings.json?')) return;
    window.electronAPI.disconnectHooks().then(function (result) {
      if (result && result.ok) {
        refreshConfigState();
      } else {
        if (statusEl) {
          statusEl.textContent = (result && result.error) ? ('Failed: ' + result.error) : 'Failed to disconnect.';
          statusEl.classList.add('error');
        }
      }
    });
  });

  // Initial check
  refreshConfigState();
})();

(function setupSnippets() {
  var btn = document.getElementById('btn-snippets');
  var modal = document.getElementById('snippets-modal');
  var closeBtn = document.getElementById('snippets-close');
  var newBtn = document.getElementById('snippets-new');
  var listEl = document.getElementById('snippets-list');
  var trigEl = document.getElementById('snippet-trigger');
  var labelEl = document.getElementById('snippet-label');
  var bodyEl = document.getElementById('snippet-body');
  var saveBtn = document.getElementById('snippet-save');
  var delBtn = document.getElementById('snippet-delete');
  if (!modal) return;

  var snippets = [];
  var editing = null;

  function open() { modal.classList.remove('hidden'); refresh(); }
  function close() {
    modal.classList.add('hidden');
    if (typeof refocusActiveTerminal === 'function') refocusActiveTerminal();
  }

  if (closeBtn) closeBtn.addEventListener('click', close);
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });

  function refresh() {
    if (!window.electronAPI || !window.electronAPI.listSnippets) return Promise.resolve();
    return window.electronAPI.listSnippets().then(function (list) {
      snippets = list || [];
      renderList();
      // Update the in-memory cache used by trigger expansion (Task 3.3)
      window.__snippetsCache = snippets;
      if (editing) {
        var match = snippets.find(function (s) { return s.id === editing.id; });
        if (match) editing = match;
        else editing = snippets.length ? snippets[0] : { trigger: '', label: '', body: '' };
      } else if (snippets.length) {
        editing = snippets[0];
      } else {
        editing = { trigger: '', label: '', body: '' };
      }
      paintEdit(editing);
    });
  }

  function renderList() {
    listEl.innerHTML = '';
    snippets.forEach(function (s) {
      var d = document.createElement('div');
      d.className = 'snippet-item' + (editing && editing.id === s.id ? ' active' : '');
      var name = document.createElement('div');
      name.textContent = s.label || '(unnamed)';
      var trig = document.createElement('div');
      trig.className = 'snippet-item-trigger';
      trig.textContent = '\\' + (s.trigger || '');
      d.appendChild(name);
      d.appendChild(trig);
      d.addEventListener('click', function () { editing = s; paintEdit(s); renderList(); });
      listEl.appendChild(d);
    });
  }

  function paintEdit(s) {
    trigEl.value = s.trigger || '';
    labelEl.value = s.label || '';
    bodyEl.value = s.body || '';
  }

  if (newBtn) newBtn.addEventListener('click', function () {
    editing = { trigger: '', label: '', body: '' };
    paintEdit(editing);
    renderList();
    trigEl.focus();
  });

  if (saveBtn) saveBtn.addEventListener('click', function () {
    var snip = Object.assign({}, editing, {
      trigger: trigEl.value.trim(),
      label: labelEl.value.trim(),
      body: bodyEl.value
    });
    if (!snip.trigger) { alert('Trigger required'); return; }
    if (!window.electronAPI || !window.electronAPI.saveSnippet) return;
    window.electronAPI.saveSnippet(snip).then(function (saved) {
      editing = saved;
      refresh();
    });
  });

  if (delBtn) delBtn.addEventListener('click', function () {
    if (!editing || !editing.id) return;
    if (!confirm('Delete snippet "' + (editing.label || editing.trigger) + '"?')) return;
    if (!window.electronAPI || !window.electronAPI.deleteSnippet) return;
    window.electronAPI.deleteSnippet(editing.id).then(function () {
      editing = null;
      refresh();
    });
  });

  if (btn) btn.addEventListener('click', open);

  // Expose for the palette command (Task 1.2's setupPalette IIFE) and for
  // the trigger expansion layer (Task 3.3) to refresh the in-memory cache.
  window.openSnippetsManager = open;
  window.refreshSnippetsCache = refresh;

  // Pre-warm the cache so trigger expansion works immediately on app start
  refresh();
})();

(function setupExtensionsManager() {
  var modal = document.getElementById('ext-modal');
  if (!modal) return;
  var closeBtn = document.getElementById('ext-close');
  var pathLabel = document.getElementById('ext-project-path');
  var currentProject = null;

  function refresh() {
    if (!currentProject || !window.electronAPI || !window.electronAPI.listExtensions) return;
    window.electronAPI.listExtensions(currentProject).then(function (data) {
      ['agents', 'skills', 'commands'].forEach(function (cat) {
        var list = modal.querySelector('[data-cat-list="' + cat + '"]');
        if (!list) return;
        list.innerHTML = '';
        var items = data[cat] || [];
        if (items.length === 0) {
          var none = document.createElement('div');
          none.className = 'settings-hint';
          none.style.padding = '8px';
          none.textContent = 'None yet.';
          list.appendChild(none);
          return;
        }
        items.forEach(function (it) {
          var row = document.createElement('div');
          row.className = 'ext-row';
          var label = document.createElement('span');
          label.textContent = it.name;
          var scope = document.createElement('span');
          scope.className = 'ext-scope ext-scope-' + it.scope;
          scope.textContent = it.scope;
          var openBtn = document.createElement('button');
          openBtn.className = 'settings-browse-btn';
          openBtn.style.padding = '2px 8px';
          openBtn.textContent = 'Edit';
          openBtn.addEventListener('click', function () {
            modal.classList.add('hidden');
            openFileEditor(it.path);
          });
          var delBtn = document.createElement('button');
          delBtn.className = 'settings-browse-btn';
          delBtn.style.padding = '2px 8px';
          delBtn.style.color = '#f87171';
          delBtn.textContent = '×';
          delBtn.addEventListener('click', function () {
            if (!confirm('Delete ' + it.name + ' (' + it.scope + ')?')) return;
            window.electronAPI.deleteExtension(it.path).then(function (r) {
              if (!r || !r.ok) alert('Delete failed: ' + (r && r.error || 'unknown'));
              refresh();
            });
          });
          row.appendChild(label);
          row.appendChild(scope);
          row.appendChild(openBtn);
          row.appendChild(delBtn);
          list.appendChild(row);
        });
      });
    });
  }

  modal.querySelectorAll('.ext-new').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var cat = btn.dataset.cat;
      // Scope picker via inline confirmDialog (Cancel = global, OK = project).
      confirmDialog(
        'Create in PROJECT scope?\n\n' +
        'OK = .claude/' + cat + '/  (this project only)\n' +
        'Cancel = ~/.claude/' + cat + '/  (global, all projects)',
        { okLabel: 'Project', cancelLabel: 'Global' }
      ).then(function (isProject) {
        var scope = isProject ? 'project' : 'global';
        promptForValue('Name for new ' + cat.slice(0, -1) + ' (alphanumeric, _ . - allowed):').then(function (name) {
          if (!name) return;
          window.electronAPI.createExtension(currentProject, cat, name.trim(), scope).then(function (r) {
            if (!r || !r.ok) { showToast('Create failed: ' + (r && r.error || 'unknown'), { kind: 'error' }); return; }
            refresh();
            modal.classList.add('hidden');
            openFileEditor(r.path);
            showToast('Created ' + cat.slice(0, -1) + ' "' + name + '" (' + scope + ')', { kind: 'success' });
          });
        });
      });
    });
  });

  if (closeBtn) closeBtn.addEventListener('click', function () { modal.classList.add('hidden'); });
  modal.addEventListener('click', function (e) { if (e.target === modal) modal.classList.add('hidden'); });

  window.openExtensionsModal = function (projPath) {
    currentProject = projPath || null;
    pathLabel.textContent = projPath ? (projPath + ' + ~/.claude/') : '~/.claude/';
    modal.classList.remove('hidden');
    refresh();
  };
})();

(function setupMcpManager() {
  var modal = document.getElementById('mcp-modal');
  if (!modal) return;
  var listEl = document.getElementById('mcp-list');
  var emptyEl = document.getElementById('mcp-empty');
  var formEl = document.getElementById('mcp-form');
  var nameEl = document.getElementById('mcp-name');
  var cmdEl = document.getElementById('mcp-command');
  var argsEl = document.getElementById('mcp-args');
  var envEl = document.getElementById('mcp-env');
  var transportEl = document.getElementById('mcp-transport');
  var statusEl = document.getElementById('mcp-status');
  var closeBtn = document.getElementById('mcp-close');
  var newBtn = document.getElementById('mcp-new');
  var saveBtn = document.getElementById('mcp-save');
  var delBtn = document.getElementById('mcp-delete');
  var pathLabel = document.getElementById('mcp-project-path');
  var projectPath = null;
  var servers = {}; // name -> config
  var editingName = null;
  var isNew = false;

  function showForm(show) {
    // Use inline style instead of .hidden class — the app doesn't have a
    // global '.hidden { display: none }' rule, only element-scoped ones, so
    // toggling .hidden on these divs is a no-op.
    emptyEl.style.display = show ? 'none' : '';
    formEl.style.display = show ? '' : 'none';
  }
  function renderList() {
    listEl.innerHTML = '';
    var names = Object.keys(servers).sort();
    if (names.length === 0) {
      var none = document.createElement('div');
      none.className = 'settings-hint';
      none.style.padding = '12px';
      none.textContent = 'No servers yet — click + to add one.';
      listEl.appendChild(none);
      return;
    }
    names.forEach(function (n) {
      var row = document.createElement('div');
      row.className = 'endpoints-list-item' + (n === editingName ? ' active' : '');
      row.textContent = n;
      row.addEventListener('click', function () { selectServer(n); });
      listEl.appendChild(row);
    });
  }
  function loadIntoForm(name) {
    var s = servers[name] || {};
    nameEl.value = name || '';
    cmdEl.value = s.command || '';
    argsEl.value = Array.isArray(s.args) ? s.args.join('\n') : '';
    envEl.value = s.env ? Object.keys(s.env).map(function (k) { return k + '=' + s.env[k]; }).join('\n') : '';
    transportEl.value = s.transport || '';
    statusEl.textContent = '';
  }
  function selectServer(n) {
    editingName = n;
    isNew = false;
    showForm(true);
    loadIntoForm(n);
    renderList();
    delBtn.style.display = '';
  }
  function startNew() {
    editingName = null;
    isNew = true;
    showForm(true);
    nameEl.value = '';
    cmdEl.value = '';
    argsEl.value = '';
    envEl.value = '';
    transportEl.value = '';
    statusEl.textContent = '';
    delBtn.style.display = 'none';
    nameEl.focus();
  }
  function parseEnv(text) {
    var out = {};
    String(text || '').split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      var i = line.indexOf('=');
      if (i < 0) return;
      var k = line.slice(0, i).trim();
      var v = line.slice(i + 1);
      if (k) out[k] = v;
    });
    return out;
  }
  function save() {
    var newName = nameEl.value.trim();
    if (!/^[A-Za-z0-9_.\-]+$/.test(newName)) {
      statusEl.textContent = 'Name must be alphanumeric (or _ . -).';
      return;
    }
    var cfg = {
      command: cmdEl.value.trim() || undefined,
      args: argsEl.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean),
      env: parseEnv(envEl.value),
      transport: transportEl.value || undefined
    };
    if (!cfg.command) { statusEl.textContent = 'Command is required.'; return; }
    if (cfg.args.length === 0) delete cfg.args;
    if (Object.keys(cfg.env).length === 0) delete cfg.env;
    if (!cfg.transport) delete cfg.transport;
    // Rename: drop the old key.
    if (!isNew && editingName && editingName !== newName) delete servers[editingName];
    servers[newName] = cfg;
    persist();
  }
  function del() {
    if (!editingName) return;
    if (!confirm('Delete MCP server "' + editingName + '"?')) return;
    delete servers[editingName];
    editingName = null;
    persist();
    showForm(false);
  }
  function persist() {
    if (!projectPath || !window.electronAPI || !window.electronAPI.writeMcp) return;
    statusEl.textContent = 'Saving…';
    window.electronAPI.writeMcp(projectPath, servers).then(function (r) {
      if (r && r.ok) {
        statusEl.textContent = 'Saved';
        setTimeout(function () { if (statusEl.textContent === 'Saved') statusEl.textContent = ''; }, 1500);
      } else {
        statusEl.textContent = 'Error: ' + (r && r.error || 'unknown');
      }
      renderList();
    });
  }

  if (newBtn) newBtn.addEventListener('click', startNew);
  if (saveBtn) saveBtn.addEventListener('click', save);
  if (delBtn) delBtn.addEventListener('click', del);
  if (closeBtn) closeBtn.addEventListener('click', function () { modal.classList.add('hidden'); });
  modal.addEventListener('click', function (e) { if (e.target === modal) modal.classList.add('hidden'); });
  ['mcp-name', 'mcp-command', 'mcp-args', 'mcp-env'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('keydown', function (e) { e.stopPropagation(); });
  });

  window.openMcpModal = function (projPath) {
    if (!projPath || !window.electronAPI || !window.electronAPI.readMcp) return;
    projectPath = projPath;
    pathLabel.textContent = projPath + '/.mcp.json';
    modal.classList.remove('hidden');
    showForm(false);
    statusEl.textContent = '';
    window.electronAPI.readMcp(projPath).then(function (r) {
      servers = (r && r.mcpServers) || {};
      editingName = null;
      renderList();
    });
  };
})();

(function setupQuickOpen() {
  var modal = document.getElementById('quick-open-modal');
  var input = document.getElementById('quick-open-input');
  var resultsEl = document.getElementById('quick-open-results');
  var closeBtn = document.getElementById('quick-open-close');
  if (!modal || !input || !resultsEl) return;

  var lastHits = [];
  var sel = 0;

  function open() {
    if (!activeProjectKey) return;
    modal.classList.remove('hidden');
    input.value = '';
    lastHits = [];
    resultsEl.innerHTML = '';
    setTimeout(function () { input.focus(); }, 0);
  }
  function close() {
    modal.classList.add('hidden');
    if (typeof refocusActiveTerminal === 'function') refocusActiveTerminal();
  }
  function render() {
    resultsEl.innerHTML = '';
    lastHits.slice(0, 40).forEach(function (h, i) {
      var row = document.createElement('div');
      row.className = 'session-search-hit' + (i === sel ? ' active' : '');
      var meta = document.createElement('div');
      meta.className = 'session-search-hit-meta';
      meta.textContent = h.relativePath || h.name;
      row.appendChild(meta);
      row.addEventListener('click', function () { openFileEditor(h.path); close(); });
      resultsEl.appendChild(row);
    });
  }

  var t = null;
  input.addEventListener('input', function () {
    clearTimeout(t);
    var q = input.value.trim();
    if (!q) { lastHits = []; resultsEl.innerHTML = ''; return; }
    t = setTimeout(function () {
      var proj = config && config.projects && config.projects.find(function (p) {
        return p && projectPathToKey(p.path) === activeProjectKey;
      });
      if (!proj || !window.electronAPI || !window.electronAPI.searchFiles) return;
      window.electronAPI.searchFiles(proj.path, q).then(function (hits) {
        // Files only — quick-open doesn't open directories.
        lastHits = (hits || []).filter(function (h) { return !h.isDirectory; });
        sel = 0;
        render();
      });
    }, 120);
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(lastHits.length - 1, sel + 1); render(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      var h = lastHits[sel];
      if (h) { openFileEditor(h.path); close(); }
    }
  });

  if (closeBtn) closeBtn.addEventListener('click', close);
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  document.addEventListener('keydown', function (e) {
    if (cmdOrCtrl(e) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
      // Exclude the textarea inside our own modal so typing 'p' inside the
      // input doesn't loop.
      if (e.target && (e.target.id === 'quick-open-input')) return;
      e.preventDefault();
      open();
    }
  }, true);
})();

(function setupContentSearch() {
  var modal = document.getElementById('content-search-modal');
  var input = document.getElementById('content-search-input');
  var resultsEl = document.getElementById('content-search-results');
  var statusEl = document.getElementById('content-search-status');
  var closeBtn = document.getElementById('content-search-close');
  if (!modal || !input || !resultsEl) return;

  function open() {
    if (!activeProjectKey) { return; }
    modal.classList.remove('hidden');
    input.focus();
    input.select();
  }
  function close() {
    modal.classList.add('hidden');
    if (typeof refocusActiveTerminal === 'function') refocusActiveTerminal();
  }
  function escapeHtmlLocal(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }
  function highlight(text, q) {
    var safe = escapeHtmlLocal(text);
    var idx = safe.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return safe;
    return safe.slice(0, idx) + '<mark>' + safe.slice(idx, idx + q.length) + '</mark>' + safe.slice(idx + q.length);
  }

  var t = null;
  input.addEventListener('input', function () {
    clearTimeout(t);
    var q = input.value.trim();
    if (q.length < 2) { resultsEl.innerHTML = ''; statusEl.textContent = ''; return; }
    statusEl.textContent = 'Searching…';
    t = setTimeout(function () {
      if (!window.electronAPI || !window.electronAPI.searchProjectContent) {
        statusEl.textContent = 'Search API not available.';
        return;
      }
      // Use the project path, not its key — main resolves via assertInsideAllowedRoots.
      var proj = config && config.projects && config.projects.find(function (p) {
        return p && projectPathToKey(p.path) === activeProjectKey;
      });
      if (!proj) { statusEl.textContent = 'No active project.'; return; }
      window.electronAPI.searchProjectContent(proj.path, q).then(function (hits) {
        resultsEl.innerHTML = '';
        if (!hits || !hits.length) { statusEl.textContent = 'No matches.'; return; }
        statusEl.textContent = hits.length + ' match' + (hits.length === 1 ? '' : 'es') + (hits.length >= 300 ? ' (capped)' : '');
        hits.forEach(function (h) {
          var row = document.createElement('div');
          row.className = 'session-search-hit';
          var meta = document.createElement('div');
          meta.className = 'session-search-hit-meta';
          meta.textContent = h.relativePath + '  •  line ' + h.line;
          var snip = document.createElement('div');
          snip.className = 'session-search-hit-snippet';
          snip.innerHTML = highlight(h.snippet || '', q);
          row.appendChild(meta);
          row.appendChild(snip);
          row.addEventListener('click', function () {
            openFileEditor(h.path, h.line);
            close();
          });
          resultsEl.appendChild(row);
        });
      }).catch(function (e) {
        statusEl.textContent = 'Search failed: ' + (e && e.message || e);
      });
    }, 200);
  });

  if (closeBtn) closeBtn.addEventListener('click', close);
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  document.addEventListener('keydown', function (e) {
    if (cmdOrCtrl(e) && e.shiftKey && (e.key === 'G' || e.key === 'g')) {
      e.preventDefault();
      open();
    }
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });
})();

(function setupShortcutsModal() {
  var btn = document.getElementById('btn-shortcuts');
  var modal = document.getElementById('shortcuts-modal');
  var closeBtn = document.getElementById('shortcuts-close');
  if (!modal) return;

  function open() { modal.classList.remove('hidden'); }
  function close() {
    modal.classList.add('hidden');
    if (typeof refocusActiveTerminal === 'function') refocusActiveTerminal();
  }

  if (btn) btn.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

  // ? hotkey — only fires when no input/textarea/select has focus, so it
  // doesn't interfere with typing a literal "?" into a form.
  document.addEventListener('keydown', function (e) {
    if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      var t = e.target;
      var tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (t && t.classList && t.classList.contains('xterm-helper-textarea')) return;
      e.preventDefault();
      open();
      return;
    }
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });
})();
