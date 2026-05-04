# Power-User Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five power-user features that compound: a Cmd-K command palette, a live hook-event inspector, a prompt snippet library with variables, endpoint failover, and prompt-history search across `~/.claude/history.jsonl`.

**Architecture:** Same 4-file extension pattern as the rest of the app (main.js, preload.js, renderer.js, index.html, styles.css), with one new pure-JS helper under `lib/` for fuzzy ranking. The hook inspector reuses the existing hook server (`main.js:1807`); endpoint failover extends the existing endpoint preset model. Prompt snippets persist to a new file under `~/.claudes/`.

**Tech Stack:** Electron IPC, vanilla DOM, Node.js native test runner, existing hook server + WebSocket bus, existing endpoint-preset persistence.

**Prerequisite:** This plan assumes the foundation features in `docs/superpowers/plans/2026-05-04-plan-limits-foundation-features.md` are merged. The session full-text search there is distinct from the prompt-history search here (transcripts vs. user prompts).

**Conventions:**
- Spawn / Kill / Respawn (UI strings)
- Background `#1a1a2e` for terminal panes; existing CSS variables for chrome
- Match the existing commit-message style; small focused commits per task

---

## Phase 1 — Cmd-K command palette

A modal triggered by Ctrl+K (Cmd+K on Mac) that fuzzy-matches across:
- **Project switch** ("switch to <name>")
- **Spawn** ("spawn in <project>" / "respawn focused column")
- **Slash command** (insert `/<name>` into focused terminal)
- **App actions** (open Usage, open Settings, broadcast, etc.)

The match list is generated dynamically; commands are typed entries with a label, keywords, and an action function.

### Task 1.1: Pure fuzzy-rank helper

**Files:**
- Create: `lib/fuzzy-rank.js`
- Test: `test/fuzzy-rank.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/fuzzy-rank.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { fuzzyRank } = require('../lib/fuzzy-rank');

const items = [
  { id: 1, label: 'Switch to Claudes' },
  { id: 2, label: 'Switch to other-project' },
  { id: 3, label: 'Open Usage' },
  { id: 4, label: 'Spawn in Claudes' }
];

test('empty query returns input order', () => {
  const out = fuzzyRank(items, '', i => i.label);
  assert.deepStrictEqual(out.map(x => x.id), [1, 2, 3, 4]);
});

test('subsequence match returns scored hits, exact substrings rank highest', () => {
  const out = fuzzyRank(items, 'Claudes', i => i.label);
  assert.deepStrictEqual(out.slice(0, 2).map(x => x.id).sort(), [1, 4]);
});

test('non-matches are excluded', () => {
  const out = fuzzyRank(items, 'xyz', i => i.label);
  assert.strictEqual(out.length, 0);
});

test('case-insensitive', () => {
  const out = fuzzyRank(items, 'OPEN', i => i.label);
  assert.deepStrictEqual(out.map(x => x.id), [3]);
});

test('subsequence — "swclo" matches "Switch to Claudes"', () => {
  const out = fuzzyRank(items, 'swclo', i => i.label);
  assert.ok(out.length >= 1);
  assert.strictEqual(out[0].id, 1);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `lib/fuzzy-rank.js`:

```javascript
// Lightweight subsequence-based fuzzy ranker.
// Score = +100 for substring at start, +50 for substring anywhere, +1 per
// char of subsequence match (with -1 penalty per char gap between matches).
// Returns items sorted desc by score; non-matches dropped. Stable for ties.
function score(label, q) {
  if (!q) return 0;
  const lab = label.toLowerCase();
  const query = q.toLowerCase();
  if (lab.startsWith(query)) return 1000 + (label.length - query.length === 0 ? 50 : 0);
  const idx = lab.indexOf(query);
  if (idx !== -1) return 500 - idx;

  let s = 0, qi = 0, lastMatch = -1;
  for (let i = 0; i < lab.length && qi < query.length; i++) {
    if (lab[i] === query[qi]) {
      s += 5;
      if (lastMatch >= 0) s -= (i - lastMatch - 1);  // gap penalty
      lastMatch = i;
      qi++;
    }
  }
  if (qi < query.length) return -1;  // not all chars matched
  return s;
}

function fuzzyRank(items, query, getLabel) {
  if (!query) return items.slice();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const s = score(getLabel(items[i]), query);
    if (s < 0) continue;
    out.push({ idx: i, item: items[i], score: s });
  }
  out.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return out.map(o => o.item);
}

module.exports = { fuzzyRank, score };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS — five new tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/fuzzy-rank.js test/fuzzy-rank.test.js
git commit -m "feat(palette): pure fuzzy-rank helper"
```

### Task 1.2: Palette UI shell

**Files:**
- Modify: `index.html` (add palette overlay)
- Modify: `styles.css`
- Modify: `renderer.js`
- Modify: `preload.js` (expose fuzzy-rank IPC)
- Modify: `main.js`

- [ ] **Step 1: Add palette markup**

In `index.html` near other modals:

```html
<div id="palette-overlay" class="palette-overlay hidden">
  <div class="palette">
    <input type="text" id="palette-input" class="palette-input" placeholder="Type a command, project, or slash command…" autocomplete="off">
    <div id="palette-results" class="palette-results"></div>
    <div class="palette-hint">↑↓ navigate · ↵ run · Esc close</div>
  </div>
</div>
```

- [ ] **Step 2: Style**

```css
.palette-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.4);
  z-index: 2000;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
}
.palette-overlay.hidden { display: none; }
.palette {
  width: 560px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: #1a1a2e;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.6);
  overflow: hidden;
}
.palette-input {
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-primary);
  font-size: 16px;
  padding: 14px 16px;
  outline: none;
}
.palette-results {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.palette-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-primary);
}
.palette-row.active { background: rgba(79,140,255,0.18); }
.palette-row .palette-row-kind {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-left: 12px;
}
.palette-hint {
  font-size: 11px;
  color: var(--text-dimmer);
  padding: 6px 16px;
  border-top: 1px solid var(--border-subtle);
  text-align: right;
}
```

- [ ] **Step 3: Expose fuzzy-rank via preload**

In `main.js`:

```javascript
const { fuzzyRank } = require('./lib/fuzzy-rank');
ipcMain.handle('palette:rank', (_event, items, query) => fuzzyRank(items, query, x => x.label));
```

In `preload.js`:

```javascript
paletteRank: (items, query) => ipcRenderer.invoke('palette:rank', items, query),
```

- [ ] **Step 4: Build the palette command list and wiring**

In `renderer.js` add at end of file:

```javascript
(function setupPalette() {
  var overlay = document.getElementById('palette-overlay');
  var input = document.getElementById('palette-input');
  var results = document.getElementById('palette-results');
  if (!overlay) return;

  var SLASH_COMMANDS = [
    '/help', '/clear', '/compact', '/cost', '/usage', '/model', '/agents',
    '/mcp', '/release', '/review', '/security-review', '/init',
    // Add more as the user's set grows. Discovered from the typical Claude
    // Code default-skill list; user's installed skills can be appended at
    // open-time by reading ~/.claude/commands/ if desired.
  ];

  function buildCommands() {
    var cmds = [];
    // Project switches + spawns
    if (config && config.projects) {
      config.projects.forEach(function (p) {
        cmds.push({
          label: 'Switch to ' + (p.name || projectKeyToName(p.path)),
          kind: 'project',
          run: function () { setActiveProject(config.projects.indexOf(p), true); }
        });
        cmds.push({
          label: 'Spawn in ' + (p.name || projectKeyToName(p.path)),
          kind: 'spawn',
          run: function () { setActiveProject(config.projects.indexOf(p), true); addColumn(null, null, spawnOpts()); }
        });
      });
    }
    // Slash commands → write to focused column
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
    // App actions
    cmds.push({ label: 'Open Usage', kind: 'action', run: openUsageModal });
    cmds.push({ label: 'Add project…', kind: 'action', run: function () {
      document.getElementById('btn-add-project').click();
    }});
    cmds.push({ label: 'Toggle sidebar', kind: 'action', run: function () {
      document.getElementById('btn-toggle-sidebar').click();
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
  var selectedIdx = 0;

  function open() {
    commands = buildCommands();
    overlay.classList.remove('hidden');
    input.value = '';
    input.focus();
    render(commands);
  }
  function close() { overlay.classList.add('hidden'); }

  function render(list) {
    results.innerHTML = '';
    list.slice(0, 50).forEach(function (cmd, i) {
      var row = document.createElement('div');
      row.className = 'palette-row' + (i === selectedIdx ? ' active' : '');
      row.dataset.idx = i;
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

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); open(); }
    if (overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') { close(); return; }
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
      var idx = parseInt(rendered[selectedIdx]?.dataset.idx, 10);
      if (!isNaN(idx)) runAt(idx, lastFiltered);
    }
  });

  function updateActive(rows) {
    rows.forEach(function (r, i) { r.classList.toggle('active', i === selectedIdx); });
    var active = rows[selectedIdx];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  var lastFiltered = [];
  input.addEventListener('input', function () {
    var q = input.value;
    window.electronAPI.paletteRank(commands, q).then(function (filtered) {
      lastFiltered = filtered;
      selectedIdx = 0;
      render(filtered);
    });
  });

  // Initial population so Enter works without typing
  lastFiltered = commands;
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
})();
```

- [ ] **Step 5: Smoke test**

Run: `npm start`. Press Ctrl+K. Expected: palette opens, lists projects + slash commands + actions. Type "swit cla" — fuzzy-matches "Switch to Claudes" first. Press Enter — switches project. Reopen, type "/comp", select "/compact", Enter — `/compact\r` is sent to the focused column.

- [ ] **Step 6: Commit**

```bash
git add lib/fuzzy-rank.js index.html main.js preload.js renderer.js styles.css test/fuzzy-rank.test.js
git commit -m "feat(palette): Cmd-K command palette with fuzzy match"
```

---

## Phase 2 — Live hook event inspector

The app already runs a hook server on a dynamic port (`main.js:1807`) and forwards events to the renderer via `ipcRenderer.on('hook:event', …)` (`preload.js:72`). Build a panel that shows a streaming list of those events with timing, project/session attribution, and an expandable detail view.

### Task 2.1: Inspector panel UI

**Files:**
- Modify: `index.html` (add a new "Hooks" tab to the explorer panel)
- Modify: `renderer.js`
- Modify: `styles.css`

- [ ] **Step 1: Add the tab**

In `index.html`, find the explorer tabs (`<button class="explorer-tab" data-tab="files">…`). Add a new tab:

```html
<button class="explorer-tab" data-tab="hooks">Hooks</button>
```

Add the tab content panel alongside the others:

```html
<div id="tab-hooks" class="tab-content">
  <div class="hooks-toolbar">
    <input type="search" id="hooks-filter" placeholder="Filter events…" autocomplete="off">
    <button id="hooks-clear" class="hooks-btn" title="Clear">Clear</button>
    <label class="hooks-pause-toggle">
      <input type="checkbox" id="hooks-pause"> Pause
    </label>
  </div>
  <div id="hooks-list" class="hooks-list"></div>
</div>
```

- [ ] **Step 2: Style**

```css
.hooks-toolbar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--border-subtle); }
#hooks-filter {
  flex: 1;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.hooks-btn { background: transparent; border: 1px solid var(--border-subtle); color: var(--text-dim); border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; }
.hooks-btn:hover { color: var(--text-primary); }
.hooks-pause-toggle { font-size: 11px; color: var(--text-dim); display: flex; align-items: center; gap: 4px; }
.hooks-list { overflow-y: auto; flex: 1; }
.hook-row {
  font-size: 11px;
  padding: 4px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.03);
  font-family: var(--mono-font, monospace);
  color: var(--text-primary);
  cursor: pointer;
}
.hook-row:hover { background: rgba(255,255,255,0.03); }
.hook-row .hook-time { color: var(--text-dimmer); margin-right: 6px; font-variant-numeric: tabular-nums; }
.hook-row .hook-event { color: #4f8cff; margin-right: 6px; }
.hook-row .hook-tool { color: #8be9fd; margin-right: 6px; }
.hook-row.expanded { background: rgba(79,140,255,0.06); white-space: pre-wrap; }
.hook-detail { margin-top: 4px; color: var(--text-dim); font-size: 10.5px; }
```

- [ ] **Step 3: Wire it up**

In `renderer.js` near other tab-content init:

```javascript
(function setupHooks() {
  var listEl = document.getElementById('hooks-list');
  var filterEl = document.getElementById('hooks-filter');
  var clearBtn = document.getElementById('hooks-clear');
  var pauseEl = document.getElementById('hooks-pause');
  if (!listEl) return;

  var MAX_EVENTS = 1000;  // ring buffer
  var events = [];
  var filterQuery = '';
  var paused = false;

  function fmtTime(ts) {
    var d = new Date(ts);
    return d.toTimeString().slice(0, 8);
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

  function summarize(input) {
    if (!input) return '';
    if (typeof input === 'string') return input.slice(0, 80);
    if (input.command) return String(input.command).slice(0, 80);
    if (input.file_path) return input.file_path;
    if (input.path) return input.path;
    if (input.pattern) return input.pattern;
    return '';
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
  clearBtn.addEventListener('click', function () { events = []; rerender(); });
  pauseEl.addEventListener('change', function () { paused = pauseEl.checked; });

  if (window.electronAPI && window.electronAPI.onHookEvent) {
    window.electronAPI.onHookEvent(function (ev) {
      if (paused) return;
      ev.received_at = Date.now();
      events.push(ev);
      if (events.length > MAX_EVENTS) events.shift();
      // Append-only: avoid full rerender unless the filter would exclude or scroll fights
      if (eventMatchesFilter(ev)) {
        var row = renderEvent(ev);
        listEl.appendChild(row);
        // Trim DOM to last 200 to keep things responsive
        while (listEl.children.length > 200) listEl.removeChild(listEl.firstChild);
        listEl.scrollTop = listEl.scrollHeight;
      }
    });
  }
})();
```

- [ ] **Step 4: Smoke test**

Run: `npm start`. Spawn a Claude column and ask Claude to do something tool-heavy ("read file X"). Switch to the Hooks tab. Expected: PreToolUse / PostToolUse events stream in with timestamps. Click a row to expand the JSON. Filter "Read" — only Read events show. Pause checkbox stops appending.

- [ ] **Step 5: Commit**

```bash
git add index.html renderer.js styles.css
git commit -m "feat(hooks): live hook event inspector tab"
```

---

## Phase 3 — Prompt snippet library

A persistent library of prompt templates with `{{variable}}` placeholders, expandable into the focused terminal via `\\name` typed in a small overlay. Snippets stored at `~/.claudes/snippets.json`.

### Task 3.1: Persistence + IPC

**Files:**
- Modify: `main.js`
- Modify: `preload.js`

- [ ] **Step 1: Add file constants and CRUD helpers**

In `main.js`, near the existing CONFIG constants:

```javascript
const SNIPPETS_FILE = path.join(CONFIG_DIR, 'snippets.json');

function readSnippets() {
  try { return JSON.parse(fs.readFileSync(SNIPPETS_FILE, 'utf8')); }
  catch { return { snippets: [] }; }
}
function writeSnippets(data) {
  ensureConfigDir();
  fs.writeFileSync(SNIPPETS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

ipcMain.handle('snippets:list', () => readSnippets().snippets || []);
ipcMain.handle('snippets:save', (_event, snippet) => {
  const data = readSnippets();
  if (!Array.isArray(data.snippets)) data.snippets = [];
  if (snippet.id) {
    const i = data.snippets.findIndex(s => s.id === snippet.id);
    if (i >= 0) data.snippets[i] = snippet; else data.snippets.push(snippet);
  } else {
    snippet.id = 'snip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    data.snippets.push(snippet);
  }
  writeSnippets(data);
  return snippet;
});
ipcMain.handle('snippets:delete', (_event, id) => {
  const data = readSnippets();
  data.snippets = (data.snippets || []).filter(s => s.id !== id);
  writeSnippets(data);
  return true;
});
```

- [ ] **Step 2: Expose via preload**

```javascript
listSnippets: () => ipcRenderer.invoke('snippets:list'),
saveSnippet: (snippet) => ipcRenderer.invoke('snippets:save', snippet),
deleteSnippet: (id) => ipcRenderer.invoke('snippets:delete', id),
```

- [ ] **Step 3: Commit**

```bash
git add main.js preload.js
git commit -m "feat(snippets): persistence + IPC for prompt snippet library"
```

### Task 3.2: Snippets manager modal

**Files:**
- Modify: `index.html`
- Modify: `renderer.js`
- Modify: `styles.css`

- [ ] **Step 1: Add modal markup**

In `index.html`:

```html
<div id="snippets-modal" class="modal-overlay hidden">
  <div class="modal-dialog snippets-dialog">
    <div class="modal-header">
      <span class="modal-title">Prompt snippets</span>
      <span id="snippets-close" class="modal-close">&times;</span>
    </div>
    <div class="modal-body snippets-body">
      <div class="snippets-list-pane">
        <button id="snippets-new" class="snippets-btn">+ New</button>
        <div id="snippets-list" class="snippets-list"></div>
      </div>
      <div class="snippets-edit-pane">
        <label>Trigger (typed as <code>\\trigger</code>):
          <input type="text" id="snippet-trigger" placeholder="e.g. review">
        </label>
        <label>Label:
          <input type="text" id="snippet-label" placeholder="e.g. Code review prompt">
        </label>
        <label>Body (use <code>{{name}}</code> for variables):
          <textarea id="snippet-body" rows="10" placeholder="Please review {{file}} for {{focus_area}}…"></textarea>
        </label>
        <div class="snippets-edit-actions">
          <button id="snippet-save" class="snippets-btn primary">Save</button>
          <button id="snippet-delete" class="snippets-btn danger">Delete</button>
        </div>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Style**

```css
.snippets-dialog { width: 880px; max-height: 80vh; }
.snippets-body { display: grid; grid-template-columns: 240px 1fr; gap: 12px; height: 60vh; }
.snippets-list-pane { display: flex; flex-direction: column; gap: 6px; border-right: 1px solid var(--border-subtle); padding-right: 8px; }
.snippets-list { overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.snippet-item { padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.snippet-item:hover { background: rgba(255,255,255,0.04); }
.snippet-item.active { background: rgba(79,140,255,0.18); }
.snippet-item-trigger { color: var(--text-dim); font-size: 10px; }
.snippets-edit-pane { display: flex; flex-direction: column; gap: 8px; }
.snippets-edit-pane label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-dim); }
.snippets-edit-pane input,
.snippets-edit-pane textarea {
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 13px;
  font-family: inherit;
}
.snippets-edit-pane textarea { resize: vertical; }
.snippets-edit-actions { display: flex; gap: 8px; }
.snippets-btn { background: transparent; border: 1px solid var(--border-subtle); color: var(--text-primary); border-radius: 4px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
.snippets-btn.primary { background: #4f8cff; color: white; border-color: #4f8cff; }
.snippets-btn.danger:hover { color: #e05050; border-color: #e05050; }
```

- [ ] **Step 3: Wire load/save/delete + manager open**

Add a sidebar/toolbar entry and a manager block in `renderer.js`:

```javascript
(function setupSnippets() {
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
  function close() { modal.classList.add('hidden'); }
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

  function refresh() {
    return window.electronAPI.listSnippets().then(function (list) {
      snippets = list;
      renderList();
      if (!editing && snippets.length) edit(snippets[0]);
      else if (!snippets.length) edit({ trigger: '', label: '', body: '' });
    });
  }

  function renderList() {
    listEl.innerHTML = '';
    snippets.forEach(function (s) {
      var d = document.createElement('div');
      d.className = 'snippet-item' + (editing && editing.id === s.id ? ' active' : '');
      d.innerHTML = '<div></div><div class="snippet-item-trigger">\\\\<span></span></div>';
      d.children[0].textContent = s.label || '(unnamed)';
      d.children[1].querySelector('span').textContent = s.trigger || '';
      d.addEventListener('click', function () { edit(s); });
      listEl.appendChild(d);
    });
  }

  function edit(s) {
    editing = s;
    trigEl.value = s.trigger || '';
    labelEl.value = s.label || '';
    bodyEl.value = s.body || '';
    renderList();
  }

  newBtn.addEventListener('click', function () { edit({ trigger: '', label: '', body: '' }); });
  saveBtn.addEventListener('click', function () {
    var snip = Object.assign({}, editing, {
      trigger: trigEl.value.trim(),
      label: labelEl.value.trim(),
      body: bodyEl.value
    });
    if (!snip.trigger) { alert('Trigger required'); return; }
    window.electronAPI.saveSnippet(snip).then(function (saved) {
      editing = saved;
      refresh();
    });
  });
  delBtn.addEventListener('click', function () {
    if (!editing || !editing.id) return;
    if (!confirm('Delete snippet "' + (editing.label || editing.trigger) + '"?')) return;
    window.electronAPI.deleteSnippet(editing.id).then(function () {
      editing = null;
      refresh();
    });
  });

  // Expose open() globally so palette + sidebar can trigger
  window.openSnippetsManager = open;
})();
```

Add a sidebar/toolbar button:

```html
<button id="btn-snippets" class="toolbar-btn" title="Prompt snippets">📝</button>
```

Wire it:

```javascript
document.getElementById('btn-snippets').addEventListener('click', function () { window.openSnippetsManager(); });
```

Also add a palette command (Phase 1):

```javascript
cmds.push({ label: 'Open snippet library', kind: 'action', run: function () { window.openSnippetsManager(); } });
```

- [ ] **Step 4: Smoke test**

Run: `npm start`. Click 📝 toolbar button. Expected: snippets modal opens with an empty list. Click +New, enter trigger=`review`, label=`Code review`, body=`Please review {{file}} for {{focus}}.`, Save. Reload app — snippet persists.

- [ ] **Step 5: Commit**

```bash
git add index.html renderer.js styles.css
git commit -m "feat(snippets): manager modal — create/edit/delete prompt templates"
```

### Task 3.3: Trigger expansion in column terminals

**Files:**
- Modify: `renderer.js` (xterm onData hook in `addColumn`)

**Approach:** When the user types `\\<trigger>`, intercept on Enter or Tab. Expand the trigger by reading from the in-memory snippet cache, then prompt for variables (simple `prompt()` per `{{var}}` in V1; later replace with a proper modal).

- [ ] **Step 1: Maintain in-memory snippet cache**

In the snippets setup, after `refresh()`, also expose:

```javascript
window.__snippetsCache = snippets;
window.refreshSnippetsCache = refresh;
```

Refresh on app start and after every save/delete.

- [ ] **Step 2: Intercept input in `addColumn`**

This is the hardest part — xterm's `onData` fires per keystroke. We need to track the current line buffer per column. Since echo is server-side, we maintain our own buffer:

In `addColumn`, after `terminal.onData(function (data) { … })`, wrap the writer:

```javascript
  // Snippet-trigger interception. Tracks a small line buffer of the user's
  // typing and watches for "\\trigger" + Enter/Tab to expand.
  colData.snippetBuffer = '';
  var origOnData = terminal._core._listeners?.['data'];  // not used; rely on the existing handler
  // Hook BEFORE wsSend by replacing the existing onData handler with one that
  // does snippet detection first. This requires editing the original handler
  // — see step 3.
```

- [ ] **Step 3: Refactor onData to call expandIfTrigger first**

Locate the existing `terminal.onData` body in `addColumn`. Wrap its top:

```javascript
  terminal.onData(function (data) {
    if (handleSnippetExpansion(id, data)) return;  // consumed by expansion
    wsSend({ type: 'write', id: id, data: data });
    // …rest of existing logic unchanged
  });
```

Then implement:

```javascript
function handleSnippetExpansion(colId, data) {
  var col = allColumns.get(colId);
  if (!col) return false;

  // Backspace handling
  if (data === '\x7f' || data === '\b') {
    col.snippetBuffer = col.snippetBuffer.slice(0, -1);
    return false;
  }
  // Enter or Tab — try expansion
  if (data === '\r' || data === '\n' || data === '\t') {
    var m = /\\\\([a-zA-Z0-9_-]+)\s*$/.exec(col.snippetBuffer);
    if (m) {
      var trig = m[1];
      var snip = (window.__snippetsCache || []).find(function (s) { return s.trigger === trig; });
      if (snip) {
        var body = snip.body || '';
        // Collect variables
        var vars = {};
        var varNames = [];
        body.replace(/\{\{(\w+)\}\}/g, function (_, n) { if (varNames.indexOf(n) === -1) varNames.push(n); return _; });
        for (var i = 0; i < varNames.length; i++) {
          var v = window.prompt('Value for {{' + varNames[i] + '}}:');
          if (v === null) { col.snippetBuffer = ''; return true; }  // cancelled — eat the keystroke
          vars[varNames[i]] = v;
        }
        var expanded = body.replace(/\{\{(\w+)\}\}/g, function (_, n) { return vars[n] || ''; });
        // Erase the typed trigger from the terminal: send N backspaces, then the body, then Enter (if data was Enter).
        var eraseCount = m[0].length;
        var erase = '\b \b'.repeat(eraseCount);
        wsSend({ type: 'write', id: colId, data: erase + expanded + (data === '\r' ? '\r' : '') });
        col.snippetBuffer = '';
        return true;
      }
    }
    col.snippetBuffer = '';
    return false;
  }
  // Accumulate printable chars
  if (data.length === 1 && data >= ' ') col.snippetBuffer += data;
  if (col.snippetBuffer.length > 200) col.snippetBuffer = col.snippetBuffer.slice(-200);
  return false;
}
```

**Caveat:** the erase-via-backspaces dance is approximate — it relies on standard echo behaviour. If a future column shows weirdness, drop trigger-expansion behind a setting and treat as V1 best-effort.

- [ ] **Step 4: Smoke test**

Run: `npm start`. Spawn Claude column. Type `\\review` then Enter. Expected: a `prompt()` per `{{var}}`, then the expanded body sent to the column. Cancel a prompt → snippet aborts cleanly.

- [ ] **Step 5: Commit**

```bash
git add renderer.js
git commit -m "feat(snippets): \\\\trigger expansion in terminals"
```

---

## Phase 4 — Endpoint failover

Current state: `endpoint:list/get/save/delete` IPC + UI exist (`preload.js:133`). Each preset is one URL. Add an optional `fallbackId` field; when a Claude session fails to authenticate or returns network errors, transparently retry on the fallback. Failover is best-effort: it manifests as a column auto-restarting with the fallback endpoint and a header badge "↺ failed over to <fallback>".

### Task 4.1: Schema bump for endpoint presets

**Files:**
- Modify: `main.js` (endpoint preset handlers — search `endpoint:save`)
- Migration: existing presets get no `fallbackId` (optional)

- [ ] **Step 1: Accept and persist `fallbackId`**

In the existing `endpoint:save` handler, ensure `fallbackId` (string | null | undefined) is preserved. Most likely it already is because the handler probably saves the whole preset object — verify by reading the handler. If a strict allowlist is in place, add `fallbackId` to it.

- [ ] **Step 2: Validate that `fallbackId` references an existing preset, not itself**

In the same handler, before persisting:

```javascript
if (preset.fallbackId) {
  if (preset.fallbackId === preset.id) return { ok: false, error: 'Fallback cannot be self.' };
  const all = readEndpoints();
  if (!all.find(p => p.id === preset.fallbackId)) return { ok: false, error: 'Fallback endpoint does not exist.' };
}
```

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(endpoints): persist optional fallbackId on presets"
```

### Task 4.2: Fallback UI in endpoint editor

**Files:**
- Modify: `index.html` (endpoint editor form — search for the existing endpoint-name input `epName`)
- Modify: `renderer.js` (endpoint editor render/save logic)

- [ ] **Step 1: Add fallback select**

Locate the endpoint editor form. Add after the existing fields:

```html
<label>Fallback endpoint (optional):
  <select id="ep-fallback"></select>
</label>
```

- [ ] **Step 2: Populate options + read/write**

In renderer code that opens the editor (search `epName.focus`), populate the select with all other endpoints:

```javascript
function populateFallbackSelect(currentEditingId, currentFallbackId) {
  var sel = document.getElementById('ep-fallback');
  sel.innerHTML = '<option value="">(none)</option>';
  window.electronAPI.endpointList().then(function (list) {
    list.forEach(function (e) {
      if (e.id === currentEditingId) return;
      var opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = e.name;
      if (e.id === currentFallbackId) opt.selected = true;
      sel.appendChild(opt);
    });
  });
}
```

When saving, include `fallbackId: document.getElementById('ep-fallback').value || null` in the saved preset.

- [ ] **Step 3: Smoke test**

Run: `npm start`. Open endpoint manager. Edit an existing preset → fallback dropdown lists other presets. Set fallback, save. Reload → setting persists. Try to set fallback to self → save returns error.

- [ ] **Step 4: Commit**

```bash
git add index.html renderer.js
git commit -m "feat(endpoints): fallback selection in editor UI"
```

### Task 4.3: Failover detection and respawn

**Files:**
- Modify: `pty-server.js` (detect repeated auth/network errors from Claude)
- Modify: `main.js` (endpoint failover IPC)
- Modify: `renderer.js` (consume failover event, respawn with fallback)

**Detection:** The cleanest signal is non-zero exit within ~3 seconds of spawn for an OAuth/keyfile mismatch, or specific stderr text. For V1, watch for early exit (<5s lifetime + non-zero code) on a Claude column and treat as a likely auth/connectivity failure.

- [ ] **Step 1: Surface early-exit signal in pty-server**

In `pty-server.js`, in the existing pty exit handler, when a pty exits, in the `exit` message include `lifetime_ms: Date.now() - createdAt` and `exit_code`. (Already may be present — verify.)

- [ ] **Step 2: Renderer detects + asks main for fallback**

In `renderer.js`, in the WebSocket message handler that processes pty exit (search for `'exit'`), after current handling:

```javascript
if (msg.type === 'exit') {
  var col = allColumns.get(msg.id);
  if (!col) return;
  if (col.cmd) return;  // skip non-Claude
  var lifetime = msg.lifetime_ms || (Date.now() - col.createdAt);
  var endpointId = (col.env && col.env.__ENDPOINT_ID__) || col.endpointId;  // however the renderer tags it currently
  if (msg.exit_code !== 0 && lifetime < 5000 && endpointId && !col.failedOver) {
    window.electronAPI.endpointGet(endpointId).then(function (preset) {
      if (preset && preset.fallbackId) {
        col.failedOver = true;
        respawnColumnWithEndpoint(msg.id, preset.fallbackId);
      }
    });
  }
}
```

- [ ] **Step 3: Implement `respawnColumnWithEndpoint`**

In `renderer.js`:

```javascript
function respawnColumnWithEndpoint(colId, endpointId) {
  var col = allColumns.get(colId);
  if (!col) return;
  window.electronAPI.endpointGetEnv(endpointId).then(function (env) {
    if (!env) return;
    // Show a badge in the header
    var badge = document.createElement('span');
    badge.className = 'col-failover-badge';
    badge.textContent = '↺ failover';
    badge.title = 'Auto-failed-over to ' + endpointId;
    if (col.headerEl) col.headerEl.appendChild(badge);
    // Re-spawn with new env, reusing same cwd / args
    var opts = { env: env, sessionId: col.sessionId, title: col.customTitle, endpointId: endpointId };
    addColumn(col.cwd, findRowForColumn(getActiveState(), colId), opts);
  });
}
```

Add styling:

```css
.col-failover-badge {
  font-size: 10px;
  color: #e0a020;
  border: 1px solid #e0a020;
  padding: 1px 6px;
  border-radius: 8px;
  margin-left: 6px;
}
```

- [ ] **Step 4: Smoke test**

Run: `npm start`. Create endpoint preset A pointing to a deliberately-bad URL (e.g. `http://localhost:1`); preset B pointing to a working one. Set A's fallback to B. Spawn a Claude column with preset A active. Expected: column starts, exits within 5s with non-zero, then automatically re-spawns with preset B; ↺ failover badge appears.

- [ ] **Step 5: Commit**

```bash
git add pty-server.js main.js renderer.js styles.css
git commit -m "feat(endpoints): auto-failover to fallback on early Claude exit"
```

---

## Phase 5 — Cross-session prompt search

Distinct from Plan A's "session full-text search" (which searches **assistant transcripts**). This searches **the user's own prompts** across `~/.claude/history.jsonl` (the per-keystroke history file). Useful for "what was that prompt I wrote last week about migrating to Tailwind".

### Task 5.1: Search backend

**Files:**
- Modify: `main.js`
- Modify: `preload.js`

- [ ] **Step 1: Implement IPC**

In `main.js`:

```javascript
// Search ~/.claude/history.jsonl for past user prompts. Returns hits in
// reverse-chronological order (most recent first).
ipcMain.handle('history:search', async (_event, query, limit) => {
  if (!query || query.length < 2) return [];
  const max = Math.max(1, Math.min(200, limit || 100));
  const file = path.join(os.homedir(), '.claude', 'history.jsonl');
  let content;
  try { content = await fs.promises.readFile(file, 'utf8'); } catch { return []; }
  const needle = query.toLowerCase();
  const lines = content.split('\n');
  const hits = [];
  for (let i = lines.length - 1; i >= 0 && hits.length < max; i--) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const text = entry.display || entry.input || entry.prompt || '';
    if (!text) continue;
    if (text.toLowerCase().indexOf(needle) === -1) continue;
    hits.push({
      text,
      project: entry.project || entry.cwd || '',
      ts: entry.ts || entry.timestamp || null
    });
  }
  return hits;
});
```

- [ ] **Step 2: Inspect actual `history.jsonl` shape**

The exact JSON keys depend on the CLI version. Open `~/.claude/history.jsonl` and inspect a line:

```bash
head -1 ~/.claude/history.jsonl
```

Update the field-pull line in step 1 to use the real keys. The Claude CLI typically writes `display` or `input` and `pastedContents` for paste-cache references.

- [ ] **Step 3: Expose via preload**

```javascript
searchHistory: (query, limit) => ipcRenderer.invoke('history:search', query, limit),
```

- [ ] **Step 4: Commit**

```bash
git add main.js preload.js
git commit -m "feat(history): backend search across ~/.claude/history.jsonl"
```

### Task 5.2: History tab in session search modal

Reuse the session-search modal from Plan A (Phase 5) by adding a small toggle: "Search transcripts | prompts". When set to "prompts", route to `searchHistory`.

**Files:**
- Modify: `index.html` (add toggle inside session search modal)
- Modify: `renderer.js` (route based on toggle)

- [ ] **Step 1: Add the toggle**

Inside the session-search modal body, above the input:

```html
<div class="session-search-mode">
  <label><input type="radio" name="search-mode" value="transcripts" checked> Transcripts</label>
  <label><input type="radio" name="search-mode" value="prompts"> My prompts</label>
</div>
```

- [ ] **Step 2: Style**

```css
.session-search-mode { display: flex; gap: 12px; margin-bottom: 6px; font-size: 11px; color: var(--text-dim); }
```

- [ ] **Step 3: Route in `runSearch`**

In the existing `runSearch` from Plan A's session-search setup:

```javascript
function runSearch(q) {
  resultsEl.innerHTML = '<div style="opacity:.6;font-size:12px">Searching…</div>';
  var mode = document.querySelector('input[name=search-mode]:checked').value;
  var p = (mode === 'prompts')
    ? window.electronAPI.searchHistory(q, 100).then(function (hits) {
        return hits.map(function (h) { return { snippet: h.text, projectKey: h.project, sessionId: '', ts: h.ts }; });
      })
    : window.electronAPI.searchSessions(q, 50);
  p.then(function (hits) { /* same render path; ignore openHit when sessionId is empty */ });
}
```

Update `openHit` to no-op (or copy-to-clipboard) when `sessionId` is empty (prompt-mode hit).

- [ ] **Step 4: Smoke test**

Run: `npm start`. Press Ctrl+Shift+F. Switch to "My prompts". Type a phrase you've used before. Expected: hits from `history.jsonl` appear, most recent first.

- [ ] **Step 5: Commit**

```bash
git add index.html renderer.js styles.css
git commit -m "feat(history): prompt-history mode in session search modal"
```

---

## Final integration smoke test

- [ ] **Step 1: Verify all five power-user features work together**

Run `npm start`. Walk through:

1. Ctrl+K — palette opens, fuzzy-matches projects + slash commands + actions, including "Open snippet library".
2. Spawn Claude column, do tool-heavy work — Hooks tab streams events.
3. Open snippets manager via 📝 → create snippet `\\test` with body "Hi {{name}}". Type `\\test` + Enter in column. Expected: prompt for `name`, expanded body sent.
4. Set up two endpoint presets with one as fallback for the other; primary URL deliberately broken. Spawn → fails over → ↺ badge appears.
5. Ctrl+Shift+F → "My prompts" mode → search past prompt text.

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: PASS — all new tests in `test/fuzzy-rank.test.js` + Plan A's tests + the existing `headless-helpers.test.js`.

- [ ] **Step 3: DevTools check**

Open DevTools console. Exercise each feature. Watch for red errors.

- [ ] **Step 4: Final commit / push**

```bash
git status
git push origin <branch>
```
