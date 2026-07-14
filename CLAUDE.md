# Claudes

Multi-column Claude Code terminal desktop app built with Electron. Also spawns Codex CLI columns and arbitrary commands.

## Architecture

Electron main process spawns `pty-server.js` as a **child process under system Node.js** (not Electron's bundled Node). This is critical — node-pty's prebuilt binaries only work with system Node, and electron-rebuild fails on this system. Never try to load node-pty directly in Electron's process.

Communication: Electron renderer <-> WebSocket <-> pty-server.js <-> node-pty <-> Claude/Codex CLI

- **The WebSocket is authenticated.** main mints a per-launch 256-bit token and passes it to pty-server via env; the renderer presents it as the `Sec-WebSocket-Protocol` subprotocol on the handshake. `handleProtocols` rejects any connection with a missing/wrong token, closing the drive-by-RCE hole (any local page could otherwise `new WebSocket('ws://127.0.0.1:<port>')` and spawn processes). Do not regress this.
- **pty-server patches node-pty at runtime** (top of `pty-server.js`): it `chmod +x`'s the `spawn-helper` prebuild and rewrites `unixTerminal.js`'s asar-unpacked path. Pragmatic but string-fragile — it silently breaks if node-pty changes those internals, and mutating installed files will fight code signing if macOS builds are ever signed.

## Key Files

- `main.js` — Electron main process (large, ~8.6k lines): window management + ~40 IPC handler families (config, sessions, file explorer, git, CLAUDE.md editor, headroom, codex, automations, endpoints, headless, mcp, usage, hooks, layouts, popout, …), plus the macOS auto-updater.
- `pty-server.js` — Standalone WebSocket server + node-pty. Runs under system Node.js. Accepts a `cmd` param to spawn arbitrary processes (not just Claude), gated by the handshake token above.
- `preload.js` — Context bridge exposing IPC to renderer (~250 flat methods).
- `renderer.js` — All frontend logic (very large, ~19.9k lines): project management, row/column layout, xterm terminals, spawn options, explorer panel, CLAUDE.md modal, and every panel below.
- `index.html` — App shell with sidebar, explorer panel, toolbar, modals.
- `styles.css` — Dark theme.
- `platform-detect.js` — Tiny shared platform helper.
- `lib/*.js` — **Pure, `npm`-tested modules** — the project's main strategy for making logic testable outside Electron. When adding non-trivial logic, extract the pure core into `lib/` with a test rather than growing main.js/renderer.js. Most use a UMD pattern (module.exports for Node/tests + `window.*` for the sandboxed renderer, which cannot `require()`).

## Build & Run

```bash
npm install    # No postinstall/electron-rebuild needed
npm start      # Launches Electron app
npm test       # node --test over test/*.test.js (pure lib/ coverage)
```

Note: `npm test` is **not** run by `release.sh` or CI today — see EVALUATION-TASKS.md.

## Subsystems

Each has a design/spec under `docs/superpowers/specs/` (and often a plan under `plans/`); the testable core lives in `lib/`.

- **Headroom** (`lib/headroom-env.js`, `lib/headroom-watchdog.js`, `headroom:` handlers) — an app-managed local proxy that Claude columns route through for rate-limit headroom. Binding is env-only: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (default 8787) + `ENABLE_TOOL_SEARCH=true` (**omitted when the column has MCP servers** — Headroom's `tool_search_deferral` optimizer swallows deferred `mcp__*` tools into a manifest the CLI's `tool_search_tool_regex` can't load, so MCP-bearing columns keep tool schemas inlined; `buildHeadroomEnv` gates the flag on `hasMcp`, threaded from `resolveProjectMcpSpawn` and persisted on the column for respawns) + optional `ANTHROPIC_MODEL=<model>[1m]` to re-activate the 1M window (a custom base URL otherwise caps at 200k). Proxy spawned as `headroom proxy --port <p> --no-http2 [--memory] [--mode cache|token | --no-optimize]`; `--no-http2` is mandatory (shared-connection HTTP/2 corrupts TLS under the frequent stream cancels of multi-column use). Mode is start-time only — restart the proxy to change it; `cache` is the subscription-safe default. main probes the `headroom` binary at startup, can auto-start/auto-update it, and a health watchdog auto-restarts a frozen ("up but silent") proxy **it owns and started**. "API error · Retrying" in a column is a real upstream 429/5xx relayed through the proxy, not an app bug; proxy logs live in `~/.headroom/logs/proxy.log`.
- **Codex columns** (`lib/codex-spawn.js`, `lib/codex-limits.js`, `codex:`/`spawn` paths) — spawn the Codex CLI as a column. Approval presets map to Codex flags (`-a` approval, `-s` sandbox, plus a bypass flag). **Codex runs direct, never through Headroom** — ChatGPT-subscription Codex ignores `OPENAI_BASE_URL`, so Headroom stays Claude-only. Codex has no usage endpoint; usage is scraped from `rate_limits` in the `~/.codex/sessions` rollout JSONL.
- **Automations / Manager mode** (`automations:` handlers, `docs/ideas/manager-mode.md`) — scheduled/collaborative agent runs, incl. a manager agent that clones and coordinates worker agents. Clone paths are sanitised per-segment inside a base dir (an escape here once enabled arbitrary dir deletion).
- **Endpoints / per-agent connections** (`endpoint:` handlers) — custom API base URLs/tokens per column. Tokens are `safeStorage`-encrypted and never returned to the renderer.
- **Headless spawn mode** (`lib/headless-helpers.js`, `headless:` handlers) — run a prompt against a project without an interactive column.
- **MCP project inheritance** (`lib/mcp-project.js`, `mcp:` handlers) — projects can inherit/override MCP server config.
- **Scheduled / interactive sessions** (`lib/interactive-scheduled.js`) — cron-style loops and interactive scheduled runs.

## Releasing

Use the `/release` slash command:
```
/release           # patch bump (e.g. 2.0.0 -> 2.0.1)
/release minor     # minor bump (e.g. 2.0.0 -> 2.1.0)
/release major     # major bump (e.g. 2.0.0 -> 3.0.0)
/release 2.1.0     # explicit version
```

This commits all outstanding changes, then runs `release.sh` which bumps `package.json` version, tags, pushes, builds the installers, and creates a GitHub Release with the artifacts. Requires `gh` CLI to be authenticated. Can also be run manually: `./release.sh [major|minor|patch|x.y.z]`.

Auto-update is **platform-split**:
- **Windows/Linux** use `electron-updater` against the GitHub Release (NSIS blockmaps + `latest.yml`; SHA512-verified).
- **macOS** uses a **custom GitHub-polling updater** (`darwinCheckForUpdates` in main.js) — Squirrel.Mac refuses to apply unsigned updates, so builds are unsigned and the updater downloads the `-mac-<arch>.dmg` release asset directly and opens it. There is currently **no checksum/signature verification** on that path (tracked in EVALUATION-TASKS.md).

## Security

The app had a 4-agent security audit — see `docs/security/2026-05-06-audit-report.md` for the fixed criticals and the deferred items. Established posture to **preserve**:

- pty-server WS is 127.0.0.1-bound + handshake-token-authed (above), with DoS caps (payload size, pty count, write size).
- Renderer-supplied `env` is blocklist-filtered before merge (`NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*`, `PYTHONPATH`, `PERL5LIB`, `RUBYOPT`, `PATH`, …) so an allow-listed `claude` invocation can't be turned into RCE.
- BrowserWindows run `contextIsolation:true, nodeIntegration:false, sandbox:true` behind a strict CSP, with `setWindowOpenHandler` / `will-navigate` locked down.
- All fs/git IPC passes through `assertInsideAllowedRoots` (realpath + symlink checks); git handlers use `execFile` arg arrays with ref-name validation.
- Secrets (ElevenLabs key, endpoint tokens) are `safeStorage`-encrypted and never returned to the renderer.

Deferred/open items (SSRF in `endpoint:fetchModels`, plaintext `dbConnectionString`, pty `cmd` allow-list, `reattach` ownership, `hooks:configure` consent, and more) live in `EVALUATION-TASKS.md` alongside the broader gaps/issues backlog.

## UI Conventions

- Product name: "Claudes"
- Terminology: Spawn (not Add), Kill (not Close), Respawn (not Restart)
- Use the real Claude starburst icon (claude-icon.png / claude-small.png), not unicode approximations
- Background colours must be consistent: terminal theme background is `#1a1a2e`

## Project Config

- App config stored in `~/.claudes/projects.json` (dev: `projects-dev.json` — auto-selected when unpackaged). Each project entry carries:
  - `name`, `path`, `columnCount`, `poppedOut`, `popoutBounds` (existing)
  - `workspaces: []` — array of `{ id, name, createdAt }` sub-workspaces (peers to Primary, rendered as indented sub-rows under the project card)
  - `activeWorkspaceId: null | "<ws id>"` — which workspace the project last routed to; `null` means Primary
- Per-project session state stored in `<project>/.claudes/sessions.json`, shape:
  ```json
  { "sessions": [ ... ], "workspaces": { "<ws id>": { "sessions": [ ... ] } } }
  ```
  Primary's columns live in the top-level `sessions` array; each sub-workspace's columns live under `workspaces.<id>.sessions`. Legacy files with just `{ "sessions": [...] }` are read as Primary with an implicit empty `workspaces: {}`; the first save upgrades the shape. Writes are atomic (`lib/config-io.js` `atomicWriteJson`: same-dir tmp + fsync + rename, with `.bak` roll-aside and corrupt-file quarantine/recovery on read).
- `config:saveProjects` has an empty-over-nonempty data-loss guard and merges on-disk `voice`/`terminal`/sync state back before persisting (`preserveManagedSettings`) — do not regress this or it clobbers settings the user just changed.
- Each per-column session entry optionally carries a `cwd` field — the working directory the column was spawned in. Omitted when equal to the project root, so existing files without `cwd` keep working unchanged. On restore, missing-on-disk values fall back to project root with a console warning (handled via `electronAPI.pathExists` pre-flight).
- Each per-column session entry also optionally carries a `targetBranch` field — auto-detected by the Git tab from the Claude CLI session JSONL's last `gitBranch` value. When set, the Git tab renders branch-relative read-only data (commits, ahead/behind, diff vs base) for `targetBranch` rather than the project root's currently-checked-out branch. Mutation actions (stage/commit/push) disable until the user checks out that branch. Persisted only as a hint — `autoBindColumnTarget` re-derives it on focus regardless.
- Claude sessions detected by scanning `~/.claude/projects/<path-key>/` for `.jsonl` files

## Voice (TTS)

Reads Claude's replies aloud via ElevenLabs. **Before touching anything voice-related, read [`docs/voice.md`](docs/voice.md)** — it covers the full architecture, IPC surface, and the bugs that keep recurring. The non-obvious essentials:

- **Voice reads the LIVE TERMINAL buffer first, transcript only as fallback.** Interactive `claude` columns often DON'T persist their reply to `~/.claude/projects/<key>/<id>.jsonl` in real time (only a ~110-byte `ai-title` stub), so the disk transcript is unreliable for live playback. The terminal parser (`lib/terminal-reply.js`) is **TUI scraping** — fragile to Claude Code UI restyles; re-capture fixtures via headless xterm if it breaks (see docs §11).
- **Reading modes** use the optional `🔊` (U+1F50A) summary line: `auto`/`summary` speak just that line (summary falls back to `firstSentence` when absent); `full` strips it and reads the body to `maxChars`.
- **Don't regress session attribution:** the session-sync poll is read-only for `sessionId` (it once stole sibling columns' sessions); `detectSession` is acquire-only; fresh local spawns get a deterministic `--session-id` kept out of persisted `cmdArgs`.
- **`config:saveProjects` must preserve on-disk `voice`/`terminal`** (`preserveManagedSettings`) or it clobbers settings the user just changed.
- Pure libs: `voice-text.js`, `terminal-reply.js`, `voice-transcript-path.js`, `voice-settings.js`, `voice-request.js`, `voice-personality.js`, `session-target.js`, `spawn-session.js` (each `npm`-tested).

## Known Issues / Backlog

`EVALUATION-TASKS.md` (repo root) holds the prioritised gaps/issues backlog from the full app evaluation — High/Medium/Low, each keyed to `file:line`. Consult and update it when working on anything it covers.

<!-- aidp-orchestrator-start -->
## AI-Driven Project Orchestrator

**Session agent active** — read `_aidp-orchestrator.md` from project memory for project-specific config (shadow dir, verify commands, docs).

### Assigned Agents
| Agent | Scope | Model |
|-------|-------|-------|
| implementer-electron | main.js, renderer.js, preload.js, pty-server.js, index.html, styles.css, scripts/, release.sh, package.json | sonnet |
| tester-node | test/ | sonnet |
| ux-reviewer | index.html, styles.css, renderer.js | sonnet |
| reviewer | (read-only) | opus |

### Workflow (mandatory for ALL implementation)
1. **Classify** — trivial (skip to 4) | standard | vague/complex (`EnterPlanMode`)
2. **Research** — Explore agent(s) to understand affected areas
3. **Plan** — decompose into agent-scoped subtasks
4. **Sync main and branch** — `git checkout main && git pull --ff-only` (skip pull if no remote; on divergence, escalate — do NOT auto-merge/rebase) then `git checkout -b work/<task-description>`
5. **Create and enter worktree** — `git worktree add -b worktree-<task-slug> .claude/worktrees/<task-slug>` then `EnterWorktree(path: ".claude/worktrees/<task-slug>")` (use `worktree add` so the branch is based on local HEAD, not origin/<default>)
6. **TDD loop** — for each behavior in step 3's behavior list, delegate ONE Agent() WITHOUT `isolation` with a strict RED→GREEN cycle (one failing test → minimum code to pass → stop). Commit per cycle (test + impl in same commit). For `## Behavior triplet:` blocks (cross-layer, plan-mode only): dispatch FE+BE in parallel, then seam test (broader-harness agent) blocking on both — see `references/tdd/cross-layer-triplets.md`. Non-behavioral tasks (config, dep bumps, copy, pure styling): single delegation, no cycle. Prompts MUST include `## Constitution Rules` + `## Structure Snippet`; add `## Design Snippet` for ui-compose/ux-reviewer. Never write all tests up front — that's horizontal slicing (see references/tdd/SKILL.md).
implementer-electron + tester-node + ux-reviewer can run TDD cycles in parallel on non-overlapping behaviors.
7. **Refactor pass** (optional, only when ALL behaviors GREEN) — same implementer agent, refactor prompt, run tests after each step, commit `refactor:` separately. Skip if already clean.
8. **Quality gate** — `npm test`. ALL must pass (zero errors, including pre-existing). 3 failures → escalate
9. **Review** — reviewer agent on `git diff main...HEAD`. Review-fix loop: Critical → fix → re-commit → re-gate → re-review (max 2 cycles)
10. **Exit worktree** — `ExitWorktree(action: "keep")`
11. **Merge and ship** — merge worktree → integration branch → main. Conflict check at each merge, verify after each, revert main on failure. Worktree cleanup (unlock + remove + branch -d) then integration branch cleanup. See Merge Protocol in `_aidp-orchestrator.md`
12. **Escalate** — user only for architectural decisions or merge conflicts

### Enforcement (hooks auto-enforce — these WILL block you)
- Agent() calls blocked without active worktree (except Explore, Plan, reviewer, plan-reviewer)
- Write/Edit blocked on subdirectory files without active worktree
- Bash file writes blocked without active worktree
- Branch must be main/master/work/* before worktree creation
- Plan review offered via AskUserQuestion before ExitPlanMode (user chooses: finalize or review first)
- ExitWorktree blocked until reviewer has run (commit-hash verified — new commits require re-review)
- ExitWorktree blocked until ALL verify commands pass (zero errors — pre-existing included)

### Direct-Edit Scope (orchestrator only, no worktree needed)
Root config: CLAUDE.md, README.md, .gitignore, package.json | .claude/ | memory/ | git ops

**All other files: Branch → EnterWorktree → Delegate → Commit → Gate → Review → ExitWorktree**
Every source file change — including one-line fixes — goes through an agent in a worktree.

### Agent Lifecycle
Agents are one-shot. Always spawn fresh Agent() for remaining work. No `isolation` param — agents inherit worktree CWD.

### Task Tracking
Emit `TaskCreate` at step 3 (Plan), one per phase: Implement (TDD) (one per parallel agent), Refactor (optional), Quality gate, Review, Merge. Use `addBlockedBy` for ordering. Update to `in_progress` when entering each step, `completed` on pass. Never `completed` while tests fail or reviewer flagged Critical. Orchestrator owns tasks — agents don't touch them. Skip for orchestrator-direct edits.

**Before your first task each session**, read `_aidp-orchestrator.md` from project memory — it is the authoritative workflow source and may be more current than these inline rules.
<!-- aidp-orchestrator-end -->
