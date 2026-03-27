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
var optModel = document.getElementById('opt-model');
var optWorktree = document.getElementById('opt-worktree');
var optCustomArgs = document.getElementById('opt-custom-args');


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

// Loops state
var loopsForProject = [];
var allLoopsData = null;

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
        col2.element.appendChild(createExitOverlay(msg.id, msg.exitCode, col2));
        setColumnActivity(msg.id, 'exited');
        // Refresh run configs to update stop/restart controls
        if (col2.cmd) setTimeout(refreshRunConfigs, 300);
      }
    } else if (msg.type === 'reattach-failed') {
      // Pty died during sleep — show exit overlay so user can respawn
      var col3 = allColumns.get(msg.id);
      if (col3 && !col3.element.querySelector('.exit-overlay')) {
        col3.element.appendChild(createExitOverlay(msg.id, null, col3));
        setColumnActivity(msg.id, 'exited');
      }
    }
  };
  ws.onclose = function () { setTimeout(connectWS, 2000); };
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
  var items = projectListEl.querySelectorAll('.project-item');
  config.projects.forEach(function (project, index) {
    var item = items[index];
    if (!item) return;

    var key = project.path;
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
var notifSettings = { taskbar: true, sidebar: true, header: true };

function loadNotifSettings() {
  if (config.notifications) {
    notifSettings = Object.assign({ taskbar: true, sidebar: true, header: true }, config.notifications);
  }
  var el1 = document.getElementById('setting-notif-taskbar');
  var el2 = document.getElementById('setting-notif-sidebar');
  var el3 = document.getElementById('setting-notif-header');
  if (el1) el1.checked = notifSettings.taskbar;
  if (el2) el2.checked = notifSettings.sidebar;
  if (el3) el3.checked = notifSettings.header;
}

function saveNotifSettings() {
  notifSettings.taskbar = document.getElementById('setting-notif-taskbar').checked;
  notifSettings.sidebar = document.getElementById('setting-notif-sidebar').checked;
  notifSettings.header = document.getElementById('setting-notif-header').checked;
  config.notifications = notifSettings;
  saveConfig();
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
    var items = projectListEl.querySelectorAll('.project-item');
    config.projects.forEach(function (project, index) {
      if (project.path === col.projectKey && items[index]) {
        items[index].classList.add('attention-flash');
      }
    });
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

function saveColumnCounts() {
  for (var i = 0; i < config.projects.length; i++) {
    var key = config.projects[i].path;
    var state = projectStates.get(key);
    config.projects[i].columnCount = state ? state.columns.size : 0;
  }
  saveConfig();
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
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].columnCount === undefined) {
        config.projects[i].columnCount = 1;
      }
    }
    if (config.fontSize) {
      fontSize = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, config.fontSize));
    }
    if (config.theme) {
      setThemePreference(config.theme);
    }
    loadNotifSettings();
    renderProjectList();
    if (config.activeProjectIndex >= 0 && config.projects[config.activeProjectIndex]) {
      setActiveProject(config.activeProjectIndex, true);
    } else {
      showEmptyState();
    }
  });
}

function saveConfig() {
  if (!window.electronAPI) return;
  window.electronAPI.saveProjects(config);
}

function renderProjectList() {
  while (projectListEl.firstChild) {
    projectListEl.removeChild(projectListEl.firstChild);
  }

  config.projects.forEach(function (project, index) {
    var key = project.path;
    var state = projectStates.get(key);
    var count = state ? state.columns.size : 0;

    var item = document.createElement('div');
    item.className = 'project-item';
    if (index === config.activeProjectIndex) item.className += ' active';
    if (projectsNeedingAttention.has(key)) item.className += ' attention-flash';

    var info = document.createElement('div');
    info.style.overflow = 'hidden';
    info.style.flex = '1';

    var name = document.createElement('div');
    name.className = 'project-name';
    name.textContent = project.name;

    var pathEl = document.createElement('div');
    pathEl.className = 'project-path';
    pathEl.textContent = project.path;

    var branchEl = document.createElement('div');
    branchEl.className = 'project-branch';
    branchEl.textContent = '';

    // Fetch branch asynchronously
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

    var removeBtn = document.createElement('span');
    removeBtn.className = 'project-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove project';

    removeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      removeProject(index);
    });

    item.addEventListener('click', function () {
      setActiveProject(index, false);
    });

    rightSide.appendChild(removeBtn);
    item.appendChild(info);
    item.appendChild(rightSide);
    projectListEl.appendChild(item);
  });
  updateLoopSidebarBadges();
}

function setActiveProject(index, isStartup) {
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
  renderProjectList();

  var emptyState = columnsContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  lastGitRaw = null; // invalidate cache on project switch
  var state = getOrCreateProjectState(newKey);
  state.containerEl.style.display = 'flex';
  refreshExplorer();
  if (activeLoopDetailId) closeLoopDetail();
  refreshLoops();
  loadSpawnOptions();

  if (state.columns.size === 0) {
    if (isStartup && window.electronAPI) {
      restoreProjectSessions(newKey, project);
    } else {
      var spawnArgs = buildSpawnArgs();
      addColumn(spawnArgs.length > 0 ? spawnArgs : null);
    }
  } else {
    if (state.focusedColumnId !== null) {
      setFocusedColumn(state.focusedColumnId);
    }
    refitAll();
  }
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
        addColumn(spawnArgs.concat(['--resume', sessionId]), null, title ? { title: title } : {});
      }
    } else {
      addColumn(spawnArgs.length > 0 ? spawnArgs : null);
    }
  });
}

function addProject(folderPath) {
  var parts = folderPath.replace(/\\/g, '/').split('/');
  var name = parts[parts.length - 1] || folderPath;

  for (var i = 0; i < config.projects.length; i++) {
    if (config.projects[i].path === folderPath) {
      setActiveProject(i, false);
      return;
    }
  }

  config.projects.push({ name: name, path: folderPath, columnCount: 1 });
  var newIndex = config.projects.length - 1;
  saveConfig();
  setActiveProject(newIndex, false);
}

function removeProject(index) {
  var project = config.projects[index];
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

  config.projects.splice(index, 1);

  if (config.activeProjectIndex === index) {
    if (config.projects.length > 0) {
      config.activeProjectIndex = Math.min(index, config.projects.length - 1);
      activeProjectKey = null;
      saveConfig();
      setActiveProject(config.activeProjectIndex, false);
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
    effortSelect.title = 'Effort level';
    effortSelect.innerHTML = '<option value="">Effort</option><option value="low">Low</option><option value="medium">Med</option><option value="high">High</option>';
    effortSelect.addEventListener('change', function () {
      if (effortSelect.value) {
        wsSend({ type: 'write', id: id, data: '/config set effort ' + effortSelect.value + '\n' });
      }
    });
    effortSelect.addEventListener('mousedown', function (e) { e.stopPropagation(); });

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
    var restartBtn = document.createElement('span');
    restartBtn.className = 'col-restart';
    restartBtn.dataset.id = String(id);
    restartBtn.title = 'Restart';
    restartBtn.textContent = '\u21bb';
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

  var id = ++globalColumnId;

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
  col.appendChild(termWrapper);
  col.appendChild(scrollBtn);
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
    wsSend({ type: 'write', id: id, data: data });
    var c = allColumns.get(id);
    if (c && data.length > 0 && data.charCodeAt(0) !== 0x1b) {
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

  // Extract session ID if resuming
  var resumeSessionId = null;
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
    customTitle: opts.title || null,
    cmd: cmd,
    cmdArgs: claudeArgs,
    env: opts.env || null,
    launchUrl: opts.launchUrl || null,
    launchUrlOpened: false,
    createdAt: Date.now(),
    hasUserInput: false,
    notified: false
  };

  row.columnIds.push(id);
  state.columns.set(id, colData);
  allColumns.set(id, colData);
  setFocusedColumn(id);
  refitAll();
  saveColumnCounts();
  renderProjectList();

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
  addColumn(null, row);
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
  renderProjectList();
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
            persistSessions(col.projectKey);
            fetchAndSetSessionTitle(columnId, projectPath, sid);
          }
          return;
        }
      }
      detectSession(columnId, projectPath, preExistingIds, attempt + 1);
    });
  }, 2000);
}

// Periodically re-detect session ID for a column (handles /clear, /resume inside CLI)
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

      // Find the most recently modified session not claimed by another column
      var claimed = getClaimedSessionIds(columnId);
      for (var i = 0; i < sessions.length; i++) {
        var sid = sessions[i].sessionId;
        if (!claimed[sid]) {
          if (col2.sessionId !== sid) {
            col2.sessionId = sid;
            persistSessions(col2.projectKey);
            // Update title too
            fetchAndSetSessionTitle(columnId, projectPath, sid);
          }
          return;
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
  renderProjectList();
  updateSidebarActivity();
}

function restartColumn(id) {
  var col = allColumns.get(id);
  if (!col) return;
  if (col.isDiff) return;

  // Kill the current process
  wsSend({ type: 'kill', id: id });

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
    var items = projectListEl.querySelectorAll('.project-item');
    config.projects.forEach(function (project, index) {
      if (project.path === col.projectKey && items[index]) {
        items[index].classList.remove('attention-flash');
      }
    });
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

// ============================================================
// Keyboard Shortcuts
// ============================================================

document.addEventListener('keydown', function (e) {
  if (e.ctrlKey && e.shiftKey && e.key === 'T') {
    e.preventDefault();
    addColumn();
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
  setTimeout(refitAll, 250);
}

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
    else if (tabName === 'loops') { stopGitPolling(); refreshLoops(); }
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
    e.preventDefault();
  });
});

function toggleExplorer() {
  explorerPanel.classList.toggle('collapsed');
  explorerResizeHandle.classList.toggle('hidden');
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

function refreshGitStatus(force) {
  if (!activeProjectKey || !window.electronAPI) return;

  var fetchAll = [
    window.electronAPI.gitStatus(activeProjectKey),
    window.electronAPI.gitBranch(activeProjectKey),
    window.electronAPI.gitAheadBehind(activeProjectKey),
    window.electronAPI.gitStashList(activeProjectKey),
    window.electronAPI.gitGraphLog(activeProjectKey, 50),
    window.electronAPI.gitDiffStat(activeProjectKey, false),
    window.electronAPI.gitDiffStat(activeProjectKey, true)
  ];

  if (!force) {
    Promise.all(fetchAll).then(function (results) {
      var rawKey = JSON.stringify(results[0]) + '|' + results[1] + '|' + JSON.stringify(results[2]) + '|' + results[3].length + '|' + JSON.stringify(results[4]);
      if (rawKey === lastGitRaw) return;
      lastGitRaw = rawKey;
      renderGitStatus(results[0], results[1], results[2], results[3], results[4], results[5], results[6]);
    });
    return;
  }

  lastGitRaw = null;
  Promise.all(fetchAll).then(function (results) {
    lastGitRaw = JSON.stringify(results[0]) + '|' + results[1] + '|' + JSON.stringify(results[2]) + '|' + results[3].length + '|' + JSON.stringify(results[4]);
    renderGitStatus(results[0], results[1], results[2], results[3], results[4], results[5], results[6]);
  });
}

function renderGitStatus(files, branch, aheadBehind, stashes, graphLog, unstagedStats, stagedStats) {
  graphLaneState = null;
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
  else if (tabName === 'loops') refreshLoops();
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
  var args = buildSpawnArgs();
  addColumn(args.length > 0 ? args : null);
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
  if (optBare.checked) {
    args.push('--bare');
  }
  if (optModel.value) {
    args.push('--model', optModel.value);
  }
  var worktree = optWorktree.value.trim();
  if (worktree) {
    args.push('--worktree', worktree);
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

function updateSpawnButtonLabel() {
  var tags = [];
  if (optModel.value) tags.push(optModel.value);
  if (optSkipPermissions.checked) tags.push('yolo');
  if (optRemoteControl.checked) tags.push('remote');
  if (optBare.checked) tags.push('bare');
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
    model: optModel.value,
    worktree: optWorktree.value,
    customArgs: optCustomArgs.value
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
  optModel.value = opts.model || '';
  optWorktree.value = opts.worktree || '';
  optCustomArgs.value = opts.customArgs || '';
  updateSpawnButtonLabel();
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
optModel.addEventListener('change', onSpawnOptionChanged);
optWorktree.addEventListener('input', onSpawnOptionChanged);
optCustomArgs.addEventListener('input', onSpawnOptionChanged);

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
      !modelSelectOpen) {
    closeSpawnDropdown();
  }
});

// Prevent dropdown clicks from closing it
spawnDropdown.addEventListener('click', function (e) {
  e.stopPropagation();
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

function openUsageModal() {
  usageModal.classList.remove('hidden');
  usageLoading.style.display = '';
  usageContent.classList.add('hidden');
  usageSubtitle.textContent = '';

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
  var totalInput = 0, totalOutput = 0, totalCacheRead = 0;
  var last7dMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  var week7Input = 0, week7Output = 0, week7Cache = 0, week7Sessions = 0;
  var projectSet7 = new Set(), projectSetAll = new Set();
  var earliestTs = Infinity, latestTs = 0;

  function emptyModelTokens() {
    return { opus: {input:0,output:0,cache:0}, sonnet: {input:0,output:0,cache:0}, haiku: {input:0,output:0,cache:0}, unknown: {input:0,output:0,cache:0} };
  }
  var allModelTokens = emptyModelTokens();
  var week7ModelTokens = emptyModelTokens();

  for (var i = 0; i < data.length; i++) {
    var s = data[i];
    var sessionInput = s.inputTokens + s.cacheReadTokens + s.cacheCreationTokens;
    totalInput += sessionInput;
    totalOutput += s.outputTokens;
    totalCacheRead += s.cacheReadTokens;
    projectSetAll.add(s.projectKey);

    var modelClass = classifyModel(s.model);
    allModelTokens[modelClass].input += sessionInput;
    allModelTokens[modelClass].output += s.outputTokens;
    allModelTokens[modelClass].cache += s.cacheReadTokens;

    if (s.firstTimestamp && s.firstTimestamp < earliestTs) earliestTs = s.firstTimestamp;
    if (s.lastTimestamp && s.lastTimestamp > latestTs) latestTs = s.lastTimestamp;

    if (s.lastTimestamp >= last7dMs) {
      week7Input += sessionInput;
      week7Output += s.outputTokens;
      week7Cache += s.cacheReadTokens;
      week7Sessions++;
      projectSet7.add(s.projectKey);
      week7ModelTokens[modelClass].input += sessionInput;
      week7ModelTokens[modelClass].output += s.outputTokens;
      week7ModelTokens[modelClass].cache += s.cacheReadTokens;
    }
  }

  // Calculate actual data span in days
  var dataSpanDays = earliestTs < Infinity ? Math.ceil((Date.now() - earliestTs) / (24 * 60 * 60 * 1000)) : 0;

  var periods = {
    '7d':  { input: week7Input,  output: week7Output,  cache: week7Cache,    sessions: week7Sessions,   projects: projectSet7.size, modelTokens: week7ModelTokens },
    'all': { input: totalInput,   output: totalOutput,   cache: totalCacheRead, sessions: data.length,   projects: projectSetAll.size, modelTokens: allModelTokens }
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

  function renderPeriod(period) {
    var p = periods[period];

    var container = document.getElementById('usage-summary-cards');
    container.textContent = '';
    container.appendChild(buildUsageCard('Total Tokens', formatTokenCount(p.input + p.output), formatTokenCount(p.input) + ' in / ' + formatTokenCount(p.output) + ' out'));
    container.appendChild(buildUsageCard('Cache Savings', formatTokenCount(p.cache), 'read from cache'));
    container.appendChild(buildUsageCard('Sessions', String(p.sessions), p.projects + ' projects'));

    var chartTitle = document.getElementById('usage-chart-title');
    if (chartTitle) chartTitle.textContent = periodLabels[period];
    renderBarChart('usage-chart-30d', data, chartDays[period]);
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

function renderEnvironmentalImpact(modelTokens, periodLabel) {
  // Carbon intensity: Google Cloud / AWS average (kg CO2 per kWh)
  var KG_CO2_PER_KWH = 0.12;

  // Calculate energy per model
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
  // Calculate percentages
  for (var bi = 0; bi < modelBreakdown.length; bi++) {
    modelBreakdown[bi].pct = energyWh > 0 ? Math.round(modelBreakdown[bi].wh / energyWh * 100) : 0;
  }

  var energyKwh = energyWh / 1000;
  var co2Kg = energyKwh * KG_CO2_PER_KWH;
  var co2G = co2Kg * 1000;

  // Format energy
  var energyStr, energyUnit;
  if (energyWh < 1) {
    energyStr = (energyWh * 1000).toFixed(1);
    energyUnit = 'mWh';
  } else if (energyWh < 1000) {
    energyStr = energyWh.toFixed(1);
    energyUnit = 'Wh';
  } else {
    energyStr = energyKwh.toFixed(2);
    energyUnit = 'kWh';
  }

  // Format CO2
  var co2Str, co2Unit;
  if (co2G < 1) {
    co2Str = (co2G * 1000).toFixed(1);
    co2Unit = 'mg';
  } else if (co2G < 1000) {
    co2Str = co2G.toFixed(1);
    co2Unit = 'g';
  } else {
    co2Str = co2Kg.toFixed(2);
    co2Unit = 'kg';
  }

  // Real-world equivalents (sorted small to large by CO2 in grams)
  var equivalents = [
    { icon: '\uD83D\uDD0D', g: 0.3,   unit: 'Google searches' },
    { icon: '\uD83D\uDCA1', g: 1.2,   unit: 'hours of an LED bulb' },
    { icon: '\uD83D\uDCF1', g: 0.96,  unit: 'phone charges' },
    { icon: '\uD83C\uDF75', g: 15,    unit: 'cups of tea (boiling the kettle)' },
    { icon: '\uD83C\uDFAC', g: 36,    unit: 'hours of Netflix streaming' },
    { icon: '\uD83D\uDEC1', g: 500,   unit: '5-minute hot showers' },
    { icon: '\uD83D\uDE97', g: 404,   unit: 'miles driven in a car' },
    { icon: '\u2708\uFE0F', g: 255000, unit: 'London\u2013NYC flights' }
  ];

  // Pick the best equivalent (aim for a count between 1 and 200)
  var best = null;
  var bestCount = 0;
  for (var i = 0; i < equivalents.length; i++) {
    var count = co2G / equivalents[i].g;
    if (count >= 0.3 && (best === null || (count >= 1 && count <= 200))) {
      best = equivalents[i];
      bestCount = count;
    }
  }
  if (!best) {
    best = equivalents[0];
    bestCount = co2G / best.g;
  }

  var countStr;
  if (bestCount < 0.01) countStr = '< 0.01';
  else if (bestCount < 1) countStr = bestCount.toFixed(2);
  else if (bestCount < 10) countStr = bestCount.toFixed(1);
  else countStr = Math.round(bestCount).toLocaleString();

  var container = document.getElementById('usage-environmental');
  container.textContent = '';

  // Header
  var header = document.createElement('div');
  header.className = 'usage-env-header';
  var headerIcon = document.createElement('span');
  headerIcon.className = 'usage-env-icon';
  headerIcon.textContent = '\uD83C\uDF0D';
  var headerTitle = document.createElement('span');
  headerTitle.className = 'usage-env-title';
  headerTitle.textContent = 'Environmental Impact \u2014 ' + (periodLabel || 'All Time') + ' (estimated)';
  header.appendChild(headerIcon);
  header.appendChild(headerTitle);
  container.appendChild(header);

  // Stats grid
  var grid = document.createElement('div');
  grid.className = 'usage-env-grid';

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

  // Build sub-label showing model mix
  var modelMixParts = [];
  for (var mi2 = 0; mi2 < modelBreakdown.length; mi2++) {
    modelMixParts.push(modelBreakdown[mi2].name + ' ' + modelBreakdown[mi2].pct + '%');
  }
  var modelMixStr = modelMixParts.length > 0 ? modelMixParts.join(', ') : 'no model data';

  grid.appendChild(buildEnvStat('Energy Used', energyStr, energyUnit, modelMixStr));
  grid.appendChild(buildEnvStat('CO\u2082 Emissions', co2Str, co2Unit, KG_CO2_PER_KWH * 1000 + ' g/kWh cloud avg'));
  container.appendChild(grid);

  // Equivalent
  var equiv = document.createElement('div');
  equiv.className = 'usage-env-equivalent';
  var eqIcon = document.createElement('span');
  eqIcon.className = 'usage-env-equiv-icon';
  eqIcon.textContent = best.icon;
  var eqText = document.createElement('span');
  eqText.className = 'usage-env-equiv-text';
  eqText.textContent = "That's about the same as ";
  var eqBold = document.createElement('strong');
  eqBold.textContent = countStr + ' ' + best.unit;
  eqText.appendChild(eqBold);
  equiv.appendChild(eqIcon);
  equiv.appendChild(eqText);
  container.appendChild(equiv);

  // Disclaimer
  var disc = document.createElement('div');
  disc.className = 'usage-env-disclaimer';
  disc.textContent = 'Energy estimated per model tier using published inference research (Luccioni et al. 2024, IEA 2024), scaled by API pricing ratios. Includes 1.1\u00D7 PUE. Actual values depend on hardware, batch size, and data centre location.';
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

// ============================================================
// Loops Tab
// ============================================================

function refreshLoops() {
  var listEl = document.getElementById('loops-list');
  var noProjectEl = document.getElementById('loops-no-project');
  if (!listEl) return;

  if (!activeProjectKey) {
    listEl.innerHTML = '';
    if (noProjectEl) noProjectEl.style.display = '';
    return;
  }
  if (noProjectEl) noProjectEl.style.display = 'none';

  window.electronAPI.getLoopsForProject(activeProjectKey).then(function (loops) {
    loopsForProject = loops;
    renderLoopCards(loops, listEl);
  });
  updateLoopsTabIndicator();
}

function formatTimeHHMM(h, m) {
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function formatLoopScheduleText(loop) {
  if (loop.schedule.type === 'interval') {
    var mins = loop.schedule.minutes;
    return mins >= 60 ? 'Every ' + (mins / 60) + 'h' : 'Every ' + mins + 'm';
  }
  if (loop.schedule.type === 'app_startup') {
    return loop.firstStartOnly ? 'First start of day' : 'App startup';
  }
  // time_of_day with multiple times
  var times = loop.schedule.times || [{ hour: loop.schedule.hour, minute: loop.schedule.minute || 0 }];
  if (times.length === 1) {
    return 'Daily ' + formatTimeHHMM(times[0].hour, times[0].minute);
  }
  var labels = times.map(function (t) { return formatTimeHHMM(t.hour, t.minute); });
  return labels.join(', ');
}

function getNextScheduledTime(loop) {
  var times = loop.schedule.times || [{ hour: loop.schedule.hour, minute: loop.schedule.minute || 0 }];
  var now = new Date();
  var nowMinutes = now.getHours() * 60 + now.getMinutes();
  var dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var lastRun = loop.lastRunAt ? new Date(loop.lastRunAt) : null;

  // Check remaining times today
  var today = dayNames[now.getDay()];
  var todayAllowed = !loop.schedule.days || loop.schedule.days.length === 0 || loop.schedule.days.indexOf(today) !== -1;
  if (todayAllowed) {
    for (var i = 0; i < times.length; i++) {
      var sm = times[i].hour * 60 + times[i].minute;
      if (sm > nowMinutes) {
        var next = new Date(now);
        next.setHours(times[i].hour, times[i].minute, 0, 0);
        return next.getTime();
      }
      // If time has passed but hasn't run yet today for this slot
      if (sm <= nowMinutes && lastRun) {
        var lastRunMinutes = lastRun.getHours() * 60 + lastRun.getMinutes();
        if (lastRun.toDateString() !== now.toDateString() || lastRunMinutes < sm) {
          return Date.now(); // due now
        }
      }
    }
  }

  // Find next allowed day
  for (var d = 1; d <= 7; d++) {
    var futureDate = new Date(now);
    futureDate.setDate(futureDate.getDate() + d);
    var futureDay = dayNames[futureDate.getDay()];
    if (!loop.schedule.days || loop.schedule.days.length === 0 || loop.schedule.days.indexOf(futureDay) !== -1) {
      futureDate.setHours(times[0].hour, times[0].minute, 0, 0);
      return futureDate.getTime();
    }
  }
  return null;
}

function renderLoopCards(loops, container) {
  container.innerHTML = '';

  if (loops.length === 0) {
    container.innerHTML = '<p style="opacity:0.5;text-align:center;padding:2rem 1rem;font-size:12px;">No loops configured.<br>Click + to create one.</p>';
    return;
  }

  loops.forEach(function (loop) {
    var card = document.createElement('div');
    card.className = 'loop-card';

    var statusClass = 'loop-idle';
    var badgeClass = 'badge-idle';
    var badgeText = 'idle';

    if (!loop.enabled) {
      statusClass = 'loop-disabled';
      badgeClass = 'badge-disabled';
      badgeText = 'disabled';
    } else if (loop.currentRunStartedAt) {
      statusClass = 'loop-running';
      badgeClass = 'badge-running';
      badgeText = 'running...';
    } else if (loop.lastRunStatus === 'error') {
      statusClass = 'loop-error';
      badgeClass = 'badge-error';
      badgeText = 'error';
    } else if (loop.lastRunStatus === 'completed') {
      badgeClass = 'badge-idle';
      badgeText = 'idle';
    }

    card.classList.add(statusClass);

    var schedText = formatLoopScheduleText(loop);


    var lastRunText = '';
    if (loop.lastRunAt) {
      var elapsed = Date.now() - new Date(loop.lastRunAt).getTime();
      if (elapsed < 60000) lastRunText = 'Last: just now';
      else if (elapsed < 3600000) lastRunText = 'Last: ' + Math.floor(elapsed / 60000) + 'm ago';
      else if (elapsed < 86400000) lastRunText = 'Last: ' + Math.floor(elapsed / 3600000) + 'h ago';
      else lastRunText = 'Last: ' + Math.floor(elapsed / 86400000) + 'd ago';
    } else {
      lastRunText = 'Never run';
    }

    var nextRunText = '';
    if (loop.enabled && loop.schedule.type === 'app_startup') {
      nextRunText = 'Next: app restart';
    } else if (loop.enabled && loop.schedule.type === 'interval') {
      if (loop.lastRunAt) {
        var nextMs = new Date(loop.lastRunAt).getTime() + loop.schedule.minutes * 60000 - Date.now();
        if (nextMs <= 0) nextRunText = 'Due now';
        else if (nextMs < 60000) nextRunText = 'Next: <1m';
        else if (nextMs < 3600000) nextRunText = 'Next: ' + Math.floor(nextMs / 60000) + 'm';
        else nextRunText = 'Next: ' + Math.floor(nextMs / 3600000) + 'h';
      } else {
        nextRunText = 'Next: pending';
      }
    } else if (loop.enabled && loop.schedule.type === 'time_of_day') {
      var nextTime = getNextScheduledTime(loop);
      if (nextTime) {
        var diff = nextTime - Date.now();
        if (diff <= 0) nextRunText = 'Due now';
        else if (diff < 60000) nextRunText = 'Next: <1m';
        else if (diff < 3600000) nextRunText = 'Next: ' + Math.floor(diff / 60000) + 'm';
        else if (diff < 86400000) nextRunText = 'Next: ' + Math.floor(diff / 3600000) + 'h';
        else nextRunText = 'Next: ' + Math.floor(diff / 86400000) + 'd';
      }
    }

    var isRunning = !!loop.currentRunStartedAt;
    var toggleIcon = loop.enabled ? '&#10074;&#10074;' : '&#9654;';
    var toggleTitle = loop.enabled ? 'Pause' : 'Enable';

    var actionsHtml = '<span class="loop-card-actions">' +
      '<button class="loop-btn-toggle" title="' + toggleTitle + '">' + toggleIcon + '</button>';

    if (!isRunning) {
      actionsHtml += '<button class="loop-btn-run" title="Run Now">&#9655;</button>';
    }

    actionsHtml += '<button class="loop-btn-edit" title="Edit">&#9998;</button>' +
      '<button class="loop-btn-delete" title="Delete">&times;</button>' +
      '</span>';

    var summaryHtml = '';
    if (isRunning) {
      summaryHtml = '<div class="loop-card-summary loop-card-summary-running">Running...</div>';
    } else if (loop.lastSummary) {
      summaryHtml = '<div class="loop-card-summary">' + escapeHtml(loop.lastSummary) + '</div>';
    }

    var attentionHtml = '';
    if (loop.lastAttentionItems && loop.lastAttentionItems.length > 0) {
      attentionHtml = '<div class="loop-card-attention-summary">';
      loop.lastAttentionItems.forEach(function (item) {
        attentionHtml += '<div class="loop-card-attention-item">&#9888; ' + escapeHtml(item.summary) + '</div>';
      });
      attentionHtml += '</div>';
    }

    var html = '<div class="loop-card-header">' +
      '<span class="loop-card-name">' + escapeHtml(loop.name) + '</span>' +
      '<span class="loop-card-schedule">' + schedText + '</span>' +
      '</div>' +
      '<div class="loop-card-status">' + lastRunText + '</div>' +
      summaryHtml +
      attentionHtml +
      '<div class="loop-card-footer">' +
        '<span class="loop-status-badge ' + badgeClass + '">' + badgeText + '</span>' +
        (nextRunText ? '<span class="loop-card-next">' + nextRunText + '</span>' : '') +
        actionsHtml +
      '</div>';

    card.innerHTML = html;
    card.style.cursor = 'pointer';

    card.addEventListener('click', function () {
      openLoopDetail(loop);
    });

    card.querySelector('.loop-btn-toggle').addEventListener('click', function (e) {
      e.stopPropagation();
      window.electronAPI.toggleLoop(loop.id).then(function () { refreshLoops(); });
    });
    var runBtn = card.querySelector('.loop-btn-run');
    if (runBtn) {
      runBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        window.electronAPI.runLoopNow(loop.id);
        refreshLoops();
      });
    }
    card.querySelector('.loop-btn-edit').addEventListener('click', function (e) {
      e.stopPropagation();
      openLoopModal(loop);
    });
    card.querySelector('.loop-btn-delete').addEventListener('click', function (e) {
      e.stopPropagation();
      if (confirm('Delete loop "' + loop.name + '"?')) {
        window.electronAPI.deleteLoop(loop.id).then(function () { refreshLoops(); });
      }
    });

    container.appendChild(card);
  });
}

// ============================================================
// Loop Detail Panel
// ============================================================

var activeLoopDetailId = null;
var loopDetailViewingLive = false;

function openLoopDetail(loop) {
  activeLoopDetailId = loop.id;
  var listEl = document.getElementById('loops-list');
  var detailEl = document.getElementById('loop-detail-panel');
  var headerEl = document.querySelector('#tab-loops .explorer-section-header');

  listEl.style.display = 'none';
  if (headerEl) headerEl.style.display = 'none';
  detailEl.style.display = 'flex';

  document.getElementById('loop-detail-name').textContent = loop.name;

  var isRunning = !!loop.currentRunStartedAt;
  var badge = document.getElementById('loop-detail-status-badge');
  if (isRunning) {
    badge.className = 'loop-status-badge badge-running';
    badge.textContent = 'running...';
  } else if (!loop.enabled) {
    badge.className = 'loop-status-badge badge-disabled';
    badge.textContent = 'disabled';
  } else if (loop.lastRunStatus === 'error') {
    badge.className = 'loop-status-badge badge-error';
    badge.textContent = 'error';
  } else {
    badge.className = 'loop-status-badge badge-idle';
    badge.textContent = 'idle';
  }

  // Meta info
  var schedText = formatLoopScheduleText(loop);
  var metaEl = document.getElementById('loop-detail-meta');
  metaEl.innerHTML = '<span>' + schedText + '</span>' +
    (loop.lastRunAt ? '<span>Last: ' + new Date(loop.lastRunAt).toLocaleTimeString() + '</span>' : '<span>Never run</span>') +
    '<span>' + escapeHtml(loop.prompt.substring(0, 80)) + (loop.prompt.length > 80 ? '...' : '') + '</span>';

  var outputEl = document.getElementById('loop-detail-output');
  var selectEl = document.getElementById('loop-detail-run-select');

  // Build the dropdown: live option (if running) + past runs
  selectEl.innerHTML = '';
  if (isRunning) {
    var liveOpt = document.createElement('option');
    liveOpt.value = 'live';
    liveOpt.textContent = 'Live (running)';
    selectEl.appendChild(liveOpt);
  }

  // Always load past runs into dropdown
  window.electronAPI.getLoopHistory(loop.id, 10).then(function (runs) {
    runs.forEach(function (run, i) {
      var opt = document.createElement('option');
      opt.value = run.startedAt;
      var t = new Date(run.startedAt);
      opt.textContent = (i === 0 && !isRunning ? 'Latest — ' : '') + t.toLocaleString() + ' (' + run.status + ')';
      selectEl.appendChild(opt);
    });

    if (!isRunning && runs.length === 0) {
      selectEl.innerHTML = '<option>No runs yet</option>';
      outputEl.textContent = 'This loop has not run yet.';
      showRunSummary(null);
      return;
    }

    // Show the right content based on state
    if (isRunning) {
      switchToLiveView(loop);
    } else if (runs.length > 0) {
      switchToRunView(loop.id, runs[0].startedAt);
    }
  });
}

function switchToLiveView(loop) {
  loopDetailViewingLive = true;
  var outputEl = document.getElementById('loop-detail-output');
  showRunSummary(null); // hide summary while live

  outputEl.innerHTML = '<span class="loop-processing-indicator">Processing...</span>';
  window.electronAPI.getLoopLiveOutput(loop.id).then(function (output) {
    // Only update if still viewing live
    if (!loopDetailViewingLive || activeLoopDetailId !== loop.id) return;
    if (output) {
      outputEl.textContent = output;
      outputEl.scrollTop = outputEl.scrollHeight;
    }
    // else keep showing "Processing..." indicator
  });
}

function switchToRunView(loopId, startedAt) {
  loopDetailViewingLive = false;
  var outputEl = document.getElementById('loop-detail-output');
  outputEl.textContent = 'Loading...';
  window.electronAPI.getLoopRunDetail(loopId, startedAt).then(function (run) {
    if (!run) {
      outputEl.textContent = 'Run data not found.';
      showRunSummary(null);
      return;
    }
    showRunSummary(run);
    outputEl.textContent = run.output || '(no output)';
    outputEl.scrollTop = 0;
  });
}

function showRunSummary(run) {
  var summaryEl = document.getElementById('loop-detail-summary');
  var attentionEl = document.getElementById('loop-detail-attention');

  if (run && run.summary) {
    summaryEl.textContent = run.summary;
    summaryEl.style.display = '';
  } else {
    summaryEl.style.display = 'none';
  }

  if (run && run.attentionItems && run.attentionItems.length > 0) {
    attentionEl.innerHTML = '';
    run.attentionItems.forEach(function (item) {
      var itemEl = document.createElement('div');
      itemEl.className = 'loop-detail-attention-item';
      itemEl.innerHTML = '<span class="attention-icon">&#9888;</span><div>' +
        '<div>' + escapeHtml(item.summary) + '</div>' +
        (item.detail ? '<div class="loop-detail-attention-detail">' + escapeHtml(item.detail) + '</div>' : '') +
        '</div>';
      attentionEl.appendChild(itemEl);
    });
    attentionEl.style.display = '';
  } else {
    attentionEl.style.display = 'none';
  }
}

function closeLoopDetail() {
  activeLoopDetailId = null;
  loopDetailViewingLive = false;
  var listEl = document.getElementById('loops-list');
  var detailEl = document.getElementById('loop-detail-panel');
  var headerEl = document.querySelector('#tab-loops .explorer-section-header');

  detailEl.style.display = 'none';
  listEl.style.display = '';
  if (headerEl) headerEl.style.display = '';
}

document.getElementById('btn-loop-detail-back').addEventListener('click', closeLoopDetail);

document.getElementById('loop-detail-run-select').addEventListener('change', function () {
  if (!activeLoopDetailId) return;
  if (this.value === 'live') {
    // Switch back to live view
    window.electronAPI.getLoopsForProject(activeProjectKey).then(function (loops) {
      var loop = loops.find(function (l) { return l.id === activeLoopDetailId; });
      if (loop) switchToLiveView(loop);
    });
  } else if (this.value) {
    switchToRunView(activeLoopDetailId, this.value);
  }
});

// ============================================================
// Loop Modal (New / Edit)
// ============================================================

var loopEditingId = null;

var loopModalTimes = []; // tracks scheduled times for the modal

function openLoopModal(existingLoop) {
  loopEditingId = existingLoop ? existingLoop.id : null;
  document.getElementById('loop-modal-title').textContent = existingLoop ? 'Edit Loop' : 'New Loop';
  document.getElementById('btn-loop-save').textContent = existingLoop ? 'Save Changes' : 'Create Loop';

  document.getElementById('loop-name').value = existingLoop ? existingLoop.name : '';
  document.getElementById('loop-prompt').value = existingLoop ? existingLoop.prompt : '';

  var schedType = existingLoop ? existingLoop.schedule.type : 'interval';
  document.getElementById('loop-schedule-type').value = schedType;
  toggleScheduleFields(schedType);

  if (existingLoop && existingLoop.schedule.type === 'interval') {
    var mins = existingLoop.schedule.minutes;
    if (mins >= 60 && mins % 60 === 0) {
      document.getElementById('loop-interval-value').value = mins / 60;
      document.getElementById('loop-interval-unit').value = 'hours';
    } else {
      document.getElementById('loop-interval-value').value = mins;
      document.getElementById('loop-interval-unit').value = 'minutes';
    }
  } else {
    document.getElementById('loop-interval-value').value = 60;
    document.getElementById('loop-interval-unit').value = 'minutes';
  }

  // Multi-time support
  loopModalTimes = [];
  if (existingLoop && existingLoop.schedule.type === 'time_of_day') {
    if (existingLoop.schedule.times) {
      loopModalTimes = existingLoop.schedule.times.slice();
    } else if (existingLoop.schedule.hour !== undefined) {
      // Legacy single-time format
      loopModalTimes = [{ hour: existingLoop.schedule.hour, minute: existingLoop.schedule.minute || 0 }];
    }
    var checkboxes = document.querySelectorAll('#loop-tod-days input[type="checkbox"]');
    checkboxes.forEach(function (cb) {
      cb.checked = existingLoop.schedule.days ? existingLoop.schedule.days.indexOf(cb.value) !== -1 : false;
    });
  }
  document.getElementById('loop-tod-time').value = '09:00';
  renderLoopTimeChips();

  document.getElementById('loop-first-start-only').checked = existingLoop ? !!existingLoop.firstStartOnly : false;
  document.getElementById('loop-skip-permissions').checked = existingLoop ? !!existingLoop.skipPermissions : false;
  document.getElementById('loop-db-connection').value = existingLoop ? (existingLoop.dbConnectionString || '') : '';
  document.getElementById('loop-db-connection').type = 'password';
  document.getElementById('loop-db-readonly').checked = existingLoop ? (existingLoop.dbReadOnly !== false) : true;
  document.getElementById('loop-db-show').checked = false;

  document.getElementById('loop-modal-overlay').classList.remove('hidden');
  document.getElementById('loop-name').focus();
}

function addLoopTime() {
  var timeVal = document.getElementById('loop-tod-time').value;
  if (!timeVal) return;
  var parts = timeVal.split(':');
  var h = parseInt(parts[0]);
  var m = parseInt(parts[1]);
  // Avoid duplicates
  var exists = loopModalTimes.some(function (t) { return t.hour === h && t.minute === m; });
  if (exists) return;
  loopModalTimes.push({ hour: h, minute: m });
  // Sort chronologically
  loopModalTimes.sort(function (a, b) { return (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute); });
  renderLoopTimeChips();
}

function removeLoopTime(index) {
  loopModalTimes.splice(index, 1);
  renderLoopTimeChips();
}

function renderLoopTimeChips() {
  var container = document.getElementById('loop-tod-times-list');
  container.innerHTML = '';
  if (loopModalTimes.length === 0) {
    container.innerHTML = '<span style="opacity:0.4;font-size:11px;">No times added yet — use the picker above</span>';
    return;
  }
  loopModalTimes.forEach(function (t, i) {
    var chip = document.createElement('span');
    chip.className = 'loop-time-chip';
    var label = (t.hour < 10 ? '0' : '') + t.hour + ':' + (t.minute < 10 ? '0' : '') + t.minute;
    chip.innerHTML = label + '<button type="button" class="loop-time-chip-remove" title="Remove">&times;</button>';
    chip.querySelector('.loop-time-chip-remove').addEventListener('click', function () {
      removeLoopTime(i);
    });
    container.appendChild(chip);
  });
}

function closeLoopModal() {
  document.getElementById('loop-modal-overlay').classList.add('hidden');
  loopEditingId = null;
}

function toggleScheduleFields(type) {
  document.getElementById('loop-interval-fields').style.display = type === 'interval' ? '' : 'none';
  document.getElementById('loop-tod-fields').style.display = type === 'time_of_day' ? '' : 'none';
  document.getElementById('loop-startup-fields').style.display = type === 'app_startup' ? '' : 'none';
}

function saveLoop() {
  var name = document.getElementById('loop-name').value.trim();
  var prompt = document.getElementById('loop-prompt').value.trim();
  if (!name || !prompt) { alert('Name and prompt are required.'); return; }
  if (!activeProjectKey) { alert('Select a project first.'); return; }

  var schedType = document.getElementById('loop-schedule-type').value;
  var schedule;
  if (schedType === 'interval') {
    var val = parseInt(document.getElementById('loop-interval-value').value) || 60;
    var unit = document.getElementById('loop-interval-unit').value;
    schedule = { type: 'interval', minutes: unit === 'hours' ? val * 60 : val };
  } else if (schedType === 'app_startup') {
    schedule = { type: 'app_startup' };
  } else {
    if (loopModalTimes.length === 0) { alert('Add at least one scheduled time.'); return; }
    var days = [];
    document.querySelectorAll('#loop-tod-days input:checked').forEach(function (cb) {
      days.push(cb.value);
    });
    schedule = { type: 'time_of_day', times: loopModalTimes.slice(), days: days };
  }

  var firstStartOnly = document.getElementById('loop-first-start-only').checked;
  var skipPermissions = document.getElementById('loop-skip-permissions').checked;
  var dbConnectionString = document.getElementById('loop-db-connection').value.trim() || null;
  var dbReadOnly = document.getElementById('loop-db-readonly').checked;

  if (loopEditingId) {
    window.electronAPI.updateLoop(loopEditingId, {
      name: name, prompt: prompt, schedule: schedule, firstStartOnly: firstStartOnly,
      skipPermissions: skipPermissions, dbConnectionString: dbConnectionString, dbReadOnly: dbReadOnly
    }).then(function () {
      closeLoopModal();
      refreshLoops();
      refreshLoopsFlyout();
    });
  } else {
    window.electronAPI.createLoop({
      name: name, prompt: prompt, projectPath: activeProjectKey, schedule: schedule,
      firstStartOnly: firstStartOnly, skipPermissions: skipPermissions,
      dbConnectionString: dbConnectionString, dbReadOnly: dbReadOnly, createdBy: 'ui'
    }).then(function () {
      closeLoopModal();
      refreshLoops();
      refreshLoopsFlyout();
    });
  }
}

document.getElementById('loop-schedule-type').addEventListener('change', function () {
  toggleScheduleFields(this.value);
});
document.getElementById('btn-loop-add-time').addEventListener('click', addLoopTime);
document.getElementById('loop-tod-time').addEventListener('keydown', function (e) {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); addLoopTime(); }
});
// Prevent keyboard shortcuts from stealing input in loop modal
['loop-name', 'loop-prompt', 'loop-db-connection'].forEach(function (id) {
  document.getElementById(id).addEventListener('keydown', function (e) {
    e.stopPropagation();
  });
});

// Show/hide connection string toggle
document.getElementById('loop-db-show').addEventListener('change', function () {
  document.getElementById('loop-db-connection').type = this.checked ? 'text' : 'password';
});

document.getElementById('btn-loop-modal-close').addEventListener('click', closeLoopModal);
document.getElementById('btn-loop-cancel').addEventListener('click', closeLoopModal);
document.getElementById('btn-loop-save').addEventListener('click', saveLoop);
document.getElementById('loop-modal-overlay').addEventListener('click', function (e) {
  // Only cancel/close buttons should dismiss the loop modal
});
document.getElementById('btn-add-loop').addEventListener('click', function () {
  if (!activeProjectKey) { alert('Select a project first.'); return; }
  openLoopModal(null);
});
document.getElementById('btn-refresh-loops').addEventListener('click', refreshLoops);

// ============================================================
// Loops Flyout Dashboard
// ============================================================

function toggleLoopsFlyout() {
  var flyout = document.getElementById('loops-flyout');
  flyout.classList.toggle('hidden');
  if (!flyout.classList.contains('hidden')) {
    refreshLoopsFlyout();
  }
}

function refreshLoopsFlyout() {
  var flyout = document.getElementById('loops-flyout');
  if (!flyout || flyout.classList.contains('hidden')) return;

  window.electronAPI.getLoops().then(function (data) {
    allLoopsData = data;
    var listEl = document.getElementById('loops-flyout-list');
    var countsEl = document.getElementById('loops-flyout-counts');

    var globalBtn = document.getElementById('btn-loops-global-toggle');
    globalBtn.innerHTML = data.globalEnabled ? '&#10074;&#10074;' : '&#9654;';
    globalBtn.title = data.globalEnabled ? 'Pause all loops' : 'Resume all loops';

    var active = data.loops.filter(function (l) { return l.enabled; }).length;
    var attention = data.loops.filter(function (l) {
      return l.lastRunStatus === 'error' || l.lastError;
    }).length;
    countsEl.textContent = active + ' active' + (attention > 0 ? ' \u00b7 ' + attention + ' need attention' : '');

    var byProject = {};
    data.loops.forEach(function (loop) {
      var projName = loop.projectPath.split('/').pop().split('\\').pop();
      if (!byProject[projName]) byProject[projName] = { path: loop.projectPath, loops: [] };
      byProject[projName].loops.push(loop);
    });

    listEl.innerHTML = '';

    if (data.loops.length === 0) {
      listEl.innerHTML = '<p style="opacity:0.5;text-align:center;padding:2rem;font-size:12px;">No loops configured yet.</p>';
      return;
    }

    Object.keys(byProject).forEach(function (projName) {
      var group = byProject[projName];
      var header = document.createElement('div');
      header.className = 'loops-flyout-project-header';
      header.textContent = projName;
      listEl.appendChild(header);

      group.loops.forEach(function (loop) {
        var row = document.createElement('div');
        row.className = 'loops-flyout-row';

        var statusText = '';
        var statusColor = '#22c55e';
        if (!loop.enabled) {
          statusText = 'disabled'; statusColor = '#888';
        } else if (loop.currentRunStartedAt) {
          statusText = 'running...';
        } else if (loop.lastRunStatus === 'error') {
          statusText = '\u2717 error'; statusColor = '#ef4444';
        } else if (loop.lastRunStatus === 'completed') {
          statusText = '\u2713 ok';
        } else {
          statusText = 'pending'; statusColor = '#6366f1';
        }

        row.innerHTML = '<div class="loops-flyout-row-header">' +
          '<span>' + escapeHtml(loop.name) + '</span>' +
          '<span class="loops-flyout-row-status" style="color:' + statusColor + '">' + statusText + '</span>' +
          '</div>' +
          '<div class="loops-flyout-row-expanded">' +
            '<div class="loops-flyout-row-summary">Loading...</div>' +
            '<div class="loops-flyout-history"></div>' +
            '<button class="loops-flyout-action-btn loops-flyout-open-claude">Open in Claude</button>' +
          '</div>';

        row.addEventListener('click', function () {
          var wasExpanded = row.classList.contains('expanded');
          listEl.querySelectorAll('.loops-flyout-row').forEach(function (r) { r.classList.remove('expanded'); });
          if (!wasExpanded) {
            row.classList.add('expanded');
            window.electronAPI.getLoopHistory(loop.id, 5).then(function (history) {
              var summaryEl = row.querySelector('.loops-flyout-row-summary');
              var historyEl = row.querySelector('.loops-flyout-history');

              if (history.length > 0) {
                var latest = history[0];
                summaryEl.textContent = latest.summary || 'No summary available';

                if (latest.attentionItems && latest.attentionItems.length > 0) {
                  var attHtml = '';
                  latest.attentionItems.forEach(function (item) {
                    attHtml += '<div class="loop-attention-item">' + '\u2192 ' + escapeHtml(item.summary) + '</div>';
                  });
                  summaryEl.innerHTML = escapeHtml(latest.summary || '') + attHtml;

                  summaryEl.querySelectorAll('.loop-attention-item').forEach(function (el, idx) {
                    el.addEventListener('click', function (e) {
                      e.stopPropagation();
                      var item = latest.attentionItems[idx];
                      var followUpPrompt = 'The loop "' + loop.name + '" flagged this issue:\n' + item.summary + '\n\nDetails: ' + (item.detail || '') + '\n\nPlease investigate and help resolve this.';
                      addColumn(['-p', followUpPrompt]);
                      toggleLoopsFlyout();
                    });
                  });
                }

                var dotsHtml = '<span style="font-size:10px;opacity:0.5;margin-right:4px;">History:</span>';
                history.forEach(function (run) {
                  var dotClass = '';
                  if (run.status === 'error') dotClass = 'dot-error';
                  else if (run.attentionItems && run.attentionItems.length > 0) dotClass = 'dot-attention';
                  else if (run.status === 'interrupted') dotClass = 'dot-interrupted';
                  dotsHtml += '<span class="loops-flyout-history-dot ' + dotClass + '" title="' + (run.startedAt || '') + ' - ' + run.status + '"></span>';
                });
                historyEl.innerHTML = dotsHtml;
              } else {
                summaryEl.textContent = 'No runs yet';
                historyEl.innerHTML = '';
              }
            });
          }
        });

        // "Open in Claude" button in flyout row
        row.querySelector('.loops-flyout-open-claude').addEventListener('click', function (e) {
          e.stopPropagation();
          window.electronAPI.getLoopHistory(loop.id, 1).then(function (history) {
            if (history.length === 0) {
              alert('No output to continue with.');
              return;
            }
            var latest = history[0];
            var output = latest.output || latest.summary || 'No output available';
            var context = 'You are continuing work from a background loop called "' + loop.name + '". ' +
              'Below is the output from the most recent run. The user wants to discuss, investigate, or action these findings.\n\n' +
              '--- LOOP OUTPUT ---\n' + output + '\n--- END LOOP OUTPUT ---';
            var spawnArgs = buildSpawnArgs();
            spawnArgs.push('--append-system-prompt', context);
            addColumn(spawnArgs, null, { title: loop.name });
            toggleLoopsFlyout();
          });
        });

        listEl.appendChild(row);
      });
    });
  });
}

document.getElementById('btn-loops-flyout').addEventListener('click', toggleLoopsFlyout);
document.getElementById('btn-loops-flyout-close').addEventListener('click', toggleLoopsFlyout);
document.getElementById('btn-loops-global-toggle').addEventListener('click', function () {
  window.electronAPI.toggleLoopsGlobal().then(function () {
    refreshLoopsFlyout();
  });
});

// ============================================================
// Loop Events & Sidebar Integration
// ============================================================

window.electronAPI.onLoopRunStarted(function (data) {
  refreshLoops();
  refreshLoopsFlyout();
  updateLoopsTabIndicator();
  updateLoopSidebarBadges();
  // If we're viewing this loop's detail, refresh it
  if (activeLoopDetailId === data.loopId) {
    window.electronAPI.getLoopsForProject(activeProjectKey).then(function (loops) {
      var loop = loops.find(function (l) { return l.id === data.loopId; });
      if (loop) openLoopDetail(loop);
    });
  }
});

window.electronAPI.onLoopOutput(function (data) {
  if (activeLoopDetailId === data.loopId && loopDetailViewingLive) {
    var outputEl = document.getElementById('loop-detail-output');
    if (outputEl) {
      // Clear processing indicator on first real output
      var indicator = outputEl.querySelector('.loop-processing-indicator');
      if (indicator) outputEl.textContent = '';
      outputEl.textContent += data.chunk;
      outputEl.scrollTop = outputEl.scrollHeight;
    }
  }
});

window.electronAPI.onLoopRunCompleted(function (data) {
  refreshLoops();
  refreshLoopsFlyout();
  updateLoopSidebarBadges();
  updateLoopsTabIndicator();
  // If viewing this loop, refresh to show completed state
  if (activeLoopDetailId === data.loopId) {
    window.electronAPI.getLoopsForProject(activeProjectKey).then(function (loops) {
      var loop = loops.find(function (l) { return l.id === data.loopId; });
      if (loop) openLoopDetail(loop);
    });
  }

  if (data.attentionItems && data.attentionItems.length > 0) {
    var flyoutBtn = document.getElementById('btn-loops-flyout');
    if (flyoutBtn) flyoutBtn.classList.add('has-attention');
  }
});

function updateLoopsTabIndicator() {
  if (!activeProjectKey) return;
  window.electronAPI.getLoopsForProject(activeProjectKey).then(function (loops) {
    var hasLoops = loops.length > 0;
    var anyRunning = loops.some(function (loop) { return !!loop.currentRunStartedAt; });
    var tab = document.querySelector('.explorer-tab[data-tab="loops"]');
    if (tab) {
      // Three states: green pulsing (running), yellow (has loops), no icon (no loops)
      if (anyRunning) {
        tab.classList.add('has-running');
        tab.classList.remove('has-loops');
      } else if (hasLoops) {
        tab.classList.remove('has-running');
        tab.classList.add('has-loops');
      } else {
        tab.classList.remove('has-running');
        tab.classList.remove('has-loops');
      }
    }
  });
}

function updateLoopSidebarBadges() {
  window.electronAPI.getLoops().then(function (data) {
    var projectsWithAttention = new Set();
    var anyRunning = false;
    data.loops.forEach(function (loop) {
      if (loop.lastRunStatus === 'error' || loop.lastError) {
        projectsWithAttention.add(loop.projectPath.replace(/\\/g, '/'));
      }
      if (loop.currentRunStartedAt) {
        anyRunning = true;
      }
    });

    var items = document.querySelectorAll('.project-item');
    items.forEach(function (item) {
      var existing = item.querySelector('.project-loop-badge');
      if (existing) existing.remove();
    });

    if (config && config.projects) {
      config.projects.forEach(function (project, index) {
        var normalizedPath = project.path.replace(/\\/g, '/');
        if (projectsWithAttention.has(normalizedPath) && items[index]) {
          var badge = document.createElement('span');
          badge.className = 'project-loop-badge';
          badge.title = 'Loop needs attention';
          var nameEl = items[index].querySelector('.project-name');
          if (nameEl) nameEl.appendChild(badge);
        }
      });
    }

    var flyoutBtn = document.getElementById('btn-loops-flyout');
    if (flyoutBtn) {
      // Running state: green pulse animation
      if (anyRunning) {
        flyoutBtn.classList.add('has-running');
      } else {
        flyoutBtn.classList.remove('has-running');
      }
      // Attention state: static orange (no animation)
      if (projectsWithAttention.size > 0) {
        flyoutBtn.classList.add('has-attention');
      } else {
        flyoutBtn.classList.remove('has-attention');
      }
    }
  });
}

// ============================================================
// Conversational Loop Setup
// ============================================================

// Copy output button
document.getElementById('btn-loop-open-claude').addEventListener('click', function () {
  if (!activeLoopDetailId) return;
  var outputEl = document.getElementById('loop-detail-output');
  var nameEl = document.getElementById('loop-detail-name');
  var loopName = nameEl ? nameEl.textContent : 'Loop';
  var output = outputEl.textContent || '';

  if (!output || output === 'Loading...' || output.indexOf('Processing...') === 0) {
    alert('No output to continue with.');
    return;
  }

  var context = 'You are continuing work from a background loop called "' + loopName + '". ' +
    'Below is the output from the most recent run. The user wants to discuss, investigate, or action these findings.\n\n' +
    '--- LOOP OUTPUT ---\n' + output + '\n--- END LOOP OUTPUT ---';

  var spawnArgs = buildSpawnArgs();
  spawnArgs.push('--append-system-prompt', context);
  addColumn(spawnArgs, null, { title: loopName });
});

document.getElementById('btn-loop-copy-output').addEventListener('click', function () {
  var outputEl = document.getElementById('loop-detail-output');
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
