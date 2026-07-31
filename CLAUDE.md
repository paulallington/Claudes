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

Note: `release.sh` **does** run `npm test` and aborts on failure — observed on the v1.9.56/57/58 releases. (This previously said it did not; `/release-gate` was written partly on that assumption, so its stated justification is weaker than it reads.) Whether CI runs the suite independently is unverified — see EVALUATION-TASKS.md.

`npm test` needs **no `node_modules`** — the `lib/` modules are pure and the suite is `node:test`, so it passes in a bare worktree. That is a trap worth knowing: a green suite there says nothing about whether the *app* runs, since `index.html` loads xterm from `./node_modules/@xterm/…`. Run `npm install` in a worktree before `npm start`, and never junction/symlink `node_modules` from the main checkout — `git worktree remove` follows the link and deletes the real one.

## Subsystems

Each has a design/spec under `docs/superpowers/specs/` (and often a plan under `plans/`); the testable core lives in `lib/`.

- **Headroom** (`lib/headroom-env.js`, `lib/headroom-watchdog.js`, `headroom:` handlers) — an app-managed local proxy that Claude columns route through for rate-limit headroom. Binding is env-only: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (default 8787) + `ENABLE_TOOL_SEARCH=true` (**omitted when the column has MCP servers** — Headroom's `tool_search_deferral` optimizer swallows deferred `mcp__*` tools into a manifest the CLI's `tool_search_tool_regex` can't load, so MCP-bearing columns keep tool schemas inlined; `buildHeadroomEnv` gates the flag on `hasMcp`, threaded from `resolveProjectMcpSpawn` and persisted on the column for respawns) + optional `ANTHROPIC_MODEL=<model>[1m]` to re-activate the 1M window (a custom base URL otherwise caps at 200k). Proxy spawned as `headroom proxy --port <p> --no-http2 [--memory] [--mode cache|token | --no-optimize]`; `--no-http2` is mandatory (shared-connection HTTP/2 corrupts TLS under the frequent stream cancels of multi-column use). Mode is start-time only — restart the proxy to change it; `cache` is the subscription-safe default. main probes the `headroom` binary at startup, can auto-start/auto-update it, and a health watchdog auto-restarts a frozen ("up but silent") proxy **it owns and started**. "API error · Retrying" in a column is a real upstream 429/5xx relayed through the proxy, not an app bug; proxy logs live in `~/.headroom/logs/proxy.log`.
- **Codex columns** (`lib/codex-app-server.js`, `lib/codex-thread-state.js`, `lib/codex-spawn-ticket.js`, `lib/codex-spawn.js`, `lib/codex-limits.js`, `codex:`/`spawn` paths) — spawn the normal Codex TUI as a column while Electron main owns a loopback `codex app-server` used for native thread state. A **fresh** managed column must attach as `codex -C <project> --remote ...` and let the TUI create its thread; `-C` is required because a remote app-server otherwise creates the thread under the wrapper's cwd, so the cwd-bound claim cannot safely adopt it. On Windows the managed TUI runs through the installed Codex Node entrypoint, not `cmd.exe`, so legal shell-active project-path characters remain literal. Pre-creating an empty app-server thread and launching `codex resume` is invalid because no rollout exists yet. Main registers a short-lived cwd-bound claim, serializes fresh launches for the same normalized cwd, adopts the UUID from the broadcast `thread/started` event, and then persists it as resume intent. Claim timeout or bridge loss is pushed to the renderer and must leave the loading state with an explicit retryable warning. Existing persisted threads verify `thread/read` belongs to the expected cwd before attaching with `resume`; a stale empty UUID that reports either `thread not loaded` or `no rollout found` transparently becomes a fresh claimed attach. Token usage, context-window size, thread status, settings, compaction events, and the live model/effort/service-tier catalog stream into the session header. The static model catalog and ordinary direct CLI spawn remain a progressive fallback if app-server is unavailable; direct fallback is visibly degraded and clears stale managed-thread state. Approval presets map to Codex flags (`-a` approval, `-s` sandbox, plus a bypass flag). **Codex runs direct from Headroom's perspective, never through Headroom** — ChatGPT-subscription Codex ignores `OPENAI_BASE_URL`, so Headroom stays Claude-only. The app-server WebSocket is 127.0.0.1-bound and bearer-authenticated; the raw bearer remains main-only, while each PTY receives it over its private stdin control channel only after consuming a short-lived, single-use spawn ticket bound to either the fresh claim or exact resumed thread UUID, plus the normalized cwd and bridge endpoint. Never expose or persist the bearer or fresh claim in renderer/preload/session state. Account rate-limit usage is still scraped from `rate_limits` in the `~/.codex/sessions` rollout JSONL.
- **Automations / Manager mode** (`automations:` handlers, `docs/ideas/manager-mode.md`) — scheduled/collaborative agent runs, incl. a manager agent that clones and coordinates worker agents. Clone paths are sanitised per-segment inside a base dir (an escape here once enabled arbitrary dir deletion).
- **Endpoints / per-agent connections** (`endpoint:` handlers) — custom API base URLs/tokens per column. Tokens are `safeStorage`-encrypted and never returned to the renderer.
- **Headless spawn mode** (`lib/headless-helpers.js`, `headless:` handlers) — run a prompt against a project without an interactive column.
- **MCP project inheritance** (`lib/mcp-project.js`, `mcp:` handlers) — projects can inherit/override MCP server config.
- **Scheduled / interactive sessions** (`lib/interactive-scheduled.js`) — cron-style loops and interactive scheduled runs.
- **Multi-subscription profiles** (`lib/profile-resolve.js`, `profile:` handlers) — a column/project/workspace/automation can run under a secondary Claude account instead of Primary, so one machine can spread work across several subscriptions' rate limits. A profile is just a directory (`~/.claudes/profiles/pf_*`, app-allocated, never renderer-supplied) set as `CLAUDE_CONFIG_DIR`; Primary sets **no** env var at all, which is what makes the whole feature a no-op for single-subscription users. `profile:resolve` in main is the single resolution entry point — it runs the column -> workspace -> project -> global-default cascade (`lib/profile-resolve.js`'s `resolveProfile`) and returns `{ id, name, colour, isPrimary, env }`; the renderer never runs the cascade itself, only caches the result. `lib/profile-resolve.js` guards its own `require('path')` (`typeof require === 'function'`) so the same file loads in the sandboxed renderer via `window.ProfileResolve`, where `path` doesn't exist — `profileClaudeRoot` throws if called there, which only main does; a `node:vm` test pins this contract (see `test/profile-resolve.test.js`). Background session ids (`backgroundSessionIds` in main) are a `Map<id, profileId>`, not a plain id set, since usage/polling needs to know which subscription a headless run was under; Primary is canonicalised to `'primary'` there even though the renderer/cascade also accept `null` for it. App-managed global config (hooks, permissions, the global `CLAUDE.md`) is Primary-authoritative and mirrored to every secondary profile's directory on write (`mirrorToProfiles`) from **both** places that write the global `CLAUDE.md` — the CLAUDE.md editor (`claudemd:save`) and the voice-personality upsert (`voice:setPersonality`) — a failed mirror surfaces as a `profiles:mirrorFailed` toast rather than silently diverging. The Subscriptions panel (global settings) creates/renames/recolours/deletes profiles and reseeds a profile's config dir from Primary; per-project and per-workspace assignment is via their sidebar right-click context menus opening a shared assign modal (there is no project-settings modal in this app), plus inline pickers on the spawn-options and automation-editor surfaces. The Usage **modal** itself is still Primary-only — the mini usage bar polls and shows every profile, but the modal's detailed breakdown does not yet split by profile (tracked follow-up). **macOS is guarded, not supported**: `profile:create` refuses on `darwin` and the panel disables "Add subscription" there, because it's unverified whether the CLI's keychain-based credential storage on that platform is scoped per `CLAUDE_CONFIG_DIR` — see `docs/superpowers/specs/2026-07-27-multi-subscription-profiles-design.md` for the outstanding experiment.
- **Codex watcher** (`lib/codex-watch-log.js`, `lib/codex-watch-jobs.js`, `lib/codex-watch-tail.js`, `codex-watch.html`, `codexwatch:` handlers) — a read-only popout that live-tails the Codex **plugin** jobs a Claude column launched (`/codex:rescue` and friends), which are otherwise invisible apart from a spinner in Claude's own output. Distinct from **"Hand off to Codex"** (`handoffColumnToCodex`), which spawns an ordinary visible Codex column — handed-off columns are not a hidden stream and are out of scope. Jobs are attributed by Claude `sessionId` across **every** plugin state dir, because a session that enters a worktree changes cwd and the plugin keys its state dir by git repo root. **The state root is profile-aware and must stay that way**: the plugin resolves it from `CLAUDE_PLUGIN_DATA` (`scripts/lib/state.mjs`), which follows `CLAUDE_CONFIG_DIR`, so a column on a secondary subscription profile logs under *that* profile's directory — `codexWatchStateRoot` goes through `claudeRootFor(columnProfileId)` (not `profile.env` directly, which would lose the `null` means Primary-explicitly coalescing). Hardcoding `~/.claude` would report zero jobs for every non-Primary column, indistinguishable from having no plugin installed. **The renderer never sends a path** — only `{ workspaceKey, jobId }`, with `workspaceKey` accepted solely when it exactly matches a directory main itself enumerated, because the plugin state root lies outside `assertInsideAllowedRoots` and that boundary was deliberately not widened. Tailing is a byte-offset poll (1s with a stream open, 3s for the badge, stopped entirely when no watcher window is open); the offset/short-read arithmetic lives in `lib/codex-watch-tail.js` behind an injected `io` so it is unit-testable. UI appears **only when the column's session actually has jobs** — deliberately *not* gated on `hasCodex()`, which probes the CLI rather than the plugin, so a CLI-only machine would otherwise get a permanently dead menu row.

## Releasing

Use the `/release` slash command:
```
/release           # patch bump (e.g. 2.0.0 -> 2.0.1)
/release minor     # minor bump (e.g. 2.0.0 -> 2.1.0)
/release major     # major bump (e.g. 2.0.0 -> 3.0.0)
/release 2.1.0     # explicit version
```

This commits all outstanding changes, then runs `release.sh`, which runs `npm test` (aborting on failure), bumps `package.json`, commits, tags, and pushes. **The installers are then built by GitHub Actions, not locally** — the tag push is what triggers the Windows/macOS/Linux build, and the Release appears once that workflow finishes, so `release.sh` returning does not mean artifacts exist yet. Watch https://github.com/paulallington/Claudes/actions. Can also be run manually: `./release.sh [major|minor|patch|x.y.z]`.

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
9. **Review** — reviewer agent on `git diff master...HEAD`. Review-fix loop: Critical → fix → re-commit → re-gate → re-review (max 2 cycles)
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
