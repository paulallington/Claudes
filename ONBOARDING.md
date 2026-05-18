# Welcome to Claudes

## How We Use Claude

Based on Ashley's usage over the last 30 days:

Work Type Breakdown:
  Build Feature    ████████████████████░░  39%
  Improve Quality  ████████████████░░░░░░  28%
  Plan Design      █████████████░░░░░░░░░  22%
  Debug Fix        ████░░░░░░░░░░░░░░░░░░   6%
  Analyze Data     ░░░░░░░░░░░░░░░░░░░░░░   0%
  Prototype        ░░░░░░░░░░░░░░░░░░░░░░   0%
  Write Docs       ░░░░░░░░░░░░░░░░░░░░░░   0%

Top Skills & Commands:
  [/effort]         ████████████████████░░  4x/month
  [/terminal-setup] ████░░░░░░░░░░░░░░░░░░  1x/month
  [/mcp]            ████░░░░░░░░░░░░░░░░░░  1x/month

Top MCP Servers:
  _None configured_

## Your Setup Checklist

### Codebases
- [ ] [claudes](https://github.com/paulallington/claudes) — Multi-column Claude Code terminal desktop app

### MCP Servers to Activate
- [ ] **github** — pull / push / review across the GitHub org. Right-click the project in the sidebar → *Manage MCP servers…* → +, then fill in:
  - command: `npx`
  - args: `-y`, `@modelcontextprotocol/server-github`
  - env: `GITHUB_TOKEN=<your_pat>`
- [ ] **filesystem** — give Claude raw read/write inside this repo (handy when you trust the sub-agent and want fewer permission prompts). `npx -y @modelcontextprotocol/server-filesystem <repo_root>`.
- [ ] **playwright** (optional) — for UI verification on the renderer. Install the plugin from your Claude Code plugin marketplace, then enable here.

### Skills to Know About
- `/effort` — Set reasoning effort level (normal, high, max). Use **high** for complex features, **max** for deep architecture work.
- `/terminal-setup` — Configure terminal environment settings.
- `/mcp` — Manage MCP (Model Context Protocol) servers from inside a Claude session (alternative to the in-app modal).
- `/release` — bump version, tag, build NSIS / AppImage / .deb, publish a GitHub Release. See [README](README.md#releasing).
- `?` (in-app) — opens the full shortcuts & features reference modal.

## Team Tips

- **Spawn vs. Add, Kill vs. Close.** The terminology in this app is deliberate: a column hosts a *process*, so it's spawned and killed, not "added" and "closed." Keep that consistent in PR descriptions and commit messages.
- **No node-pty in Electron.** node-pty's prebuilt binaries only link against system Node — `pty-server.js` runs as a child process under the user's installed `node`, and the renderer talks to it over a localhost WebSocket gated by a per-launch token. Never try to `require('node-pty')` from the Electron process; electron-rebuild fails on this codebase.
- **All renderer-supplied paths are containment-checked.** `assertInsideAllowedRoots` runs on every FS / git / shell IPC. If you're adding a new IPC that takes a path from the renderer, route it through that helper.
- **Frequent commits with descriptive messages.** Tooling (release script, what's-new overlay, CI) reads the commit log — squash-merging is fine but the resulting commit should be informative on its own.
- **TDD-lite.** The repo has `test/*.test.js` (run with `npm test`) for the pieces that are unit-testable. UI logic is mostly verified in the actual app, which is why the README says: don't claim a UI feature is done without booting `npm start` and clicking through it.

## Get Started

1. `git clone https://github.com/paulallington/Claudes && cd Claudes && npm install`. No `electron-rebuild`, no postinstall — `npm install` is all you need.
2. `npm start` to boot the app. Hit `?` once it's open to glance at the shortcuts modal.
3. Add this repo as your first project (sidebar → **+ Add Project**), then spawn a Claude column (**Ctrl/Cmd+Shift+T**).
4. Try `/release patch` from the Claude prompt to walk through the publishing flow (it'll dry-run if no `gh` auth yet).
5. Browse `CLAUDE.md` for the codebase's hard architectural rules — they're short on purpose.
6. Pick one of the *Setup Checklist* items above to enable (start with `github` MCP — it pays for itself within an hour).

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->
