# Automation Manager Agent

An optional supervisory agent that sits outside an automation's pipeline, autonomously investigates failures, takes corrective action where possible, and escalates to the human only when it genuinely needs help — surfaced via Windows notifications and a clear "Needs You" indicator in the UI.

## Problem

Multi-agent automations run in the background as an automated dev team. When a pipeline fails partway through, there's no one watching. The user has to notice, open each agent's output, piece together what happened, and manually intervene. This breaks the autonomy model — the whole point is that these agents work while the user does other things.

## Solution

Each automation can optionally have a **Manager Agent** — a dedicated Claude instance that:

1. **Runs autonomously first** — when triggered, it investigates failures, analyses outputs, and attempts resolution (re-running failed agents, diagnosing root causes in the codebase/database)
2. **Has full tooling access** — codebase access (runs in the project directory), optional database access (same MCP config as other agents), and the ability to re-run agents programmatically
3. **Escalates only when stuck** — if it can resolve the issue, it does so silently (logging what it did). If it needs human input, it sends a Windows notification and marks the automation as "Needs You"
4. **Becomes interactive on escalation** — the user clicks the notification or the "Needs You" indicator, which opens an interactive terminal with the manager. Full context is already loaded; the user picks up where the manager left off

The manager is NOT part of the pipeline dependency chain. It observes, investigates, and supervises.

## Execution Model: Two Phases

### Phase 1: Autonomous Investigation (headless)

When triggered, the manager runs as a **background `--print` job** (same as other agents) with:
- Full pipeline report as context
- Database access (if configured)
- Codebase access (runs in project directory)
- `--dangerously-skip-permissions` (if the automation uses it)
- A structured prompt that instructs it to investigate, diagnose, and attempt resolution

The manager's autonomous prompt includes instructions to:
1. Analyse all agent outputs and identify failures
2. Investigate root causes using the codebase and database
3. Attempt resolution (e.g., re-running failed agents if the failure was transient)
4. Report findings in a structured format

The manager outputs a structured result block (same `:::loop-result` format as agents):

```json
{
  "summary": "Triage Agent failed due to MongoDB timeout. Verified DB is responsive now. Re-running.",
  "attentionItems": [],
  "actions": [
    { "type": "rerun_agent", "agentId": "agent_xyz" }
  ],
  "needsHuman": false
}
```

OR when it needs human help:

```json
{
  "summary": "Bug Resolution Agent created a branch with merge conflicts. Cannot resolve automatically.",
  "attentionItems": [
    { "summary": "Merge conflict in src/auth.js needs manual resolution", "detail": "Branch hotfix/triage1-142 conflicts with recent master changes in the auth middleware." }
  ],
  "actions": [],
  "needsHuman": true,
  "humanContext": "I've diagnosed the issue. The hotfix branch conflicts with commit abc123. I need you to resolve the conflict in src/auth.js — specifically the session token handling on lines 45-62. Once resolved, I can re-run the Bug Resolution Agent."
}
```

### Phase 2: Interactive Escalation (terminal)

If `needsHuman: true`, the system:
1. Sends a **Windows notification**: "Automation Manager needs your attention: {summary}"
2. Marks the automation with a **"Needs You"** badge in the UI (sidebar, flyout, detail view)
3. Flashes the taskbar
4. Stores the `humanContext` for when the user opens the terminal

When the user clicks the notification or the "Needs You" badge:
1. An interactive terminal column spawns with the full manager context + the `humanContext` message
2. The user can discuss, give instructions, and the manager can execute
3. The terminal has re-run buttons: "Re-run All", "Re-run Failed"
4. Once the user is done, they close the terminal and the badge clears

### Phase 1 Actions

The manager can take these actions autonomously (parsed from its output):

| Action | Description | Implementation |
|--------|-------------|----------------|
| `rerun_agent` | Re-run a specific failed agent | Call `runAgent(automationId, agentId)` from main.js |
| `rerun_all` | Re-run the full pipeline | Call `runAutomationNow(automationId)` |
| `report` | Log findings without action | Save to manager run history |

Actions are executed by the backend after parsing the manager's output (same pattern as `parseAgentResult`). The manager does NOT have MCP tools to call IPC — it outputs structured commands that the execution engine interprets.

## Data Model

### Automation-level manager config

Added to each automation object in `automations.json`:

```json
{
  "id": "auto_abc123",
  "name": "TaskBoard Pipeline",
  "agents": [...],
  "manager": {
    "enabled": false,
    "prompt": "You are the manager of the TaskBoard Pipeline...",
    "triggerOn": "failure",
    "includeFullOutput": false,
    "skipPermissions": false,
    "dbConnectionString": null,
    "dbReadOnly": true,
    "maxRetries": 1,
    "lastRunAt": null,
    "lastRunStatus": null,
    "lastSummary": null,
    "needsHuman": false,
    "humanContext": null
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Whether this automation has a manager |
| `prompt` | string | `""` | Custom instructions appended to the auto-generated investigation prompt |
| `triggerOn` | `"always"` \| `"failure"` \| `"manual"` | `"failure"` | When to auto-run the manager |
| `includeFullOutput` | boolean | `false` | Include full agent output vs summaries only |
| `skipPermissions` | boolean | `false` | Whether the manager runs with `--dangerously-skip-permissions` |
| `dbConnectionString` | string \| null | `null` | MongoDB connection string for manager's database access |
| `dbReadOnly` | boolean | `true` | Read-only database constraint |
| `maxRetries` | number | `1` | How many times the manager can re-run failed agents before escalating |
| `lastRunAt` | timestamp \| null | `null` | When the manager last ran |
| `lastRunStatus` | string \| null | `null` | `"resolved"`, `"escalated"`, `"error"` |
| `lastSummary` | string \| null | `null` | Manager's last summary |
| `needsHuman` | boolean | `false` | Whether the manager is waiting for human input |
| `humanContext` | string \| null | `null` | Context message for the human when escalated |

### Manager run history

Stored alongside agent runs: `~/.claudes/automation-runs/{automationId}/_manager/`

Same format as agent run files but with additional `actions` and `needsHuman` fields.

## Trigger Logic

### Pipeline completion detection

Done in `main.js` after `triggerDependentAgents()` in the `runAgent` close handler. After updating the agent state:

```
After agent completes:
  1. Re-read automation data
  2. Check: are ALL agents in a terminal state? (no currentRunStartedAt set)
  3. Check: did at least one agent run? (any lastRunStatus set)
  4. If not all done → return (more agents still running/pending)
  5. Pipeline is complete. Check manager config:
     - manager not enabled → return
     - manager already running → return
     - triggerOn === "manual" → return
     - triggerOn === "always" → run manager
     - triggerOn === "failure" → run manager only if any agent errored/skipped
```

This check happens in `main.js` (not renderer) so it works even if the UI isn't focused.

### Manager execution

The manager runs via a new `runManager(automationId)` function in `main.js` that:
1. Builds the context prompt (pipeline report + agent results)
2. Spawns Claude CLI with `--print` (headless)
3. Parses the structured output
4. Executes any actions (re-run agents)
5. If `needsHuman` → sets `manager.needsHuman = true`, saves `humanContext`, sends Windows notification, sends IPC event to renderer
6. If resolved → sets `manager.lastRunStatus = 'resolved'`, sends IPC event

### Re-run tracking

The manager tracks how many times it has re-run agents for the current pipeline cycle via a transient counter. If it exceeds `maxRetries`, it escalates to human rather than looping.

## Manager Prompt Template

The autonomous investigation prompt sent to Claude CLI:

```
You are the Automation Manager for "{automation.name}".

A pipeline run has just completed. Your job is to:
1. Review all agent results below
2. Identify any failures or issues
3. Investigate root causes using the codebase and database
4. Take corrective action if possible (re-running agents, etc.)
5. Escalate to the human ONLY if you cannot resolve the issue

PIPELINE REPORT:
{structured report of all agents, their status, summaries, errors, attention items}

RULES:
- If an agent failed due to a transient error (timeout, network issue), re-run it
- If an agent failed due to a code or data issue, investigate the root cause
- Do NOT re-run an agent more than {maxRetries} time(s)
- If you cannot resolve the issue, set needsHuman to true and provide clear context for the human
- Always explain what you found and what you did

{manager.prompt}

End your response with:
:::manager-result
{
  "summary": "Brief description of what happened and what you did",
  "attentionItems": [{"summary": "...", "detail": "..."}],
  "actions": [{"type": "rerun_agent", "agentId": "..."} or {"type": "rerun_all"} or {"type": "report"}],
  "needsHuman": false,
  "humanContext": "Only set this if needsHuman is true. Explain exactly what you need from the human."
}
:::manager-result
```

## UI Changes

### 1. Creation Modal — Manager Section

After the agent cards and "+ Add Agent" button, before the footer:

```
--- Manager ---
[x] Enable Automation Manager

  Manager Prompt (optional)
  [textarea: Additional instructions for the manager...]

  Trigger: [On failure v]     Max retries: [1]

  [ ] Include full agent output (increases cost)

  Database (optional)
  [mongodb+srv://...]
  [x] Read-only

  Permissions
  [ ] Skip permissions
```

Only visible when 2+ agents exist. Checkbox toggles the section.

### 2. Pipeline Detail View — Manager Status

In `renderMultiAgentDetail`, add a manager status row:

**When idle (no issues):**
```
[Run All]  [Pause]  [Manager: idle]
```

**When manager is investigating (running):**
```
[Run All]  [Pause]  [Manager: investigating...]
```
With a pulsing blue indicator.

**When manager needs human (escalated):**
```
[Run All]  [Pause]  [Manager: Needs You ⚠]
```
The "Needs You" button pulses amber. Clicking it spawns the interactive terminal with the manager's `humanContext` pre-loaded.

**When manager resolved the issue:**
```
[Run All]  [Pause]  [Manager: resolved ✓]
```
Clicking shows the manager's summary.

### 3. Interactive Terminal (on escalation)

When the user clicks "Needs You":
- A terminal column spawns with title: "{automation.name} Manager"
- System prompt contains the full pipeline report + the manager's investigation findings + `humanContext`
- The terminal has a toolbar: `[Re-run All] [Re-run Failed] [Dismiss]`
- Dismiss clears the `needsHuman` flag and closes the badge

### 4. Windows Notification

When `needsHuman: true`:
```
Title: "Automation Manager — {automation.name}"
Body: "{manager summary — first 100 chars}"
Click action: Focus Claudes window, open the automation detail, highlight manager badge
```

Uses Electron's `Notification` API. Only fires if the window is not focused.

### 5. Sidebar / Flyout Indicators

- Sidebar project badge: amber dot when any automation's manager `needsHuman` is true
- Flyout row: "Needs You" badge next to automation name
- Both clear when the user dismisses or the manager resolves on a re-run

## IPC / API

### New IPC handlers

| Channel | Direction | Description |
|---------|-----------|-------------|
| `automations:runManager` | renderer → main | Manually trigger the manager for an automation |
| `automations:dismissManager` | renderer → main | Clear `needsHuman` flag and `humanContext` |
| `automations:getManagerStatus` | renderer → main | Get current manager state for an automation |

### New IPC events

| Event | Direction | Description |
|-------|-----------|-------------|
| `automations:manager-started` | main → renderer | Manager investigation has begun |
| `automations:manager-completed` | main → renderer | Manager finished. Payload includes `needsHuman`, `summary`, `actions` |

### Updated handlers

| Channel | Change |
|---------|--------|
| `automations:update` | Add `manager` to safe fields |
| `automations:create` | Accept `manager` config in automation creation |

## Implementation Notes

### `runManager(automationId)` in main.js

New function, similar to `runAgent()` but:
- Uses the automation's `projectPath` as cwd (manager always runs in the main project, not an isolated clone)
- Builds context from ALL agents' results
- Parses `:::manager-result` block (new parser, similar to `parseAgentResult`)
- Executes actions: `rerun_agent` calls `runAgent()`, `rerun_all` calls the existing `runAutomationNow` logic
- Updates `manager.*` fields in automation config
- Sends Windows notification if `needsHuman`
- Saves run to `automation-runs/{automationId}/_manager/`

### `parseManagerResult(output)` in main.js

Similar to `parseAgentResult` but parses `:::manager-result` markers and extracts `actions`, `needsHuman`, `humanContext` fields in addition to `summary` and `attentionItems`.

### Pipeline completion detection

Add to the end of `runAgent()`'s close handler, after `triggerDependentAgents()`:

```javascript
// Check if pipeline is fully complete and trigger manager
checkPipelineComplete(automationId);
```

Where `checkPipelineComplete` is a debounced function (2s) that reads the automation, checks all agents are in terminal state, and calls `runManager()` if conditions are met.

### Windows notification

```javascript
const { Notification } = require('electron');

function sendManagerNotification(automation, summary) {
  if (mainWindow && mainWindow.isFocused()) return; // Don't notify if already focused
  const notif = new Notification({
    title: 'Automation Manager — ' + automation.name,
    body: summary.substring(0, 100),
    icon: path.join(__dirname, 'icon.png')
  });
  notif.on('click', () => {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('automations:focus-manager', { automationId: automation.id });
  });
  notif.show();
}
```

### Database access for manager

Same MCP config pattern as agents. If `manager.dbConnectionString` is set, generate a temp MCP config file and pass `--mcp-config` to the CLI. Apply the same read-only constraints and allowed tools list.

## Migration

No migration needed. The `manager` field is optional. Automations without it are treated as `manager: { enabled: false }`. All defaults are applied in code.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Manager fails (CLI error) | Set `lastRunStatus: 'error'`, send notification, mark needsHuman |
| Manager re-runs an agent that fails again | Increment retry counter. If exceeds `maxRetries`, escalate to human |
| Manager already running when triggered again | Skip (only one manager run at a time per automation) |
| User dismisses manager without resolving | Clear `needsHuman`. Next pipeline failure will re-trigger |
| Manager terminal open when pipeline re-runs | Keep terminal open. After new completion, send fresh context as new message |
| Automation deleted while manager is running | Kill manager process (same as `stopAutomationScheduler` cleanup) |

## Security

- Manager runs with the same permission level as the automation's agents
- Database access is independently configurable (manager may need DB access even if no agents do, or vice versa)
- The manager cannot modify automation config — it can only re-run existing agents with their existing settings
- Re-run actions are logged in manager run history for audit
