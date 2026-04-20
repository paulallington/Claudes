# Project Pop-Out Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user right-click a project in the main sidebar and open it in its own OS window, with persistence of popped-out state across app restarts.

**Architecture:** Add a popout-mode boot path to the existing `index.html` / `renderer.js` (no new HTML). `main.js` gains a window registry keyed by project path, pop-out IPC handlers, and a `config:updated` broadcast so both windows stay in sync through the existing debounced single-writer (`scheduleWriteConfig`). PTY sessions in `pty-server.js` are untouched — windows attach to them by session id.

**Tech Stack:** Electron (main + renderer), `BrowserWindow`, existing IPC via `ipcMain.handle` / `ipcRenderer.invoke`, plain DOM/JS in renderer. No test framework exists — verification is manual against a running `npm start`.

**Spec:** `docs/superpowers/specs/2026-04-20-project-popout-window-design.md`

---

## File Structure

**Modified:**

- `main.js` — new popout window registry, `createProjectWindow()`, three IPC channels (`project:popOut`, `project:popIn`, `config:updated` broadcaster), startup restore, before-quit coordination, delete-project coordination.
- `preload.js` — expose the new IPC channels on `electronAPI`.
- `renderer.js` — mode detection at boot, `poppedOut` filter in sidebar render, right-click menu entry, popout-mode UI suppression, `config:updated` listener, pop-out action trigger, delete-project coordination.
- `index.html` — a `body` class marker for popout mode (purely cosmetic hook, no structural change).
- `styles.css` — rules scoped to `body.mode-popout` that hide sidebar + its resize handle.

**Created:** None.

**Why no split:** The pop-out renderer is ~95% the same code path as the main renderer (columns, terminals, toolbar, explorer, CLAUDE.md modal, git tab). Duplicating `renderer.js` would violate DRY and create drift. The existing file already does mode detection for several features; we add one more flag.

---

## Task 1: Add `poppedOut` / `popoutBounds` defaults on config load

**Files:**
- Modify: `renderer.js:559-587` (`loadProjects` function)

- [ ] **Step 1: Add defaulting for new fields**

In `loadProjects`, extend the existing field-defaulting loop so new projects have sane values. Replace the loop body at `renderer.js:563-567`:

```javascript
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
```

- [ ] **Step 2: Manually verify**

Run: `npm start`

Expected:
- App launches with existing projects intact.
- Open `~/.claudes/projects.json` and verify each project gets `poppedOut: false` and `popoutBounds: null` after first save (will happen automatically as debounced writes fire).

- [ ] **Step 3: Commit**

```bash
git add renderer.js
git commit -m "feat(popout): default poppedOut/popoutBounds on config load"
```

---

## Task 2: Add popout window registry and `createProjectWindow` in main

**Files:**
- Modify: `main.js:277-326` (near `createWindow`), add new function afterwards.

- [ ] **Step 1: Add registry and creator function**

Add after `createWindow()` (after `main.js:326`):

```javascript
// Registry of open popout windows keyed by project path.
const popoutWindows = new Map();

function createProjectWindow(projectKey) {
  if (popoutWindows.has(projectKey)) {
    const existing = popoutWindows.get(projectKey);
    if (!existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return existing;
    }
    popoutWindows.delete(projectKey);
  }

  const config = readConfig();
  const project = config.projects.find((p) => p.path === projectKey);
  if (!project) return null;

  const isLight = config.theme === 'auto' ? !nativeTheme.shouldUseDarkColors : config.theme === 'light';
  const bounds = project.popoutBounds || {};

  const win = new BrowserWindow({
    width: bounds.width || 1200,
    height: bounds.height || 800,
    x: typeof bounds.x === 'number' ? bounds.x : undefined,
    y: typeof bounds.y === 'number' ? bounds.y : undefined,
    minWidth: 600,
    minHeight: 400,
    title: 'Claudes \u2013 ' + (project.name || projectKey),
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon-tray.ico' : 'icon.png'),
    backgroundColor: isLight ? '#ffffff' : '#1a1a2e',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: isLight ? '#e8ecf1' : '#16213e',
      symbolColor: isLight ? '#1f2328' : '#e0e0e0',
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html', {
    query: { mode: 'popout', projectKey: projectKey }
  });

  const saveBoundsDebounced = debouncePopoutBounds(projectKey, win);
  win.on('move', saveBoundsDebounced);
  win.on('resize', saveBoundsDebounced);

  win.on('closed', () => {
    popoutWindows.delete(projectKey);
  });

  popoutWindows.set(projectKey, win);
  return win;
}

// Per-window debounce for bounds persistence so drag events don't flood writeConfig.
const POPOUT_BOUNDS_DEBOUNCE_MS = 300;
function debouncePopoutBounds(projectKey, win) {
  let timer = null;
  return function () {
    if (win.isDestroyed()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      const cfg = readConfig();
      const p = cfg.projects.find((x) => x.path === projectKey);
      if (!p) return;
      p.popoutBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      scheduleWriteConfig(cfg);
      broadcastConfigUpdated(cfg);
    }, POPOUT_BOUNDS_DEBOUNCE_MS);
  };
}

function broadcastConfigUpdated(config) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config:updated', config);
  }
  for (const win of popoutWindows.values()) {
    if (!win.isDestroyed()) {
      win.webContents.send('config:updated', config);
    }
  }
}
```

- [ ] **Step 2: Manually verify file still loads**

Run: `npm start`

Expected: App launches normally. No console errors. Nothing triggers `createProjectWindow` yet — this task is wiring only.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(popout): add popout window registry and createProjectWindow"
```

---

## Task 3: Add `project:popOut` and `project:popIn` IPC handlers

**Files:**
- Modify: `main.js`, add handlers next to `config:saveProjects` (after `main.js:373`).

- [ ] **Step 1: Add the two handlers**

Insert after the `config:saveProjects` handler block:

```javascript
ipcMain.handle('project:popOut', (event, projectKey) => {
  const cfg = readConfig();
  const project = cfg.projects.find((p) => p.path === projectKey);
  if (!project) return false;
  project.poppedOut = true;
  scheduleWriteConfig(cfg);
  broadcastConfigUpdated(cfg);
  createProjectWindow(projectKey);
  return true;
});

ipcMain.handle('project:popIn', (event, projectKey) => {
  const cfg = readConfig();
  const project = cfg.projects.find((p) => p.path === projectKey);
  if (!project) return false;
  project.poppedOut = false;
  scheduleWriteConfig(cfg);
  broadcastConfigUpdated(cfg);
  const win = popoutWindows.get(projectKey);
  if (win && !win.isDestroyed()) {
    win.close();
  }
  return true;
});
```

- [ ] **Step 2: Manually verify**

Run: `npm start`

Expected: App launches normally. No new behaviour visible yet (renderer hasn't been wired).

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(popout): add popOut/popIn IPC handlers"
```

---

## Task 4: Close popout on window close and mark `poppedOut: false`

**Files:**
- Modify: `main.js`, update the `win.on('closed', ...)` handler inside `createProjectWindow` added in Task 2.

- [ ] **Step 1: Replace the closed handler**

The current `closed` handler only removes from the registry. We also need to:
- Flush bounds one last time (synchronous getBounds before destroy).
- Mark `poppedOut: false` if the close was user-initiated (not app-quitting).

Replace the `win.on('closed', ...)` block with a `close`/`closed` pair:

```javascript
  win.on('close', () => {
    if (win.isDestroyed()) return;
    try {
      const b = win.getBounds();
      const cfg = readConfig();
      const p = cfg.projects.find((x) => x.path === projectKey);
      if (p) {
        p.popoutBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        if (!isQuitting) {
          p.poppedOut = false;
        }
        scheduleWriteConfig(cfg);
        broadcastConfigUpdated(cfg);
      }
    } catch (err) {
      console.error('popout close bookkeeping failed:', err);
    }
  });

  win.on('closed', () => {
    popoutWindows.delete(projectKey);
  });
```

Note: the `isQuitting` flag is already set in `before-quit` at `main.js:3165`. When the user quits from tray, popouts retain `poppedOut: true` so next launch restores them. When the user closes just the popout window, `poppedOut` flips to `false`.

- [ ] **Step 2: Manually verify**

Requires Task 5 and Task 7 before end-to-end behaviour is testable. For now run `npm start` and confirm no startup errors.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(popout): flip poppedOut on window close, preserve on quit"
```

---

## Task 5: Coordinate before-quit to close popouts cleanly

**Files:**
- Modify: `main.js:3164-3171` (`before-quit` handler).

- [ ] **Step 1: Close popouts during shutdown**

Replace the existing `before-quit` handler at `main.js:3164`:

```javascript
app.on('before-quit', () => {
  isQuitting = true;
  for (const win of popoutWindows.values()) {
    if (!win.isDestroyed()) {
      try { win.close(); } catch {}
    }
  }
  flushPendingConfig();
  stopAutomationScheduler();
  if (ptyServerProcess) {
    ptyServerProcess.kill();
  }
});
```

The close loop must run BEFORE `flushPendingConfig()` so the final `popoutBounds` writes go into `pendingConfig` and then get flushed synchronously.

- [ ] **Step 2: Manually verify**

Requires Tasks 6-8 before end-to-end testing. Run `npm start` and confirm app still quits cleanly via `File → Exit` / tray → Quit.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(popout): close popout windows during before-quit"
```

---

## Task 6: Expose popout IPC on the preload bridge

**Files:**
- Modify: `preload.js:3-112`.

- [ ] **Step 1: Add popout methods**

Add three new entries to the `electronAPI` object in `preload.js`. Insert near `saveProjects` (line 6):

```javascript
  popOutProject: (projectKey) => ipcRenderer.invoke('project:popOut', projectKey),
  popInProject: (projectKey) => ipcRenderer.invoke('project:popIn', projectKey),
  onConfigUpdated: (callback) => ipcRenderer.on('config:updated', (_, cfg) => callback(cfg)),
```

- [ ] **Step 2: Manually verify**

Run: `npm start`

Open DevTools in the main window (Ctrl+Shift+I) and in the console type:

```javascript
typeof window.electronAPI.popOutProject
```

Expected: `"function"`

Same for `popInProject` and `onConfigUpdated`.

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat(popout): expose popOut/popIn/onConfigUpdated on preload"
```

---

## Task 7: Add mode detection and popout boot path in renderer

**Files:**
- Modify: `renderer.js` (top-of-file, near line 1); `renderer.js:559-587` (`loadProjects`); `index.html` (add body class logic).
- Modify: `index.html` — no HTML change, but styles rely on body class set by renderer.

- [ ] **Step 1: Detect mode at script load**

Add near the top of `renderer.js`, immediately after the opening `var` declarations (around line 10):

```javascript
var popoutMode = false;
var popoutProjectKey = null;
(function detectPopoutMode() {
  try {
    var params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'popout') {
      popoutMode = true;
      popoutProjectKey = params.get('projectKey');
      document.body.classList.add('mode-popout');
    }
  } catch {}
})();
```

The `document.body.classList.add` call must wait for body to exist. Since this runs inline at script parse time and `renderer.js` is loaded at the bottom of `index.html`, body already exists. Verify by inspection.

- [ ] **Step 2: Branch the `loadProjects` function**

Replace `loadProjects` at `renderer.js:559`:

```javascript
function loadProjects() {
  if (!window.electronAPI) return;
  window.electronAPI.getProjects().then(function (cfg) {
    config = cfg || { projects: [], activeProjectIndex: -1 };
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
      setActiveProject(idx, true);
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
  });
}
```

- [ ] **Step 3: Add `config:updated` listener for live sync**

Add after `loadProjects` declaration (before the next function). This handler updates config in place when the main process broadcasts, and triggers a sidebar re-render in main mode. In popout mode, it only refreshes the single project title if name changed.

```javascript
if (window.electronAPI && window.electronAPI.onConfigUpdated) {
  window.electronAPI.onConfigUpdated(function (newCfg) {
    if (!newCfg) return;
    config = newCfg;
    if (popoutMode) {
      var p = config.projects.find(function (x) { return x.path === popoutProjectKey; });
      if (p) {
        activeProjectNameEl.textContent = p.name;
        document.title = 'Claudes \u2013 ' + p.name;
      }
    } else {
      renderProjectList();
    }
  });
}
```

- [ ] **Step 4: Manually verify main-mode boot still works**

Run: `npm start`

Expected:
- App launches, all projects still visible in the sidebar, previously active project is active.
- No console errors.

- [ ] **Step 5: Commit**

```bash
git add renderer.js
git commit -m "feat(popout): mode detection and popout boot path"
```

---

## Task 8: Hide popped-out projects in the main sidebar

**Files:**
- Modify: `renderer.js:888-951` (`renderProjectList`).

- [ ] **Step 1: Filter `poppedOut` projects upstream of grouping**

Replace the `allEntries` / `pinnedEntries` / `unpinnedEntries` block at `renderer.js:896-898`:

```javascript
  var allEntries = config.projects
    .map(function (p, i) { return { project: p, index: i }; })
    .filter(function (e) { return !e.project.poppedOut; });
  var pinnedEntries = allEntries.filter(function (e) { return e.project.pinned; });
  var unpinnedEntries = allEntries.filter(function (e) { return !e.project.pinned; });
```

The filter applies before pin/alpha-sort/worktree-group logic, so empty groups simply don't render (worktree grouping keys off presence in `entries`).

- [ ] **Step 2: Manually verify**

Run: `npm start`

Expected: No change from before (no project is `poppedOut: true` yet). Sidebar still renders everything.

Optional sanity check: manually edit `~/.claudes/projects.json`, set one project's `poppedOut: true`, restart app. Expected: that project does not appear in the sidebar. Then set it back to `false`.

- [ ] **Step 3: Commit**

```bash
git add renderer.js
git commit -m "feat(popout): filter popped-out projects from main sidebar"
```

---

## Task 9: Add "Open in new window" to the sidebar context menu

**Files:**
- Modify: `renderer.js:737-798` (`contextmenu` handler in `buildProjectItem`).

- [ ] **Step 1: Add the menu item and wire the action**

Insert after the last `addMenuItem(...)` call in the existing context menu (after the regroup block, before `menu.style.left = ...`) at approximately `renderer.js:766`:

```javascript
    addMenuItem('Open in new window', 'pop-out');
```

Add the click handler inside the existing `menu.onclick = function (ev) { ... }` block, before the closing `}` and the `menu.style.display = 'none'` line:

```javascript
      } else if (action === 'pop-out') {
        if (window.electronAPI && window.electronAPI.popOutProject) {
          window.electronAPI.popOutProject(config.projects[projIndex].path);
        }
```

So the handler now reads (showing the full resulting structure):

```javascript
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
        if (window.electronAPI && window.electronAPI.popOutProject) {
          window.electronAPI.popOutProject(config.projects[projIndex].path);
        }
      }
      menu.style.display = 'none';
    };
```

The renderer doesn't need to update its own `config` object manually — the main process will broadcast `config:updated`, and the listener added in Task 7 will re-render the sidebar (removing the popped-out entry).

Also: if the popped-out project was the active one, the listener's `renderProjectList()` alone won't switch active state. Handle that in the next step.

- [ ] **Step 2: Switch active project in main if we just popped out the active one**

Extend the `onConfigUpdated` listener added in Task 7, Step 3. Replace the main-mode branch:

```javascript
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
    }
```

- [ ] **Step 3: Manually verify end-to-end pop-out**

Run: `npm start`

1. Right-click any project in the sidebar.
2. Click **"Open in new window"**.

Expected:
- A new OS window opens with the project's toolbar and terminals.
- The project disappears from the main sidebar.
- If it was the active project, main switches to the next available one (or empty state).
- No console errors in either window.

- [ ] **Step 4: Commit**

```bash
git add renderer.js
git commit -m "feat(popout): add Open in new window context menu action"
```

---

## Task 10: Hide sidebar + related chrome in popout mode (CSS)

**Files:**
- Modify: `styles.css` (append at end).

- [ ] **Step 1: Add popout-mode CSS rules**

Append to `styles.css`:

```css
body.mode-popout #project-sidebar,
body.mode-popout #sidebar-resize-handle,
body.mode-popout #add-project-btn {
  display: none !important;
}

body.mode-popout #main-content {
  left: 0 !important;
  width: 100% !important;
}
```

Replace the selector names if they don't match. Verify by grepping `index.html`:

Run: `grep -n 'id="project-sidebar\|id="main-content\|id="add-project-btn\|id="sidebar-resize-handle' index.html`

Adjust the CSS selectors to match the actual ids. If `#main-content` uses different layout (flex), use equivalent overrides (`flex: 1`, etc.).

- [ ] **Step 2: Manually verify popout mode hides sidebar**

Run: `npm start`. Right-click a project → Open in new window.

Expected in the popout window:
- No left sidebar, no "add project" button, no sidebar resize handle.
- Columns area fills the full window width.
- The main window's sidebar appearance is unchanged.

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "feat(popout): hide sidebar and add-project in popout mode"
```

---

## Task 11: Hide sidebar-only controls in popout via JS (defensive)

**Files:**
- Modify: `renderer.js` — in the popout branch of `loadProjects` (added in Task 7).

Some controls may be positioned outside `#project-sidebar` (e.g., sort toggle button, pinned header, drag-reorder handlers). The CSS in Task 10 only covers known containers. Add a JS-level guard for any dynamic behaviour that references `projectListEl`.

- [ ] **Step 1: Skip project-list DOM work in popout mode**

In `loadProjects`, inside the `if (popoutMode) { ... }` branch added in Task 7, confirm that `renderProjectList()` is NOT called (it isn't — the branch returns early). That's already correct.

Additionally, guard any global subscribers that might assume the sidebar exists. Search:

Run: `grep -n 'projectListEl' renderer.js`

For each reference, verify it's either:
- Only fired in response to a user action that can't happen without the sidebar (safe), OR
- Inside `renderProjectList()` or a helper only called from it (safe — never invoked in popout mode).

If any call-site could fire unconditionally (e.g., an interval, an IPC listener), wrap it with:

```javascript
if (popoutMode) return;
```

Document which call-sites you touched in the commit message. If none need changes, skip this step.

- [ ] **Step 2: Manually verify popout window has no sidebar-dependent errors**

Run: `npm start` → right-click project → Open in new window. Open DevTools in the popout (Ctrl+Shift+I). Exercise features:
- Type in a terminal.
- Open explorer panel, git tab, CLAUDE.md modal.
- Spawn and kill a column.
- Click pause all / resume all in the toolbar.

Expected: No errors in DevTools console.

- [ ] **Step 3: Commit**

```bash
git add renderer.js
git commit -m "feat(popout): guard sidebar-only code paths in popout mode"
```

---

## Task 12: Restore popped-out projects on app startup

**Files:**
- Modify: `main.js:3126-3140` (`app.whenReady()`).

- [ ] **Step 1: Restore popouts after main window creation**

Replace the `whenReady` block at `main.js:3126`:

```javascript
  app.whenReady().then(async () => {
    await startPtyServer();
    startHookServer();
    createTray();
    createWindow();
    setupAutoUpdater();
    migrateLoopsToAutomations();
    startAutomationScheduler();

    const cfg = readConfig();
    for (const p of cfg.projects) {
      if (p.poppedOut) {
        createProjectWindow(p.path);
      }
    }

    powerMonitor.on('resume', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('power:resume');
      }
      for (const win of popoutWindows.values()) {
        if (!win.isDestroyed()) win.webContents.send('power:resume');
      }
    });
  });
```

Note: `startPtyServer()` has already resolved before we create popout windows, so popout renderers can connect to pty-server immediately.

- [ ] **Step 2: Manually verify persistence**

Run: `npm start` → pop out a project → move/resize the window → close app fully (tray → Quit).

Relaunch: `npm start`

Expected:
- The popped-out project reopens automatically in its own window at the same size and position.
- It does not appear in the main sidebar.

Close the popout (click its X).

Relaunch: `npm start`

Expected:
- Only the main window opens. The project is back in the sidebar.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(popout): restore popped-out windows on startup"
```

---

## Task 13: Coordinate project deletion when popped out

**Files:**
- Modify: `main.js` — add a dedicated window-close IPC that does not touch config.
- Modify: `preload.js` — expose the new method.
- Modify: `renderer.js:1135-1174` (`removeProject`).

Background: In main mode, a popped-out project is hidden from the sidebar (Task 8), so the × button flow isn't reachable directly. This task is defensive hardening so that if a popped-out project ever reaches `removeProject` (e.g., future UI, edited config), we close its window without racing the config mutation.

Naive approach (calling `popInProject` then deleting) races: `popInProject` reads disk, mutates `poppedOut: false`, writes — but `removeProject` also writes a spliced-config; last writer wins, and if popInProject wins, the project reappears. So we use a window-only close path that never touches config.

- [ ] **Step 1: Add `project:closePopoutWindow` IPC in main**

Insert after the `project:popIn` handler added in Task 3:

```javascript
ipcMain.handle('project:closePopoutWindow', (event, projectKey) => {
  const win = popoutWindows.get(projectKey);
  if (win && !win.isDestroyed()) {
    // Set a sentinel so the close handler skips its config bookkeeping.
    win._skipCloseBookkeeping = true;
    win.close();
  }
  return true;
});
```

Update the `close` handler inside `createProjectWindow` (from Task 4) to honour the sentinel:

```javascript
  win.on('close', () => {
    if (win.isDestroyed()) return;
    if (win._skipCloseBookkeeping) return;
    try {
      const b = win.getBounds();
      const cfg = readConfig();
      const p = cfg.projects.find((x) => x.path === projectKey);
      if (p) {
        p.popoutBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        if (!isQuitting) {
          p.poppedOut = false;
        }
        scheduleWriteConfig(cfg);
        broadcastConfigUpdated(cfg);
      }
    } catch (err) {
      console.error('popout close bookkeeping failed:', err);
    }
  });
```

- [ ] **Step 2: Expose on preload**

Add to `preload.js`:

```javascript
  closePopoutWindow: (projectKey) => ipcRenderer.invoke('project:closePopoutWindow', projectKey),
```

- [ ] **Step 3: Close popout before deleting in renderer**

Insert at the top of `removeProject` (`renderer.js:1135`), right after the `confirm(...)` guard:

```javascript
  if (project.poppedOut && window.electronAPI && window.electronAPI.closePopoutWindow) {
    window.electronAPI.closePopoutWindow(project.path);
  }
```

The existing `removeProject` then mutates its local `config`, calls `saveConfig()` which goes through `scheduleWriteConfig`. No competing write from main's close handler because of the sentinel.

- [ ] **Step 4: Manually verify**

Run: `npm start`.

Primary check: delete a normal (non-popped-out) project via the × button — confirm it works and is removed from the sidebar.

Defensive check: manually edit `~/.claudes/projects.json`, set one project to `poppedOut: false`, then in code temporarily call `removeProject` while `project.poppedOut === true`. Easiest way: in DevTools, `config.projects[0].poppedOut = true; removeProject(0);` — confirm the popout window closes (if one exists for that key) and the project is deleted from config.

Cleaner check: run through the full pop-out → pop-in → × delete flow end-to-end.

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js renderer.js
git commit -m "feat(popout): close popout window before deleting project"
```

---

## Task 14: Theme sync across windows

**Files:**
- Modify: `main.js:394-403` (`theme:setTitleBarOverlay`).

When the user changes theme in the main window, the existing handler only updates `mainWindow`. Popouts should also update.

- [ ] **Step 1: Apply theme to all popout windows too**

Replace the handler at `main.js:394`:

```javascript
ipcMain.handle('theme:setTitleBarOverlay', (event, colors) => {
  const apply = (win) => {
    if (!win || win.isDestroyed()) return;
    win.setTitleBarOverlay({
      color: colors.color,
      symbolColor: colors.symbolColor,
      height: 40
    });
    win.setBackgroundColor(colors.color);
  };
  apply(mainWindow);
  for (const win of popoutWindows.values()) apply(win);
});
```

Also update the `nativeTheme.on('updated', ...)` listener at `main.js:323-325`:

```javascript
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('theme:osChanged', nativeTheme.shouldUseDarkColors);
    }
    for (const win of popoutWindows.values()) {
      if (!win.isDestroyed()) win.webContents.send('theme:osChanged', nativeTheme.shouldUseDarkColors);
    }
  });
```

- [ ] **Step 2: Manually verify**

Run: `npm start`. Pop out a project. In the main window, switch theme (light ↔ dark) via existing settings.

Expected: Popout window's title bar and background update in sync.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(popout): propagate theme changes to popout windows"
```

---

## Task 15: Full verification pass against spec checklist

**Files:** None modified.

- [ ] **Step 1: Work through the spec's verification checklist**

Open `docs/superpowers/specs/2026-04-20-project-popout-window-design.md`, go through every item under "Verification checklist". For each: perform the action, record PASS/FAIL.

Run: `npm start`

**Golden path (1-5):**
- [ ] Right-click → Open in new window shows popout with terminals intact (no restart).
- [ ] Project disappears from main sidebar.
- [ ] Typing/output works in popout.
- [ ] Closing popout returns project to sidebar, main's active project unchanged.

**Persistence (6-7):**
- [ ] Pop out, move/resize, Quit, relaunch → popout restored at same bounds.
- [ ] Pop out, close popout, relaunch → project in main sidebar, no popout.

**Edge cases (8-14):**
- [ ] Popping out active project switches main to next available.
- [ ] Main hides to tray while popout open → popout stays visible.
- [ ] Tray quit closes all popouts, bounds persisted.
- [ ] Two popouts open concurrently, each independent.
- [ ] Deleting project works for non-popped-out projects.
- [ ] CLAUDE.md editor, spawn options, explorer panel, git tab, pause/resume all work in popout.

**Regression (15-16):**
- [ ] Non-popped-out projects honour pin, alpha sort, worktree groups, drag reorder, collapsible groups.
- [ ] `projects.json` debounced writes still flush on quit.

- [ ] **Step 2: Fix any FAIL items inline**

If any item fails, debug and patch. Commit each fix on its own:

```bash
git commit -m "fix(popout): <short description>"
```

- [ ] **Step 3: Final commit (if no fixes needed)**

No commit required — verification-only task.

---

## Notes for the implementer

- This codebase has no automated test framework. All verification is manual. Do not invent a test runner; follow the steps as written.
- `scheduleWriteConfig(cfg)` is the single writer for `projects.json`. Never call `writeConfig` directly from renderer-facing handlers.
- Always pair a config mutation with `broadcastConfigUpdated(cfg)` so renderers stay in sync without re-reading disk.
- Popout windows reuse the existing `index.html` and `renderer.js`. The mode flag is carried in the URL query string, readable via `window.location.search`.
- PTY sessions are referenced by id and live in `pty-server.js` — they survive any UI window being closed or reopened, because the child process is independent of BrowserWindows.
- If an IPC handler reads config, mutates it, writes it back, and broadcasts, do it in a single synchronous block. `readConfig()` reads from disk each call, so interleaved writes from two handlers could lose updates if they overlap — in practice the debounce serialises them, but keep each handler atomic.
