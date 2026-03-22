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
var btnSpawnWithOpts = document.getElementById('btn-spawn-with-opts');

var globalColumnId = 0;
var globalRowId = 0;
var ws = null;

// All pty columns keyed by global id (for routing WS messages)
var allColumns = new Map();

// Activity state tracking per column: 'working' | 'attention' | 'idle' | 'exited'
var activityTimers = new Map(); // columnId -> setTimeout handle
var ACTIVITY_IDLE_MS = 3000; // after 3s of no data, transition working -> attention
var resizeSuppressed = new Set(); // columnIds temporarily suppressed after resize

// Per-project state: projectKey -> { containerEl, rows: [], columns: Map, focusedColumnId }
var projectStates = new Map();
var activeProjectKey = null;

var config = { projects: [], activeProjectIndex: -1 };

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
        if (!resizeSuppressed.has(msg.id)) {
          setColumnActivity(msg.id, 'working');
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
    // Always reset the idle timer: working -> attention after 3s
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

function notifyAttentionNeeded(columnId) {
  var col = allColumns.get(columnId);
  if (!col) return;

  // Don't flash during startup — wait 15s for Claude to finish loading
  if (Date.now() - col.createdAt < 15000) return;

  // Flash taskbar if window not focused
  if (window.electronAPI && window.electronAPI.flashFrame) {
    window.electronAPI.flashFrame();
  }

  // Flash the column header
  var header = col.headerEl;
  if (header) {
    header.classList.add('attention-flash');
    setTimeout(function () { header.classList.remove('attention-flash'); }, 4000);
  }

  // Flash the sidebar project item
  if (notifSettings.sidebar) {
    var items = projectListEl.querySelectorAll('.project-item');
    config.projects.forEach(function (project, index) {
      if (project.path === col.projectKey && items[index]) {
        items[index].classList.add('attention-flash');
        setTimeout(function () { items[index].classList.remove('attention-flash'); }, 4000);
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

  // Clear attention state on all columns of this project — user has looked at it
  clearProjectAttention(newKey);

  saveConfig();
  renderProjectList();

  var emptyState = columnsContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  lastGitRaw = null; // invalidate cache on project switch
  var state = getOrCreateProjectState(newKey);
  state.containerEl.style.display = 'flex';
  refreshExplorer();

  if (state.columns.size === 0) {
    if (isStartup && window.electronAPI) {
      restoreProjectSessions(newKey, project);
    } else {
      addColumn();
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
    if (savedSessions && savedSessions.length > 0) {
      for (var i = 0; i < savedSessions.length; i++) {
        // Support both old format (plain string) and new format ({sessionId, title})
        var entry = savedSessions[i];
        var sessionId = typeof entry === 'string' ? entry : entry.sessionId;
        var title = typeof entry === 'object' ? entry.title : null;
        addColumn(['--resume', sessionId], null, title ? { title: title } : {});
      }
    } else {
      addColumn();
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

function createColumnHeader(id, customTitle) {
  var header = document.createElement('div');
  header.className = 'column-header';
  var title = document.createElement('span');
  title.className = 'col-title';
  title.textContent = customTitle || ('Claude #' + id);
  title.addEventListener('dblclick', function () {
    startTitleEdit(id, title);
  });
  // Action buttons container (right side of header)
  var actions = document.createElement('span');
  actions.className = 'col-actions';

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

  var maximizeBtn = document.createElement('span');
  maximizeBtn.className = 'col-maximize';
  maximizeBtn.title = 'Maximize';
  maximizeBtn.textContent = '\u25A1';
  maximizeBtn.addEventListener('click', function () {
    toggleMaximizeColumn(id);
  });

  var restartBtn = document.createElement('span');
  restartBtn.className = 'col-restart';
  restartBtn.dataset.id = String(id);
  restartBtn.title = 'Restart';
  restartBtn.textContent = '\u21bb';

  var closeBtn = document.createElement('span');
  closeBtn.className = 'col-close';
  closeBtn.dataset.id = String(id);
  closeBtn.title = 'Kill';
  closeBtn.textContent = '\u00d7';

  actions.appendChild(compactBtn);
  actions.appendChild(teleportBtn);
  actions.appendChild(effortSelect);
  actions.appendChild(maximizeBtn);
  actions.appendChild(restartBtn);
  actions.appendChild(closeBtn);

  header.appendChild(title);
  header.appendChild(actions);

  // Double-click header (not title) to toggle maximize
  header.addEventListener('dblclick', function (e) {
    if (e.target === title || title.contains(e.target)) return; // title dblclick is rename
    toggleMaximizeColumn(id);
  });

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

  col.appendChild(header);
  col.appendChild(termWrapper);
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

  wsSend({ type: 'kill', id: id });

  var colElement = col.element;
  var prevSibling = colElement.previousElementSibling;
  var nextSibling = colElement.nextElementSibling;

  colElement.remove();

  if (prevSibling && prevSibling.classList.contains('resize-handle')) {
    prevSibling.remove();
  } else if (nextSibling && nextSibling.classList.contains('resize-handle')) {
    nextSibling.remove();
  }

  col.terminal.dispose();
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
  col.terminal.focus();
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
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ============================================================
// Fit / Resize
// ============================================================

function refitAll() {
  var state = getActiveState();
  if (!state) return;
  state.columns.forEach(function (col, id) {
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

// Tab switching
document.querySelectorAll('.explorer-tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    var tabName = tab.dataset.tab;
    document.querySelectorAll('.explorer-tab').forEach(function (t) { t.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function (tc) { tc.classList.remove('active'); });
    tab.classList.add('active');
    document.getElementById('tab-' + tabName).classList.add('active');
    if (tabName === 'files') { stopGitPolling(); refreshFileTree(); }
    else if (tabName === 'git') { refreshGitStatus(true); startGitPolling(); }
    else if (tabName === 'run') { stopGitPolling(); refreshRunConfigs(); }
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

function refreshFileTree() {
  if (!activeProjectKey || !window.electronAPI) return;
  while (fileTreeEl.firstChild) fileTreeEl.removeChild(fileTreeEl.firstChild);
  window.electronAPI.readDir(activeProjectKey).then(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      fileTreeEl.appendChild(createTreeItem(entries[i], 0));
    }
  });
}

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
var gitExpandedDiff = null; // track which file has diff open

function refreshGitStatus(force) {
  if (!activeProjectKey || !window.electronAPI) return;

  var fetchAll = [
    window.electronAPI.gitStatus(activeProjectKey),
    window.electronAPI.gitBranch(activeProjectKey),
    window.electronAPI.gitAheadBehind(activeProjectKey),
    window.electronAPI.gitStashList(activeProjectKey),
    window.electronAPI.gitLog(activeProjectKey, 10)
  ];

  if (!force) {
    Promise.all(fetchAll).then(function (results) {
      var rawKey = JSON.stringify(results[0]) + '|' + results[1] + '|' + JSON.stringify(results[2]) + '|' + results[3].length + '|' + JSON.stringify(results[4]);
      if (rawKey === lastGitRaw) return;
      lastGitRaw = rawKey;
      renderGitStatus(results[0], results[1], results[2], results[3], results[4]);
    });
    return;
  }

  lastGitRaw = null;
  Promise.all(fetchAll).then(function (results) {
    lastGitRaw = JSON.stringify(results[0]) + '|' + results[1] + '|' + JSON.stringify(results[2]) + '|' + results[3].length + '|' + JSON.stringify(results[4]);
    renderGitStatus(results[0], results[1], results[2], results[3], results[4]);
  });
}

function renderGitStatus(files, branch, aheadBehind, stashes, commits) {
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

  if (staged.length === 0 && changes.length === 0 && commits.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'git-empty';
    empty.textContent = 'No changes';
    gitChangesEl.appendChild(empty);
    return;
  }

  if (staged.length > 0) {
    gitChangesEl.appendChild(createGitSection('Staged Changes', staged, true));
  }
  if (changes.length > 0) {
    gitChangesEl.appendChild(createGitSection('Changes', changes, false));
  }

  // Commit log section
  if (commits.length > 0) {
    gitChangesEl.appendChild(createGitLogSection(commits));
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

// Commit log section
function createGitLogSection(commits) {
  var section = document.createElement('div');
  section.className = 'git-section';

  var header = document.createElement('div');
  header.className = 'git-section-header';

  var arrow = document.createElement('span');
  arrow.className = 'git-section-arrow';
  arrow.textContent = '\u25B8'; // collapsed by default

  var label = document.createElement('span');
  label.className = 'git-section-label';
  label.textContent = 'Recent Commits (' + commits.length + ')';

  header.appendChild(arrow);
  header.appendChild(label);
  section.appendChild(header);

  var list = document.createElement('div');
  list.className = 'git-section-list';
  list.style.display = 'none'; // collapsed by default

  for (var i = 0; i < commits.length; i++) {
    var entry = document.createElement('div');
    entry.className = 'git-log-entry';
    var hash = document.createElement('span');
    hash.className = 'git-log-hash';
    hash.textContent = commits[i].hash;
    var msg = document.createElement('span');
    msg.className = 'git-log-msg';
    msg.textContent = commits[i].message;
    entry.appendChild(hash);
    entry.appendChild(msg);
    list.appendChild(entry);
  }

  section.appendChild(list);

  header.addEventListener('click', function () {
    var collapsed = list.style.display === 'none';
    list.style.display = collapsed ? 'block' : 'none';
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

function createGitSection(title, files, isStaged) {
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

  for (var i = 0; i < files.length; i++) {
    list.appendChild(createGitFileRow(files[i], isStaged));
  }
  section.appendChild(list);

  header.addEventListener('click', function () {
    var collapsed = list.style.display === 'none';
    list.style.display = collapsed ? 'block' : 'none';
    arrow.textContent = collapsed ? '\u25BE' : '\u25B8';
  });

  return section;
}

function createGitFileRow(file, isStaged) {
  var container = document.createElement('div');
  container.className = 'git-file-container';

  var row = document.createElement('div');
  row.className = 'git-file';

  var statusEl = document.createElement('span');
  statusEl.className = 'git-status git-status-' + gitStatusClass(file.status);
  statusEl.textContent = file.status;

  var nameEl = document.createElement('span');
  nameEl.className = 'git-filename';
  nameEl.textContent = file.file;
  nameEl.title = 'Click to view diff';

  // Click filename to toggle diff
  nameEl.addEventListener('click', function (e) {
    e.stopPropagation();
    var diffKey = (isStaged ? 'staged:' : 'unstaged:') + file.file;
    var existingDiff = container.querySelector('.git-diff-content');
    if (existingDiff) {
      existingDiff.remove();
      gitExpandedDiff = null;
      return;
    }
    // Close any other open diff
    var allDiffs = gitChangesEl.querySelectorAll('.git-diff-content');
    for (var d = 0; d < allDiffs.length; d++) allDiffs[d].remove();

    gitExpandedDiff = diffKey;
    var diffEl = document.createElement('pre');
    diffEl.className = 'git-diff-content';
    diffEl.textContent = 'Loading...';
    container.appendChild(diffEl);

    window.electronAPI.gitDiff(activeProjectKey, file.file, isStaged).then(function (diffText) {
      diffEl.textContent = '';
      if (!diffText || !diffText.trim()) {
        diffEl.textContent = '(no diff available)';
        return;
      }
      var lines = diffText.split('\n');
      for (var li = 0; li < lines.length; li++) {
        var span = document.createElement('span');
        var line = lines[li];
        if (line.startsWith('+++') || line.startsWith('---')) {
          span.className = 'diff-meta';
        } else if (line.startsWith('+')) {
          span.className = 'diff-add';
        } else if (line.startsWith('-')) {
          span.className = 'diff-del';
        } else if (line.startsWith('@@')) {
          span.className = 'diff-hunk';
        }
        span.textContent = line;
        diffEl.appendChild(span);
        if (li < lines.length - 1) diffEl.appendChild(document.createTextNode('\n'));
      }
    });
  });

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
  window.electronAPI.getLaunchConfigs(activeProjectKey).then(function (configs) {
    if (configs.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'run-empty';
      empty.textContent = 'No launch configurations found';
      runConfigsEl.appendChild(empty);
      return;
    }
    for (var i = 0; i < configs.length; i++) {
      (function (config) {
        var item = document.createElement('div');
        item.className = 'run-config-item';
        var playBtn = document.createElement('button');
        playBtn.className = 'run-play-btn';
        playBtn.textContent = '\u25B6';
        playBtn.title = 'Run ' + config.name;
        var nameEl = document.createElement('span');
        nameEl.className = 'run-config-name';
        nameEl.textContent = config.name;
        var typeEl = document.createElement('span');
        typeEl.className = 'run-config-type';
        typeEl.textContent = config.type || '';
        playBtn.addEventListener('click', function () {
          launchConfig(config);
        });
        item.appendChild(playBtn);
        item.appendChild(nameEl);
        item.appendChild(typeEl);
        runConfigsEl.appendChild(item);
      })(configs[i]);
    }
  });
}

function launchConfig(config) {
  if (!activeProjectKey) return;
  function resolve(str) {
    if (!str) return str;
    return str.replace(/\$\{workspaceFolder\}/g, activeProjectKey);
  }
  var cmd, cmdArgs, cwd, env;
  cwd = config.cwd ? resolve(config.cwd) : activeProjectKey;
  env = config.env || null;
  if (config.type === 'dotnet-project') {
    cmd = 'dotnet';
    cmdArgs = ['run'];
    if (config.applicationUrl) {
      cmdArgs.push('--urls');
      cmdArgs.push(config.applicationUrl);
    }
    if (config.commandLineArgs) {
      cmdArgs.push('--');
      cmdArgs = cmdArgs.concat(config.commandLineArgs.split(/\s+/));
    }
  } else if (config.type === 'coreclr') {
    cmd = 'dotnet';
    cmdArgs = [];
    if (config.program) cmdArgs.push(resolve(config.program));
    if (config.args) cmdArgs = cmdArgs.concat(config.args.map(resolve));
  } else if (config.type === 'node' || config.type === 'pwa-node') {
    cmd = config.runtimeExecutable || 'node';
    cmdArgs = [];
    if (config.runtimeArgs) cmdArgs = cmdArgs.concat(config.runtimeArgs.map(resolve));
    if (config.program) cmdArgs.push(resolve(config.program));
    if (config.args) cmdArgs = cmdArgs.concat(config.args.map(resolve));
  } else if (config.runtimeExecutable) {
    cmd = resolve(config.runtimeExecutable);
    cmdArgs = (config.args || []).map(resolve);
    if (config.program) cmdArgs.unshift(resolve(config.program));
  } else if (config.program) {
    cmd = resolve(config.program);
    cmdArgs = (config.args || []).map(resolve);
  } else {
    return;
  }
  var launchUrl = config.applicationUrl || null;
  addColumn(cmdArgs, null, { cmd: cmd, title: config.name, cwd: cwd, env: env, launchUrl: launchUrl });
}

function refreshExplorer() {
  var activeTab = document.querySelector('.explorer-tab.active');
  if (!activeTab) return;
  var tabName = activeTab.dataset.tab;
  if (tabName === 'files') refreshFileTree();
  else if (tabName === 'git') refreshGitStatus();
  else if (tabName === 'run') refreshRunConfigs();
}

btnToggleExplorer.addEventListener('click', toggleExplorer);
document.getElementById('btn-refresh-files').addEventListener('click', refreshFileTree);
document.getElementById('btn-refresh-git').addEventListener('click', function () { refreshGitStatus(true); });
document.getElementById('btn-refresh-run').addEventListener('click', refreshRunConfigs);
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

btnAdd.addEventListener('click', function () { addColumn(); });
btnAddRow.addEventListener('click', addRow);
btnToggleSidebar.addEventListener('click', toggleSidebar);
themeSelect.addEventListener('change', function () {
  setThemePreference(themeSelect.value);
  config.theme = themeSelect.value;
  saveConfig();
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

btnAddOptions.addEventListener('click', function (e) {
  e.stopPropagation();
  toggleSpawnDropdown();
});

btnSpawnWithOpts.addEventListener('click', function () {
  var args = buildSpawnArgs();
  closeSpawnDropdown();
  addColumn(args.length > 0 ? args : null);
});

// Close dropdown when clicking outside
document.addEventListener('click', function (e) {
  if (!spawnDropdown.classList.contains('hidden') &&
      !spawnDropdown.contains(e.target) &&
      e.target !== btnAddOptions) {
    closeSpawnDropdown();
  }
});

// Prevent dropdown clicks from closing it
spawnDropdown.addEventListener('click', function (e) {
  e.stopPropagation();
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
  document.getElementById('app-version').textContent = 'v' + v;
});

// --- Auto Update Notifications ---

(function setupUpdateNotifications() {
  var updateBar = document.getElementById('update-bar');
  var updateMessage = document.getElementById('update-message');
  var updateAction = document.getElementById('update-action');
  var updateDismiss = document.getElementById('update-dismiss');

  var updateVersion = '';

  window.electronAPI.onUpdateAvailable(function(info) {
    updateVersion = info.version;
    updateMessage.textContent = 'Downloading update v' + info.version + '...';
    updateAction.style.display = 'none';
    updateBar.classList.remove('hidden');
  });

  window.electronAPI.onUpdateProgress(function(info) {
    var pct = Math.round(info.percent);
    updateMessage.textContent = 'Downloading update v' + updateVersion + '... ' + pct + '%';
  });

  window.electronAPI.onUpdateDownloaded(function(info) {
    updateMessage.textContent = 'Update v' + info.version + ' ready to install';
    updateAction.style.display = '';
    updateBar.classList.remove('hidden');
  });

  window.electronAPI.onUpdateError(function(info) {
    updateMessage.textContent = 'Update failed: ' + (info.message || 'unknown error');
    updateAction.style.display = 'none';
    setTimeout(function() { updateBar.classList.add('hidden'); }, 8000);
  });

  updateAction.addEventListener('click', function() {
    window.electronAPI.installUpdate();
  });

  updateDismiss.addEventListener('click', function() {
    updateBar.classList.add('hidden');
  });
})();
