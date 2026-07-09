# Project-level MCP Inheritance Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user tick which MCP servers a project inherits from the global config, in the "Manage MCP servers" modal, so every window spawned under that project (and, by inheritance, its automations) launches with exactly those servers.

**Architecture:** Reuse the existing per-project selection store `projectMcpDefaults` (automations.json) — already read by automation agents. Add a checklist to the `#mcp-modal`. Add a main-process IPC that materializes a scoped `--mcp-config` temp file from the project's selection; the renderer appends `--mcp-config <file> --strict-mcp-config` to the spawn args at the single `addColumn` spawn choke point. Pure logic lives in a new tested lib module.

**Tech Stack:** Electron (main/renderer/preload), Node.js, `node --test` + `node:assert`, vanilla DOM.

## Global Constraints

- **Selection convention (verbatim):** `null`/absent = inherit ALL discovered servers · `[]` = none · `["a","b"]` = explicit allowlist. Preserve everywhere.
- **Secrets stay in main:** the renderer only ever receives `{name, scope}` (no server `def`/env). The scoped config file must be written by the **main** process. Never send server defs to the renderer.
- **No global `.hidden` rule:** styles.css has no `.hidden {display:none}`. Toggle visibility with inline `style.display`, matching the existing modal code.
- **New element IDs must not collide** with the modal's existing `mcp-*` CRUD IDs — use the `mcp-inherit-*` prefix.
- **Do not persist the temp config path** into a column's saved `args`/`cmdArgs`. Resolve fresh and append only on the outgoing `create` message.
- **Tests:** only pure lib modules are unit-tested in this repo (`test/*.test.js`, run with `npm test`). Renderer/main wiring is verified manually via the `/run` skill.
- **Reuse, do not reimplement:** `discoverProjectMcpServers` (main.js:7059), `resolveMcpSelection` + `filterMcpDefs` (lib/interactive-scheduled.js:122/134), the `automations:discoverMcpServers` (main.js:5487) and `automations:setProjectMcpDefault` (main.js:5498) IPCs, and their preload methods `discoverMcpServers`/`setProjectMcpDefault` (preload.js:166/167).

---

## File Structure

- **Create** `lib/mcp-project.js` — pure helpers: `readbackMcpSelection`, `resolveProjectMcpSpawn`, `appendProjectMcpArgs`. One responsibility: translate between checkbox state, the selection convention, and spawn args. No file IO, no DOM.
- **Create** `test/mcp-project.test.js` — unit tests for the three helpers.
- **Modify** `main.js` — add `MCP_TMP_DIR` constant + boot-time stale sweep; add `mcp:buildProjectConfig` IPC that uses `lib/mcp-project` + existing discovery to write the scoped temp file.
- **Modify** `preload.js` — expose `buildProjectMcpConfig`.
- **Modify** `index.html` — add the `mcp-inherit-*` checklist section inside `#mcp-modal`.
- **Modify** `renderer.js` — render/persist the checklist in `setupMcpManager`/`openMcpModal`; append project MCP args in `addColumn` before `gatedWsSend`.
- **Modify** `styles.css` — only if a spacing rule is needed for the new section (reuse `.automation-permission-*`).

---

## Task 1: Pure helpers (`lib/mcp-project.js`)

**Files:**
- Create: `lib/mcp-project.js`
- Test: `test/mcp-project.test.js`

**Interfaces:**
- Consumes: `resolveMcpSelection`, `filterMcpDefs` from `lib/interactive-scheduled.js`.
- Produces:
  - `readbackMcpSelection(checkedNames: string[], allNames: string[], hadSelection: boolean) => string[] | null` — checkbox state → selection. `(!hadSelection && all checked) → null` (inherit untouched); otherwise the explicit `checkedNames` (possibly `[]`).
  - `resolveProjectMcpSpawn(projectDefault: string[]|null, discovered: {[name]:{def,scope}}) => { inherit: true } | { inherit: false, config: { mcpServers: {} } }`.
  - `appendProjectMcpArgs(args: string[], mcpResult: {mcpConfigPath?, strict?}|null) => string[]` — returns a NEW array; no-op if `args` already contains `--mcp-config` (so the "Strip MCPs" toggle wins).

- [ ] **Step 1: Write the failing test**

Create `test/mcp-project.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  readbackMcpSelection,
  resolveProjectMcpSpawn,
  appendProjectMcpArgs
} = require('../lib/mcp-project');

// --- readbackMcpSelection ---

test('readbackMcpSelection: untouched, all checked -> null (inherit)', () => {
  assert.strictEqual(readbackMcpSelection(['a', 'b'], ['a', 'b'], false), null);
});

test('readbackMcpSelection: touched, all checked -> explicit full list', () => {
  assert.deepStrictEqual(readbackMcpSelection(['a', 'b'], ['a', 'b'], true), ['a', 'b']);
});

test('readbackMcpSelection: subset checked -> explicit subset', () => {
  assert.deepStrictEqual(readbackMcpSelection(['a'], ['a', 'b'], false), ['a']);
});

test('readbackMcpSelection: none checked -> empty array (none)', () => {
  assert.deepStrictEqual(readbackMcpSelection([], ['a', 'b'], false), []);
});

// --- resolveProjectMcpSpawn ---

const DISCOVERED = {
  github: { def: { command: 'gh-mcp' }, scope: 'user' },
  mongo: { def: { command: 'mongo-mcp' }, scope: 'project' }
};

test('resolveProjectMcpSpawn: null default -> inherit', () => {
  assert.deepStrictEqual(resolveProjectMcpSpawn(null, DISCOVERED), { inherit: true });
});

test('resolveProjectMcpSpawn: explicit subset -> scoped config', () => {
  const r = resolveProjectMcpSpawn(['github'], DISCOVERED);
  assert.strictEqual(r.inherit, false);
  assert.deepStrictEqual(r.config, { mcpServers: { github: { command: 'gh-mcp' } } });
});

test('resolveProjectMcpSpawn: empty array -> scoped empty config (none)', () => {
  const r = resolveProjectMcpSpawn([], DISCOVERED);
  assert.strictEqual(r.inherit, false);
  assert.deepStrictEqual(r.config, { mcpServers: {} });
});

// --- appendProjectMcpArgs ---

test('appendProjectMcpArgs: adds flags for a scoped config', () => {
  const out = appendProjectMcpArgs(['--bare'], { mcpConfigPath: '/tmp/x.json', strict: true });
  assert.deepStrictEqual(out, ['--bare', '--mcp-config', '/tmp/x.json', '--strict-mcp-config']);
});

test('appendProjectMcpArgs: inherit (no path) -> unchanged copy', () => {
  const out = appendProjectMcpArgs(['--bare'], { inherit: true });
  assert.deepStrictEqual(out, ['--bare']);
});

test('appendProjectMcpArgs: does not override an existing --mcp-config (strip wins)', () => {
  const base = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  const out = appendProjectMcpArgs(base, { mcpConfigPath: '/tmp/x.json', strict: true });
  assert.deepStrictEqual(out, base);
});

test('appendProjectMcpArgs: returns a new array (no mutation)', () => {
  const base = ['--bare'];
  const out = appendProjectMcpArgs(base, { mcpConfigPath: '/tmp/x.json', strict: true });
  assert.notStrictEqual(out, base);
  assert.deepStrictEqual(base, ['--bare']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/mcp-project'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/mcp-project.js`:

```js
'use strict';

const { resolveMcpSelection, filterMcpDefs } = require('./interactive-scheduled');

// Checkbox state -> selection, preserving the convention:
//   null = inherit ALL, [] = none, [...] = explicit allowlist.
// "all checked and never touched" stays null (inherit) rather than freezing
// an explicit full list, mirroring the automation-agent picker.
function readbackMcpSelection(checkedNames, allNames, hadSelection) {
  const checked = Array.isArray(checkedNames) ? checkedNames : [];
  const all = Array.isArray(allNames) ? allNames : [];
  const allChecked = checked.length === all.length;
  if (!hadSelection && allChecked) return null;
  return checked;
}

// Resolve what an interactive spawn should do for a project.
//   projectDefault  array | null  (from projectMcpDefaults[path])
//   discovered      { name: { def, scope } }  (from discoverProjectMcpServers)
// Returns { inherit: true } (do nothing, today's behaviour) or
//         { inherit: false, config: { mcpServers: {...} } } (scoped, strict).
function resolveProjectMcpSpawn(projectDefault, discovered) {
  const sel = resolveMcpSelection(null, projectDefault);
  if (sel === null) return { inherit: true };
  return { inherit: false, config: filterMcpDefs(discovered || {}, sel, null) };
}

// Append the scoped-config flags to a spawn arg list. Returns a NEW array.
// No-op when args already carry --mcp-config (the per-column "Strip MCPs"
// toggle emits that first and must win).
function appendProjectMcpArgs(args, mcpResult) {
  const out = Array.isArray(args) ? args.slice() : [];
  if (out.indexOf('--mcp-config') !== -1) return out;
  if (mcpResult && mcpResult.mcpConfigPath) {
    out.push('--mcp-config', mcpResult.mcpConfigPath);
    if (mcpResult.strict) out.push('--strict-mcp-config');
  }
  return out;
}

module.exports = { readbackMcpSelection, resolveProjectMcpSpawn, appendProjectMcpArgs };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `mcp-project` tests green, existing suite unaffected.

- [ ] **Step 5: Commit**

```bash
git add lib/mcp-project.js test/mcp-project.test.js
git commit -m "feat(mcp): pure helpers for project MCP selection + spawn args"
```

---

## Task 2: Main IPC — materialize scoped config (`mcp:buildProjectConfig`)

**Files:**
- Modify: `main.js` (add `MCP_TMP_DIR` near `CONFIG_FILE` ~line 359; boot sweep near other startup init; IPC handler near the other `mcp:*`/automations MCP handlers ~line 5494)
- Modify: `preload.js` (near line 167)

**Interfaces:**
- Consumes: `resolveProjectMcpSpawn` (Task 1); `discoverProjectMcpServers` (main.js:7059); `readAutomations()` + `projectMcpDefaults`.
- Produces:
  - IPC `mcp:buildProjectConfig(projectPath) => { inherit: true } | { mcpConfigPath: string, strict: true }`.
  - Preload `buildProjectMcpConfig(projectPath) => Promise<...>`.

- [ ] **Step 1: Add the temp dir constant + boot sweep**

In `main.js`, near `const CONFIG_FILE = ...` (~line 359), add:

```js
// Per-spawn scoped MCP config files for interactive columns. claude reads
// --mcp-config once at startup, so these are short-lived; swept on boot.
const MCP_TMP_DIR = path.join(CONFIG_DIR, app.isPackaged ? 'mcp-tmp' : 'mcp-tmp-dev');

function sweepMcpTmp() {
  try {
    if (!fs.existsSync(MCP_TMP_DIR)) return;
    const cutoff = Date.now() - 60 * 60 * 1000; // 1h
    for (const f of fs.readdirSync(MCP_TMP_DIR)) {
      const p = path.join(MCP_TMP_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (_) { /* ignore individual file errors */ }
    }
  } catch (_) { /* ignore */ }
}
```

Call `sweepMcpTmp();` once during app startup, alongside the other boot-time init (e.g. right after `ensureMcpCatalogSeeded()` if present, otherwise inside the `app.whenReady()` / existing startup block that runs `migrateLoopsToAutomations()`).

- [ ] **Step 2: Add the IPC handler**

In `main.js`, after the `automations:setProjectMcpDefault` handler (~line 5506), add:

```js
// Build the scoped MCP config for an interactive column spawned under a
// project. Secrets (server defs) never leave main — the renderer gets only a
// file path. Returns { inherit:true } (no scoping) or { mcpConfigPath, strict }.
const { resolveProjectMcpSpawn } = require('./lib/mcp-project');
ipcMain.handle('mcp:buildProjectConfig', (event, projectPath) => {
  try {
    if (!projectPath) return { inherit: true };
    const data = readAutomations();
    const norm = String(projectPath).replace(/\\/g, '/');
    const projectDefault = (data.projectMcpDefaults && data.projectMcpDefaults[norm]) || null;
    const discovered = discoverProjectMcpServers(projectPath);
    const res = resolveProjectMcpSpawn(projectDefault, discovered);
    if (res.inherit) return { inherit: true };
    fs.mkdirSync(MCP_TMP_DIR, { recursive: true, mode: 0o700 });
    const file = path.join(MCP_TMP_DIR, `col_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.json`);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(res.config), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return { mcpConfigPath: file, strict: true };
  } catch (err) {
    // Fail open to today's inherit-all behaviour rather than blocking a spawn.
    console.warn('[mcp] buildProjectConfig failed:', err && err.message);
    return { inherit: true };
  }
});
```

> If a top-level `const { ... } = require('./lib/mcp-project')` is cleaner in this file's style, hoist the require to the top with the other `require`s instead of inlining it — either is fine, keep it single.
> `Date.now()`/`Math.random()` are ordinary here (main.js, not a workflow script) — no restriction applies.

- [ ] **Step 3: Expose in preload**

In `preload.js`, after line 167 (`setProjectMcpDefault`), add:

```js
  buildProjectMcpConfig: (projectPath) => ipcRenderer.invoke('mcp:buildProjectConfig', projectPath),
```

- [ ] **Step 4: Verify it loads (no unit test — file IO in main)**

Run: `npm test`
Expected: PASS — existing suite unaffected (this task adds no test; its logic core is covered by Task 1).

Then sanity-check the app boots and the handler is registered (full behaviour is verified in Task 4):

Run: `npm start` (dev build — leave the installed app running), confirm no console error at boot referencing `mcp:buildProjectConfig` or `mcp-project`. Close the dev build.

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js
git commit -m "feat(mcp): main IPC to materialize project-scoped MCP config for spawns"
```

---

## Task 3: UI — inherited-servers checklist in the "Manage MCP servers" modal

**Files:**
- Modify: `index.html` (inside `#mcp-modal`, ~line 1242, top of `.modal-body`)
- Modify: `renderer.js` (`setupMcpManager` IIFE ~19279; `openMcpModal` ~19423)
- Modify: `styles.css` (optional spacing only)

**Interfaces:**
- Consumes: `readbackMcpSelection` (Task 1, via `window.McpProject` — see Step 1); `electronAPI.discoverMcpServers` (returns `{servers:[{name,scope}], projectDefault}`); `electronAPI.setProjectMcpDefault`.
- Produces: none (terminal UI).

- [ ] **Step 1: Make the pure helper available to the renderer**

The renderer is not a module bundler context; expose Task 1's helpers on `window`. At the very top of `lib/mcp-project.js`'s export, ALSO attach to `window` when present — add at the end of `lib/mcp-project.js` before `module.exports`:

```js
if (typeof window !== 'undefined') {
  window.McpProject = { readbackMcpSelection, resolveProjectMcpSpawn, appendProjectMcpArgs };
}
```

Then include the script in `index.html` **before** `renderer.js`. Find the existing `<script src="lib/...">` includes (e.g. the interactive-scheduled / spawn-session includes) and add alongside them:

```html
    <script src="lib/mcp-project.js"></script>
```

> If `lib/interactive-scheduled.js` is NOT already included via a `<script>` in index.html (it may be main-only), then `require('./interactive-scheduled')` at the top of `lib/mcp-project.js` will throw in the renderer. Guard it: wrap the `require` so the renderer path uses `window`-provided fns. Concretely, change the top of `lib/mcp-project.js` to:
> ```js
> let _is;
> try { _is = require('./interactive-scheduled'); } catch (_) { _is = (typeof window !== 'undefined' && window.InteractiveScheduled) || {}; }
> const { resolveMcpSelection, filterMcpDefs } = _is;
> ```
> Check first: `grep -n "interactive-scheduled" index.html`. If present, keep the plain `require`. The renderer only calls `readbackMcpSelection` (which uses neither `resolveMcpSelection` nor `filterMcpDefs`), so even if those are undefined in the renderer, the UI path is safe — but keep the guard so loading the file never throws.

- [ ] **Step 2: Add the checklist markup**

In `index.html`, inside `#mcp-modal` `.modal-body` (the `<div class="modal-body endpoints-body">` at ~line 1242), add a section as the FIRST child, above `.endpoints-sidebar`:

```html
        <div id="mcp-inherit-section" style="flex-basis:100%; padding:12px 4px 4px; border-bottom:1px solid var(--border, #333); margin-bottom:8px;">
          <label style="display:block; margin-bottom:6px;">Inherited MCP servers
            <span class="automation-permission-hint">Applies to every window and automation in this project. Unchecked = not loaded. Leave all checked to inherit every server.</span>
          </label>
          <div id="mcp-inherit-list" class="automation-permissions"></div>
        </div>
```

> Note: `.endpoints-body` is likely a flex row (sidebar + edit pane). `flex-basis:100%` makes the new section span the full width above them. Confirm visually in Step 5; if the layout is not flex-wrap, wrap the section and the existing body in a column container instead — but prefer the minimal `flex-wrap:wrap` on the parent if needed via the optional styles.css step.

- [ ] **Step 3: Render + persist the checklist in the renderer**

In `renderer.js`, inside the `setupMcpManager` IIFE, add element refs near the others (~line 19295) and a render function. Add after `var pathLabel = ...`:

```js
  var inheritListEl = document.getElementById('mcp-inherit-list');

  function renderInheritList(servers, projectDefault) {
    if (!inheritListEl) return;
    inheritListEl.innerHTML = '';
    var hadSelection = Array.isArray(projectDefault);
    inheritListEl.setAttribute('data-had-selection', hadSelection ? 'true' : 'false');
    if (!servers || servers.length === 0) {
      var hint = document.createElement('div');
      hint.className = 'automation-permission-hint';
      hint.textContent = 'No MCP servers discovered for this project (all inherited).';
      inheritListEl.appendChild(hint);
      return;
    }
    servers.forEach(function (s) {
      var checked = !hadSelection || projectDefault.indexOf(s.name) !== -1;
      var label = document.createElement('label');
      label.className = 'automation-permission-option';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'mcp-inherit-cb';
      cb.setAttribute('data-server', s.name);
      cb.checked = checked;
      cb.addEventListener('change', persistInherit);
      var span = document.createElement('span');
      span.textContent = s.name + ' ';
      var scope = document.createElement('span');
      scope.className = 'automation-permission-hint';
      scope.textContent = '(' + s.scope + ')';
      span.appendChild(scope);
      label.appendChild(cb);
      label.appendChild(span);
      inheritListEl.appendChild(label);
    });
  }

  function persistInherit() {
    if (!inheritListEl || !projectPath || !window.electronAPI || !window.electronAPI.setProjectMcpDefault) return;
    var cbs = inheritListEl.querySelectorAll('.mcp-inherit-cb');
    var allNames = [];
    var checkedNames = [];
    cbs.forEach(function (cb) {
      var n = cb.getAttribute('data-server');
      allNames.push(n);
      if (cb.checked) checkedNames.push(n);
    });
    var hadSelection = inheritListEl.getAttribute('data-had-selection') === 'true';
    var selection = window.McpProject.readbackMcpSelection(checkedNames, allNames, hadSelection);
    // Once the user touches a box, the selection becomes explicit.
    inheritListEl.setAttribute('data-had-selection', selection === null ? 'false' : 'true');
    window.electronAPI.setProjectMcpDefault(projectPath, selection);
  }
```

Use safe DOM construction (no `innerHTML` with interpolated names) as above, matching the app's safe-DOM convention.

- [ ] **Step 4: Populate the checklist on modal open**

In `renderer.js`, modify `window.openMcpModal` (~line 19423) to also discover servers and render. After the existing `readMcp(...)` block, add a discovery call:

```js
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
    if (window.electronAPI.discoverMcpServers) {
      window.electronAPI.discoverMcpServers(projPath).then(function (res) {
        renderInheritList((res && res.servers) || [], (res && res.projectDefault) || null);
      }).catch(function () { renderInheritList([], null); });
    }
  };
```

- [ ] **Step 5: Verify in the running app (manual — no DOM unit harness)**

Run: `npm test` (must stay green), then `npm start` (dev build). Then, using the `/run` skill:
- Right-click a project → "Manage MCP servers…". Confirm the "Inherited MCP servers" checklist appears above the `.mcp.json` editor, with one checkbox per discovered server, all checked by default.
- Untick one server, close and reopen the modal → that server stays unticked (persisted to `projectMcpDefaults`).
- Re-tick all → reopening shows all ticked.

Expected: selection round-trips. Screenshot the modal.

- [ ] **Step 6: Commit**

```bash
git add index.html renderer.js lib/mcp-project.js styles.css
git commit -m "feat(mcp): project inherited-servers checklist in Manage MCP servers modal"
```

---

## Task 4: Spawn wiring — interactive columns honour the selection

**Files:**
- Modify: `renderer.js` (`addColumn`, at the `create` message send ~line 4534-4540)

**Interfaces:**
- Consumes: `electronAPI.buildProjectMcpConfig` (Task 2); `window.McpProject.appendProjectMcpArgs` (Task 1/3).
- Produces: none.

- [ ] **Step 1: Append project MCP args before sending `create`**

In `renderer.js`, the spawn send lives inside a `requestAnimationFrame(function () { ... })` in `addColumn` (~line 4515). The `create` message is built at ~4534 and sent via `gatedWsSend(sendMsg)` at ~4540. Make that callback async and await the config for claude columns only (`!cmd`). Replace the send region:

```js
    var sendMsg = { type: 'create', id: id, cols: terminal.cols, rows: terminal.rows, cwd: cwd, args: claudeArgs };
    if (cmd) sendMsg.cmd = cmd;
    if (opts.env) sendMsg.env = opts.env;
    maybeBindHeadroom(sendMsg, { hasEndpoint: !!(opts.endpointId || opts.env), isClaude: !cmd });

    // Project-scoped MCP: for default claude columns, resolve the project's
    // inherited-server selection and append --mcp-config/--strict-mcp-config.
    // No-op when inherit-all (returns {inherit:true}) or when "Strip MCPs"
    // already put a --mcp-config in args (appendProjectMcpArgs guards that).
    if (!cmd && window.electronAPI && window.electronAPI.buildProjectMcpConfig && window.McpProject) {
      try {
        var mcpRes = await window.electronAPI.buildProjectMcpConfig(cwd);
        sendMsg.args = window.McpProject.appendProjectMcpArgs(sendMsg.args, mcpRes);
      } catch (e) {
        vlog('spawn', { colId: id, mcpErr: String(e && e.message) });
      }
    }

    vlog('spawn', { colId: id, cwd: cwd, cmd: sendMsg.cmd || 'claude', args: sendMsg.args });
    gatedWsSend(sendMsg);
```

And change the callback signature from `requestAnimationFrame(function () {` to `requestAnimationFrame(async function () {` (the `reattach` early-return above stays synchronous and is unaffected).

> Why here: `addColumn` is the single funnel for all six `buildSpawnArgs` call sites, and `maybeBindHeadroom` already mutates `sendMsg` for claude columns at this exact point — this mirrors that precedent. The reattach path (existing pty) returns earlier and correctly does NOT re-resolve MCP.

- [ ] **Step 2: Verify end-to-end (manual — the whole point of the feature)**

Run: `npm test` (green), then `npm start`. Using `/run`:
- In a project with ≥2 global MCP servers, open "Manage MCP servers", untick one server, leave one ticked.
- Spawn a new window under that project. In the running claude, run `/mcp` (or check `--strict-mcp-config` took effect) and confirm ONLY the ticked server is present.
- Re-tick all servers → spawn again → all inherited (no `--strict-mcp-config` added; `{inherit:true}`).
- Tick the "Strip MCPs" spawn option with a project selection set → spawn → zero MCP servers (strip wins).

Expected: spawned windows load exactly the ticked set; inherit-all and strip-all both behave as before. Screenshot `/mcp` output for the scoped case.

- [ ] **Step 3: Commit**

```bash
git add renderer.js
git commit -m "feat(mcp): interactive columns honour project MCP selection at spawn"
```

---

## Self-Review

**Spec coverage:**
- Storage reuse of `projectMcpDefaults` → Task 2 (read) + Task 3 (write). ✓
- Convention `null`/`[]`/`[...]` → Task 1 (`readbackMcpSelection`, `resolveProjectMcpSpawn`) with tests. ✓
- Checklist inside "Manage MCP servers" modal → Task 3. ✓
- Discovery reuse (`discoverMcpServers`) + `projectDefault` pre-check → Task 3 Step 4. ✓
- Scoped temp config written in main, secrets never in renderer → Task 2. ✓
- Interactive spawn honours selection via `--mcp-config`/`--strict-mcp-config` → Task 4. ✓
- Strip-all toggle overrides → Task 1 `appendProjectMcpArgs` guard + Task 4 Step 2 verification. ✓
- Temp dir + boot sweep → Task 2 Step 1. ✓
- Automations keep inheriting the same base, unchanged → no code touched; verified by not modifying `runAgent`'s `resolveMcpSelection` call. ✓
- Do-not-persist temp path → Task 4 appends to the outgoing `create` message only, never to saved `args`. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `readbackMcpSelection`/`resolveProjectMcpSpawn`/`appendProjectMcpArgs` signatures match between Task 1 definition and Tasks 2–4 usage. `resolveProjectMcpSpawn` returns `{inherit}` / `{inherit,config}`; the IPC maps `config` → file → `{mcpConfigPath,strict}`; `appendProjectMcpArgs` consumes `{mcpConfigPath,strict}`. Consistent.
