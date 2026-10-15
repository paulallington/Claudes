# Codex watcher

A read-only popout that live-tails the Codex **plugin** jobs a Claude column launched
(`/codex:rescue` and similar), which otherwise show only as a spinner in Claude's own output.
Code: `lib/codex-watch-log.js`, `lib/codex-watch-jobs.js`, `lib/codex-watch-tail.js`,
`codex-watch.html`, the `codexwatch:` handlers.
Design: `docs/superpowers/specs/2026-07-27-codex-stream-popout-design.md`.

- Separate from **Hand off to Codex** (`handoffColumnToCodex`), which spawns an ordinary visible
  Codex column. Handed-off columns are out of scope.
- Jobs are attributed by Claude `sessionId` across **every** plugin state dir: a session that
  enters a worktree changes cwd, and the plugin keys its state dir by git repo root.
- **The state root is profile-aware and must stay that way.** The plugin resolves it from
  `CLAUDE_PLUGIN_DATA` (`scripts/lib/state.mjs`), which follows `CLAUDE_CONFIG_DIR`, so a column on
  a secondary profile logs under that profile's directory. `codexWatchStateRoot` goes through
  `claudeRootFor(columnProfileId)`, not `profile.env` directly (which would lose the coalescing of
  `null` to Primary). Hardcoding `~/.claude` would report zero jobs for every non-Primary column,
  indistinguishable from having no plugin installed.
- **The renderer never sends a path**, only `{ workspaceKey, jobId }`. `workspaceKey` is accepted
  only when it exactly matches a directory main itself enumerated, because the plugin state root
  lies outside `assertInsideAllowedRoots` and that boundary was deliberately not widened.
- Tailing is a byte-offset poll: 1s with a stream open, 3s for the badge, stopped when no watcher
  window is open. The offset and short-read arithmetic lives in `lib/codex-watch-tail.js` behind
  an injected `io` so it is unit-testable.
- UI appears **only when the column's session has jobs**. It is deliberately not gated on
  `hasCodex()`, which probes the CLI rather than the plugin: a CLI-only machine would otherwise get
  a permanently dead menu row.
