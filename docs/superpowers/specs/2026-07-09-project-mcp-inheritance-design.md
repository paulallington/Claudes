# Project-level MCP inheritance selection

**Date:** 2026-07-09
**Status:** Approved, ready for planning

## Problem

A colleague added per-automation-agent MCP server selection: each scheduled
automation agent can tick which MCP servers (discovered from the global
`~/.claude.json` + project scopes) it inherits and uses. There is no equivalent
control for a **project** as a whole. Interactive claude columns spawned under a
project either inherit *every* globally-configured MCP server or (via the
"Strip MCPs" toggle) none — there is no per-server project selection, and that
selection cannot flow to the windows spawned under the project.

## Goal

Let a user tick which MCP servers a **project** inherits from the global config.
That selection is the project's **base level**: it applies to **every window
spawned under the project**, and **automations inherit it** (an automation agent
can still override below it, per the existing per-agent picker).

## Non-goals

- Per-column (per-window) MCP selection UI. The selection is project-wide.
- Changing how automation agents override the project base (already built).
- Editing MCP server *definitions* — that stays in the existing `.mcp.json`
  CRUD editor and `~/.claude.json`.

## Existing building blocks (reused)

| Piece | Location | Role |
|-------|----------|------|
| `discoverProjectMcpServers(projectPath)` | `main.js:7059` | Merges user + project + `.mcp.json` scoped servers → `{name:{def,scope}}`. Project-generic. |
| `automations:discoverMcpServers` IPC | `main.js:5467` | Returns `{ servers:[{name,scope}], projectDefault }`. |
| `projectMcpDefaults[normalizedPath]` | `automations.json` | **The per-project selection store.** Already consulted by automation agents at `main.js:7509`. |
| `automations:setProjectMcpDefault` IPC | `main.js:5478` | Persists the project selection. Preload: `setProjectMcpDefault`. |
| `filterMcpDefs(available, names, extra)` | `lib/interactive-scheduled.js:134` | `{name:{def,scope}}` + names → real `{ mcpServers:{...} }`. Tested. |
| `resolveMcpSelection(agentSel, projDefault)` | `lib/interactive-scheduled.js:122` | Precedence resolver. Tested. |
| Automation tickbox UI | `renderer.js:15859` (build), `16399` (read-back) | Visual + null-vs-explicit reference pattern. |
| `.mcp.json` "Manage MCP servers" modal | `#mcp-modal` `index.html:1235`; `openMcpModal` `renderer.js:19400` | Where the new checklist lives. |
| Interactive spawn args | `renderer.js:10724` (`buildSpawnArgs`, strip-all only) | Where the scoped flags get appended. |

**Selection convention (preserved everywhere):**
`null`/absent = inherit ALL discovered servers · `[]` = none · `["a","b"]` = explicit allowlist.

## Design

### 1. Storage — reuse `projectMcpDefaults`

The project selection is stored in `projectMcpDefaults[normalizedPath]`
(automations.json), the same store automations already read. No new schema.
Path keys normalized with `.replace(/\\/g,'/')` (existing convention).

This unifies the model: one project-level selection is the base for both
spawned windows and automations. Automations keep their per-agent override via
the already-shipped `resolveMcpSelection(agent.mcpServers, projDefault)`.

### 2. UI — checklist inside the "Manage MCP servers" modal

Add a section at the **top** of `#mcp-modal`, above the existing `.mcp.json`
CRUD editor:

- Heading: *"Inherited MCP servers"* with hint *"Applies to every window and
  automation in this project. Unchecked = not loaded. Leave all checked to
  inherit every server."*
- Rendered with the existing `.automation-permissions` /
  `.automation-permission-option` styles for consistency with the automation
  picker. New scoped IDs (`mcp-inherit-*`), no clash with the CRUD editor's
  `mcp-*` IDs (audit for collisions during implementation).
- On `openMcpModal(projPath)`: call `discoverMcpServers(projPath)` (already
  returns `servers` + `projectDefault`). Build one checkbox per server, labelled
  `name (scope)`. Checked state: if `projectDefault` is `null` → all checked
  (inherit); else checked iff `name` is in the array.
- Carry a `data-had-selection` marker (same trick as the automation card) so
  "all checked, never touched" reads back as `null` (inherit), not a frozen
  explicit full list.
- Persist on change via `setProjectMcpDefault(projPath, selection)`. Read-back
  maps the checked set → `null` / `[]` / `[...]`.
- The `.mcp.json` CRUD editor is untouched below the new section.
- If no servers are discovered, show the same "all inherited" hint the
  automation UI uses — no checklist.

### 3. Spawn wiring — interactive columns honour the selection

New main-process IPC `mcp:buildProjectConfig(projectPath)`:

1. Read the project's selection via `resolveMcpSelection(null, projDefault)`
   (project has no agent-level layer, so agent arg is `null`).
2. If the resolved selection is `null` → return `{ inherit: true }` (no scoping;
   preserves today's inherit-all behaviour, no flags added).
3. Else → `filterMcpDefs(discoverProjectMcpServers(path), selection, null)` →
   write the scoped `{ mcpServers }` JSON to a temp file → return
   `{ mcpConfigPath, strict: true }`.

Renderer spawn path (the caller of `buildSpawnArgs`):

- If the per-column **"Strip MCPs" toggle is checked**, keep today's behaviour
  (`--strict-mcp-config --mcp-config {"mcpServers":{}}`) — the toggle overrides
  the project base to empty.
- Otherwise `await electronAPI.buildProjectMcpConfig(projPath)`; if it returns
  `{mcpConfigPath, strict}`, append `--mcp-config <path> --strict-mcp-config`.
  If `{inherit:true}`, append nothing.
- `buildSpawnArgs` (or its caller) becomes async to await the IPC. Persisted
  `cmdArgs` must **not** bake in the temp path (it is per-spawn); the flags are
  appended at spawn time only, mirroring how the automation temp config is kept
  out of persisted args.

Temp files:

- Written to a dedicated dir (e.g. `~/.claudes/mcp-tmp`, dev-suffixed to match
  the app's dev-file convention). `claude` reads `--mcp-config` once at startup,
  so the file only needs to exist at spawn.
- Boot-time sweep of stale files (mirrors the automation runs cleanup), plus
  best-effort cleanup. Directory `0700`, files `0600` where the OS supports it.

### 4. Testing

- Reuse the already-tested `filterMcpDefs` / `resolveMcpSelection`.
- Extract as pure, `npm`-tested helpers in `lib/`:
  - **Checkbox read-back**: `(checkedNames, allNames, hadSelection) → null | [] | [...]`.
  - **Project spawn-config resolution**: `(projDefault, discovered) → {inherit:true} | {mcpServers}` (the pure core of `mcp:buildProjectConfig`, minus file IO).
- Tests assert the convention boundaries: untouched-all-checked → `null`;
  none-checked → `[]`; subset → sorted explicit array; and that `{inherit:true}`
  adds no flags while an explicit selection yields a scoped config.

## Data flow

```
User ticks servers in "Manage MCP servers" modal
      │  setProjectMcpDefault(path, selection)
      ▼
projectMcpDefaults[path]  (automations.json)   ← single source of truth
      │
      ├── window spawn:  buildProjectMcpConfig(path)
      │                    → temp scoped config → --mcp-config --strict-mcp-config
      │
      └── automation run: resolveMcpSelection(agent.mcpServers, projDefault)
                            (unchanged; per-agent override still applies)
```

## Risks / notes

- **ID collision** in `#mcp-modal`: the CRUD editor already uses `mcp-*` IDs.
  New checklist IDs must be distinct (`mcp-inherit-*`) — audit before writing.
- **Async spawn path**: making the spawn build async must not race column
  restore or duplicate spawns; keep the await inside the single spawn choke
  point.
- **Strip-all interaction**: strip toggle wins over project base — documented,
  tested.
- **Discovered-server churn**: if a server later disappears from global config,
  a stale name in the selection is simply not matched by `filterMcpDefs` — no
  crash, it is dropped. Acceptable.
