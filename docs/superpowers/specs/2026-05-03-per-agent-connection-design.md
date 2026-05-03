# Per-agent connection & model selection for automations

**Status:** approved (verbal, 2026-05-03)
**Scope:** small, self-contained — straight to dev after the implementation plan.

## Problem

Automations always run against the cloud (Anthropic) endpoint with the CLI's
default model. Users now have local-endpoint presets (LM Studio, Ollama, etc.)
configured via the Endpoint Presets modal, but those presets cannot be selected
for automated runs. There's no way to mix local + cloud agents in the same
automation, and no visible indication of what connection a headless run is
using.

## Requirements

1. Each agent card in the automation modal gets a **connection picker** below
   its schedule, with a **model picker** that swaps options based on the
   selected connection. Mirrors the spawn-dropdown UX.
2. Default for both new and migrated agents is **Cloud (Anthropic)** with no
   model override (i.e. current behaviour — fully backward-compatible).
3. The agent's saved connection + model is honoured when the automation runs,
   whether kicked off by schedule, by "Run Now", or by the manager agent.
4. Both the **automation card in the Automations panel** and the **headless
   dock row** show a small **connection name tag** (e.g. `Cloud`, `LM Studio`)
   so the user can see at a glance what each run is running on. Tag only — no
   model in the tag (model is visible inside the expanded agent card).

## Non-goals

- No per-agent endpoint *creation*. Connections are still managed in the
  existing Endpoint Presets modal.
- No mid-run connection switching.
- No automatic fallback (cloud → local or vice-versa) on failure.
- No bulk "set all agents to X" affordance — agents are independent.

## UI

### Agent card (in automation modal)

New section directly under `.agent-schedule-section`:

```
Connection
[ Cloud (Anthropic)            ▼ ]   ← default
Model
[ Default                      ▼ ]   ← cloud model list when connection=Cloud
                                      endpoint model list (+ ↻) when local
```

Layout matches the existing spawn-dropdown rows: label above, single-row
control. The model row gets a refresh button (↻) only when a local connection
is selected, identical to `#opt-endpoint-model-refresh` in the spawn dropdown.

### Connection tag

Small chip rendered next to the agent name on:
- Automation card collapsed/expanded view in the Automations panel
- Headless dock list row

Format: connection name only. Cloud uses the existing
`endpoint-banner-tag--cloud` style; local uses `endpoint-banner-tag--local`.
Tag is omitted when there are zero local presets configured (no point flagging
"Cloud" if cloud is the only option).

## Data model

Each agent gains two optional fields (mirrors the per-column spawn options
already persisted on tabs):

```js
agent = {
  // ... existing fields
  endpointId: null | string,    // null = cloud (Anthropic)
  endpointModel: null | string  // null = use default for the connection
}
```

Migration: missing fields → treat as `null`/`null` (cloud + default model).
No write-time migration needed; reads coalesce to defaults.

If an agent's saved `endpointId` no longer matches a known preset (deleted or
renamed), silently fall back to cloud, exactly as `applyEndpointSelection`
already does for per-project state at `renderer.js:5912-5914`.

## Run-time wiring

The main process already exposes `endpoint:getEnv` (`main.js:756`) which
returns the env block for a given preset id, with optional model override. The
automation runner needs to:

1. Look up the agent's `endpointId` and `endpointModel`.
2. If `endpointId` is set, call `endpoint:getEnv(id, model)` and merge the
   returned env into the spawn env.
3. If `endpointId` is null, no env override (cloud default).
4. If the agent's `endpointModel` is set and `endpointId` is null (cloud),
   pass `--model <value>` as a CLI arg, exactly like the spawn flow at
   `renderer.js:5820-5823`.
5. If the endpoint env carries `ANTHROPIC_CUSTOM_HEADERS`, force `--bare`
   exactly like the spawn flow at `renderer.js:5807-5808`.

Where the runner lives is in `main.js` (automations are scheduled there); the
helpers above are renderer-side, but the env block itself is computed in main
already, so the path is: runner reads agent.endpointId → calls the same env
builder used by `endpoint:getEnv`.

## Edge cases

- **No local presets configured:** Connection picker still renders but
  contains only "Cloud (Anthropic)". Tag is suppressed (see UI).
- **Preset deleted while automation exists:** Fall back to cloud at run time.
  Card UI shows cloud as selected next time it's opened.
- **User refreshes models on a local preset:** Existing `endpoint-models-cache`
  keyed by preset id (`renderer.js:57`) is reused — no separate cache for
  agent cards.
- **Switching connection in the card:** Reset the model select to the new
  connection's default. Don't try to map the old model name onto the new list.
- **Multi-agent with mixed connections:** Each agent runs with its own env
  block; nothing shared.

## Files touched (estimate)

- `index.html` — agent card template (added by JS, but the modal HTML around
  it may need a tweak); minor.
- `renderer.js` — agent card render + bind (`renderHeadlessDock`,
  `renderAgentCardBody`-equivalent), `saveAutomation`, automation-card render,
  headless dock row render. Largest set of edits but all localised.
- `main.js` — automation runner: read agent connection fields, compose env +
  CLI args before spawn.
- `styles.css` — reuse existing endpoint-banner tag classes; add a
  `.agent-card-connection-tag` if styling needs to differ in the dock.

## Out of scope reminders

- No spec doc for the headless-dock chip — fold into the same change.
- No new IPC: existing `endpoint:getEnv` covers the runner's needs.
- No telemetry / logging additions.
