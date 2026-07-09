# Scheduled Interactive Sessions (Automations)

## Problem

Automations currently run each agent as a **headless** Claude Code process:
`spawnHeadlessClaude()` (`main.js:6738`) invokes `claude --print <prompt> --output-format stream-json --verbose`. That process is a fresh, non-interactive subprocess.

Some Claude Code capabilities only exist in an **interactive** session, not a `--print` one. The one that motivated this spec is **Claude-in-Chrome**: it's not a config MCP server (nothing in `~/.claude.json → mcpServers`), it's the paired **Chrome extension** integration (`chromeExtension.pairedDeviceId`, `claudeInChromeDefaultEnabled`, `hasCompletedClaudeInChromeOnboarding`). The pairing binds to the interactive CLI/app session. A spawned `claude --print` subprocess never establishes that bridge, so `mcp__claude-in-chrome__*` tools are simply absent from automation runs.

Empirically confirmed on the "Live Issues — Claude Triage" automation — two headless runs, with the **full** (non-strict) MCP set:

```
[run 1] browser tools: chrome-devtools, playwright   | claude-in-chrome: absent
[run 2] browser tools: chrome-devtools, playwright   | claude-in-chrome: absent
```

The consequence: any automation that needs to drive the user's **real, authenticated browser** (e.g. verify a live issue / a proposed fix in the ClubRight admin, which is logged in in the user's Chrome) can't — a headless browser (`playwright` / `chrome-devtools`) starts logged-out. Claude-in-Chrome would reuse the existing authenticated session, but it isn't available headless.

## Goal

Let an automation agent run on its schedule as an **interactive** Claude Code session — the same kind of session a Claudes **column** spawns — so it has the full interactive toolset, including the paired Chrome extension (Claude-in-Chrome) reusing the user's authenticated browser. The scheduled interactive run must still: take the automation's prompt, run to completion unattended, capture output + summary/attention items into the automation run history, and terminate cleanly.

This generalises beyond Claude-in-Chrome: any interactive-only integration (browser extension, IDE bridge, etc.) becomes schedulable.

## Non-goals

- Not replacing headless mode — most automations should stay headless (cheaper, simpler, no live-browser side effects). This is an **opt-in** per agent.
- Not changing the scheduler, run-history format, dependency/`runAfter` graph, or usage gates.
- Not building a new browser integration — reuse the existing Claude-in-Chrome pairing as-is.

## Proposed data model change

Add an optional per-agent field to the automations schema (`~/.claudes/automations.json`), alongside the existing agent fields (see `2026-03-27-automations-redesign.md`):

| Field | Type | Default | Description |
|---|---|---|---|
| `sessionMode` | `"headless"` \| `"interactive"` | `"headless"` | `headless` = today's `claude --print`. `interactive` = spawn an interactive Claude Code session (same path a column uses) so extension integrations are available. |

(Existing fields — `prompt`, `schedule`, `skipPermissions`, `extraArgs`, `endpointModel`, `dbConnectionString`, etc. — apply unchanged.)

## Execution design

The interactive scheduled run should reuse the **column spawn path** (see `main.js:2000` — "what each column spawns (claude vs custom cmd)…"), because that path already produces a session with the Chrome extension paired. The automation runner (`runAgent`, ~`main.js:7000–7200`) should branch on `sessionMode`:

- `headless` → `spawnHeadlessClaude()` (unchanged).
- `interactive` → a new `spawnInteractiveScheduled()` that:
  1. Starts an interactive `claude` session in the agent's `cwd` (a PTY, the same as a column), inheriting the app's device pairing so Claude-in-Chrome is available.
  2. **Injects the prompt** (`agent.prompt`, e.g. `/live-triage`) into the session as the first user turn.
  3. Runs **unattended** — the session must not block on a permission prompt (see Safety), and must not wait for human input.
  4. **Detects completion**, captures output, then **terminates** the session (interactive sessions don't self-exit like `--print`).
  5. Writes the same run record shape to `~/.claudes/automation-runs/{automationId}/{agentId}/` as headless runs.

### Completion detection & capture

Headless mode ends when the `--print` process exits, and parses the trailing `:::loop-result` JSON block for `summary` / `attentionItems` (the `AGENT_PROMPT_SUFFIX` at `main.js:6408`; parser ~`main.js:6530`). Interactive sessions don't exit on their own, so:

- Append the same `AGENT_PROMPT_SUFFIX` so the session emits the `:::loop-result` marker when done.
- Treat the appearance of the closing `:::loop-result` marker (or the session going idle after it) as the completion signal → capture the summary/attention items with the existing parser, then terminate the session.
- Reuse the existing run-record writer and the `automations:agent-output` / `automations:agent-completed` events so the UI shows interactive runs identically.

### Safety & concurrency

An interactive scheduled run drives the user's **live** Chrome via the extension — this has real side effects the headless path doesn't:

- **No blocking prompts.** The run is unattended, so tool-permission prompts must be auto-resolved (equivalent to `--dangerously-skip-permissions`, or an auto-approve mode) — otherwise the session hangs forever waiting for a human. Gate this behind the agent's existing `skipPermissions` flag.
- **Live-browser interference.** Because it acts on the user's real browser (opening tabs, navigating), consider: run in a **dedicated Chrome window/profile** if the pairing allows, and/or surface a clear "this automation drives your real browser" warning in the UI when `sessionMode: "interactive"` is selected.
- **Watchdog / max duration.** Interactive sessions can hang (a modal dialog, a stuck page). Add a hard timeout that kills the session and records the run as `interrupted` with a reason — headless has a natural process-exit backstop; interactive needs an explicit one.
- **Concurrency cap.** Interactive runs still count toward `maxConcurrentRuns`. Two interactive runs fighting over the same paired Chrome will collide — consider serialising interactive runs, or at minimum not running two against the same device concurrently.

## Config / UI

- Automation create/edit modal: a **Session mode** toggle — *Headless (default)* vs *Interactive (uses your logged-in browser)* — with a one-line explainer and the live-browser warning on the interactive option.
- List/detail view: badge interactive agents so it's obvious which ones will touch the real browser.

## Open questions (for the builder)

1. **Exact column spawn path** — which function spawns a column's interactive `claude`, and can it be driven programmatically (PTY write of the prompt, read of the stream) without a visible column UI? If a column is always tied to a visible pane, does a headless-but-interactive variant need a hidden PTY?
2. **Device pairing inheritance** — does a session spawned by the app automatically inherit the Chrome-extension pairing, or does the pairing need to be passed/re-established for a background session?
3. **Prompt injection** — is there an existing helper to send a first user message into an interactive session, or does the PTY need raw stdin writes + a submit keystroke?
4. **Idle/completion signal** — is there a cleaner "task complete / session idle" signal than watching for the `:::loop-result` marker (e.g. an SDK/stream event)?
5. **Permission auto-approve in interactive mode** — is `--dangerously-skip-permissions` honoured on an interactive session, or is a different auto-approve mechanism needed?

## Acceptance criteria

- [ ] An agent with `sessionMode: "interactive"` runs on its schedule and, within the run, `mcp__claude-in-chrome__*` tools are available (verifiable in the run transcript).
- [ ] The interactive run reuses the user's authenticated Chrome (can reach a page that requires the user's existing login without a fresh login step).
- [ ] The run completes unattended (no human prompt), captures `summary` + `attentionItems` into the run history, and terminates the session.
- [ ] A hung interactive run is killed by the watchdog and recorded as `interrupted`.
- [ ] `sessionMode: "headless"` (and agents with no `sessionMode`) behave exactly as today.
- [ ] The create/edit UI exposes the toggle with the live-browser warning.

## Related feature: per-project / per-agent MCP selection

Independently of session mode, we want a first-class way to **choose which MCP servers an automation loads** — turn them on/off — instead of inheriting the entire merged set.

### Why

A scheduled `claude --print` (or interactive) run inherits **every** MCP server from the merged Claude config: user-scoped (`~/.claude.json → mcpServers`) **plus** project-scoped (`projects[cwd].mcpServers`). For ClubRight that's ~11 servers (TestPlan, PostHog, Outlook, Slack, Granola, chrome-devtools, taskboard, playwright, mongodb-clubright, clubright, …). Two problems:

1. **Cost.** Every server's tool schemas/names load into context on every run. The empty "Live Issues — Claude Triage" run boots ~135k tokens (≈$1.18/run on Opus, ~$113/day at a 15-min cadence when idle) — most of it MCP boot. The automation only needs 3 servers (`taskboard`, `mongodb-clubright`, a browser).
2. **Blast radius.** An unattended agent shouldn't have tools it doesn't need (e.g. Slack/Outlook/email send) — smaller surface = safer.

Claude Code scopes *project* servers per project natively, but there is **no native way to disable a *user-scoped* server for one project** — the only lever is `--strict-mcp-config` + a hand-built `--mcp-config` file. We've done this by hand for the live-triage automation (a new `extraArgs` passthrough forwarding `--strict-mcp-config --mcp-config <file>`, with a hand-copied 3-server file). That works but is manual and brittle. Make it a UI feature.

### Design

- **Per-agent** (and optionally **per-project default**) MCP selection stored in `automations.json`, e.g. `mcpServers: ["taskboard", "mongodb-clubright", "chrome-devtools"]` (allowlist of server names).
- On run, Claudes:
  1. Discovers the available MCP servers for the agent's project (merged user + project config).
  2. Filters to the selected set, writes a temp `--mcp-config` with just those server definitions, and passes `--strict-mcp-config`.
  3. This is exactly the hand-rolled hack, but automated and reusable — and it obsoletes the manual `extraArgs` scoping on the live-triage automation (migrate it to the selection once built).
- **UI:** in the automation create/edit modal, list the project's available MCP servers as checkboxes (default: all on, or a project default). A per-project default set with per-agent override is ideal — that's the "turn MCPs on/off based on a project" ask.
- Works for **both** headless and interactive `sessionMode`.

### Acceptance criteria (MCP selection)

- [ ] An automation with an MCP allowlist loads **only** those servers (verifiable in the run transcript) — including dropping user-scoped servers that would otherwise be inherited.
- [ ] Deselecting a server removes its tools from the run and measurably reduces boot tokens.
- [ ] No selection = today's behaviour (all inherited servers).
- [ ] Selection is editable in the UI and stored per agent (with optional per-project default).

## Motivating consumer

`~/.claudes/automations.json → "Live Issues — Claude Triage"` (`auto_livetriage_cr01`), skill `.claude/skills/live-triage/SKILL.md` in the ClubRight repo. It classifies Live Issues tickets and, for genuine bugs, wants to **verify the issue and the proposed fix in the real, logged-in ClubRight admin** — which needs Claude-in-Chrome, i.e. this feature. Until it exists, that automation does code + Mongo + git root-cause and leaves the browser confirmation to a human (or to an interactive on-demand run).
