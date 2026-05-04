# Plan-Limits Foundation Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six features that build on the recently-wired plan-limits API (`usage:getPlanLimits`) and the existing local token data (`usage:getAll`): threshold notifications, session attribution, context-window meter, cross-column broadcast, session full-text search, and a cost dashboard.

**Architecture:** Stays in the existing 4-file pattern (main.js, preload.js, renderer.js, index.html, styles.css) with two new pure-JS modules under `lib/` for testable logic (cost calculation, JSONL token parsing). All UI lives in renderer.js + index.html. Uses Node's built-in `node --test` runner already wired into `npm test`.

**Tech Stack:** Electron IPC, vanilla DOM, Node.js native test runner, existing `~/.claude/projects/*.jsonl` transcripts as the data source.

**Conventions reminder:**
- Spawn / Kill / Respawn (not Add / Close / Restart) — match existing UI strings
- Background `#1a1a2e` for terminal panes, dark theme variables (`--bg-deep`, `--text-dim`, etc.)
- Commit per task using existing style (no `Co-Authored-By` footer in this repo's history; match the surrounding commits)

---

## Phase 1 — Threshold notifications + automation auto-pause

When session or weekly utilization crosses 70% or 90%, fire one system notification and flash the window. At 90%, also offer to auto-pause user automations so they don't burn the rest of the week unattended.

### Task 1.1: Pure threshold-detection module

**Files:**
- Create: `lib/plan-limit-thresholds.js`
- Test: `test/plan-limit-thresholds.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/plan-limit-thresholds.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { detectCrossings } = require('../lib/plan-limit-thresholds');

test('returns no crossings on first observation', () => {
  const crossings = detectCrossings(null, { five_hour: { utilization: 50 }, seven_day: { utilization: 50 } });
  assert.deepStrictEqual(crossings, []);
});

test('detects 70% upward crossing on session', () => {
  const prev = { five_hour: { utilization: 65 }, seven_day: { utilization: 10 } };
  const next = { five_hour: { utilization: 71 }, seven_day: { utilization: 10 } };
  const crossings = detectCrossings(prev, next);
  assert.deepStrictEqual(crossings, [{ window: 'five_hour', threshold: 70, value: 71 }]);
});

test('detects 90% upward crossing on weekly', () => {
  const prev = { five_hour: { utilization: 50 }, seven_day: { utilization: 89 } };
  const next = { five_hour: { utilization: 50 }, seven_day: { utilization: 91 } };
  const crossings = detectCrossings(prev, next);
  assert.deepStrictEqual(crossings, [{ window: 'seven_day', threshold: 90, value: 91 }]);
});

test('does not re-fire on same side of threshold', () => {
  const prev = { five_hour: { utilization: 75 } };
  const next = { five_hour: { utilization: 80 } };
  assert.deepStrictEqual(detectCrossings(prev, next), []);
});

test('does not fire on downward crossing (reset)', () => {
  const prev = { five_hour: { utilization: 95 } };
  const next = { five_hour: { utilization: 5 } };
  assert.deepStrictEqual(detectCrossings(prev, next), []);
});

test('handles missing window gracefully', () => {
  assert.deepStrictEqual(detectCrossings({ five_hour: null }, { five_hour: null }), []);
  assert.deepStrictEqual(detectCrossings({}, { five_hour: { utilization: 80 } }), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with "Cannot find module '../lib/plan-limit-thresholds'"

- [ ] **Step 3: Implement the module**

Create `lib/plan-limit-thresholds.js`:

```javascript
const WINDOWS = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus', 'seven_day_omelette'];
const THRESHOLDS = [70, 90];

function getUtil(data, key) {
  if (!data) return null;
  const slot = data[key];
  if (!slot || typeof slot.utilization !== 'number') return null;
  return slot.utilization;
}

// Returns [{ window, threshold, value }] for thresholds crossed UPWARD between prev and next.
// First observation (prev === null) returns []. Downward crossings (resets) return [].
function detectCrossings(prev, next) {
  const out = [];
  if (!prev || !next) return out;
  for (const w of WINDOWS) {
    const p = getUtil(prev, w);
    const n = getUtil(next, w);
    if (p == null || n == null) continue;
    for (const t of THRESHOLDS) {
      if (p < t && n >= t) out.push({ window: w, threshold: t, value: n });
    }
  }
  return out;
}

module.exports = { detectCrossings, WINDOWS, THRESHOLDS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all six tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/plan-limit-thresholds.js test/plan-limit-thresholds.test.js
git commit -m "feat(usage): pure threshold-crossing detector for plan limits"
```

### Task 1.2: Notification preferences in settings

**Files:**
- Modify: `index.html` (Settings modal section, search for `setting-notif-sidebar`)
- Modify: `renderer.js` (settings load/save block, search for `notifSettings`)
- Modify: `main.js` (CONFIG defaults, search for `function defaultConfig`)

- [ ] **Step 1: Add settings checkboxes**

In `index.html`, locate the existing notification settings group (the block containing `id="setting-notif-sidebar"`). Immediately after that group, insert:

```html
<div class="setting-row">
  <label>
    <input type="checkbox" id="setting-notif-limits-70" checked>
    <span>Notify when plan limits cross 70%</span>
  </label>
</div>
<div class="setting-row">
  <label>
    <input type="checkbox" id="setting-notif-limits-90" checked>
    <span>Notify when plan limits cross 90%</span>
  </label>
</div>
<div class="setting-row">
  <label>
    <input type="checkbox" id="setting-notif-limits-pause" checked>
    <span>At 90% weekly, prompt to pause automations</span>
  </label>
</div>
```

- [ ] **Step 2: Wire load/save in renderer.js**

In `renderer.js`, find where `notifSettings` is defined and persisted (search `notifSettings`). Extend the object to include `limits70`, `limits90`, `limitsPause` and read/write them from the three new checkboxes alongside the existing settings. Default all three to `true` when the saved config has no value for them.

- [ ] **Step 3: Smoke test**

Run: `npm start`
Open Settings modal. Expected: three new checkboxes appear under existing notification toggles, default ON. Toggle them off, restart app, confirm they stay off.

- [ ] **Step 4: Commit**

```bash
git add index.html renderer.js
git commit -m "feat(settings): add plan-limit threshold notification toggles"
```

### Task 1.3: Wire crossings into the existing poll loop

**Files:**
- Modify: `renderer.js` (search for `lastPlanLimitsResult` and `loadPlanLimits`)

- [ ] **Step 1: Track previous data and detect crossings**

In `renderer.js`, near the top where `lastPlanLimitsResult` is declared, also declare:

```javascript
var prevPlanLimitsData = null;  // last successful data, used for crossing detection
```

Then modify `loadPlanLimits` so that when `r.ok && r.data` after a successful fetch, we run threshold detection. The thresholds module is exposed to the renderer via Electron's preload or by inlining the logic. Since the renderer can't `require()` arbitrary local modules without a bundler, expose it via preload as `window.electronAPI.detectThresholdCrossings(prev, next)` — see Step 2.

After the `lastPlanLimitsResult = r;` line in the success branch, add:

```javascript
if (r && r.ok && r.data) {
  if (prevPlanLimitsData) {
    window.electronAPI.detectThresholdCrossings(prevPlanLimitsData, r.data).then(function (crossings) {
      if (crossings && crossings.length) handleThresholdCrossings(crossings);
    });
  }
  prevPlanLimitsData = r.data;
}
```

- [ ] **Step 2: Expose the detector through preload + main**

In `main.js`, near the top after `const fs = require('fs');`, add:

```javascript
const { detectCrossings: detectPlanLimitCrossings } = require('./lib/plan-limit-thresholds');
```

Add an IPC handler near the existing `usage:getPlanLimits` handler:

```javascript
ipcMain.handle('usage:detectThresholdCrossings', (_event, prev, next) => {
  try { return detectPlanLimitCrossings(prev, next); } catch { return []; }
});
```

In `preload.js`, add to the `electronAPI` object:

```javascript
detectThresholdCrossings: (prev, next) => ipcRenderer.invoke('usage:detectThresholdCrossings', prev, next),
```

- [ ] **Step 3: Implement the crossing handler**

In `renderer.js`, add near `loadPlanLimits`:

```javascript
function handleThresholdCrossings(crossings) {
  for (var i = 0; i < crossings.length; i++) {
    var c = crossings[i];
    var enabled70 = !notifSettings || notifSettings.limits70 !== false;
    var enabled90 = !notifSettings || notifSettings.limits90 !== false;
    if (c.threshold === 70 && !enabled70) continue;
    if (c.threshold === 90 && !enabled90) continue;
    showThresholdNotification(c);
    if (c.threshold === 90 && c.window === 'seven_day' &&
        notifSettings && notifSettings.limitsPause !== false) {
      promptPauseAutomations(c);
    }
  }
}

function showThresholdNotification(c) {
  var label = ({
    five_hour: 'Current session',
    seven_day: 'Weekly (all models)',
    seven_day_sonnet: 'Weekly (Sonnet)',
    seven_day_opus: 'Weekly (Opus)',
    seven_day_omelette: 'Weekly (Claude Design)'
  })[c.window] || c.window;
  var msg = label + ' just crossed ' + c.threshold + '% (' + Math.round(c.value) + '% used).';
  if (window.electronAPI && window.electronAPI.flashFrame) window.electronAPI.flashFrame();
  if (window.electronAPI && window.electronAPI.showSystemNotification) {
    window.electronAPI.showSystemNotification({ title: 'Claude usage limit', body: msg });
  }
}
```

- [ ] **Step 4: Add the system notification IPC**

In `main.js`, near the existing notification call site (search `new Notification(`), add an IPC handler:

```javascript
ipcMain.handle('notify:show', (_event, opts) => {
  try {
    const notif = new Notification({ title: opts.title || 'Claudes', body: opts.body || '' });
    notif.show();
    return true;
  } catch { return false; }
});
```

In `preload.js`, expose:

```javascript
showSystemNotification: (opts) => ipcRenderer.invoke('notify:show', opts),
```

- [ ] **Step 5: Smoke test**

Run: `npm start`. Open the JS console (Ctrl+Shift+I). Run:

```javascript
handleThresholdCrossings([{ window: 'five_hour', threshold: 70, value: 71 }]);
```

Expected: a system notification fires saying "Current session just crossed 70%". Window flashes if not focused.

- [ ] **Step 6: Commit**

```bash
git add main.js preload.js renderer.js
git commit -m "feat(usage): notify on plan-limit threshold crossings"
```

### Task 1.4: Auto-pause automations prompt at 90% weekly

**Files:**
- Modify: `renderer.js` (add `promptPauseAutomations` function next to `handleThresholdCrossings`)
- Existing IPC: `automations:setAllEnabled` (main.js:2056) — already implemented

- [ ] **Step 1: Implement the prompt**

Add to `renderer.js` near `handleThresholdCrossings`:

```javascript
function promptPauseAutomations(c) {
  // Use a simple modal-confirm. The app already has confirm-style dialogs;
  // match whichever pattern is in use. If none, use window.confirm for V1.
  var ok = window.confirm(
    'You\'ve crossed 90% of your weekly limit (' + Math.round(c.value) + '%).\n\n' +
    'Pause all your automations until next reset?'
  );
  if (ok && window.electronAPI && window.electronAPI.toggleAutomationsGlobal) {
    // toggleAutomationsGlobal flips state; if already enabled, this turns them off.
    window.electronAPI.getAutomationSettings().then(function (settings) {
      if (settings && settings.globalEnabled) {
        window.electronAPI.toggleAutomationsGlobal();
      }
    });
  }
}
```

- [ ] **Step 2: Smoke test**

Run: `npm start`. In console:

```javascript
handleThresholdCrossings([{ window: 'seven_day', threshold: 90, value: 91 }]);
```

Expected: confirm dialog, clicking OK disables global automations (verify in Automations tab — toggle should now be OFF).

- [ ] **Step 3: Commit**

```bash
git add renderer.js
git commit -m "feat(usage): offer to pause automations at 90% weekly"
```

---

## Phase 2 — Session attribution per column

Snapshot `five_hour.utilization` and `seven_day.utilization` at column-spawn time. Show a small "Δ session 0.4%" pill in the column header that updates whenever plan-limits poll completes.

### Task 2.1: Snapshot on spawn, render delta in header

**Files:**
- Modify: `renderer.js:2338` (the `colData = {…}` block in `addColumn`)
- Modify: `renderer.js` — `loadPlanLimits` and column rendering
- Modify: `index.html` (column header template — search for `col-restart`)
- Modify: `styles.css`

- [ ] **Step 1: Add snapshot fields to colData**

In `renderer.js`, in `addColumn` around line 2338 where `colData` is built, add fields after `notified: false`:

```javascript
    notified: false,
    spawnSessionPct: null,    // five_hour.utilization at spawn time
    spawnWeeklyPct: null,     // seven_day.utilization at spawn time
    deltaSessionEl: null      // header element, created in next step
```

Right after `setFocusedColumn(id);` (line ~2362) but before `refitAll();`, add:

```javascript
  if (lastPlanLimitsResult && lastPlanLimitsResult.ok && lastPlanLimitsResult.data) {
    var d0 = lastPlanLimitsResult.data;
    colData.spawnSessionPct = d0.five_hour ? d0.five_hour.utilization : null;
    colData.spawnWeeklyPct = d0.seven_day ? d0.seven_day.utilization : null;
  }
```

- [ ] **Step 2: Add the delta pill to the column header**

Find where the column header is built (search for `col-restart` and the surrounding `header.innerHTML` or DOM-builder). Inside that header, add a span:

```html
<span class="col-delta-pill" data-col-delta hidden>Δ —</span>
```

Then in `addColumn` after the header is wired, capture the element:

```javascript
  colData.deltaSessionEl = header.querySelector('[data-col-delta]');
```

- [ ] **Step 3: Update pills on every plan-limits poll**

In `renderer.js`, modify `loadPlanLimits`'s success branch. After the `prevPlanLimitsData = r.data;` line added in Phase 1, also call:

```javascript
  updateColumnDeltaPills(r.data);
```

Implement near `loadPlanLimits`:

```javascript
function updateColumnDeltaPills(data) {
  if (!data || !data.five_hour) return;
  var nowSession = data.five_hour.utilization;
  allColumns.forEach(function (c) {
    if (!c.deltaSessionEl) return;
    if (c.spawnSessionPct == null) return;
    var delta = nowSession - c.spawnSessionPct;
    if (delta < 0) delta = 0;  // session reset mid-life — don't show negative
    c.deltaSessionEl.removeAttribute('hidden');
    c.deltaSessionEl.textContent = 'Δ ' + delta.toFixed(1) + '%';
    c.deltaSessionEl.title =
      'Session usage spent by this column since spawn\n' +
      'Spawn snapshot: ' + c.spawnSessionPct.toFixed(1) + '%\n' +
      'Now: ' + nowSession.toFixed(1) + '%';
  });
}
```

Also call `updateColumnDeltaPills(lastPlanLimitsResult.data)` once after a fresh column is spawned, so the pill appears immediately (e.g. at 0.0%).

- [ ] **Step 4: Style the pill**

Add to `styles.css` near the column-header rules:

```css
.col-delta-pill {
  font-size: 10px;
  color: var(--text-dimmer);
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border-subtle);
  padding: 1px 6px;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
  margin-left: 6px;
  cursor: help;
}
```

- [ ] **Step 5: Smoke test**

Run: `npm start`. Spawn a column. Expected: Δ 0.0% pill appears in header within ≤60s of spawn (next poll). Hover for tooltip with spawn/now numbers. Use Claude in the column for a moment, wait for next poll, expected pill increments.

- [ ] **Step 6: Commit**

```bash
git add index.html renderer.js styles.css
git commit -m "feat(columns): show plan-limit delta pill since column spawn"
```

---

## Phase 3 — Context-window meter per column

Each Claude Code session writes assistant turns to `~/.claude/projects/<key>/<sessionId>.jsonl`, each with a `usage` object including `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and `output_tokens`. The model's effective live context is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` for the most recent assistant message. Render a meter showing (current_tokens / model_context_max).

### Task 3.1: Pure JSONL token-counter helper

**Files:**
- Create: `lib/session-context-tokens.js`
- Test: `test/session-context-tokens.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/session-context-tokens.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { lastAssistantContextTokens } = require('../lib/session-context-tokens');

function tmpFile(lines) {
  const p = path.join(os.tmpdir(), 'ctxtok-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jsonl');
  fs.writeFileSync(p, lines.map(JSON.stringify).join('\n') + '\n');
  return p;
}

test('returns null for empty file', () => {
  const p = tmpFile([]);
  assert.strictEqual(lastAssistantContextTokens(p), null);
  fs.unlinkSync(p);
});

test('sums input + cache_creation + cache_read of last assistant message', () => {
  const p = tmpFile([
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 50, output_tokens: 5 } } },
    { type: 'user', message: { content: 'again' } },
    { type: 'assistant', message: { usage: { input_tokens: 110, cache_creation_input_tokens: 0, cache_read_input_tokens: 380, output_tokens: 7 } } }
  ]);
  assert.strictEqual(lastAssistantContextTokens(p), 110 + 0 + 380);
  fs.unlinkSync(p);
});

test('skips non-assistant lines and malformed JSON', () => {
  const p = path.join(os.tmpdir(), 'ctxtok-bad.jsonl');
  fs.writeFileSync(p,
    '{"type":"system","x":1}\n' +
    'not json\n' +
    '{"type":"assistant","message":{"usage":{"input_tokens":42,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n'
  );
  assert.strictEqual(lastAssistantContextTokens(p), 42);
  fs.unlinkSync(p);
});

test('returns null for nonexistent file', () => {
  assert.strictEqual(lastAssistantContextTokens('/no/such/file.jsonl'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `lib/session-context-tokens.js`:

```javascript
const fs = require('fs');

// Returns the live context-token count for the last assistant turn in a JSONL,
// or null if the file is missing/empty/malformed. Reads the whole file
// (acceptable: typical session JSONLs are <50MB; called only on demand).
function lastAssistantContextTokens(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  if (!content) return null;
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    if (line.indexOf('"usage"') === -1) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' || !entry.message || !entry.message.usage) continue;
    const u = entry.message.usage;
    const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    return total;
  }
  return null;
}

// Map model name fragment → effective context window in tokens.
// Defaults to 200000 if unknown. Update when new context tiers ship.
function modelContextLimit(model) {
  if (!model) return 200000;
  const m = String(model).toLowerCase();
  if (m.indexOf('1m') !== -1) return 1000000;
  if (m.indexOf('haiku') !== -1) return 200000;
  if (m.indexOf('opus') !== -1) return 200000;
  if (m.indexOf('sonnet') !== -1) return 200000;
  return 200000;
}

module.exports = { lastAssistantContextTokens, modelContextLimit };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — four new tests green plus the existing ones.

- [ ] **Step 5: Commit**

```bash
git add lib/session-context-tokens.js test/session-context-tokens.test.js
git commit -m "feat(usage): pure helper for last-assistant context-token count"
```

### Task 3.2: IPC + poll loop in main.js

**Files:**
- Modify: `main.js` (near `usage:getPlanLimits` handler)
- Modify: `preload.js`

- [ ] **Step 1: Add main-process IPC**

In `main.js`, after the `usage:getPlanLimits` handler, add:

```javascript
const { lastAssistantContextTokens, modelContextLimit } = require('./lib/session-context-tokens');

// One-shot read of the live context-token count for a session.
// Renderer calls this every ~10s while a Claude column is live.
ipcMain.handle('session:contextTokens', (_event, projectPath, sessionId) => {
  if (!projectPath || !sessionId) return null;
  // projectPath here is the renderer's projectKey, e.g. "D--Git-Repos-Claudes".
  // Sessions live under ~/.claude/projects/<projectKey>/<sessionId>.jsonl.
  const filePath = path.join(os.homedir(), '.claude', 'projects', projectPath, sessionId + '.jsonl');
  const tokens = lastAssistantContextTokens(filePath);
  return tokens;
});

ipcMain.handle('session:modelContextLimit', (_event, model) => modelContextLimit(model));
```

- [ ] **Step 2: Expose via preload**

In `preload.js` add:

```javascript
getSessionContextTokens: (projectKey, sessionId) => ipcRenderer.invoke('session:contextTokens', projectKey, sessionId),
getModelContextLimit: (model) => ipcRenderer.invoke('session:modelContextLimit', model),
```

- [ ] **Step 3: Commit**

```bash
git add main.js preload.js
git commit -m "feat(usage): IPC for live session context-token count"
```

### Task 3.3: Render context meter in column header

**Files:**
- Modify: `renderer.js` (column lifecycle)
- Modify: `index.html` / column-header builder
- Modify: `styles.css`

- [ ] **Step 1: Add meter element next to delta pill**

In the column header where the delta pill was added (Phase 2), add immediately after it:

```html
<div class="col-ctx-meter" data-col-ctx hidden title="Context window usage">
  <div class="col-ctx-fill"></div>
  <span class="col-ctx-text"></span>
</div>
```

- [ ] **Step 2: Capture element + start per-column poll**

In `addColumn`, after capturing `deltaSessionEl`, also:

```javascript
  colData.ctxMeterEl = header.querySelector('[data-col-ctx]');
  colData.ctxFillEl = colData.ctxMeterEl ? colData.ctxMeterEl.querySelector('.col-ctx-fill') : null;
  colData.ctxTextEl = colData.ctxMeterEl ? colData.ctxMeterEl.querySelector('.col-ctx-text') : null;
  colData.ctxPollTimer = null;
  startContextMeterPoll(id);
```

- [ ] **Step 3: Implement the poll**

Add to `renderer.js`:

```javascript
var CTX_POLL_MS = 10000;  // 10s — JSONL grows on every assistant turn
var CTX_LIMIT_CACHE = new Map();  // model -> max tokens, populated lazily

function startContextMeterPoll(colId) {
  var c = allColumns.get(colId);
  if (!c || c.cmd) return;  // skip non-Claude columns
  function tick() {
    var col = allColumns.get(colId);
    if (!col || !col.ctxMeterEl) return;
    if (!col.sessionId) return;  // not yet detected
    window.electronAPI.getSessionContextTokens(col.projectKey, col.sessionId).then(function (tokens) {
      if (tokens == null) return;
      var modelKey = col.model || 'sonnet';
      var limit = CTX_LIMIT_CACHE.get(modelKey);
      var draw = function () {
        col.ctxMeterEl.removeAttribute('hidden');
        var pct = Math.min(100, (tokens / limit) * 100);
        col.ctxFillEl.style.width = pct + '%';
        col.ctxFillEl.classList.toggle('warning', pct >= 70 && pct < 90);
        col.ctxFillEl.classList.toggle('critical', pct >= 90);
        var k = (n) => (n >= 1000 ? Math.round(n/1000) + 'k' : n);
        col.ctxTextEl.textContent = k(tokens) + '/' + k(limit);
        col.ctxMeterEl.title = tokens.toLocaleString() + ' / ' + limit.toLocaleString() + ' tokens (' + Math.round(pct) + '%)';
      };
      if (limit) { draw(); return; }
      window.electronAPI.getModelContextLimit(modelKey).then(function (lim) {
        CTX_LIMIT_CACHE.set(modelKey, lim);
        limit = lim;
        draw();
      });
    });
  }
  tick();
  c.ctxPollTimer = setInterval(tick, CTX_POLL_MS);
}

function stopContextMeterPoll(colId) {
  var c = allColumns.get(colId);
  if (c && c.ctxPollTimer) { clearInterval(c.ctxPollTimer); c.ctxPollTimer = null; }
}
```

In `removeColumn` (search for it), add `stopContextMeterPoll(id);` near the top.

- [ ] **Step 4: Style the meter**

Add to `styles.css`:

```css
.col-ctx-meter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
  height: 16px;
  width: 90px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  position: relative;
  overflow: hidden;
  cursor: help;
}
.col-ctx-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: #4f8cff;
  width: 0;
  transition: width 200ms ease;
}
.col-ctx-fill.warning { background: #e0a020; }
.col-ctx-fill.critical { background: #e05050; }
.col-ctx-text {
  position: relative;
  font-size: 10px;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  width: 100%;
  text-align: center;
  text-shadow: 0 0 2px rgba(0,0,0,0.6);
}
```

- [ ] **Step 5: Smoke test**

Run: `npm start`. Spawn a Claude column, send a few messages. Expected: meter appears in header within 10s, shows e.g. "12k/200k", colour shifts amber at 70%, red at 90%. Reattaching a column reuses the same JSONL — meter stays accurate.

- [ ] **Step 6: Commit**

```bash
git add index.html renderer.js styles.css
git commit -m "feat(columns): live context-window meter per column"
```

---

## Phase 4 — Cross-column broadcast

Toolbar button "Broadcast" opens a small popover with a textarea and column-checkbox list (only Claude columns visible). Submitting writes the prompt + Enter to each selected column's pty.

### Task 4.1: Broadcast popover UI

**Files:**
- Modify: `index.html` (toolbar — search for an existing toolbar button to insert beside)
- Modify: `index.html` (add popover element near other modals)
- Modify: `styles.css`
- Modify: `renderer.js`

- [ ] **Step 1: Add toolbar button + popover markup**

In `index.html`, find the toolbar (`#toolbar`) and add a button:

```html
<button id="btn-broadcast" class="toolbar-btn" title="Broadcast a prompt to multiple columns">⤳</button>
```

Near the other modal/popover blocks at the bottom of `<body>`:

```html
<div id="broadcast-popover" class="broadcast-popover hidden">
  <div class="broadcast-header">
    <span class="broadcast-title">Broadcast prompt</span>
    <button id="broadcast-close" class="broadcast-close">&times;</button>
  </div>
  <textarea id="broadcast-text" rows="4" placeholder="Type a prompt to send to selected columns…"></textarea>
  <div id="broadcast-targets" class="broadcast-targets"></div>
  <div class="broadcast-actions">
    <label class="broadcast-press-enter">
      <input type="checkbox" id="broadcast-press-enter" checked> Press Enter after send
    </label>
    <button id="broadcast-send" class="broadcast-send-btn">Send to selected</button>
  </div>
</div>
```

- [ ] **Step 2: Style the popover**

Add to `styles.css`:

```css
.broadcast-popover {
  position: fixed;
  top: 60px;
  right: 16px;
  width: 360px;
  z-index: 1000;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 12px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.broadcast-popover.hidden { display: none; }
.broadcast-header { display: flex; justify-content: space-between; align-items: center; }
.broadcast-title { font-weight: 600; font-size: 13px; }
.broadcast-close { background: transparent; border: 0; color: var(--text-dim); font-size: 18px; cursor: pointer; }
.broadcast-popover textarea {
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  border-radius: 4px;
  padding: 6px 8px;
  font-family: inherit;
  font-size: 13px;
  resize: vertical;
}
.broadcast-targets {
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--border-subtle);
  padding-top: 8px;
}
.broadcast-target {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-primary);
}
.broadcast-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.broadcast-press-enter { font-size: 11px; color: var(--text-dim); }
.broadcast-send-btn {
  background: #4f8cff;
  color: white;
  border: 0;
  border-radius: 4px;
  padding: 5px 12px;
  cursor: pointer;
  font-size: 12px;
}
.broadcast-send-btn:hover { background: #3a78ee; }
```

- [ ] **Step 3: Open/close + populate targets**

In `renderer.js`, add at the end of the file:

```javascript
(function setupBroadcast() {
  var btn = document.getElementById('btn-broadcast');
  var popover = document.getElementById('broadcast-popover');
  var closeBtn = document.getElementById('broadcast-close');
  var sendBtn = document.getElementById('broadcast-send');
  var textEl = document.getElementById('broadcast-text');
  var targetsEl = document.getElementById('broadcast-targets');
  var pressEnterEl = document.getElementById('broadcast-press-enter');
  if (!btn || !popover) return;

  function refreshTargets() {
    targetsEl.innerHTML = '';
    allColumns.forEach(function (c, id) {
      if (c.cmd) return;  // only Claude columns
      var label = document.createElement('label');
      label.className = 'broadcast-target';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.colId = id;
      cb.checked = true;
      var span = document.createElement('span');
      var title = c.customTitle || c.cwd || ('column ' + id);
      span.textContent = title;
      label.appendChild(cb);
      label.appendChild(span);
      targetsEl.appendChild(label);
    });
    if (!targetsEl.children.length) {
      targetsEl.innerHTML = '<div class="broadcast-target" style="opacity:.6">No Claude columns open.</div>';
    }
  }

  btn.addEventListener('click', function () {
    refreshTargets();
    popover.classList.remove('hidden');
    textEl.focus();
  });
  closeBtn.addEventListener('click', function () { popover.classList.add('hidden'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !popover.classList.contains('hidden')) {
      popover.classList.add('hidden');
    }
  });

  sendBtn.addEventListener('click', function () {
    var text = textEl.value;
    if (!text) return;
    var checks = targetsEl.querySelectorAll('input[type=checkbox]:checked');
    var pressEnter = pressEnterEl.checked;
    checks.forEach(function (cb) {
      var id = parseInt(cb.dataset.colId, 10);
      var col = allColumns.get(id);
      if (!col) return;
      // Send raw text to pty via existing wsSend mechanism.
      wsSend({ type: 'write', id: id, data: text + (pressEnter ? '\r' : '') });
    });
    popover.classList.add('hidden');
    textEl.value = '';
  });
})();
```

- [ ] **Step 4: Smoke test**

Run: `npm start`. Spawn 2-3 Claude columns. Click ⤳, type "what is the weather", check both boxes, click Send. Expected: each column receives the same text + Enter and Claude responds in each.

- [ ] **Step 5: Commit**

```bash
git add index.html renderer.js styles.css
git commit -m "feat(broadcast): send a prompt to multiple columns at once"
```

---

## Phase 5 — Session full-text search

A search input in the explorer panel (or a new sidebar entry) scans every JSONL under `~/.claude/projects/`, returning hits with project + session + snippet. Click a hit to spawn a column resuming that session.

### Task 5.1: Search backend in main.js

**Files:**
- Modify: `main.js` (new IPC handler)
- Modify: `preload.js`

- [ ] **Step 1: Implement search IPC**

In `main.js`, add near the other usage handlers:

```javascript
// Full-text search across all session JSONLs. Streaming: returns first N hits
// with surrounding context. Case-insensitive substring match (no regex for V1).
ipcMain.handle('sessions:search', async (_event, query, limit) => {
  if (!query || typeof query !== 'string' || query.length < 2) return [];
  const max = Math.max(1, Math.min(200, limit || 50));
  const needle = query.toLowerCase();
  const root = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs;
  try { projectDirs = await fs.promises.readdir(root); } catch { return []; }

  const hits = [];
  outer:
  for (const dir of projectDirs) {
    const projDir = path.join(root, dir);
    let entries;
    try { entries = await fs.promises.readdir(projDir); } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(projDir, file);
      let content;
      try { content = await fs.promises.readFile(filePath, 'utf8'); } catch { continue; }
      const idx = content.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      // Find the JSONL line containing the match
      const lineStart = content.lastIndexOf('\n', idx) + 1;
      const lineEnd = content.indexOf('\n', idx);
      const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      let snippet = line;
      try {
        const obj = JSON.parse(line);
        // Pull a human-readable snippet from typical Claude JSONL shapes
        if (obj && obj.message && obj.message.content) {
          const c = obj.message.content;
          snippet = typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.map(p => (p && p.text) || '').join(' ')
              : JSON.stringify(c);
        }
      } catch { /* keep raw line */ }
      // Trim to ~200 chars around the needle for display
      const matchInSnippet = snippet.toLowerCase().indexOf(needle);
      const start = Math.max(0, matchInSnippet - 80);
      const end = Math.min(snippet.length, matchInSnippet + 120);
      const trimmed = (start > 0 ? '…' : '') + snippet.slice(start, end) + (end < snippet.length ? '…' : '');

      hits.push({
        projectKey: dir,
        sessionId: file.replace('.jsonl', ''),
        snippet: trimmed,
        matchedAt: idx
      });
      if (hits.length >= max) break outer;
    }
  }
  return hits;
});
```

- [ ] **Step 2: Expose via preload**

```javascript
searchSessions: (query, limit) => ipcRenderer.invoke('sessions:search', query, limit),
```

- [ ] **Step 3: Manual test from console**

Run: `npm start`. Open DevTools → Console:

```javascript
window.electronAPI.searchSessions('websocket', 10).then(console.log);
```

Expected: array of `{projectKey, sessionId, snippet, matchedAt}`.

- [ ] **Step 4: Commit**

```bash
git add main.js preload.js
git commit -m "feat(sessions): full-text search across all session JSONLs"
```

### Task 5.2: Search UI

**Files:**
- Modify: `index.html` (add a search modal triggered by toolbar button)
- Modify: `renderer.js`
- Modify: `styles.css`

- [ ] **Step 1: Add modal markup**

In `index.html` add to the modals section:

```html
<div id="session-search-modal" class="modal-overlay hidden">
  <div class="modal-dialog session-search-dialog">
    <div class="modal-header">
      <span class="modal-title">Search sessions</span>
      <span id="session-search-close" class="modal-close">&times;</span>
    </div>
    <div class="modal-body">
      <input type="search" id="session-search-input" placeholder="Search across all session transcripts…" autocomplete="off">
      <div id="session-search-results" class="session-search-results"></div>
    </div>
  </div>
</div>
```

Add a toolbar button:

```html
<button id="btn-session-search" class="toolbar-btn" title="Search session transcripts (Ctrl+Shift+F)">🔎</button>
```

- [ ] **Step 2: Style results list**

```css
.session-search-dialog { width: 720px; max-height: 80vh; }
#session-search-input {
  width: 100%;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 14px;
  margin-bottom: 8px;
}
.session-search-results {
  max-height: 60vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.session-search-hit {
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 8px 10px;
  cursor: pointer;
}
.session-search-hit:hover { border-color: #4f8cff; }
.session-search-hit-meta { font-size: 11px; color: var(--text-dim); margin-bottom: 4px; }
.session-search-hit-snippet { font-size: 12px; color: var(--text-primary); white-space: pre-wrap; word-break: break-word; }
.session-search-hit-snippet mark { background: rgba(79,140,255,0.4); color: inherit; padding: 0 1px; }
```

- [ ] **Step 3: Wire open + debounced search + result click**

In `renderer.js`:

```javascript
(function setupSessionSearch() {
  var btn = document.getElementById('btn-session-search');
  var modal = document.getElementById('session-search-modal');
  var closeBtn = document.getElementById('session-search-close');
  var input = document.getElementById('session-search-input');
  var resultsEl = document.getElementById('session-search-results');
  if (!btn || !modal) return;

  function open() {
    modal.classList.remove('hidden');
    input.focus();
    input.select();
  }
  function close() { modal.classList.add('hidden'); }

  btn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); open(); }
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });

  var debounceTimer = null;
  input.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    var q = input.value.trim();
    if (q.length < 2) { resultsEl.innerHTML = ''; return; }
    debounceTimer = setTimeout(function () { runSearch(q); }, 200);
  });

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (m) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]; });
  }

  function highlight(text, q) {
    var safe = escapeHtml(text);
    var idx = safe.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return safe;
    return safe.slice(0, idx) + '<mark>' + safe.slice(idx, idx + q.length) + '</mark>' + safe.slice(idx + q.length);
  }

  function runSearch(q) {
    resultsEl.innerHTML = '<div style="opacity:.6;font-size:12px">Searching…</div>';
    window.electronAPI.searchSessions(q, 50).then(function (hits) {
      resultsEl.innerHTML = '';
      if (!hits.length) {
        resultsEl.innerHTML = '<div style="opacity:.6;font-size:12px">No matches.</div>';
        return;
      }
      hits.forEach(function (h) {
        var div = document.createElement('div');
        div.className = 'session-search-hit';
        var meta = document.createElement('div');
        meta.className = 'session-search-hit-meta';
        meta.textContent = h.projectKey + '  •  ' + h.sessionId.slice(0, 8);
        var snip = document.createElement('div');
        snip.className = 'session-search-hit-snippet';
        snip.innerHTML = highlight(h.snippet, q);
        div.appendChild(meta);
        div.appendChild(snip);
        div.addEventListener('click', function () { openHit(h); });
        resultsEl.appendChild(div);
      });
    });
  }

  function openHit(h) {
    // Find the project in config matching this projectKey, switch to it,
    // and spawn a new column resuming the session.
    if (!config || !config.projects) return;
    var proj = config.projects.find(function (p) { return p.path === h.projectKey; });
    if (!proj) {
      alert('That session\'s project is not in your project list. Add it first.');
      return;
    }
    setActiveProject(config.projects.indexOf(proj), true);
    // Spawn a column with --resume <sessionId>
    addColumn(null, null, { sessionId: h.sessionId });
    close();
  }
})();
```

- [ ] **Step 4: Smoke test**

Run: `npm start`. Press Ctrl+Shift+F, type a unique phrase you remember from a past session. Expected: hits appear within ~200ms after typing stops. Click a hit; the matching project is selected and a new column spawns resuming that session.

- [ ] **Step 5: Commit**

```bash
git add index.html renderer.js styles.css
git commit -m "feat(sessions): full-text search modal with resume-on-click"
```

---

## Phase 6 — Cost dashboard

Convert local token totals from `usage:getAll` into approximate USD cost per project, per day, per model. Display as a fourth tab inside the existing Usage modal.

### Task 6.1: Pure cost-calculation module

**Files:**
- Create: `lib/cost-calc.js`
- Test: `test/cost-calc.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { sessionCost, MODEL_PRICES_PER_MTOK } = require('../lib/cost-calc');

test('opus pricing: 100k input + 10k output', () => {
  // Opus 4.x prices: $15 input, $75 output, $1.50 cache_read, $18.75 cache_creation per MTok
  const c = sessionCost({
    model: 'claude-opus-4-7',
    input: 100000,
    cacheCreation: 0,
    cacheRead: 0,
    output: 10000
  });
  // 100k input @ $15/MTok = $1.50; 10k output @ $75/MTok = $0.75 → $2.25
  assert.strictEqual(c.toFixed(2), '2.25');
});

test('sonnet pricing: cache reads cost less than fresh input', () => {
  // Sonnet 4.x: $3 input, $15 output, $0.30 cache_read, $3.75 cache_creation
  const c = sessionCost({
    model: 'claude-sonnet-4-6',
    input: 0,
    cacheCreation: 0,
    cacheRead: 1000000, // 1MTok cache read
    output: 0
  });
  assert.strictEqual(c.toFixed(2), '0.30');
});

test('haiku pricing on unknown variant falls back to haiku rate', () => {
  const c = sessionCost({
    model: 'claude-haiku-99-99',
    input: 1000000,
    cacheCreation: 0,
    cacheRead: 0,
    output: 0
  });
  // Haiku 4.x: $1 input
  assert.strictEqual(c.toFixed(2), '1.00');
});

test('unknown model returns 0 with `unknown` flag', () => {
  const c = sessionCost({ model: 'gpt-4', input: 1000, cacheCreation: 0, cacheRead: 0, output: 1000 });
  assert.strictEqual(c, 0);
});

test('MODEL_PRICES_PER_MTOK is exported and immutable-ish', () => {
  assert.ok(MODEL_PRICES_PER_MTOK.opus);
  assert.ok(MODEL_PRICES_PER_MTOK.sonnet);
  assert.ok(MODEL_PRICES_PER_MTOK.haiku);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` — expect failure (module missing).

- [ ] **Step 3: Implement**

Create `lib/cost-calc.js`:

```javascript
// Anthropic public list prices as of plan authoring (2026-05-04).
// Update when pricing changes. All values USD per million tokens.
const MODEL_PRICES_PER_MTOK = {
  opus:   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreation: 18.75 },
  sonnet: { input:  3.00, output: 15.00, cacheRead: 0.30, cacheCreation:  3.75 },
  haiku:  { input:  1.00, output:  5.00, cacheRead: 0.10, cacheCreation:  1.25 }
};

function classify(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (m.indexOf('opus') !== -1) return 'opus';
  if (m.indexOf('sonnet') !== -1) return 'sonnet';
  if (m.indexOf('haiku') !== -1) return 'haiku';
  return null;
}

// Returns a number (USD). Returns 0 for unknown model.
function sessionCost({ model, input = 0, cacheCreation = 0, cacheRead = 0, output = 0 }) {
  const cls = classify(model);
  if (!cls) return 0;
  const p = MODEL_PRICES_PER_MTOK[cls];
  const cost =
    (input         / 1e6) * p.input +
    (output        / 1e6) * p.output +
    (cacheRead     / 1e6) * p.cacheRead +
    (cacheCreation / 1e6) * p.cacheCreation;
  return cost;
}

module.exports = { sessionCost, MODEL_PRICES_PER_MTOK, classify };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — expect all green.

- [ ] **Step 5: Commit**

```bash
git add lib/cost-calc.js test/cost-calc.test.js
git commit -m "feat(usage): pure cost-calculation module with price table"
```

### Task 6.2: Aggregate costs in main.js

**Files:**
- Modify: `main.js` (new IPC handler near `usage:getAll`)
- Modify: `preload.js`

- [ ] **Step 1: Add aggregator IPC**

In `main.js`, after the `usage:getAll` handler:

```javascript
const { sessionCost: calcSessionCost } = require('./lib/cost-calc');

// Returns aggregated cost rollups: by model, by project, by day, plus totals.
// Re-uses the digest output of usage:getAll. The digest entries include
// per-model token splits already.
ipcMain.handle('usage:getCosts', async () => {
  // Reuse the cached parser by calling the existing handler's logic. Simplest
  // path: invoke the registered handler. ipcMain.invoke isn't a thing for
  // self-calls; instead refactor the handler body into a helper. For V1, we
  // duplicate a minimal version: walk the cache file or re-run usage:getAll.
  const usage = await new Promise((resolve) => {
    // Wrap the original handler. Since ipcMain.handle stores the handler
    // internally and there's no public getter, the cleanest thing is to
    // keep a module-scope reference. Refactor in step 2.
    resolve(global.__lastUsageDigest || []);
  });
  return rollupCosts(usage);
});

function rollupCosts(usageDigests) {
  var byModel = { opus: 0, sonnet: 0, haiku: 0, unknown: 0 };
  var byProject = {};
  var byDay = {};
  var total = 0;
  for (const d of usageDigests) {
    if (!d || !d.modelTokens) continue;
    for (const cls of ['opus', 'sonnet', 'haiku']) {
      const t = d.modelTokens[cls];
      if (!t) continue;
      const c = calcSessionCost({
        model: 'claude-' + cls,
        input: t.input || 0,
        cacheCreation: t.cacheCreation || 0,
        cacheRead: t.cache || 0,  // existing digests may name this `cache`; map below
        output: t.output || 0
      });
      byModel[cls] += c;
      total += c;
      if (d.projectKey) byProject[d.projectKey] = (byProject[d.projectKey] || 0) + c;
      if (d.lastDate)   byDay[d.lastDate]       = (byDay[d.lastDate] || 0) + c;
    }
  }
  return { total, byModel, byProject, byDay };
}
```

- [ ] **Step 2: Refactor the existing `usage:getAll` handler to expose its digests**

The above stub uses `global.__lastUsageDigest`. Refactor: in the existing `usage:getAll` handler at `main.js:1605`, after computing `results` and before returning them, store:

```javascript
  global.__lastUsageDigest = results;
  return results;
```

This is a pragmatic V1; if you'd rather, factor the parsing into a named helper `getUsageDigests()` and call it from both handlers.

- [ ] **Step 3: Map field names**

Inspect what the existing digests contain — open `main.js:1546` area where `entry.message.usage` is read. Confirm exact field names (`cache_read_input_tokens` vs the rolled `cache` field on the digest). Update `rollupCosts` to use whatever the digest actually exposes. If the digest does not yet split by model, extend the parsing in `usage:getAll` to keep per-model token sums per session — this is needed for `byModel` to be meaningful.

- [ ] **Step 4: Expose via preload**

```javascript
getUsageCosts: () => ipcRenderer.invoke('usage:getCosts'),
```

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js
git commit -m "feat(usage): cost rollups by model/project/day"
```

### Task 6.3: Cost tab in Usage modal

**Files:**
- Modify: `index.html` (Usage modal — search for the existing tabs `data-usage-tab="summary"`)
- Modify: `renderer.js`
- Modify: `styles.css`

- [ ] **Step 1: Add Cost tab markup**

In `index.html`, in the existing `.usage-tabs` block, after the "Sessions" tab:

```html
<button class="usage-tab" data-usage-tab="cost">Cost</button>
```

Add the corresponding tab content panel after `usage-tab-sessions`:

```html
<div id="usage-tab-cost" class="usage-tab-content">
  <div class="cost-summary">
    <div class="cost-card"><div class="cost-label">Total</div><div class="cost-value" id="cost-total">—</div></div>
    <div class="cost-card"><div class="cost-label">Opus</div><div class="cost-value" id="cost-opus">—</div></div>
    <div class="cost-card"><div class="cost-label">Sonnet</div><div class="cost-value" id="cost-sonnet">—</div></div>
    <div class="cost-card"><div class="cost-label">Haiku</div><div class="cost-value" id="cost-haiku">—</div></div>
  </div>
  <h3 class="usage-section-title">By project</h3>
  <div id="cost-by-project" class="cost-table"></div>
  <h3 class="usage-section-title">Last 30 days</h3>
  <div id="cost-by-day" class="cost-chart"></div>
  <div class="cost-disclaimer">
    Approximate, based on Anthropic public list prices. Plan-included usage is billed differently;
    these figures show what the same tokens would cost at API rates.
  </div>
</div>
```

- [ ] **Step 2: Render cost tab**

In `renderer.js`, in `openUsageModal` after `renderUsageSessions(data);` add:

```javascript
    window.electronAPI.getUsageCosts().then(renderCostTab);
```

Add the renderer:

```javascript
function fmtUsd(n) {
  if (!n) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

function renderCostTab(c) {
  if (!c) return;
  document.getElementById('cost-total').textContent  = fmtUsd(c.total);
  document.getElementById('cost-opus').textContent   = fmtUsd(c.byModel.opus);
  document.getElementById('cost-sonnet').textContent = fmtUsd(c.byModel.sonnet);
  document.getElementById('cost-haiku').textContent  = fmtUsd(c.byModel.haiku);

  var byProj = document.getElementById('cost-by-project');
  byProj.innerHTML = '';
  var rows = Object.keys(c.byProject).map(function (k) { return [k, c.byProject[k]]; });
  rows.sort(function (a, b) { return b[1] - a[1]; });
  rows.forEach(function (r) {
    var d = document.createElement('div');
    d.className = 'cost-row';
    d.innerHTML = '<span class="cost-row-name"></span><span class="cost-row-val"></span>';
    d.querySelector('.cost-row-name').textContent = r[0];
    d.querySelector('.cost-row-val').textContent = fmtUsd(r[1]);
    byProj.appendChild(d);
  });

  var byDayEl = document.getElementById('cost-by-day');
  byDayEl.innerHTML = '';
  var dayRows = Object.keys(c.byDay).sort().slice(-30);
  var max = Math.max.apply(null, dayRows.map(function (d) { return c.byDay[d]; })) || 1;
  dayRows.forEach(function (d) {
    var row = document.createElement('div');
    row.className = 'cost-day-row';
    row.innerHTML = '<span class="cost-day-label"></span><div class="cost-day-bar"><div class="cost-day-fill"></div></div><span class="cost-day-val"></span>';
    row.querySelector('.cost-day-label').textContent = d;
    row.querySelector('.cost-day-fill').style.width = ((c.byDay[d] / max) * 100) + '%';
    row.querySelector('.cost-day-val').textContent = fmtUsd(c.byDay[d]);
    byDayEl.appendChild(row);
  });
}
```

- [ ] **Step 3: Style the cost tab**

```css
.cost-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 20px;
}
.cost-card {
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 12px 14px;
}
.cost-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
.cost-value { font-size: 22px; font-weight: 600; color: var(--text-primary); margin-top: 4px; font-variant-numeric: tabular-nums; }
.cost-table { display: flex; flex-direction: column; gap: 4px; margin-bottom: 20px; }
.cost-row { display: flex; justify-content: space-between; padding: 6px 10px; background: rgba(255,255,255,0.02); border-radius: 4px; font-size: 12px; }
.cost-row-name { color: var(--text-primary); }
.cost-row-val { color: var(--text-dim); font-variant-numeric: tabular-nums; }
.cost-chart { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; }
.cost-day-row { display: grid; grid-template-columns: 84px 1fr 70px; gap: 8px; align-items: center; font-size: 11px; }
.cost-day-label { color: var(--text-dim); }
.cost-day-bar { height: 8px; background: rgba(255,255,255,0.04); border-radius: 4px; overflow: hidden; }
.cost-day-fill { height: 100%; background: #4f8cff; border-radius: 4px; }
.cost-day-val { color: var(--text-primary); text-align: right; font-variant-numeric: tabular-nums; }
.cost-disclaimer { font-size: 10px; color: var(--text-dimmer); margin-top: 12px; line-height: 1.4; }
```

- [ ] **Step 4: Smoke test**

Run: `npm start`. Open Usage modal → Cost tab. Expected: total + per-model values, project list sorted desc by cost, last-30-day bar chart. Disclaimer visible at bottom.

- [ ] **Step 5: Commit**

```bash
git add index.html renderer.js styles.css
git commit -m "feat(usage): cost dashboard tab in Usage modal"
```

---

## Final integration smoke test

- [ ] **Step 1: Verify all six features coexist**

Run `npm start`. Walk through each feature in order:

1. Sidebar plan-limits mini-bar still updates every minute. (existing)
2. Cross 70% threshold (manually trigger via console): notification fires.
3. Spawn a Claude column → Δ pill appears within 60s, increments after a turn.
4. Use Claude → context meter advances, colour changes past 70%.
5. Spawn a 2nd column → broadcast popover lists both, send works to both.
6. Ctrl+Shift+F → search modal finds historical sessions.
7. Usage modal → Cost tab populates with totals.

- [ ] **Step 2: Check tests still pass**

Run: `npm test`
Expected: PASS — all new tests green, existing `headless-helpers.test.js` still passes.

- [ ] **Step 3: Verify no console errors**

Open DevTools, exercise each feature, watch for red errors. Fix any before merging.

- [ ] **Step 4: Final commit / push**

```bash
git status        # confirm clean
git push origin <branch>
```
