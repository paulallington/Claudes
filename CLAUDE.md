# Claudes

Multi-column Claude Code terminal desktop app. Also spawns Codex CLI columns and arbitrary commands.
Stack: Electron, plain JavaScript (no bundler), xterm.js, node-pty under system Node, `node:test`.

## Build, run, test

```bash
npm install    # no postinstall or electron-rebuild needed
npm start      # launches the Electron app
npm test       # node --test over test/*.test.js (pure lib/ coverage)
```

- `npm test` needs no `node_modules` (pure `lib/` modules, `node:test`), so it passes in a bare
  worktree. That says nothing about whether the app runs: `index.html` loads xterm from
  `./node_modules/@xterm/...`. Run `npm install` in a worktree before `npm start`.
- Never junction or symlink `node_modules` from the main checkout: `git worktree remove` follows
  the link and deletes the real one.

## Verifying a change

Run `npm test`, then `npm start` and use the change in the running app. An unpackaged run uses
dev files and ports (`~/.claudes/projects-dev.json`, `automations-dev.json`, pty port 3457), so it
runs alongside the installed app without touching its project list.

## Live data

There is no server. A dev run reads the real `~/.claude` and `~/.codex` session files, and every
column it spawns is a real Claude or Codex session on the signed-in subscription.

## Deploy

`/release [major|minor|patch|x.y.z]`. `release.sh` tests, bumps, tags and pushes; the tag push
runs `.github/workflows/release.yml`, which builds the installers and creates the GitHub Release.
Details and auto-update: `docs/claude/releasing.md`.

## Architecture

- Electron main spawns `pty-server.js` as a **child process under system Node.js**, not
  Electron's bundled Node. node-pty's prebuilt binaries only work with system Node, and
  electron-rebuild fails here (node-gyp cannot find Visual Studio 2026). Never load node-pty in
  Electron's process.
- Renderer <-> WebSocket <-> `pty-server.js` <-> node-pty <-> Claude/Codex CLI.
- **The WebSocket is authenticated.** main mints a per-launch 256-bit token and passes it to
  pty-server via env; the renderer presents it as the `Sec-WebSocket-Protocol` subprotocol, and
  `handleProtocols` rejects a missing or wrong token. Without it any local page could open
  `ws://127.0.0.1:<port>` and spawn processes. Do not regress this.
- **pty-server patches node-pty at runtime** (top of `pty-server.js`): it `chmod +x`'s the
  `spawn-helper` prebuild and rewrites `unixTerminal.js`'s asar-unpacked path. This breaks
  silently if node-pty changes those internals, and will fight code signing if macOS builds are
  ever signed.

## Key files

- `main.js`: Electron main (about 8.6k lines). Window management, about 40 IPC handler families
  (config, sessions, explorer, git, CLAUDE.md editor, headroom, codex, automations, endpoints,
  headless, mcp, usage, hooks, layouts, popout and more), and the macOS auto-updater.
- `pty-server.js`: WebSocket server plus node-pty, under system Node. Its `cmd` param spawns
  arbitrary processes, gated by the handshake token.
- `preload.js`: context bridge (about 250 flat methods).
- `renderer.js`: all front-end logic (about 19.9k lines).
- `index.html` (shell, sidebar, modals), `styles.css` (dark theme), `platform-detect.js`.
- `lib/*.js`: pure, `npm`-tested modules. Put the core of any non-trivial logic here with a test
  instead of growing `main.js`/`renderer.js`. Most use a UMD pattern (`module.exports` for
  Node/tests plus `window.*` for the sandboxed renderer, which cannot `require()`).

## Rules

- Security posture to preserve (audit: `docs/security/2026-05-06-audit-report.md`):
  - pty-server WebSocket bound to 127.0.0.1, token-authenticated, with DoS caps (payload size,
    pty count, write size).
  - Renderer-supplied `env` is blocklist-filtered before merge (`NODE_OPTIONS`, `NODE_PATH`,
    `LD_*`, `DYLD_*`, `PYTHONPATH`, `PERL5LIB`, `RUBYOPT`, `PATH` and more), so an allow-listed
    `claude` invocation cannot become RCE.
  - BrowserWindows run `contextIsolation:true, nodeIntegration:false, sandbox:true` behind a
    strict CSP, with `setWindowOpenHandler` and `will-navigate` locked down.
  - All fs/git IPC goes through `assertInsideAllowedRoots` (realpath and symlink checks); git
    handlers use `execFile` arg arrays with ref-name validation.
  - Secrets (ElevenLabs key, endpoint tokens) are `safeStorage`-encrypted and never returned to
    the renderer.
  - Open items (SSRF in `endpoint:fetchModels`, plaintext `dbConnectionString`, pty `cmd`
    allow-list, `reattach` ownership, `hooks:configure` consent and more) are in
    `EVALUATION-TASKS.md`.
- `config:saveProjects` keeps its empty-over-nonempty guard and `preserveManagedSettings`, or it
  clobbers settings the user just changed.
- Automation clone paths are sanitised per segment inside a base dir (an escape here once allowed
  arbitrary directory deletion).
- UI wording: the product is "Claudes". Spawn (not Add), Kill (not Close), Respawn (not Restart),
  "Add Row" for a new row. Keep toolbar shortcut hints brief.
- Use the real Claude starburst icon (`claude-icon.png`, `claude-small.png`), never a unicode
  stand-in. Background colours match the terminal theme background `#1a1a2e`, including padding
  and wrapper elements.
- `EVALUATION-TASKS.md` is the prioritised backlog (High/Medium/Low, keyed to `file:line`).
  Consult and update it when working on anything it covers.

## Before working on...

Designs live under `docs/superpowers/specs/` (often with a plan under `docs/superpowers/plans/`);
the testable core lives in `lib/`.

| Area | Read first |
|------|-----------|
| Any implementation | `docs/claude/aidp-workflow.md` |
| Headroom proxy | `docs/claude/headroom.md` |
| Codex columns | `docs/claude/codex-columns.md` |
| Codex watcher popout | `docs/claude/codex-watcher.md` |
| MCP inheritance, connectors | `docs/claude/mcp-inheritance.md` |
| Subscription profiles | `docs/claude/profiles.md` |
| Project config, sessions.json | `docs/claude/project-config.md` |
| Voice (TTS) | `docs/voice.md` |
| Releasing, auto-update | `docs/claude/releasing.md` |
| Automations, manager mode | `specs/2026-03-27-automations-redesign.md`, `specs/2026-03-30-automation-manager-agent.md`, `docs/ideas/manager-mode.md` |
| Endpoints (per-column API base URL and token) | `specs/2026-05-03-per-agent-connection-design.md` |
| Headless spawn (`lib/headless-helpers.js`) | `specs/2026-04-23-headless-spawn-mode-design.md` |
| Scheduled and interactive scheduled sessions (`lib/interactive-scheduled.js`) | `specs/2026-03-24-scheduled-loops-design.md`, `specs/2026-07-08-interactive-scheduled-sessions.md` |
| Security | `docs/security/2026-05-06-audit-report.md` |

<!-- aidp-orchestrator-start -->
## Implementation workflow

Every source change goes through the agent workflow in `docs/claude/aidp-workflow.md` (branch,
worktree, TDD by agents in `.claude/agents/`, `npm test` gate, reviewer, merge to master). Root
config, `.claude/` and docs can be edited directly.
<!-- aidp-orchestrator-end -->

## Memory

Project memory lives in `.claude/memory/` (rules in the house rules). Index:

@.claude/memory/MEMORY.md
