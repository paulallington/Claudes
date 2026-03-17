/* global Terminal, FitAddon */

var columnsContainer = document.getElementById('columns-container');
var btnAdd = document.getElementById('btn-add');
var btnAddProject = document.getElementById('btn-add-project');
var btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
var projectListEl = document.getElementById('project-list');
var activeProjectNameEl = document.getElementById('active-project-name');
var sidebar = document.getElementById('sidebar');

var globalColumnId = 0;
var ws = null;

// All pty columns keyed by global id (for routing WS messages)
var allColumns = new Map();

// Per-project state: projectKey -> { containerEl, columns: Map, focusedColumnId }
var projectStates = new Map();
var activeProjectKey = null;

// Config
var config = { projects: [], activeProjectIndex: -1 };

var termTheme = {
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

// ============================================================
// WebSocket
// ============================================================

function connectWS() {
  ws = new WebSocket('ws://127.0.0.1:3456');

  ws.onopen = function () {
    loadProjects();
  };

  ws.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }

    if (msg.type === 'data') {
      var col = allColumns.get(msg.id);
      if (col) col.terminal.write(msg.data);
    } else if (msg.type === 'exit') {
      var col2 = allColumns.get(msg.id);
      if (col2) col2.element.appendChild(createExitOverlay(msg.id, msg.exitCode, col2));
    }
  };

  ws.onclose = function () {
    setTimeout(connectWS, 2000);
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ============================================================
// Per-project state helpers
// ============================================================

function getProjectKey(index) {
  return config.projects[index] ? config.projects[index].path : null;
}

function getOrCreateProjectState(projectKey) {
  if (projectStates.has(projectKey)) return projectStates.get(projectKey);

  var containerEl = document.createElement('div');
  containerEl.className = 'project-columns';
  containerEl.style.display = 'none';
  columnsContainer.appendChild(containerEl);

  var state = {
    containerEl: containerEl,
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

function getActiveColumns() {
  var state = getActiveState();
  return state ? state.columns : new Map();
}

function saveColumnCounts() {
  for (var i = 0; i < config.projects.length; i++) {
    var key = config.projects[i].path;
    var state = projectStates.get(key);
    config.projects[i].columnCount = state ? state.columns.size : 0;
  }
  saveConfig();
}

// ============================================================
// Project Management
// ============================================================

function loadProjects() {
  if (!window.electronAPI) return;

  window.electronAPI.getProjects().then(function (cfg) {
    config = cfg || { projects: [], activeProjectIndex: -1 };

    // Ensure columnCount exists on each project
    for (var i = 0; i < config.projects.length; i++) {
      if (config.projects[i].columnCount === undefined) {
        config.projects[i].columnCount = 1;
      }
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

    info.appendChild(name);
    info.appendChild(pathEl);

    var rightSide = document.createElement('div');
    rightSide.className = 'project-right';

    if (count > 0) {
      var badge = document.createElement('span');
      badge.className = 'project-badge';
      badge.textContent = count + ' ';
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

  // Hide previous project's columns
  if (prevKey && prevKey !== newKey) {
    var prevState = projectStates.get(prevKey);
    if (prevState) {
      prevState.containerEl.style.display = 'none';
    }
  }

  config.activeProjectIndex = index;
  activeProjectKey = newKey;
  activeProjectNameEl.textContent = project.name;
  saveConfig();
  renderProjectList();

  // Remove empty state if present
  var emptyState = columnsContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  // Show (or create) this project's columns
  var state = getOrCreateProjectState(newKey);
  state.containerEl.style.display = 'flex';

  if (state.columns.size === 0) {
    if (isStartup && window.electronAPI) {
      // Try to restore previous sessions
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
  window.electronAPI.loadSessions(projectPath).then(function (savedSessionIds) {
    if (savedSessionIds && savedSessionIds.length > 0) {
      // Resume each saved session
      for (var i = 0; i < savedSessionIds.length; i++) {
        addColumn(['--resume', savedSessionIds[i]]);
      }
    } else {
      // No saved sessions, just spawn one fresh
      addColumn();
    }
  });
}

function addProject(folderPath) {
  var parts = folderPath.replace(/\\/g, '/').split('/');
  var name = parts[parts.length - 1] || folderPath;

  // Check for duplicates
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

  // Kill all columns for this project
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
    if (index < config.activeProjectIndex) {
      config.activeProjectIndex--;
    }
    saveConfig();
    renderProjectList();
  }
}

function showEmptyState() {
  // Hide all project containers
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

function createColumnHeader(id) {
  var header = document.createElement('div');
  header.className = 'column-header';

  var title = document.createElement('span');
  title.className = 'col-title';
  title.textContent = 'Claude #' + id;

  var closeBtn = document.createElement('span');
  closeBtn.className = 'col-close';
  closeBtn.dataset.id = String(id);
  closeBtn.title = 'Kill (Ctrl+Shift+W)';
  closeBtn.textContent = '\u00d7';

  header.appendChild(title);
  header.appendChild(closeBtn);
  return header;
}

function createExitOverlay(id, exitCode, col) {
  var overlay = document.createElement('div');
  overlay.className = 'exit-overlay';

  var msg = document.createElement('div');
  msg.textContent = 'Claude exited (code ' + exitCode + ')';

  var restartBtn = document.createElement('button');
  restartBtn.className = 'restart-btn';
  restartBtn.textContent = 'Respawn';

  var closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.textContent = 'Kill';

  restartBtn.addEventListener('click', function () {
    overlay.remove();
    col.fitAddon.fit();
    var resumeArgs = col.sessionId ? ['--resume', col.sessionId] : [];
    wsSend({ type: 'create', id: id, cols: col.terminal.cols, rows: col.terminal.rows, cwd: col.cwd, args: resumeArgs });
    col.terminal.clear();
  });

  closeBtn.addEventListener('click', function () {
    removeColumn(id);
  });

  overlay.appendChild(msg);
  overlay.appendChild(restartBtn);
  overlay.appendChild(closeBtn);
  return overlay;
}

// ============================================================
// Column Management
// ============================================================

function addColumn(args) {
  if (!activeProjectKey) return;

  var state = getActiveState();
  if (!state) return;

  var id = ++globalColumnId;
  var targetContainer = state.containerEl;

  if (state.columns.size > 0) {
    var lastId = Array.from(state.columns.keys()).pop();
    var handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.dataset.leftColumnId = String(lastId);
    handle.dataset.rightColumnId = String(id);
    targetContainer.appendChild(handle);
    setupResizeHandle(handle);
  }

  var col = document.createElement('div');
  col.className = 'column';
  col.dataset.id = String(id);

  var header = createColumnHeader(id);
  var termWrapper = document.createElement('div');
  termWrapper.className = 'terminal-wrapper';

  col.appendChild(header);
  col.appendChild(termWrapper);
  targetContainer.appendChild(col);

  var terminal = new Terminal({
    theme: termTheme,
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    fontSize: 14,
    cursorBlink: true,
    allowProposedApi: true
  });

  var fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(termWrapper);

  var cwd = activeProjectKey;
  var claudeArgs = args || [];

  // Snapshot existing sessions before spawning so we can detect the new one
  var preSpawnSessionsPromise = window.electronAPI
    ? window.electronAPI.getRecentSessions(cwd)
    : Promise.resolve([]);

  requestAnimationFrame(function () {
    fitAddon.fit();
    wsSend({ type: 'create', id: id, cols: terminal.cols, rows: terminal.rows, cwd: cwd, args: claudeArgs });

    // After a delay, detect which session this Claude created
    if (window.electronAPI) {
      preSpawnSessionsPromise.then(function (preSessions) {
        var preIds = {};
        for (var i = 0; i < preSessions.length; i++) {
          preIds[preSessions[i].sessionId] = true;
        }
        // Poll for the new session (Claude takes a moment to create it)
        detectSession(id, cwd, preIds, 0);
      });
    }
  });

  terminal.onData(function (data) {
    wsSend({ type: 'write', id: id, data: data });
  });

  termWrapper.addEventListener('mousedown', function () {
    setFocusedColumn(id);
  });

  header.querySelector('.col-close').addEventListener('click', function () {
    removeColumn(id);
  });

  var colData = {
    element: col,
    terminal: terminal,
    fitAddon: fitAddon,
    headerEl: header,
    cwd: cwd,
    projectKey: activeProjectKey,
    sessionId: null
  };

  state.columns.set(id, colData);
  allColumns.set(id, colData);
  setFocusedColumn(id);
  refitAll();
  saveColumnCounts();
  renderProjectList();
}

// Detect which session ID was created by a newly spawned Claude
function detectSession(columnId, projectPath, preExistingIds, attempt) {
  if (attempt > 15) return; // give up after ~30 seconds

  setTimeout(function () {
    window.electronAPI.getRecentSessions(projectPath).then(function (sessions) {
      // Find sessions that didn't exist before
      for (var i = 0; i < sessions.length; i++) {
        if (!preExistingIds[sessions[i].sessionId]) {
          // New session found — assign it to this column
          var col = allColumns.get(columnId);
          if (col) {
            col.sessionId = sessions[i].sessionId;
            persistSessions(col.projectKey);
          }
          return;
        }
      }

      // Also check if the most recent session was updated (resume case)
      if (sessions.length > 0) {
        var col = allColumns.get(columnId);
        if (col && !col.sessionId) {
          col.sessionId = sessions[0].sessionId;
          persistSessions(col.projectKey);
          return;
        }
      }

      // Not found yet, retry
      detectSession(columnId, projectPath, preExistingIds, attempt + 1);
    });
  }, 2000);
}

// Save all active session IDs for a project
function persistSessions(projectKey) {
  if (!window.electronAPI) return;

  var state = projectStates.get(projectKey);
  if (!state) return;

  var sessionIds = [];
  state.columns.forEach(function (col) {
    if (col.sessionId) {
      sessionIds.push(col.sessionId);
    }
  });

  window.electronAPI.saveSessions(projectKey, sessionIds);
}

function removeColumn(id) {
  var col = allColumns.get(id);
  if (!col) return;

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

  // Remove from project state
  var state = projectStates.get(col.projectKey);
  if (state) {
    state.columns.delete(id);

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
}

function setFocusedColumn(id) {
  var col = allColumns.get(id);
  if (!col) return;

  var state = projectStates.get(col.projectKey);
  if (!state) return;

  // Unfocus previous in this project
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

  var ids = Array.from(state.columns.keys());
  if (ids.length < 2) return;

  var idx = ids.indexOf(state.focusedColumnId);
  var newIdx = direction === 'left'
    ? (idx - 1 + ids.length) % ids.length
    : (idx + 1) % ids.length;
  setFocusedColumn(ids[newIdx]);
}

// ============================================================
// Resize Handles
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
// Fit / Resize
// ============================================================

function refitAll() {
  var state = getActiveState();
  if (!state) return;

  state.columns.forEach(function (col, id) {
    try {
      col.fitAddon.fit();
      wsSend({ type: 'resize', id: id, cols: col.terminal.cols, rows: col.terminal.rows });
    } catch (e) {
      // Terminal may not be fully initialized yet
    }
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

  if (e.ctrlKey && !e.shiftKey && e.key === 'b') {
    e.preventDefault();
    toggleSidebar();
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
// Init
// ============================================================

btnAdd.addEventListener('click', addColumn);
btnToggleSidebar.addEventListener('click', toggleSidebar);

btnAddProject.addEventListener('click', function () {
  if (!window.electronAPI) return;
  window.electronAPI.openDirectoryDialog().then(function (folderPath) {
    if (folderPath) addProject(folderPath);
  });
});

connectWS();
