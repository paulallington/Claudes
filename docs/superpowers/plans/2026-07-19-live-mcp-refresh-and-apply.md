# Live MCP Refresh & Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user add an MCP server while the app runs, refresh the MCP modal to see it, tick it, and apply it to live columns via a one-click conversation-preserving respawn — no app reboot.

**Architecture:** Two pure helpers in `lib/mcp-project.js` (discovery-scope match + eligible-column selector) with node:test coverage; main-side discovery widened to find worktree/subdir-scoped servers; renderer wiring adds a Refresh button, makes `restartColumn` re-resolve the project's scoped MCP config on respawn, and shows a sticky "Respawn N columns" toast when the tick set changed while the modal was open.

**Tech Stack:** Electron (main.js + renderer.js + preload.js), pure UMD libs in `lib/`, `node --test` over `test/*.test.js`.

## Global Constraints

- Pure logic goes in `lib/` using the UMD pattern (`module.exports` for Node/tests + `window.*` for the renderer). Match the existing `lib/mcp-project.js` guard idiom exactly.
- `npm test` must pass with ZERO failures (pre-existing included) at every commit.
- Terminology: Spawn / Kill / Respawn (not Add/Close/Restart) in any user-facing string.
- Do not regress: WS handshake auth, env blocklist, `--strict-mcp-config` allowlist semantics, or the Headroom `hasMcp` → `ENABLE_TOOL_SEARCH` gating (MCP-bearing columns keep tool schemas inlined).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- All source-file work happens in the AIDP worktree; each task is one RED→GREEN→commit cycle (pure tasks) or a single wiring delegation (renderer/main).

---

### Task 1: Discovery-scope match — find worktree/subdir-scoped servers

**Files:**
- Modify: `lib/mcp-project.js` (add `matchesProjectScope`, export it)
- Modify: `main.js:7534-7541` (use it in `discoverProjectMcpServers`) and `main.js:34` (require it)
- Test: `test/mcp-project.test.js`

**Interfaces:**
- Produces: `matchesProjectScope(configPathKey, projectRoot) -> boolean` — true when `configPathKey` equals `projectRoot` or is nested under it (slash-normalized, trailing-slash-insensitive, case-sensitive).

- [ ] **Step 1: Write the failing test**

Add to `test/mcp-project.test.js` (create if absent, mirroring other `lib` tests' `node:test`/`node:assert` style and requiring `../lib/mcp-project`):

```js
const test = require('node:test');
const assert = require('node:assert');
const { matchesProjectScope } = require('../lib/mcp-project');

test('matchesProjectScope: exact root matches', () => {
  assert.strictEqual(matchesProjectScope('D:/Git Repos/Claudes', 'D:/Git Repos/Claudes'), true);
});
test('matchesProjectScope: worktree subpath matches', () => {
  assert.strictEqual(matchesProjectScope('D:/Git Repos/Claudes/.claude/worktrees/x', 'D:/Git Repos/Claudes'), true);
});
test('matchesProjectScope: backslash key normalizes to match', () => {
  assert.strictEqual(matchesProjectScope('D:\\Git Repos\\Claudes\\sub', 'D:/Git Repos/Claudes'), true);
});
test('matchesProjectScope: trailing slash on root still matches', () => {
  assert.strictEqual(matchesProjectScope('D:/Git Repos/Claudes/sub', 'D:/Git Repos/Claudes/'), true);
});
test('matchesProjectScope: sibling dir does NOT match', () => {
  assert.strictEqual(matchesProjectScope('D:/Git Repos/ClaudesOther', 'D:/Git Repos/Claudes'), false);
});
test('matchesProjectScope: empty/nullish returns false', () => {
  assert.strictEqual(matchesProjectScope('', 'D:/Git Repos/Claudes'), false);
  assert.strictEqual(matchesProjectScope('D:/x', ''), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `matchesProjectScope is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/mcp-project.js`, add before the export guard:

```js
// True when configPathKey is the project root or nested under it. Slash- and
// trailing-slash-normalized so a "local" scope server keyed under a worktree or
// subdirectory of the project (e.g. ~/.claude.json projects[<worktree cwd>])
// still resolves to the project. Case-sensitive to match prior discovery semantics.
function matchesProjectScope(configPathKey, projectRoot) {
  if (!configPathKey || !projectRoot) return false;
  var norm = function (p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, ''); };
  var a = norm(configPathKey);
  var b = norm(projectRoot);
  if (!a || !b) return false;
  return a === b || a.indexOf(b + '/') === 0;
}
```

Add `matchesProjectScope` to BOTH the `module.exports` object and the `window.McpProject` object at the bottom of the file.

- [ ] **Step 4: Wire into main.js discovery**

`main.js:34` — extend the destructure:
```js
const { resolveProjectMcpSpawn, matchesProjectScope } = require('./lib/mcp-project');
```

`main.js:7534-7541` — replace the exact-equality match. Change:
```js
      const norm = String(projectPath).replace(/\\/g, '/');
      for (const [p, pcfg] of Object.entries(cfg.projects)) {
        if (p.replace(/\\/g, '/') === norm && pcfg && pcfg.mcpServers) {
          addAll(pcfg.mcpServers, 'project');
        }
      }
```
to:
```js
      for (const [p, pcfg] of Object.entries(cfg.projects)) {
        if (matchesProjectScope(p, projectPath) && pcfg && pcfg.mcpServers) {
          addAll(pcfg.mcpServers, 'project');
        }
      }
```
(The now-unused `norm` local in that block is removed; leave the outer `.mcp.json` block unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `matchesProjectScope` tests green, full suite green.

- [ ] **Step 6: Commit**

```bash
git add lib/mcp-project.js test/mcp-project.test.js main.js
git commit -m "feat(mcp): discover servers scoped under project subpaths (worktrees)"
```

---

### Task 2: Eligible-column selector for MCP respawn

**Files:**
- Modify: `lib/mcp-project.js` (add `mcpEligibleRespawnColumns`, export it)
- Test: `test/mcp-project.test.js`

**Interfaces:**
- Produces: `mcpEligibleRespawnColumns(descriptors) -> string[]` — given `[{ id, isClaude, stripped }]`, returns the `id`s of real Claude columns (`isClaude === true`) that are not MCP-stripped (`stripped !== true`). Order preserved. The renderer maps live columns to these descriptors and gates the banner on whether the tick set changed.

- [ ] **Step 1: Write the failing test**

Add to `test/mcp-project.test.js`:

```js
const { mcpEligibleRespawnColumns } = require('../lib/mcp-project');

test('mcpEligibleRespawnColumns: keeps real claude columns', () => {
  const out = mcpEligibleRespawnColumns([
    { id: 'a', isClaude: true, stripped: false },
    { id: 'b', isClaude: true, stripped: false },
  ]);
  assert.deepStrictEqual(out, ['a', 'b']);
});
test('mcpEligibleRespawnColumns: excludes custom cmd columns', () => {
  const out = mcpEligibleRespawnColumns([
    { id: 'a', isClaude: true, stripped: false },
    { id: 'c', isClaude: false, stripped: false },
  ]);
  assert.deepStrictEqual(out, ['a']);
});
test('mcpEligibleRespawnColumns: excludes strip-MCPs columns', () => {
  const out = mcpEligibleRespawnColumns([
    { id: 'a', isClaude: true, stripped: false },
    { id: 's', isClaude: true, stripped: true },
  ]);
  assert.deepStrictEqual(out, ['a']);
});
test('mcpEligibleRespawnColumns: empty / nullish input', () => {
  assert.deepStrictEqual(mcpEligibleRespawnColumns([]), []);
  assert.deepStrictEqual(mcpEligibleRespawnColumns(null), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `mcpEligibleRespawnColumns is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/mcp-project.js`, add before the export guard:

```js
// Filter live column descriptors to those a project-MCP change should offer to
// respawn: real Claude columns only (exclude custom `cmd` columns) that did not
// opt out via "Strip MCPs". Pure: the caller decides whether to act (banner is
// gated on whether the tick set actually changed).
function mcpEligibleRespawnColumns(descriptors) {
  var out = [];
  (descriptors || []).forEach(function (d) {
    if (!d || d.isClaude !== true || d.stripped === true) return;
    out.push(d.id);
  });
  return out;
}
```

Add `mcpEligibleRespawnColumns` to BOTH `module.exports` and `window.McpProject`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/mcp-project.js test/mcp-project.test.js
git commit -m "feat(mcp): pure selector for MCP-respawn-eligible columns"
```

---

### Task 3: Respawn re-resolves the project's scoped MCP config

**Files:**
- Modify: `renderer.js` — `restartColumn` (~6134-6145)

**Interfaces:**
- Consumes: `window.electronAPI.buildProjectMcpConfig(projectPath)` → `{ inherit, hasMcp } | { mcpConfigPath, strict, hasMcp }`; `window.McpProject.appendProjectMcpArgs(args, mcpResult)`; `maybeBindHeadroom`.
- Produces: after `restartColumn`, a resumed Claude column reflects the CURRENT project tick set (new `--mcp-config`/`--strict-mcp-config`) and correct `col.hasMcp`.

**Context:** Today `restartColumn` rebuilds args via `buildResumeArgs(col)` and never re-fetches the scoped MCP config, so a tick change is not applied on respawn. Mirror the initial-spawn resolution at `renderer.js:4583-4597`. Only for real Claude columns whose args are NOT already MCP-stripped (a `--mcp-config` already present in the resume args means "Strip MCPs" — leave it).

- [ ] **Step 1: Edit `restartColumn`**

Replace the block at `renderer.js:6134-6144`:
```js
  var sendMsg = { type: 'create', id: id, cols: col.terminal.cols, rows: col.terminal.rows, cwd: window.SessionTarget.resolveSessionLookupCwd(col, col.projectKey) };
  if (col.cmd) {
    sendMsg.cmd = col.cmd;
    sendMsg.args = col.cmdArgs || [];
  } else {
    sendMsg.args = buildResumeArgs(col);
  }
  if (col.env) sendMsg.env = col.env;
  // Bind to the app-managed Headroom proxy by env var (no `headroom wrap`).
  // Passthrough for arbitrary-cmd/endpoint columns; re-derived from live flag.
  maybeBindHeadroom(sendMsg, { hasEndpoint: !!(col.endpointId || col.env), isClaude: !col.cmd, hasMcp: !!(col && col.hasMcp) });
```
with:
```js
  var sendMsg = { type: 'create', id: id, cols: col.terminal.cols, rows: col.terminal.rows, cwd: window.SessionTarget.resolveSessionLookupCwd(col, col.projectKey) };
  if (col.cmd) {
    sendMsg.cmd = col.cmd;
    sendMsg.args = col.cmdArgs || [];
  } else {
    sendMsg.args = buildResumeArgs(col);
  }
  if (col.env) sendMsg.env = col.env;

  // Re-resolve the project's scoped MCP config so a respawn reflects the CURRENT
  // inherited-server tick set (the Claude CLI loads MCP only at process start, so
  // this is how a modal tick change goes live). Skip custom `cmd` columns and
  // columns already carrying --mcp-config (per-column "Strip MCPs" wins). Mirror
  // of the initial-spawn resolution; never blocks the respawn on failure.
  var __stripped = sendMsg.args.indexOf('--mcp-config') !== -1;
  var __rHasMcp = !!(col && col.hasMcp);
  if (!col.cmd && !__stripped && window.electronAPI && window.electronAPI.buildProjectMcpConfig && window.McpProject) {
    var __mcpRes = null;
    try { __mcpRes = await window.electronAPI.buildProjectMcpConfig(col.projectKey); }
    catch (e) { __mcpRes = null; }
    if (__mcpRes) {
      __rHasMcp = !!__mcpRes.hasMcp;
      col.hasMcp = __rHasMcp;
      sendMsg.args = window.McpProject.appendProjectMcpArgs(sendMsg.args, __mcpRes);
    }
  }
  // Bind to the app-managed Headroom proxy by env var (no `headroom wrap`).
  // Passthrough for arbitrary-cmd/endpoint columns; hasMcp from the fresh resolve.
  maybeBindHeadroom(sendMsg, { hasEndpoint: !!(col.endpointId || col.env), isClaude: !col.cmd, hasMcp: __rHasMcp });
```

- [ ] **Step 2: Verify no regression**

Run: `npm test`
Expected: PASS (no lib change; renderer not unit-tested). Confirm the file parses (no syntax error) — `node --check renderer.js`.

Run: `node --check renderer.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add renderer.js
git commit -m "feat(mcp): respawn re-resolves project MCP config so tick changes apply"
```

---

### Task 4: Refresh button in the MCP modal

**Files:**
- Modify: `index.html:1265-1269` (add refresh button to the inherited heading)
- Modify: `renderer.js` — `setupMcpManager` (bind the button), `openMcpModal` (~19845-19862)
- Modify: `styles.css` (button style, scoped)

**Interfaces:**
- Consumes: `window.electronAPI.discoverMcpServers(projectPath)`, existing `renderInheritList(servers, projectDefault)`.
- Produces: a `#mcp-inherit-refresh` button that re-runs discovery and re-renders the inherited list in place.

- [ ] **Step 1: Add the button markup**

`index.html` — replace line 1266:
```html
          <div class="mcp-inherit-heading">Inherited MCP servers</div>
```
with:
```html
          <div class="mcp-inherit-heading">Inherited MCP servers<button type="button" id="mcp-inherit-refresh" class="mcp-inherit-refresh" title="Re-scan for MCP servers">Refresh</button></div>
```

- [ ] **Step 2: Extract a reload function and bind the button**

In `renderer.js` `setupMcpManager` (after `inheritListEl` is defined, ~19666), add:
```js
  var inheritRefreshBtn = document.getElementById('mcp-inherit-refresh');
  function reloadInheritList() {
    if (!projectPath || !window.electronAPI || !window.electronAPI.discoverMcpServers) return;
    window.electronAPI.discoverMcpServers(projectPath).then(function (res) {
      renderInheritList((res && res.servers) || [], (res && res.projectDefault) || null);
    }).catch(function () { renderInheritList([], null); });
  }
  if (inheritRefreshBtn) inheritRefreshBtn.addEventListener('click', reloadInheritList);
```

In `openMcpModal` (~19857-19861), replace the inline discover call with a call to the shared function:
```js
    if (window.electronAPI.discoverMcpServers) {
      reloadInheritList();
    }
```
(`reloadInheritList` and `renderInheritList` are in the same `setupMcpManager` closure, so both are in scope.)

- [ ] **Step 3: Style the button**

In `styles.css`, add (scoped — no generic classes):
```css
.mcp-inherit-refresh {
  margin-left: 8px;
  font-size: 11px;
  padding: 1px 8px;
  background: transparent;
  border: 1px solid var(--border, #3a3a52);
  color: var(--text-dim, #9a9ab0);
  border-radius: 4px;
  cursor: pointer;
}
.mcp-inherit-refresh:hover { color: var(--text, #e0e0f0); border-color: var(--text-dim, #9a9ab0); }
```
(Match existing token names in `styles.css`; if these custom-property names differ, use the file's actual variables.)

- [ ] **Step 4: Verify**

Run: `node --check renderer.js && npm test`
Expected: renderer parses; suite green.

- [ ] **Step 5: Commit**

```bash
git add index.html renderer.js styles.css
git commit -m "feat(mcp): Refresh button re-scans inherited servers without reopen"
```

---

### Task 5: Change-tracking + "Respawn N columns" banner on modal close

**Files:**
- Modify: `renderer.js` — `setupMcpManager` (`persistInherit` marks dirty; close handler shows the toast)

**Interfaces:**
- Consumes: `window.McpProject.mcpEligibleRespawnColumns(descriptors)`, `showToast(message, { duration: 0, action: { label, onClick } })`, `restartColumn(id)`, the project's live columns (`projectStates` / `getOrCreateProjectState`), `projectPathToKey`.
- Produces: on modal close after a tick change, a sticky toast offering to respawn eligible columns; clicking respawns them.

**Context:** `showToast` (renderer.js:1524) supports `duration: 0` (sticky) and one action button. `persistInherit` (renderer.js:19828) already fires on every checkbox change. Column eligibility descriptor per live column: `{ id, isClaude: !col.cmd, stripped: (col.cmdArgs || []).indexOf('--mcp-config') !== -1 }`.

- [ ] **Step 1: Track dirty state on change**

In `setupMcpManager`, add a closure flag near `var projectPath = null;`:
```js
  var inheritDirty = false;
```
At the end of `persistInherit` (after `setProjectMcpDefault`), set:
```js
    inheritDirty = true;
```
Reset it when the modal opens — in `openMcpModal`, after `projectPath = projPath;`:
```js
    inheritDirty = false;
```

- [ ] **Step 2: Show the banner on close**

Find the modal close handler in `setupMcpManager` (the `closeBtn` click and any overlay/Escape close). Factor a `closeModal()` that hides the modal AND runs the banner check, and point the existing close paths at it:
```js
  function maybeOfferRespawn() {
    if (!inheritDirty || !projectPath) return;
    inheritDirty = false;
    var stateKeyStr = (typeof projectPathToKey === 'function') ? projectPathToKey(projectPath) : projectPath;
    var st = projectStates.get(stateKeyStr);
    if (!st || !st.columns) return;
    var descriptors = [];
    st.columns.forEach(function (col, id) {
      descriptors.push({ id: id, isClaude: !col.cmd, stripped: (col.cmdArgs || []).indexOf('--mcp-config') !== -1 });
    });
    var ids = window.McpProject.mcpEligibleRespawnColumns(descriptors);
    if (!ids.length) return;
    showToast('MCP servers changed. Respawn ' + ids.length + ' column' + (ids.length === 1 ? '' : 's') + ' to apply?', {
      duration: 0,
      kind: 'info',
      action: {
        label: 'Respawn',
        onClick: function () { ids.forEach(function (id) { try { restartColumn(id); } catch (e) {} }); }
      }
    });
  }
  function closeModal() {
    modal.classList.add('hidden');
    maybeOfferRespawn();
  }
```
Replace the body of the existing `closeBtn` handler (and any other close path in this closure) to call `closeModal()` instead of directly toggling `modal.classList`. Verify the exact current close handler(s) first and keep any extra behavior (e.g. `refocusActiveTerminal`) they already do.

- [ ] **Step 3: Verify project-state key**

Confirm how live columns are keyed: `projectStates` is keyed by the renderer's project key (`projectPathToKey(path)`), while the modal holds the raw `projectPath`. Confirm `projectPathToKey` exists and is the right mapping (grep `projectStates.get(` and `function projectPathToKey`). If columns are instead reachable via `getOrCreateProjectState`/`activeProjectKey`, use that accessor. Adjust the descriptor-collection lines accordingly. Do NOT create a state; only read.

- [ ] **Step 4: Verify**

Run: `node --check renderer.js && npm test`
Expected: renderer parses; suite green.

- [ ] **Step 5: Manual smoke (documented, not automated)**

In a dev build (`npm start`): add an MCP via `claude mcp add` from a chat → open modal → Refresh → server appears → tick it → close → toast offers "Respawn 1 column" → click → column reconnects (`--resume`, history intact) → `/mcp` shows the server.

- [ ] **Step 6: Commit**

```bash
git add renderer.js
git commit -m "feat(mcp): offer one-click respawn to apply MCP tick changes to live columns"
```

---

## Self-Review

**Spec coverage:**
- Refresh list (spec §1) → Task 4 (button) + Task 1 (discovery fix at source). ✓
- Apply to live columns via manual one-click respawn (spec §2) → Task 5 (banner) + Task 3 (respawn re-resolves config). ✓
- Eligible = real claude, not cmd, not strip-MCPs; respawn all eligible (spec §2) → Task 2 selector + Task 5 descriptor mapping. ✓
- `--resume` preserves conversation; `hasMcp`/Headroom gating (spec §2) → Task 3. ✓
- Testable seams `matchesProjectScope` + eligible selector (spec §3) → Tasks 1, 2. ✓
- Out of scope: no new authoring UI, no per-column selection, no CLI change. Respected. ✓

**Placeholder scan:** No TBD/TODO; all code shown. Two verify-in-code notes (Task 4 style tokens, Task 5 project-state key/close-handler) are explicit "confirm the actual name" instructions with a concrete default, not deferred work.

**Type consistency:** `matchesProjectScope(key, root)→bool`, `mcpEligibleRespawnColumns([{id,isClaude,stripped}])→id[]`, `buildProjectMcpConfig`/`appendProjectMcpArgs`/`showToast` signatures match usage across tasks. `window.McpProject` gains both new helpers. Consistent.
