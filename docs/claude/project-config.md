# Project config and session files

## `~/.claudes/projects.json`

Dev runs (unpackaged) use `projects-dev.json`. Each project entry carries:

- `name`, `path`, `columnCount`, `poppedOut`, `popoutBounds`
- `workspaces: []`: array of `{ id, name, createdAt }` sub-workspaces (peers to Primary, rendered
  as indented sub-rows under the project card)
- `activeWorkspaceId: null | "<ws id>"`: the workspace the project last routed to; `null` means
  Primary

`config:saveProjects` has an empty-over-nonempty data-loss guard, and merges on-disk `voice`,
`terminal` and sync state back before persisting (`preserveManagedSettings`). Do not regress
either, or it clobbers settings the user just changed.

## `<project>/.claudes/sessions.json`

```json
{ "sessions": [ ... ], "workspaces": { "<ws id>": { "sessions": [ ... ] } } }
```

- Primary's columns live in the top-level `sessions` array. Each sub-workspace's columns live
  under `workspaces.<id>.sessions`.
- A file with only `{ "sessions": [...] }` is read as Primary with an implicit empty
  `workspaces: {}`. The first save writes the full shape.
- Writes are atomic (`atomicWriteJson` in `lib/config-io.js`: same-dir tmp, fsync, rename, with a
  `.bak` roll-aside and corrupt-file quarantine and recovery on read).

Per-column optional fields:

- `cwd`: the directory the column was spawned in. Omitted when equal to the project root. On
  restore, a value missing on disk falls back to the project root with a console warning
  (checked first with `electronAPI.pathExists`).
- `targetBranch`: detected by the Git tab from the last `gitBranch` value in the Claude CLI
  session JSONL. When set, the Git tab shows branch-relative read-only data (commits,
  ahead/behind, diff vs base) for `targetBranch` instead of the project root's checked-out branch.
  Stage, commit and push are disabled until the user checks out that branch. It is only a hint:
  `autoBindColumnTarget` re-derives it on focus.

## Claude sessions

Detected by scanning `~/.claude/projects/<path-key>/` for `.jsonl` files.
