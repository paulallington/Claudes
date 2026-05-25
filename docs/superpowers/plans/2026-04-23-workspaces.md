# Project rename + per-project workspaces

## Context

Today each project in Claudes owns a single terminal layout persisted to `<project>/.claudes/sessions.json`. Power users (e.g. CSUX work) accumulate 12+ sessions for a single project — Dev, PR review, general Q&A — that all get crammed into one grid.

This change adds:

1. **Rename by double-click** on a project's name (writes `project.name` into `~/.claudes/projects.json`).
2. **Workspaces** — child sub-tabs under a project, each a named sub-context with its own terminal layout, own session persistence, own status/alert icon, no path/worktree label. Created with a "+" button on each project card, also renameable by double-click.

## Model

- The project tab **is** the **Primary** workspace. Clicking the project card navigates to the primary terminal layout, which continues to live in `<project>/.claudes/sessions.json` exactly as today. Primary does **not** get its own sub-tab under the project.
- Sub-workspaces are **peers** to Primary, rendered as indented sub-rows under the project card. Each is its own named context with its own terminal grid and its own alerts. Clicking one switches the grid to that workspace's layout.
- Each workspace (Primary and sub-workspaces alike) tracks **its own** alert state. No rollup — the project card badge reflects Primary's columns only; each sub-workspace row shows its own badge for its own columns.
- **Active highlighting** follows the peer model: only the currently-active workspace gets the `.active` accent. When a sub-workspace is active, the project card is **not** highlighted; when Primary is active, the project card is highlighted and sub-rows aren't.
- PTYs stay alive across workspace switches (same behavior as today's project switches — nothing is killed, just hidden).

## Design decisions

- **Single-file storage (per user direction):** everything stays in the existing `<project>/.claudes/sessions.json`. The shape evolves from `{ sessions: [...] }` to `{ sessions: [...], workspaces: { "<id>": { sessions: [...] } } }`. Primary sessions remain in the top-level `sessions` array (existing shape preserved for read compat); sub-workspace sessions are keyed under `workspaces.<id>.sessions`. **No new directory**, **no new IPC handlers** — just extend the existing `sessions:load` / `sessions:save` to carry the richer shape.
- **Legacy shape:** if `sessions.json` on disk is the old flat shape `{ sessions: [...] }`, it's loaded as Primary with an implicit empty `workspaces: {}`. First save writes the new shape. Old Claudes versions can still read the new file's `sessions` array (they'll ignore the unknown `workspaces` key), so this is forward- and backward-readable for Primary.
- **Workspace ID:** `'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 10)` — **8 random base36 chars**. In `addWorkspace`, check `project.workspaces.some(w => w.id === ws.id)` and regenerate on collision. Debounce the `+` button by disabling it between click and `renderProjectList()` completion.
- **`workspaceId` stamping on columns:** every column has an explicit `workspaceId` field. Primary: `workspaceId: null` (explicit null, not `undefined`, not omitted). Sub-workspaces: `workspaceId: <the ws id>`. Filters use **strict equality** (`col.workspaceId === null` for Primary, `col.workspaceId === id` otherwise). Legacy columns loaded from pre-feature `sessions.json` get normalized to `null` at load time. `stateKey(projectPath, workspaceId)` coerces: `workspaceId == null ? projectPath : projectPath + '::' + workspaceId`.
- **Active state key:** `projectStates` Map is re-keyed via `stateKey`. Call sites to update (enumerated so nothing is missed): `getOrCreateProjectState` (769–790), `saveColumnCounts` (800–807), `setActiveProject` (1588–1649), `restoreProjectSessions` (1651–1666), `removeColumn` (1158, 2907), `disposeColumnLocalOnly` (1133–1142), `persistSessions` (2862–2873), popout paths (941–961, 1020, 1027–1075, 1101–1131).
- **Persist-write uses column's own workspaceId (not active state):** `persistSessions(projectKey, workspaceId)` takes both args; `removeColumn` passes `col.workspaceId`. With single-file storage, the workspaceId selects which key in the on-disk JSON gets rewritten. `persistSessions` reads the current file, mutates the correct key (`sessions` for Primary, `workspaces.<id>.sessions` for sub-workspaces), and writes the whole blob atomically. **Guard:** if `workspaceId != null` and `project.workspaces` no longer contains that id (deletion in progress), early-return without writing so the delete path's in-memory `workspaces` mutation isn't overwritten.
- **Alerts — strictly per-workspace:**
  - Project card badge filters `allColumns` where `projectKey === project.path && col.workspaceId === null`; sub-workspace badge filters where `col.workspaceId === ws.id`.
  - `clearProjectAttention(projectKey)` at 753–761 becomes `clearProjectAttention(projectKey, workspaceId)` and only clears attention on columns matching the workspace. Update callers (`setActiveProject`, `setActiveWorkspace`, `setFocusedColumn` at ~2996–3002) to pass the workspace id.
  - **Known UX trade-off:** when a project group is collapsed or sub-workspaces are scrolled off-screen, their badges are invisible. Accepted — user explicitly asked for per-workspace alerts with no cross-workspace rollup.
  - **Known startup lag:** on app launch, only the active workspace per project restores its PTYs. Inactive workspaces don't light their badges until the user switches to them. Accepted — pre-restoring every workspace on launch would multiply startup cost.
- **Hover layout (DOM vs CSS):** the DOM child order of `.project-right` changes to: `<remove× />`, `<middle-row><badge /><pin /></middle-row>`, `<add-workspace+ />`. CSS reflows the container as `flex-direction: column; justify-content: space-between; align-items: flex-end` so the children land top/middle/bottom. Hover reveal rules stay the same per-child (× hidden until hover, + hidden until hover, badge+pin per existing rules). Structural DOM change, not pure CSS.
- **Hover UX:** on project card hover, `×` (top-right), `+` (bottom-right, `title="New workspace"`). `+` click creates a new sub-workspace with placeholder name "New workspace", immediately calls `startInlineRename` on the new name (focus + select all), and switches active.
- **Deletion:** sub-workspace `×` calls `confirm('Delete workspace "<name>"? This will kill its terminals.')` consistent with project delete at renderer.js:1780. On confirm, **in order**: (1) remove the workspace from `project.workspaces` first so `persistSessions`' guard short-circuits in-flight writes, (2) call `removeColumn()` on each column (kills the PTY, disposes xterm), (3) `loadSessions(projectPath)` → `delete blob.workspaces[id]` → `saveSessions(projectPath, blob)` to remove the workspace's sessions from the single file, (4) if it was active, call `setActiveWorkspace(projectIndex, null)` to switch to Primary. Deleting the last sub-workspace simply leaves `workspaces: []` — Primary is unaffected.
- **Popout interaction:** popouts remain Primary-only (per Open Questions).
  - When popping out a project, force `project.activeWorkspaceId = null` before the popout window opens so the popout renderer always boots on Primary.
  - When popping back in (`handleProjectPoppedIn`), keep `activeWorkspaceId` at null.
  - `.project-add-workspace` hidden on popped-out cards.
  - `applyTransferredColumns` (1101–1131) explicitly stamps received columns with `workspaceId: null`.
  - `setActiveWorkspace` early-returns if `popoutMode` is true.
- **Maximize interaction:** on any project/workspace switch, if `maximizedColumnId` is non-null and the column doesn't belong to the new active `(projectKey, workspaceId)`, call `toggleMaximizeColumn(maximizedColumnId)` to restore normal layout **before** hiding the previous container. Optionally move `maximizedColumnId` onto `state` (per-state, referenced at 3047/3055/3075) — only if the extraction is small; otherwise restore-before-hide is sufficient.
- **Right-click on workspace rows:** attach a `contextmenu` listener that calls `e.preventDefault()`. For this PR the menu can show nothing or a minimal Rename/Delete pair — implementer's call. Without this, the default browser context menu opens inside the app chrome.
- **Atomic-write upgrade:** `sessions:save` at main.js:687–694 is **not** atomic today — it writes directly via `writeFileSync`. The atomic tmp+rename pattern is in the sticky-notes handler at main.js:706–737 (`writeStickyNotesAtomic`). Since sessions.json now carries multi-workspace state, a partial write is a much bigger regression than today. **Upgrade `sessions:save` to the sticky-notes tmp+rename pattern in this PR** (small change; reduces partial-write risk for both Primary and workspace data).

## Files to change

### `main.js`
- **`sessions:load` at 696–704:** behavior is unchanged for callers — it returns the loaded JSON blob. Today it returns `data.sessions || []`; change it to return the **whole blob** `{ sessions: [...], workspaces: {...} }` (with `workspaces` defaulted to `{}` if absent). Renderer-side code that previously called `loadSessions` for Primary now receives the blob and reads `.sessions` itself; the extra data is available for workspace loads without a second IPC round-trip.
- **`sessions:save` at 687–694:** change the payload shape from `sessionData` (plain array) to the full blob `{ sessions, workspaces }`. Upgrade the write to the atomic tmp+rename pattern modeled on the sticky-notes atomic writer at main.js:706–737 (extract or inline — 3-line change).
- **No new IPC handlers.** No `workspace:load` / `workspace:save` / `workspace:delete` — that flow is collapsed into the existing `sessions:*` handlers. Workspace deletion is a renderer-side `delete blob.workspaces[id]` followed by a normal `sessions:save`.
- No handler needed for project/workspace rename — plain field edits on `~/.claudes/projects.json`, covered by `config:saveProjects` at **main.js:525–527**.

### `preload.js`
- No new bridged functions. `saveSessions(projectPath, data)` and `loadSessions(projectPath)` keep their names and shapes (just the data shape changes, which the renderer controls).

### `renderer.js`

**Data model migration (near `loadProjects()` at ~907–979):**
- On load, for any project missing `workspaces`, set `workspaces: []` and `activeWorkspaceId: null`. Insertion point is alongside the existing `columnCount`/`poppedOut` defaults at ~917–927. For each column loaded from `sessions.json` lacking `workspaceId`, normalize to `null` at load time.

**Project card (buildProjectItem at 1219–1439):**
- **Restructure `.project-right`** to three zones via flex-column: `<remove× />`, `<middle-row><badge /><pin /></middle-row>`, `<add-workspace+ />`. This is a **DOM reorder**, not just CSS repositioning. Existing hover-reveal behaviors per child stay intact.
- **Rename dblclick on `.project-name`** (around line 1267): call the new shared `startInlineRename(el, { onCommit: (text) => { project.name = text; saveConfig(); renderProjectList(); }})`. Stop click propagation inside the editable so cursor-positioning clicks don't activate the project.
- **"+" button:** new `<span class="project-add-workspace" title="New workspace">+</span>` appended to `.project-right` last. Click handler:
  ```js
  function addWorkspace(projectIndex) {
    var project = config.projects[projectIndex];
    if (!project.workspaces) project.workspaces = [];
    // Retry on collision
    var ws;
    for (var attempt = 0; attempt < 5; attempt++) {
      var id = 'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 10);
      if (!project.workspaces.some(w => w.id === id)) { ws = { id, name: 'New workspace', createdAt: Date.now() }; break; }
    }
    project.workspaces.push(ws);
    saveConfig();
    renderProjectList();
    setActiveWorkspace(projectIndex, ws.id);
    var nameEl = projectListEl.querySelector('.workspace-item[data-workspace-id="' + CSS.escape(ws.id) + '"] .workspace-name');
    if (nameEl) startInlineRename(nameEl, { onCommit: (text) => { ws.name = text; saveConfig(); renderProjectList(); }});
  }
  ```
  The `+` button should be disabled during render to debounce rapid double-clicks.
- **Status badge logic at ~1269–1282:** compute `count` for the project badge by filtering `allColumns` where `col.projectKey === project.path && col.workspaceId === null` (Primary-only, strict null).

**Workspace rows (new, rendered inside `renderProjectEntries` at ~1441–1521):**
- After the `.project-item` is appended for a project, if `project.workspaces.length > 0`, render each workspace as a `<div class="workspace-item">` sibling with `data-project-path` and `data-workspace-id`. Structure:
  ```html
  <div class="workspace-item" data-project-path="..." data-workspace-id="...">
    <div class="workspace-name">Dev</div>
    <div class="workspace-right">
      <span class="workspace-badge"><img class="claude-icon" src="./claude-small.png"></span>
      <span class="workspace-remove">×</span>
    </div>
  </div>
  ```
  `.workspace-badge` only appended when that workspace has columns (mirrors the project rule).
- Dblclick rename on `.workspace-name` → `startInlineRename` with `onCommit: (text) => { ws.name = text; saveConfig(); renderProjectList(); }`.
- Click → `setActiveWorkspace(projectIndex, workspaceId)`.
- Right-click: `contextmenu` listener calls `e.preventDefault()` (suppresses browser default menu).
- `×` hover-revealed, confirm(), then `deleteWorkspace(projectIndex, workspaceId)`:
  1. Splice the workspace out of `project.workspaces` first (so the `persistSessions` guard short-circuits any in-flight writes).
  2. For each column in that workspace, call `removeColumn(id)` (kills PTY, disposes xterm; per-column persist attempts are guarded and become no-ops).
  3. Load the current sessions blob (`loadSessions(projectPath)`), `delete blob.workspaces[workspaceId]`, call `saveSessions(projectPath, blob)`.
  4. If it was the active workspace, `setActiveWorkspace(projectIndex, null)` to switch to Primary.
  5. `saveConfig()` and `renderProjectList()`.

**Shared rename helper (required):**
- Extract the contenteditable + Enter/Escape/blur pattern at renderer.js:1934–1965 into `startInlineRename(el, { onCommit, onEmpty })`. Refactor `startTitleEdit` (existing column rename) to use it so the three call sites share one implementation. **Required** — the workspace rename flow depends on it.
- **Paste safety:** attach a `paste` listener that calls `e.preventDefault()` then `document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))` so clipboard HTML (including `<img onerror>`) never lands in the DOM. Commit handler reads `textContent.trim()`.
- **Empty-name behavior:** on commit, if `textContent.trim()` is empty, revert the element's text to the prior name and **do not** call `onCommit`. For columns, the caller passes `onEmpty: (id) => 'Claude #' + id` to preserve the existing fallback. Projects and workspaces omit `onEmpty` so the helper's default-revert kicks in.

**Drag-reorder for workspaces (within same project only):**
- Mirror the project drag pattern at renderer.js:1317–1359. Module-level `workspaceDragFromIndex = -1` and `workspaceDragFromProjectPath = null`.
- On each `.workspace-item`: `draggable="true"` unconditionally. Same five handlers:
  - `dragstart`: record `{ fromIndex, fromProjectPath }`, add `.dragging`.
  - `dragover`: accept only when `dragFromProjectPath === this.projectPath`; else `dropEffect = 'none'`, no highlight.
  - `drop`: splice `project.workspaces` from `fromIndex` → drop index. `saveConfig()`, `renderProjectList()`.
- **Guard project dragover/drop against workspace drags:** in the existing project-item `dragover` handler at 1332, early-return if `workspaceDragFromIndex !== -1` (don't paint valid-drop cursor on project cards while a workspace is being dragged). Same for the `drop` handler.
- Styling: extend `.dragging` and `.drag-over` selectors in styles.css to cover `.workspace-item.dragging` and `.workspace-item.drag-over`.

**Active project/workspace plumbing:**
- `stateKey(projectPath, workspaceId)` — returns `projectPath` when `workspaceId == null`, else `projectPath + '::' + workspaceId`. Normalize defensively. Use as the key for `projectStates`.
- `setActiveProject(index, isStartup)` at 1588–1649: if `project.activeWorkspaceId` is non-null AND that id is in `project.workspaces`, delegate to `setActiveWorkspace(index, project.activeWorkspaceId, isStartup)`. If set but stale (id no longer in the array), clear `project.activeWorkspaceId = null` and fall through to Primary. Always route through `setActiveWorkspace` (Primary = `setActiveWorkspace(index, null, isStartup)`).
- **Clicking the project-item DOM always sets Primary:** the click handler at 1309 calls `setActiveWorkspace(index, null)` explicitly, regardless of prior `activeWorkspaceId`. (This is the Verification step 11 case.)
- `setActiveWorkspace(projectIndex, workspaceId, isStartup)` (new): early-return if `popoutMode`. If `maximizedColumnId` points to a column outside the new `(project, workspace)`, call `toggleMaximizeColumn(maximizedColumnId)` **before** hiding the previous container. Hide previous `(project, workspace)` containerEl; show (or create via `getOrCreateProjectState(stateKey(...))`) the new one. Update `config.activeProjectIndex`, set `config.projects[projectIndex].activeWorkspaceId = workspaceId` (null clears it). Call `restoreSessions(projectPath, workspaceId)` if target state has no columns and `isStartup`. `saveConfig()` at end.
- `restoreProjectSessions` at 1651–1666: generalize to `restoreSessions(projectPath, workspaceId)`. Call `loadSessions(projectPath)` once, then read the correct key from the blob — `blob.sessions` for Primary (workspaceId null), or `blob.workspaces[workspaceId]?.sessions || []` for a sub-workspace. Spawn columns with `addColumn(args.concat(['--resume', sessionId]), null, { title, workspaceId })`.
- `persistSessions(projectKey, workspaceId)` at 2862–2873: **read-modify-write the blob**. Call `loadSessions(projectKey)`, mutate the correct key (set `blob.sessions = [...]` for Primary or `blob.workspaces[workspaceId] = { sessions: [...] }` for a sub-workspace), call `saveSessions(projectKey, blob)`. **Guard:** if `workspaceId != null` and `project.workspaces` (in renderer state) no longer contains that id, early-return (deletion-in-progress safety). Consider a short in-memory cache of the blob to avoid an extra disk read on every column-level change — or accept the tiny cost, per existing session files being small.
- `removeColumn(id)` at 2890: pass `col.workspaceId` (not derived from active state) to `persistSessions`. Same for `disposeColumnLocalOnly` (1133–1142).
- `saveColumnCounts` at 800–807: rekey via `stateKey`. If it tracks a single count per project for sidebar purposes, extend to track Primary + each workspace separately; otherwise let the render-time badge filter handle it (confirm during implementation).
- `addColumn(...)` at ~2211–2229: stamp `workspaceId: project.activeWorkspaceId` (`null` for Primary). **Exception:** `applyTransferredColumns` (1101–1131) explicitly stamps `workspaceId: null` (popouts are Primary-only).

**Alerts (status badge):**
- `updateSidebarActivity()` at 646–683: bucket by `(projectKey, workspaceId)` — e.g. `attentionByProject[projectKey][workspaceId || '__primary__']`. Apply:
  - Project badge (`.project-item .project-badge`) → Primary bucket only.
  - Workspace badge (`.workspace-item[data-workspace-id="X"] .workspace-badge`) → that workspace's bucket.
- No cross-workspace rollup on the project card.

### `styles.css`
- **`.project-right` layout update** (at styles.css:394): change to `display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end;`. Wrap today's badge+pin in a middle `<div>`. No change to card height or paddings.
- **`.project-add-workspace`:** mirror `.project-pin` (11px font, 2px 4px padding, `--text-dimmer` default, `--text-primary` on hover), hidden by default and revealed via `.project-item:hover .project-add-workspace { display: inline-block; }`. Also add `.project-item.popped-out .project-add-workspace { display: none; }` so popped-out cards don't expose it.
- **`.workspace-item`:** height ~22–28px (project-item is ~56px today; dropping branch+path lands at ~40% — roughly "1/3–1/4"). Left margin/padding ~16–20px to inset. Reuse `--border-primary`, `--hover-light`, `--accent`. `.workspace-item.active` uses the same `--accent` as `.project-item.active`.
- **`.workspace-right`:** two-zone (badge + ×). `.workspace-remove` hover-reveal matches `.project-remove`. Extend `.project-badge.badge-working .claude-icon` / `.badge-attention` rules at styles.css:1004/1024 to cover `.workspace-badge` too.
- **`.editing`:** extend the existing column-rename selector to include `.project-name.editing, .workspace-name.editing`.

### `index.html`
- No changes expected.

### Docs
- Update `CLAUDE.md` to mention the new sessions.json shape (Primary sessions at `sessions`, sub-workspace sessions at `workspaces.<id>.sessions`) and the `workspaces` + `activeWorkspaceId` fields on projects in `~/.claudes/projects.json`. README.md and SECURITY.md only mention session data at a high level — audit and update if specifics need to change, otherwise leave alone.

## Reused code/patterns

- **Inline rename:** `startInlineRename` extracted from the contenteditable+`.editing` flow at renderer.js:1934–1965. Used by column, project, and workspace rename.
- **Atomic config write:** `config:saveProjects` at main.js:525–527 handles debounced write-through for projects.json; rename and workspace-list mutations flow through it unchanged.
- **Session file write:** sticky-notes atomic writer at main.js:706–737 is the template for upgrading `sessions:save` to tmp+rename.
- **Badge rollup:** existing `allColumns` filter for the status badge — extend with a `workspaceId` predicate instead of a parallel data structure.
- **Drag reorder:** existing project drag handlers at renderer.js:1317–1359 are the template for the workspace drag handlers.

## Verification

1. **Migration (no-op load):** `npm start` against an existing projects.json that has no `workspaces` field on any project. Expected: sidebar renders identically to today, no sub-rows, single-click still navigates. Inspect `~/.claudes/projects.json` after the first debounced save — every project should now have `workspaces: []` and `activeWorkspaceId: null`. Existing `sessions.json` is untouched.
2. **Hover layout:** Hover a project card: `×` appears top-right, `+` appears bottom-right; badge/pin still in their existing positions. The three zones stack visibly (DOM restructure verified by devtools).
3. **Project rename:** Dblclick a project name → edit mode (name selected). Type a new name, press Enter → sidebar updates, `~/.claudes/projects.json` reflects the new `name`. Escape restores. Enter with empty string reverts to prior name (no save). Paste HTML from clipboard (e.g. copy text from a webpage) → text-only arrives in the field.
4. **Column rename regression:** Dblclick a column title, rename, Enter. Confirm the title updates and `sessions.json` persists it — validates the `startInlineRename` extraction didn't regress existing behavior.
5. **Add workspace:** Click `+` on a project. Expect a new indented sub-row appears, name in edit mode pre-filled with "New workspace" (selected). Type "Dev", Enter. `~/.claudes/projects.json` now has `workspaces: [{id, name: 'Dev', createdAt}]` and `activeWorkspaceId` set on that project. **Expected:** `setActiveWorkspace` auto-spawns a blank column in the empty workspace (same as today's empty-project behavior at 1632–1638), so `<project>/.claudes/sessions.json` gets rewritten with the new shape — `{ sessions: [...primary...], workspaces: { "<id>": { sessions: [one new session] } } }`.
6. **Workspace isolation:** Spawn an extra terminal in Dev. Click back on the project card → grid swaps to Primary's terminals. Click "Dev" → Dev's terminals come back (same PTY, same scrollback). Inspect `sessions.json`: Primary's `sessions` array is unchanged from its pre-workspace state; only the `workspaces.<id>.sessions` sub-array grew.
7. **Restart persistence:** Kill Claudes and relaunch. Open `~/.claudes/projects.json` in an editor and confirm `activeWorkspaceId` matches the workspace that was active before shutdown. Confirm the visible grid matches that workspace's sessions. Separately, manually corrupt the stored `activeWorkspaceId` to a non-existent id and relaunch — confirm Claudes silently falls back to Primary without crashing and clears the stale id.
8. **Per-workspace alerts:** Start a long-running command in Dev (e.g. `python -m http.server 9999`). Click back to the project card (Primary). Dev's sub-row badge shows `badge-working`. Project card badge reflects **Primary only** — stays idle with no active Primary terminals. Wait for `ACTIVITY_IDLE_MS` (grep renderer.js for the constant — usually a few seconds) and confirm the Dev badge transitions from `badge-working` to `badge-attention`. Alternatively trigger directly via devtools: call `setColumnActivityState(id, 'attention')`. Confirm Primary badge stays unaffected.
9. **Workspace rename:** Dblclick "Dev" → edit mode. Rename to "PR reviews", Enter → sidebar + projects.json update. Workspace key in `sessions.json` unchanged (stable id). Test empty-name: dblclick again, clear, Enter → reverts to "PR reviews".
10. **Add second workspace:** Click `+` again → "New workspace" sub-row appears, becomes active. Rename to "General Qs".
11. **Delete workspace:** Hover "PR reviews" → `×` appears. Click → `confirm()`. OK → the workspace key is removed from `sessions.json`'s `workspaces` object (inspect the file), PTYs killed (verify via Task Manager or `tasklist | findstr node` before/after; or check the `npm start` terminal for pty-server kill log lines), sub-row disappears, active switches to Primary. `~/.claudes/projects.json` `workspaces` array has one entry left.
12. **Delete last workspace:** Delete "General Qs" → sub-row disappears, `workspaces: []` in projects.json, `sessions.json` has an empty `workspaces: {}` object (or the key is gone). Primary's `sessions` array untouched throughout.
13. **Clicking project card while on sub-workspace:** Switch to "Dev", then single-click the project card → returns to Primary. `activeWorkspaceId` is null in projects.json after the click.
14. **Drag-reorder workspaces:** With two sub-workspaces under a project, drag one above the other. Sidebar order updates; inspect `projects.json` — `workspaces` array order is swapped. **Functional** check for cross-project: drag a workspace onto a *different* project card and drop — `projects.json` for both projects must be unchanged (cursor feedback may be flaky on Windows, so rely on the data assertion). Relaunch confirms order persists.

## Phases

Execute phase-by-phase. Each phase has a browser-automation gate modeled on `C:\Users\mrichardson\.claude\projects\D--Repos-Claudes\scripts\verify-sticky-notes.mjs` (Playwright `_electron` launching the real app, scratch `~/.claudes/projects-dev.json`, scratch project dirs, DOM + on-disk assertions). A single growing script — `scripts/verify-workspaces.mjs` in the same scripts folder — holds all assertions; each phase gates on the subset that's been added by then. Gates auto-commit on green; failures pause for investigation.

### - [ ] Phase 1 — Project rename + shared inline-rename helper
- Deliverables: `startInlineRename(el, { onCommit, onEmpty })` extracted from renderer.js:1934–1965, `startTitleEdit` refactored to use it, dblclick on `.project-name`, `.project-name.editing` CSS rule.
- No workspace work yet.
- **Gate:** Playwright launches app, dblclicks a project name, types, Enter → asserts `~/.claudes/projects-dev.json` `name` field updated and sidebar reflects change. Dblclicks again, clears, Enter → asserts name reverts (empty-name no-op). Paste HTML text → asserts only plain text lands. Dblclicks a column title, renames → asserts column rename regression passes.
- Effort: S (~60 LOC).

### - [ ] Phase 2 — Data model + IPC shape + state rekey (no UI yet)
- Deliverables: `loadProjects` defaults `workspaces: []` and `activeWorkspaceId: null`. `stateKey(projectPath, workspaceId)` helper. `projectStates` Map rekey across all enumerated call sites. Legacy column `workspaceId` normalization to `null`. `sessions:load` returns full blob `{ sessions, workspaces }`. `sessions:save` accepts blob shape and upgrades to atomic tmp+rename. `persistSessions(projectKey, workspaceId)` + read-modify-write of the blob. `restoreSessions(projectPath, workspaceId)`. `addColumn` stamps `workspaceId: null` for all columns (no sub-workspaces yet exist).
- **Proven no-op gate:** Playwright launches with an existing pre-feature `projects-dev.json` and `sessions.json`. Spawns columns, switches projects, kills and relaunches. Asserts `sessions.json` byte-content matches pre-change except the shape upgrade (any legacy `{sessions:[...]}` blob becomes `{sessions:[...], workspaces:{}}` with identical `sessions` array). Asserts `projects-dev.json` reflects only the `workspaces: []` / `activeWorkspaceId: null` defaults on each project.
- Effort: M (~150 LOC).

### - [ ] Phase 3 — Workspace UI (add, rename, switch)
- Deliverables: `.project-right` DOM restructure (flex-column three zones). `+` button + `addWorkspace()`. `.workspace-item` render in `renderProjectEntries`. Workspace-name dblclick rename via `startInlineRename`. `setActiveWorkspace(projectIndex, workspaceId, isStartup)` with maximize-restore, popout early-return, active-workspace persistence. Project-item click always routes to Primary. `.workspace-item` / `.workspace-right` / `.project-add-workspace` CSS. `.editing` selector extended.
- **Gate:** Playwright clicks `+` on scratch project A → asserts new `.workspace-item` sub-row, name in edit mode, `projects-dev.json` has a new workspace entry. Types "Dev", Enter → asserts sidebar label, `sessions.json` gains `workspaces.<id>` key. Spawns a terminal → asserts one session under that workspace key, primary `sessions` array untouched. Clicks project card → grid swaps back to Primary. Clicks "Dev" row → grid restores Dev. Kills app, relaunches → asserts `activeWorkspaceId` drives restoration. Rename "Dev" to "PR reviews", empty-name no-op, paste safety.
- Effort: M (~180 LOC).

### - [ ] Phase 4 — Per-workspace alerts + delete
- Deliverables: `updateSidebarActivity` rebuckets by `(projectKey, workspaceId)`. Project badge = Primary only; workspace badge = own workspace only. `clearProjectAttention(projectKey, workspaceId)` signature change and caller updates. Workspace `×` + confirm + `deleteWorkspace()` (splice first, kill PTYs, delete key from blob, save, switch active to Primary if needed). `.workspace-badge.badge-working` / `.badge-attention` CSS rules.
- **Gate:** Playwright starts a long-running command in Dev, switches to Primary → asserts `.workspace-item[data-workspace-id=X] .workspace-badge.badge-working` class, project card badge has no working class. Waits `ACTIVITY_IDLE_MS` → asserts transition to `badge-attention`. Starts a command in Primary → asserts Primary badge lights independently. Deletes Dev via `×` + accept confirm (intercept `window.confirm`) → asserts workspace key gone from sessions.json, PTY child process count dropped (check via `tasklist` before/after or log scrape), sub-row removed, active back to Primary.
- Effort: M (~100 LOC).

### - [ ] Phase 5 — Drag-reorder + right-click guard
- Deliverables: Workspace drag handlers mirroring project drag at 1317–1359. `workspaceDragFromIndex` / `workspaceDragFromProjectPath` module-level. Project-item dragover/drop early-return when workspace drag is in flight. Workspace `contextmenu` preventDefault. `.dragging` / `.drag-over` CSS selectors extended.
- **Gate:** Playwright creates two workspaces, drags one above the other → asserts `workspaces` array order in `projects-dev.json` swapped and DOM order reflects it. Attempts cross-project drag → asserts both projects' `workspaces` arrays unchanged (functional, not cursor). Right-clicks a workspace row → asserts no default browser context menu surfaces (via `contextmenu` event intercept).
- Effort: S (~50 LOC).

### - [ ] Phase 6 — Polish + docs
- Deliverables: Visual touch-up on hover button placement, active highlighting, inset dimensions. Update CLAUDE.md with new sessions.json shape and `workspaces` field on projects.
- **Gate:** Manual visual pass + CLAUDE.md diff review (no automation needed for this phase — call it out in the /plan-tools:phases prompt so it doesn't try to automate docs).
- Effort: S (~30 LOC + docs).

**Setup for phased execution:**
- Create `C:\Users\mrichardson\.claude\projects\D--Repos-Claudes\scripts\verify-workspaces.mjs` following the sticky-notes script's structure (setup, teardown, pass/fail, launchApp, per-check blocks). Re-use `PROJECTS_FILE = ~/.claudes/projects-dev.json` and the scratch-project-dir pattern so production projects.json is never touched.
- After each green phase, auto-commit with the message shape `feat(workspaces): phase N — <slug>` (one commit per phase).
- On red, pause with the failing check's detail; do not advance.

## Alternatives considered

- **Per-workspace file shards** at `<project>/.claudes/workspaces/<id>.json` — rejected per user direction. Would have added 3 IPC handlers, a new subdirectory, and `mkdir`/unlink plumbing. The single-file shape chosen here keeps the file surface identical to today.
- **Session data embedded in `~/.claudes/projects.json`** — rejected. Would couple per-project session data with global app config, bloat the global file, and break the useful property that session data travels with the project folder.
- **Terminal tags / filter chips** — rejected upstream. Doesn't match the user's "basically like a sub-project" framing; separate canvases are the point.

## Open questions / deferrable

- Cross-project workspace moves (drag a workspace onto another project) — out of scope; drag is same-parent only.
- Moving a terminal from one workspace to another — out of scope; `workspaceId` is set at column spawn time.
- Pop-out windows for workspaces — out of scope; `poppedOut` stays at project level. Popouts are always Primary.
- Keyboard shortcuts for cycling workspaces — out of scope.
- Scroll-into-view when switching to an off-screen workspace row — nice-to-have, not in scope.
