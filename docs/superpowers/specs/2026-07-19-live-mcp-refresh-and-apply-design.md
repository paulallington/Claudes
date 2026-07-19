# Live MCP refresh & apply — design

**Date:** 2026-07-19
**Status:** Approved (brainstorm), pending spec review → plan

## Problem

Adding an MCP server while the Claudes app is running currently "falls into the
void" until the entire app is restarted. Concretely, a user ran `claude mcp add`
from inside a running Claude chat column and hit three compounding gaps:

1. **The running chat can't see the new server.** Its `claude` process loaded
   MCP config once, at spawn, via the app's `--mcp-config` / `--strict-mcp-config`
   args. The Claude CLI does not hot-reload MCP config mid-session; `/mcp` only
   shows/authenticates servers that were already loaded at startup.
2. **The "Manage MCP servers" modal doesn't surface the new server.** The modal
   re-reads `~/.claude.json` + `<project>/.mcp.json` fresh on every open
   (`discoverProjectMcpServers`, no cache), so it *should* appear on reopen — but
   a likely real bug prevents it: `claude mcp add`'s default **local** scope
   writes to `~/.claude.json` → `projects[<cwd>].mcpServers`. When that chat's
   cwd was a worktree or subdirectory, `discoverProjectMcpServers(projectRoot)`
   matches keys by exact-equality only, so a server keyed under a sub-path is
   never discovered.
3. **`--strict-mcp-config` is an allowlist.** Even once a server is visible and
   ticked, the column must be respawned with a config that includes it before the
   `claude` process will load it.

The coherent fix chains three links: **Refresh → tick → one-click Respawn-to-apply.**

## Hard constraint (not fixable in this app)

The Claude CLI loads MCP servers only at process startup. There is no in-session
hot-reload. Therefore applying an MCP change to a *running* column **requires
restarting that column's `claude` process**. The app already has a Respawn path
that restarts the pty with `--resume <sessionId>`, preserving the conversation —
so "restart the process" does **not** mean "reboot the app" or "lose the chat."
The design makes that respawn one click and conversation-preserving.

## Design

### 1. Refresh the inherited list (modal)

- Add a **Refresh** control (icon button beside the "Inherited MCP servers"
  header) in `openMcpModal`. It re-invokes `discoverMcpServers(projectPath)` and
  re-renders the inherited list + tick state in place, with no modal reopen.
- **Fix the discovery key-match at the source.** In `main.js`
  `discoverProjectMcpServers`, replace the exact-equality project-key match with a
  scope test that accepts `~/.claude.json` → `projects[<key>].mcpServers` when
  `<key>` equals the project root **or is nested under it**. This surfaces
  servers added as "local" scope from a worktree/subdir chat. Path comparison is
  `\`-vs-`/` normalized.
- Verify (during implementation) whether reopen-already-refreshes holds once the
  key-match is fixed; the Refresh button is valuable regardless (config can change
  out-of-band while the modal is open).

### 2. Apply ticked changes to live columns (one-click respawn)

- **Trigger:** The modal tracks whether the tick set changed while open. On
  Save/close, if the selection changed *and* there are eligible live columns in
  the project, show a **non-blocking banner** in the main window:
  > **MCP servers changed.** Respawn N columns to apply? **[Respawn]** [Dismiss]
- **Manual only.** Nothing auto-respawns. Respawn is user-triggered; Dismiss
  leaves columns untouched until the user respawns them.
- **Eligible / "affected" columns:** every live column in the project that is a
  real `claude` column — excluding custom `cmd` columns and columns spawned with
  "Strip MCPs". Simplification (approved): offer to respawn **all** eligible
  columns rather than diffing each column's spawn-time set.
- **Respawn mechanics:** reuse the existing `restartColumn` path (already
  respawns with `--resume <sessionId>`). The one addition: before respawn,
  re-fetch the project's scoped config via `mcp:buildProjectConfig` so the new
  `--mcp-config` / `--strict-mcp-config` reflects the updated tick set, and
  re-thread `hasMcp` on the column (keeps the Headroom `ENABLE_TOOL_SEARCH`
  gating correct — MCP-bearing columns must keep tool schemas inlined). After
  reconnect, `/mcp` shows the new servers.
- **Edges:** a column with no `sessionId` yet (fresh, unsent) simply spawns fresh
  with the new set — no resume. Respawn failures surface via the existing exit
  overlay.

### 3. Testable seams (lib/-first)

- **`lib/mcp-project.js`** — extract a pure `matchesProjectScope(configPathKey,
  projectRoot)` returning true when the key equals the root or is nested under it.
  Drive `discoverProjectMcpServers`'s project-scope match through it. Unit tests:
  root exact match, worktree sub-path match, sibling-dir **non**-match, and
  `\`-vs-`/` normalization.
- **Pure selector** `mcpChangeAffectedColumns({ columns, changed })` → count/ids
  of eligible live columns (real claude; excludes `cmd` and strip-MCPs). New small
  module or folded into `mcp-project.js`. Unit tests: mixed sets, no-change →
  empty, cmd/strip excluded.
- **Wiring** (Refresh button, banner, respawn-with-refreshed-config, main-side
  discovery change) follows the codebase norm — no Electron-level test.
- `npm test` stays green; new units add focused coverage.

## Out of scope

- Authoring new servers (any scope) from inside the modal — the "+" panel's
  existing project `.mcp.json` authoring is unchanged; this design is about
  *surfacing and applying* servers, not adding new authoring UI.
- Per-column MCP selection (columns inherit the project tick set).
- Any change to the Claude CLI's startup-only MCP loading (not ours to change).

## Success criteria

1. Add an MCP via `claude mcp add` (incl. from a worktree/subdir chat) → click
   Refresh in the modal → the server appears in the inherited list without an app
   restart.
2. Tick it, close the modal → banner offers to respawn N columns → click Respawn
   → affected columns reconnect with `--resume` (conversation intact) and `/mcp`
   in each shows the new server.
3. No app reboot required at any step. `npm test` green with new lib coverage.
