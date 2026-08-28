# Codex stream popout — design

**Date:** 2026-07-27
**Status:** Design approved, pending implementation plan

## Problem

Codex work launched *by Claude inside a column* is invisible. When Claude runs
`/codex:rescue`, `/plan-build-codex`, or `/full-codex-review`, the Codex plugin
spawns a job through its companion runtime and the only thing the user sees is a
spinner in Claude's own output. There is no way to tell whether Codex is making
progress, thrashing, or has gone idle without asking Claude to poll
`/codex:status`.

This is distinct from **"Hand off to Codex"** (`handoffColumnToCodex`,
renderer.js:7050), which writes a handoff doc and then calls `addColumn` with a
Codex CLI spawn. That produces an ordinary interactive column whose output is
already fully visible in the grid. Handed-off columns are explicitly **out of
scope** — they are not a hidden stream.

## What the plugin already writes

The codex plugin logs every job to disk, and does so incrementally:
`appendLogLine` / `appendLogBlock` use `fs.appendFileSync` on every progress
event (`scripts/lib/tracked-jobs.mjs`). Nothing is buffered until exit, so the
file is safe to tail live.

Log path:

```
<state-root>/<repo-slug>-<sha256(realpath(repo-root))[0:16]>/jobs/task-<id>.log
```

`<state-root>` is **not** a fixed path. `scripts/lib/state.mjs` resolves it from
the `CLAUDE_PLUGIN_DATA` environment variable that Claude Code sets for the
plugin, falling back to `<tmpdir>/codex-companion` when that is absent. In
practice Claude Code derives it from the session's config directory, so for a
Primary session it is:

```
~/.claude/plugins/data/codex-openai-codex/state
```

This interacts directly with **multi-subscription profiles**. A column running
under a secondary profile has `CLAUDE_CONFIG_DIR=~/.claudes/profiles/pf_*`, so
its Codex jobs are written under *that* profile's directory instead. Hardcoding
the Primary path would show zero jobs for every non-Primary column — silently,
since "no jobs" is also the legitimate no-plugin state. See §2 for how the root
is resolved per column.

The directory key is the **git repo root** of the session's cwd
(`resolveWorkspaceRoot` → `ensureGitRepository`), not the project root.

Log content is genuinely useful: thread and turn ids, every shell command Codex
runs with its exit code, assistant messages as they are captured, and the final
report.

Two behaviours of the plugin that the design must accommodate:

- **Session attribution is available.** The plugin's `SessionStart` hook sets
  `CODEX_COMPANION_SESSION_ID` to Claude Code's own `session_id`, and every job
  record in `state.json` carries that `sessionId`. Columns already track their
  Claude session id as `col.sessionId`, and it is the same id space.
- **`SessionEnd` deletes job records** from `state.json` and kills anything
  still running — but it leaves the `.log` files on disk. Records are therefore
  reliable only for the lifetime of the session, which is exactly the window
  this feature cares about.
- **`EnterWorktree` moves a session's cwd mid-run**, so a single column's jobs
  can land in more than one state directory.

## Scope decisions

| Decision | Choice |
|---|---|
| What is surfaced | Plugin jobs only. Not handed-off Codex columns, not ad-hoc `codex exec` log redirects. |
| Attribution | By `sessionId`, scanning **all** state directories — survives a column moving into a worktree. |
| Layout | One window per column; job list plus tabs, not one window per job. |
| Entry point | Overflow-menu row plus a live-count badge on the column header. Never auto-opens, never steals focus. |
| Rendering | Parsed, styled event rows (not a raw monospace tail). |
| Interactivity | Read-only. No cancel control — `/codex:cancel` already exists. |

## 1. User-facing behaviour

A **"Watch Codex"** row in the column overflow menu, directly under "Hand off to
Codex" and gated to Claude-chrome columns the same way.

**Visibility rule:** the row is added only when the column's session has at
least one known job. It is never rendered in a disabled state.

This single condition subsumes every "Codex isn't here" case — no codex CLI, no
codex plugin, plugin installed but never used, column with no detected session
id — all yield zero jobs and therefore no row. It also matches the codebase's
existing convention of *conditionally adding* overflow rows rather than
rendering them disabled (see the `Teleport to claude.ai` row,
renderer.js:6997).

Note that `hasCodex()` (main.js:7051), which gates every other Codex affordance
via the `codex-hidden` class, is deliberately **not** used here. It probes for
the codex *CLI binary*; this feature depends on the codex *Claude Code plugin*,
a separate install. Gating on `hasCodex()` would leave a permanently dead row on
a machine that has the CLI but has never used the plugin, and could conversely
hide the row while jobs are genuinely streaming if the app's PATH probe
disagrees with the shell PATH inside a column.

The column header gains a small badge showing the live job count whenever that
session has running jobs, and is absent otherwise. Clicking it opens the same
window.

The window is **one per column** — re-opening focuses the existing one — and is
titled `Codex · <column title>`. Left is the job list (title, status dot,
elapsed); right is the parsed event stream. The stream autoscrolls unless the
user has scrolled up, in which case a "jump to latest" affordance appears.
Finished jobs from the current session remain listed so a completed run can be
read back.

Per the project's UI conventions, any new toggled element gets its own scoped
class — there is no generic `.hidden` in `styles.css` to reuse.

## 2. Architecture and data flow

The main process owns all filesystem access. A new `codexwatch:` IPC family is
the only route in.

### Resolving the state root (profile-aware)

The state root is derived in main, never supplied by the renderer:

1. Resolve the column's profile through the existing `profile:resolve` entry
   point (`lib/profile-resolve.js`), which already runs the
   column → workspace → project → global-default cascade.
2. Take that profile's Claude root — `profileClaudeRoot` for a secondary,
   `~/.claude` for Primary, which sets no env var at all.
3. Append `plugins/data/codex-openai-codex/state`.

Because the watcher is per column, this yields exactly one root per window. The
background badge poll scans the **union of distinct roots** across open columns,
which for a single-subscription user is one directory.

A root that does not exist simply yields no jobs — the same outcome as a machine
without the plugin, and handled by the same code path. The
`<tmpdir>/codex-companion` fallback that the plugin uses when
`CLAUDE_PLUGIN_DATA` is unset is deliberately **not** searched: it only occurs
when the plugin runs outside a Claude Code session, which is not a case this
feature covers, and probing a shared temp directory for job state is a poor
trade against the small benefit.

**The renderer never sends a path.** This matters because the plugin state root
sits outside the app's allowed roots, so `fs:startWatch` and the file-read IPC
will correctly refuse it via `assertInsideAllowedRoots`. Widening those roots to
accommodate this feature is explicitly rejected — it would weaken a deliberate
security boundary for a read-only convenience.

- `codexwatch:listJobs({ sessionId })` — scans `<root>/*/state.json`, keeps jobs
  whose `sessionId` matches, and returns sanitised descriptors (`id`,
  `workspaceKey`, `title`, `status`, `phase`, timestamps). No paths returned.
- `codexwatch:openStream({ workspaceKey, jobId })` — `workspaceKey` is validated
  by exact match against the directory names found in the scan, making traversal
  structurally impossible rather than filtered. Main resolves the log path
  itself and returns a tail of recent content plus a byte offset.
- `codexwatch:closeStream({ workspaceKey, jobId })`.
- Pushed events: `codexwatch:jobs` (list changed) and `codexwatch:delta` (new
  log content).

### Polling

A **slow background poll (~3s)** drives badge and row visibility. Its first
action each tick is an `existsSync` per resolved root, bailing immediately on
any that are absent — so on a single-subscription machine without the plugin the
entire ongoing cost is one stat every 3 seconds. Checking existence every tick
rather than caching it at startup
means the feature self-heals when the user installs the plugin or runs their
first job after the app launched, instead of staying dark until restart.

While at least one watcher window is open the cadence steps up to **1s**: re-scan
the state files for status changes, `fs.stat` each open log, and read only the
delta on growth.

Polling was chosen over `fs.watch` deliberately — one mechanism instead of two,
no per-platform file-watching quirks (the existing `fs:startWatch` already has
to fall back from recursive mode, main.js:2558), and 1s latency is imperceptible
for a human watcher.

### The window

`codex-watch.html` plus a small `codex-watch.js`, sharing `preload.js` and
receiving the same `lockdownWebContents()` and CSP treatment as project popouts.
A dedicated page rather than another `index.html` mode: the existing popout
loads the entire app shell via `{ mode: 'popout', projectKey }` (main.js:1225),
which would mean booting the sidebar, xterm and every panel to render a log
viewer, and would add more startup branching to a 19.9k-line `renderer.js`.

Bounds: a single remembered rectangle stored as a top-level `codexWatchBounds`
key in `projects.json` — shared by all watcher windows rather than per column,
and cascaded by a small offset for each additional window. Written from main on
a debounced move/resize handler, mirroring `popoutBounds` (main.js:1281). It
must be written through the same read-modify-write path that `popoutBounds`
uses, so it cannot interact with the `preserveManagedSettings` guard in
`config:saveProjects`.

## 3. Testable core (`lib/`)

Two pure UMD modules, following the project's convention of extracting logic out
of `main.js` / `renderer.js` so it can be tested outside Electron.

**`lib/codex-watch-jobs.js`**
- `selectSessionJobs(scans, sessionId)` — filters to the session's jobs and
  orders them (running first, then newest), deriving `elapsedMs`.
- `summariseCounts(jobs)` — running/total counts for the header badge.

**`lib/codex-watch-log.js`**
- `parseLogChunk(carry, chunk)` → `{ events, carry }`. Classifies `[ISO] …`
  lines into `status | command | command-result | assistant | error`, extracts
  exit codes, and flags commands the plugin itself truncated. A partial trailing
  line is held in `carry` so a chunk boundary landing mid-line or mid-block
  cannot corrupt the view.

## 4. Error handling

| Condition | Behaviour |
|---|---|
| State root missing (plugin not installed) | No row, no badge, no work beyond one `existsSync` per root per slow tick. |
| Column runs under a secondary subscription profile | Root resolved from that profile's Claude root, so its jobs are found. A Primary-hardcoded root would show zero jobs indistinguishably from "no plugin" — this is the failure mode §2 exists to prevent. |
| Torn / corrupt `state.json` | Catch per file, skip that directory for the tick, keep the last good list. The companion writes non-atomically, so this **will** occur. |
| Log truncated or rotated (size < offset) | Reset offset to 0 and reload the file. |
| Job vanishes from `state.json` (`SessionEnd` cleanup) | Keep the tab, mark it ended, retain content, stop tailing. |
| Column has no detected session id | No row (covered by the zero-jobs rule). |
| Column killed while window open | Window stays open and read-only; content is preserved. |

## 5. Testing

`lib/` tests via `node --test`, using fixtures captured from real job logs
already on disk (path-sanitised). Coverage targets what actually breaks: chunk
splits landing mid-line and mid-block, corrupt state files, session filtering
across multiple state directories, and elapsed derivation.

**The suite cannot verify this feature works.** A green run proves the parser is
sound and says nothing about the window — this is precisely the trap CLAUDE.md
documents ("A green test suite is not a working program"). Acceptance is driving
the real app:

1. Run `/codex:rescue` from a Claude column; confirm the header badge appears.
2. Open "Watch Codex"; confirm the stream renders live and autoscrolls.
3. Start a second concurrent job; confirm both tab correctly and independently.
4. Let a job finish; confirm it remains readable in the list.
5. Confirm no Codex UI appears at all on a profile with no plugin state root.
6. If a secondary subscription profile is configured, run a job from a column
   assigned to it and confirm the jobs are found under that profile's root.

## Out of scope

- Handed-off Codex columns (already visible as columns).
- Ad-hoc `codex exec` redirects such as `/full-codex-review`'s
  `/tmp/codex-review.log` — a skill-local convention, not a stable contract.
- Cancelling or interacting with a job from the window.
- A global, app-wide Codex activity viewer across all repos.
