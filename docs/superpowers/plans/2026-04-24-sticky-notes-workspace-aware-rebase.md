# Make sticky-notes workspace-aware (upstream rebase follow-up)

## Why this doc exists

`feat/workspaces` and `feat/sticky-notes` are two independent PRs against upstream (`paulallington/Claudes`). They don't know about each other, so:

- Sticky notes today persist per-project (`<project>/.claudes/sticky-notes.json`) and render via `window.activeProjectKey`.
- Workspaces introduced sub-workspaces whose identity is `stateKey(projectPath, workspaceId)`.

Without a fix, every sub-workspace under a given project shows the **same** sticky-note overlay as Primary. That's the bug.

Keeping the two PRs independent is deliberate — mingling them would slow each one's review. The fix lands as part of **whichever PR rebases second** on upstream master. This doc captures the rebase work so it isn't forgotten.

## When this applies

Trigger this work when you're rebasing the second-landing PR. Two scenarios:

1. **`feat/workspaces` merges first.** When rebasing `feat/sticky-notes` on the new master, apply the changes below to sticky-notes' persistence + renderer.
2. **`feat/sticky-notes` merges first.** When rebasing `feat/workspaces` on the new master, apply the same changes as part of that rebase commit.

Either way the delta is the same ~30–50 LOC. A personal-release patch exists on `personal/main` under the commit message prefix `personal-only:` — the content is the reference implementation for this upstream rebase.

## What changes

### `main.js` (sticky-notes IPC)

Current shape:

```
ipcMain.handle('sticky-notes:load', (event, projectPath) => { … reads sticky-notes.json … })
ipcMain.handle('sticky-notes:save', (event, projectPath, notes) => scheduleWriteStickyNotes(projectPath, notes))
```

Target shape — add a second arg `workspaceId` to both, and key storage by it:

```
ipcMain.handle('sticky-notes:load', (event, projectPath, workspaceId) => …)
ipcMain.handle('sticky-notes:save', (event, projectPath, workspaceId, notes) => …)
```

Storage options (pick one — whichever ships on `personal/main` wins by convention):

- **(a) File-per-stateKey** — `<project>/.claudes/sticky-notes.json` for Primary (back-compat), `<project>/.claudes/sticky-notes-<workspaceId>.json` for sub-workspaces. Simplest migration; zero schema change for existing users.
- **(b) Blob-shape** — `{ notes: [...], workspaces: { "<id>": { notes: [...] } } }`, mirroring the sessions.json shape chosen in Phase 2 of the workspaces plan. More consistent, but needs an atomic-write upgrade and a legacy read path.

Recommendation: **(a)**. Sticky-notes writes are already atomic (tmp+rename at `writeStickyNotesAtomic`). Extending the path is a two-line change. Blob-shape is more work without a proportional benefit at this scale.

### `renderer.js` (sticky-notes renderer)

- Replace every `activeProjectKey` reference in the sticky-notes module with a `currentStickyKey()` helper that returns `stateKey(activeProjectKey, config.projects[config.activeProjectIndex]?.activeWorkspaceId)`.
- In `setActiveWorkspace(projectIndex, workspaceId, isStartup)` (renderer.js, in this branch), add a call to `__renderStickyNotesForActiveProject()` (or whatever the current entry point is named) after the container swap so sticky-notes re-render for the new workspace.
- The load/save IPC calls pass both the project path and the workspace id.

### Migration

Old users on sub-workspaces see an empty overlay on first load. Primary is unaffected (file path unchanged). No migration script needed — sticky-notes aren't load-bearing.

## Verification

Extend `scripts/verify-workspaces.mjs` Phase 3 or Phase 4 with a sticky-notes sub-block:

1. Seed a sticky note on Primary of project A. Switch to sub-workspace Dev. Assert: **zero** sticky notes visible (or a separate set).
2. Create a sticky note on Dev. Type text. Wait for flush debounce.
3. Switch back to Primary. Assert: only Primary's sticky note is visible, with its original text.
4. Inspect disk: `<project>/.claudes/sticky-notes.json` has the Primary note; `<project>/.claudes/sticky-notes-<devId>.json` has the Dev note.
5. Relaunch. Assert both files load into their respective workspaces.

The `verify-sticky-notes.mjs` script still covers Primary-only behavior and should still pass after the rebase.

## Risks

- **Dual-write on mixed load orders**: if the user opens the app, hovers sticky-notes while switching workspaces rapidly, the debounced write timer might persist the wrong set. Mitigation: scope the `pendingStickyNotes` Map key by stateKey too — already per-projectPath, just extend the key.
- **Popout windows**: popouts are Primary-only per the workspaces plan, so sticky-notes in a popout always see Primary's overlay. No extra work needed.

## Related

- Workspaces plan: `docs/superpowers/plans/2026-04-23-workspaces.md`
- Sticky-notes persistence lives at `main.js:706–737` (writeStickyNotesAtomic, scheduleWriteStickyNotes, flushPendingStickyNotes)
- Sticky-notes renderer entry: `window.__renderStickyNotesForActiveProject()`
