# Automations System (Loops Redesign)

## Overview

Rename "Loops" to "Automations". An automation is either **simple** (single agent, runs in the project directory — identical to current loops) or **multi-agent** (a pipeline of agents, each optionally with its own isolated clone of the repository). The execution engine stays the same under the hood — same Claude CLI `--print` spawning, same run history, same scheduling.

### Problem

Multiple agents running as loops within the same project share a single working directory. When agents perform git operations concurrently (branching, committing, checking out), they interfere with each other — dirty working directories, HEAD confusion, race conditions on branch creation.

### Solution

Allow each agent within an automation to optionally clone the project repo into its own isolated working directory. A setup wizard automates the cloning process. Agent dependencies enable pipeline-style workflows where agents run in sequence.

## Data Model

### Config File

Rename from `~/.claudes/loops.json` to `~/.claudes/automations.json`.

```json
{
  "globalEnabled": true,
  "maxConcurrentRuns": 3,
  "agentReposBaseDir": "~/.claudes/agents/",
  "automations": [
    {
      "id": "auto_<timestamp>_<random>",
      "name": "TaskBoard Pipeline",
      "projectPath": "D:/Git Repos/MyProject",
      "agents": [
        {
          "id": "agent_<timestamp>_<random>",
          "name": "Bug Resolution Agent",
          "prompt": "...",
          "schedule": {
            "type": "interval",
            "minutes": 30
          },
          "runMode": "independent",
          "runAfter": [],
          "runOnUpstreamFailure": false,
          "isolation": {
            "enabled": true,
            "clonePath": "D:/AgentRepos/my-project/bug-resolution-agent/"
          },
          "enabled": true,
          "skipPermissions": false,
          "firstStartOnly": false,
          "dbConnectionString": null,
          "dbReadOnly": true,
          "lastRunAt": null,
          "lastRunStatus": null,
          "lastError": null,
          "lastSummary": null,
          "lastAttentionItems": null,
          "currentRunStartedAt": null
        }
      ],
      "enabled": true,
      "createdAt": "2026-03-27T00:00:00Z"
    }
  ]
}
```

A simple automation has a single entry in the `agents` array. No special casing — the UI handles the presentation.

### Agent Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique agent identifier |
| `name` | string | Display name |
| `prompt` | string | Claude CLI prompt |
| `schedule` | object | Same schedule types as current loops: `manual`, `interval`, `time_of_day`, `app_startup` |
| `runMode` | `"independent"` \| `"run_after"` | Whether this agent runs on its own schedule or waits for others |
| `runAfter` | string[] | Agent IDs that must complete before this agent runs (only when `runMode` is `"run_after"`) |
| `runOnUpstreamFailure` | boolean | If false (default), skip this agent when any upstream agent fails. If true, run anyway. |
| `isolation.enabled` | boolean | Whether this agent gets its own repo clone |
| `isolation.clonePath` | string \| null | Absolute path to the cloned working directory |
| `enabled` | boolean | Per-agent toggle |
| `skipPermissions` | boolean | Allow dangerous operations |
| `firstStartOnly` | boolean | For `app_startup` schedule type |
| `dbConnectionString` | string \| null | MongoDB MCP connection |
| `dbReadOnly` | boolean | Enforce read-only DB constraints |
| `lastRunAt` | timestamp \| null | |
| `lastRunStatus` | `"completed"` \| `"error"` \| `"interrupted"` \| `"skipped"` \| null | |
| `lastError` | string \| null | |
| `lastSummary` | string \| null | |
| `lastAttentionItems` | array \| null | |
| `currentRunStartedAt` | timestamp \| null | Set while running |

### Run History

Directory structure moves from `~/.claudes/loop-runs/{loopId}/` to `~/.claudes/automation-runs/{automationId}/{agentId}/`. Same run JSON format inside each agent directory.

### Settings

New user-configurable setting: `agentReposBaseDir` — the base directory for isolated agent clones. Default: `~/.claudes/agents/`. Clones are created at `<agentReposBaseDir>/<project-name>/<agent-name>/`.

## Migration

On app startup, if `loops.json` exists and `automations.json` does not:

1. Copy `loops.json` to `loops.backup.json`
2. Transform each loop into an automation with a single agent — the loop's fields map directly onto the agent fields, the automation wrapper gets `name` from the loop name, `projectPath` from the loop's `projectPath`
3. Copy `globalEnabled` and `maxConcurrentRuns` across, add `agentReposBaseDir` with default value
4. Write `automations.json`
5. Rename `loop-runs/` to `automation-runs/`, nesting each `{loopId}/` under a matching `{automationId}/{agentId}/` path
6. Log the migration to console

If both files exist (interrupted migration), `automations.json` wins. Old `loops.json` is never deleted — just ignored after migration.

## Execution Engine

### Scheduling

The 30-second scheduler loop iterates automations, then agents within each automation:

- **Independent agents**: Same logic as today — check `interval`, `time_of_day`, `app_startup` schedule conditions.
- **`run_after` agents**: Don't check schedule. When an upstream agent completes, check if all of this agent's `runAfter` dependencies have completed in the current cycle.
  - If all succeeded: trigger the agent.
  - If any failed and `runOnUpstreamFailure` is true: trigger the agent.
  - If any failed and `runOnUpstreamFailure` is false: mark this agent as `skipped`. Any agents depending on this one are also skipped (cascade).

### Working Directory

- `isolation.enabled = false`: `cwd` is the automation's `projectPath` (same as today)
- `isolation.enabled = true`: `cwd` is `isolation.clonePath`

### Concurrency

The existing `maxConcurrentRuns` queue applies globally across all agents from all automations. An agent from automation A and an agent from automation B both count toward the limit.

### Clone Setup (triggered on save)

For each agent with `isolation.enabled = true` and no existing `clonePath`:

1. Read remote URL from the project's `.git/config` via `git remote get-url origin`
2. Build target path: `<agentReposBaseDir>/<project-name>/<agent-name>/`
3. `git clone <remote-url> <target-path>`
4. If no remote configured, fall back to `git clone <projectPath> <target-path>` and warn the user
5. Store the resolved path in `isolation.clonePath`

### Pre-run Pull

Before each run of an isolated agent:

```
cd <clonePath>
git checkout master
git pull origin master
```

If pull fails, mark agent as errored. Do not proceed with the run.

## UI Changes

### Tab Rename

"Loops" becomes "Automations" everywhere — tab label, CSS classes, IPC channel names, flyout header.

### Creation Modal (3 stages)

**Stage 1 — Simple mode (default):**
Opens as today's loop modal. Fields: name, prompt, schedule, permissions, database. An "+ Add Agent" link at the bottom.

**Stage 2 — Multi-agent mode:**
Clicking "+ Add Agent" transforms the modal:
- The original fields become "Agent 1" in a collapsible card
- A new automation-level name field appears at the top
- Each agent card has:
  - Name
  - Prompt
  - Run mode toggle: Independent / Run after (with agent picker — multi-select chips)
  - Repo isolation checkbox (shows predicted clone path when checked)
  - Schedule (only shown for independent agents)
  - Permissions, database (same as today)
- Cards are collapsible. Collapsed header shows: name, run mode badge, isolation badge, schedule summary.
- "+ Add Agent" button below the last card. "Remove" button per card.

**Stage 3 — Setup phase:**
"Save & Setup" triggers cloning for isolated agents. A progress panel shows:
- Per-agent status: checkmark (done), spinner (cloning), circle (waiting)
- Live git clone output in a log pane
- Completes to the detail view

### List View (Automations tab)

- **Simple automations**: Same card as current loops — name, schedule, status badge, last summary
- **Multi-agent automations**: Card shows agent count, dependency summary ("4 agents, 2 independent, 2 chained"), and a mini pipeline visualization — colored dots per agent showing running (pulsing blue), idle (green), error (red), waiting (grey), with arrows between dependent agents

### Detail View

- **Simple automations**: Same as today's loop detail — output pane, run selector dropdown, attention items
- **Multi-agent automations**: Pipeline view with:
  - "Run All" and "Pause All" controls at the top
  - Vertical list of agents with colored left border (blue=running, green=idle, red=error, grey=waiting)
  - Connectors between dependent agents with dependency labels ("waits for both above")
  - Per-agent: status, run mode, schedule, last summary, "View Output" and "History" links
  - Clicking "View Output" opens the same output pane as today's loop detail, scoped to that agent

### Flyout

Rename to "Automations". Same grouped-by-project layout. Multi-agent automations show the mini pipeline dots. Global pause/resume stays.

### Settings

New field in app settings: "Agent repos directory" — text input with folder picker for `agentReposBaseDir`.

## IPC API

### Renamed Channels

All `loops:*` channels become `automations:*`.

### New/Changed Methods (renderer to main)

| Method | Description |
|--------|-------------|
| `createAutomation(config)` | Create automation with agents array |
| `updateAutomation(automationId, updates)` | Update automation-level fields |
| `updateAgent(automationId, agentId, updates)` | Update a single agent |
| `addAgent(automationId, agentConfig)` | Add agent to existing automation |
| `removeAgent(automationId, agentId)` | Remove agent, clean up clone if isolated |
| `runAgentNow(automationId, agentId)` | Trigger a single agent |
| `runAutomationNow(automationId)` | Trigger all independent agents (cascades to dependents) |
| `toggleAutomation(automationId)` | Enable/disable entire automation |
| `toggleAgent(automationId, agentId)` | Enable/disable single agent |
| `toggleAutomationsGlobal()` | Master pause/resume |
| `getAutomations()` | Returns full config |
| `getAutomationsForProject(projectPath)` | Returns automations for a project |
| `getAgentHistory(automationId, agentId, count)` | Run history for an agent |
| `getAgentRunDetail(automationId, agentId, startedAt)` | Single run detail |
| `getAgentLiveOutput(automationId, agentId)` | Live output stream |
| `setupAgentClone(automationId, agentId)` | Trigger git clone for an isolated agent |
| `getCloneStatus(automationId)` | Setup progress for all agents |
| `exportAutomations(projectPath)` | Export all automations for a project |
| `exportAutomation(automationId)` | Export single automation |
| `importAutomations(projectPath)` | Import from JSON file |

### Events (main to renderer)

| Event | Payload |
|-------|---------|
| `automations:agent-started` | `{automationId, agentId}` |
| `automations:agent-completed` | `{automationId, agentId, status, summary, attentionItems, exitCode}` |
| `automations:agent-output` | `{automationId, agentId, chunk}` |
| `automations:clone-progress` | `{automationId, agentId, line}` |

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Clone directory already exists with correct remote | Skip cloning, reuse it |
| Clone directory exists but is wrong content | Warn user, ask them to resolve |
| Clone directory deleted externally | Mark agent errored: "Working directory not found — run setup again". Show "Re-clone" action in UI |
| Circular dependencies in `runAfter` | Reject on save with error in modal. Simple cycle detection on the dependency graph |
| Removing an agent that others depend on | Warn in modal. Offer to convert dependent agents to independent, or cancel removal |
| Agent repos base directory changed in settings | Existing clones stay where they are. Only new clones use the new path |
| All upstream agents skipped/failed with `runOnUpstreamFailure=false` | Agent marked as `skipped`. Cascade stops — agents depending on this one are also skipped |
| Git pull fails before isolated agent run | Mark agent as errored. Do not proceed with the run |
| No git remote configured on project | Fall back to `git clone <localPath>`, warn user that clone's origin points to local directory |
