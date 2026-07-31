'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CodexSpawn = require('../lib/codex-spawn');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

const THREAD = '019fb86e-d6c5-7202-bf7c-258981429c4a';
const OLD_THREAD = '019fb86e-901e-7580-8b4d-a512d317bcab';
const CLAIM = '0123456789abcdef0123456789abcdef';

function functionSource(source, name) {
  const functionAt = source.indexOf(`function ${name}`);
  assert.notEqual(functionAt, -1, `${name} must exist`);
  const start = source.slice(Math.max(0, functionAt - 6), functionAt) === 'async '
    ? functionAt - 6
    : functionAt;
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test('main publishes only validated claim identities and authorizes mode-aware tickets', () => {
  const publisher = functionSource(main, 'publishCodexThreadClaimed');
  const sent = [];
  const BrowserWindow = {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }]
  };
  const publish = new Function('BrowserWindow', 'isCodexThreadId', `${publisher}; return publishCodexThreadClaimed;`)(
    BrowserWindow,
    CodexSpawn.isCodexThreadId
  );

  publish({ claimId: CLAIM, threadId: THREAD, cwd: 'D:/must-not-leak', token: 'secret' });
  publish({ claimId: CLAIM.toUpperCase(), threadId: THREAD });
  publish({ claimId: CLAIM, threadId: '../../bad' });
  assert.deepStrictEqual(sent, [['codex:threadClaimed', { claimId: CLAIM, threadId: THREAD }]]);

  const prepare = main.slice(
    main.indexOf("ipcMain.handle('codex:prepareThread'"),
    main.indexOf("ipcMain.handle('codex:getThreadState'", main.indexOf("ipcMain.handle('codex:prepareThread'"))
  );
  assert.match(prepare, /mode:\s*prepared\.mode/);
  assert.match(prepare, /prepared\.mode === 'fresh'[\s\S]*claimId:\s*prepared\.claimId/);
  assert.match(prepare, /prepared\.mode === 'resume'[\s\S]*threadId:\s*prepared\.threadId/);
  assert.match(main, /onThreadClaimed:\s*publishCodexThreadClaimed/);
});

test('preload claim listener filters payloads and follows the unsubscribe convention', () => {
  const listeners = new Map();
  let exposed;
  const ipcRenderer = {
    invoke() {},
    send() {},
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    }
  };
  vm.runInNewContext(preload, {
    require: (name) => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } }, ipcRenderer };
    }
  });

  const claims = [];
  const unsubscribe = exposed.onCodexThreadClaimed((claim) => claims.push(claim));
  const listener = listeners.get('codex:threadClaimed');
  listener({}, { claimId: CLAIM, threadId: THREAD, cwd: 'D:/must-not-leak' });
  listener({}, { claimId: CLAIM.toUpperCase(), threadId: THREAD });
  listener({}, { claimId: CLAIM, threadId: 'bad' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(claims)), [{ claimId: CLAIM, threadId: THREAD }]);
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
  assert.equal(listeners.has('codex:threadClaimed'), false);
});

test('fresh preparation launches managed remote argv without resuming the stale UUID', async () => {
  const source = functionSource(renderer, 'spawnCodexColumn');
  const persisted = [];
  const columns = new Map();
  let globalColumnId = 0;
  const window = {
    CodexSpawn,
    electronAPI: {
      codexPrepareThread: async () => ({
        ok: true,
        mode: 'fresh',
        claimId: CLAIM,
        cwd: 'D:/project',
        remoteUrl: 'ws://127.0.0.1:4567',
        remoteTokenEnvName: 'CLAUDES_CODEX_BRIDGE_TOKEN',
        spawnTicket: 'a'.repeat(64)
      })
    }
  };
  const addColumn = (args, _row, opts) => {
    globalColumnId++;
    const col = {
      projectKey: 'D:/project', workspaceId: null, cwd: opts.cwd,
      cmdArgs: opts.persistedCmdArgs, codexThreadId: opts.codexThreadId || null,
      codexClaimId: opts.codexClaimId || null, codexManaged: !!opts.codexManaged
    };
    col.spawnArgs = args;
    columns.set(globalColumnId, col);
    columns.set(0, col); // extracted function's private id counter is not incremented by this stub
  };
  const persistSessions = () => {
    const col = columns.get(globalColumnId);
    persisted.push(CodexSpawn.codexPersistShape(col.cmdArgs, col.codexThreadId, col.codexManaged));
  };
  const spawn = new Function(
    'window', 'activeProjectKey', 'allColumns', 'addColumn', 'persistSessions',
    `let globalColumnId = 0; ${source}; return spawnCodexColumn;`
  )(window, 'D:/project', columns, addColumn, persistSessions);

  const spec = CodexSpawn.buildCodexRestore({
    kind: 'codex', codexThreadId: OLD_THREAD, codexPreset: 'auto'
  }, 'D:/project');
  const result = await spawn('D:/project', null, spec, { threadId: OLD_THREAD });
  const col = columns.get(1);

  assert.equal(result.managed, true);
  assert.equal(result.threadId, null);
  assert.equal(result.claimId, CLAIM);
  assert.equal(col.codexThreadId, null);
  assert.equal(col.codexClaimId, CLAIM);
  assert.equal(col.codexManaged, true);
  assert.equal(col.spawnArgs.includes('resume'), false);
  assert.equal(col.spawnArgs.includes(OLD_THREAD), false);
  assert.deepStrictEqual(col.spawnArgs.slice(col.spawnArgs.indexOf('-C'), col.spawnArgs.indexOf('-C') + 2), ['-C', 'D:/project']);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].kind, 'codex');
  assert.equal(persisted[0].codexPreset, 'auto');
  assert.equal('codexThreadId' in persisted[0], false);
  assert.equal('codexClaimId' in persisted[0], false);

  const addStart = renderer.indexOf('function addColumn');
  const addSource = renderer.slice(addStart, renderer.indexOf('function addRow()', addStart));
  const pendingAt = addSource.indexOf("colData.codexManaged && colData.codexClaimId) showCtxMeterPlaceholder(colData, '…')");
  const fallbackAt = addSource.indexOf("markCodexFallback(colData)", pendingAt);
  assert.ok(pendingAt !== -1 && fallbackAt > pendingAt, 'a pending fresh claim must show managed loading state, not direct fallback');
});

test('resume preparation keeps the exact verified thread and no transient claim', async () => {
  const source = functionSource(renderer, 'spawnCodexColumn');
  const columns = new Map();
  let globalColumnId = 0;
  const window = {
    CodexSpawn,
    electronAPI: {
      codexPrepareThread: async () => ({
        ok: true,
        mode: 'resume',
        threadId: THREAD,
        remoteUrl: 'ws://127.0.0.1:4567',
        remoteTokenEnvName: 'CLAUDES_CODEX_BRIDGE_TOKEN',
        spawnTicket: 'b'.repeat(64)
      })
    }
  };
  const addColumn = (args, _row, opts) => {
    globalColumnId++;
    const col = { projectKey: 'D:/project', workspaceId: null, spawnArgs: args, ...opts };
    columns.set(globalColumnId, col);
    columns.set(0, col);
  };
  const spawn = new Function(
    'window', 'activeProjectKey', 'allColumns', 'addColumn', 'persistSessions',
    `let globalColumnId = 0; ${source}; return spawnCodexColumn;`
  )(window, 'D:/project', columns, addColumn, () => {});

  const result = await spawn('D:/project', null, CodexSpawn.buildCodexSpawn('D:/project', 'auto'), { threadId: THREAD });
  const col = columns.get(1);
  assert.equal(result.threadId, THREAD);
  assert.equal(col.codexThreadId, THREAD);
  assert.equal(col.codexClaimId, undefined);
  assert.equal(col.spawnArgs[0], 'resume');
  assert.equal(col.spawnArgs.at(-1), THREAD);
});

test('matching claim atomically adopts and persists the real UUID while rejecting replay and ambiguity', async () => {
  const source = functionSource(renderer, 'handleCodexThreadClaimed');
  const allColumns = new Map();
  const persisted = [];
  const started = [];
  const applied = [];
  const first = {
    cmd: 'codex', codexManaged: true, codexClaimId: CLAIM, codexClaimCwd: 'D:/project',
    codexThreadId: null, cwd: 'D:/project', projectKey: 'D:/project', workspaceId: null
  };
  allColumns.set(1, first);
  const window = {
    CodexSpawn,
    electronAPI: { codexGetThreadState: async () => ({ threadId: THREAD, status: 'idle' }) }
  };
  const handle = new Function(
    'allColumns', 'window', 'persistSessions', 'startCodexThreadState', 'applyCodexThreadState',
    `${source}; return handleCodexThreadClaimed;`
  )(
    allColumns, window,
    (projectKey, workspaceId) => persisted.push([projectKey, workspaceId, first.codexThreadId, first.codexClaimId]),
    (id) => started.push(id),
    (col, state) => applied.push([col, state])
  );

  handle({ claimId: CLAIM, threadId: THREAD });
  assert.equal(first.codexThreadId, THREAD);
  assert.equal(first.codexClaimId, null);
  assert.equal(first.codexClaimCwd, null);
  assert.deepStrictEqual(persisted, [['D:/project', null, THREAD, null]]);
  assert.deepStrictEqual(started, [1]);

  handle({ claimId: CLAIM, threadId: OLD_THREAD });
  assert.equal(first.codexThreadId, THREAD);
  assert.equal(persisted.length, 1);

  first.codexThreadId = null;
  first.codexClaimId = CLAIM;
  first.codexClaimCwd = 'D:/other';
  handle({ claimId: CLAIM, threadId: OLD_THREAD });
  assert.equal(first.codexThreadId, null);
  assert.equal(persisted.length, 1);

  const duplicateClaim = { ...first, codexThreadId: null, codexClaimId: CLAIM, codexClaimCwd: 'D:/other', cwd: 'D:/other', projectKey: 'D:/other' };
  first.codexClaimId = CLAIM;
  first.codexClaimCwd = 'D:/project';
  allColumns.set(2, duplicateClaim);
  handle({ claimId: CLAIM, threadId: OLD_THREAD });
  assert.equal(first.codexThreadId, null);
  assert.equal(duplicateClaim.codexThreadId, null);
  assert.equal(persisted.length, 1);
});

test('restart uses the mode-aware attach builder and stores a pending fresh claim', () => {
  const restart = functionSource(renderer, 'restartColumn');
  assert.match(restart, /buildCodexRemoteAttach\(col\.cmdArgs \|\| \[\], preparedThread\)/);
  assert.match(restart, /preparedThread\.mode === 'fresh'[\s\S]*col\.codexThreadId = null/);
  assert.match(restart, /col\.codexClaimId = preparedThread\.claimId/);
  assert.match(restart, /persistSessions\(col\.projectKey, col\.workspaceId\)/);
});
