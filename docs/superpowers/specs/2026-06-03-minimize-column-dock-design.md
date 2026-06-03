# Minimise column → workspace dock

**Date:** 2026-06-03
**Status:** Approved (design)

## Problem

Columns can be closed (×) and maximised (□), but there is no way to temporarily
get a column out of the way while keeping its Claude/run session alive and
running. Users want to "minimise" a column so the remaining columns reclaim the
space, with the minimised column parked as a tab at the bottom of the workspace.

## Goal

Add a per-column **minimise** action that moves a live column into a **dock bar**
at the bottom of its workspace as a chip, freeing its space. Clicking the chip
restores the column to its original row/position with its session intact.

## UX

### Header button
- A third header button is added to every column header: **minimise**, rendered
  as a bottom-line SVG matching the existing maximise icon style.
- Button order, left → right: `[minimise] [maximise] [×]`.
- Tooltip: "Minimise".
- Present on all column types (Claude, diff, run). In popout windows too
  (the dock is per-state, so it works there automatically).

### Dock bar
- A thin bar pinned to the bottom of each workspace's columns container
  (`state.containerEl`). One dock per `(project, workspace)` state and per popout
  window.
- Hidden (not rendered / `display:none`) when the state has zero minimised
  columns; shown when ≥1.
- Contains one **chip** per minimised column, in minimise order (most-recent
  last). Each chip shows:
  - a minimise glyph (`▭`),
  - the column's title (custom title if set, else the same derived label the
    column header shows),
  - a small `×` to kill that session directly from the dock.
- **Chip body click** → restore the column.
- **Chip `×` click** → kill the column (dispose terminal + kill pty + remove
  chip + persist), with no confirmation (parity with the column header ×).
- Chips reflect **activity/attention state**: when a minimised column's session
  transitions to "waiting/attention" (e.g. Claude is waiting for input), the chip
  shows the same attention treatment columns use (pulse/dot). This prevents a
  backgrounded session that finishes from being invisible. Activity updates that
  currently target the column header must also update the chip when the column is
  minimised.

## Behaviour

### Minimise `minimizeColumn(id)`
1. If `id` is the currently maximised column, un-maximise first
   (`toggleMaximizeColumn(id)`).
2. Build a **snapshot** of the column (same serialisable shape used by the popout
   transfer / sessions entry): `ptyId` (= column id), `cols`, `rows`, `cwd`,
   `cwdSource`, `cmd`, `cmdArgs`, `env`, `sessionId`, `title`, `isDiff` — **plus**
   `minimizeOrigin: { rowId, index }` capturing the row id and the column's index
   within that row's `columnIds` at minimise time.
3. Soft-remove the column from the layout, keeping the pty alive: reuse the
   existing `disposeColumnLocalOnly(id)` path (removes the column element + its
   adjacent resize handle, reflows remaining siblings, collapses an emptied row,
   removes it from `state.columns`/`allColumns`/`row.columnIds`) — it does **not**
   kill the pty and does **not** rewrite sessions.
4. Append the snapshot to a per-state `state.minimized` list and render its chip
   in the dock; show the dock if it was hidden.
5. `persistSessions(projectKey, workspaceId)` so the minimised entry is saved.

### Restore `restoreMinimizedColumn(id)`
1. Look up the snapshot in `state.minimized`; remove it from that list.
2. Resolve the restore target with `resolveRestoreTarget(rows, origin)` (see
   Testable seam): if the origin row still exists, restore into that row at the
   clamped original index; otherwise create a new full-width row at the bottom.
3. Recreate the column via the existing `addColumn(cmdArgs, targetRow, opts)` path
   with `reattachPtyId: snapshot.ptyId` (and `sessionId`, `title`, `cmd`, `env`,
   `cwd`, `cwdSource`, `isDiff`, `workspaceId`, and an `insertIndex` for position).
   This reattaches the live pty (the same mechanism verified for popouts).
4. Remove the chip; hide the dock if now empty; `refitAll()`; focus the restored
   column; `persistSessions(...)`.

### Kill from dock
- Remove the snapshot from `state.minimized`, remove the chip, then kill the pty
  and dispose any retained resources for that id; hide the dock if empty; persist.
  (Since the column was soft-removed, this sends a `kill` for the pty id and
  clears any per-id state.)

## Persistence

- A minimised column is saved in `sessions.json` like a normal column entry, with
  two extra fields: `minimized: true` and `minimizeOrigin: { rowId, index }`.
- The save path (`persistSessions`) serialises `state.minimized` snapshots into
  the same `entries` array used for live columns, tagged `minimized:true`.
- On launch, `restoreSessions` recreates each saved column. Entries tagged
  `minimized:true` are created **live but minimised**: the column spawns/resumes
  as usual (so its pty runs), then is immediately minimised into the dock with its
  `minimizeOrigin` preserved. This matches today's behaviour where all saved
  sessions respawn on launch. (A future optimisation could make persisted chips
  lazy — respawn only on click — but that is out of scope for v1.)
- Row-id stability: `minimizeOrigin.rowId` references a row id from the saved
  layout; restore order must create rows before re-minimising columns so origins
  resolve. If a row id can't be matched, fall back to a new bottom row on restore.

## Architecture

### Testable seam — `lib/minimize-dock.js`
Pure, DOM-free functions with unit tests (mirrors `lib/row-layout.js`,
`lib/maximize-layout.js`):

- `resolveRestoreTarget(rows, origin)` where `rows` is `[{ id, columnIds: [] }]`
  and `origin` is `{ rowId, index }`. Returns:
  - `{ mode: 'existing', rowId, index }` when a row with `origin.rowId` exists,
    `index` clamped to `[0, columnIds.length]`;
  - `{ mode: 'new' }` when no matching row exists (origin row was removed) or
    `origin` is missing/malformed.

This isolates the only non-trivial decision (where a restored column goes) for
unit testing. All DOM manipulation, chip rendering, snapshotting, and
persistence wiring live in `renderer.js`.

### renderer.js
- `createColumnHeader`: add the minimise button + click → `minimizeColumn(id)`.
- New: `minimizeColumn(id)`, `restoreMinimizedColumn(id)`, dock render helpers
  (`ensureDockEl(state)`, `renderMinimizedChip(state, snapshot)`,
  `removeMinimizedChip(state, id)`), and `killMinimizedColumn(id)`.
- `state` shape gains `minimized: []` (array of snapshots) and the dock element is
  created lazily inside `state.containerEl`.
- Activity routing: where column activity/attention is set
  (`setColumnActivity` / `notifyAttentionNeeded`), also update the chip if the id
  is currently minimised.
- `refitAll`/layout iterations operate on live columns only (minimised columns are
  not in `state.columns`, so they are naturally skipped).

### styles.css
- Dock bar (bottom of `.project-columns`, themed for light/dark, background
  consistent with `#1a1a2e` dark theme), chip styling, minimise button styling to
  match `.col-maximize`, and the chip attention pulse.

## Scope (YAGNI for v1)
- No drag-to-reorder of chips.
- No drag chip → row, or drag column → dock.
- No collapse-in-place strip variant.
- No lazy/deferred restore of persisted chips (they restore live).

## Testing
- Unit: `lib/minimize-dock.js` `resolveRestoreTarget` — existing row (incl. index
  clamping), missing row → new, malformed origin → new.
- Manual / CDP verification in a dev instance: minimise a column (siblings expand,
  chip appears, dock shows), restore (column returns to origin row/index, session
  intact), kill-from-dock, persistence across restart, and behaviour in a popout
  window.
