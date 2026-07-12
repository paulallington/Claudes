# Spawn Codex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Spawn Codex" action that launches the `codex` CLI in a column, only shown when `codex` is installed, without touching any Claude-specific spawn machinery.

**Architecture:** A Codex column is an ordinary column spawned with `cmd: 'codex'`. Because `col.cmd` is already the codebase-wide "not a Claude column" discriminator (headroom binding, voice, session detection, crash-failover all branch on it), Codex inherits all the "skip the Claude stuff" behaviour for free. New code is limited to: PATH detection (main→IPC→preload), a gated "Spawn Codex" button in the existing spawn dropdown, and suppression of Claude-only column-header controls plus a "Codex" badge for `cmd` columns. Pure logic lives in a new `lib/codex-spawn.js` so it is unit-testable; the wiring in `main.js`/`renderer.js`/`index.html` is thin.

**Tech Stack:** Electron (main + preload + renderer), vanilla JS renderer, `node:test`/`node:assert` for unit tests (`npm test` → `node --test "test/*.test.js"`).

## Global Constraints

- Product name is "Claudes"; terminology is Spawn / Kill / Respawn.
- Terminal theme background is `#1a1a2e` (do not change).
- No generic `.hidden` class exists globally — every `.hidden` is scoped per component (see `feedback_no_generic_hidden_class`). The new Codex button is shown/hidden by `hasCodex`, so it uses its OWN scoped class (`codex-hidden`), NOT a global `.hidden`.
- Pure logic goes in `lib/*.js` with a matching `test/*.test.js`; wiring stays in `main.js`/`renderer.js`.
- Do not modify `buildSpawnArgs()`, the spawn-options behaviour, headroom, or endpoint presets.
- Codex is intentionally second-class: no voice, no session detection, no usage, no pet. These must remain *absent*, achieved by NOT adding any code that treats a `cmd` column as Claude.

---

## File Structure

- **Create** `lib/codex-spawn.js` — pure helpers: PATH-lookup command per platform, which/where output parsing, the Codex spawn descriptor, and the "does this column use Claude chrome" predicate.
- **Create** `test/codex-spawn.test.js` — unit tests for the above.
- **Modify** `main.js` — add cached `hasCodex()` (mirrors `findClaudePath()` at ~6619) + `ipcMain.handle('config:hasCodex', …)`.
- **Modify** `preload.js` — expose `hasCodex()` on the context bridge.
- **Modify** `index.html` — add the "Spawn Codex" button at the top of `#spawn-dropdown` (line ~293).
- **Modify** `styles.css` — scoped styles for the Codex spawn button, its hidden state, and the header Codex badge.
- **Modify** `renderer.js` — fetch `hasCodex` on startup and reveal the button; wire the button to spawn a Codex column; suppress Claude-only header controls and add a Codex badge for `cmd` columns.

---

## Task 1: Pure Codex-spawn helpers (`lib/codex-spawn.js`)

**Files:**
- Create: `lib/codex-spawn.js`
- Test: `test/codex-spawn.test.js`

**Interfaces:**
- Produces:
  - `codexLookupCommand(platform: string): 'where' | 'which'`
  - `parseWhichOutput(raw: string): string | null` — first non-empty trimmed line, or `null`
  - `buildCodexSpawn(cwd: string|null): { args: string[], opts: { cmd: string, title: string, cwd: string|null } }`
  - `columnUsesClaudeChrome(col: {cmd?: string}|null): boolean` — `true` only for Claude columns (no `cmd`)

- [ ] **Step 1: Write the failing test**

```js
// test/codex-spawn.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  codexLookupCommand,
  parseWhichOutput,
  buildCodexSpawn,
  columnUsesClaudeChrome
} = require('../lib/codex-spawn');

test('codexLookupCommand: where on win32, which elsewhere', () => {
  assert.strictEqual(codexLookupCommand('win32'), 'where');
  assert.strictEqual(codexLookupCommand('darwin'), 'which');
  assert.strictEqual(codexLookupCommand('linux'), 'which');
});

test('parseWhichOutput: returns first non-empty line, else null', () => {
  assert.strictEqual(parseWhichOutput('C:\\tools\\codex.exe\r\nC:\\other\\codex.exe\r\n'), 'C:\\tools\\codex.exe');
  assert.strictEqual(parseWhichOutput('/usr/local/bin/codex\n'), '/usr/local/bin/codex');
  assert.strictEqual(parseWhichOutput('   \n  \n'), null);
  assert.strictEqual(parseWhichOutput(''), null);
});

test('buildCodexSpawn: cmd=codex, empty args, Codex title, no Claude flags', () => {
  const spec = buildCodexSpawn('D:/proj');
  assert.deepStrictEqual(spec.args, []);
  assert.strictEqual(spec.opts.cmd, 'codex');
  assert.strictEqual(spec.opts.title, 'Codex');
  assert.strictEqual(spec.opts.cwd, 'D:/proj');
  // Guard: nothing Claude-specific leaks in.
  assert.ok(!('endpointId' in spec.opts));
  assert.ok(!('env' in spec.opts));
});

test('buildCodexSpawn: tolerates null cwd', () => {
  assert.strictEqual(buildCodexSpawn(null).opts.cwd, null);
});

test('columnUsesClaudeChrome: true for Claude, false for cmd columns', () => {
  assert.strictEqual(columnUsesClaudeChrome({}), true);
  assert.strictEqual(columnUsesClaudeChrome({ cmd: null }), true);
  assert.strictEqual(columnUsesClaudeChrome(null), true);
  assert.strictEqual(columnUsesClaudeChrome({ cmd: 'codex' }), false);
  assert.strictEqual(columnUsesClaudeChrome({ cmd: 'dotnet' }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/codex-spawn.test.js`
Expected: FAIL — `Cannot find module '../lib/codex-spawn'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/codex-spawn.js
'use strict';

// Which command resolves an executable's path on this platform.
function codexLookupCommand(platform) {
  return platform === 'win32' ? 'where' : 'which';
}

// First non-empty line of `where`/`which` output, or null if none.
function parseWhichOutput(raw) {
  if (!raw) return null;
  const lines = String(raw).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

// Descriptor for spawning a Codex column via addColumn(args, row, opts).
// Deliberately carries NO Claude-specific fields — a Codex column must never
// pick up permission-mode / model / headroom / endpoint plumbing.
function buildCodexSpawn(cwd) {
  return {
    args: [],
    opts: { cmd: 'codex', title: 'Codex', cwd: cwd == null ? null : cwd }
  };
}

// A column uses Claude-specific header chrome (compact/teleport/effort, the
// starburst icon) only when it has no custom command. cmd columns (Codex,
// launch configs) do not.
function columnUsesClaudeChrome(col) {
  return !col || !col.cmd;
}

module.exports = {
  codexLookupCommand,
  parseWhichOutput,
  buildCodexSpawn,
  columnUsesClaudeChrome
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/codex-spawn.test.js`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/codex-spawn.js test/codex-spawn.test.js
git commit -m "feat(codex): pure codex-spawn helpers (lookup, parse, descriptor, predicate)"
```

---

## Task 2: Codex PATH detection in main + bridge (`main.js`, `preload.js`)

**Files:**
- Modify: `main.js` — add after `getClaudePath()` (~6634)
- Modify: `preload.js` — add near `getHeadroomStatus` (~116)

**Interfaces:**
- Consumes: `codexLookupCommand`, `parseWhichOutput` from Task 1.
- Produces: IPC channel `config:hasCodex` → `boolean`; `window.electronAPI.hasCodex(): Promise<boolean>`.

This task has no unit test (it wraps `execFileSync` against the host PATH — an integration boundary). It is verified manually in Task 5 / the quality gate. Keep it a thin wrapper so all real logic stays in the Task 1 lib.

- [ ] **Step 1: Add the require in `main.js`**

Find the existing lib requires near the top of `main.js` (e.g. the `require('./lib/interactive-scheduled')` block ~39-43) and add below it:

```js
const { codexLookupCommand, parseWhichOutput } = require('./lib/codex-spawn');
```

- [ ] **Step 2: Add `hasCodex()` + IPC handler in `main.js`**

Insert immediately after `getClaudePath()` (the function ending ~6634):

```js
// Detect whether the `codex` CLI is on PATH. Cached for the session (result
// won't change while the app runs). Mirrors findClaudePath(); a missing binary
// simply means the "Spawn Codex" affordance is never offered.
let codexAvailable = null;
function hasCodex() {
  if (codexAvailable !== null) return codexAvailable;
  try {
    const out = execFileSync(codexLookupCommand(process.platform), ['codex'], { encoding: 'utf8' });
    codexAvailable = !!parseWhichOutput(out);
  } catch {
    codexAvailable = false;
  }
  return codexAvailable;
}

ipcMain.handle('config:hasCodex', () => hasCodex());
```

- [ ] **Step 3: Expose it in `preload.js`**

Add to the `electronAPI` object (next to `getHeadroomStatus`, ~116):

```js
  hasCodex: () => ipcRenderer.invoke('config:hasCodex'),
```

- [ ] **Step 4: Verify nothing broke**

Run: `npm test`
Expected: PASS (no test regressions). Manual bridge verification happens in Task 5.

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js
git commit -m "feat(codex): main-process codex PATH detection + preload bridge"
```

---

## Task 3: "Spawn Codex" button in the dropdown (`index.html`, `styles.css`, `renderer.js`)

**Files:**
- Modify: `index.html` — top of `#spawn-dropdown` (~293)
- Modify: `styles.css` — scoped button + hidden-state rules
- Modify: `renderer.js` — startup fetch of `hasCodex`, reveal button, wire click

**Interfaces:**
- Consumes: `window.electronAPI.hasCodex()` (Task 2); `buildCodexSpawn` (Task 1); existing `addColumn(args, targetRow, opts)`; existing `closeSpawnDropdown()`; the existing active-cwd source used by the normal "+ Spawn Claude" path.
- Produces: a working "Spawn Codex" action; DOM node `#btn-spawn-codex`.

This task's logic lives in `buildCodexSpawn` (unit-tested in Task 1). The renderer wiring is DOM glue verified manually (Task 5). Do NOT attempt a headless renderer unit test — the codebase has no such harness.

- [ ] **Step 1: Add the button markup (`index.html`)**

Insert as the FIRST child inside `<div id="spawn-dropdown" class="spawn-dropdown hidden">` (before `opt-headroom-label`, line ~294):

```html
              <button type="button" id="btn-spawn-codex" class="spawn-codex-action codex-hidden" title="Launch the Codex CLI in a new column">+ Spawn Codex</button>
              <div class="spawn-divider"></div>
```

- [ ] **Step 2: Add scoped styles (`styles.css`)**

Append near the other `.spawn-*` dropdown rules:

```css
.spawn-codex-action {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  border-radius: 4px;
}
.spawn-codex-action:hover { background: rgba(255, 255, 255, 0.08); }
/* Scoped hidden — NOT a global .hidden. Hidden until hasCodex() confirms the CLI. */
.spawn-codex-action.codex-hidden { display: none; }
```

- [ ] **Step 3: Grab the element and wire the click (`renderer.js`)**

Near the other spawn-button element lookups (`var btnAddOptions = document.getElementById('btn-add-options');`, ~22):

```js
var btnSpawnCodex = document.getElementById('btn-spawn-codex');
```

Then, near the `btnAddOptions.addEventListener('click', …)` wiring (~10908), add:

```js
if (btnSpawnCodex) {
  btnSpawnCodex.addEventListener('click', function (e) {
    e.stopPropagation();
    var spec = buildCodexSpawn(currentSpawnCwd());
    addColumn(spec.args, null, spec.opts);
    closeSpawnDropdown();
  });
}
```

`currentSpawnCwd()` must be the SAME cwd the normal Spawn button uses. Grep the `btnAdd` ("+ Spawn Claude") click handler and copy its cwd source verbatim rather than inventing a helper. Passing `null` is acceptable (addColumn falls back to project root) but matching the Claude path is preferred.

- [ ] **Step 4: Make `buildCodexSpawn` available to the renderer (`renderer.js`)**

Confirm how the renderer already loads pure libs (search `renderer.js` for `require('./lib/` or how `PermissionMode` — used as `PermissionMode.permissionModeToArgs` in `buildSpawnArgs` — is imported). Load Codex helpers the SAME way, alongside that existing import:

```js
var { buildCodexSpawn, columnUsesClaudeChrome } = require('./lib/codex-spawn');
```

If the renderer uses a different mechanism than `require`, mirror exactly what `PermissionMode` uses.

- [ ] **Step 5: Reveal the button on startup when Codex is present (`renderer.js`)**

In the renderer startup/init sequence (where other `electronAPI.*` status calls run — e.g. wherever `headroomInstalled` is fetched), add:

```js
if (window.electronAPI && window.electronAPI.hasCodex && btnSpawnCodex) {
  window.electronAPI.hasCodex().then(function (present) {
    if (present) btnSpawnCodex.classList.remove('codex-hidden');
  }).catch(function () { /* leave hidden on error */ });
}
```

- [ ] **Step 6: Verify tests still pass**

Run: `npm test`
Expected: PASS (unchanged — Task 1's tests still pass; no new unit tests here).

- [ ] **Step 7: Commit**

```bash
git add index.html styles.css renderer.js
git commit -m "feat(codex): Spawn Codex action in spawn dropdown, gated on installed CLI"
```

---

## Task 4: Suppress Claude-only header chrome + Codex badge for cmd columns (`renderer.js`, `styles.css`)

**Files:**
- Modify: `renderer.js` — `createColumnHeader` (~3706) and its call site in `addColumn` (~4159)
- Modify: `styles.css` — Codex badge style

**Interfaces:**
- Consumes: `columnUsesClaudeChrome` (Task 1).
- Produces: header without compact/teleport/effort controls for `cmd` columns; a small "Codex" text badge on Codex columns.

**Rationale:** compact (`/compact`), teleport (`/teleport`), and effort are Claude slash-command controls. On a Codex column they are broken affordances — exactly the "confusing UI" to avoid. The starburst icon likewise implies Claude.

- [ ] **Step 1: Thread the cmd into the header call (`renderer.js` ~4159)**

Change:

```js
  var header = createColumnHeader(id, opts.title);
```

to:

```js
  var header = createColumnHeader(id, opts.title, { cmd: opts.cmd || null });
```

- [ ] **Step 2: Gate Claude-only controls in `createColumnHeader` (`renderer.js` ~3719)**

`createColumnHeader(id, customTitle, opts)` already gates the compact/teleport/effort block on `if (!opts.isDiff)`. Widen it. Replace:

```js
  if (!opts.isDiff) {
```

with:

```js
  // cmd columns (Codex, launch configs) have no Claude slash commands — the
  // compact/teleport/effort controls would be broken affordances there.
  var claudeChrome = columnUsesClaudeChrome({ cmd: opts.cmd });
  if (!opts.isDiff && claudeChrome) {
```

(Verify the block's closing brace still balances — only the opening condition changes.)

- [ ] **Step 3: Add a Codex badge (`renderer.js`, inside `createColumnHeader`)**

Right after the `title` span is created (~3712), add:

```js
  if (opts.cmd === 'codex') {
    var codexBadge = document.createElement('span');
    codexBadge.className = 'col-codex-badge';
    codexBadge.textContent = 'Codex';
    codexBadge.title = 'This column runs the Codex CLI, not Claude';
    title.appendChild(codexBadge);
  }
```

(Appending to `title` keeps the badge next to the column name regardless of how `header` assembles `actions`. If the existing layout appends `title` then `actions` to `header`, this places the badge inline after the name — the intended spot.)

- [ ] **Step 4: Style the badge (`styles.css`)**

Append near the `.col-title` / `.column-header` rules:

```css
.col-codex-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  font-size: 10px;
  line-height: 15px;
  border-radius: 3px;
  background: rgba(120, 170, 255, 0.18);
  color: #a9c7ff;
  vertical-align: middle;
}
```

- [ ] **Step 5: Verify tests still pass**

Run: `npm test`
Expected: PASS (Task 1's `columnUsesClaudeChrome` tests cover the predicate; header wiring is manual-verified).

- [ ] **Step 6: Commit**

```bash
git add renderer.js styles.css
git commit -m "feat(codex): hide Claude-only header controls and add Codex badge on cmd columns"
```

---

## Task 5: Manual verification (persistence + no-Claude-machinery)

**Files:** none (verification only).

No code. Confirm the end-to-end behaviour the spec promised. A failed check indicates a wiring bug in Tasks 2-4 to fix before completion.

- [ ] **Step 1: Launch the dev build**

Run: `npm start` (dev build — leave any installed production app running; see `feedback_never_close_production_app`).

- [ ] **Step 2: Codex present → button shows; spawn works**

With `codex` on PATH: open the spawn chevron dropdown → "Spawn Codex" is visible at the top. Click it → a column titled "Codex" with the Codex badge appears and `codex` runs in it. The header shows NO compact/teleport/effort controls and no starburst icon.

- [ ] **Step 3: No Claude machinery attaches**

Confirm the Codex column triggers no voice playback, no headroom banner/binding, and does not appear as a Claude session (no session-id badge). These are inherited from the `col.cmd` branch — this step confirms nothing regressed.

- [ ] **Step 4: Persistence across restart**

Quit and relaunch the dev app. The Codex column is restored and respawns `codex` (via the existing `cmd` restore path). Kill and Respawn both work; the exit banner reads "Restart"/"Respawn" as appropriate.

- [ ] **Step 5: Codex absent → button hidden**

Temporarily make `codex` unresolvable (rename it on PATH, or test on a machine without it) and relaunch: the "Spawn Codex" item is absent from the dropdown, with no error surface.

- [ ] **Step 6: Full quality gate**

Run: `npm test`
Expected: PASS — zero failures (pre-existing included).

---

## Self-Review

**Spec coverage:**
- Entry point / dropdown → Task 3 (button at top of `#spawn-dropdown`). **Deviation from spec's literal wording:** the spec speculated a "menu with Spawn options…" reachable in one extra click. The real `#spawn-dropdown` already opens from the chevron as a panel, so Codex is placed as a prominent action at its top and the options stay in the same panel — **no extra click**, which actually resolves the tradeoff the spec flagged. Confirm this reading with the user.
- MVP scope (persisted terminal; no voice/session/resume) → inherited via `col.cmd`; verified in Task 5 steps 3-4.
- No confusing config surface → Task 3 (Codex bypasses `buildSpawnArgs`) + Task 4 (broken header controls removed).
- PATH gating; hidden when absent → Tasks 2 + 3 + Task 5 step 5.
- Visual distinction → Task 4 (badge + suppressed starburst).
- Git tab left visible/unchanged → no task touches it (correct — leaving it is the design).

**Placeholder scan:** No TBD/TODO. The two "grep the existing pattern and match it" instructions (renderer cwd source, Task 3 step 3; renderer lib-import mechanism, Task 3 step 4) are deliberate — the exact renderer idiom must be copied from the live file rather than guessed. Both name the concrete symbol to copy (`btnAdd` handler's cwd source; `PermissionMode`'s import).

**Type consistency:** `buildCodexSpawn` returns `{ args, opts:{ cmd,title,cwd } }` — consumed exactly so in Task 3 (`addColumn(spec.args, null, spec.opts)`). `columnUsesClaudeChrome({cmd})` defined in Task 1, consumed in Task 4. IPC `config:hasCodex` defined in Task 2, consumed in Task 3. Names match across tasks.
