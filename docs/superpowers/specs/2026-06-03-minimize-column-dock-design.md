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

**Model: keep-alive (detach DOM, keep the column object live).** A minimised
column is NOT disposed. Its `colData` (terminal, pty, listeners, context-meter,
session-sync) stays registered in `allColumns` and `state.columns`, flagged
`col.minimized = true`; only its DOM element is detached from the row. This is
required for the chip attention pulse: ws output keeps flowing into the live
`col.terminal`, so activity/attention detection keeps running while minimised.

### Minimise `minimizeColumn(id)`
1. If `id` is the currently maximised column, un-maximise first
   (`toggleMaximizeColumn(id)`).
2. Record origin on the column: `col.minimizeOrigin = { rowId, index }` (the row
   id containing it and its index within that row's `columnIds`).
3. Detach from the layout WITHOUT disposing: set `col.minimized = true`; remove
   the column's adjacent resize handle and detach `col.element` from the row
   (keep the element + terminal in memory via `colData`); remove `id` from
   `row.columnIds`; reset remaining siblings' flex; `removeRowIfEmpty` if the row
   is now empty. Do NOT kill the pty, dispose the terminal, or delete the column
   from `allColumns`/`state.columns`; do NOT stop session-sync/context-meter.
4. Add `id` to a per-state `state.minimized` list (order = minimise order) and
   render its chip in the dock; show the dock if it was hidden.
5. Guard layout iterators that fit/measure (`refitAll` and similar) to skip
   columns with `col.minimized` (their elements are detached → zero-size).
6. `refitAll()`; `persistSessions(projectKey, workspaceId)`.

### Restore `restoreMinimizedColumn(id)`
1. Remove `id` from `state.minimized` and remove its chip.
2. Resolve the restore target with `resolveRestoreTarget(state.rows, col.minimizeOrigin)`
   (see Testable seam): `mode:'existing'` → the origin row (found by id);
   `mode:'new'` → create a new full-width row at the bottom (`addRowToProject`).
3. Re-insert the **existing** `col.element` by **appending** it to the target row
   (create a leading resize handle when the row already has visible columns,
   mirroring `addColumn`'s append logic); push `id` onto `row.columnIds`. (v1
   appends to the origin row; restoring to the exact in-row index is deferred —
   see Scope. The clamped `index` from `resolveRestoreTarget` is retained for that
   future enhancement.)
4. Clear `col.minimized` / `col.minimizeOrigin`; reset siblings' flex; hide the
   dock if now empty; `refitAll()`; `setFocusedColumn(id)`; `persistSessions(...)`.

No pty reattach is needed — the pty stayed bound to this window's socket and the
terminal stayed live, so restore is just a DOM re-attach + fit (no repaint flash).

### Kill from dock `killMinimizedColumn(id)`
- Remove `id` from `state.minimized` and remove the chip, then call the normal
  `removeColumn(id)` (kills the pty, disposes the terminal, clears per-id state;
  its row/handle cleanup is a no-op on the already-detached element). Hide the
  dock if empty; persist.

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
- `refitAll`/layout iterations must skip columns flagged `col.minimized` (they
  remain in `state.columns` under the keep-alive model but their elements are
  detached, so fitting them is wasteful/invalid).

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
