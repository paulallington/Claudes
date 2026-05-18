# Per-agent connection & model selection — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-agent connection (cloud/local) and model selection to the automation modal, mirror the spawn-dropdown UX, persist on the agent, honour at run time, and surface a connection-name tag on automation cards and headless-dock rows.

**Architecture:** Two new fields on each agent (`endpointId`, `endpointModel`). UI rendered inside the existing agent card under the schedule section. Run-time wiring reads the agent's connection (with safe fallback to the project's setting if the agent predates this change) and swaps the env block / `--model` arg passed to `spawnHeadlessClaude`. Tags reuse the existing `endpoint-banner-tag--cloud` / `endpoint-banner-tag--local` styles.

**Tech Stack:** vanilla JS renderer, Electron main, no new deps.

---

## Task 1 — Renderer-side helpers and connection picker HTML

**Files:**
- Modify: `renderer.js:8540` area (`renderAgentCard`)

- [ ] **Step 1:** Add a helper above `renderAgentCard` that renders the connection picker HTML for an agent. It returns the markup for the connection select + model select + refresh button, defaulting to cloud when `agent.endpointId` is null/undefined.

```js
function renderAgentConnectionSection(agent) {
  var selectedId = (agent && agent.endpointId) || '';
  var selectedModel = (agent && agent.endpointModel) || '';

  // Connection options: Cloud + each preset
  var connOpts = '<option value=""' + (selectedId === '' ? ' selected' : '') + '>Cloud (Anthropic)</option>';
  endpointPresets.forEach(function (p) {
    connOpts += '<option value="' + escapeHtml(p.id) + '"' + (selectedId === p.id ? ' selected' : '') + '>' + escapeHtml(p.name || '(unnamed)') + '</option>';
  });

  // Model options depend on selected connection
  var modelOpts;
  var refreshBtn = '';
  if (!selectedId) {
    // Cloud: fixed list mirroring spawn dropdown #opt-model
    var cloudModels = [
      { v: '', t: 'Default' },
      { v: 'sonnet', t: 'Sonnet (latest)' },
      { v: 'opus', t: 'Opus (latest)' },
      { v: 'haiku', t: 'Haiku (latest)' }
    ];
    modelOpts = cloudModels.map(function (m) {
      return '<option value="' + m.v + '"' + (selectedModel === m.v ? ' selected' : '') + '>' + m.t + '</option>';
    }).join('');
  } else {
    // Local: cached models for this preset, or just the current value as a placeholder
    var cached = endpointModelsCache[selectedId];
    var preset = endpointPresets.find(function (p) { return p.id === selectedId; });
    var defaultModel = preset ? (preset.model || '') : '';
    var models = (cached && cached.models) ? cached.models.slice() : [];
    if (defaultModel && models.indexOf(defaultModel) === -1) models.unshift(defaultModel);
    if (selectedModel && models.indexOf(selectedModel) === -1) models.unshift(selectedModel);
    if (models.length === 0) models = [defaultModel || ''];
    modelOpts = models.map(function (m) {
      return '<option value="' + escapeHtml(m) + '"' + (selectedModel === m || (!selectedModel && m === defaultModel) ? ' selected' : '') + '>' + escapeHtml(m || '(default)') + '</option>';
    }).join('');
    refreshBtn = '<button type="button" class="agent-endpoint-model-refresh spawn-icon-btn" title="Re-fetch loaded models from endpoint">&#8634;</button>';
  }

  return '<div class="automation-form-group agent-connection-group">' +
    '<label>Connection</label>' +
    '<select class="agent-endpoint">' + connOpts + '</select>' +
    '</div>' +
    '<div class="automation-form-group agent-model-group">' +
    '<label>Model</label>' +
    '<div class="automation-schedule-row">' +
      '<select class="agent-endpoint-model">' + modelOpts + '</select>' +
      refreshBtn +
    '</div>' +
    '</div>';
}
```

- [ ] **Step 2:** Inject the section into `renderAgentCard` at the end of the agent body, right before the Database group. Locate the line in `renderAgentCard` that starts with `'<div class="automation-form-group">' + '<label>Database` (around `renderer.js:8685`) and insert `renderAgentConnectionSection(agent) +` immediately above it.

- [ ] **Step 3:** Run `npm start`, open Automations panel, edit an existing automation. Confirm the new Connection + Model controls render correctly under the schedule section. Cloud should be the default selection, and the model dropdown should show the four cloud options.

- [ ] **Step 4:** Commit.

```bash
git add renderer.js
git commit -m "feat(automations): per-agent connection picker UI"
```

---

## Task 2 — Bind connection-change to swap the model dropdown

**Files:**
- Modify: `renderer.js` — `bindAgentCardEvents` (find via `function bindAgentCardEvents(card, agentIndex)` near `renderer.js:8732`).

- [ ] **Step 1:** Add a helper that, given a card, replaces the model-select container based on the currently-selected connection. Place it next to the other helpers (above `bindAgentCardEvents`).

```js
function refreshAgentModelDropdown(card, endpointId) {
  var modelGroup = card.querySelector('.agent-model-group');
  if (!modelGroup) return;
  // Build a temp agent stub to reuse the section renderer's model logic.
  var stubAgent = { endpointId: endpointId || null, endpointModel: null };
  // Render only the model-group portion: render the whole connection section
  // and pluck the model-group out of it.
  var temp = document.createElement('div');
  temp.innerHTML = renderAgentConnectionSection(stubAgent);
  var newModelGroup = temp.querySelector('.agent-model-group');
  if (newModelGroup) modelGroup.replaceWith(newModelGroup);
}
```

- [ ] **Step 2:** In `bindAgentCardEvents`, near the bottom (after schedule binds), bind change on `.agent-endpoint`:

```js
var epSelect = card.querySelector('.agent-endpoint');
if (epSelect) {
  epSelect.addEventListener('change', function () {
    refreshAgentModelDropdown(card, epSelect.value);
  });
}
var refreshBtn = card.querySelector('.agent-endpoint-model-refresh');
// Live-bind a delegated handler on the card for the refresh button — it gets
// re-created when the user changes connection, so a captured ref would go stale.
card.addEventListener('click', function (e) {
  if (!e.target.classList.contains('agent-endpoint-model-refresh')) return;
  var ep = card.querySelector('.agent-endpoint');
  if (!ep || !ep.value) return;
  var preset = endpointPresets.find(function (p) { return p.id === ep.value; });
  if (!preset) return;
  // Reuse main-process fetcher
  if (!window.electronAPI || !window.electronAPI.endpointFetchModels) return;
  var btn = e.target;
  btn.textContent = '…';
  window.electronAPI.endpointFetchModels({ baseUrl: preset.baseUrl, authToken: '' }).then(function (result) {
    btn.innerHTML = '&#8634;';
    if (!result || !result.ok || !result.models || result.models.length === 0) return;
    endpointModelsCache[preset.id] = { models: result.models, fetchedAt: Date.now(), ok: true };
    refreshAgentModelDropdown(card, ep.value);
  }).catch(function () { btn.innerHTML = '&#8634;'; });
});
```

> Note: `endpointFetchModels` in main reads creds from the args; we pass empty token because the renderer doesn't have the decrypted token. The endpoint preset's stored token is used by the *runner*, not the model-list fetcher — for the model-list fetch we rely on the renderer-side cache filled from earlier endpoint-modal use, OR send empty creds (works for unauthenticated local servers like LM Studio). For ngrok-protected endpoints the cache will already be populated from the Endpoint Presets modal.

- [ ] **Step 3:** Test in dev app: change connection from Cloud → a local preset, model dropdown should swap to cached/default models. Click ↻ — for an unauthenticated endpoint this should refresh; for an authenticated one it'll silently no-op (models stay cached).

- [ ] **Step 4:** Commit.

```bash
git add renderer.js
git commit -m "feat(automations): swap model dropdown on connection change"
```

---

## Task 3 — Persist endpointId/endpointModel on save

**Files:**
- Modify: `renderer.js` — `syncAgentFromCard` (around `renderer.js:8939`), and the new-agent default in `openAutomationModal` (around `renderer.js:8438`).

- [ ] **Step 1:** In `syncAgentFromCard`, after the `dbReadOnly` line (around `renderer.js:8960`), add:

```js
var epEl = card.querySelector('.agent-endpoint');
agent.endpointId = (epEl && epEl.value) ? epEl.value : null;
var epModelEl = card.querySelector('.agent-endpoint-model');
agent.endpointModel = (epModelEl && epModelEl.value) ? epModelEl.value : null;
```

- [ ] **Step 2:** In `openAutomationModal`, in the new-agent default (the `modalAgents = [{ ... }]` line around `renderer.js:8438`), add `endpointId: null, endpointModel: null` to the object literal.

- [ ] **Step 3:** Test: in dev app, edit an automation, change its connection to a local preset, save. Reopen — confirm the connection is persisted. Switch back to Cloud, save, reopen — confirm it's saved as Cloud.

- [ ] **Step 4:** Commit.

```bash
git add renderer.js
git commit -m "feat(automations): persist per-agent endpointId/endpointModel"
```

---

## Task 4 — Honour the agent's endpoint at run time

**Files:**
- Modify: `main.js` — `runAgent` (around `main.js:3252`), and the manager runner around `main.js:3677`.

- [ ] **Step 1:** Above `runAgent`, add a small helper:

```js
// Resolve which endpoint env to use for an agent. Falls back to the project's
// configured endpoint for legacy agents that pre-date the per-agent picker
// (so we don't silently switch a user's running automations to cloud).
function getAgentEndpointEnv(agent, projectPath) {
  if (agent && agent.endpointId !== undefined) {
    // Explicit pick (including null = cloud)
    if (!agent.endpointId) return null;
    return buildEndpointEnv(agent.endpointId, agent.endpointModel || null);
  }
  // Legacy: agent has no endpointId field — keep current project-inherited behaviour
  return getProjectEndpointEnvByPath(projectPath);
}
```

- [ ] **Step 2:** In `runAgent`, change the `env:` line in the `spawnHeadlessClaude` call (around `main.js:3389`) from:

```js
env: getProjectEndpointEnvByPath(automation.projectPath),
```

to:

```js
env: getAgentEndpointEnv(agent, automation.projectPath),
```

- [ ] **Step 3:** In the manager runner around `main.js:3677`, change `getProjectEndpointEnvByPath(automation.projectPath)` to use the manager's own endpoint if set: leave as project-inherited for now (manager is a separate concern, out of scope). No change unless the manager flow shares the agent's endpoint — confirm by reading lines 3670-3690 and skip if it's its own thing.

- [ ] **Step 4:** Test: configure an agent to use a local preset, click Run Now. Verify (via terminal output or console logs in main) that the local endpoint env is applied. Configure another agent on Cloud, run it, verify cloud env path.

- [ ] **Step 5:** Commit.

```bash
git add main.js
git commit -m "feat(automations): honour per-agent endpoint at run time"
```

---

## Task 5 — Connection tag on automation cards in the panel

**Files:**
- Modify: `renderer.js` around `renderer.js:7790` (simple-card branch) and `renderer.js:7824` (multi-agent card branch).
- Modify: `styles.css` — add a small chip class.

- [ ] **Step 1:** Above the simple-card render, compute the tag once:

```js
var connTag = (function () {
  if (endpointPresets.length === 0) return '';
  var ag = automation.agents[0];
  if (!ag || !ag.endpointId) return '<span class="automation-card-conn-tag automation-card-conn-tag--cloud">Cloud</span>';
  var preset = endpointPresets.find(function (p) { return p.id === ag.endpointId; });
  return '<span class="automation-card-conn-tag automation-card-conn-tag--local">' + escapeHtml(preset ? preset.name : 'local') + '</span>';
})();
```

Insert `connTag` into the simple-card header right after the name span:

```js
card.innerHTML = '<div class="automation-card-header">' +
  '<span class="automation-card-name">' + escapeHtml(agent.name) + '</span>' +
  connTag +
  '<span class="automation-card-schedule">' + schedText + '</span>' +
  '</div>' +
  ...
```

- [ ] **Step 2:** Multi-agent card: a single tag doesn't make sense if agents have different connections, so build a deduped set. Above `card.innerHTML = '<div class="automation-card-header">' +` for the multi-agent branch:

```js
var connNames = {};
automation.agents.forEach(function (ag) {
  if (!ag.endpointId) connNames['Cloud'] = 'cloud';
  else {
    var p = endpointPresets.find(function (pp) { return pp.id === ag.endpointId; });
    if (p) connNames[p.name] = 'local';
  }
});
var connTagHtml = '';
if (endpointPresets.length > 0) {
  Object.keys(connNames).forEach(function (n) {
    connTagHtml += '<span class="automation-card-conn-tag automation-card-conn-tag--' + connNames[n] + '">' + escapeHtml(n) + '</span>';
  });
}
```

Insert `connTagHtml` after the name span in the multi-agent header.

- [ ] **Step 3:** Add CSS. Append to `styles.css`:

```css
.automation-card-conn-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  margin-left: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
  vertical-align: middle;
}
.automation-card-conn-tag--cloud {
  background: rgba(100, 210, 255, 0.15);
  color: var(--color-cyan, #64d2ff);
  border: 1px solid rgba(100, 210, 255, 0.4);
}
.automation-card-conn-tag--local {
  background: rgba(255, 165, 0, 0.15);
  color: #ffa500;
  border: 1px solid rgba(255, 165, 0, 0.4);
}
```

- [ ] **Step 4:** Test: with local presets configured, automation cards show the tag. Without any local presets, no tag shows.

- [ ] **Step 5:** Commit.

```bash
git add renderer.js styles.css
git commit -m "feat(automations): connection-name tag on automation cards"
```

---

## Task 6 — Connection tag on headless dock rows

**Files:**
- Modify: `renderer.js` `renderHeadlessDock` (around `renderer.js:170`).

- [ ] **Step 1:** A headless run record may have come from the dock's prompt input or from an automation. The run record (`r`) is what the dock shows. We need its connection info. Run records currently have `runId, status, title, startedAt`. To know the connection, we either:

  a) Stuff the connection name onto the run record at spawn time (main-side), OR
  b) For automation-originated runs, look it up by automationId/agentId at render time.

  Simplest: stuff a `connectionName` field on the run record when it's created. Look in `main.js` for where runs are pushed for the dock. Search `headless-dock` IPC handlers.

- [ ] **Step 2:** Find `headless:list` and `headless:get` handlers in `main.js`, plus wherever the dock-visible run record is created. The run record is built when a headless run is launched (search for `pushHeadlessRun`, `headlessRuns`, or similar). Inspect and add:

  - For a manual dock run (the user types into the dock): the dock prompt UI knows the current project's endpoint — reuse that.
  - For an automation-spawned run: take the agent's endpointId and resolve to a name.

  Concretely: add `connectionName` (string, e.g. `Cloud` or preset name) to the record at creation. If running a legacy automation with no endpointId, derive from project setting.

- [ ] **Step 3:** In `renderHeadlessDock` row build (`renderer.js:184+`), insert a chip after the title:

```js
if (r.connectionName && endpointPresets.length > 0) {
  var chip = document.createElement('span');
  chip.className = 'headless-dock-row-conn ' + (r.connectionName === 'Cloud' ? 'headless-dock-row-conn--cloud' : 'headless-dock-row-conn--local');
  chip.textContent = r.connectionName;
  row.appendChild(chip);
}
```

- [ ] **Step 4:** Add CSS:

```css
.headless-dock-row-conn {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 6px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  font-weight: 600;
  flex-shrink: 0;
}
.headless-dock-row-conn--cloud {
  background: rgba(100, 210, 255, 0.15);
  color: var(--color-cyan, #64d2ff);
  border: 1px solid rgba(100, 210, 255, 0.4);
}
.headless-dock-row-conn--local {
  background: rgba(255, 165, 0, 0.15);
  color: #ffa500;
  border: 1px solid rgba(255, 165, 0, 0.4);
}
```

- [ ] **Step 5:** Test: spawn a headless run on cloud and another on a local preset. Verify the chip appears with the correct connection name.

- [ ] **Step 6:** Commit.

```bash
git add main.js renderer.js styles.css
git commit -m "feat(headless): connection-name tag on dock rows"
```

---

## Self-review

- Spec coverage: req 1 (per-agent picker) → Tasks 1-3. Req 2 (cloud default + backward compat) → Tasks 1, 4 (with the safer fallback I flagged). Req 3 (run-time honoured) → Task 4. Req 4 (tags on cards + dock) → Tasks 5, 6.
- Placeholder scan: clean. Task 6 has a "find the run-record creation site" instruction that's vague — that's intentional because I haven't read that code yet; the executing step will look it up.
- Type/name consistency: `endpointId` and `endpointModel` used consistently. `endpointPresets` and `endpointModelsCache` are existing renderer globals (`renderer.js:51-57`).
