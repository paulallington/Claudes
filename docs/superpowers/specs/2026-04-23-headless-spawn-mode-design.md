# Headless Spawn Mode

A way to fire one-off `claude --print` runs from the app without allocating a terminal column. Output streams into a new bottom dock, and the OS notifies when runs finish. Reuses the automation runner's spawn/parse plumbing.

## Problem

Today, spawning in Claudes always produces an interactive terminal column. For quick ad-hoc prompts ("summarise this diff", "explain this config", "check whether X is wired up") the interactive terminal is overkill — the user wants to fire a prompt, do something else, and read the answer when it lands. The automation runner already spawns headless `claude --print` processes for scheduled agents (`main.js:2678`), but that capability isn't exposed for ad-hoc use.

## Requirements

- User can launch a headless run from the spawn dropdown via a transient "Headless" checkbox.
- Output streams into a bottom dock, not a terminal column.
- A floating chip in the bottom-right of the app chrome shows live run state and toggles the dock.
- Runs are project-scoped — the dock shows only the currently active project's runs.
- Runs persist across app restarts; the most recent 100 per project are kept.
- OS notification fires when a run completes (success, error, or cancelled). Clicking the notification focuses the app and opens the dock on that run.
- User can cancel an in-flight run and delete completed runs.
- Concurrent runs are unlimited — each is an independent child process.
- The existing `runAgent()` spawn/stream logic is refactored once to share a `spawnHeadlessClaude()` helper with the new runner; no broader automation changes.

## Architecture

Headless runs reuse the existing `runAgent()` plumbing from `main.js:2678` — spawn `claude --print --output-format stream-json --verbose`, parse events, stream text via IPC. The shared core (spawn + stream-json parse loop) is extracted into `spawnHeadlessClaude(prompt, cwd, opts)` and used by both `runAgent()` and a new `runHeadless(projectId, prompt)` function.

Differences from automation agents:

- No schedule, no pipeline, no upstream context — a run is just `{ prompt, cwd, projectId }`.
- No structured summary / attention-items parsing. The full streamed text is the result.
- Stored per-project, not in the global automations file.
- Lifecycle is standalone — start, stream, complete/error/cancelled. No dependents to trigger.

## UI Components

### Chip

A small pill in the bottom-right corner of the app chrome. Floats above content (absolutely positioned), anchored to the window. States:

- **No runs for current project** — hidden.
- **Running** — spinner + count (e.g. `⟳ 2 running`).
- **Done with unseen results** — badge colour shift + count with a "new" indicator (e.g. `● 3 · 1 new`). "New" means completed since the dock was last opened; opening the dock clears it.
- Click toggles the dock.

### Dock

Slides up from the bottom of the window to ~40% of window height. Resizable by drag handle. Two-pane layout:

- **Top strip** — "New run" input: a textarea (grows up to ~6 lines) + "Run" button. Enter submits, Shift+Enter newline. Submitting clears the textarea, creates a new run, and auto-selects it.
- **Left pane** (~30% width) — run list. Each row: title (first non-empty line of prompt, truncated ~80 chars) + relative timestamp + status icon (running / done / error / cancelled / interrupted). Newest at top. Clicking selects.
- **Right pane** (~70% width) — detail for selected run. Header strip: full prompt (collapsed by default, expand to see), started-at, duration, status, "Cancel" button (if running), "Delete" button. Body: streamed output in monospace, auto-scrolls to bottom while running. "Copy all" button.

### Spawn dropdown integration

A "Headless" checkbox added next to the existing spawn options. When checked and the user clicks spawn, the dock opens focused on the input instead of spawning a column. The checkbox state is **not** persisted to `spawnOptions` — it's transient per-click, so users don't accidentally lock themselves out of spawning columns.

## Execution & Data Flow

### Kickoff

1. User types prompt in dock input, clicks Run (or presses Enter).
2. Renderer sends `headless:run` IPC with `{ projectId, prompt }`.
3. Main process generates a `runId` (uuid), reads the project's spawn defaults (model, skip-permissions, bare, etc.) from `projects.json` — same config source as the interactive spawn dropdown.
4. Writes a new run record to `<project>/.claudes/headless-runs.json` with `status: 'running'`, `startedAt`, `prompt`, `title`.
5. Calls `spawnHeadlessClaude(prompt, cwd, opts)`. Child process is tracked in an in-memory `runningHeadless: Map<runId, ChildProcess>`.

### Streaming

The shared parser extracts text from `stream-json` events (`assistant` message content, `content_block_delta`, `result`) — identical to the existing `runAgent()` stdout handler. Extracted text is:

- Appended to an in-memory buffer for that run.
- Appended to the run's on-disk output file (`<project>/.claudes/headless-runs/<runId>.txt`) as it streams.
- Fired as `headless:output` IPC `{ projectId, runId, chunk }` to the renderer.

The renderer appends to the detail pane if that run is selected; otherwise just increments the chip badge.

### Completion

On child `close`:

1. Output file on disk is already up to date from streaming.
2. Update the index entry: `status` ← `completed` | `error` | `cancelled`, `completedAt`, `exitCode`, `durationMs`.
3. Fire `headless:completed` IPC. Renderer updates the run's list row, updates chip badge with "new" indicator if dock is closed.
4. Main fires OS notification via Electron's `Notification` API: title `Headless run completed` (or `failed` / `cancelled`), body the run's title. Clicking the notification focuses the main window and opens the dock on that run.

### Cancellation

Renderer sends `headless:cancel { runId }`. Main looks up the child in `runningHeadless`, calls `child.kill()`. The close handler runs normally and flags the run `cancelled`.

## Data Model

### File layout

Per project:

```
<project>/.claudes/
  headless-runs.json           — index
  headless-runs/<runId>.txt    — full streamed output for each run
```

### Index entry shape

```json
{
  "runId": "uuid",
  "title": "First line of prompt, truncated to ~80 chars",
  "prompt": "Full prompt text",
  "status": "running" | "completed" | "error" | "cancelled" | "interrupted",
  "startedAt": "ISO-8601",
  "completedAt": "ISO-8601 | null",
  "durationMs": 12345,
  "exitCode": 0
}
```

`title` is derived once at creation from the prompt's first non-empty line, truncated to ~80 chars. Not editable.

### Retention

The index is capped at the 100 most recent runs per project. When a run is evicted, its `.txt` file is deleted too. User can manually delete any run via the dock's per-row delete button (removes both the index entry and the file).

## Crash Recovery

On app start, for each project the main process reads `headless-runs.json` and reconciles: any run with `status: 'running'` is flipped to `status: 'interrupted'` with `completedAt` set to now. Child processes die with the parent, so there is nothing to resume — this step just avoids stuck "running" entries. `interrupted` renders in the dock list with its own icon/colour.

## Error Handling

- **Missing/invalid `cwd`** — fail fast before spawn; mark run `error` with message `Working directory not found: <path>`. No child process spawned.
- **Claude CLI missing / spawn fails** — caught by spawn's `error` event, same `error` terminal state.
- **Index JSON write failures** — logged to main process stderr; do not take down the run. The output file on disk is the source of truth for streamed text; index is a best-effort summary.
- **Stream-json parse errors on individual lines** — already handled in the existing runner with `try/catch` + `continue`. The extracted helper keeps this behaviour.

## IPC Channels (new)

Renderer → main:
- `headless:list { projectId }` → returns index for project
- `headless:get { projectId, runId }` → returns full output text + index entry
- `headless:run { projectId, prompt }` → starts a new run, returns `runId`
- `headless:cancel { runId }`
- `headless:delete { projectId, runId }`

Main → renderer:
- `headless:started { projectId, runId, ...entry }`
- `headless:output { projectId, runId, chunk }`
- `headless:completed { projectId, runId, status, exitCode, completedAt, durationMs }`

## Testing

The codebase is light on automated tests. Testing here is pragmatic and manual-heavy, matching the existing style.

### Manual smoke tests (pre-ship checklist)

1. Kick off a simple headless run ("say hi") → confirms it streams into the dock, completes, fires OS notification.
2. Kick off 3 concurrent runs → confirms chip count tracks correctly and all three stream independently.
3. Cancel a run mid-stream → confirms `cancelled` status and that the child process is actually killed (check Task Manager / `ps`).
4. Quit the app with a run in flight, relaunch → confirms the run shows as `interrupted`.
5. Spam >100 runs → confirms the index cap and `.txt` file cleanup kick in.
6. Rename the project folder and kick off a run → confirms `error` status with a clear message.
7. Switch projects while a run is in flight → dock empties of other project's runs; running run continues in the background; switch back to see it.

### Unit tests (if a minimal harness is added)

Using Node's built-in `node:test`, the pure pieces worth covering:

- Title derivation (first-line truncation, whitespace handling, empty prompt).
- Index eviction (cap at 100, oldest first, `.txt` cleanup on evict).
- Stream-json event parsing in the extracted helper (malformed lines, partial chunks, all three event shapes).

A test harness is added only if the extracted `spawnHeadlessClaude` helper picks up meaningful logic beyond "spawn child, pipe stdout." Otherwise the manual pass suffices for this iteration.

## Key Files to Modify

- **main.js** — extract `spawnHeadlessClaude(prompt, cwd, opts)` from `runAgent()`; add `runHeadless()`, IPC handlers for `headless:*` channels, crash-recovery on startup, OS notification on completion.
- **renderer.js** — add dock component (resizable two-pane), chip component, "Headless" checkbox wiring in the spawn dropdown, IPC listeners.
- **index.html** — dock and chip DOM scaffolding.
- **styles.css** — dock, chip, status icons. Background consistency with `#1a1a2e`.
- **preload.js** — expose new `headless:*` IPC methods.

## Not in Scope

- Prompt templates / saved named prompts — deferred; add if repeat-run patterns emerge.
- Per-run config overrides (different model / flags per run) — runs inherit the project's spawn defaults.
- Global (cross-project) view of headless runs — project-scoped only.
- Resuming an interrupted run — child processes die with the parent; no persistence of in-flight state.
- Structured result parsing (summary, attention items) — the output text is the result.
- Concurrency caps or queueing — each run is an independent child process.
