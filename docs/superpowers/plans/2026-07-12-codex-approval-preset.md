# Codex Approval Preset Selector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Approval" preset dropdown to Spawn Codex so a Codex column starts at a chosen approval/sandbox level, persisted per-project, defaulting to Auto.

**Architecture:** A pure preset→flags mapping in `lib/codex-spawn.js`; the flags become the Codex column's `cmdArgs` (so respawn/restore replay them via the shipped `cmd`-column rail). A `<select>` in the spawn dropdown (gated by the same `codex-hidden` class as the button) drives the preset; the per-project default lives in `spawnOptions.codexApprovalMode`. The column badge tooltip names the active mode, derived from the column's args so it survives restore.

**Tech Stack:** Electron renderer (vanilla JS, UMD libs via `window.*`), `node:test`/`node:assert` (`npm test` → `node --test "test/*.test.js"`).

## Global Constraints

- Product name "Claudes"; terminology Spawn / Kill / Respawn.
- No global `.hidden` class — new toggled elements use the existing scoped `codex-hidden`.
- Pure logic in `lib/codex-spawn.js` with tests in `test/codex-spawn.test.js`; UMD dual-export (`module.exports` + `window.CodexSpawn`).
- Do NOT touch `buildSpawnArgs()`, the Claude permission-mode selector, headroom, or endpoint presets. The Codex Approval change must NOT alter the Claude `+ Spawn · …` tag summary line.
- Codex CLI flag facts (v0.144.1): `-a untrusted|on-request|never`, `-s read-only|workspace-write|danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`.

---

## File Structure

- **Modify** `lib/codex-spawn.js` — add `CODEX_APPROVAL_PRESETS`, `DEFAULT_CODEX_APPROVAL`, `codexApprovalArgs`, `codexApprovalLabelFromArgs`; change `buildCodexSpawn` to take a preset.
- **Modify** `test/codex-spawn.test.js` — tests for the above.
- **Modify** `index.html` — Approval `<select>` + label row inside `#spawn-dropdown`.
- **Modify** `styles.css` — minor row styling (reuses `.spawn-option`).
- **Modify** `renderer.js` — element refs, load/save persistence, change listener, button click passes the preset, `initCodexUI` reveal, badge-tooltip mode naming.

---

## Task 1: Preset mapping in `lib/codex-spawn.js` (TDD)

**Files:**
- Modify: `lib/codex-spawn.js`
- Test: `test/codex-spawn.test.js`

**Interfaces:**
- Produces:
  - `CODEX_APPROVAL_PRESETS: Array<{ key: string, label: string, args: string[] }>` (also the dropdown order)
  - `DEFAULT_CODEX_APPROVAL: 'auto'`
  - `codexApprovalArgs(key: string): string[]` — matching preset's args (copy), else `[]`
  - `codexApprovalLabelFromArgs(args: string[]): string` — preset label matching args deep-equal; `[]` → 'Codex default'; unmatched non-empty → 'Custom'
  - `buildCodexSpawn(cwd: string|null, preset?: string): { args: string[], opts: { cmd:'codex', cwd:string|null } }`

- [ ] **Step 1: Write the failing tests** (append to `test/codex-spawn.test.js`, and update the existing `buildCodexSpawn` back-compat test)

```js
const {
  CODEX_APPROVAL_PRESETS,
  DEFAULT_CODEX_APPROVAL,
  codexApprovalArgs,
  codexApprovalLabelFromArgs
} = require('../lib/codex-spawn');

test('CODEX_APPROVAL_PRESETS: exact keys and order', () => {
  assert.deepStrictEqual(
    CODEX_APPROVAL_PRESETS.map(function (p) { return p.key; }),
    ['read-only', 'auto', 'full-access', 'yolo', 'codex-default']
  );
  assert.strictEqual(DEFAULT_CODEX_APPROVAL, 'auto');
});

test('codexApprovalArgs: maps each preset to its flags', () => {
  assert.deepStrictEqual(codexApprovalArgs('read-only'), ['-a', 'untrusted', '-s', 'read-only']);
  assert.deepStrictEqual(codexApprovalArgs('auto'), ['-a', 'on-request', '-s', 'workspace-write']);
  assert.deepStrictEqual(codexApprovalArgs('full-access'), ['-a', 'never', '-s', 'danger-full-access']);
  assert.deepStrictEqual(codexApprovalArgs('yolo'), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepStrictEqual(codexApprovalArgs('codex-default'), []);
});

test('codexApprovalArgs: unknown/undefined -> [] (codex default)', () => {
  assert.deepStrictEqual(codexApprovalArgs('bogus'), []);
  assert.deepStrictEqual(codexApprovalArgs(undefined), []);
});

test('codexApprovalArgs: returns a fresh array (no shared mutation)', () => {
  var a = codexApprovalArgs('auto');
  a.push('x');
  assert.deepStrictEqual(codexApprovalArgs('auto'), ['-a', 'on-request', '-s', 'workspace-write']);
});

test('codexApprovalLabelFromArgs: reverse-maps flags to labels', () => {
  assert.strictEqual(codexApprovalLabelFromArgs(['-a', 'on-request', '-s', 'workspace-write']), 'Auto');
  assert.strictEqual(codexApprovalLabelFromArgs(['--dangerously-bypass-approvals-and-sandbox']), 'Yolo (bypass)');
  assert.strictEqual(codexApprovalLabelFromArgs([]), 'Codex default');
  assert.strictEqual(codexApprovalLabelFromArgs(['--weird']), 'Custom');
});

test('buildCodexSpawn: preset drives args; omitted preset stays []', () => {
  assert.deepStrictEqual(buildCodexSpawn('D:/p', 'auto').args, ['-a', 'on-request', '-s', 'workspace-write']);
  assert.deepStrictEqual(buildCodexSpawn('D:/p', 'yolo').args, ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepStrictEqual(buildCodexSpawn('D:/p').args, []);
  assert.strictEqual(buildCodexSpawn('D:/p', 'auto').opts.cmd, 'codex');
});
```

(The existing test `buildCodexSpawn: cmd=codex, empty args, no hardcoded title, no Claude flags` still passes unchanged — it calls `buildCodexSpawn('D:/proj')` with no preset → `args: []`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/codex-spawn.test.js`
Expected: FAIL — `codexApprovalArgs`/`CODEX_APPROVAL_PRESETS` undefined.

- [ ] **Step 3: Implement in `lib/codex-spawn.js`**

Inside the IIFE, before the `buildCodexSpawn` definition, add:

```js
  // Curated approval presets → Codex CLI flags. Order here is the dropdown order.
  // (Codex has two independent axes: -a approval and -s sandbox; plus a bypass flag.)
  var CODEX_APPROVAL_PRESETS = [
    { key: 'read-only', label: 'Read Only', args: ['-a', 'untrusted', '-s', 'read-only'] },
    { key: 'auto', label: 'Auto', args: ['-a', 'on-request', '-s', 'workspace-write'] },
    { key: 'full-access', label: 'Full Access', args: ['-a', 'never', '-s', 'danger-full-access'] },
    { key: 'yolo', label: 'Yolo (bypass)', args: ['--dangerously-bypass-approvals-and-sandbox'] },
    { key: 'codex-default', label: 'Codex default', args: [] }
  ];
  var DEFAULT_CODEX_APPROVAL = 'auto';

  function findPreset(key) {
    for (var i = 0; i < CODEX_APPROVAL_PRESETS.length; i++) {
      if (CODEX_APPROVAL_PRESETS[i].key === key) return CODEX_APPROVAL_PRESETS[i];
    }
    return null;
  }

  // Preset key -> flag args. Unknown/undefined -> [] (Codex uses its own default).
  // Returns a fresh array so callers can't mutate the preset table.
  function codexApprovalArgs(key) {
    var p = findPreset(key);
    return p ? p.args.slice() : [];
  }

  // Reverse map: flag args -> preset label, for the column badge tooltip (works on
  // restore, where only cmdArgs survive). [] -> 'Codex default'; unmatched -> 'Custom'.
  function codexApprovalLabelFromArgs(args) {
    var target = JSON.stringify(args || []);
    for (var i = 0; i < CODEX_APPROVAL_PRESETS.length; i++) {
      if (JSON.stringify(CODEX_APPROVAL_PRESETS[i].args) === target) return CODEX_APPROVAL_PRESETS[i].label;
    }
    return (args && args.length) ? 'Custom' : 'Codex default';
  }
```

Change `buildCodexSpawn` to accept and apply the preset:

```js
  function buildCodexSpawn(cwd, preset) {
    // No `title` — createColumnHeader derives "Codex #<id>". `preset` maps to
    // approval/sandbox flags; omitted -> [] (Codex default), preserving old callers.
    return {
      args: codexApprovalArgs(preset),
      opts: { cmd: 'codex', cwd: cwd == null ? null : cwd }
    };
  }
```

Add the four names to the `api` object:

```js
  var api = {
    codexLookupCommand: codexLookupCommand,
    parseWhichOutput: parseWhichOutput,
    buildCodexSpawn: buildCodexSpawn,
    columnUsesClaudeChrome: columnUsesClaudeChrome,
    CODEX_APPROVAL_PRESETS: CODEX_APPROVAL_PRESETS,
    DEFAULT_CODEX_APPROVAL: DEFAULT_CODEX_APPROVAL,
    codexApprovalArgs: codexApprovalArgs,
    codexApprovalLabelFromArgs: codexApprovalLabelFromArgs
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/codex-spawn.test.js`
Expected: PASS (all, including the pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add lib/codex-spawn.js test/codex-spawn.test.js
git commit -m "feat(codex): approval preset -> CLI flag mapping (pure, tested)"
```

---

## Task 2: Approval `<select>` markup + styling (`index.html`, `styles.css`)

**Files:**
- Modify: `index.html` — inside `#spawn-dropdown`, between the Spawn Codex button and its divider
- Modify: `styles.css` — approval row + hidden state

Non-behavioral (markup/CSS). Verified visually in Task 5.

- [ ] **Step 1: Add the select row (`index.html`)**

The current markup is:

```html
              <button type="button" id="btn-spawn-codex" class="spawn-codex-action codex-hidden" title="Launch the Codex CLI in a new column">+ Spawn Codex</button>
              <div class="spawn-divider codex-hidden" id="spawn-codex-divider"></div>
```

Insert the approval row between the button and the divider:

```html
              <button type="button" id="btn-spawn-codex" class="spawn-codex-action codex-hidden" title="Launch the Codex CLI in a new column">+ Spawn Codex</button>
              <div class="spawn-option spawn-codex-approval-row codex-hidden" id="opt-codex-approval-row" title="Approval/sandbox level Codex starts with. Sandbox enforcement is OS-level (Seatbelt/Landlock); on Windows Codex may not fully sandbox.">
                <label for="opt-codex-approval">Approval:</label>
                <select id="opt-codex-approval">
                  <option value="read-only">Read Only</option>
                  <option value="auto">Auto</option>
                  <option value="full-access">Full Access</option>
                  <option value="yolo">Yolo (bypass)</option>
                  <option value="codex-default">Codex default</option>
                </select>
              </div>
              <div class="spawn-divider codex-hidden" id="spawn-codex-divider"></div>
```

- [ ] **Step 2: Style the row (`styles.css`)**

Append near the existing `.spawn-codex-action` rules:

```css
.spawn-codex-approval-row {
  justify-content: space-between;
}
.spawn-codex-approval-row select {
  margin-left: 8px;
  flex: 1;
  min-width: 0;
}
.spawn-codex-approval-row.codex-hidden { display: none; }
```

- [ ] **Step 3: Commit**

```bash
git add index.html styles.css
git commit -m "feat(codex): Approval preset select markup + styling in spawn dropdown"
```

---

## Task 3: Persistence + wiring (`renderer.js`)

**Files:**
- Modify: `renderer.js`

**Interfaces:**
- Consumes: `window.CodexSpawn.buildCodexSpawn(cwd, preset)`, `DEFAULT_CODEX_APPROVAL`; existing `saveConfig`, `saveSpawnOptions`, `loadSpawnOptions`, `addColumn`, `closeSpawnDropdown`, `initCodexUI`.
- Produces: persisted `spawnOptions.codexApprovalMode`; Codex spawns using the selected preset.

Renderer glue verified manually (Task 5). Preset→args logic is already unit-tested (Task 1).

- [ ] **Step 1: Element refs** — near `var spawnCodexDivider = document.getElementById('spawn-codex-divider');` (~line 24):

```js
var optCodexApproval = document.getElementById('opt-codex-approval');
var codexApprovalRow = document.getElementById('opt-codex-approval-row');
```

- [ ] **Step 2: Persist on save** — in `saveSpawnOptions()`, add the field to the written object (after `endpointModel`):

```js
    endpointModel: currentEndpointModel || null,
    codexApprovalMode: optCodexApproval ? optCodexApproval.value : 'auto'
```

(Add a comma after the previous `endpointModel: ...` line.)

- [ ] **Step 3: Restore on load** — at the end of `loadSpawnOptions()` (after `optCustomArgs.value = opts.customArgs || '';`):

```js
  if (optCodexApproval) {
    optCodexApproval.value = opts.codexApprovalMode || window.CodexSpawn.DEFAULT_CODEX_APPROVAL;
  }
```

- [ ] **Step 4: Save on change** — near the other spawn-option change listeners (e.g. after `optCustomArgs.addEventListener('input', onSpawnOptionChanged);`). Use `saveSpawnOptions` DIRECTLY, not `onSpawnOptionChanged`, so the Claude `+ Spawn · …` tag summary is not touched:

```js
if (optCodexApproval) {
  optCodexApproval.addEventListener('change', function () { saveSpawnOptions(); });
  // Keep the dropdown open while the native select is used.
  optCodexApproval.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  optCodexApproval.addEventListener('click', function (e) { e.stopPropagation(); });
}
```

- [ ] **Step 5: Button click passes the preset** — change the Spawn Codex handler (~line 10714):

```js
    var preset = optCodexApproval ? optCodexApproval.value : window.CodexSpawn.DEFAULT_CODEX_APPROVAL;
    var spec = window.CodexSpawn.buildCodexSpawn(null, preset);
    addColumn(spec.args, null, spec.opts);
```

- [ ] **Step 6: Reveal the row with the button** — in `initCodexUI()`, alongside the button/divider reveal:

```js
    btnSpawnCodex.classList.remove('codex-hidden');
    if (spawnCodexDivider) spawnCodexDivider.classList.remove('codex-hidden');
    if (codexApprovalRow) codexApprovalRow.classList.remove('codex-hidden');
```

- [ ] **Step 7: Syntax + gate**

Run: `node --check renderer.js && node --test "test/*.test.js"`
Expected: renderer OK; all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add renderer.js
git commit -m "feat(codex): persist per-project approval preset and apply it on spawn"
```

---

## Task 4: Badge tooltip names the active mode (`renderer.js`)

**Files:**
- Modify: `renderer.js` — `addColumn` (createColumnHeader call ~line 4161) and `createColumnHeader` (~3721)

**Interfaces:**
- Consumes: `window.CodexSpawn.codexApprovalLabelFromArgs(args)`.

- [ ] **Step 1: Pass a derived label from `addColumn`** — the `addColumn(args, targetRow, opts)` function has `args` (the column's cmdArgs, present for both fresh spawn and restore). Change the header call:

```js
  var header = createColumnHeader(id, opts.title, { cmd: opts.cmd || null });
```

to:

```js
  var codexLabel = (opts.cmd === 'codex' && window.CodexSpawn)
    ? window.CodexSpawn.codexApprovalLabelFromArgs(args || [])
    : null;
  var header = createColumnHeader(id, opts.title, { cmd: opts.cmd || null, codexLabel: codexLabel });
```

- [ ] **Step 2: Use it in the badge tooltip** — change the badge block in `createColumnHeader`:

```js
  if (opts.cmd === 'codex') {
    var codexBadge = document.createElement('span');
    codexBadge.className = 'col-codex-badge';
    codexBadge.textContent = 'Codex';
    codexBadge.title = opts.codexLabel
      ? ('Codex CLI · ' + opts.codexLabel)
      : 'This column runs the Codex CLI, not Claude';
    title.appendChild(codexBadge);
  }
```

- [ ] **Step 3: Syntax + gate**

Run: `node --check renderer.js && node --test "test/*.test.js"`
Expected: renderer OK; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add renderer.js
git commit -m "feat(codex): badge tooltip names the active approval mode"
```

---

## Task 5: Manual verification

No code. Confirm end-to-end.

- [ ] **Step 1:** `npm start` (dev build; leave the production app running).
- [ ] **Step 2:** Open the spawn ▾ dropdown → the "Approval" select shows under "+ Spawn Codex", default **Auto**.
- [ ] **Step 3:** Pick **Full Access**, Spawn Codex → the column's process runs `codex -a never -s danger-full-access` (verify via the running command / process args), badge tooltip reads "Codex CLI · Full Access".
- [ ] **Step 4:** Pick **Read Only**, spawn again → args `-a untrusted -s read-only`; tooltip "Codex CLI · Read Only".
- [ ] **Step 5:** Restart the app → the Approval select still shows the last chosen preset (per-project persistence), and a restored Codex column respawns with the same flags and correct tooltip.
- [ ] **Step 6:** Confirm the Claude `+ Spawn Claude` button and its `+ Spawn · …` tag line are unchanged by any Approval-select interaction.
- [ ] **Step 7:** `npm test` — all pass.

---

## Self-Review

**Spec coverage:** preset dropdown → Task 2/3; five presets + flag mapping → Task 1; default Auto → Task 1 (`DEFAULT_CODEX_APPROVAL`) + Task 3 (load); per-project persistence in `spawnOptions.codexApprovalMode` → Task 3; flags ride `cmdArgs` for restore → inherent (no code, verified Task 5 step 5); badge tooltip names mode, restore-safe via args → Task 4; Windows caveat tooltip → Task 2 (row `title`); no Claude-tag regression → Task 3 step 4 uses `saveSpawnOptions` directly, verified Task 5 step 6.

**Placeholder scan:** none. All steps carry concrete code.

**Type consistency:** `buildCodexSpawn(cwd, preset)` (Task 1) consumed with two args in Task 3 step 5; `codexApprovalLabelFromArgs(args)` (Task 1) consumed in Task 4 step 1; `DEFAULT_CODEX_APPROVAL` (Task 1) consumed in Task 3 steps 3/5; `spawnOptions.codexApprovalMode` written (Task 3 step 2) and read (Task 3 step 3) with matching name; `opts.codexLabel` produced in Task 4 step 1 and consumed in step 2.
