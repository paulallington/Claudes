# Automation Run Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global and optional per-automation time-of-day/day-of-week window that gates when scheduled automations are allowed to start, with a visible status strip so users know whether the gate is open or closed.

**Architecture:** A pure helper `isWithinRunWindow(window, now)` is added to `main.js`. The scheduler's `shouldRunAgent` function gets two early-return calls — one for the global window, one for the automation's own window — so an agent runs only when both are currently open (intersection). Manual `Run Now` bypasses the gate; `run_after` agents follow their upstream. Config is persisted in the existing `automations.json` — extending the already-present `automations:getSettings` / `automations:updateSettings` IPC channels rather than adding new ones. UI adds a clock button to the automations flyout header (opens a popover), a status strip under the AUTOMATIONS panel toolbar, a small clock badge on automations that have their own window, and a collapsible "Run window" section in the create/edit modal.

**Tech Stack:** Electron IPC, vanilla JS DOM, CSS.

**Spec:** `docs/superpowers/specs/2026-04-23-automation-run-windows-design.md`

**Note on IPC channel:** The spec proposed a new `automations:updateGlobalRunWindow` channel. This plan instead extends the existing `automations:updateSettings` channel — cleaner and matches the pattern already established by `agentReposBaseDir`. No behavior change.

**Testing approach:** This codebase has no automated test framework (no Jest/Mocha/Vitest). Each task has a **Verify** step the engineer performs manually in a running Electron instance via `npm start`.

---

## Phase 1: Backend — Window helper and scheduler gate

### Task 1: Add `isWithinRunWindow` pure helper

**Files:**
- Modify: `main.js` — add helper function immediately before `shouldRunAgent` at line 2535.

- [ ] **Step 1: Add the helper**

Insert the following function in `main.js` directly above the existing `function shouldRunAgent(agent, now)` line (current line 2535):

```javascript
// Returns true if `now` falls within the configured run window.
// window: { enabled, startHour, startMinute, endHour, endMinute, days[] } or null/undefined
// A null/undefined window, or one with enabled=false, imposes no restriction.
// Overnight windows (end <= start) wrap past midnight; `days` identifies the
// day the window OPENS.
function isWithinRunWindow(window, now) {
  if (!window || !window.enabled) return true;
  if (!Array.isArray(window.days) || window.days.length === 0) return false;

  var nowDate = (now instanceof Date) ? now : new Date(now);
  var dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var todayKey = dayNames[nowDate.getDay()];
  var yesterdayKey = dayNames[(nowDate.getDay() + 6) % 7];

  var nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  var startMinutes = window.startHour * 60 + (window.startMinute || 0);
  var endMinutes = window.endHour * 60 + (window.endMinute || 0);

  if (endMinutes > startMinutes) {
    // Same-day window
    if (window.days.indexOf(todayKey) === -1) return false;
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  // Overnight window (end <= start): wraps past midnight
  if (window.days.indexOf(todayKey) !== -1 && nowMinutes >= startMinutes) return true;
  if (window.days.indexOf(yesterdayKey) !== -1 && nowMinutes < endMinutes) return true;
  return false;
}
```

- [ ] **Step 2: Verify the function loads without error**

Run:

```bash
npm start
```

Expected: App opens, DevTools console (Ctrl+Shift+I in the main window) shows no new errors on startup. No visible behavior change — the function is not wired yet.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(automations): add isWithinRunWindow helper"
```

---

### Task 2: Wire the gate into `shouldRunAgent`

**Files:**
- Modify: `main.js:2535` (the `shouldRunAgent` function and its single caller in the scheduler interval at `main.js:3341`).

- [ ] **Step 1: Extend the function signature**

Change the signature of `shouldRunAgent` from `function shouldRunAgent(agent, now)` to `function shouldRunAgent(data, automation, agent, now)`. At the very top of the function body, insert the two gate checks BEFORE the existing `if (!agent.enabled) return false;` line:

```javascript
function shouldRunAgent(data, automation, agent, now) {
  if (!isWithinRunWindow(data.runWindow, now)) return false;
  if (!isWithinRunWindow(automation.runWindow, now)) return false;
  if (!agent.enabled) return false;
  if (agent.currentRunStartedAt) return false;
  // ... (rest of the function unchanged)
```

Leave the rest of the function body as is.

- [ ] **Step 2: Update the caller in the scheduler interval**

At `main.js:3341`, change:

```javascript
if (shouldRunAgent(agent, now)) {
  runAgent(automation.id, agent.id);
}
```

To:

```javascript
if (shouldRunAgent(autoData, automation, agent, now)) {
  runAgent(automation.id, agent.id);
}
```

(Note: `autoData` is already the variable name for the loaded automations data in this scope — confirm by reading the surrounding `setInterval` block at `main.js:3334-3346`.)

- [ ] **Step 3: Grep for other callers**

Run:

```bash
grep -n "shouldRunAgent" main.js
```

Expected: exactly two hits — the function definition and the scheduler caller. If any other caller exists, update it with the same argument order.

- [ ] **Step 4: Verify the app still runs**

Run:

```bash
npm start
```

Create or keep an automation with `interval: 1 minute`. Wait ~90 seconds. Expected: the automation runs normally (no `runWindow` configured yet, so the gate is a no-op).

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(automations): gate scheduler on run window"
```

---

### Task 3: Persist `runWindow` via getSettings/updateSettings

**Files:**
- Modify: `main.js:2229-2243` (the existing `automations:getSettings` and `automations:updateSettings` handlers).

- [ ] **Step 1: Extend `automations:getSettings`**

Replace the current handler at `main.js:2229`:

```javascript
ipcMain.handle('automations:getSettings', () => {
  const data = readAutomations();
  return {
    agentReposBaseDir: data.agentReposBaseDir || path.join(os.homedir(), '.claudes', 'agents'),
    runWindow: data.runWindow || null
  };
});
```

- [ ] **Step 2: Extend `automations:updateSettings` to accept `runWindow`**

Replace the current handler at `main.js:2236`:

```javascript
ipcMain.handle('automations:updateSettings', (event, settings) => {
  const data = readAutomations();
  if (settings.agentReposBaseDir !== undefined) {
    data.agentReposBaseDir = settings.agentReposBaseDir;
  }
  if (settings.runWindow !== undefined) {
    // null clears the window; object replaces it
    data.runWindow = settings.runWindow;
  }
  writeAutomations(data);
  return true;
});
```

- [ ] **Step 3: Verify in DevTools**

Run `npm start`, open DevTools on the main window (Ctrl+Shift+I), and in the Console run:

```javascript
await window.electronAPI.updateAutomationSettings({
  runWindow: { enabled: true, startHour: 9, startMinute: 0, endHour: 17, endMinute: 0, days: ['mon','tue','wed','thu','fri'] }
});
await window.electronAPI.getAutomationSettings();
```

Expected: second call returns an object including the `runWindow` you just set. Confirm `~/.claudes/automations.json` contains the new top-level `runWindow` field.

- [ ] **Step 4: Clear the window again**

In the Console:

```javascript
await window.electronAPI.updateAutomationSettings({ runWindow: null });
await window.electronAPI.getAutomationSettings();
```

Expected: returns `runWindow: null`. Confirm the field is `null` in the JSON file.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(automations): persist global run window in settings"
```

---

### Task 4: Allow per-automation `runWindow` in `automations:update`

**Files:**
- Modify: `main.js:1584` — extend the `safeFields` list in the `automations:update` handler.

- [ ] **Step 1: Add `runWindow` to safeFields**

At `main.js:1584`, change:

```javascript
const safeFields = ['name', 'enabled', 'manager'];
```

To:

```javascript
const safeFields = ['name', 'enabled', 'manager', 'runWindow'];
```

- [ ] **Step 2: Verify in DevTools**

Run `npm start`. In the DevTools console of the main window, assuming you have at least one automation, run:

```javascript
const list = await window.electronAPI.getAutomations();
const id = list.automations[0].id;
await window.electronAPI.updateAutomation(id, {
  runWindow: { enabled: true, startHour: 22, startMinute: 0, endHour: 6, endMinute: 0, days: ['mon','tue','wed','thu','fri'] }
});
(await window.electronAPI.getAutomations()).automations.find(a => a.id === id).runWindow;
```

Expected: the returned automation contains the `runWindow` field with the values you set.

- [ ] **Step 3: Clear the per-automation window**

```javascript
await window.electronAPI.updateAutomation(id, { runWindow: null });
```

Expected: the automation's `runWindow` is `null` in the JSON.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(automations): allow runWindow in updateAutomation"
```

---

### Task 5: End-to-end gate test

**Files:** none modified — pure manual verification.

- [ ] **Step 1: Configure a blocking global window**

Run `npm start`. In DevTools console on the main window:

```javascript
// Pick a window that is currently CLOSED.
// Example if current time is 14:00: set 15:00-16:00 today.
const now = new Date();
await window.electronAPI.updateAutomationSettings({
  runWindow: {
    enabled: true,
    startHour: (now.getHours() + 1) % 24, startMinute: 0,
    endHour: (now.getHours() + 2) % 24, endMinute: 0,
    days: ['sun','mon','tue','wed','thu','fri','sat']
  }
});
```

- [ ] **Step 2: Create a 1-minute interval automation**

Using the existing `+ New Automation` UI, create an automation with a simple prompt like `Say hi` and schedule `interval: 1 minute`. Save.

- [ ] **Step 3: Wait 2-3 minutes and confirm it did NOT run**

Expected: the automation card shows no `lastRunAt` update; no run history is created.

- [ ] **Step 4: Confirm manual Run Now still works**

Click Run Now on the automation. Expected: it runs immediately, producing a new run entry. (Manual override bypasses the window.)

- [ ] **Step 5: Clear the window, confirm scheduled run resumes**

```javascript
await window.electronAPI.updateAutomationSettings({ runWindow: null });
```

Wait ~90 seconds. Expected: the automation fires on its 1-minute interval again.

- [ ] **Step 6: Commit anything (no code changes expected)**

If any incidental edits were made, commit. Otherwise proceed.

---

## Phase 2: UI — Global run window (flyout popover + status strip)

### Task 6: Add clock button to the automations flyout header

**Files:**
- Modify: `index.html:225-228` — add a clock button in the flyout header actions row, between the global pause button and the close button.
- Modify: `styles.css` — style for the new button and its indicator dot.

- [ ] **Step 1: Add the clock button markup**

In `index.html`, inside `<div class="automations-flyout-actions">` (currently containing the global-toggle and close buttons), insert a new button between them:

```html
<button id="btn-automations-runwindow" class="automations-flyout-action" title="Run window">&#128344;</button>
```

(The character `&#128344;` is a clock emoji. If this renders inconsistently across platforms, swap for a unicode clock such as `&#9201;` or an SVG — keep consistent with the pause/resume button's style.)

Wrap the button in a relative-positioned container so the popover can anchor under it:

```html
<div class="automations-runwindow-wrap" style="position:relative;display:inline-block;">
  <button id="btn-automations-runwindow" class="automations-flyout-action" title="Run window">&#128344;</button>
  <span id="automations-runwindow-indicator" class="automations-runwindow-indicator hidden"></span>
</div>
```

- [ ] **Step 2: Add CSS for the button and indicator dot**

In `styles.css`, append:

```css
.automations-flyout-action {
  background: transparent;
  color: #ccc;
  border: none;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 14px;
}
.automations-flyout-action:hover { color: #fff; }
.automations-runwindow-indicator {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4caf50;
  pointer-events: none;
}
.automations-runwindow-indicator.hidden { display: none; }
```

- [ ] **Step 3: Verify**

Run `npm start`, open the Automations flyout (right-side panel). Expected: the clock button is visible between pause/resume and close, no indicator dot, no popover yet.

- [ ] **Step 4: Commit**

```bash
git add index.html styles.css
git commit -m "feat(automations): add clock button to flyout header"
```

---

### Task 7: Add run-window popover markup and styles

**Files:**
- Modify: `index.html` — add a popover container right after the `automations-flyout-actions` div (still inside the flyout header).
- Modify: `styles.css` — popover layout.

- [ ] **Step 1: Add popover markup**

Immediately after the `</div>` closing `automations-flyout-actions` (around `index.html:228`, before `</div>` of `automations-flyout-header`), add a hidden container that will hold the popover. Actually, place it as a sibling of the flyout-actions so absolute positioning works — inside the wrap div from Task 6:

Replace the wrap block from Task 6 with:

```html
<div class="automations-runwindow-wrap" style="position:relative;display:inline-block;">
  <button id="btn-automations-runwindow" class="automations-flyout-action" title="Run window">&#128344;</button>
  <span id="automations-runwindow-indicator" class="automations-runwindow-indicator hidden"></span>
  <div id="automations-runwindow-popover" class="runwindow-popover hidden">
    <div class="runwindow-popover-title">Run window</div>
    <label class="runwindow-row">
      <input type="checkbox" id="runwindow-enabled">
      <span>Restrict when automations can run</span>
    </label>
    <div id="runwindow-fields" style="display:none;">
      <div class="runwindow-row">
        <label>From <input type="time" id="runwindow-start" value="09:00"></label>
        <label>To <input type="time" id="runwindow-end" value="17:00"></label>
      </div>
      <div class="runwindow-days">
        <label><input type="checkbox" data-day="mon" checked> M</label>
        <label><input type="checkbox" data-day="tue" checked> T</label>
        <label><input type="checkbox" data-day="wed" checked> W</label>
        <label><input type="checkbox" data-day="thu" checked> T</label>
        <label><input type="checkbox" data-day="fri" checked> F</label>
        <label><input type="checkbox" data-day="sat"> S</label>
        <label><input type="checkbox" data-day="sun"> S</label>
      </div>
      <div id="runwindow-error" class="runwindow-error" style="display:none;"></div>
    </div>
    <div class="runwindow-actions">
      <button id="btn-runwindow-cancel" class="btn-secondary">Cancel</button>
      <button id="btn-runwindow-save" class="btn-primary">Save</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add popover styles**

Append to `styles.css`:

```css
.runwindow-popover {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: #1e1e2f;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 12px;
  min-width: 260px;
  z-index: 1000;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  color: #eee;
  font-size: 12px;
}
.runwindow-popover.hidden { display: none; }
.runwindow-popover-title {
  font-weight: 600;
  margin-bottom: 8px;
  font-size: 13px;
}
.runwindow-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}
.runwindow-row input[type="time"] {
  background: #111;
  color: #eee;
  border: 1px solid #333;
  padding: 2px 4px;
}
.runwindow-days {
  display: flex;
  gap: 4px;
  margin: 8px 0;
  flex-wrap: wrap;
}
.runwindow-days label {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px;
  background: #222;
  border-radius: 3px;
  cursor: pointer;
}
.runwindow-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 10px;
}
.runwindow-error {
  color: #f66;
  font-size: 11px;
  margin-top: 4px;
}
```

(If `.btn-primary` / `.btn-secondary` are not already defined in styles.css, reuse the existing modal button classes the codebase uses — check what `automation-modal` uses for its action buttons and match.)

- [ ] **Step 3: Verify**

Run `npm start`. Open DevTools. In the Elements tab, confirm the popover HTML is in the DOM but its container has `hidden`. No visual change yet.

- [ ] **Step 4: Commit**

```bash
git add index.html styles.css
git commit -m "feat(automations): add run-window popover markup and styles"
```

---

### Task 8: Wire popover open/close/save behavior

**Files:**
- Modify: `renderer.js` — add handlers for the clock button and popover buttons. A good location is near the existing flyout wiring around `renderer.js:8386` (the `refreshAutomationsFlyout` function).

- [ ] **Step 1: Add popover open/close wiring**

Add these new functions in `renderer.js` somewhere near `refreshAutomationsFlyout` (anywhere reachable at load time works; the existing file has wiring attached via `addEventListener` scattered throughout — follow the dominant pattern):

```javascript
var currentRunWindowDraft = null;

function openRunWindowPopover() {
  var pop = document.getElementById('automations-runwindow-popover');
  window.electronAPI.getAutomationSettings().then(function (settings) {
    var w = settings.runWindow || { enabled: false, startHour: 9, startMinute: 0, endHour: 17, endMinute: 0, days: ['mon','tue','wed','thu','fri'] };
    document.getElementById('runwindow-enabled').checked = !!w.enabled;
    document.getElementById('runwindow-fields').style.display = w.enabled ? 'block' : 'none';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    document.getElementById('runwindow-start').value = pad(w.startHour) + ':' + pad(w.startMinute || 0);
    document.getElementById('runwindow-end').value = pad(w.endHour) + ':' + pad(w.endMinute || 0);
    var days = w.days || [];
    var dayEls = pop.querySelectorAll('.runwindow-days input[type="checkbox"]');
    dayEls.forEach(function (el) {
      el.checked = days.indexOf(el.getAttribute('data-day')) !== -1;
    });
    document.getElementById('runwindow-error').style.display = 'none';
    pop.classList.remove('hidden');
  });
}

function closeRunWindowPopover() {
  document.getElementById('automations-runwindow-popover').classList.add('hidden');
}

function saveRunWindowPopover() {
  var enabled = document.getElementById('runwindow-enabled').checked;
  var errEl = document.getElementById('runwindow-error');
  var payload;

  if (!enabled) {
    payload = null;
  } else {
    var startStr = document.getElementById('runwindow-start').value; // "HH:MM"
    var endStr = document.getElementById('runwindow-end').value;
    if (!startStr || !endStr) { errEl.textContent = 'Pick a start and end time'; errEl.style.display = 'block'; return; }
    var sParts = startStr.split(':').map(Number);
    var eParts = endStr.split(':').map(Number);
    var days = Array.prototype.slice.call(document.querySelectorAll('#automations-runwindow-popover .runwindow-days input:checked'))
      .map(function (el) { return el.getAttribute('data-day'); });
    if (days.length === 0) { errEl.textContent = 'Pick at least one day'; errEl.style.display = 'block'; return; }
    if (sParts[0] === eParts[0] && sParts[1] === eParts[1]) {
      errEl.textContent = 'Start and end must differ';
      errEl.style.display = 'block';
      return;
    }
    payload = { enabled: true, startHour: sParts[0], startMinute: sParts[1], endHour: eParts[0], endMinute: eParts[1], days: days };
  }

  window.electronAPI.updateAutomationSettings({ runWindow: payload }).then(function () {
    closeRunWindowPopover();
    refreshAutomationsRunWindowIndicator();
    if (typeof refreshAutomationsStatusStrip === 'function') refreshAutomationsStatusStrip();
  });
}

function refreshAutomationsRunWindowIndicator() {
  var ind = document.getElementById('automations-runwindow-indicator');
  if (!ind) return;
  window.electronAPI.getAutomationSettings().then(function (settings) {
    if (settings.runWindow && settings.runWindow.enabled) ind.classList.remove('hidden');
    else ind.classList.add('hidden');
  });
}
```

- [ ] **Step 2: Toggle fields visibility when checkbox toggles**

Append a listener:

```javascript
document.addEventListener('DOMContentLoaded', function () {
  var enabledEl = document.getElementById('runwindow-enabled');
  if (enabledEl) {
    enabledEl.addEventListener('change', function () {
      document.getElementById('runwindow-fields').style.display = this.checked ? 'block' : 'none';
    });
  }
  var openBtn = document.getElementById('btn-automations-runwindow');
  if (openBtn) openBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var pop = document.getElementById('automations-runwindow-popover');
    if (pop.classList.contains('hidden')) openRunWindowPopover();
    else closeRunWindowPopover();
  });
  var cancelBtn = document.getElementById('btn-runwindow-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeRunWindowPopover);
  var saveBtn = document.getElementById('btn-runwindow-save');
  if (saveBtn) saveBtn.addEventListener('click', saveRunWindowPopover);

  // Dismiss on outside click
  document.addEventListener('click', function (e) {
    var pop = document.getElementById('automations-runwindow-popover');
    var wrap = document.querySelector('.automations-runwindow-wrap');
    if (!pop || pop.classList.contains('hidden')) return;
    if (wrap && !wrap.contains(e.target)) closeRunWindowPopover();
  });

  refreshAutomationsRunWindowIndicator();
});
```

(If the file already has a single `DOMContentLoaded` handler, merge these into it rather than registering a second handler — grep `renderer.js` for `DOMContentLoaded` and add to the existing block. If multiple already exist, match the dominant style.)

- [ ] **Step 3: Verify popover behavior**

Run `npm start`. Open the Automations flyout, click the clock button.
- Expected: popover opens, unchecked.
- Check the box → fields appear. Pick 09:00–17:00, Mon–Fri. Save.
- Indicator dot appears on the clock button.
- Reopen → values persisted.
- Uncheck "Restrict…" → Save. Indicator dot disappears, `~/.claudes/automations.json` has `runWindow: null`.

- [ ] **Step 4: Verify validation**

Open popover, enable, uncheck every day, Save → error "Pick at least one day" shown, nothing persisted.
Set start 10:00 and end 10:00, Save → error "Start and end must differ".

- [ ] **Step 5: Commit**

```bash
git add renderer.js
git commit -m "feat(automations): wire run-window popover behavior"
```

---

### Task 9: Add status strip under the AUTOMATIONS panel toolbar

**Files:**
- Modify: `index.html` — insert a strip element immediately after `<div class="explorer-section-header">…</div>` inside `<div id="tab-automations">` (around `index.html:108`).
- Modify: `styles.css` — strip styles.
- Modify: `renderer.js` — populate and refresh the strip.

- [ ] **Step 1: Add strip markup**

In `index.html`, after line 108 (right after the closing `</div>` of the `explorer-section-header`) and before the `automations-search-bar`, insert:

```html
<div id="automations-runwindow-strip" class="automations-runwindow-strip hidden" title="Click to edit the run window">
  <span class="automations-runwindow-strip-dot"></span>
  <span id="automations-runwindow-strip-text"></span>
</div>
```

- [ ] **Step 2: Add strip styles**

Append to `styles.css`:

```css
.automations-runwindow-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 11px;
  background: #16161f;
  color: #aaa;
  border-bottom: 1px solid #222;
  cursor: pointer;
  user-select: none;
}
.automations-runwindow-strip.hidden { display: none; }
.automations-runwindow-strip:hover { background: #1c1c28; color: #ddd; }
.automations-runwindow-strip-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #666;
  flex: 0 0 auto;
}
.automations-runwindow-strip.active .automations-runwindow-strip-dot { background: #4caf50; }
.automations-runwindow-strip.paused .automations-runwindow-strip-dot { background: #ff9800; }
```

- [ ] **Step 3: Add refresh logic in `renderer.js`**

Add these helpers in `renderer.js` near the popover helpers from Task 8:

```javascript
var runWindowStripTimer = null;

function formatRunWindowSummary(w) {
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var dayLabels = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  var order = ['mon','tue','wed','thu','fri','sat','sun'];
  var sel = order.filter(function (d) { return w.days.indexOf(d) !== -1; }).map(function (d) { return dayLabels[d]; });
  // Condense contiguous weekdays
  var dayStr;
  if (sel.length === 5 && w.days.indexOf('mon') !== -1 && w.days.indexOf('fri') !== -1 && w.days.indexOf('sat') === -1 && w.days.indexOf('sun') === -1) dayStr = 'Mon–Fri';
  else if (sel.length === 7) dayStr = 'Every day';
  else dayStr = sel.join(', ');
  return pad(w.startHour) + ':' + pad(w.startMinute || 0) + '–' + pad(w.endHour) + ':' + pad(w.endMinute || 0) + ' · ' + dayStr;
}

// Pure helper mirroring main.js isWithinRunWindow (renderer-side copy)
function isWithinRunWindow(w, now) {
  if (!w || !w.enabled) return true;
  if (!w.days || w.days.length === 0) return false;
  var names = ['sun','mon','tue','wed','thu','fri','sat'];
  var today = names[now.getDay()];
  var yest = names[(now.getDay() + 6) % 7];
  var nm = now.getHours() * 60 + now.getMinutes();
  var sm = w.startHour * 60 + (w.startMinute || 0);
  var em = w.endHour * 60 + (w.endMinute || 0);
  if (em > sm) return w.days.indexOf(today) !== -1 && nm >= sm && nm < em;
  if (w.days.indexOf(today) !== -1 && nm >= sm) return true;
  if (w.days.indexOf(yest) !== -1 && nm < em) return true;
  return false;
}

function nextOpenMoment(w, from) {
  var names = ['sun','mon','tue','wed','thu','fri','sat'];
  var dayLabel = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var pad = function (n) { return String(n).padStart(2, '0'); };
  // Scan up to 8 days ahead
  for (var i = 0; i < 8; i++) {
    var d = new Date(from.getTime() + i * 86400000);
    var key = names[d.getDay()];
    if (w.days.indexOf(key) === -1) continue;
    var scheduled = new Date(d.getFullYear(), d.getMonth(), d.getDate(), w.startHour, w.startMinute || 0, 0, 0);
    if (scheduled > from) return dayLabel[d.getDay()] + ' ' + pad(w.startHour) + ':' + pad(w.startMinute || 0);
  }
  return '';
}

function refreshAutomationsStatusStrip() {
  var strip = document.getElementById('automations-runwindow-strip');
  if (!strip) return;
  window.electronAPI.getAutomationSettings().then(function (settings) {
    var w = settings.runWindow;
    if (!w || !w.enabled) {
      strip.classList.add('hidden');
      strip.classList.remove('active', 'paused');
      return;
    }
    strip.classList.remove('hidden');
    var now = new Date();
    var open = isWithinRunWindow(w, now);
    var summary = formatRunWindowSummary(w);
    var textEl = document.getElementById('automations-runwindow-strip-text');
    if (open) {
      strip.classList.add('active'); strip.classList.remove('paused');
      textEl.textContent = '⏰ Active · ' + summary;
    } else {
      strip.classList.add('paused'); strip.classList.remove('active');
      var next = nextOpenMoment(w, now);
      textEl.textContent = '⏰ Paused until ' + next + ' · ' + summary;
    }
  });
}

function startAutomationsStatusStripTimer() {
  if (runWindowStripTimer) return;
  refreshAutomationsStatusStrip();
  runWindowStripTimer = setInterval(refreshAutomationsStatusStrip, 60000);
}

function stopAutomationsStatusStripTimer() {
  if (runWindowStripTimer) {
    clearInterval(runWindowStripTimer);
    runWindowStripTimer = null;
  }
}
```

- [ ] **Step 4: Start the timer when the Automations tab is opened**

Grep `renderer.js` for the existing tab-switch handler (look for where `tab-automations` becomes visible). Add `startAutomationsStatusStripTimer();` on activation and `stopAutomationsStatusStripTimer();` on deactivation.

If a tab-switch handler is not obvious, call `startAutomationsStatusStripTimer()` once unconditionally from the DOMContentLoaded block from Task 8 — the cost of a 60s interval when the tab is hidden is negligible.

- [ ] **Step 5: Wire click on strip to open the popover**

In the DOMContentLoaded block from Task 8, add:

```javascript
var strip = document.getElementById('automations-runwindow-strip');
if (strip) strip.addEventListener('click', function () {
  // Ensure the flyout is open so the popover has a visible anchor
  var flyout = document.getElementById('automations-flyout');
  if (flyout && flyout.classList.contains('hidden')) {
    document.getElementById('btn-automations-flyout').click();
  }
  openRunWindowPopover();
});
```

- [ ] **Step 6: Also refresh the strip when the popover saves**

The `saveRunWindowPopover` function from Task 8 already calls `refreshAutomationsStatusStrip()` via the `typeof === 'function'` guard — now that the function exists, the strip updates on save automatically.

- [ ] **Step 7: Verify**

Run `npm start`.
- No global window set → strip hidden.
- Open clock popover, enable, set window 09:00–17:00 Mon–Fri, Save.
  - If current time is inside that window → strip shows `⏰ Active · 09:00–17:00 · Mon–Fri` with green dot.
  - If outside → strip shows `⏰ Paused until <next> · 09:00–17:00 · Mon–Fri` with amber dot.
- Click the strip → flyout opens (if closed), popover opens.
- Clear the window → strip disappears.

- [ ] **Step 8: Commit**

```bash
git add index.html styles.css renderer.js
git commit -m "feat(automations): status strip for global run window"
```

---

## Phase 3: UI — Per-automation run window

### Task 10: Add "Run window" section to the automation modal

**Files:**
- Modify: `index.html` — insert a collapsible section in the automation modal, above `<div id="automation-agents-list"></div>` at `index.html:386`.
- Modify: `styles.css` — collapsible section styles.

- [ ] **Step 1: Insert the section markup**

In `index.html`, just before line 386 (`<div id="automation-agents-list"></div>`), insert:

```html
<div id="automation-runwindow-section" class="automation-runwindow-section">
  <button type="button" id="automation-runwindow-toggle" class="automation-runwindow-toggle">
    <span class="automation-runwindow-chevron">&#9656;</span>
    Run window (optional)
  </button>
  <div id="automation-runwindow-body" class="automation-runwindow-body" style="display:none;">
    <label class="automation-permission-option">
      <input type="checkbox" id="automation-runwindow-enabled">
      <span>Restrict when this automation can run</span>
    </label>
    <div id="automation-runwindow-fields" style="display:none;margin-top:8px;">
      <div class="automation-form-group automation-runwindow-times">
        <label>From <input type="time" id="automation-runwindow-start" value="09:00"></label>
        <label>To <input type="time" id="automation-runwindow-end" value="17:00"></label>
      </div>
      <div class="runwindow-days" id="automation-runwindow-days">
        <label><input type="checkbox" data-day="mon" checked> M</label>
        <label><input type="checkbox" data-day="tue" checked> T</label>
        <label><input type="checkbox" data-day="wed" checked> W</label>
        <label><input type="checkbox" data-day="thu" checked> T</label>
        <label><input type="checkbox" data-day="fri" checked> F</label>
        <label><input type="checkbox" data-day="sat"> S</label>
        <label><input type="checkbox" data-day="sun"> S</label>
      </div>
      <div id="automation-runwindow-error" class="runwindow-error" style="display:none;"></div>
      <div class="automation-permission-hint" style="margin-top:4px;">Intersects with the global run window.</div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Style the collapsible section**

Append to `styles.css`:

```css
.automation-runwindow-section {
  border: 1px solid #2a2a3a;
  border-radius: 4px;
  padding: 8px;
  margin-bottom: 12px;
  background: #141421;
}
.automation-runwindow-toggle {
  background: transparent;
  border: none;
  color: #ddd;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.automation-runwindow-chevron {
  transition: transform 120ms;
  display: inline-block;
}
.automation-runwindow-section.expanded .automation-runwindow-chevron {
  transform: rotate(90deg);
}
.automation-runwindow-body { margin-top: 8px; }
.automation-runwindow-times { display: flex; gap: 12px; }
.automation-runwindow-times input[type="time"] {
  background: #111; color: #eee; border: 1px solid #333; padding: 2px 4px;
}
```

- [ ] **Step 3: Verify**

Run `npm start`, open the automation modal (New Automation or edit an existing one). Expected: collapsed "Run window (optional)" toggle visible above the agents list. Clicking does nothing yet.

- [ ] **Step 4: Commit**

```bash
git add index.html styles.css
git commit -m "feat(automations): add per-automation run-window section markup"
```

---

### Task 11: Wire the modal section's toggle, load, save, and validation

**Files:**
- Modify: `renderer.js:7317` (`openAutomationModal`) — populate the new section from the existing automation's `runWindow`.
- Modify: `renderer.js:7831` (`saveAutomation`) — read the section and include `runWindow` in the update payload.

- [ ] **Step 1: Add toggle expand/collapse and checkbox handlers**

In the DOMContentLoaded block from Task 8, add:

```javascript
var autoRwToggle = document.getElementById('automation-runwindow-toggle');
if (autoRwToggle) autoRwToggle.addEventListener('click', function () {
  var section = document.getElementById('automation-runwindow-section');
  var body = document.getElementById('automation-runwindow-body');
  var isOpen = section.classList.toggle('expanded');
  body.style.display = isOpen ? 'block' : 'none';
});

var autoRwEnabled = document.getElementById('automation-runwindow-enabled');
if (autoRwEnabled) autoRwEnabled.addEventListener('change', function () {
  document.getElementById('automation-runwindow-fields').style.display = this.checked ? 'block' : 'none';
});
```

- [ ] **Step 2: Populate the section when the modal opens**

Locate `function openAutomationModal(existingAutomation)` at `renderer.js:7317`. After the code that populates the existing modal fields but before returning, add:

```javascript
// Populate per-automation runWindow section
var rwSection = document.getElementById('automation-runwindow-section');
var rwBody = document.getElementById('automation-runwindow-body');
var rwEnabled = document.getElementById('automation-runwindow-enabled');
var rwFields = document.getElementById('automation-runwindow-fields');
var rwStart = document.getElementById('automation-runwindow-start');
var rwEnd = document.getElementById('automation-runwindow-end');
var rwErr = document.getElementById('automation-runwindow-error');
var w = existingAutomation && existingAutomation.runWindow;
var pad2 = function (n) { return String(n).padStart(2, '0'); };
if (w && w.enabled) {
  rwSection.classList.add('expanded');
  rwBody.style.display = 'block';
  rwEnabled.checked = true;
  rwFields.style.display = 'block';
  rwStart.value = pad2(w.startHour) + ':' + pad2(w.startMinute || 0);
  rwEnd.value = pad2(w.endHour) + ':' + pad2(w.endMinute || 0);
  var dayEls = document.querySelectorAll('#automation-runwindow-days input[type="checkbox"]');
  var days = w.days || [];
  dayEls.forEach(function (el) { el.checked = days.indexOf(el.getAttribute('data-day')) !== -1; });
} else {
  rwSection.classList.remove('expanded');
  rwBody.style.display = 'none';
  rwEnabled.checked = false;
  rwFields.style.display = 'none';
  rwStart.value = '09:00';
  rwEnd.value = '17:00';
  var dayEls2 = document.querySelectorAll('#automation-runwindow-days input[type="checkbox"]');
  dayEls2.forEach(function (el) {
    var d = el.getAttribute('data-day');
    el.checked = (d !== 'sat' && d !== 'sun');
  });
}
rwErr.style.display = 'none';
```

- [ ] **Step 3: Read & validate the section in `saveAutomation`**

In `saveAutomation` (`renderer.js:7831`), immediately after the circular-dependency validation block (ends around line 7880) and **before** the `modalAgents.map` at line 7889, add:

```javascript
// Build per-automation runWindow
var rwErrEl = document.getElementById('automation-runwindow-error');
rwErrEl.style.display = 'none';
var rwEnabledV = document.getElementById('automation-runwindow-enabled').checked;
var automationRunWindow = null;
if (rwEnabledV) {
  var rwStartStr = document.getElementById('automation-runwindow-start').value;
  var rwEndStr = document.getElementById('automation-runwindow-end').value;
  if (!rwStartStr || !rwEndStr) { rwErrEl.textContent = 'Pick a start and end time'; rwErrEl.style.display = 'block'; return; }
  var sP = rwStartStr.split(':').map(Number);
  var eP = rwEndStr.split(':').map(Number);
  if (sP[0] === eP[0] && sP[1] === eP[1]) { rwErrEl.textContent = 'Start and end must differ'; rwErrEl.style.display = 'block'; return; }
  var rwDays = Array.prototype.slice.call(document.querySelectorAll('#automation-runwindow-days input:checked'))
    .map(function (el) { return el.getAttribute('data-day'); });
  if (rwDays.length === 0) { rwErrEl.textContent = 'Pick at least one day'; rwErrEl.style.display = 'block'; return; }
  automationRunWindow = { enabled: true, startHour: sP[0], startMinute: sP[1], endHour: eP[0], endMinute: eP[1], days: rwDays };
}
```

- [ ] **Step 4: Include `runWindow` when updating/creating the automation**

In `saveAutomation`, find the `updateAutomation` call (currently `renderer.js:7930`):

```javascript
return window.electronAPI.updateAutomation(automationEditingId, { name: automationName, manager: managerConfig });
```

Change to:

```javascript
return window.electronAPI.updateAutomation(automationEditingId, { name: automationName, manager: managerConfig, runWindow: automationRunWindow });
```

And for the create path — find the `config` object at `renderer.js:7950` and add `runWindow`:

```javascript
var config = {
  name: automationName,
  projectPath: activeProjectKey,
  agents: agents,
  manager: managerConfig,
  runWindow: automationRunWindow
};
```

Also confirm the `automations:create` handler in `main.js` passes `runWindow` into the stored automation. Grep:

```bash
grep -n "automations:create" main.js
```

Open the handler body. If it constructs the automation from whitelisted fields, add `runWindow` to that list. If it spreads `config` directly, no change needed.

- [ ] **Step 5: Verify end-to-end**

Run `npm start`.
1. Open New Automation modal. The "Run window (optional)" section is collapsed.
2. Expand, enable, pick 22:00–06:00, days Mon–Sun. Save (with any agent config). Confirm `~/.claudes/automations.json` has `runWindow` on that automation.
3. Re-open for edit. The section is expanded and fields are pre-filled.
4. Uncheck, save. The `runWindow` on the automation becomes `null`.
5. Enable with zero days checked → save blocked with "Pick at least one day".
6. Enable with start == end → save blocked with "Start and end must differ".

- [ ] **Step 6: Commit**

```bash
git add renderer.js main.js
git commit -m "feat(automations): per-automation run window in modal"
```

---

### Task 12: Add small clock badge to automation cards with a per-automation window

**Files:**
- Modify: `renderer.js` — the card-rendering code in `refreshAutomations` / `refreshAutomationsFlyout`.
- Modify: `styles.css` — badge style.

- [ ] **Step 1: Locate card rendering**

Run:

```bash
grep -n "lastRunStatus\|automation-status-badge\|automation-card" renderer.js | head -40
```

Find the function(s) that render each automation's card (both the AUTOMATIONS panel list and the flyout list). Identify where the status badge is appended.

- [ ] **Step 2: Append a clock badge next to the existing status badge**

For each card-rendering site, when the automation has `runWindow && runWindow.enabled`, append a small span after the existing status badge:

```javascript
if (auto.runWindow && auto.runWindow.enabled) {
  var rwBadge = document.createElement('span');
  rwBadge.className = 'automation-runwindow-badge';
  rwBadge.textContent = '⏰';
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var w = auto.runWindow;
  rwBadge.title = 'Runs ' + pad(w.startHour) + ':' + pad(w.startMinute || 0) + '–' + pad(w.endHour) + ':' + pad(w.endMinute || 0) + ' on ' + (w.days || []).join(', ');
  // Insert next to the existing status badge — use the same parent element
  statusBadgeEl.parentNode.appendChild(rwBadge);
}
```

Adapt the variable names to match whatever the card code uses for its existing status badge element. If the code uses an HTML-string concatenation pattern, splice in `' <span class="automation-runwindow-badge" title="…">⏰</span>'`.

- [ ] **Step 3: Style the badge**

Append to `styles.css`:

```css
.automation-runwindow-badge {
  display: inline-block;
  margin-left: 4px;
  color: #8a8;
  font-size: 10px;
  cursor: help;
}
```

- [ ] **Step 4: Verify**

Run `npm start`. An automation with `runWindow.enabled=true` shows a small `⏰` next to its status badge in both the AUTOMATIONS panel and the flyout. Hovering shows the tooltip. Automations without a window show nothing.

- [ ] **Step 5: Commit**

```bash
git add renderer.js styles.css
git commit -m "feat(automations): per-automation runwindow badge on cards"
```

---

## Phase 4: End-to-end verification

### Task 13: Manual verification pass

**Files:** none modified.

- [ ] **Step 1: Intersection behavior**

Set global window 09:00–17:00 Mon–Fri. On one automation, set per-auto window 13:00–14:00 Mon–Fri. Set that automation to interval 1 minute.
- At current time outside 13:00–14:00 → automation does not run (per-auto closed).
- At current time outside 09:00–17:00 → automation does not run (global closed).
- At current time inside both (adjust your computer clock or set windows to cover now) → automation runs.

- [ ] **Step 2: Manual override**

With both windows closed, click Run Now on the automation. Expected: runs immediately.

- [ ] **Step 3: In-progress run survives window close**

Set a long-running prompt on an automation. Set global window to end 2 minutes from now. Trigger a run manually. When 2 minutes pass and the window closes, the in-progress run finishes normally (no kill).

- [ ] **Step 4: `run_after` follows upstream**

Two-agent automation: agent A (interval 1 min), agent B (run_after A). Global window open. Trigger A, watch B run after. Then set global window to close immediately. Trigger A via Run Now. Expected: A runs (manual override), B runs after A (follows upstream).

- [ ] **Step 5: Overnight wrap**

Set global window 22:00–06:00 Mon–Fri. Adjust system clock (or temporarily change window edges to wrap the current time to simulate) and verify the window is considered open. Revert clock.

- [ ] **Step 6: No-catch-up on reopen**

Set a 1-minute interval automation. Set global window to close in 1 min and reopen 3 min later. Let the window close and reopen. Expected: after reopen, the automation fires once on the next scheduler tick (~30s), not 3 times in a burst.

- [ ] **Step 7: Status strip accuracy**

Set global window 13:00–14:00 Mon–Fri. At 12:55, strip reads "Paused until Mon 13:00" (or whichever day). At 13:05, strip refreshes (wait up to 60s) and reads "Active".

- [ ] **Step 8: Commit any tidy-ups**

If no further changes were needed, no commit. Otherwise commit with a message describing the fix.

---

### Task 14: Release

**Files:** version bumped automatically.

- [ ] **Step 1: Run the release command**

Use the repo's release flow — from the user's perspective this is `/release` inside Claude Code. Outside that context, run:

```bash
./release.sh patch
```

Expected: bumps `package.json`, tags, pushes, builds NSIS installer, creates GitHub Release.

- [ ] **Step 2: Smoke-test the installed build**

Install the new version on the host. Confirm the clock button, popover, status strip, and modal section are all present and behave correctly against `~/.claudes/automations.json`.

---

## Self-Review Notes

- **Spec coverage:** Data model (Tasks 3, 4), scheduler gate with intersection and manual override (Tasks 1, 2, 5), flyout clock + popover with validation (Tasks 6–8), status strip with 60s refresh (Task 9), per-automation modal section (Tasks 10, 11), per-automation badge (Task 12), manual override / run_after behavior verification (Task 13). Not-in-scope items are not implemented by design.
- **Overnight wrap:** Helper handles via the `endMinutes <= startMinutes` branch. Verified by Task 13 step 5.
- **No-catch-up:** Naturally falls out because the scheduler is a plain interval that evaluates `shouldRunAgent` each tick; closed windows cause tick-by-tick skips, not a backlog. Verified by Task 13 step 6.
- **IPC divergence from spec:** Uses existing `automations:updateSettings` / `automations:getSettings` instead of a new `updateGlobalRunWindow` channel — noted in plan header.
