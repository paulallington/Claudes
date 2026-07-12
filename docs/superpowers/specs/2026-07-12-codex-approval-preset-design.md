# Codex Approval Preset Selector — Design

**Date:** 2026-07-12
**Status:** Approved (design), pending implementation plan
**Builds on:** `2026-07-12-spawn-codex-design.md` (Spawn Codex, shipped to master)

## Problem

"Spawn Codex" currently launches `codex` with **no flags**, so the column starts in
whatever approval/sandbox level `~/.codex/config.toml` (or Codex's built-in default)
dictates — the app has no control over, or visibility into, the permission level a
Codex column runs at. Claude columns already expose a permission-mode selector; Codex
should have the equivalent.

## Codex's permission model (CLI 0.144.1)

Two **independent** axes plus a bypass flag (there is no single `--full-auto` preset in
this version):

- `-a, --ask-for-approval <APPROVAL_POLICY>` → `untrusted` | `on-request` | `never`
- `-s, --sandbox <SANDBOX_MODE>` → `read-only` | `workspace-write` | `danger-full-access`
- `--dangerously-bypass-approvals-and-sandbox` → skip all approvals AND sandbox

## Decision — one preset dropdown

A single **Approval** `<select>` (not two axes, not raw flags) mapping curated presets to
`-a`/`-s` combos. Mirrors Claude's single permission dropdown; minimal and hard to
misconfigure.

| Preset key | Label | Flags emitted |
|---|---|---|
| `read-only` | Read Only | `-a untrusted -s read-only` |
| `auto` | Auto | `-a on-request -s workspace-write` |
| `full-access` | Full Access | `-a never -s danger-full-access` |
| `yolo` | Yolo (bypass) | `--dangerously-bypass-approvals-and-sandbox` |
| `codex-default` | Codex default | *(no flags)* |

- **Default:** `auto` when a project has never set the preset. Deterministic and
  app-controlled regardless of `config.toml`, matches Codex's normal working mode
  (sandboxed workspace writes, model asks before risky commands).
- **Label wording:** keep "Yolo (bypass)" as-is (approved).

## Architecture

Rides the existing `cmd`-column rail — no new spawn machinery.

1. **Pure mapping** in `lib/codex-spawn.js`:
   - `CODEX_APPROVAL_PRESETS` — ordered list of `{ key, label }` (also the dropdown order).
   - `codexApprovalArgs(preset): string[]` — maps a preset key to its flags. Unknown /
     missing / `codex-default` → `[]` (Codex default). Pure, unit-tested.
   - `buildCodexSpawn(cwd, preset)` — now returns `{ args: codexApprovalArgs(preset),
     opts: { cmd: 'codex', cwd } }` (was always `args: []`). `preset` omitted/undefined
     behaves as `codex-default` → `[]`, so existing callers/tests that pass no preset
     still get `[]`.
2. **Flags land in `cmdArgs`** of the spawned column, so **respawn and restore already
   replay the chosen mode** via the existing `cmd`-column persistence path. No new
   per-column persistence needed.
3. **Per-project default** persisted in the project's `spawnOptions`, mirroring Claude's
   `permissionMode`:
   - New field `spawnOptions.codexApprovalMode` (string preset key). Absent → treated as
     `auto`.
   - Read in `loadSpawnOptions`, written in `saveSpawnOptions`, alongside the existing
     Claude fields. `config:saveProjects` managed-settings preservation is unaffected
     (this is a normal spawnOptions field, not a managed voice/terminal setting).

## UI

- An **Approval** `<select>` placed with the "+ Spawn Codex" button inside `#spawn-dropdown`,
  gated by the same `codex-hidden` class (shown only when `hasCodex()` resolves true) so
  it never appears on machines without Codex.
- The select's value initialises from `spawnOptions.codexApprovalMode` (default `auto`) and
  writes back on change (same `onSpawnOptionChanged`-style save the Claude options use, but
  it must NOT alter the Claude `+ Spawn · …` tag summary — Codex is separate).
- Clicking "+ Spawn Codex" reads the current select value and passes it as the `preset` to
  `buildCodexSpawn`.

## Badge honesty

The column "Codex" badge's tooltip names the active mode, e.g. `Codex CLI · Auto`, so the
running level is visible at a glance (matching how Claude columns surface their permission
mode). The preset label is derived from `CODEX_APPROVAL_PRESETS`.

## Windows sandbox caveat

Codex's OS-level sandbox is Seatbelt (macOS) / Landlock (Linux). On Windows the `-s`
sandbox modes may be no-ops or behave differently — "Read Only" may not hard-enforce.
The app passes the flag faithfully (behaviour is Codex's to define) and surfaces this via a
tooltip on the Approval select (e.g. "Sandbox enforcement depends on your OS; on Windows
Codex may not fully sandbox"). Not a blocker; just honest.

## What is NOT touched

- `buildSpawnArgs()`, the Claude permission-mode selector, headroom, endpoint presets —
  unchanged.
- The Spawn Codex button gating, the `col.cmd`-based "not Claude" behaviour — unchanged.
- No change to how a Codex column is restored/respawned beyond the flags already living in
  `cmdArgs`.

## Testing

- Pure/unit (`test/codex-spawn.test.js`, extend existing):
  - `codexApprovalArgs('read-only')` → `['-a','untrusted','-s','read-only']`
  - `codexApprovalArgs('auto')` → `['-a','on-request','-s','workspace-write']`
  - `codexApprovalArgs('full-access')` → `['-a','never','-s','danger-full-access']`
  - `codexApprovalArgs('yolo')` → `['--dangerously-bypass-approvals-and-sandbox']`
  - `codexApprovalArgs('codex-default')` / `codexApprovalArgs(undefined)` /
    `codexApprovalArgs('bogus')` → `[]`
  - `buildCodexSpawn('D:/p','auto')` → args reflect the auto flags; `buildCodexSpawn('D:/p')`
    (no preset) → `args: []` (back-compat).
  - `CODEX_APPROVAL_PRESETS` — exact keys and order.
- Manual: pick each preset, Spawn Codex, confirm the launched column's args match; restart
  app and confirm the column respawns with the same flags; confirm the per-project default
  persists across restarts.

## Risks

- **Low.** Pure mapping + one select + one persisted field, all riding shipped rails.
- Windows sandbox semantics are Codex's, not ours — surfaced via tooltip, not hidden.
