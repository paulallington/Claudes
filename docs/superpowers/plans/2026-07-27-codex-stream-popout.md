# Codex Stream Popout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a Claude column a read-only popout window that live-streams the Codex plugin jobs Claude launched from it (`/codex:rescue`, `/plan-build-codex`, `/full-codex-review`), which are currently invisible apart from a spinner.

**Architecture:** The Codex plugin appends every job event to a per-job log file on disk. Main resolves that file's location from the column's subscription profile, tails it by byte offset on a poll, and pushes deltas to a small dedicated `codex-watch.html` window. The renderer never sends a filesystem path — only job ids. All parsing logic lives in two pure `lib/` modules with `node --test` coverage.

**Tech Stack:** Electron (main + preload + sandboxed renderer), vanilla JS, `node:test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-27-codex-stream-popout-design.md`

**Branch:** `work/codex-stream-popout` (already merged up to date with `master`)

## Global Constraints

- **No new npm dependencies.** Node built-ins only.
- **`lib/` modules must be pure and UMD.** End every module with both `module.exports = {...}` (for `node --test`) and `window.X = {...}` (for the sandboxed renderer, which cannot `require()`). Follow `lib/profile-resolve.js` exactly.
- **`lib/` modules must not `require('fs')` or `require('path')` unguarded** — they load in the renderer where those don't exist. These three modules need neither.
- **The renderer must never send a filesystem path over IPC for this feature.** It sends `{ workspaceKey, jobId }`; main resolves paths itself. `workspaceKey` is validated by exact match against directory names main itself enumerated.
- **Do not widen `assertInsideAllowedRoots`** or route this feature through `fs:startWatch` / existing file-read IPC.
- **No generic `.hidden` class.** `styles.css` has no global `.hidden`; add a component-scoped class (the existing Codex controls use `codex-hidden`).
- **Terminal/window background colour is `#1a1a2e`** (dark) to match the app.
- **UI terminology:** Spawn (not Add), Kill (not Close), Respawn (not Restart).
- **`npm test` must pass with zero failures**, including pre-existing tests.
- Commit after every GREEN step. Conventional commit prefixes (`feat:`, `fix:`, `test:`, `docs:`).

---

## File Structure

**Create:**
- `lib/codex-watch-log.js` — parses raw log text into typed events. Pure.
- `lib/codex-watch-jobs.js` — filters/orders job records for a session. Pure.
- `test/codex-watch-log.test.js`
- `test/codex-watch-jobs.test.js`
- `codex-watch.html` — the watcher window page.
- `codex-watch.js` — that page's script.

**Modify:**
- `main.js` — `codexwatch:` IPC family, poll loop, `createCodexWatchWindow`.
- `preload.js` — bridge methods (~line 117 area, next to `hasCodex`).
- `renderer.js` — overflow menu row (`showColumnOverflowMenu`, line 7455), header badge, badge poll wiring.
- `styles.css` — badge + watcher window styles.
- `CLAUDE.md` — subsystem entry.

**Key existing references:**
- `main.js:760` `resolveProfileFor(sel)` — profile cascade, returns `{ id, name, colour, isPrimary, env }`.
- `main.js:1291` `lockdownWebContents(wc)` — must be called on the new window.
- `main.js:1408` `createProjectWindow(projectKey)` — the window-creation pattern to mirror (bounds, preload, `titleBarStyle`, `backgroundColor`).
- `renderer.js:7455` `showColumnOverflowMenu(id, x, y)` — has inner `addRow(glyph, label, action)`.
- `renderer.js:7554` `handoffColumnToCodex(id)` — the "Hand off to Codex" row sits just above where the new row goes.

---

## Log format reference (read before Task 1)

The plugin writes with `appendLogLine` (`[ISO] message\n`) and `appendLogBlock` (`\n[ISO] title\n body \n`). Real sample:

```
[2026-07-22T22:41:45.992Z] Starting Codex Task.
[2026-07-22T22:42:01.149Z] Thread ready (019f8bfe-087c-74b2-9289-9f766cc24c85).
[2026-07-22T22:42:05.922Z] Assistant message
I'll trace each review point into the resolver.
[2026-07-22T22:42:07.545Z] Running command: "pwsh.exe" -Command 'rg --files -g...
[2026-07-22T22:42:08.983Z] Command failed: "pwsh.exe" -Command 'rg --files -g... (exit 1)
[2026-07-22T22:42:12.360Z] Command completed: "git ls-files" (exit 0)
```

Rules the parser must implement:
- A line matching `^\[<ISO timestamp>\] ` starts a **new event**. Any following line that does not match that pattern is **body** belonging to the previous event.
- An event is only *complete* once a following header appears (more body may still arrive). The trailing event is returned via `carry`, previewable with `previewEvent`.
- Message classification: `Running command: X` → `command`; `Command completed: X (exit N)` → `command-result` with `ok: true`; `Command failed: X (exit N)` → `command-result` with `ok: false`; `Assistant message` (with or without `captured: …`) → `assistant`; anything else → `status`.
- The plugin truncates long command text with a trailing `...`; flag that as `truncated: true` so the UI can mark it.

---

### Task 1: Log parser — event splitting and carry

**Files:**
- Create: `lib/codex-watch-log.js`
- Test: `test/codex-watch-log.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseLogChunk(carry, chunk) -> { events, carry }` where each event is `{ ts, message, body, type, ok, exitCode, truncated }`. `previewEvent(carry) -> event | null`. Task 2 extends the same file; Tasks 5 and 7 consume both functions.

- [ ] **Step 1: Write failing test**

Create `test/codex-watch-log.test.js`:

```js
// test/codex-watch-log.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parseLogChunk, previewEvent } = require('../lib/codex-watch-log');

test('emits completed events and carries the trailing one', () => {
  const chunk = '[2026-07-22T22:41:45.992Z] Starting Codex Task.\n'
    + '[2026-07-22T22:41:48.672Z] Starting Codex task thread.\n';
  const r = parseLogChunk('', chunk);
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].message, 'Starting Codex Task.');
  assert.strictEqual(r.events[0].ts, '2026-07-22T22:41:45.992Z');
  assert.match(r.carry, /Starting Codex task thread\./);
});

test('a chunk split mid-line does not corrupt the event', () => {
  const a = parseLogChunk('', '[2026-07-22T22:41:45.992Z] Starting Codex Ta');
  assert.deepStrictEqual(a.events, []);
  const b = parseLogChunk(a.carry, 'sk.\n[2026-07-22T22:41:48.672Z] Next.\n');
  assert.strictEqual(b.events.length, 1);
  assert.strictEqual(b.events[0].message, 'Starting Codex Task.');
});

test('body lines attach to the preceding event', () => {
  const chunk = '[2026-07-22T22:42:05.922Z] Assistant message\n'
    + 'line one\nline two\n'
    + '[2026-07-22T22:42:07.545Z] Done.\n';
  const r = parseLogChunk('', chunk);
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].body, 'line one\nline two');
});

test('previewEvent exposes the in-flight trailing event', () => {
  const r = parseLogChunk('', '[2026-07-22T22:41:45.992Z] Starting Codex Task.\n');
  const p = previewEvent(r.carry);
  assert.strictEqual(p.message, 'Starting Codex Task.');
});

test('previewEvent returns null for empty carry', () => {
  assert.strictEqual(previewEvent(''), null);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `node --test test/codex-watch-log.test.js`
Expected: FAIL — `Cannot find module '../lib/codex-watch-log'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/codex-watch-log.js`:

```js
// Parses codex-companion job logs into typed events.
//
// The plugin writes `[<ISO>] message` lines, with any following non-header
// lines forming that event's body (appendLogBlock). An event is therefore only
// complete once the NEXT header arrives, so the trailing event is held in
// `carry` and exposed separately via previewEvent() for live display.

var HEADER_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s?([\s\S]*)$/;

function isHeader(line) {
  return HEADER_RE.test(line);
}

function buildEvent(lines) {
  if (!lines.length) return null;
  var m = HEADER_RE.exec(lines[0]);
  if (!m) return null;
  var body = lines.slice(1).join('\n').replace(/\s+$/, '');
  return classify({
    ts: m[1],
    message: m[2].trim(),
    body: body,
    type: 'status',
    ok: null,
    exitCode: null,
    truncated: false
  });
}

// Extended in Task 2.
function classify(evt) {
  return evt;
}

function parseLogChunk(carry, chunk) {
  var text = String(carry || '') + String(chunk || '');
  var lines = text.split('\n');

  // Group lines into events; each group starts at a header line.
  var groups = [];
  for (var i = 0; i < lines.length; i++) {
    if (isHeader(lines[i]) || !groups.length) groups.push([lines[i]]);
    else groups[groups.length - 1].push(lines[i]);
  }

  // The final group may still grow (more body, or an incomplete line), so it
  // is never emitted — it becomes the new carry.
  var trailing = groups.pop() || [];
  var events = [];
  for (var g = 0; g < groups.length; g++) {
    var evt = buildEvent(groups[g]);
    if (evt) events.push(evt);
  }

  return { events: events, carry: trailing.join('\n') };
}

function previewEvent(carry) {
  var text = String(carry || '');
  if (!text.trim()) return null;
  return buildEvent(text.split('\n'));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseLogChunk, previewEvent };
}
if (typeof window !== 'undefined') {
  window.CodexWatchLog = { parseLogChunk, previewEvent };
}
```

- [ ] **Step 4: Run test and verify it passes**

Run: `node --test test/codex-watch-log.test.js`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add lib/codex-watch-log.js test/codex-watch-log.test.js
git commit -m "feat(codex-watch): parse job logs into events with carry handling"
```

---

### Task 2: Log parser — event classification

**Files:**
- Modify: `lib/codex-watch-log.js` (the `classify` function from Task 1)
- Test: `test/codex-watch-log.test.js` (append)

**Interfaces:**
- Consumes: `buildEvent`/`classify` from Task 1.
- Produces: events now carry `type` of `status | command | command-result | assistant`, plus `ok` (boolean, `command-result` only), `exitCode` (number or null), `truncated` (boolean). Task 7 renders on these fields.

- [ ] **Step 1: Write failing test**

Append to `test/codex-watch-log.test.js`:

```js
test('classifies a running command and flags truncation', () => {
  const r = parseLogChunk('',
    "[2026-07-22T22:42:07.545Z] Running command: \"pwsh.exe\" -Command 'rg --files -g...\n"
    + '[2026-07-22T22:42:08.000Z] x\n');
  assert.strictEqual(r.events[0].type, 'command');
  assert.strictEqual(r.events[0].message, "\"pwsh.exe\" -Command 'rg --files -g...");
  assert.strictEqual(r.events[0].truncated, true);
});

test('classifies a completed command with its exit code', () => {
  const r = parseLogChunk('',
    '[2026-07-22T22:42:12.360Z] Command completed: "git ls-files" (exit 0)\n'
    + '[2026-07-22T22:42:13.000Z] x\n');
  assert.strictEqual(r.events[0].type, 'command-result');
  assert.strictEqual(r.events[0].ok, true);
  assert.strictEqual(r.events[0].exitCode, 0);
  assert.strictEqual(r.events[0].message, '"git ls-files"');
});

test('classifies a failed command', () => {
  const r = parseLogChunk('',
    '[2026-07-22T22:42:08.983Z] Command failed: "rg" (exit 1)\n'
    + '[2026-07-22T22:42:09.000Z] x\n');
  assert.strictEqual(r.events[0].type, 'command-result');
  assert.strictEqual(r.events[0].ok, false);
  assert.strictEqual(r.events[0].exitCode, 1);
});

test('classifies assistant messages in both forms', () => {
  const block = parseLogChunk('',
    '[2026-07-22T22:42:05.922Z] Assistant message\nhello\n[2026-07-22T22:42:06.000Z] x\n');
  assert.strictEqual(block.events[0].type, 'assistant');
  assert.strictEqual(block.events[0].body, 'hello');

  const inline = parseLogChunk('',
    '[2026-07-22T22:42:05.922Z] Assistant message captured: hello there\n'
    + '[2026-07-22T22:42:06.000Z] x\n');
  assert.strictEqual(inline.events[0].type, 'assistant');
  assert.strictEqual(inline.events[0].message, 'hello there');
});

test('anything unrecognised stays a status event', () => {
  const r = parseLogChunk('',
    '[2026-07-22T22:42:01.149Z] Thread ready (019f8bfe).\n[2026-07-22T22:42:02.000Z] x\n');
  assert.strictEqual(r.events[0].type, 'status');
  assert.strictEqual(r.events[0].exitCode, null);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `node --test test/codex-watch-log.test.js`
Expected: FAIL — first new test fails, `type` is `'status'` not `'command'`

- [ ] **Step 3: Write minimal implementation**

Replace the placeholder `classify` in `lib/codex-watch-log.js`:

```js
var RUNNING_RE = /^Running command:\s*([\s\S]*)$/;
var RESULT_RE = /^Command (completed|failed):\s*([\s\S]*?)\s*\(exit (-?\d+)\)$/;
var ASSISTANT_INLINE_RE = /^Assistant message captured:\s*([\s\S]*)$/;

function classify(evt) {
  var result = RESULT_RE.exec(evt.message);
  if (result) {
    evt.type = 'command-result';
    evt.ok = result[1] === 'completed';
    evt.exitCode = Number(result[3]);
    evt.message = result[2];
    evt.truncated = /\.\.\.$/.test(evt.message);
    return evt;
  }

  var running = RUNNING_RE.exec(evt.message);
  if (running) {
    evt.type = 'command';
    evt.message = running[1];
    evt.truncated = /\.\.\.$/.test(evt.message);
    return evt;
  }

  var inlineAssistant = ASSISTANT_INLINE_RE.exec(evt.message);
  if (inlineAssistant) {
    evt.type = 'assistant';
    evt.message = inlineAssistant[1];
    evt.truncated = /\.\.\.$/.test(evt.message);
    return evt;
  }

  if (evt.message === 'Assistant message') {
    evt.type = 'assistant';
    return evt;
  }

  return evt;
}
```

- [ ] **Step 4: Run test and verify it passes**

Run: `node --test test/codex-watch-log.test.js`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add lib/codex-watch-log.js test/codex-watch-log.test.js
git commit -m "feat(codex-watch): classify log events by type and exit code"
```

---

### Task 3: Job selection and counts

**Files:**
- Create: `lib/codex-watch-jobs.js`
- Test: `test/codex-watch-jobs.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `selectSessionJobs(scans, sessionId, nowMs) -> descriptor[]`, where `scans` is `[{ workspaceKey, jobs }]` and a descriptor is `{ id, workspaceKey, title, status, phase, createdAt, elapsedMs, active }`.
  - `summariseCounts(descriptors) -> { total, running }`.
  - `isActiveStatus(status) -> boolean`.

  Task 4 calls `selectSessionJobs`; Task 9 calls `summariseCounts`.

- [ ] **Step 1: Write failing test**

Create `test/codex-watch-jobs.test.js`:

```js
// test/codex-watch-jobs.test.js
const test = require('node:test');
const assert = require('node:assert');
const { selectSessionJobs, summariseCounts, isActiveStatus } = require('../lib/codex-watch-jobs');

const NOW = Date.parse('2026-07-22T23:00:00.000Z');

const SCANS = [
  {
    workspaceKey: 'repo-a-1111111111111111',
    jobs: [
      { id: 'task-1', sessionId: 's1', title: 'Rescue', status: 'running', phase: 'exec', createdAt: '2026-07-22T22:50:00.000Z' },
      { id: 'task-2', sessionId: 's2', title: 'Other session', status: 'running', createdAt: '2026-07-22T22:55:00.000Z' }
    ]
  },
  {
    workspaceKey: 'repo-b-2222222222222222',
    jobs: [
      { id: 'task-3', sessionId: 's1', title: 'Review', status: 'completed', createdAt: '2026-07-22T22:40:00.000Z', completedAt: '2026-07-22T22:45:00.000Z' }
    ]
  }
];

test('keeps only the requested session, across every state dir', () => {
  const jobs = selectSessionJobs(SCANS, 's1', NOW);
  assert.deepStrictEqual(jobs.map((j) => j.id), ['task-1', 'task-3']);
  assert.strictEqual(jobs[0].workspaceKey, 'repo-a-1111111111111111');
});

test('orders active jobs before finished ones', () => {
  const jobs = selectSessionJobs(SCANS, 's1', NOW);
  assert.strictEqual(jobs[0].active, true);
  assert.strictEqual(jobs[1].active, false);
});

test('elapsed runs to now while active, and to completion when finished', () => {
  const jobs = selectSessionJobs(SCANS, 's1', NOW);
  assert.strictEqual(jobs[0].elapsedMs, 10 * 60 * 1000);
  assert.strictEqual(jobs[1].elapsedMs, 5 * 60 * 1000);
});

test('an unparseable createdAt yields null elapsed rather than NaN', () => {
  const jobs = selectSessionJobs(
    [{ workspaceKey: 'k', jobs: [{ id: 'x', sessionId: 's1', status: 'running', createdAt: 'nonsense' }] }],
    's1', NOW);
  assert.strictEqual(jobs[0].elapsedMs, null);
});

test('a missing or empty scan list is not an error', () => {
  assert.deepStrictEqual(selectSessionJobs([], 's1', NOW), []);
  assert.deepStrictEqual(selectSessionJobs(null, 's1', NOW), []);
  assert.deepStrictEqual(selectSessionJobs([{ workspaceKey: 'k' }], 's1', NOW), []);
});

test('no session id matches nothing', () => {
  assert.deepStrictEqual(selectSessionJobs(SCANS, null, NOW), []);
});

test('summariseCounts reports totals and active count', () => {
  const jobs = selectSessionJobs(SCANS, 's1', NOW);
  assert.deepStrictEqual(summariseCounts(jobs), { total: 2, running: 1 });
});

test('queued counts as active', () => {
  assert.strictEqual(isActiveStatus('queued'), true);
  assert.strictEqual(isActiveStatus('running'), true);
  assert.strictEqual(isActiveStatus('completed'), false);
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `node --test test/codex-watch-jobs.test.js`
Expected: FAIL — `Cannot find module '../lib/codex-watch-jobs'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/codex-watch-jobs.js`:

```js
// Selects and orders codex-companion job records for one Claude session.
//
// Job records live in <state-root>/<workspaceKey>/state.json. A single Claude
// session can own jobs in more than one state dir, because EnterWorktree moves
// the session's cwd and the plugin keys its state dir by git repo root — so
// callers pass every scanned dir and we filter by sessionId.

var ACTIVE = ['queued', 'running'];

function isActiveStatus(status) {
  return ACTIVE.indexOf(String(status || '')) !== -1;
}

function toMs(value) {
  if (!value) return null;
  var ms = Date.parse(value);
  return isNaN(ms) ? null : ms;
}

function selectSessionJobs(scans, sessionId, nowMs) {
  if (!Array.isArray(scans) || !sessionId) return [];

  var out = [];
  for (var i = 0; i < scans.length; i++) {
    var scan = scans[i] || {};
    var jobs = Array.isArray(scan.jobs) ? scan.jobs : [];
    for (var j = 0; j < jobs.length; j++) {
      var job = jobs[j] || {};
      if (job.sessionId !== sessionId) continue;

      var active = isActiveStatus(job.status);
      var startMs = toMs(job.createdAt);
      var endMs = active ? nowMs : (toMs(job.completedAt) || toMs(job.updatedAt) || nowMs);

      out.push({
        id: job.id,
        workspaceKey: scan.workspaceKey,
        title: job.title || job.kind || 'Codex job',
        status: job.status || 'unknown',
        phase: job.phase || null,
        createdAt: job.createdAt || null,
        elapsedMs: startMs === null ? null : Math.max(0, endMs - startMs),
        active: active
      });
    }
  }

  // Active first, then newest first. Jobs without a usable createdAt sort last.
  out.sort(function (a, b) {
    if (a.active !== b.active) return a.active ? -1 : 1;
    var am = toMs(a.createdAt);
    var bm = toMs(b.createdAt);
    if (am === null && bm === null) return 0;
    if (am === null) return 1;
    if (bm === null) return -1;
    return bm - am;
  });

  return out;
}

function summariseCounts(descriptors) {
  var list = Array.isArray(descriptors) ? descriptors : [];
  var running = 0;
  for (var i = 0; i < list.length; i++) if (list[i].active) running++;
  return { total: list.length, running: running };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { selectSessionJobs, summariseCounts, isActiveStatus };
}
if (typeof window !== 'undefined') {
  window.CodexWatchJobs = { selectSessionJobs, summariseCounts, isActiveStatus };
}
```

- [ ] **Step 4: Run test and verify it passes**

Run: `node --test test/codex-watch-jobs.test.js`
Expected: PASS — 8 tests

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, zero failures

- [ ] **Step 6: Commit**

```bash
git add lib/codex-watch-jobs.js test/codex-watch-jobs.test.js
git commit -m "feat(codex-watch): select and order a session's Codex jobs"
```

---

### Task 4: Main — profile-aware state root and `codexwatch:listJobs`

**Files:**
- Modify: `main.js` (add a new section near the other Codex helpers, after `hasCodex()`)

**Interfaces:**
- Consumes: `selectSessionJobs` (Task 3); `resolveProfileFor(sel)` (`main.js:760`), which returns `{ id, name, colour, isPrimary, env }` where `env` carries `CLAUDE_CONFIG_DIR` for a secondary profile.
- Produces:
  - `codexWatchStateRoot(sel)` — internal, returns an absolute path string.
  - IPC `codexwatch:listJobs({ sessionId, columnProfileId })` → `{ ok: true, jobs: [...] }` (descriptors from Task 3, no paths) or `{ ok: false, error }`. `columnProfileId` is the column's persisted `profileId` — the same value used at spawn — and no other selector, because `claudeRootFor` treats it as authoritative rather than running the cascade.
  - `codexWatchResolveLogPath(sel, workspaceKey, jobId)` — internal, used by Task 5. Returns `null` when `workspaceKey` is not one of the directories main itself enumerated.

**Why the root is not hardcoded:** the plugin reads `CLAUDE_PLUGIN_DATA` (`scripts/lib/state.mjs:9`). Claude Code derives it from the session's config dir, so a column on a secondary subscription profile writes its Codex logs under that profile's directory, not `~/.claude`.

- [ ] **Step 1: Add the root resolver and scanner**

Insert into `main.js` after `ipcMain.handle('config:hasCodex', ...)`:

```js
// --- Codex watcher -------------------------------------------------------
//
// The codex plugin resolves its state root from CLAUDE_PLUGIN_DATA, which
// Claude Code derives from the session's config dir. A column running under a
// secondary subscription profile therefore writes its job logs under that
// profile's directory, NOT ~/.claude. Resolve per column, never hardcode.

const CODEX_PLUGIN_DATA_SUBPATH = path.join('plugins', 'data', 'codex-openai-codex', 'state');

// Reuse claudeRootFor() rather than reading profile.env.CLAUDE_CONFIG_DIR
// directly: it already coalesces a persisted column's `profileId: null` to
// PRIMARY_ID, which means "Primary, explicitly" for a column and must NOT fall
// through the cascade to a non-Primary default. The column's Codex logs live
// wherever the column actually spawned, so this must match spawn resolution.
function codexWatchStateRoot(sel) {
  return path.join(claudeRootFor(sel && sel.columnProfileId), CODEX_PLUGIN_DATA_SUBPATH);
}

// Enumerate <root>/*/state.json. A torn read is expected — the companion does
// not write these atomically — so a bad file is skipped for this tick rather
// than failing the whole scan.
function codexWatchScan(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }

  const scans = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = fs.readFileSync(path.join(root, entry.name, 'state.json'), 'utf8');
      const parsed = JSON.parse(raw);
      scans.push({ workspaceKey: entry.name, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] });
    } catch { /* missing or torn state.json — skip this dir this tick */ }
  }
  return scans;
}

// Resolve a log path from renderer-supplied ids. workspaceKey is accepted ONLY
// if it exactly matches a directory main itself enumerated, so traversal is
// structurally impossible rather than filtered.
function codexWatchResolveLogPath(sel, workspaceKey, jobId) {
  if (typeof workspaceKey !== 'string' || typeof jobId !== 'string') return null;
  if (!/^[A-Za-z0-9._-]+$/.test(jobId)) return null;

  const root = codexWatchStateRoot(sel);
  const known = codexWatchScan(root).some((s) => s.workspaceKey === workspaceKey);
  if (!known) return null;

  return path.join(root, workspaceKey, 'jobs', jobId + '.log');
}

ipcMain.handle('codexwatch:listJobs', (event, sel) => {
  const opts = sel || {};
  if (!opts.sessionId) return { ok: true, jobs: [] };
  try {
    const scans = codexWatchScan(codexWatchStateRoot(opts));
    return { ok: true, jobs: CodexWatchJobs.selectSessionJobs(scans, opts.sessionId, Date.now()) };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
});
```

- [ ] **Step 2: Require the lib modules at the top of `main.js`**

Add alongside the other `lib/` requires:

```js
const CodexWatchJobs = require('./lib/codex-watch-jobs');
const CodexWatchLog = require('./lib/codex-watch-log');
```

- [ ] **Step 3: Verify main still boots**

Run: `npm start`
Expected: the app launches normally with no console errors mentioning `codexwatch` or `CodexWatch`. Kill it once confirmed.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(codex-watch): resolve the plugin state root per subscription profile"
```

---

### Task 5: Main — stream tailing and the poll loop

**Files:**
- Modify: `main.js` (immediately after Task 4's block)

**Interfaces:**
- Consumes: `codexWatchResolveLogPath`, `codexWatchScan`, `codexWatchStateRoot` (Task 4); `parseLogChunk` (Task 1).
- Produces:
  - IPC `codexwatch:openStream({ workspaceKey, jobId })` → `{ ok: true, events, preview }` or `{ ok: false, error }`. The session and profile come from the window's registration, not the payload, so a watcher window can only ever reach its own column's jobs.
  - IPC `codexwatch:closeStream({ workspaceKey, jobId })` → `{ ok: true }`.
  - Pushed to watcher windows: `codexwatch:delta` with `{ workspaceKey, jobId, events, preview }`, and `codexwatch:jobs` with `{ sessionId, jobs }`.
  - `codexWatchRegisterWindow(win, sel)` / `codexWatchUnregisterWindow(win)` — used by Task 8.

Tail policy: seed from the last 64 KB so a long-running job opens instantly rather than replaying megabytes.

- [ ] **Step 1: Add the tail state and poll loop**

```js
const CODEX_WATCH_TAIL_BYTES = 64 * 1024;
const CODEX_WATCH_FAST_MS = 1000;
const CODEX_WATCH_SLOW_MS = 3000;

// win -> { sel, streams: Map<streamKey, { workspaceKey, jobId, offset, carry }> }
const codexWatchWindows = new Map();
let codexWatchTimer = null;

// '::' is a safe separator: the plugin's dir slug and job ids are both
// [A-Za-z0-9._-], so neither can contain a colon and the key is unambiguous.
function streamKey(workspaceKey, jobId) { return workspaceKey + '::' + jobId; }

function codexWatchReadDelta(logPath, state) {
  let stat;
  try { stat = fs.statSync(logPath); }
  catch { return null; }

  // Truncated or rotated: start over rather than reading from a stale offset.
  if (stat.size < state.offset) { state.offset = 0; state.carry = ''; }
  if (stat.size === state.offset) return null;

  const start = state.offset === 0 && stat.size > CODEX_WATCH_TAIL_BYTES
    ? stat.size - CODEX_WATCH_TAIL_BYTES
    : state.offset;

  let chunk = '';
  const fd = fs.openSync(logPath, 'r');
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    chunk = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  state.offset = stat.size;

  const parsed = CodexWatchLog.parseLogChunk(state.carry, chunk);
  state.carry = parsed.carry;
  return { events: parsed.events, preview: CodexWatchLog.previewEvent(state.carry) };
}

function codexWatchTick() {
  for (const [win, entry] of codexWatchWindows) {
    if (win.isDestroyed()) { codexWatchWindows.delete(win); continue; }

    try {
      const scans = codexWatchScan(codexWatchStateRoot(entry.sel));
      const jobs = CodexWatchJobs.selectSessionJobs(scans, entry.sel.sessionId, Date.now());
      win.webContents.send('codexwatch:jobs', { sessionId: entry.sel.sessionId, jobs });
    } catch { /* transient scan failure — try again next tick */ }

    for (const state of entry.streams.values()) {
      const logPath = codexWatchResolveLogPath(entry.sel, state.workspaceKey, state.jobId);
      if (!logPath) continue;
      let delta = null;
      try { delta = codexWatchReadDelta(logPath, state); }
      catch { continue; }
      if (!delta) continue;
      win.webContents.send('codexwatch:delta', {
        workspaceKey: state.workspaceKey,
        jobId: state.jobId,
        events: delta.events,
        preview: delta.preview
      });
    }
  }

  codexWatchSchedule();
}

function codexWatchSchedule() {
  if (codexWatchTimer) { clearTimeout(codexWatchTimer); codexWatchTimer = null; }
  if (!codexWatchWindows.size) return;
  let anyStream = false;
  for (const entry of codexWatchWindows.values()) if (entry.streams.size) anyStream = true;
  codexWatchTimer = setTimeout(codexWatchTick, anyStream ? CODEX_WATCH_FAST_MS : CODEX_WATCH_SLOW_MS);
}

function codexWatchRegisterWindow(win, sel) {
  codexWatchWindows.set(win, { sel: sel, streams: new Map() });
  codexWatchSchedule();
}

function codexWatchUnregisterWindow(win) {
  codexWatchWindows.delete(win);
  codexWatchSchedule();
}

ipcMain.handle('codexwatch:openStream', (event, opts) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const entry = win && codexWatchWindows.get(win);
  if (!entry) return { ok: false, error: 'not a watcher window' };

  const logPath = codexWatchResolveLogPath(entry.sel, opts && opts.workspaceKey, opts && opts.jobId);
  if (!logPath) return { ok: false, error: 'unknown job' };

  const state = { workspaceKey: opts.workspaceKey, jobId: opts.jobId, offset: 0, carry: '' };
  entry.streams.set(streamKey(opts.workspaceKey, opts.jobId), state);
  codexWatchSchedule();

  let delta = null;
  try { delta = codexWatchReadDelta(logPath, state); }
  catch (err) { return { ok: false, error: err && err.message }; }

  return { ok: true, events: (delta && delta.events) || [], preview: (delta && delta.preview) || null };
});

ipcMain.handle('codexwatch:closeStream', (event, opts) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const entry = win && codexWatchWindows.get(win);
  if (entry && opts) entry.streams.delete(streamKey(opts.workspaceKey, opts.jobId));
  codexWatchSchedule();
  return { ok: true };
});
```

- [ ] **Step 2: Verify main still boots**

Run: `npm start`
Expected: launches cleanly. Kill it once confirmed.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(codex-watch): tail job logs by offset and push deltas to watcher windows"
```

---

### Task 6: Preload bridge

**Files:**
- Modify: `preload.js` (next to `hasCodex`, line ~117)

**Interfaces:**
- Produces: `window.electronAPI.codexWatchListJobs(sel)`, `.codexWatchOpen(o)`, `.codexWatchOpenStream(o)`, `.codexWatchCloseStream(o)`, `.onCodexWatchJobs(cb)`, `.onCodexWatchDelta(cb)`. Tasks 7 and 9 consume these.

Note `codexWatchOpen` (opens the window, Task 8) and `codexWatchOpenStream` (starts tailing a job, Task 5) are different calls — the main window uses the former, the watcher window the latter.

- [ ] **Step 1: Add the bridge methods**

```js
  codexWatchListJobs: (sel) => ipcRenderer.invoke('codexwatch:listJobs', sel),
  codexWatchOpen: (o) => ipcRenderer.invoke('codexwatch:open', o),
  codexWatchOpenStream: (o) => ipcRenderer.invoke('codexwatch:openStream', o),
  codexWatchCloseStream: (o) => ipcRenderer.invoke('codexwatch:closeStream', o),
  onCodexWatchJobs: (cb) => ipcRenderer.on('codexwatch:jobs', (_e, v) => cb(v)),
  onCodexWatchDelta: (cb) => ipcRenderer.on('codexwatch:delta', (_e, v) => cb(v)),
```

- [ ] **Step 2: Commit**

```bash
git add preload.js
git commit -m "feat(codex-watch): expose the watcher IPC to the renderer"
```

---

### Task 7: The watcher window page

**Files:**
- Create: `codex-watch.html`, `codex-watch.js`
- Modify: `styles.css` (append a `codex-watch` section)

**Interfaces:**
- Consumes: `window.electronAPI.codexWatch*` (Task 6); event fields from Tasks 1–3.
- Produces: a page that reads `?sessionId=...&title=...` from its own URL. Task 8 launches it.

- [ ] **Step 1: Create `codex-watch.html`**

Mirror `index.html`'s CSP and structure. Load `lib/codex-watch-log.js` and `lib/codex-watch-jobs.js` before `codex-watch.js` (they self-register on `window`).

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'">
<title>Codex</title>
<link rel="stylesheet" href="styles.css">
<div class="cw-root">
  <aside class="cw-jobs" id="cwJobs"></aside>
  <main class="cw-stream" id="cwStream">
    <div class="cw-empty" id="cwEmpty">No Codex jobs for this column.</div>
    <div class="cw-events" id="cwEvents"></div>
    <button class="cw-jump cw-hidden" id="cwJump">Jump to latest</button>
  </main>
</div>
<script src="lib/codex-watch-log.js"></script>
<script src="lib/codex-watch-jobs.js"></script>
<script src="codex-watch.js"></script>
```

- [ ] **Step 2: Create `codex-watch.js`**

Required behaviour, in order:

1. Parse `sessionId` and `title` from `window.location.search`; set `document.title` to `'Codex · ' + title`.
2. Call `codexWatchListJobs({ sessionId, ... })` on load; render the job list into `#cwJobs` (title, a status dot classed by `active`, and elapsed formatted `m:ss`).
3. Auto-select the first job and call `codexWatchOpenStream`, rendering the returned `events` and `preview`.
4. On `onCodexWatchJobs`, re-render the list, preserving the current selection by `workspaceKey + jobId`. If the selected job disappears (SessionEnd cleanup), keep its tab and events, and append a `status` row reading `Job record ended.` — do not clear the pane.
5. On `onCodexWatchDelta`, ignore payloads whose `workspaceKey`/`jobId` are not the selection; otherwise append `events` and replace the trailing preview row.
6. Switching jobs calls `codexWatchCloseStream` for the old selection then `codexWatchOpenStream` for the new.
7. Autoscroll to bottom on append **only if** already within 40px of the bottom; otherwise reveal `#cwJump`, which scrolls to bottom and hides itself.

Render each event type distinctly: `command` prefixed `$` in a monospace row; `command-result` showing exit code, coloured by `ok`; `assistant` as wrapped prose with its `body`; `status` as dim text. When `truncated` is true, append an ellipsis marker with a `title` attribute explaining the plugin truncated it.

- [ ] **Step 3: Add styles**

Append a `codex-watch` block to `styles.css`. Background `#1a1a2e` to match the app. Add a scoped `.cw-hidden { display: none; }` — do **not** add a global `.hidden`.

- [ ] **Step 4: Commit**

```bash
git add codex-watch.html codex-watch.js styles.css
git commit -m "feat(codex-watch): add the watcher window page"
```

---

### Task 8: Main — create and manage the watcher window

**Files:**
- Modify: `main.js` (near `createProjectWindow`, line 1408)

**Interfaces:**
- Consumes: `codexWatchRegisterWindow` / `codexWatchUnregisterWindow` (Task 5); `lockdownWebContents` (`main.js:1291`).
- Produces: IPC `codexwatch:open({ columnId, sessionId, title, projectKey, workspaceId, columnProfileId })` → `{ ok: true }`. Task 9 calls it.

- [ ] **Step 1: Add the window factory**

Mirror `createProjectWindow`: a `Map` keyed by `columnId` returning/focusing an existing window; `preload.js`; `backgroundColor: '#1a1a2e'`; `lockdownWebContents(win.webContents)`; `win.loadFile('codex-watch.html', { query: { sessionId, title } })`. Register on create, unregister on `closed`.

Bounds: read/write a top-level `codexWatchBounds` key in the config via the same read-modify-write path `popoutBounds` uses (so it cannot interact with the `preserveManagedSettings` guard in `config:saveProjects`), debounced on move/resize like `main.js:1281`. Cascade each additional window by `(index * 24)` px on x and y.

- [ ] **Step 2: Verify the window opens**

Temporarily invoke `codexwatch:open` from DevTools in the main window; confirm a window appears with the correct title and no CSP violations in its console. Remove the temporary call.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(codex-watch): add the watcher BrowserWindow and bounds persistence"
```

---

### Task 9: Renderer — overflow row and header badge

**Files:**
- Modify: `renderer.js` (`showColumnOverflowMenu`, line 7455; add badge helpers near the column header render)
- Modify: `index.html` (load the jobs lib)
- Modify: `styles.css` (badge)

**Interfaces:**
- Consumes: `codexWatchListJobs`, `codexWatchOpen` (Tasks 4/6/8); `summariseCounts` (Task 3).
- Produces: no exports; this is the user-facing entry point.

**Visibility rule (from the spec):** the row is added **only** when the column's session has at least one job, and is never rendered disabled. Do **not** gate on `codexPresent` / `hasCodex()` — that probes the codex *CLI*, whereas this feature depends on the codex *plugin*, and gating on it would leave a dead row on CLI-only machines.

- [ ] **Step 1: Load the jobs lib in the main window**

The renderer is sandboxed and cannot `require()`, so add the script tag to `index.html` alongside the other `lib/` includes, before `renderer.js`. This is what makes `window.CodexWatchJobs.summariseCounts` available:

```html
<script src="lib/codex-watch-jobs.js"></script>
```

- [ ] **Step 2: Add a per-column job-count cache and poll**

Add a module-level `var codexWatchCounts = new Map(); // columnId -> { total, running }`, refreshed on a 3s interval that iterates columns with a `sessionId`, calls `codexWatchListJobs`, and stores `summariseCounts(...)`. Skip the interval entirely while no column has a `sessionId`. Re-render the affected column header when a count changes.

- [ ] **Step 3: Add the overflow row**

In `showColumnOverflowMenu`, immediately after the "Hand off to Codex" row (inside the same `columnUsesClaudeChrome` block):

```js
    var codexJobs = codexWatchCounts.get(id);
    if (codexJobs && codexJobs.total > 0) {
      addRow('◉', 'Watch Codex (' + codexJobs.total + ')', function () {
        openCodexWatchWindow(id);
      });
    }
```

- [ ] **Step 4: Add `openCodexWatchWindow(id)`**

Reads the column, and calls `window.electronAPI.codexWatchOpen({ columnId: id, sessionId: col.sessionId, title: <column title>, projectKey: col.projectKey, workspaceId: <current workspace id>, columnProfileId: col.profileId || null })`. On `{ ok: false }`, show a toast with the error.

- [ ] **Step 5: Add the header badge**

Render a `<span class="col-codex-badge">` in the column header showing `running` when `running > 0`, hidden otherwise (scoped class, no global `.hidden`). Click calls `openCodexWatchWindow(id)`. Style it in `styles.css` consistent with existing header chips.

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS, zero failures

- [ ] **Step 7: Commit**

```bash
git add renderer.js styles.css
git commit -m "feat(codex-watch): add the Watch Codex row and header badge"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md` (Subsystems list)

- [ ] **Step 1: Add the subsystem entry**

Append to the Subsystems list, matching the existing entries' style:

```markdown
- **Codex watcher** (`lib/codex-watch-log.js`, `lib/codex-watch-jobs.js`, `codex-watch.html`, `codexwatch:` handlers) — a read-only popout that live-tails the Codex *plugin* jobs a Claude column launched (`/codex:rescue` and friends), which are otherwise invisible. Distinct from "Hand off to Codex", which spawns an ordinary visible Codex column. Jobs are attributed by Claude `sessionId` across every plugin state dir (a session that enters a worktree writes to a second dir). **The state root is profile-aware** — the plugin reads `CLAUDE_PLUGIN_DATA`, which follows `CLAUDE_CONFIG_DIR`, so a column on a secondary subscription profile logs under that profile's directory; hardcoding `~/.claude` would show zero jobs for non-Primary columns, indistinguishably from having no plugin. The renderer never sends a path — only `{ workspaceKey, jobId }`, with `workspaceKey` validated against directories main itself enumerated, because the state root lies outside `assertInsideAllowedRoots`. UI appears only when the column's session actually has jobs (**not** gated on `hasCodex()`, which probes the CLI rather than the plugin).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the Codex watcher subsystem"
```

---

## Manual acceptance (required — the suite cannot verify this)

`npm test` proves the parsers and nothing about the window. Per CLAUDE.md's own warning, a green suite here is necessary and not sufficient. Run `npm install` first if working in a fresh worktree — `index.html` and `codex-watch.html` load from `node_modules`, and the suite passes without it.

1. `npm start`, open a project, spawn a Claude column.
2. In that column, run `/codex:rescue --background <small task>`.
3. Confirm the header badge appears within ~3s.
4. Open the overflow menu → confirm "Watch Codex (1)" is present; open it.
5. Confirm the stream renders live, showing commands and assistant messages as they happen, and autoscrolls.
6. Scroll up mid-stream → confirm autoscroll stops and "Jump to latest" appears and works.
7. Start a second concurrent job → confirm both are listed and switching between them works.
8. Let a job finish → confirm it stays readable in the list.
9. Kill the column → confirm the window stays open and keeps its content.
10. Confirm no "Watch Codex" row and no badge on a column that has never run a Codex job.
11. **If a secondary subscription profile is configured:** assign a column to it, run a job, and confirm the jobs are found (this is the profile-aware root path — the one most likely to regress silently).

## Review gate

Per CLAUDE.md's AIDP workflow, run the `reviewer` agent on `git diff master...HEAD` before merging. Escalation to Sol is **not** required here — this is read-only, local, adds no dependencies, and touches no money/auth/irreversible surface — but the traversal guard in `codexWatchResolveLogPath` and the "no paths from the renderer" boundary are the two things a reviewer should specifically confirm.
