# Claude Code Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 8 new features integrating recent Claude Code CLI capabilities into the Claudes Electron app.

**Architecture:** All features modify the existing 4-file architecture (renderer.js, index.html, styles.css, main.js/preload.js). Features 1-3 add options to the spawn dropdown. Features 4-6 add per-column controls. Features 7-8 add toolbar buttons. Each feature is an independent commit.

**Tech Stack:** Electron, xterm.js, node-pty (via pty-server.js), vanilla JS

---

### Task 1: Worktree spawn option

Add a "Worktree" text input to the spawn dropdown. When filled, appends `--worktree <name>` to CLI args.

**Files:**
- Modify: `index.html` (spawn dropdown)
- Modify: `renderer.js` (buildSpawnArgs)

- [ ] **Step 1: Add worktree input to spawn dropdown in index.html**

After the custom args row, before the final divider+button, add:
```html
<div class="spawn-divider"></div>
<div class="spawn-option spawn-custom-row">
  <input type="text" id="opt-worktree" placeholder="Worktree name..." title="Spawn in isolated git worktree (--worktree)">
</div>
```

- [ ] **Step 2: Wire up in renderer.js**

Add `var optWorktree = document.getElementById('opt-worktree');` to the top variables.

In `buildSpawnArgs()`, after the custom args block, add:
```javascript
var worktree = optWorktree.value.trim();
if (worktree) {
  args.push('--worktree', worktree);
}
```

- [ ] **Step 3: Commit**

```
git commit -m "Add worktree spawn option for isolated git branches"
```

---

### Task 2: Remote Control toggle in spawn dropdown

Add a "Remote Control" checkbox to the spawn dropdown. When checked, appends `--remote-control` to CLI args.

**Files:**
- Modify: `index.html` (spawn dropdown)
- Modify: `renderer.js` (buildSpawnArgs)

- [ ] **Step 1: Add checkbox to spawn dropdown in index.html**

After the Skip Permissions label, add:
```html
<label class="spawn-option">
  <input type="checkbox" id="opt-remote-control"> Remote Control
</label>
```

- [ ] **Step 2: Wire up in renderer.js**

Add `var optRemoteControl = document.getElementById('opt-remote-control');` to top variables.

In `buildSpawnArgs()`, after skip permissions block:
```javascript
if (optRemoteControl.checked) {
  args.push('--remote-control');
}
```

- [ ] **Step 3: Commit**

```
git commit -m "Add Remote Control toggle to spawn options"
```

---

### Task 3: --bare flag option in spawn dropdown

Add a "Bare mode" checkbox to the spawn dropdown. When checked, appends `--bare` to CLI args. Only relevant for headless/scripted spawns.

**Files:**
- Modify: `index.html` (spawn dropdown)
- Modify: `renderer.js` (buildSpawnArgs)

- [ ] **Step 1: Add checkbox after Remote Control**

```html
<label class="spawn-option">
  <input type="checkbox" id="opt-bare"> Bare Mode
</label>
```

- [ ] **Step 2: Wire up in renderer.js**

Add `var optBare = document.getElementById('opt-bare');`

In `buildSpawnArgs()`:
```javascript
if (optBare.checked) {
  args.push('--bare');
}
```

- [ ] **Step 3: Commit**

```
git commit -m "Add bare mode option to spawn dropdown"
```

---

### Task 4: /compact button per column

Add a compact button to each column header that sends `/compact\n` to that column's PTY.

**Files:**
- Modify: `renderer.js` (createColumnHeader)
- Modify: `styles.css` (button styling)

- [ ] **Step 1: Add compact button in createColumnHeader**

After the maximize button, before close button:
```javascript
var compactBtn = document.createElement('span');
compactBtn.className = 'col-action';
compactBtn.title = 'Compact context (/compact)';
compactBtn.textContent = '\u229C'; // circled equals - represents compression
compactBtn.addEventListener('click', function () {
  wsSend({ type: 'write', id: id, data: '/compact\n' });
});
```

Append: `header.appendChild(compactBtn);`

- [ ] **Step 2: Add CSS for .col-action**

```css
.column-header .col-action {
  cursor: pointer;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 3px;
}

.column-header .col-action:hover {
  background: var(--hover-strong);
  color: var(--text-bright);
}
```

- [ ] **Step 3: Commit**

```
git commit -m "Add /compact button to column headers"
```

---

### Task 5: Effort level control per column header

Add a small dropdown in each column header to set effort level (low/medium/high). Sends the `/config` command to change effort.

**Files:**
- Modify: `renderer.js` (createColumnHeader)
- Modify: `styles.css` (select styling)

- [ ] **Step 1: Add effort select in createColumnHeader**

After compact button, before maximize button:
```javascript
var effortSelect = document.createElement('select');
effortSelect.className = 'col-effort';
effortSelect.title = 'Effort level';
effortSelect.innerHTML = '<option value="">Effort</option><option value="low">Low</option><option value="medium">Med</option><option value="high">High</option>';
effortSelect.addEventListener('change', function () {
  if (effortSelect.value) {
    wsSend({ type: 'write', id: id, data: '/config set effort ' + effortSelect.value + '\n' });
  }
});
```

Append: `header.appendChild(effortSelect);`

- [ ] **Step 2: Add CSS for .col-effort**

```css
.column-header .col-effort {
  background: transparent;
  border: 1px solid var(--border-dim);
  color: var(--text-dim);
  font-size: 10px;
  padding: 0 2px;
  border-radius: 3px;
  cursor: pointer;
  outline: none;
  max-width: 58px;
}

.column-header .col-effort:hover {
  border-color: var(--accent);
  color: var(--text-secondary);
}

.column-header .col-effort option {
  background: var(--bg-toolbar);
  color: var(--text-primary);
}
```

- [ ] **Step 3: Commit**

```
git commit -m "Add effort level dropdown to column headers"
```

---

### Task 6: /teleport button per column

Add a teleport button to each column header that sends `/teleport\n` to that column's PTY.

**Files:**
- Modify: `renderer.js` (createColumnHeader)

- [ ] **Step 1: Add teleport button in createColumnHeader**

After compact button, before effort select:
```javascript
var teleportBtn = document.createElement('span');
teleportBtn.className = 'col-action';
teleportBtn.title = 'Teleport to claude.ai (/teleport)';
teleportBtn.textContent = '\u21F1'; // upward arrow to bar - represents "send up"
teleportBtn.addEventListener('click', function () {
  wsSend({ type: 'write', id: id, data: '/teleport\n' });
});
```

Append: `header.appendChild(teleportBtn);`

- [ ] **Step 2: Commit**

```
git commit -m "Add /teleport button to column headers"
```

---

### Task 7: Claude Config button in toolbar

Add a "Config" button to the toolbar that opens `~/.claude/settings.json` in the existing file editor modal.

**Files:**
- Modify: `index.html` (toolbar button)
- Modify: `renderer.js` (click handler)
- Modify: `main.js` (IPC to resolve home dir)
- Modify: `preload.js` (expose API)

- [ ] **Step 1: Add button to toolbar in index.html**

After the theme select in toolbar-left:
```html
<button id="btn-claude-config" class="btn-claude-md" title="Edit Claude settings (~/.claude/settings.json)">Config</button>
```

- [ ] **Step 2: Add IPC handler in main.js**

```javascript
ipcMain.handle('claude:getConfigPath', () => {
  return path.join(os.homedir(), '.claude', 'settings.json');
});
```

- [ ] **Step 3: Expose in preload.js**

```javascript
getClaudeConfigPath: () => ipcRenderer.invoke('claude:getConfigPath'),
```

- [ ] **Step 4: Add click handler in renderer.js**

```javascript
document.getElementById('btn-claude-config').addEventListener('click', function () {
  if (!window.electronAPI || !window.electronAPI.getClaudeConfigPath) return;
  window.electronAPI.getClaudeConfigPath().then(function (configPath) {
    openFileEditor(configPath);
  });
});
```

- [ ] **Step 5: Commit**

```
git commit -m "Add Config button to open Claude settings.json"
```

---

### Task 8: HTTP Hooks for centralized activity monitoring

Run a small HTTP server in the Electron main process. Claude sessions can POST hook events to it. The main process relays these to the renderer for precise activity indicators.

**Files:**
- Modify: `main.js` (HTTP server, IPC)
- Modify: `preload.js` (expose hook events)
- Modify: `renderer.js` (consume hook events for activity state)

- [ ] **Step 1: Add HTTP server in main.js**

After the pty server startup, create a minimal HTTP server on a random port:
```javascript
const http = require('http');

let hookServer;
let hookServerPort;

function startHookServer() {
  hookServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/hook') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const event = JSON.parse(body);
          mainWindow?.webContents.send('hook:event', event);
        } catch {}
        res.writeHead(200);
        res.end('ok');
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  hookServer.listen(0, '127.0.0.1', () => {
    hookServerPort = hookServer.address().port;
    console.log('[hook-server] listening on port', hookServerPort);
  });
}
```

Add IPC handler:
```javascript
ipcMain.handle('hooks:getPort', () => hookServerPort);
```

Call `startHookServer()` in the app.whenReady block.

- [ ] **Step 2: Expose in preload.js**

```javascript
getHookServerPort: () => ipcRenderer.invoke('hooks:getPort'),
onHookEvent: (callback) => ipcRenderer.on('hook:event', (_, event) => callback(event)),
```

- [ ] **Step 3: Consume hook events in renderer.js**

Add after WebSocket setup:
```javascript
if (window.electronAPI && window.electronAPI.onHookEvent) {
  window.electronAPI.onHookEvent(function (event) {
    // event: { session_id, type: 'Notification', matcher: 'idle_prompt'|'permission_prompt', ... }
    // Map session_id to column and update activity state
    allColumns.forEach(function (col, id) {
      if (col.sessionId && event.session_id === col.sessionId) {
        if (event.matcher === 'idle_prompt') {
          setActivity(id, 'waiting');
        } else if (event.matcher === 'permission_prompt') {
          setActivity(id, 'waiting');
        }
      }
    });
  });
}
```

Expose the hook server port so users can configure Claude hooks to POST to it:
```javascript
if (window.electronAPI && window.electronAPI.getHookServerPort) {
  window.electronAPI.getHookServerPort().then(function (port) {
    console.log('[hooks] Hook server available at http://127.0.0.1:' + port + '/hook');
  });
}
```

- [ ] **Step 4: Commit**

```
git commit -m "Add HTTP hook server for centralized activity monitoring"
```
