/* global Terminal, FitAddon */

var columnsContainer = document.getElementById('columns-container');
var btnAdd = document.getElementById('btn-add');
var btnAddRow = document.getElementById('btn-add-row');
var btnAddProject = document.getElementById('btn-add-project');
var btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
var projectListEl = document.getElementById('project-list');
var activeProjectNameEl = document.getElementById('active-project-name');
var sidebar = document.getElementById('sidebar');

var btnAddOptions = document.getElementById('btn-add-options');
var spawnDropdown = document.getElementById('spawn-dropdown');
var optSkipPermissions = document.getElementById('opt-skip-permissions');
var optModel = document.getElementById('opt-model');
var optCustomArgs = document.getElementById('opt-custom-args');
var btnSpawnWithOpts = document.getElementById('btn-spawn-with-opts');

var globalColumnId = 0;
var globalRowId = 0;
var ws = null;

// All pty columns keyed by global id (for routing WS messages)
var allColumns = new Map();

// Per-project state: projectKey -> { containerEl, rows: [], columns: Map, focusedColumnId }
var projectStates = new Map();
var activeProjectKey = null;

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
  ws.onopen = function () { loadProjects(); };
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
  ws.onclose = function () { setTimeout(connectWS, 2000); };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
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

  if (prevKey && prevKey !== newKey) {
    var prevState = projectStates.get(prevKey);
    if (prevState) prevState.containerEl.style.display = 'none';
  }

  config.activeProjectIndex = index;
  activeProjectKey = newKey;
  activeProjectNameEl.textContent = project.name;
  saveConfig();
  renderProjectList();

  var emptyState = columnsContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  var state = getOrCreateProjectState(newKey);
  state.containerEl.style.display = 'flex';

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
  window.electronAPI.loadSessions(projectPath).then(function (savedSessionIds) {
    if (savedSessionIds && savedSessionIds.length > 0) {
      for (var i = 0; i < savedSessionIds.length; i++) {
        addColumn(['--resume', savedSessionIds[i]]);
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

function createColumnHeader(id) {
  var header = document.createElement('div');
  header.className = 'column-header';
  var title = document.createElement('span');
  title.className = 'col-title';
  title.textContent = 'Claude #' + id;
  var closeBtn = document.createElement('span');
  closeBtn.className = 'col-close';
  closeBtn.dataset.id = String(id);
  closeBtn.title = 'Kill';
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
  closeBtn.addEventListener('click', function () { removeColumn(id); });

  overlay.appendChild(msg);
  overlay.appendChild(restartBtn);
  overlay.appendChild(closeBtn);
  return overlay;
}

// ============================================================
// Column Management
// ============================================================

function addColumn(args, targetRow) {
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

  var header = createColumnHeader(id);
  var termWrapper = document.createElement('div');
  termWrapper.className = 'terminal-wrapper';

  col.appendChild(header);
  col.appendChild(termWrapper);
  row.el.appendChild(col);

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

  var preSpawnSessionsPromise = window.electronAPI
    ? window.electronAPI.getRecentSessions(cwd)
    : Promise.resolve([]);

  requestAnimationFrame(function () {
    fitAddon.fit();
    wsSend({ type: 'create', id: id, cols: terminal.cols, rows: terminal.rows, cwd: cwd, args: claudeArgs });

    if (window.electronAPI) {
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

  row.columnIds.push(id);
  state.columns.set(id, colData);
  allColumns.set(id, colData);
  setFocusedColumn(id);
  refitAll();
  saveColumnCounts();
  renderProjectList();
}

function addRow() {
  if (!activeProjectKey) return;
  var state = getActiveState();
  if (!state) return;

  var row = addRowToProject(state);
  addColumn(null, row);
}

// Detect which session ID was created by a newly spawned Claude
function detectSession(columnId, projectPath, preExistingIds, attempt) {
  if (attempt > 15) return;
  setTimeout(function () {
    window.electronAPI.getRecentSessions(projectPath).then(function (sessions) {
      for (var i = 0; i < sessions.length; i++) {
        if (!preExistingIds[sessions[i].sessionId]) {
          var col = allColumns.get(columnId);
          if (col) {
            col.sessionId = sessions[i].sessionId;
            persistSessions(col.projectKey);
          }
          return;
        }
      }
      if (sessions.length > 0) {
        var col2 = allColumns.get(columnId);
        if (col2 && !col2.sessionId) {
          col2.sessionId = sessions[0].sessionId;
          persistSessions(col2.projectKey);
          return;
        }
      }
      detectSession(columnId, projectPath, preExistingIds, attempt + 1);
    });
  }, 2000);
}

function persistSessions(projectKey) {
  if (!window.electronAPI) return;
  var state = projectStates.get(projectKey);
  if (!state) return;
  var sessionIds = [];
  state.columns.forEach(function (col) {
    if (col.sessionId) sessionIds.push(col.sessionId);
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

  var state = projectStates.get(col.projectKey);
  if (state) {
    state.columns.delete(id);

    // Remove from row
    for (var r = 0; r < state.rows.length; r++) {
      var idx = state.rows[r].columnIds.indexOf(id);
      if (idx !== -1) {
        state.rows[r].columnIds.splice(idx, 1);
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

btnAdd.addEventListener('click', function () { addColumn(); });
btnAddRow.addEventListener('click', addRow);
btnToggleSidebar.addEventListener('click', toggleSidebar);

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
  if (optModel.value) {
    args.push('--model', optModel.value);
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

connectWS();
