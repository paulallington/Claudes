# Spawn Codex — Design

**Date:** 2026-07-12
**Status:** Approved (design), pending implementation plan

## Problem

The user has installed the `codex` CLI and wants to launch it from within Claudes,
in a column, alongside Claude sessions. This fundamentally sits outside the "Claudes"
concept, so Codex is intentionally **second-class**: no usage tracking, no pet, no
voice, no session detection. The bar is: it spawns, it persists, and the UI is not
broken or confusing.

## Key architectural insight

Spawning Codex needs **no new spawn machinery**. Throughout the codebase, a column
with `col.cmd` set is already the universal "this is not a Claude column"
discriminator:

- `isClaude: !col.cmd` gates headroom env binding (`renderer.js` ~4085, ~4546, ~723)
- session detection / voice are guarded by `!col.cmd` (~709, ~3748)
- persistence & respawn already flow through the `cmd` path (~1259, ~1263, ~4076)
- exit UI already says "Restart" vs "Respawn" and refreshes run configs for `cmd`
  columns (~4067, ~702)

`pty-server.js:429` spawns `cmd || CLAUDE_PATH`, with a shell fallback (~431) for
Windows `.cmd`/PATHEXT shims — so `codex` resolves the same way `npm`/`dotnet` do
for launch configs.

A Codex column is therefore an ordinary column spawned as:

```js
addColumn([], targetRow, { cmd: 'codex', title: 'Codex', cwd });
```

The existing launch-config columns (dotnet/node/python) already prove this rail
works end-to-end, including persistence and restore.

## Scope (MVP — "persisted terminal only")

**In scope**
- Spawn `codex` in a column with the correct cwd.
- Survives app restart (respawns `codex` via the existing `cmd` restore path).
- Kill / Respawn work (inherited from the `cmd` column path).
- Visually distinct so it doesn't look like a broken Claude column.
- Only offered when the `codex` CLI is actually on PATH.

**Explicitly out of scope**
- Voice / TTS, session detection, Codex-native resume — all cleanly *absent*
  (they branch on `col.cmd`, so no new gating code is needed).
- Usage tracking, pet, headroom.
- Any Codex configuration surface inside the app. Codex's own TUI owns its settings.

## Entry point — the Spawn dropdown

`index.html:291-292` already has:
- `#btn-add` — primary "+ Spawn Claude" button (unchanged; reads all spawn options).
- `#btn-add-options` — a chevron (▾) that currently toggles the spawn-options panel.

To avoid two adjacent chevrons, the existing chevron becomes a small **menu**
instead of a direct panel toggle:

```
▾  ┌─────────────────────┐
   │ Spawn Codex         │   ← only present when codex is on PATH
   ├─────────────────────┤
   │ Spawn options…      │   ← opens the existing spawn-options panel
   └─────────────────────┘
```

- "Spawn Codex" calls `addColumn([], row, { cmd: 'codex', title: 'Codex', cwd })`
  **directly, bypassing `buildSpawnArgs()` entirely** — no permission-mode, model,
  headroom, bare, MCP, endpoint, or custom-args flags are applied. This is the answer
  to "no confusing UI": the Claude spawn-options panel stays 100% Claude, and Codex
  simply never consults it.
- "Spawn options…" preserves access to the existing panel (one extra click vs today).
- The primary `#btn-add` button and its `+ Spawn · …` tag summary line remain
  Claude-only.

> **Open for spec review:** routing Codex through the existing chevron adds one click
> to reach the options panel. Acceptable tradeoff vs. a second caret. Flag if you'd
> rather keep chevron→options direct and place Codex elsewhere.

## PATH detection (gate the menu item)

Add a main-process check that resolves `codex` on PATH (mirrors the existing
`which claude` logic near `main.js:52`; `where codex` on Windows / `which codex`
elsewhere). Expose via an IPC handler (e.g. `config:hasCodex`), result cached for the
session. The renderer includes the "Spawn Codex" menu item **only when this returns
true**. If Codex isn't installed, the item is absent — no error surface, no broken
affordance.

## Visual distinction

A Codex column must not read as a broken Claude column. In the column header:
- Title defaults to **"Codex"** (via the `title` opt, same mechanism launch configs use).
- Show a small **Codex badge/text marker** in place of the Claude starburst icon.

This is the one spot needing deliberate UI work; everything else is inherited.
(No Codex brand asset is bundled — a neutral text/glyph badge is sufficient and avoids
trademark-asset questions. Exact glyph decided during implementation.)

## Git tab

Left **visible and unchanged** on Codex columns. It is project-relative and read-only;
with no Claude JSONL to auto-bind from, it falls back to the project root and shows the
project's current-branch git status. That is honest, not broken. Hiding tabs per-column
would be extra code for no real gain.

## What is NOT touched

- `buildSpawnArgs()`, the spawn-options panel, headroom, endpoint presets — unchanged.
- Voice, session sync, usage modal — unchanged (they already skip `cmd` columns).
- `config:saveProjects` managed-settings preservation — unchanged.
- Persistence shape — a Codex column persists as an existing `cmd` column entry
  (`{ cmd: 'codex', cmdArgs: [], cwd, ... }`); no schema change.

## Testing

- Pure/unit: PATH-detection helper (found / not-found → boolean), if extracted into a
  testable lib function.
- Behavioral (renderer): menu shows "Spawn Codex" only when `hasCodex` is true;
  selecting it calls `addColumn` with `cmd: 'codex'` and does **not** invoke
  `buildSpawnArgs`.
- Manual: spawn Codex, confirm it runs; restart app, confirm the column respawns
  `codex`; confirm no voice/headroom/session activity attaches to it.

## Risks

- **Low.** The feature rides an already-proven rail (`cmd` columns). The only genuinely
  new code is the dropdown menu, the PATH check, and the header badge.
- Windows PATH/`.cmd` shim resolution is already handled by the pty-server shell
  fallback, same as other launch configs.
