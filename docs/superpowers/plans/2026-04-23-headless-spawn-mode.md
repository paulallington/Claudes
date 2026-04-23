# Headless Spawn Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users fire one-off `claude --print` runs from the app into a bottom dock (streamed output, OS notification on completion) without allocating a terminal column.

**Architecture:** New `runHeadless()` in `main.js` reuses an extracted `spawnHeadlessClaude()` helper shared with the automation runner (`runAgent()`). Runs persist per-project in `<project>/.claudes/headless-runs.json` plus per-run `.txt` files. New UI: a floating chip (bottom-right) toggles a bottom-docked two-pane panel (runs list + detail + new-run input). Spawn dropdown gets a transient "Headless" checkbox that routes the click to the dock instead of a column.

**Tech Stack:** Electron, Node child_process (spawn), `claude --print --output-format stream-json --verbose`, Electron's `Notification` API, Node's built-in `node:test` runner for pure helpers, vanilla JS / CSS in renderer.

**Spec:** `docs/superpowers/specs/2026-04-23-headless-spawn-mode-design.md`

---

## Task 1: Add minimal test harness

**Files:**
- Create: `test/.gitkeep`
- Modify: `package.json` (add `test` script)

- [ ] **Step 1: Create test directory**

```bash
mkdir -p test && touch test/.gitkeep
```

- [ ] **Step 2: Add `test` script to package.json**

In `package.json`, add inside `"scripts"`:

```json
"test": "node --test test/"
```

Final scripts block:

```json
"scripts": {
  "start": "electron .",
  "pty-server": "node pty-server.js",
  "dist": "electron-builder",
  "dist:win": "electron-builder --win",
  "dist:mac": "electron-builder --mac",
  "dist:publish": "electron-builder --publish always",
  "test": "node --test test/"
}
```

- [ ] **Step 3: Verify the harness runs (with no tests yet)**

Run: `npm test`
Expected: exit code 0, output mentions `0 tests`, no crash.

- [ ] **Step 4: Commit**

```bash
git add package.json test/.gitkeep
git commit -m "chore: add node:test harness for unit tests"
```

---

## Task 2: TDD the `deriveHeadlessTitle` helper

Pure function: take a prompt string, return the first non-empty line trimmed and truncated to 80 chars. Used when creating a run's index entry.

**Files:**
- Create: `lib/headless-helpers.js`
- Create: `test/headless-helpers.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/headless-helpers.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveHeadlessTitle } = require('../lib/headless-helpers');

test('deriveHeadlessTitle: returns first non-empty line', () => {
  assert.equal(deriveHeadlessTitle('Hello world'), 'Hello world');
});

test('deriveHeadlessTitle: skips leading blank lines', () => {
  assert.equal(deriveHeadlessTitle('\n\n  \nSecond line here'), 'Second line here');
});

test('deriveHeadlessTitle: trims whitespace', () => {
  assert.equal(deriveHeadlessTitle('   padded   '), 'padded');
});

test('deriveHeadlessTitle: truncates to 80 chars', () => {
  const long = 'a'.repeat(200);
  const result = deriveHeadlessTitle(long);
  assert.equal(result.length, 80);
  assert.equal(result, 'a'.repeat(80));
});

test('deriveHeadlessTitle: empty prompt returns "(empty)"', () => {
  assert.equal(deriveHeadlessTitle(''), '(empty)');
  assert.equal(deriveHeadlessTitle('   \n\n  '), '(empty)');
});

test('deriveHeadlessTitle: non-string input returns "(empty)"', () => {
  assert.equal(deriveHeadlessTitle(null), '(empty)');
  assert.equal(deriveHeadlessTitle(undefined), '(empty)');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/headless-helpers'`.

- [ ] **Step 3: Create the helper module**

Create `lib/headless-helpers.js`:

```javascript
function deriveHeadlessTitle(prompt) {
  if (typeof prompt !== 'string') return '(empty)';
  const lines = prompt.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 80);
  }
  return '(empty)';
}

module.exports = { deriveHeadlessTitle };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all 6 `deriveHeadlessTitle` tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/headless-helpers.js test/headless-helpers.test.js
git commit -m "feat(headless): add deriveHeadlessTitle helper"
```

---

## Task 3: TDD the `evictOldHeadlessRuns` helper

Pure function: given an index array and a cap, return `{ kept, evicted }`. Caller is responsible for deleting `.txt` files of evicted runs. Newest first in input, newest first in output.

**Files:**
- Modify: `lib/headless-helpers.js`
- Modify: `test/headless-helpers.test.js`

- [ ] **Step 1: Add failing tests**

Append to `test/headless-helpers.test.js`:

```javascript
const { evictOldHeadlessRuns } = require('../lib/headless-helpers');

test('evictOldHeadlessRuns: returns all when under cap', () => {
  const runs = [{ runId: 'a' }, { runId: 'b' }];
  const result = evictOldHeadlessRuns(runs, 100);
  assert.deepEqual(result.kept, runs);
  assert.deepEqual(result.evicted, []);
});

test('evictOldHeadlessRuns: evicts oldest when over cap', () => {
  const runs = [
    { runId: '1' }, { runId: '2' }, { runId: '3' }, { runId: '4' }
  ];
  const result = evictOldHeadlessRuns(runs, 2);
  assert.deepEqual(result.kept.map(r => r.runId), ['1', '2']);
  assert.deepEqual(result.evicted.map(r => r.runId), ['3', '4']);
});

test('evictOldHeadlessRuns: cap of 0 evicts everything', () => {
  const runs = [{ runId: 'a' }];
  const result = evictOldHeadlessRuns(runs, 0);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.evicted.map(r => r.runId), ['a']);
});

test('evictOldHeadlessRuns: empty input returns empty arrays', () => {
  const result = evictOldHeadlessRuns([], 100);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.evicted, []);
});

test('evictOldHeadlessRuns: non-array input treated as empty', () => {
  const result = evictOldHeadlessRuns(null, 100);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.evicted, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `evictOldHeadlessRuns is not a function`.

- [ ] **Step 3: Add the helper**

Append to `lib/headless-helpers.js`:

```javascript
function evictOldHeadlessRuns(runs, cap) {
  if (!Array.isArray(runs)) return { kept: [], evicted: [] };
  if (runs.length <= cap) return { kept: runs.slice(), evicted: [] };
  return {
    kept: runs.slice(0, cap),
    evicted: runs.slice(cap)
  };
}

module.exports = { deriveHeadlessTitle, evictOldHeadlessRuns };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all title + eviction tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/headless-helpers.js test/headless-helpers.test.js
git commit -m "feat(headless): add evictOldHeadlessRuns helper"
```

---

## Task 4: Persistence functions in main.js

Read/write the per-project index file and append-stream to the per-run `.txt` file. No IPC yet — these are internal helpers.

**Files:**
- Modify: `main.js` (add after the automations persistence section, near line ~2430 where `getClaudePath` is defined — put the new block immediately before `getClaudePath`)

- [ ] **Step 1: Add persistence functions**

In `main.js`, find `function findClaudePath() {` (around line 2420). Immediately **above** it, insert:

```javascript
// --- Headless Persistence ---

const HEADLESS_INDEX_CAP = 100;
const { deriveHeadlessTitle, evictOldHeadlessRuns } = require('./lib/headless-helpers');

function headlessDir(projectPath) {
  return path.join(projectPath, '.claudes', 'headless-runs');
}

function headlessIndexPath(projectPath) {
  return path.join(projectPath, '.claudes', 'headless-runs.json');
}

function ensureHeadlessDirs(projectPath) {
  fs.mkdirSync(headlessDir(projectPath), { recursive: true });
}

function readHeadlessIndex(projectPath) {
  try {
    const raw = fs.readFileSync(headlessIndexPath(projectPath), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.runs)) return parsed;
    return { runs: [] };
  } catch {
    return { runs: [] };
  }
}

function writeHeadlessIndex(projectPath, index) {
  ensureHeadlessDirs(projectPath);
  fs.writeFileSync(headlessIndexPath(projectPath), JSON.stringify(index, null, 2), 'utf8');
}

function headlessOutputPath(projectPath, runId) {
  return path.join(headlessDir(projectPath), runId + '.txt');
}

function deleteHeadlessOutputFile(projectPath, runId) {
  try { fs.unlinkSync(headlessOutputPath(projectPath, runId)); } catch { /* ignore */ }
}

function applyHeadlessEviction(projectPath, index) {
  const { kept, evicted } = evictOldHeadlessRuns(index.runs, HEADLESS_INDEX_CAP);
  if (evicted.length === 0) return index;
  for (const entry of evicted) deleteHeadlessOutputFile(projectPath, entry.runId);
  return { ...index, runs: kept };
}
```

- [ ] **Step 2: Smoke-check the app still starts**

Run: `npm start`
Expected: app opens without errors. Close it.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(headless): add per-project persistence helpers"
```

---

## Task 5: Crash recovery on startup

On app start, reconcile any `running` entries to `interrupted` across all projects. Fire-and-forget; errors don't block startup.

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Add reconciliation function**

In `main.js`, immediately below the block you just added in Task 4 (still above `function findClaudePath()`), insert:

```javascript
function reconcileInterruptedHeadlessRuns() {
  try {
    const cfg = readConfig();
    if (!Array.isArray(cfg.projects)) return;
    for (const project of cfg.projects) {
      if (!project || !project.path) continue;
      if (!fs.existsSync(headlessIndexPath(project.path))) continue;
      const index = readHeadlessIndex(project.path);
      let changed = false;
      for (const entry of index.runs) {
        if (entry.status === 'running') {
          entry.status = 'interrupted';
          entry.completedAt = new Date().toISOString();
          if (entry.startedAt) {
            entry.durationMs = new Date(entry.completedAt).getTime() - new Date(entry.startedAt).getTime();
          }
          changed = true;
        }
      }
      if (changed) {
        try { writeHeadlessIndex(project.path, index); }
        catch (err) { console.error('headless reconcile write failed:', err); }
      }
    }
  } catch (err) {
    console.error('reconcileInterruptedHeadlessRuns failed:', err);
  }
}
```

- [ ] **Step 2: Call it during app startup**

In `main.js`, find the `app.whenReady().then(...)` block (search for `app.whenReady`). Add `reconcileInterruptedHeadlessRuns();` as the first statement inside the `.then` callback. Example shape:

```javascript
app.whenReady().then(() => {
  reconcileInterruptedHeadlessRuns();
  // ... existing startup code
});
```

- [ ] **Step 3: Manual test**

1. Run `npm start`, close the app cleanly.
2. Pick any project in the sidebar, open a terminal in that folder, and create a fake stuck run:

```bash
mkdir -p .claudes/headless-runs
cat > .claudes/headless-runs.json <<'EOF'
{"runs":[{"runId":"fake1","title":"Stuck run","prompt":"test","status":"running","startedAt":"2026-04-23T10:00:00.000Z","completedAt":null,"durationMs":0,"exitCode":null}]}
EOF
```

3. Run `npm start` again.
4. Read `.claudes/headless-runs.json` — the entry's `status` should now be `interrupted` with a `completedAt` timestamp.
5. Clean up: delete the `.claudes/headless-runs.json` and `.claudes/headless-runs/` you created.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(headless): reconcile interrupted runs on startup"
```

---

## Task 6: Extract `spawnHeadlessClaude` helper from `runAgent`

Factor out the shared spawn + stream-json parse core so both `runAgent` and (upcoming) `runHeadless` use it. This is a pure refactor — no behaviour change. Automations must still work afterwards.

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Add the new helper**

In `main.js`, immediately above `function runAgent(` (search for `async function runAgent` or `function runAgent`), insert:

```javascript
/**
 * Spawn `claude --print` and stream-parse stdout, emitting text chunks as they arrive.
 *
 * Returns: { child, cleanup }
 *   - child: the ChildProcess (caller tracks lifecycle + handles 'close'/'error').
 *   - cleanup(): removes any temp MCP config file created during spawn.
 *
 * Callbacks:
 *   - onText(chunk): called with each extracted text fragment.
 *   - onRaw(chunk): called with each raw stdout chunk (for saving to disk).
 */
function spawnHeadlessClaude(prompt, cwd, opts) {
  opts = opts || {};
  const args = ['--print', prompt, '--output-format', 'stream-json', '--verbose'];
  if (opts.skipPermissions) args.push('--dangerously-skip-permissions');
  if (opts.bare) args.push('--bare');
  if (opts.model) args.push('--model', opts.model);
  if (Array.isArray(opts.extraArgs)) {
    for (const a of opts.extraArgs) args.push(a);
  }

  let mcpConfigPath = null;
  if (opts.mcpConfig) {
    mcpConfigPath = opts.mcpConfigPath;
    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    fs.writeFileSync(mcpConfigPath, JSON.stringify(opts.mcpConfig), 'utf8');
    args.push('--mcp-config', mcpConfigPath);
    if (Array.isArray(opts.allowedTools) && opts.allowedTools.length > 0) {
      args.push('--allowedTools', opts.allowedTools.join(','));
    }
  }

  const child = spawn(getClaudePath(), args, {
    cwd: cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env)
  });

  let streamBuffer = '';
  child.stdout.on('data', (chunk) => {
    const raw = chunk.toString();
    if (typeof opts.onRaw === 'function') opts.onRaw(raw);
    streamBuffer += raw;
    const lines = streamBuffer.split('\n');
    streamBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        let text = '';
        if (evt.type === 'assistant' && evt.message && evt.message.content) {
          evt.message.content.forEach(block => {
            if (block.type === 'text') text += block.text;
          });
        } else if (evt.type === 'content_block_delta' && evt.delta) {
          if (evt.delta.type === 'text_delta') text = evt.delta.text;
        } else if (evt.type === 'result' && evt.result) {
          if (typeof evt.result === 'string') {
            text = evt.result;
          } else if (Array.isArray(evt.result)) {
            evt.result.forEach(block => {
              if (block.type === 'text') text += block.text;
            });
          }
        }
        if (text && typeof opts.onText === 'function') opts.onText(text);
      } catch { /* skip non-JSON lines */ }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (typeof opts.onText === 'function') opts.onText(text);
  });

  const cleanup = () => {
    if (mcpConfigPath) {
      try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
    }
  };

  return { child, cleanup };
}
```

- [ ] **Step 2: Refactor `runAgent` to use it**

In `main.js`, locate the body of `runAgent` (around line 2734 based on spec context). Find this block:

```javascript
const args = ['--print', fullPrompt, '--output-format', 'stream-json', '--verbose'];
if (agent.skipPermissions) args.push('--dangerously-skip-permissions');

// Database MCP config
let mcpConfigPath = null;
if (agent.dbConnectionString) {
  // ... builds mcpConfig, writes file, pushes --mcp-config + --allowedTools ...
}

const child = spawn(getClaudePath(), args, {
  cwd: cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: Object.assign({}, process.env)
});

runningAgents.set(key, child);
agentLiveOutputBuffers.set(key, textChunks);

let streamBuffer = '';
child.stdout.on('data', (chunk) => {
  // ... existing parse loop that pushes to outputChunks, textChunks, and emits IPC ...
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  textChunks.push(text);
  if (mainWindow) mainWindow.webContents.send('automations:agent-output', { automationId, agentId, chunk: text });
});
```

Replace that entire section (from `const args = [...]` down to the stderr handler, inclusive) with:

```javascript
// Build MCP config (if any) — same shape as before
let mcpOpts = null;
if (agent.dbConnectionString) {
  const mcpArgs = ['-y', 'mongodb-mcp-server@latest'];
  if (agent.dbReadOnly !== false) mcpArgs.push('--readOnly');
  const mcpConfig = {
    mcpServers: {
      mongodb: {
        command: 'npx',
        args: mcpArgs,
        env: { MDB_MCP_CONNECTION_STRING: agent.dbConnectionString }
      }
    }
  };
  const mcpConfigPath = path.join(AUTOMATIONS_RUNS_DIR, automationId + '_' + agentId + '_mcp.json');
  let allowedTools = null;
  if (agent.dbReadOnly !== false) {
    allowedTools = [
      'mcp__mongodb__find', 'mcp__mongodb__count', 'mcp__mongodb__collection-indexes',
      'mcp__mongodb__collection-schema', 'mcp__mongodb__collection-storage-size',
      'mcp__mongodb__db-stats', 'mcp__mongodb__explain', 'mcp__mongodb__export',
      'mcp__mongodb__list-collections', 'mcp__mongodb__list-databases',
      'mcp__mongodb__mongodb-logs', 'mcp__mongodb__list-knowledge-sources',
      'mcp__mongodb__search-knowledge',
      'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'
    ];
  }
  mcpOpts = { mcpConfig, mcpConfigPath, allowedTools };
}

const spawned = spawnHeadlessClaude(fullPrompt, cwd, {
  skipPermissions: !!agent.skipPermissions,
  mcpConfig: mcpOpts ? mcpOpts.mcpConfig : null,
  mcpConfigPath: mcpOpts ? mcpOpts.mcpConfigPath : null,
  allowedTools: mcpOpts ? mcpOpts.allowedTools : null,
  onRaw: (raw) => { outputChunks.push(raw); },
  onText: (text) => {
    textChunks.push(text);
    if (mainWindow) mainWindow.webContents.send('automations:agent-output', { automationId, agentId, chunk: text });
  }
});
const child = spawned.child;

runningAgents.set(key, child);
agentLiveOutputBuffers.set(key, textChunks);
```

- [ ] **Step 3: Update the `close` handler to call `spawned.cleanup()`**

Still inside `runAgent`, find the existing `child.on('close', (exitCode) => { ... })` handler. The first statements inside were:

```javascript
runningAgents.delete(key);
agentLiveOutputBuffers.delete(key);
if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
```

Since `mcpConfigPath` is no longer in scope here, replace that third line with `spawned.cleanup();`:

```javascript
runningAgents.delete(key);
agentLiveOutputBuffers.delete(key);
spawned.cleanup();
```

Do the same swap inside the `child.on('error', ...)` handler — replace the `if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch { }` line with `spawned.cleanup();`.

- [ ] **Step 4: Smoke test automations still work**

1. Run `npm start`.
2. Open a project that has an automation configured (or create a trivial one with prompt "say hi briefly").
3. Click "Run now" on the agent.
4. Confirm: output streams into the existing automation flyout, completes with `status: completed`, exit code 0.
5. If no automation is configured, skip this smoke test and rely on Task 13's full pass — but note this means the refactor is only verified end-to-end later.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "refactor(automations): extract spawnHeadlessClaude helper"
```

---

## Task 7: `runHeadless` + IPC handlers (run / list / get / cancel / delete)

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Add `runHeadless` and a running-map**

In `main.js`, below the `spawnHeadlessClaude` definition added in Task 6, insert:

```javascript
// --- Headless Runner ---

const runningHeadless = new Map(); // runId -> { child, cleanup, projectPath }

function runHeadless(projectPath, prompt) {
  if (!projectPath || typeof prompt !== 'string') {
    throw new Error('runHeadless requires projectPath and prompt');
  }
  if (!fs.existsSync(projectPath)) {
    throw new Error('Working directory not found: ' + projectPath);
  }

  const cfg = readConfig();
  const project = (cfg.projects || []).find(p => p && p.path === projectPath);
  const spawnOptions = (project && project.spawnOptions) || {};

  const runId = require('crypto').randomUUID();
  const startedAt = new Date().toISOString();
  const title = deriveHeadlessTitle(prompt);

  ensureHeadlessDirs(projectPath);
  const outputFile = headlessOutputPath(projectPath, runId);
  fs.writeFileSync(outputFile, '', 'utf8');

  // Prepend the new run, then evict oldest beyond cap.
  let index = readHeadlessIndex(projectPath);
  const entry = {
    runId,
    title,
    prompt,
    status: 'running',
    startedAt,
    completedAt: null,
    durationMs: 0,
    exitCode: null
  };
  index = { ...index, runs: [entry, ...(index.runs || [])] };
  index = applyHeadlessEviction(projectPath, index);
  writeHeadlessIndex(projectPath, index);

  if (mainWindow) {
    mainWindow.webContents.send('headless:started', { projectPath, runId, entry });
  }

  let outputStream;
  try {
    outputStream = fs.createWriteStream(outputFile, { flags: 'a' });
  } catch (err) {
    finalizeHeadlessRun(projectPath, runId, 'error', null, 'Failed to open output file: ' + err.message);
    throw err;
  }

  const spawned = spawnHeadlessClaude(prompt, projectPath, {
    skipPermissions: !!spawnOptions.skipPermissions,
    bare: !!spawnOptions.bare,
    model: spawnOptions.model || null,
    onText: (text) => {
      try { outputStream.write(text); } catch { /* ignore */ }
      if (mainWindow) mainWindow.webContents.send('headless:output', { projectPath, runId, chunk: text });
    }
  });

  runningHeadless.set(runId, { child: spawned.child, cleanup: spawned.cleanup, projectPath });

  spawned.child.on('close', (exitCode) => {
    const state = runningHeadless.get(runId);
    const cancelled = state && state.cancelled;
    runningHeadless.delete(runId);
    spawned.cleanup();
    try { outputStream.end(); } catch { /* ignore */ }
    const status = cancelled ? 'cancelled' : (exitCode === 0 ? 'completed' : 'error');
    finalizeHeadlessRun(projectPath, runId, status, exitCode, null);
  });

  spawned.child.on('error', (err) => {
    runningHeadless.delete(runId);
    spawned.cleanup();
    try { outputStream.end(); } catch { /* ignore */ }
    finalizeHeadlessRun(projectPath, runId, 'error', null, err.message);
  });

  return { runId, entry };
}

function finalizeHeadlessRun(projectPath, runId, status, exitCode, errorMessage) {
  const completedAt = new Date().toISOString();
  try {
    const index = readHeadlessIndex(projectPath);
    const entry = index.runs.find(r => r.runId === runId);
    if (entry) {
      entry.status = status;
      entry.completedAt = completedAt;
      entry.exitCode = exitCode;
      if (entry.startedAt) {
        entry.durationMs = new Date(completedAt).getTime() - new Date(entry.startedAt).getTime();
      }
      if (errorMessage) entry.error = errorMessage;
      writeHeadlessIndex(projectPath, index);
    }
    if (mainWindow) {
      mainWindow.webContents.send('headless:completed', {
        projectPath, runId, status, exitCode, completedAt,
        durationMs: entry ? entry.durationMs : 0,
        title: entry ? entry.title : ''
      });
    }
  } catch (err) {
    console.error('finalizeHeadlessRun failed:', err);
  }
}

function cancelHeadless(runId) {
  const entry = runningHeadless.get(runId);
  if (!entry) return false;
  entry.cancelled = true;
  try { entry.child.kill(); } catch { /* ignore */ }
  return true;
}

function deleteHeadless(projectPath, runId) {
  const index = readHeadlessIndex(projectPath);
  const before = index.runs.length;
  index.runs = index.runs.filter(r => r.runId !== runId);
  if (index.runs.length === before) return false;
  writeHeadlessIndex(projectPath, index);
  deleteHeadlessOutputFile(projectPath, runId);
  return true;
}
```

- [ ] **Step 2: Register IPC handlers**

In `main.js`, find a cluster of existing `ipcMain.handle(...)` registrations (e.g. the `automations:*` block). At the end of that cluster add:

```javascript
ipcMain.handle('headless:run', (_event, projectPath, prompt) => {
  try {
    const { runId, entry } = runHeadless(projectPath, prompt);
    return { runId, entry };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('headless:list', (_event, projectPath) => {
  if (!projectPath) return { runs: [] };
  return readHeadlessIndex(projectPath);
});

ipcMain.handle('headless:get', (_event, projectPath, runId) => {
  const index = readHeadlessIndex(projectPath);
  const entry = index.runs.find(r => r.runId === runId);
  if (!entry) return { error: 'Not found' };
  let output = '';
  try { output = fs.readFileSync(headlessOutputPath(projectPath, runId), 'utf8'); } catch { /* absent */ }
  return { entry, output };
});

ipcMain.handle('headless:cancel', (_event, runId) => {
  return { cancelled: cancelHeadless(runId) };
});

ipcMain.handle('headless:delete', (_event, projectPath, runId) => {
  return { deleted: deleteHeadless(projectPath, runId) };
});
```

- [ ] **Step 3: Smoke test from DevTools**

1. Run `npm start`.
2. Open DevTools (Ctrl+Shift+I).
3. In the Console, run:

```javascript
await window.electronAPI || 'preload not yet updated';
// This will fail until preload is wired — that's Task 8. For now, test via a direct ipcRenderer call:
require('electron').ipcRenderer.invoke('headless:run', config.projects[config.activeProjectIndex].path, 'say "hello headless"');
```

(If `require('electron')` isn't available due to `contextIsolation`, defer this smoke test to after Task 8's preload wiring.)

Expected: response contains `{ runId, entry }`. After a few seconds, a file appears at `<project>/.claudes/headless-runs/<runId>.txt` with assistant output.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(headless): add runHeadless runner and IPC handlers"
```

---

## Task 8: OS notification on completion + focus-on-click

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Add the notification + focus routing**

In `main.js`, inside `finalizeHeadlessRun`, immediately before `if (mainWindow) { mainWindow.webContents.send('headless:completed', ...); }`, insert:

```javascript
    // OS notification
    try {
      if (Notification.isSupported()) {
        const titleText = entry ? entry.title : runId;
        let notifTitle = 'Headless run completed';
        if (status === 'error') notifTitle = 'Headless run failed';
        else if (status === 'cancelled') notifTitle = 'Headless run cancelled';
        const notif = new Notification({ title: notifTitle, body: titleText });
        notif.on('click', () => {
          if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('headless:focus-run', { projectPath, runId });
          }
        });
        notif.show();
      }
    } catch (err) { console.error('headless notification failed:', err); }
```

- [ ] **Step 2: Smoke test**

1. Run `npm start`, trigger a headless run (via DevTools or leave for Task 8 verification if preload isn't wired yet).
2. Minimise the window while the run executes.
3. On completion, an OS notification should appear with the run's title.
4. Click the notification — window should un-minimise and focus.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(headless): OS notification on run completion"
```

---

## Task 9: Expose headless API via preload.js

**Files:**
- Modify: `preload.js`

- [ ] **Step 1: Add headless methods to `electronAPI`**

In `preload.js`, inside the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, before the final `onPowerResume` entry, insert:

```javascript
  // Headless runs
  headlessRun: (projectPath, prompt) => ipcRenderer.invoke('headless:run', projectPath, prompt),
  headlessList: (projectPath) => ipcRenderer.invoke('headless:list', projectPath),
  headlessGet: (projectPath, runId) => ipcRenderer.invoke('headless:get', projectPath, runId),
  headlessCancel: (runId) => ipcRenderer.invoke('headless:cancel', runId),
  headlessDelete: (projectPath, runId) => ipcRenderer.invoke('headless:delete', projectPath, runId),
  onHeadlessStarted: (callback) => ipcRenderer.on('headless:started', (_, data) => callback(data)),
  onHeadlessOutput: (callback) => ipcRenderer.on('headless:output', (_, data) => callback(data)),
  onHeadlessCompleted: (callback) => ipcRenderer.on('headless:completed', (_, data) => callback(data)),
  onHeadlessFocusRun: (callback) => ipcRenderer.on('headless:focus-run', (_, data) => callback(data)),
```

- [ ] **Step 2: Smoke test**

1. Run `npm start`.
2. In DevTools Console:

```javascript
await window.electronAPI.headlessRun(config.projects[config.activeProjectIndex].path, 'say "hi"')
```

Expected: returns `{ runId, entry }`. A `headless-runs.json` appears in the project's `.claudes/` folder.

3. Then:

```javascript
await window.electronAPI.headlessList(config.projects[config.activeProjectIndex].path)
```

Expected: `{ runs: [{ runId, title: 'say "hi"', status: 'completed' or 'running', ... }] }`.

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat(headless): expose headless API in preload"
```

---

## Task 10: Chip DOM + CSS

**Files:**
- Modify: `index.html`
- Modify: `styles.css`

- [ ] **Step 1: Add the chip to index.html**

In `index.html`, find the end of the `<body>` tag. Immediately before `</body>`, add:

```html
    <div id="headless-chip" class="headless-chip hidden" title="Headless runs">
      <span id="headless-chip-icon" class="headless-chip-icon"></span>
      <span id="headless-chip-label">0</span>
    </div>
```

- [ ] **Step 2: Add chip styles**

In `styles.css`, append at the end of the file:

```css
/* ============================================================
   Headless Chip
   ============================================================ */

.headless-chip {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 250;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #2a2a45;
  color: #e6e6f0;
  border: 1px solid var(--border-primary, #3a3a5a);
  border-radius: 999px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  user-select: none;
}

.headless-chip:hover {
  background: #34345a;
}

.headless-chip.hidden {
  display: none;
}

.headless-chip.state-running .headless-chip-icon::before {
  content: '\25D4'; /* rotating circle glyph, will animate */
  display: inline-block;
  animation: headless-spin 1s linear infinite;
}

.headless-chip.state-done .headless-chip-icon::before {
  content: '\25CF';
  color: #4ade80;
}

.headless-chip.state-new .headless-chip-icon::before {
  content: '\25CF';
  color: #facc15;
}

.headless-chip.state-error .headless-chip-icon::before {
  content: '\25CF';
  color: #f87171;
}

@keyframes headless-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 3: Smoke test**

Run `npm start`. The chip should **not** be visible (it's `hidden` by default). Manually flip the class in DevTools:

```javascript
document.getElementById('headless-chip').classList.remove('hidden');
document.getElementById('headless-chip').classList.add('state-running');
```

Expected: chip appears bottom-right with a spinning glyph and the label "0".

- [ ] **Step 4: Commit**

```bash
git add index.html styles.css
git commit -m "feat(headless): add chip DOM and styles"
```

---

## Task 11: Dock DOM + CSS (scaffolding only, no logic)

**Files:**
- Modify: `index.html`
- Modify: `styles.css`

- [ ] **Step 1: Add the dock to index.html**

In `index.html`, immediately after the `<div id="headless-chip">...</div>` you added in Task 10, add:

```html
    <div id="headless-dock" class="headless-dock hidden">
      <div class="headless-dock-resize" id="headless-dock-resize"></div>
      <div class="headless-dock-header">
        <div class="headless-dock-title">Headless Runs</div>
        <button id="headless-dock-close" class="headless-dock-close" title="Close">&times;</button>
      </div>
      <div class="headless-dock-input">
        <textarea id="headless-dock-prompt" placeholder="Type a prompt... (Enter to run, Shift+Enter for newline)" rows="2"></textarea>
        <button id="headless-dock-run" class="headless-dock-run">Run</button>
      </div>
      <div class="headless-dock-body">
        <div class="headless-dock-list" id="headless-dock-list"></div>
        <div class="headless-dock-detail" id="headless-dock-detail">
          <div class="headless-dock-empty">Select a run to view output</div>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: Add dock styles**

In `styles.css`, append (after the chip styles from Task 10):

```css
/* ============================================================
   Headless Dock
   ============================================================ */

.headless-dock {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: 40vh;
  min-height: 180px;
  max-height: 85vh;
  z-index: 240;
  background: #1a1a2e;
  border-top: 1px solid var(--border-primary, #3a3a5a);
  display: flex;
  flex-direction: column;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.5);
}

.headless-dock.hidden { display: none; }

.headless-dock-resize {
  height: 6px;
  cursor: ns-resize;
  background: transparent;
  border-top: 1px solid var(--border-primary, #3a3a5a);
}
.headless-dock-resize:hover { background: rgba(255, 255, 255, 0.05); }

.headless-dock-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-primary, #3a3a5a);
}

.headless-dock-title {
  font-size: 13px;
  font-weight: 600;
  color: #e6e6f0;
}

.headless-dock-close {
  background: transparent;
  border: none;
  color: #9a9ab0;
  font-size: 20px;
  cursor: pointer;
  padding: 0 8px;
}
.headless-dock-close:hover { color: #e6e6f0; }

.headless-dock-input {
  display: flex;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-primary, #3a3a5a);
}

.headless-dock-input textarea {
  flex: 1;
  background: #12122a;
  color: #e6e6f0;
  border: 1px solid var(--border-primary, #3a3a5a);
  border-radius: 4px;
  padding: 6px 8px;
  font-family: inherit;
  font-size: 13px;
  resize: vertical;
  min-height: 32px;
  max-height: 160px;
}

.headless-dock-run {
  background: #4a4a7a;
  color: #e6e6f0;
  border: 1px solid var(--border-primary, #3a3a5a);
  border-radius: 4px;
  padding: 0 16px;
  cursor: pointer;
  font-size: 13px;
}
.headless-dock-run:hover { background: #5a5a9a; }
.headless-dock-run:disabled { opacity: 0.5; cursor: not-allowed; }

.headless-dock-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.headless-dock-list {
  width: 30%;
  min-width: 200px;
  max-width: 400px;
  overflow-y: auto;
  border-right: 1px solid var(--border-primary, #3a3a5a);
}

.headless-dock-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 12px;
  color: #c0c0d0;
}
.headless-dock-row:hover { background: rgba(255, 255, 255, 0.03); }
.headless-dock-row.selected { background: rgba(120, 120, 180, 0.15); color: #e6e6f0; }

.headless-dock-row-status {
  width: 10px; height: 10px; border-radius: 50%;
  flex-shrink: 0;
}
.headless-dock-row-status.running { background: #60a5fa; animation: headless-spin 1s linear infinite; }
.headless-dock-row-status.completed { background: #4ade80; }
.headless-dock-row-status.error { background: #f87171; }
.headless-dock-row-status.cancelled { background: #9a9ab0; }
.headless-dock-row-status.interrupted { background: #fbbf24; }

.headless-dock-row-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.headless-dock-row-time { color: #8a8aa0; font-size: 11px; flex-shrink: 0; }

.headless-dock-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.headless-dock-detail-header {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-primary, #3a3a5a);
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: #c0c0d0;
}

.headless-dock-detail-header button {
  background: #2a2a45;
  border: 1px solid var(--border-primary, #3a3a5a);
  color: #e6e6f0;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
}
.headless-dock-detail-header button:hover { background: #34345a; }

.headless-dock-prompt-preview {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  color: #9a9ab0;
}
.headless-dock-prompt-preview.expanded { white-space: pre-wrap; color: #c0c0d0; }

.headless-dock-output {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  font-family: 'Cascadia Mono', 'Consolas', monospace;
  font-size: 12px;
  color: #d0d0e0;
  white-space: pre-wrap;
}

.headless-dock-empty {
  padding: 24px;
  color: #8a8aa0;
  text-align: center;
}
```

- [ ] **Step 3: Smoke test**

Run `npm start`. In DevTools:

```javascript
document.getElementById('headless-dock').classList.remove('hidden');
```

Expected: dock appears at the bottom, 40% tall, with a prompt input and an empty "Select a run to view output" placeholder.

- [ ] **Step 4: Commit**

```bash
git add index.html styles.css
git commit -m "feat(headless): add dock DOM and styles"
```

---

## Task 12: Chip logic + project-switch sync in renderer.js

**Files:**
- Modify: `renderer.js`

- [ ] **Step 1: Add headless state + chip element references**

In `renderer.js`, near the top where other module-level `var` declarations live (e.g. around the existing `var spawnDropdown = document.getElementById('spawn-dropdown');` line at ~23), add:

```javascript
// ============================================================
// Headless Runs
// ============================================================
var headlessChipEl = document.getElementById('headless-chip');
var headlessChipLabelEl = document.getElementById('headless-chip-label');
var headlessDockEl = document.getElementById('headless-dock');
var headlessDockListEl = document.getElementById('headless-dock-list');
var headlessDockDetailEl = document.getElementById('headless-dock-detail');
var headlessDockPromptEl = document.getElementById('headless-dock-prompt');
var headlessDockRunBtn = document.getElementById('headless-dock-run');
var headlessDockCloseBtn = document.getElementById('headless-dock-close');
var headlessDockResizeEl = document.getElementById('headless-dock-resize');

// State: per-project cache of runs (index entries) + per-run output buffer (for selected)
var headlessRunsByProject = {}; // projectPath -> Array<entry>
var headlessSelectedRunId = null;
var headlessOutputBuffer = ''; // buffer for currently selected run
var headlessSeen = new Set(); // runIds whose completion the user has seen (cleared when dock opens)
```

- [ ] **Step 2: Add helper to get the active project's path**

Still near the top of the new section, add:

```javascript
function getActiveProjectPath() {
  if (!config || !Array.isArray(config.projects)) return null;
  var p = config.projects[config.activeProjectIndex];
  return p ? p.path : null;
}
```

- [ ] **Step 3: Add chip update logic**

Add:

```javascript
function updateHeadlessChip() {
  var projectPath = getActiveProjectPath();
  if (!projectPath) { headlessChipEl.classList.add('hidden'); return; }
  var runs = headlessRunsByProject[projectPath] || [];
  if (runs.length === 0) { headlessChipEl.classList.add('hidden'); return; }

  var running = runs.filter(function (r) { return r.status === 'running'; }).length;
  var newlyDone = runs.filter(function (r) {
    return r.status !== 'running' && !headlessSeen.has(r.runId);
  }).length;
  var errored = runs.filter(function (r) { return r.status === 'error'; }).length;

  headlessChipEl.classList.remove('hidden', 'state-running', 'state-done', 'state-new', 'state-error');
  if (running > 0) {
    headlessChipEl.classList.add('state-running');
    headlessChipLabelEl.textContent = running + ' running';
  } else if (newlyDone > 0) {
    headlessChipEl.classList.add(errored > 0 ? 'state-error' : 'state-new');
    headlessChipLabelEl.textContent = runs.length + ' · ' + newlyDone + ' new';
  } else {
    headlessChipEl.classList.add('state-done');
    headlessChipLabelEl.textContent = String(runs.length);
  }
}
```

- [ ] **Step 4: Add load-on-project-switch**

Add:

```javascript
function loadHeadlessRunsForActiveProject() {
  var projectPath = getActiveProjectPath();
  if (!projectPath) { updateHeadlessChip(); return; }
  window.electronAPI.headlessList(projectPath).then(function (index) {
    headlessRunsByProject[projectPath] = (index && index.runs) || [];
    // Mark already-completed runs as seen on initial load, so old results don't
    // show as "new" after an app restart.
    for (var i = 0; i < headlessRunsByProject[projectPath].length; i++) {
      var r = headlessRunsByProject[projectPath][i];
      if (r.status !== 'running') headlessSeen.add(r.runId);
    }
    updateHeadlessChip();
    if (!headlessDockEl.classList.contains('hidden')) renderHeadlessDock();
  });
}
```

- [ ] **Step 5: Hook into `setActiveProject`**

In `renderer.js`, find the function `setActiveProject(...)`. At the end of its body (after all existing logic), add:

```javascript
  loadHeadlessRunsForActiveProject();
```

- [ ] **Step 6: Call it once on initial load**

Find the existing startup block (there's an existing `if (config.activeProjectIndex >= 0 ...) setActiveProject(...)` near line ~638). Immediately after that block, add:

```javascript
loadHeadlessRunsForActiveProject();
```

If `setActiveProject` is called there, the hook from Step 5 makes this redundant — the extra call is fine either way (idempotent).

- [ ] **Step 7: Provide a placeholder `renderHeadlessDock` (filled in in Task 13)**

Add (so the `loadHeadlessRunsForActiveProject` call in Step 4 doesn't throw):

```javascript
function renderHeadlessDock() { /* populated in Task 13 */ }
```

- [ ] **Step 8: Smoke test**

1. Run `npm start`.
2. From DevTools, fire one run to create state:

```javascript
await window.electronAPI.headlessRun(getActiveProjectPath(), 'say "hi"');
```

3. Still in DevTools:

```javascript
loadHeadlessRunsForActiveProject();
```

4. Expected: the chip appears bottom-right with "1 running" (then flipping to "1 · 1 new" after completion, or "1" if the completion-IPC listener is already marking seen — that listener comes in Task 14).

- [ ] **Step 9: Commit**

```bash
git add renderer.js
git commit -m "feat(headless): chip state and project-switch sync"
```

---

## Task 13: Dock open/close + resize + list/detail rendering

**Files:**
- Modify: `renderer.js`

- [ ] **Step 1: Toggle logic**

In `renderer.js`, inside the headless section (still near the top), add:

```javascript
function openHeadlessDock() {
  headlessDockEl.classList.remove('hidden');
  // Mark all current runs as seen
  var projectPath = getActiveProjectPath();
  var runs = (projectPath && headlessRunsByProject[projectPath]) || [];
  for (var i = 0; i < runs.length; i++) {
    if (runs[i].status !== 'running') headlessSeen.add(runs[i].runId);
  }
  updateHeadlessChip();
  renderHeadlessDock();
  headlessDockPromptEl.focus();
}

function closeHeadlessDock() {
  headlessDockEl.classList.add('hidden');
}

function toggleHeadlessDock() {
  if (headlessDockEl.classList.contains('hidden')) openHeadlessDock();
  else closeHeadlessDock();
}

headlessChipEl.addEventListener('click', toggleHeadlessDock);
headlessDockCloseBtn.addEventListener('click', closeHeadlessDock);
```

- [ ] **Step 2: Resize handle**

Add:

```javascript
(function wireHeadlessDockResize() {
  var dragging = false;
  var startY = 0;
  var startHeight = 0;
  headlessDockResizeEl.addEventListener('mousedown', function (e) {
    dragging = true;
    startY = e.clientY;
    startHeight = headlessDockEl.getBoundingClientRect().height;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var dy = startY - e.clientY;
    var newHeight = Math.max(180, Math.min(window.innerHeight * 0.85, startHeight + dy));
    headlessDockEl.style.height = newHeight + 'px';
  });
  document.addEventListener('mouseup', function () {
    if (dragging) {
      dragging = false;
      document.body.style.userSelect = '';
    }
  });
})();
```

- [ ] **Step 3: Replace placeholder `renderHeadlessDock` with real implementation**

Find the `function renderHeadlessDock() { /* populated in Task 13 */ }` placeholder added in Task 12 and replace it with:

```javascript
function renderHeadlessDock() {
  var projectPath = getActiveProjectPath();
  var runs = (projectPath && headlessRunsByProject[projectPath]) || [];

  // List pane
  headlessDockListEl.innerHTML = '';
  if (runs.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'headless-dock-empty';
    empty.textContent = 'No runs yet';
    headlessDockListEl.appendChild(empty);
  } else {
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      var row = document.createElement('div');
      row.className = 'headless-dock-row' + (r.runId === headlessSelectedRunId ? ' selected' : '');
      row.dataset.runId = r.runId;

      var status = document.createElement('div');
      status.className = 'headless-dock-row-status ' + r.status;
      row.appendChild(status);

      var title = document.createElement('div');
      title.className = 'headless-dock-row-title';
      title.textContent = r.title || '(untitled)';
      row.appendChild(title);

      var time = document.createElement('div');
      time.className = 'headless-dock-row-time';
      time.textContent = formatRelativeTime(r.startedAt);
      row.appendChild(time);

      (function (runId) {
        row.addEventListener('click', function () { selectHeadlessRun(runId); });
      })(r.runId);
      headlessDockListEl.appendChild(row);
    }
  }

  // Detail pane
  renderHeadlessDetail();
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  var then = new Date(iso).getTime();
  var diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return diffSec + 's ago';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm ago';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h ago';
  return Math.floor(diffSec / 86400) + 'd ago';
}

function selectHeadlessRun(runId) {
  headlessSelectedRunId = runId;
  headlessOutputBuffer = '';
  renderHeadlessDock();
  var projectPath = getActiveProjectPath();
  if (!projectPath || !runId) return;
  window.electronAPI.headlessGet(projectPath, runId).then(function (res) {
    if (res && res.output != null && headlessSelectedRunId === runId) {
      headlessOutputBuffer = res.output;
      renderHeadlessDetail();
    }
  });
}

function renderHeadlessDetail() {
  var projectPath = getActiveProjectPath();
  var runs = (projectPath && headlessRunsByProject[projectPath]) || [];
  var entry = runs.find(function (r) { return r.runId === headlessSelectedRunId; });
  headlessDockDetailEl.innerHTML = '';
  if (!entry) {
    var empty = document.createElement('div');
    empty.className = 'headless-dock-empty';
    empty.textContent = 'Select a run to view output';
    headlessDockDetailEl.appendChild(empty);
    return;
  }

  var header = document.createElement('div');
  header.className = 'headless-dock-detail-header';

  var preview = document.createElement('div');
  preview.className = 'headless-dock-prompt-preview';
  preview.textContent = entry.prompt;
  preview.title = 'Click to expand';
  preview.addEventListener('click', function () { preview.classList.toggle('expanded'); });
  header.appendChild(preview);

  var meta = document.createElement('div');
  meta.textContent = entry.status + (entry.durationMs ? ' · ' + Math.round(entry.durationMs / 100) / 10 + 's' : '');
  header.appendChild(meta);

  if (entry.status === 'running') {
    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () {
      window.electronAPI.headlessCancel(entry.runId);
    });
    header.appendChild(cancelBtn);
  }

  var copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', function () {
    window.electronAPI.clipboardWriteText(headlessOutputBuffer);
  });
  header.appendChild(copyBtn);

  var deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', function () {
    window.electronAPI.headlessDelete(projectPath, entry.runId).then(function () {
      headlessRunsByProject[projectPath] = (headlessRunsByProject[projectPath] || []).filter(function (r) { return r.runId !== entry.runId; });
      if (headlessSelectedRunId === entry.runId) headlessSelectedRunId = null;
      updateHeadlessChip();
      renderHeadlessDock();
    });
  });
  header.appendChild(deleteBtn);

  headlessDockDetailEl.appendChild(header);

  var output = document.createElement('div');
  output.className = 'headless-dock-output';
  output.id = 'headless-dock-output-body';
  output.textContent = headlessOutputBuffer || (entry.status === 'running' ? '(streaming...)' : '(no output)');
  headlessDockDetailEl.appendChild(output);
}
```

- [ ] **Step 4: Smoke test**

1. Run `npm start`.
2. Fire a headless run via DevTools: `window.electronAPI.headlessRun(getActiveProjectPath(), 'say "hi"')`.
3. Click the chip → dock opens.
4. Click the run in the left list → detail pane shows the prompt, status, and the saved output.

- [ ] **Step 5: Commit**

```bash
git add renderer.js
git commit -m "feat(headless): dock open/close, resize, list and detail rendering"
```

---

## Task 14: New-run input + streaming IPC event listeners

**Files:**
- Modify: `renderer.js`

- [ ] **Step 1: Wire the "Run" button / Enter-to-submit**

In `renderer.js`, inside the headless section, add:

```javascript
function submitHeadlessRun() {
  var prompt = headlessDockPromptEl.value;
  if (!prompt || !prompt.trim()) return;
  var projectPath = getActiveProjectPath();
  if (!projectPath) return;
  headlessDockRunBtn.disabled = true;
  window.electronAPI.headlessRun(projectPath, prompt).then(function (res) {
    headlessDockRunBtn.disabled = false;
    if (res && res.error) {
      alert('Headless run failed: ' + res.error);
      return;
    }
    headlessDockPromptEl.value = '';
    // The onHeadlessStarted handler below will insert the entry; also select it.
    if (res && res.runId) {
      headlessSelectedRunId = res.runId;
      headlessOutputBuffer = '';
    }
  }).catch(function (err) {
    headlessDockRunBtn.disabled = false;
    alert('Headless run failed: ' + (err && err.message ? err.message : err));
  });
}

headlessDockRunBtn.addEventListener('click', submitHeadlessRun);
headlessDockPromptEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitHeadlessRun();
  }
});
```

- [ ] **Step 2: IPC listeners**

Add:

```javascript
window.electronAPI.onHeadlessStarted(function (data) {
  var list = headlessRunsByProject[data.projectPath] || [];
  // Prepend
  list = [data.entry].concat(list.filter(function (r) { return r.runId !== data.entry.runId; }));
  headlessRunsByProject[data.projectPath] = list;
  updateHeadlessChip();
  if (!headlessDockEl.classList.contains('hidden') && getActiveProjectPath() === data.projectPath) {
    renderHeadlessDock();
  }
});

window.electronAPI.onHeadlessOutput(function (data) {
  if (headlessSelectedRunId === data.runId) {
    headlessOutputBuffer += data.chunk;
    var outEl = document.getElementById('headless-dock-output-body');
    if (outEl) {
      outEl.textContent = headlessOutputBuffer;
      outEl.scrollTop = outEl.scrollHeight;
    }
  }
});

window.electronAPI.onHeadlessCompleted(function (data) {
  var runs = headlessRunsByProject[data.projectPath] || [];
  var entry = runs.find(function (r) { return r.runId === data.runId; });
  if (entry) {
    entry.status = data.status;
    entry.exitCode = data.exitCode;
    entry.completedAt = data.completedAt;
    entry.durationMs = data.durationMs;
  }
  updateHeadlessChip();
  if (!headlessDockEl.classList.contains('hidden') && getActiveProjectPath() === data.projectPath) {
    renderHeadlessDock();
  }
});

window.electronAPI.onHeadlessFocusRun(function (data) {
  // Switch to that project if needed, open dock, select run.
  if (getActiveProjectPath() !== data.projectPath) {
    var idx = (config.projects || []).findIndex(function (p) { return p && p.path === data.projectPath; });
    if (idx >= 0) setActiveProject(idx, true);
  }
  openHeadlessDock();
  selectHeadlessRun(data.runId);
});
```

- [ ] **Step 3: Smoke test — end-to-end UI path**

1. Run `npm start`.
2. Click the chip to open the dock (if hidden — it will be hidden until you have runs; for the very first time you can force it: `openHeadlessDock()` in DevTools).
3. Type "say hi briefly" in the prompt, press Enter.
4. Expected: new row appears at the top of the list, selected, output streams into the detail pane, status flips running → completed, OS notification fires.
5. Minimise the window, fire another run. When it completes, click the notification → window focuses, dock opens on that run.

- [ ] **Step 4: Commit**

```bash
git add renderer.js
git commit -m "feat(headless): new-run submit and streaming IPC listeners"
```

---

## Task 15: "Headless" checkbox in spawn dropdown

Transient checkbox — **not** persisted. When checked, clicking Spawn opens the dock focused on input instead of spawning a column.

**Files:**
- Modify: `index.html`
- Modify: `renderer.js`

- [ ] **Step 1: Add checkbox to spawn dropdown**

In `index.html`, inside `<div id="spawn-dropdown" class="spawn-dropdown hidden">`, after the existing `opt-bare` label (around line 197), add:

```html
              <label class="spawn-option">
                <input type="checkbox" id="opt-headless"> Headless
                <span class="spawn-help" title="Run the prompt without a terminal column. Output streams into the headless dock at the bottom.">?</span>
              </label>
```

- [ ] **Step 2: Wire the checkbox behaviour**

In `renderer.js`, find the existing element lookups near the top where `optBare` is declared. Add:

```javascript
var optHeadless = document.getElementById('opt-headless');
```

Then find `btnAdd.addEventListener('click', function () { ... })` (around line 5270). Replace it with:

```javascript
btnAdd.addEventListener('click', function () {
  if (optHeadless.checked) {
    // Consume the transient flag immediately — don't persist it.
    optHeadless.checked = false;
    closeSpawnDropdown();
    openHeadlessDock();
    return;
  }
  var args = buildSpawnArgs();
  addColumn(args.length > 0 ? args : null);
});
```

Also, ensure the checkbox state is **not** added to `buildSpawnArgs`, `saveSpawnOptions`, `loadSpawnOptions`, or `updateSpawnButtonLabel`. Verify it is absent from all four (it should be — you only just added the DOM element). If you accidentally wired it, remove those wirings.

- [ ] **Step 3: Smoke test**

1. Run `npm start`.
2. Click the spawn dropdown chevron → see the new "Headless" checkbox.
3. Check it → click "Spawn Claude" → dock opens, prompt textarea is focused, no column was added.
4. Reopen the dropdown → "Headless" is unchecked again (transient).
5. Unchecked + Spawn → normal column spawn works as before.

- [ ] **Step 4: Commit**

```bash
git add index.html renderer.js
git commit -m "feat(headless): spawn dropdown Headless checkbox routes to dock"
```

---

## Task 16: Full smoke-test pass against the spec checklist

**Files:** none to modify — pure verification.

- [ ] **Step 1: Run the spec's smoke-test checklist**

Follow these in order. All must pass before marking the feature complete.

1. **Single simple run.** Open the app on a valid project. Click Spawn dropdown → Headless → Spawn. Type "say hi" in the dock input. Press Enter. Expected: row appears, streams, completes with green dot, OS notification fires.

2. **Three concurrent runs.** Fire three runs in quick succession. Expected: chip shows "3 running". All three stream independently into their own rows. Clicking each row shows its own output live.

3. **Cancel mid-stream.** Fire a longer-running prompt ("write a haiku about each of the planets in the solar system"). While it's streaming, click the selected run's Cancel button. Expected: row status icon flips to grey (cancelled), output stops growing, OS notification "Headless run cancelled" fires. In Task Manager / `ps`, confirm the `claude` child process is gone (no orphans).

4. **Crash recovery.** Fire a long run. Before it finishes, quit the app (close the window). Relaunch. Expected: the run in the list shows yellow "interrupted" status. `<project>/.claudes/headless-runs.json` shows `status: "interrupted"`.

5. **Index cap.** In DevTools, fire 101 runs:

```javascript
(async () => {
  for (let i = 0; i < 101; i++) {
    await window.electronAPI.headlessRun(getActiveProjectPath(), 'echo ' + i);
    await new Promise(r => setTimeout(r, 50));
  }
})();
```

After all complete, confirm `.claudes/headless-runs.json` has exactly 100 runs, and `.claudes/headless-runs/` has exactly 100 `.txt` files.

6. **Invalid cwd.** Rename the active project's folder on disk. Fire a run. Expected: `headlessRun` returns `{ error: "Working directory not found: ..." }`, no run entry is created. Rename the folder back.

7. **Project switch mid-run.** Fire a run in project A. Switch to project B in the sidebar. Expected: dock empties / shows project B's runs only. Switch back to A. Expected: the run is still there, either still running or completed.

8. **Automations regression.** If the user has any existing automation with an agent, click "Run now" on that agent. Expected: it still works end-to-end (the spawn helper refactor from Task 6 didn't break anything).

9. **Unit tests.** Run `npm test`. Expected: all helper tests pass.

- [ ] **Step 2: If anything fails, file a follow-up task and fix before marking complete**

For each failure, open a short note describing what broke, the likely root cause, and a minimal fix. Do not mark this task complete with open regressions.

- [ ] **Step 3: Commit any final cleanup / fixes discovered during smoke tests**

```bash
git add -A
git commit -m "fix(headless): <specific thing found during smoke test>"
```

(Only if a fix was needed.)

---

## Self-Review Checklist

- [x] **Spec coverage:** every requirement in the spec has a task — chip (T10), dock (T11), spawn checkbox (T15), per-project storage (T4), crash recovery (T5), OS notification (T8), shared helper extraction (T6), retention cap (T4 + runtime use in T7), cancellation (T7+T13), delete (T7+T13), streaming (T7+T14), unlimited concurrency (T7 — no cap, just a Map), interrupted status recovery (T5 + styles T11).
- [x] **No placeholders:** every step contains complete code or a concrete shell command with expected output.
- [x] **Type consistency:** `spawnHeadlessClaude`, `runHeadless`, `finalizeHeadlessRun`, `cancelHeadless`, `deleteHeadless`, `headlessRunsByProject`, `headlessSelectedRunId`, `headlessSeen`, `updateHeadlessChip`, `renderHeadlessDock`, `renderHeadlessDetail`, `selectHeadlessRun`, `openHeadlessDock`, `closeHeadlessDock`, `toggleHeadlessDock`, `submitHeadlessRun`, `loadHeadlessRunsForActiveProject`, `getActiveProjectPath` — names are used consistently across all tasks.
- [x] **IPC names:** `headless:run`, `headless:list`, `headless:get`, `headless:cancel`, `headless:delete`, `headless:started`, `headless:output`, `headless:completed`, `headless:focus-run` — used consistently in main.js, preload, and renderer.
