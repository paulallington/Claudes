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
var optSkipPermissions = document.getElementById('opt-skip-permissions');
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

// Per-endpoint-class default effort applied at spawn. User-configurable in the
// spawn options panel; persisted in config.defaultEffortCloud/Local.
var defaultEffortCloud = 'high';
var defaultEffortLocal = 'medium';
function isValidEffort(v) {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max';
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

// Activity state tracking per column: 'working' | 'attention' | 'idle' | 'exited'
var activityTimers = new Map(); // columnId -> setTimeout handle
var ACTIVITY_IDLE_MS = 3000; // after 3s of no substantial data, consider Claude "waiting"
var resizeSuppressed = new Set(); // columnIds temporarily suppressed after resize

// Per-project state: projectKey -> { containerEl, rows: [], columns: Map, focusedColumnId }
var projectStates = new Map();
var activeProjectKey = null;

var config = { projects: [], activeProjectIndex: -1 };
var projectDragFromIndex = -1; // For sidebar drag-to-reorder

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
var wsHasConnectedBefore = false;

function connectWS() {
  ws = new WebSocket('ws://127.0.0.1:' + wsPort);
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
          // Detect: input prompt (> / ❯), permission prompt (Yes/No), or "Do you want to proceed"
          var endsWithPrompt = /\n\s*[>❯]\s*$/.test(trimmed) || /^\s*[>❯]\s*$/.test(trimmed) ||
            /Do you want to proceed/.test(trimmed) || /Esc to cancel/.test(trimmed) ||
            /\d\.\s*(Yes|No)\s*$/.test(trimmed);
          if (endsWithPrompt && col.activityState === 'working') {
            setColumnActivity(msg.id, 'waiting');
            notifyAttentionNeeded(msg.id);
          } else if (msg.data.length > 10 && !endsWithPrompt) {
            setColumnActivity(msg.id, 'working');
          }
        }
        // Auto-open browser when server starts listening
        if (col.launchUrl && !col.launchUrlOpened && msg.data.indexOf('Now listening on') !== -1) {
          col.launchUrlOpened = true;
          window.electronAPI.openExternal(col.launchUrl);
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
          col3.fitAddon.fit();
          var respawnMsg = {
            type: 'create',
            id: msg.id,
            cols: col3.terminal.cols,
            rows: col3.terminal.rows,
            cwd: col3.cwd,
            args: ['--resume', col3.sessionId]
          };
          if (col3.env) respawnMsg.env = col3.env;
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

    col.fitAddon.fit();
    wsSend({
      type: 'reattach',
      id: id,
      cols: col.terminal.cols,
      rows: col.terminal.rows
    });
  });
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
    col.activityState = state; // 'exited'
    activityTimers.delete(id);
    updateActivityIndicator(id);
    updateSidebarActivity();
  }
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
  // Count activity states per project
  var attentionByProject = {};
  var workingByProject = {};
  allColumns.forEach(function (col) {
    var key = col.projectKey;
    if (col.activityState === 'attention') {
      attentionByProject[key] = (attentionByProject[key] || 0) + 1;
    }
    if (col.activityState === 'working') {
      workingByProject[key] = (workingByProject[key] || 0) + 1;
    }
  });

  // Apply activity class to existing project badges
  config.projects.forEach(function (project) {
    var key = project.path;
    var item = projectListEl.querySelector('.project-item[data-project-path="' + CSS.escape(key) + '"]');
    if (!item) return;

    var attention = attentionByProject[key] || 0;
    var working = workingByProject[key] || 0;

    var badge = item.querySelector('.project-badge');
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

  // Track project attention (persists across renderProjectList rebuilds)
  if (notifSettings.sidebar) {
    projectsNeedingAttention.add(col.projectKey);
    // Apply to current DOM
    var item = projectListEl.querySelector('.project-item[data-project-path="' + CSS.escape(col.projectKey) + '"]');
    if (item) item.classList.add('attention-flash');
  }
}

function clearProjectAttention(projectKey) {
  var changed = false;
  allColumns.forEach(function (col, id) {
    if (col.projectKey === projectKey && col.activityState === 'attention') {
      col.activityState = 'idle';
      updateActivityIndicator(id);
      changed = true;
    }
  });
  if (changed) updateSidebarActivity();
}

// ============================================================
// Per-project state helpers
// ============================================================

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
    focusedColumnId: null
  };
  projectStates.set(projectKey, state);
  return state;
}

function getActiveState() {
  if (!activeProjectKey) return null;
  return projectStates.get(activeProjectKey) || null;
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
  var items = document.querySelectorAll('.project-item');
  config.projects.forEach(function (project, index) {
    if (index >= items.length) return;
    var item = items[index];
    var rightSide = item.querySelector('.project-right');
    if (!rightSide) return;
    var existingBadge = rightSide.querySelector('.project-badge');
    var state = projectStates.get(project.path);
    var count = state ? state.columns.size : 0;
    if (count > 0 && !existingBadge) {
      var badge = document.createElement('span');
      badge.className = 'project-badge';
      var icon = document.createElement('img');
      icon.className = 'claude-icon';
      icon.src = './claude-small.png';
      icon.alt = '';
      badge.appendChild(icon);
      rightSide.insertBefore(badge, rightSide.firstChild);
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
    }
    if (config.fontSize) {
      fontSize = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, config.fontSize));
    }
    if (isValidEffort(config.defaultEffortCloud)) defaultEffortCloud = config.defaultEffortCloud;
    if (isValidEffort(config.defaultEffortLocal)) defaultEffortLocal = config.defaultEffortLocal;
    if (optDefaultEffortCloud) optDefaultEffortCloud.value = defaultEffortCloud;
    if (optDefaultEffortLocal) optDefaultEffortLocal.value = defaultEffortLocal;
    if (config.theme) {
      setThemePreference(config.theme);
    }
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
            setActiveProject(idx, true);
          }
        });
      } else {
        setActiveProject(idx, true);
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
      isDiff: entry.isDiff
    });
  });

  activeProjectKey = prevActive;
  setActiveProject(projIdx, false);
  persistSessions(project.path);
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

  if (col.terminal) col.terminal.dispose();
  allColumns.delete(id);

  var state = projectStates.get(col.projectKey);
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

function buildProjectItem(project, index) {
  var key = project.path;
  var state = projectStates.get(key);
  var count = state ? state.columns.size : 0;

  var item = document.createElement('div');
  item.className = 'project-item';
  item.dataset.projectPath = key;
  if (index === config.activeProjectIndex && !project.poppedOut) item.className += ' active';
  if (projectsNeedingAttention.has(key)) item.className += ' attention-flash';
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

  var rightSide = document.createElement('div');
  rightSide.className = 'project-right';

  if (count > 0) {
    var badge = document.createElement('span');
    badge.className = 'project-badge';
    var claudeIcon = document.createElement('img');
    claudeIcon.className = 'claude-icon';
    claudeIcon.src = './claude-small.png';
    claudeIcon.alt = '';
    badge.appendChild(claudeIcon);
    rightSide.appendChild(badge);
  }

  var pinBtn = document.createElement('span');
  pinBtn.className = 'project-pin';
  pinBtn.textContent = '\u272F'; // ✯ sparkle star — matches pinned accent colour
  pinBtn.title = project.pinned ? 'Unpin' : 'Pin to top';
  pinBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    togglePinProject(index);
  });
  rightSide.appendChild(pinBtn);

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
    setActiveProject(index, false);
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

  rightSide.appendChild(removeBtn);
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
    if (inGroup) {
      item.classList.add('in-group');
      var container = groupContainers[groupKey];
      if (container) container.appendChild(item);
      else parent.appendChild(item);
    } else {
      parent.appendChild(item);
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
    pinnedHeader.textContent = '\u272F Pinned';
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

function setActiveProject(index, isStartup, skipDefaultSpawn) {
  var project = config.projects[index];
  if (!project) return;

  var prevKey = activeProjectKey;
  var newKey = project.path;

  if (prevKey && prevKey !== newKey) {
    var prevState = projectStates.get(prevKey);
    if (prevState) prevState.containerEl.style.display = 'none';
    var commitInput = document.getElementById('git-commit-msg');
    if (commitInput) commitInput.value = '';
  }

  config.activeProjectIndex = index;
  activeProjectKey = newKey;
  activeProjectNameEl.textContent = project.name;

  // Show branch in toolbar
  if (window.electronAPI && window.electronAPI.gitBranch) {
    window.electronAPI.gitBranch(newKey).then(function (branch) {
      if (branch && activeProjectKey === newKey) {
        activeProjectNameEl.textContent = project.name + '  \u2387 ' + branch.trim();
      }
    }).catch(function () {});
  }

  saveConfig();
  // Update active highlight without full re-render (avoids jitter)
  document.querySelectorAll('.project-item').forEach(function (el) {
    el.classList.toggle('active', el.dataset.projectPath === newKey);
  });

  var emptyState = columnsContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  lastGitRaw = null; // invalidate cache on project switch
  var state = getOrCreateProjectState(newKey);
  state.containerEl.style.display = 'flex';
  refreshExplorer();
  if (activeAutomationDetailId) closeAutomationDetail();
  refreshAutomations();
  loadSpawnOptions();

  if (state.columns.size === 0) {
    if (isStartup && window.electronAPI) {
      restoreProjectSessions(newKey, project);
    } else if (!skipDefaultSpawn) {
      var spawnArgs = buildSpawnArgs();
      addColumn(spawnArgs.length > 0 ? spawnArgs : null, null, spawnOpts());
    }
  } else {
    if (state.focusedColumnId !== null) {
      setFocusedColumn(state.focusedColumnId);
    }
    refitAll();
  }
  loadHeadlessRunsForActiveProject();
}

function restoreProjectSessions(projectPath, project) {
  window.electronAPI.loadSessions(projectPath).then(function (savedSessions) {
    var spawnArgs = buildSpawnArgs();
    if (savedSessions && savedSessions.length > 0) {
      for (var i = 0; i < savedSessions.length; i++) {
        // Support both old format (plain string) and new format ({sessionId, title})
        var entry = savedSessions[i];
        var sessionId = typeof entry === 'string' ? entry : entry.sessionId;
        var title = typeof entry === 'object' ? entry.title : null;
        addColumn(spawnArgs.concat(['--resume', sessionId]), null, spawnOpts(title ? { title: title } : null));
      }
    } else {
      addColumn(spawnArgs.length > 0 ? spawnArgs : null, null, spawnOpts());
    }
  });
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
  var msg = document.createElement('div');
  msg.textContent = 'No project selected';
  var hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Add a project from the sidebar to get started';
  empty.appendChild(msg);
  empty.appendChild(hint);
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
    effortSelect.title = 'Effort level — launched with --effort. To change mid-session, click to open the interactive /effort picker (Claude Code has no non-interactive way to change effort after spawn).';
    effortSelect.innerHTML = '<option value="">Effort</option><option value="low">Low</option><option value="medium">Med</option><option value="high">High</option><option value="xhigh">XHigh</option><option value="max">Max</option>';
    // Mid-session effort changes can only be made via the interactive /effort
    // picker — there's no non-interactive setter. Open the picker and let the
    // user finish there. Reset the dropdown to its prior value since we can't
    // know what the user actually picked.
    effortSelect.addEventListener('mousedown', function (e) {
      e.stopPropagation();
      e.preventDefault();
      wsSend({ type: 'write', id: id, data: '/effort\n' });
      effortSelect.blur();
    });

    actions.appendChild(compactBtn);
    actions.appendChild(teleportBtn);
    actions.appendChild(effortSelect);
  }

  var maximizeBtn = document.createElement('span');
  maximizeBtn.className = 'col-maximize';
  maximizeBtn.title = 'Maximize';
  maximizeBtn.textContent = '\u25A1';
  maximizeBtn.addEventListener('click', function () {
    toggleMaximizeColumn(id);
  });
  actions.appendChild(maximizeBtn);

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
  }

  var closeBtn = document.createElement('span');
  closeBtn.className = 'col-close';
  closeBtn.dataset.id = String(id);
  closeBtn.title = opts.isDiff ? 'Close' : 'Kill';
  closeBtn.textContent = '\u00d7';
  actions.appendChild(closeBtn);

  header.appendChild(title);
  header.appendChild(actions);

  header.addEventListener('dblclick', function (e) {
    if (e.target === title || title.contains(e.target)) return;
    toggleMaximizeColumn(id);
  });

  if (!opts.isDiff) setupColumnDrag(header, id);

  return header;
}

function startTitleEdit(id, titleEl) {
  if (titleEl.contentEditable === 'true') return;
  titleEl.contentEditable = 'true';
  titleEl.classList.add('editing');
  titleEl.focus();
  var range = document.createRange();
  range.selectNodeContents(titleEl);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  function finishEdit() {
    titleEl.contentEditable = 'false';
    titleEl.classList.remove('editing');
    var newTitle = titleEl.textContent.trim();
    var col = allColumns.get(id);
    if (col) {
      col.customTitle = newTitle || null;
      if (!newTitle) titleEl.textContent = 'Claude #' + id;
      persistSessions(col.projectKey);
    }
  }
  titleEl.addEventListener('blur', finishEdit, { once: true });
  titleEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    if (e.key === 'Escape') {
      var col = allColumns.get(id);
      titleEl.textContent = (col && col.customTitle) || ('Claude #' + id);
      titleEl.blur();
    }
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
    col.fitAddon.fit();
    var sendMsg = { type: 'create', id: id, cols: col.terminal.cols, rows: col.terminal.rows, cwd: col.cwd };
    if (col.cmd) {
      sendMsg.cmd = col.cmd;
      sendMsg.args = col.cmdArgs || [];
    } else {
      sendMsg.args = col.sessionId ? ['--resume', col.sessionId] : [];
    }
    if (col.env) sendMsg.env = col.env;
    wsSend(sendMsg);
    col.terminal.clear();
    setColumnActivity(id, 'working');
  });
  closeBtn.addEventListener('click', function () { removeColumn(id); });

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
    endpointBanner = document.createElement('div');
    endpointBanner.className = 'endpoint-banner endpoint-banner--cloud';
    endpointBanner.innerHTML =
      '<span class="endpoint-banner-tag endpoint-banner-tag--cloud">Cloud</span>' +
      '<span class="endpoint-banner-name">Anthropic</span>' +
      '<span class="endpoint-banner-caveat">Suitable for any tasks</span>';
  }

  var termWrapper = document.createElement('div');
  termWrapper.className = 'terminal-wrapper';

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

  var terminal = new Terminal({
    theme: termTheme,
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    fontSize: fontSize,
    cursorBlink: true,
    allowProposedApi: true
  });

  var fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(termWrapper);
  try { terminal.loadAddon(new WebglAddon.WebglAddon()); } catch (e) { console.warn('WebGL addon failed, using canvas renderer:', e); }

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

  // Handle Ctrl+V paste and Shift+Enter newline
  terminal.attachCustomKeyEventHandler(function (e) {
    // Ctrl+V: paste from clipboard
    if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && e.key === 'v') {
      e.preventDefault();
      window.electronAPI.clipboardReadText().then(function (text) {
        if (text) {
          terminal.paste(text);
        }
      });
      return false;
    }
    // Ctrl+Shift+V: also paste
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key === 'V') {
      e.preventDefault();
      window.electronAPI.clipboardReadText().then(function (text) {
        if (text) {
          terminal.paste(text);
        }
      });
      return false;
    }
    // Ctrl+C: copy selection if there is one, otherwise send SIGINT
    if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && e.key === 'c') {
      var sel = terminal.getSelection();
      if (sel) {
        window.electronAPI.clipboardWriteText(sel);
        terminal.clearSelection();
        return false;
      }
      // No selection — let xterm send SIGINT as normal
      return true;
    }
    // Shift+Enter: send CSI u sequence so Claude CLI sees it as newline
    if (e.type === 'keydown' && e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Enter') {
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

  var preSpawnSessionsPromise = (!cmd && window.electronAPI)
    ? window.electronAPI.getRecentSessions(cwd)
    : Promise.resolve([]);

  requestAnimationFrame(function () {
    fitAddon.fit();
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
    var sendMsg = { type: 'create', id: id, cols: terminal.cols, rows: terminal.rows, cwd: cwd, args: claudeArgs };
    if (cmd) sendMsg.cmd = cmd;
    if (opts.env) sendMsg.env = opts.env;
    wsSend(sendMsg);

    var isResume = claudeArgs.indexOf('--resume') !== -1;
    if (!cmd && !isResume && window.electronAPI) {
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
        c.hasUserInput = true;
        c.notified = false;
      }
    }
  });

  termWrapper.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var sel = terminal.getSelection();
    if (sel) {
      window.electronAPI.clipboardWriteText(sel);
      terminal.clearSelection();
    } else {
      window.electronAPI.clipboardReadText().then(function (text) {
        if (text) {
          terminal.focus();
          terminal.paste(text);
        }
      });
    }
  });

  termWrapper.addEventListener('mousedown', function () {
    setFocusedColumn(id);
  });

  header.querySelector('.col-restart').addEventListener('click', function () {
    restartColumn(id);
  });
  header.querySelector('.col-close').addEventListener('click', function () {
    removeColumn(id);
  });

  // Extract session ID if resuming, or take from opts for a reattach transfer.
  var resumeSessionId = opts.sessionId || null;
  for (var ai = 0; ai < claudeArgs.length - 1; ai++) {
    if (claudeArgs[ai] === '--resume') { resumeSessionId = claudeArgs[ai + 1]; break; }
  }

  var colData = {
    element: col,
    terminal: terminal,
    fitAddon: fitAddon,
    headerEl: header,
    cwd: cwd,
    projectKey: activeProjectKey,
    sessionId: resumeSessionId,
    sessionMtime: 0,
    customTitle: opts.title || null,
    cmd: cmd,
    cmdArgs: claudeArgs,
    env: opts.env || null,
    launchUrl: opts.launchUrl || null,
    launchUrlOpened: false,
    createdAt: Date.now(),
    lastInputAt: 0,
    hasUserInput: false,
    notified: false,
    spawnSessionPct: null,    // five_hour.utilization at spawn time
    spawnWeeklyPct: null,  // reserved: weekly-delta pill in a follow-up task
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
  colData.deltaSessionEl = header.querySelector('[data-col-delta]');
  colData.ctxMeterEl = header.querySelector('[data-col-ctx]');
  colData.ctxFillEl = colData.ctxMeterEl ? colData.ctxMeterEl.querySelector('.col-ctx-fill') : null;
  colData.ctxTextEl = colData.ctxMeterEl ? colData.ctxMeterEl.querySelector('.col-ctx-text') : null;
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

  // Start periodic session sync for Claude columns (not custom commands)
  if (!cmd) {
    startSessionSync(id, cwd);
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

  // Find existing column of the same slot type and reuse it
  var existingDiffId = null;
  state.columns.forEach(function (col, id) {
    if (col.isDiff && col.diffSlot === slotType) existingDiffId = id;
  });
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
    cwd: activeProjectKey,
    projectKey: activeProjectKey,
    customTitle: title,
    createdAt: Date.now()
  };

  row.columnIds.push(id);
  state.columns.set(id, colData);
  allColumns.set(id, colData);

  // Toggle button handler
  toggleBtn.addEventListener('click', function () {
    colData.diffMode = colData.diffMode === 'unified' ? 'split' : 'unified';
    toggleBtn.textContent = colData.diffMode === 'unified' ? '\u2194' : '\u2016';
    renderDiffContent(diffBody, colData);
  });

  // Close button handler
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
  window.electronAPI.gitDiff(activeProjectKey, colData.diffData.filePath, colData.diffData.staged || false).then(function (text) {
    colData.diffData.diffText = text;
    colData.diffData.parsed = parseDiff(text);
    renderDiffContent(diffBody, colData);
  });
}

function loadCommitDiff(diffBody, colData) {
  diffBody.textContent = 'Loading...';
  var hash = colData.diffData.commitHash;

  if (colData.diffData.filePath) {
    window.electronAPI.gitDiffCommit(activeProjectKey, hash, colData.diffData.filePath).then(function (text) {
      colData.diffData.diffText = text;
      colData.diffData.parsed = parseDiff(text);
      renderDiffContent(diffBody, colData);
    });
  } else {
    // Full commit — show file list first, click to view individual diffs
    window.electronAPI.gitCommitDetail(activeProjectKey, hash).then(function (detail) {
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
        }, { title: fileInfo.file.split('/').pop() });
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
          window.electronAPI.gitDiffCommit(activeProjectKey, colData.diffData.commitHash, fileInfo.file).then(function (text) {
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
    persistSessions(col2.projectKey);
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
  return claimed;
}

// Detect which session ID was created by a newly spawned Claude
function detectSession(columnId, projectPath, preExistingIds, attempt) {
  if (attempt > 15) return;
  setTimeout(function () {
    window.electronAPI.getRecentSessions(projectPath).then(function (sessions) {
      var claimed = getClaimedSessionIds(columnId);
      for (var i = 0; i < sessions.length; i++) {
        var sid = sessions[i].sessionId;
        if (!preExistingIds[sid] && !claimed[sid]) {
          var col = allColumns.get(columnId);
          if (col) {
            col.sessionId = sid;
            col.sessionMtime = sessions[i].modified || 0;
            persistSessions(col.projectKey);
            fetchAndSetSessionTitle(columnId, projectPath, sid);
            // Effort is now set at spawn via --effort (the only non-interactive
            // mechanism — /config set effort doesn't exist and /effort opens
            // an interactive picker). Just sync the column header dropdown
            // visual to whatever default this column was launched with so the
            // tab honestly reflects what claude is running on.
            if (!col.effortApplied) {
              var isLocal = col.env && col.env.ANTHROPIC_BASE_URL;
              col.effortApplied = true;
              var effortEl = col.element && col.element.querySelector('.col-effort');
              if (effortEl) effortEl.value = isLocal ? defaultEffortLocal : defaultEffortCloud;
            }
          }
          return;
        }
      }
      detectSession(columnId, projectPath, preExistingIds, attempt + 1);
    });
  }, 2000);
}

// Periodically re-detect session ID for a column (handles /clear, /resume inside CLI).
// Pinning rule: each column tracks sessionMtime of its current file. A newer session
// only replaces it if THIS column has had user input recently — so an idle column
// can't steal a sibling's freshly-created (post-/clear) session.
var sessionSyncTimers = new Map();
var SESSION_SYNC_INTERVAL = 5000;
var SESSION_REASSIGN_INPUT_WINDOW_MS = 30000;

function startSessionSync(columnId, projectPath) {
  if (!window.electronAPI) return;
  stopSessionSync(columnId);

  var timer = setInterval(function () {
    var col = allColumns.get(columnId);
    if (!col) { stopSessionSync(columnId); return; }

    window.electronAPI.getRecentSessions(projectPath).then(function (sessions) {
      var col2 = allColumns.get(columnId);
      if (!col2 || !sessions.length) return;

      var claimed = getClaimedSessionIds(columnId);
      var now = Date.now();
      var hasRecentInput = col2.lastInputAt && (now - col2.lastInputAt < SESSION_REASSIGN_INPUT_WINDOW_MS);

      var currentEntry = null;
      for (var j = 0; j < sessions.length; j++) {
        if (sessions[j].sessionId === col2.sessionId) { currentEntry = sessions[j]; break; }
      }

      if (currentEntry) {
        // Current session file still exists. Only consider a reassignment if
        // THIS column has had recent input AND there's a newer unclaimed file.
        if (hasRecentInput) {
          for (var i = 0; i < sessions.length; i++) {
            var s = sessions[i];
            if (s.sessionId === col2.sessionId) break; // nothing newer than current
            if (!claimed[s.sessionId] && s.modified > (col2.sessionMtime || 0)) {
              col2.sessionId = s.sessionId;
              col2.sessionMtime = s.modified;
              persistSessions(col2.projectKey);
              fetchAndSetSessionTitle(columnId, projectPath, s.sessionId);
              return;
            }
          }
        }
        col2.sessionMtime = currentEntry.modified;
      } else if (hasRecentInput) {
        // Pinned file is gone — fall back to the most recent unclaimed session,
        // but only if this column was actively being typed into.
        for (var k = 0; k < sessions.length; k++) {
          var sid = sessions[k].sessionId;
          if (!claimed[sid]) {
            col2.sessionId = sid;
            col2.sessionMtime = sessions[k].modified;
            persistSessions(col2.projectKey);
            fetchAndSetSessionTitle(columnId, projectPath, sid);
            return;
          }
        }
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

function persistSessions(projectKey) {
  if (!window.electronAPI) return;
  var state = projectStates.get(projectKey);
  if (!state) return;
  var sessionData = [];
  state.columns.forEach(function (col) {
    if (col.sessionId) {
      sessionData.push({ sessionId: col.sessionId, title: col.customTitle || null });
    }
  });
  window.electronAPI.saveSessions(projectKey, sessionData);
}

function removeColumn(id) {
  var col = allColumns.get(id);
  if (!col) return;

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

  if (col.terminal) col.terminal.dispose();
  allColumns.delete(id);

  var state = projectStates.get(col.projectKey);
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
      }
    }
  }

  refitAll();
  saveColumnCounts();
  persistSessions(col.projectKey);
  updateProjectBadges();
  updateSidebarActivity();
}

function restartColumn(id) {
  var col = allColumns.get(id);
  if (!col) return;
  if (col.isDiff) return;

  // Kill the current process
  wsSend({ type: 'kill', id: id });

  // Re-snapshot plan-limits so the Δ pill measures from this respawn, not the first spawn
  if (lastPlanLimitsResult && lastPlanLimitsResult.ok && lastPlanLimitsResult.data) {
    var d0 = lastPlanLimitsResult.data;
    col.spawnSessionPct = d0.five_hour ? d0.five_hour.utilization : null;
    col.spawnWeeklyPct = d0.seven_day ? d0.seven_day.utilization : null;
    updateColumnDeltaPills(lastPlanLimitsResult.data);
  }

  // Hide the context meter — the new session's first poll will repopulate it.
  if (col && col.ctxMeterEl) col.ctxMeterEl.setAttribute('hidden', '');

  // Remove any existing exit overlay
  var overlay = col.element.querySelector('.exit-overlay');
  if (overlay) overlay.remove();

  // Clear and respawn
  col.terminal.clear();
  col.fitAddon.fit();
  var sendMsg = { type: 'create', id: id, cols: col.terminal.cols, rows: col.terminal.rows, cwd: col.cwd };
  if (col.cmd) {
    sendMsg.cmd = col.cmd;
    sendMsg.args = col.cmdArgs || [];
  } else {
    sendMsg.args = col.sessionId ? ['--resume', col.sessionId] : [];
  }
  if (col.env) sendMsg.env = col.env;
  wsSend(sendMsg);
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
      col.fitAddon.fit();
      var respawnMsg = {
        type: 'create',
        id: colId,
        cols: col.terminal.cols,
        rows: col.terminal.rows,
        cwd: col.cwd,
        args: col.sessionId ? ['--resume', col.sessionId] : (col.cmdArgs || [])
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

function setFocusedColumn(id) {
  var col = allColumns.get(id);
  if (!col) return;
  var state = projectStates.get(col.projectKey);
  if (!state) return;

  if (state.focusedColumnId !== null && state.focusedColumnId !== id) {
    var prev = allColumns.get(state.focusedColumnId);
    if (prev) prev.element.classList.remove('focused');
  }
  state.focusedColumnId = id;
  col.element.classList.add('focused');
  if (col.terminal) col.terminal.focus();

  // Clear attention flash on this column's header
  if (col.headerEl) col.headerEl.classList.remove('attention-flash');

  // Only clear sidebar flash if no other columns in this project are still flashing
  var otherFlashing = false;
  allColumns.forEach(function (c, cid) {
    if (cid !== id && c.projectKey === col.projectKey && c.headerEl &&
        c.headerEl.classList.contains('attention-flash')) {
      otherFlashing = true;
    }
  });
  if (!otherFlashing) {
    projectsNeedingAttention.delete(col.projectKey);
    var item = projectListEl.querySelector('.project-item[data-project-path="' + CSS.escape(col.projectKey) + '"]');
    if (item) item.classList.remove('attention-flash');
  }
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
    setFocusedColumn(state.rows[targetRow].columnIds[targetColIdx]);
    return;
  }

  setFocusedColumn(ids[newIdx]);
}

// ============================================================
// Maximize / Restore Column
// ============================================================

var maximizedColumnId = null;

function toggleMaximizeColumn(id) {
  var col = allColumns.get(id);
  if (!col) return;
  var state = projectStates.get(col.projectKey);
  if (!state) return;

  if (maximizedColumnId === id) {
    // Restore
    maximizedColumnId = null;
    state.containerEl.classList.remove('has-maximized');
    state.columns.forEach(function (c) {
      c.element.classList.remove('col-maximized', 'col-hidden');
      c.element.style.flex = '';
      c.element.style.width = '';
    });
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
}

// ============================================================
// Resize Handles (columns)
// ============================================================

function setupResizeHandle(handle) {
  handle.addEventListener('mousedown', function (e) {
    e.preventDefault();
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
        refitAll();
      }
    }
    function onMouseUp() {
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
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
        refitAll();
      }
    }
    function onMouseUp() {
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
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
    try {
      col.fitAddon.fit();
      // Suppress activity tracking for redraw data after resize
      resizeSuppressed.add(id);
      setTimeout(function () { resizeSuppressed.delete(id); }, 500);
      wsSend({ type: 'resize', id: id, cols: col.terminal.cols, rows: col.terminal.rows });
    } catch (e) {}
  });
}

var resizeTimeout;
window.addEventListener('resize', function () {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(refitAll, 100);
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
  if (e.ctrlKey && e.shiftKey && e.key === 'T') {
    e.preventDefault();
    addColumn(null, null, spawnOpts());
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'R') {
    e.preventDefault();
    addRow();
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'W') {
    e.preventDefault();
    var state = getActiveState();
    if (state && state.focusedColumnId !== null) removeColumn(state.focusedColumnId);
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    navigateColumn('left');
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.key === 'ArrowRight') {
    e.preventDefault();
    navigateColumn('right');
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.key === 'ArrowUp') {
    e.preventDefault();
    navigateColumn('up');
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.key === 'ArrowDown') {
    e.preventDefault();
    navigateColumn('down');
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.key === 'b') {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'E') {
    e.preventDefault();
    toggleExplorer();
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'M') {
    e.preventDefault();
    var state = getActiveState();
    if (state && state.focusedColumnId !== null) {
      toggleMaximizeColumn(state.focusedColumnId);
    }
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
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
        setFocusedColumn(ids[num - 1]);
      }
    }
    return;
  }
  if (e.ctrlKey && !e.shiftKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    changeFontSize(1);
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.key === '-') {
    e.preventDefault();
    changeFontSize(-1);
    return;
  }
  if (e.ctrlKey && !e.shiftKey && e.key === '0') {
    e.preventDefault();
    resetFontSize();
    return;
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

function refreshGitStatus(force) {
  if (!activeProjectKey || !window.electronAPI) return;
  // Skip background polls if a previous batch is still running — prevents
  // backed-up git calls piling up on the main thread when the repo or disk is slow.
  if (gitPollInFlight && !force) return;

  var fetchAll = [
    window.electronAPI.gitStatus(activeProjectKey),
    window.electronAPI.gitBranch(activeProjectKey),
    window.electronAPI.gitAheadBehind(activeProjectKey),
    window.electronAPI.gitStashList(activeProjectKey),
    window.electronAPI.gitGraphLog(activeProjectKey, 50),
    window.electronAPI.gitDiffStat(activeProjectKey, false),
    window.electronAPI.gitDiffStat(activeProjectKey, true)
  ];

  gitPollInFlight = true;
  var done = function () { gitPollInFlight = false; };

  if (!force) {
    Promise.all(fetchAll).then(function (results) {
      var rawKey = JSON.stringify(results[0]) + '|' + results[1] + '|' + JSON.stringify(results[2]) + '|' + results[3].length + '|' + JSON.stringify(results[4]);
      if (rawKey === lastGitRaw) return;
      lastGitRaw = rawKey;
      renderGitStatus(results[0], results[1], results[2], results[3], results[4], results[5], results[6]);
    }).then(done, done);
    return;
  }

  lastGitRaw = null;
  Promise.all(fetchAll).then(function (results) {
    lastGitRaw = JSON.stringify(results[0]) + '|' + results[1] + '|' + JSON.stringify(results[2]) + '|' + results[3].length + '|' + JSON.stringify(results[4]);
    renderGitStatus(results[0], results[1], results[2], results[3], results[4], results[5], results[6]);
  }).then(done, done);
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

function renderGitStatus(files, branch, aheadBehind, stashes, graphLog, unstagedStats, stagedStats) {
  graphLaneState = null;
  updateActiveProjectBranchLabels(branch);
  while (gitHeaderEl.firstChild) gitHeaderEl.removeChild(gitHeaderEl.firstChild);
  while (gitChangesEl.firstChild) gitChangesEl.removeChild(gitChangesEl.firstChild);

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

  window.electronAPI.gitBranches(activeProjectKey).then(function (branches) {
    for (var i = 0; i < branches.length; i++) {
      (function (b) {
        var item = document.createElement('div');
        item.className = 'git-branch-dropdown-item' + (b.isCurrent ? ' current' : '');
        item.textContent = (b.isCurrent ? '\u2713 ' : '  ') + b.name;
        if (!b.isCurrent) {
          item.addEventListener('click', function (e) {
            e.stopPropagation();
            dropdown.remove();
            gitCheckout(b.name);
          });
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

function createGitGraphSection(graphLog) {
  var state = computeGraphLanes(graphLog, graphLaneState);
  graphLaneState = { lanes: state.lanes, commitLanes: state.commitLanes };

  var section = document.createElement('div');
  section.className = 'git-section';

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
      hashEl.textContent = commit.abbrev;

      var msgEl = document.createElement('span');
      msgEl.className = 'git-graph-msg';
      msgEl.textContent = commit.message;

      var refsEl = document.createElement('span');
      refsEl.className = 'git-graph-refs';
      for (var r = 0; r < commit.refs.length; r++) {
        var ref = commit.refs[r];
        var badge = document.createElement('span');
        badge.className = 'git-graph-ref' + (ref.startsWith('tag:') ? ' git-graph-tag' : '');
        badge.textContent = ref.replace(/^HEAD -> /, '').replace(/^tag: /, '');
        refsEl.appendChild(badge);
      }

      var authorEl = document.createElement('span');
      authorEl.className = 'git-graph-author';
      authorEl.textContent = commit.author;

      var dateEl = document.createElement('span');
      dateEl.className = 'git-graph-date';
      dateEl.textContent = commit.relativeDate;

      row.appendChild(hashEl);
      row.appendChild(msgEl);
      row.appendChild(refsEl);
      row.appendChild(authorEl);
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

function createGitSection(title, files, isStaged, stats) {
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
  renderFileTreeNode(list, tree, isStaged, statsMap, 0);

  section.appendChild(list);

  header.addEventListener('click', function () {
    var collapsed = list.style.display === 'none';
    list.style.display = collapsed ? 'block' : 'none';
    arrow.textContent = collapsed ? '\u25BE' : '\u25B8';
  });

  return section;
}

function renderFileTreeNode(container, node, isStaged, statsMap, depth) {
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
      renderFileTreeNode(folderContent, folder, isStaged, statsMap, depth + 1);
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
    container.appendChild(createGitFileRow(node.files[i], isStaged, statsMap, depth));
  }
}

function createGitFileRow(file, isStaged, statsMap, depth) {
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
  window.electronAPI.gitStageFile(activeProjectKey, filePath).then(function () { refreshGitStatus(); });
}

function gitUnstageFile(filePath) {
  if (!activeProjectKey || !window.electronAPI) return;
  window.electronAPI.gitUnstageFile(activeProjectKey, filePath).then(function () { refreshGitStatus(); });
}

function gitStageAll() {
  if (!activeProjectKey || !window.electronAPI) return;
  window.electronAPI.gitStageAll(activeProjectKey).then(function () { refreshGitStatus(); });
}

function gitUnstageAll() {
  if (!activeProjectKey || !window.electronAPI) return;
  window.electronAPI.gitUnstageAll(activeProjectKey).then(function () { refreshGitStatus(); });
}

function gitDiscardFile(filePath) {
  if (!activeProjectKey || !window.electronAPI) return;
  window.electronAPI.gitDiscardFile(activeProjectKey, filePath).then(function () { refreshGitStatus(); });
}

function gitCommit() {
  if (!activeProjectKey || !window.electronAPI) return;
  var msg = gitCommitMsg.value.trim();
  if (!msg) return;
  var amend = gitAmendCheckbox && gitAmendCheckbox.checked;
  window.electronAPI.gitCommit(activeProjectKey, msg, amend).then(function (result) {
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
  window.electronAPI.gitCheckout(activeProjectKey, branchName).then(function (result) {
    if (result.success) {
      showGitStatus('Switched to ' + branchName);
      refreshGitStatus(true);
    } else {
      showGitStatus('Checkout failed: ' + result.error, true);
    }
  });
}

function gitCreateBranch(branchName) {
  if (!activeProjectKey || !window.electronAPI) return;
  showGitStatus('Creating ' + branchName + '...');
  window.electronAPI.gitCreateBranch(activeProjectKey, branchName).then(function (result) {
    if (result.success) {
      showGitStatus('Created and switched to ' + branchName);
      refreshGitStatus(true);
    } else {
      showGitStatus('Create branch failed: ' + result.error, true);
    }
  });
}

function gitStashPush() {
  if (!activeProjectKey || !window.electronAPI) return;
  showGitStatus('Stashing...');
  window.electronAPI.gitStashPush(activeProjectKey).then(function (result) {
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
  window.electronAPI.gitStashPop(activeProjectKey).then(function (result) {
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
  window.electronAPI.gitPull(activeProjectKey).then(function (result) {
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
  window.electronAPI.gitPush(activeProjectKey).then(function (result) {
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
    addColumn(cmdArgs, null, { cmd: cmd, title: config.name, cwd: cwd, env: env, launchUrl: launchUrl });

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
  if (e.ctrlKey && e.key === 'Enter') {
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

var themePreference = 'dark'; // 'dark' | 'light' | 'auto'

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

// ============================================================
// Hook Server Integration
// ============================================================

if (window.electronAPI && window.electronAPI.onHookEvent) {
  window.electronAPI.onHookEvent(function (event) {
    allColumns.forEach(function (col, id) {
      if (col.sessionId && event.session_id === col.sessionId) {
        if (event.matcher === 'idle_prompt' || event.matcher === 'permission_prompt') {
          setActivity(id, 'waiting');
        }
      }
    });
  });
}

if (window.electronAPI && window.electronAPI.getHookServerPort) {
  window.electronAPI.getHookServerPort().then(function (port) {
    if (port) console.log('[hooks] Hook server at http://127.0.0.1:' + port + '/hook');
  });
}

// ============================================================
// Init
// ============================================================

btnAdd.addEventListener('click', function () {
  if (optHeadless.checked) {
    // Consume the transient flag immediately — don't persist it.
    optHeadless.checked = false;
    closeSpawnDropdown();
    openHeadlessDock();
    return;
  }
  var args = buildSpawnArgs();
  addColumn(args.length > 0 ? args : null, null, spawnOpts());
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

function buildSpawnArgs() {
  var args = [];
  if (optSkipPermissions.checked) {
    args.push('--dangerously-skip-permissions');
  }
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
    args.push('--worktree', worktree);
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
  if (optSkipPermissions.checked) tags.push('yolo');
  if (optRemoteControl.checked) tags.push('remote');
  if (optBare.checked || (currentEndpointEnv && currentEndpointEnv.ANTHROPIC_CUSTOM_HEADERS)) tags.push('bare');
  if (optStripMcps.checked) tags.push('no-mcp');
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
    skipPermissions: optSkipPermissions.checked,
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
  optSkipPermissions.checked = !!opts.skipPermissions;
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
optSkipPermissions.addEventListener('change', onSpawnOptionChanged);
optRemoteControl.addEventListener('change', onSpawnOptionChanged);
optBare.addEventListener('change', onSpawnOptionChanged);
optStripMcps.addEventListener('change', onSpawnOptionChanged);
optModel.addEventListener('change', onSpawnOptionChanged);
optWorktree.addEventListener('input', onSpawnOptionChanged);
optCustomArgs.addEventListener('input', onSpawnOptionChanged);

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

function collectFormPayload() {
  return {
    id: editingPresetId === '__new__' ? null : editingPresetId,
    name: epName.value.trim(),
    baseUrl: epBaseUrl.value.trim(),
    authToken: epAuthToken.value, // pass as-is; main encrypts
    model: epModelInput.classList.contains('hidden')
      ? epModelSelect.value
      : epModelInput.value.trim(),
    fallbackId: (epFallback && epFallback.value) || null
  };
}

function saveCurrentPreset() {
  var payload = collectFormPayload();
  if (!payload.name) { setEpStatus('Name is required', 'error'); return; }
  if (!payload.baseUrl) { setEpStatus('Base URL is required', 'error'); return; }
  if (!payload.model) { setEpStatus('Model is required', 'error'); return; }
  setEpStatus('Saving…');
  window.electronAPI.endpointSave(payload).then(function (result) {
    if (result && result.ok === false) {
      setEpStatus(result.error || 'Save failed', 'error');
      return;
    }
    setEpStatus('Saved', 'ok');
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
    setEpStatus('Loaded ' + result.models.length + ' model' + (result.models.length === 1 ? '' : 's'), 'ok');
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

function openClaudeMdModal() {
  if (!activeProjectKey || !window.electronAPI) return;

  claudeMdPath.textContent = activeProjectKey + '/CLAUDE.md';
  claudeMdStatus.textContent = 'Loading...';
  claudeMdEditor.value = '';
  claudeMdModal.classList.remove('hidden');

  window.electronAPI.readClaudeMd(activeProjectKey).then(function (result) {
    claudeMdEditor.value = result.content;
    claudeMdStatus.textContent = result.exists ? '' : 'File does not exist yet — will be created on save';
  });
}

function closeClaudeMdModal() {
  claudeMdModal.classList.add('hidden');
}

function saveClaudeMd() {
  if (!activeProjectKey || !window.electronAPI) return;

  claudeMdStatus.textContent = 'Saving...';
  window.electronAPI.saveClaudeMd(activeProjectKey, claudeMdEditor.value).then(function (result) {
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
  window.electronAPI.getAutomationSettings().then(function (settings) {
    document.getElementById('setting-agent-repos-dir').value = settings.agentReposBaseDir || '';
  });
  settingsModal.classList.remove('hidden');
});

document.getElementById('settings-close').addEventListener('click', function () {
  settingsModal.classList.add('hidden');
});

settingsModal.addEventListener('click', function (e) {
  if (e.target === settingsModal) settingsModal.classList.add('hidden');
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

btnClaudeMd.addEventListener('click', openClaudeMdModal);

document.getElementById('btn-claude-config').addEventListener('click', function () {
  if (!window.electronAPI || !window.electronAPI.getClaudeConfigPath) return;
  window.electronAPI.getClaudeConfigPath().then(function (configPath) {
    openFileEditor(configPath);
  });
});
claudeMdClose.addEventListener('click', closeClaudeMdModal);
claudeMdSave.addEventListener('click', saveClaudeMd);

claudeMdModal.addEventListener('click', function (e) {
  if (e.target === claudeMdModal) closeClaudeMdModal();
});

claudeMdEditor.addEventListener('keydown', function (e) {
  // Ctrl+S to save
  if (e.ctrlKey && e.key === 's') {
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

function openFileEditor(filePath) {
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
    }
  });
}

function closeFileEditor() {
  if (fileEditorEditor.value !== fileEditorOriginal && fileEditorCurrentPath) {
    if (!confirm('You have unsaved changes. Close anyway?')) return;
  }
  fileEditorModal.classList.add('hidden');
  fileEditorCurrentPath = null;
  fileEditorOriginal = '';
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

fileEditorClose.addEventListener('click', closeFileEditor);
fileEditorSave.addEventListener('click', saveFileEditor);

fileEditorModal.addEventListener('click', function (e) {
  if (e.target === fileEditorModal) closeFileEditor();
});

fileEditorEditor.addEventListener('keydown', function (e) {
  // Ctrl+S to save
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    saveFileEditor();
  }
  // Escape to close
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFileEditor();
  }
  // Tab inserts spaces instead of changing focus
  if (e.key === 'Tab') {
    e.preventDefault();
    var start = fileEditorEditor.selectionStart;
    var end = fileEditorEditor.selectionEnd;
    fileEditorEditor.value = fileEditorEditor.value.substring(0, start) + '  ' + fileEditorEditor.value.substring(end);
    fileEditorEditor.selectionStart = fileEditorEditor.selectionEnd = start + 2;
  }
  // Prevent shortcuts from bubbling to terminal
  e.stopPropagation();
});

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

function renderPlanLimitsMini(result) {
  var el = document.getElementById('plan-limits-mini');
  if (!el) return;
  if (!result || !result.ok || !result.data) {
    el.classList.add('hidden');
    return;
  }
  var d = result.data;
  // Hide if the API returned nothing useful (e.g. API-key user).
  if (!d.five_hour && !d.seven_day) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
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

function startContextMeterPoll(colId) {
  var c = allColumns.get(colId);
  if (!c || c.cmd) return;  // skip non-Claude columns (custom commands)
  function tick() {
    var col = allColumns.get(colId);
    if (!col || !col.ctxMeterEl) return;
    if (!col.sessionId) return;  // session not yet detected — try again next tick
    if (!window.electronAPI || !window.electronAPI.getSessionContextTokens) return;
    window.electronAPI.getSessionContextTokens(col.projectKey, col.sessionId).then(function (tokens) {
      if (tokens == null) return;
      // TODO: col.model is not yet populated — colData has no model field. All
      // current 4.x models are 200k; if 1M-context sessions need accurate limits,
      // parse --model from claudeArgs in addColumn or read opts.env.ANTHROPIC_MODEL.
      var modelKey = col.model || 'sonnet';
      var limit = CTX_LIMIT_CACHE.get(modelKey);
      function draw() {
        col.ctxMeterEl.removeAttribute('hidden');
        var pct = Math.min(100, (tokens / limit) * 100);
        col.ctxFillEl.style.width = pct + '%';
        col.ctxFillEl.classList.toggle('warning', pct >= 70 && pct < 90);
        col.ctxFillEl.classList.toggle('critical', pct >= 90);
        function k(n) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }
        col.ctxTextEl.textContent = k(tokens) + '/' + k(limit);
        col.ctxMeterEl.title = tokens.toLocaleString() + ' / ' + limit.toLocaleString() + ' tokens (' + Math.round(pct) + '%)';
      }
      if (limit) { draw(); return; }
      window.electronAPI.getModelContextLimit(modelKey).then(function (lim) {
        CTX_LIMIT_CACHE.set(modelKey, lim);
        limit = lim;
        draw();
      }).catch(function () { /* fall back silently — pill stays hidden */ });
    }).catch(function () {});
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

function updateColumnDeltaPills(data) {
  if (!data || !data.five_hour) return;
  var nowSession = data.five_hour.utilization;
  if (typeof nowSession !== 'number') return;
  allColumns.forEach(function (c) {
    if (!c.deltaSessionEl) return;
    if (c.spawnSessionPct == null) {
      // Late snapshot: column was spawned before plan-limits data was available.
      // Treat this poll as the baseline so the pill becomes meaningful from now on.
      c.spawnSessionPct = nowSession;
      if (data.seven_day && typeof data.seven_day.utilization === 'number') {
        c.spawnWeeklyPct = data.seven_day.utilization;
      }
    }
    var delta = nowSession - c.spawnSessionPct;
    if (delta < 0) delta = 0;
    c.deltaSessionEl.removeAttribute('hidden');
    c.deltaSessionEl.textContent = 'Δ ' + delta.toFixed(1) + '%';
    c.deltaSessionEl.title =
      'Session usage spent by this column since spawn\n' +
      'Spawn snapshot: ' + c.spawnSessionPct.toFixed(1) + '%\n' +
      'Now: ' + nowSession.toFixed(1) + '%';
  });
}

function promptPauseAutomations(c) {
  if (!window.electronAPI || !window.electronAPI.getAutomationSettings || !window.electronAPI.toggleAutomationsGlobal) return;
  // window.confirm blocks the renderer thread. TODO: replace with a
  // dialog.showMessageBox-backed IPC if blocking becomes a problem.
  var ok = window.confirm(
    'You\'ve crossed 90% of your weekly limit (' + Math.round(c.value) + '%).\n\n' +
    'Pause all your automations? You can re-enable them any time from the Automations panel.'
  );
  if (!ok) return;
  // toggleAutomationsGlobal flips state; only call if currently enabled, otherwise we'd re-enable.
  window.electronAPI.getAutomationSettings().then(function (settings) {
    if (settings && settings.globalEnabled) {
      window.electronAPI.toggleAutomationsGlobal();
    }
  }).catch(function () { /* ignore — silent failure is acceptable here */ });
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

// Initial fetch on app start, only if the page already has focus.
if (document.hasFocus()) {
  loadPlanLimits(false);
  startPlanLimitsPolling();
}

// Click the mini-bar to open the full Usage modal.
(function () {
  var mini = document.getElementById('plan-limits-mini');
  if (mini) mini.addEventListener('click', openUsageModal);
})();

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

// Fetch PTY port (dev uses 3457 to avoid conflict with production on 3456)
if (window.electronAPI && window.electronAPI.getPtyPort) {
  window.electronAPI.getPtyPort().then(function (port) {
    if (port) wsPort = port;
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
});

// ============================================================
// Utility: escapeHtml
// ============================================================

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
      if (hasIsolated) {
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
    preview.automationCount + ' automations, ' + preview.totalAgents + ' agents';
  if (preview.totalManagers > 0) headerHtml += ', ' + preview.totalManagers + ' managers';
  headerHtml += '</div>';
  if (preview.totalIsolated > 0) {
    headerHtml += '<div style="font-size:11px;color:#f59e0b;margin-top:2px;">' + preview.totalIsolated + ' repo clone(s) will be set up after import</div>';
  }
  headerHtml += '</div>';

  // Automation list
  var listHtml = '<div class="import-progress-list">';
  preview.automations.forEach(function (a) {
    var badges = '';
    if (a.hasManager) badges += '<span class="agent-badge agent-badge-chained" style="margin-left:6px;">Manager</span>';
    if (a.hasChaining) badges += '<span class="agent-badge agent-badge-isolated" style="margin-left:4px;">Chained</span>';
    if (a.isolatedCount > 0) badges += '<span class="agent-badge" style="margin-left:4px;background:rgba(59,130,246,0.15);color:#60a5fa;">' + a.isolatedCount + ' clone(s)</span>';

    listHtml += '<div class="import-progress-row">' +
      '<span class="import-progress-icon">&#9711;</span>' +
      '<span class="import-progress-name">' + escapeHtml(a.name) + '</span>' +
      '<span style="font-size:11px;opacity:0.5;">' + a.agentCount + ' agent' + (a.agentCount > 1 ? 's' : '') + '</span>' +
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
          '<div style="font-size:11px;opacity:0.6;margin-top:4px;">' + result.count + ' automations imported (paused)</div>';
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
    '<strong>Imported ' + importResult.count + ' automations (paused)</strong>' +
    '<div class="import-progress-subtitle">Setting up ' + needsClone.length + ' repo clone(s)...</div>' +
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
      '<span class="import-progress-name">' + auto.name + '</span>' +
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
      config.projects.forEach(function (project, index) {
        var normalizedPath = project.path.replace(/\\/g, '/');
        if (projectsWithAttention.has(normalizedPath) && items[index]) {
          var badge = document.createElement('span');
          badge.className = 'project-automation-badge';
          badge.title = 'Automation needs attention';
          var nameEl = items[index].querySelector('.project-name');
          if (nameEl) nameEl.appendChild(badge);
        }
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
      // Release notes can be HTML (from GitHub) or plain text
      if (updateReleaseNotes.indexOf('<') !== -1) {
        updateNotesEl.innerHTML = updateReleaseNotes;
      } else {
        updateNotesEl.textContent = updateReleaseNotes;
      }
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
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); open(); }
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
    if (!t || t.name !== 'search-mode') return;
    var input2 = document.getElementById('session-search-input');
    if (!input2) return;
    if (t.value === 'prompts') {
      input2.placeholder = 'Search your past prompts…';
    } else {
      input2.placeholder = 'Search across all session transcripts…';
    }
    var q = input2.value.trim();
    if (q.length >= 2) runSearch(q);
  });

  function runSearch(q) {
    resultsEl.innerHTML = '<div style="opacity:.6;font-size:12px">Searching…</div>';
    var modeRadio = document.querySelector('input[name=search-mode]:checked');
    var mode = (modeRadio && modeRadio.value) || 'transcripts';
    var apiCall;
    if (mode === 'prompts') {
      if (!window.electronAPI || !window.electronAPI.searchHistory) {
        resultsEl.innerHTML = '<div style="opacity:.6;font-size:12px">Search API not available.</div>';
        return;
      }
      apiCall = window.electronAPI.searchHistory(q, 100).then(function (hits) {
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
      apiCall = window.electronAPI.searchSessions(q, 50);
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

  // Register Ctrl+K in capture phase so xterm can't swallow it.
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === 'k' || e.key === 'K') && !e.shiftKey && !e.altKey) {
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

  function eventMatchesFilter(ev) {
    if (!filterQuery) return true;
    var q = filterQuery.toLowerCase();
    var hay = (ev.event || '') + ' ' + (ev.tool_name || '') + ' ' + (ev.session_id || '') + ' ' + JSON.stringify(ev.tool_input || {});
    return hay.toLowerCase().indexOf(q) !== -1;
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
    detail.textContent = JSON.stringify(ev, null, 2);
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
