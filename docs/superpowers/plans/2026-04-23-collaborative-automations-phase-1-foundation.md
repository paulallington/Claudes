# Collaborative Automations — Phase 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the ability to configure and hold a MongoDB credential for shared automations. The app can connect to a user-provided Mongo database, store the connection string encrypted via Electron `safeStorage`, test connectivity, and display connection status in Settings. No orgs, no automations, no collections yet — just a working connection foundation that subsequent phases build on.

**Architecture:** Pure-logic helpers (`lib/sharing-*.js`) are unit-testable with `node --test`. The Electron main process (`main.js`) wires them to IPC handlers. Renderer shows a new "Shared automations" Settings section. No schema or collection creation in this phase — those arrive in Phase 2 when orgs are introduced.

**Tech Stack:** Node.js 22 (Electron-bundled), `mongodb` Node driver (pure JS, no native bindings), Electron `safeStorage` (DPAPI on Windows, Keychain on macOS), `mongodb-memory-server` for integration tests.

**Scope boundary:** This phase ends when the user can enter a connection string in Settings, the app verifies it reaches Mongo, and the connection status persists across app restarts. No data is written to the Mongo database yet.

**Reference spec:** `docs/superpowers/specs/2026-04-23-collaborative-automations-design.md`

---

## File structure

| Path | Status | Responsibility |
|---|---|---|
| `lib/sharing-connection-string.js` | Create | Pure helpers: `normalizeConnectionString`, `redactHost` |
| `lib/sharing-credstore.js` | Create | Injectable wrapper over `safeStorage` + `fs` for reading/writing `~/.claudes/shared-creds.enc` |
| `lib/sharing-mongo.js` | Create | Mongo client lifecycle: `testConnection`, `connect`, `disconnect`. No collection logic yet. |
| `test/sharing-connection-string.test.js` | Create | Unit tests for connection string helpers |
| `test/sharing-credstore.test.js` | Create | Unit tests for cred store with injected stubs |
| `test/integration/sharing-mongo.test.js` | Create | Integration test against `mongodb-memory-server` |
| `main.js` | Modify | Require the new modules, hold a single client instance, add IPC handlers for `sharing:configureConnection`, `sharing:clearConnection`, `sharing:getConnectionStatus`. Emit `sharing:connection-state-changed` events. |
| `preload.js` | Modify | Expose the three IPC channels + event listener |
| `index.html` | Modify | Add Settings modal "Shared automations" section markup (status area + connect form + disconnect button) |
| `renderer.js` | Modify | Render Settings section, wire form submission, listen for state events |
| `styles.css` | Modify | Styling for the new Settings section |
| `package.json` | Modify | Add `mongodb`, `mongodb-memory-server` (dev), `test:integration` script |

---

## Task 1: Add dependencies and integration test script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update `package.json` dependencies and scripts**

Open `package.json` and apply these changes to the `"scripts"` and dependencies objects:

```json
{
  "scripts": {
    "start": "electron .",
    "pty-server": "node pty-server.js",
    "dist": "electron-builder",
    "dist:win": "electron-builder --win",
    "dist:mac": "electron-builder --mac",
    "dist:publish": "electron-builder --publish always",
    "test": "node --test \"test/*.test.js\"",
    "test:integration": "node --test \"test/integration/*.test.js\""
  },
  "dependencies": {
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/addon-webgl": "^0.19.0",
    "@xterm/xterm": "^6.0.0",
    "electron-updater": "^6.8.3",
    "mongodb": "^6.10.0",
    "node-pty": "^1.1.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "electron": "^41.1.0",
    "electron-builder": "^26.8.1",
    "mongodb-memory-server": "^10.1.4"
  }
}
```

Keep everything else in `package.json` identical — do NOT touch the `"build"` section.

- [ ] **Step 2: Install**

Run: `npm install`
Expected: completes without errors. `node_modules/mongodb` and `node_modules/mongodb-memory-server` now present.

- [ ] **Step 3: Sanity-check the Mongo driver loads**

Run: `node -e "console.log(require('mongodb').MongoClient ? 'ok' : 'fail')"`
Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(sharing): add mongodb and mongodb-memory-server dependencies"
```

---

## Task 2: Pure-logic module — connection string helpers

**Files:**
- Create: `lib/sharing-connection-string.js`
- Test: `test/sharing-connection-string.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/sharing-connection-string.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeConnectionString,
  redactHost,
} = require('../lib/sharing-connection-string');

test('normalizeConnectionString: trims whitespace', () => {
  assert.equal(
    normalizeConnectionString('  mongodb://user:pw@host:27017/  '),
    'mongodb://user:pw@host:27017/'
  );
});

test('normalizeConnectionString: accepts mongodb:// scheme', () => {
  const cs = 'mongodb://user:pw@host:27017/';
  assert.equal(normalizeConnectionString(cs), cs);
});

test('normalizeConnectionString: accepts mongodb+srv:// scheme', () => {
  const cs = 'mongodb+srv://user:pw@cluster.mongo.cosmos.azure.com/';
  assert.equal(normalizeConnectionString(cs), cs);
});

test('normalizeConnectionString: rejects empty', () => {
  assert.throws(() => normalizeConnectionString(''), /empty/i);
  assert.throws(() => normalizeConnectionString('   '), /empty/i);
});

test('normalizeConnectionString: rejects non-string', () => {
  assert.throws(() => normalizeConnectionString(null), /string/i);
  assert.throws(() => normalizeConnectionString(undefined), /string/i);
  assert.throws(() => normalizeConnectionString(123), /string/i);
});

test('normalizeConnectionString: rejects unsupported scheme', () => {
  assert.throws(
    () => normalizeConnectionString('https://host/'),
    /mongodb:\/\/ or mongodb\+srv:\/\//
  );
});

test('redactHost: extracts host from mongodb://', () => {
  assert.equal(
    redactHost('mongodb://user:pw@host.example.com:27017/mydb'),
    'host.example.com:27017'
  );
});

test('redactHost: extracts host from mongodb+srv://', () => {
  assert.equal(
    redactHost('mongodb+srv://user:pw@cluster.mongo.cosmos.azure.com/mydb'),
    'cluster.mongo.cosmos.azure.com'
  );
});

test('redactHost: handles no credentials', () => {
  assert.equal(redactHost('mongodb://host.example.com:27017/'), 'host.example.com:27017');
});

test('redactHost: handles multiple hosts', () => {
  assert.equal(
    redactHost('mongodb://u:p@h1:27017,h2:27017/db'),
    'h1:27017,h2:27017'
  );
});

test('redactHost: returns "(invalid)" on unparseable input', () => {
  assert.equal(redactHost('not a url'), '(invalid)');
  assert.equal(redactHost(''), '(invalid)');
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npm test -- --test-name-pattern="normalizeConnectionString|redactHost"`
Expected: all tests FAIL with `Cannot find module '../lib/sharing-connection-string'`.

- [ ] **Step 3: Create the module**

Create `lib/sharing-connection-string.js`:

```js
'use strict';

/**
 * Trim, validate, and return a Mongo connection string.
 * Throws on empty, non-string, or unsupported scheme.
 */
function normalizeConnectionString(input) {
  if (typeof input !== 'string') {
    throw new Error('Connection string must be a string');
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Connection string is empty');
  }
  if (!trimmed.startsWith('mongodb://') && !trimmed.startsWith('mongodb+srv://')) {
    throw new Error('Connection string must start with mongodb:// or mongodb+srv://');
  }
  return trimmed;
}

/**
 * Extract the host(s) portion of a connection string for display.
 * Strips userinfo (user:password@) and everything after the host list.
 * Returns "(invalid)" if the input can't be parsed.
 */
function redactHost(cs) {
  if (typeof cs !== 'string' || !cs) return '(invalid)';
  const match = cs.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/);
  if (!match) return '(invalid)';
  return match[1];
}

module.exports = { normalizeConnectionString, redactHost };
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- --test-name-pattern="normalizeConnectionString|redactHost"`
Expected: all tests PASS.

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `npm test`
Expected: all tests PASS including the existing `deriveHeadlessTitle` / `evictOldHeadlessRuns` suites.

- [ ] **Step 6: Commit**

```bash
git add lib/sharing-connection-string.js test/sharing-connection-string.test.js
git commit -m "feat(sharing): add connection string normalize/redact helpers"
```

---

## Task 3: Credential store wrapper

**Files:**
- Create: `lib/sharing-credstore.js`
- Test: `test/sharing-credstore.test.js`

The credstore is an injectable wrapper so we can unit-test it with stubs. `main.js` will inject the real Electron `safeStorage` + `fs` + a config dir path. Tests inject fake implementations.

- [ ] **Step 1: Write the failing tests**

Create `test/sharing-credstore.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCredStore } = require('../lib/sharing-credstore');

function makeFakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from('enc:' + plain, 'utf8'),
    decryptString: (buf) => {
      const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : buf;
      if (!s.startsWith('enc:')) throw new Error('not encrypted');
      return s.slice(4);
    },
  };
}

function makeFakeFs() {
  const files = new Map();
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    writeFileSync: (p, data) => {
      files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
    mkdirSync: () => {},
    _files: files,
  };
}

test('createCredStore: write then read round-trips', () => {
  const store = createCredStore({
    safeStorage: makeFakeSafeStorage(),
    fs: makeFakeFs(),
    filePath: '/fake/shared-creds.enc',
  });
  store.write({ connectionString: 'mongodb://host/', dbName: 'Claudes' });
  const out = store.read();
  assert.deepEqual(out, { connectionString: 'mongodb://host/', dbName: 'Claudes' });
});

test('createCredStore: read returns null when file absent', () => {
  const store = createCredStore({
    safeStorage: makeFakeSafeStorage(),
    fs: makeFakeFs(),
    filePath: '/fake/shared-creds.enc',
  });
  assert.equal(store.read(), null);
});

test('createCredStore: clear removes the file', () => {
  const fakeFs = makeFakeFs();
  const store = createCredStore({
    safeStorage: makeFakeSafeStorage(),
    fs: fakeFs,
    filePath: '/fake/shared-creds.enc',
  });
  store.write({ connectionString: 'mongodb://host/', dbName: 'Claudes' });
  assert.equal(store.read() !== null, true);
  store.clear();
  assert.equal(store.read(), null);
  assert.equal(fakeFs._files.has('/fake/shared-creds.enc'), false);
});

test('createCredStore: clear is a no-op when file absent', () => {
  const store = createCredStore({
    safeStorage: makeFakeSafeStorage(),
    fs: makeFakeFs(),
    filePath: '/fake/shared-creds.enc',
  });
  store.clear();
  // Should not throw.
  assert.equal(store.read(), null);
});

test('createCredStore: write rejects when safeStorage unavailable', () => {
  const store = createCredStore({
    safeStorage: makeFakeSafeStorage({ available: false }),
    fs: makeFakeFs(),
    filePath: '/fake/shared-creds.enc',
  });
  assert.throws(
    () => store.write({ connectionString: 'mongodb://host/', dbName: 'Claudes' }),
    /encryption is not available/i
  );
});

test('createCredStore: read returns null on corrupted file', () => {
  const fakeFs = makeFakeFs();
  fakeFs.writeFileSync('/fake/shared-creds.enc', Buffer.from('garbage-not-encrypted'));
  const store = createCredStore({
    safeStorage: makeFakeSafeStorage(),
    fs: fakeFs,
    filePath: '/fake/shared-creds.enc',
  });
  assert.equal(store.read(), null);
});

test('createCredStore: isAvailable reflects safeStorage', () => {
  const ok = createCredStore({
    safeStorage: makeFakeSafeStorage({ available: true }),
    fs: makeFakeFs(),
    filePath: '/fake/shared-creds.enc',
  });
  const no = createCredStore({
    safeStorage: makeFakeSafeStorage({ available: false }),
    fs: makeFakeFs(),
    filePath: '/fake/shared-creds.enc',
  });
  assert.equal(ok.isAvailable(), true);
  assert.equal(no.isAvailable(), false);
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npm test -- --test-name-pattern="createCredStore"`
Expected: FAIL with `Cannot find module '../lib/sharing-credstore'`.

- [ ] **Step 3: Create the module**

Create `lib/sharing-credstore.js`:

```js
'use strict';

/**
 * Build a credential store bound to a specific safeStorage implementation,
 * fs module, and file path. Injectable so tests can use fakes.
 *
 * Stored shape: { connectionString, dbName }.
 * On disk: Electron safeStorage ciphertext (DPAPI on Windows, Keychain on macOS).
 */
function createCredStore({ safeStorage, fs, filePath }) {
  function isAvailable() {
    return safeStorage.isEncryptionAvailable();
  }

  function read() {
    if (!fs.existsSync(filePath)) return null;
    let ciphertext;
    try {
      ciphertext = fs.readFileSync(filePath);
    } catch {
      return null;
    }
    let plain;
    try {
      plain = safeStorage.decryptString(ciphertext);
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(plain);
      if (parsed && typeof parsed.connectionString === 'string' && typeof parsed.dbName === 'string') {
        return { connectionString: parsed.connectionString, dbName: parsed.dbName };
      }
      return null;
    } catch {
      return null;
    }
  }

  function write({ connectionString, dbName }) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Credential encryption is not available on this machine');
    }
    const ciphertext = safeStorage.encryptString(JSON.stringify({ connectionString, dbName }));
    fs.writeFileSync(filePath, ciphertext);
  }

  function clear() {
    if (!fs.existsSync(filePath)) return;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // If the file disappeared between exists check and unlink, ignore.
    }
  }

  return { isAvailable, read, write, clear };
}

module.exports = { createCredStore };
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- --test-name-pattern="createCredStore"`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sharing-credstore.js test/sharing-credstore.test.js
git commit -m "feat(sharing): add encrypted credential store with safeStorage"
```

---

## Task 4: Mongo client lifecycle module

**Files:**
- Create: `lib/sharing-mongo.js`
- Test: `test/integration/sharing-mongo.test.js`

This module owns the `MongoClient` instance. It exposes `testConnection` (transient — open, ping, close), `connect` (persistent — stores the client), and `disconnect`. No collection reads or writes in this phase.

- [ ] **Step 1: Create the integration test scaffold**

Create `test/integration/sharing-mongo.test.js`:

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const {
  testConnection,
  connect,
  disconnect,
  getDb,
} = require('../../lib/sharing-mongo');

let replset;
let uri;

before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  uri = replset.getUri();
}, { timeout: 60_000 });

after(async () => {
  await disconnect();
  if (replset) await replset.stop();
});

test('testConnection: ok against a live Mongo', async () => {
  const result = await testConnection({ connectionString: uri, dbName: 'Claudes' });
  assert.equal(result.ok, true);
  assert.equal(result.dbName, 'Claudes');
  assert.equal(typeof result.hostRedacted, 'string');
  assert.equal(result.hostRedacted.length > 0, true);
});

test('testConnection: fails with invalid host (short timeout)', async () => {
  const result = await testConnection({
    connectionString: 'mongodb://127.0.0.1:1/',
    dbName: 'Claudes',
    timeoutMs: 1500,
  });
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.equal(result.error.length > 0, true);
});

test('connect + getDb: returns a usable Db handle', async () => {
  await connect({ connectionString: uri, dbName: 'Claudes' });
  const db = getDb();
  assert.equal(db !== null, true);
  const pong = await db.command({ ping: 1 });
  assert.equal(pong.ok, 1);
  await disconnect();
});

test('getDb before connect returns null', () => {
  assert.equal(getDb(), null);
});

test('disconnect when not connected is a no-op', async () => {
  await disconnect();
  assert.equal(getDb(), null);
});
```

- [ ] **Step 2: Run the integration test, confirm it fails to import the module**

Run: `npm run test:integration`
Expected: FAIL with `Cannot find module '../../lib/sharing-mongo'`.

- [ ] **Step 3: Create the Mongo module**

Create `lib/sharing-mongo.js`:

```js
'use strict';

const { MongoClient } = require('mongodb');
const { normalizeConnectionString, redactHost } = require('./sharing-connection-string');

let currentClient = null;
let currentDb = null;
let currentConfig = null;

/**
 * Open a transient client, ping, close. Returns { ok, dbName, hostRedacted, error? }.
 * Never throws for connection failures — returns { ok: false, error }.
 * Re-throws for programmer errors (invalid argument types).
 */
async function testConnection({ connectionString, dbName, timeoutMs = 8000 }) {
  const cs = normalizeConnectionString(connectionString);
  if (typeof dbName !== 'string' || !dbName.trim()) {
    throw new Error('dbName must be a non-empty string');
  }
  const client = new MongoClient(cs, {
    serverSelectionTimeoutMS: timeoutMs,
    connectTimeoutMS: timeoutMs,
  });
  try {
    await client.connect();
    const db = client.db(dbName.trim());
    await db.command({ ping: 1 });
    return { ok: true, dbName: dbName.trim(), hostRedacted: redactHost(cs) };
  } catch (err) {
    return { ok: false, dbName: dbName.trim(), hostRedacted: redactHost(cs), error: String(err && err.message || err) };
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

/**
 * Open a persistent client. Replaces any existing client.
 * Throws on failure — callers handle the error.
 */
async function connect({ connectionString, dbName }) {
  const cs = normalizeConnectionString(connectionString);
  if (typeof dbName !== 'string' || !dbName.trim()) {
    throw new Error('dbName must be a non-empty string');
  }
  await disconnect();
  const client = new MongoClient(cs, {
    serverSelectionTimeoutMS: 8000,
  });
  await client.connect();
  currentClient = client;
  currentDb = client.db(dbName.trim());
  currentConfig = { dbName: dbName.trim(), hostRedacted: redactHost(cs) };
  return { dbName: currentConfig.dbName, hostRedacted: currentConfig.hostRedacted };
}

async function disconnect() {
  if (!currentClient) return;
  const c = currentClient;
  currentClient = null;
  currentDb = null;
  currentConfig = null;
  try { await c.close(); } catch { /* ignore */ }
}

function getDb() {
  return currentDb;
}

function getStatus() {
  if (!currentDb) return { connected: false };
  return { connected: true, dbName: currentConfig.dbName, hostRedacted: currentConfig.hostRedacted };
}

module.exports = { testConnection, connect, disconnect, getDb, getStatus };
```

- [ ] **Step 4: Run the integration test, confirm it passes**

Run: `npm run test:integration`
Expected: all 5 tests PASS. First run will be slow (~30–60s) because `mongodb-memory-server` downloads the Mongo binary on first use. Subsequent runs are fast.

If the first run times out downloading: set `MONGOMS_DISABLE_POSTINSTALL=1` is already default, just let it finish. If behind a corporate proxy, export `MONGOMS_SYSTEM_BINARY` pointing to an installed mongod.

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `npm test`
Expected: all unit tests PASS (integration suite is separate, runs via `test:integration`).

- [ ] **Step 6: Commit**

```bash
git add lib/sharing-mongo.js test/integration/sharing-mongo.test.js
git commit -m "feat(sharing): add mongo client lifecycle module"
```

---

## Task 5: Wire credstore and mongo client into main.js

**Files:**
- Modify: `main.js`

This task introduces a single module-scope section near the top of `main.js` that instantiates the credstore, exposes IPC handlers, and emits connection state events. It does not change any existing behavior.

- [ ] **Step 1: Add requires + credstore instance near the top of main.js**

Find the top of `main.js`. After the existing `const path = require('path');` line (around line 3) and before `// Set appUserModelId early...`, keep them. Find the block of constants that define `CONFIG_DIR`, `CONFIG_FILE`, `LOOPS_FILE`, etc. (around lines 20–29). Immediately after that block, add:

```js
// --- Shared automations (collaborative mode) ---
// Credential storage uses Electron safeStorage. Mongo client lifecycle lives
// in lib/sharing-mongo.js. This section is intentionally scoped narrowly —
// Phase 1 only handles connect/disconnect/status. Later phases add orgs,
// automations, and sync.
const { safeStorage } = require('electron');
const { createCredStore } = require('./lib/sharing-credstore');
const sharingMongo = require('./lib/sharing-mongo');
const { normalizeConnectionString } = require('./lib/sharing-connection-string');

const SHARED_CREDS_FILE = path.join(CONFIG_DIR, 'shared-creds.enc');
const sharingCredStore = createCredStore({ safeStorage, fs, filePath: SHARED_CREDS_FILE });

let sharingConnectionState = { state: 'disconnected' }; // 'disconnected' | 'connecting' | 'connected' | 'error'

function broadcastSharingState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sharing:connection-state-changed', sharingConnectionState);
  }
}

async function tryAutoConnectSharing() {
  const stored = sharingCredStore.read();
  if (!stored) return;
  sharingConnectionState = { state: 'connecting' };
  broadcastSharingState();
  try {
    const info = await sharingMongo.connect(stored);
    sharingConnectionState = { state: 'connected', dbName: info.dbName, hostRedacted: info.hostRedacted };
  } catch (err) {
    sharingConnectionState = { state: 'error', error: String(err && err.message || err) };
  }
  broadcastSharingState();
}
```

- [ ] **Step 2: Add IPC handlers**

Find the existing `ipcMain.handle(...)` blocks in `main.js` (there are many — search for `ipcMain.handle`). Add these handlers anywhere in that section (a logical spot is near the other config-related handlers):

```js
ipcMain.handle('sharing:getConnectionStatus', () => {
  return sharingConnectionState;
});

ipcMain.handle('sharing:configureConnection', async (_evt, { connectionString, dbName }) => {
  if (!sharingCredStore.isAvailable()) {
    return { ok: false, error: "This machine can't securely store credentials. Sharing disabled." };
  }
  let cs;
  try {
    cs = normalizeConnectionString(connectionString);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  const dbNameTrimmed = typeof dbName === 'string' ? dbName.trim() : '';
  if (!dbNameTrimmed) {
    return { ok: false, error: 'Database name is required' };
  }
  sharingConnectionState = { state: 'connecting' };
  broadcastSharingState();
  const result = await sharingMongo.testConnection({ connectionString: cs, dbName: dbNameTrimmed });
  if (!result.ok) {
    sharingConnectionState = { state: 'error', error: result.error };
    broadcastSharingState();
    return { ok: false, error: result.error };
  }
  try {
    sharingCredStore.write({ connectionString: cs, dbName: dbNameTrimmed });
  } catch (err) {
    sharingConnectionState = { state: 'error', error: String(err.message || err) };
    broadcastSharingState();
    return { ok: false, error: String(err.message || err) };
  }
  try {
    const info = await sharingMongo.connect({ connectionString: cs, dbName: dbNameTrimmed });
    sharingConnectionState = { state: 'connected', dbName: info.dbName, hostRedacted: info.hostRedacted };
    broadcastSharingState();
    return { ok: true, dbName: info.dbName, hostRedacted: info.hostRedacted };
  } catch (err) {
    sharingConnectionState = { state: 'error', error: String(err.message || err) };
    broadcastSharingState();
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('sharing:clearConnection', async () => {
  await sharingMongo.disconnect();
  sharingCredStore.clear();
  sharingConnectionState = { state: 'disconnected' };
  broadcastSharingState();
  return { ok: true };
});
```

- [ ] **Step 3: Call `tryAutoConnectSharing()` on app ready**

Find the existing `app.whenReady()` block in `main.js`. It contains window creation and other startup. Locate the `.then(async () => { ... })` or equivalent callback. Inside it, after the main window is created but not blocking it (fire-and-forget), add:

```js
  // Fire-and-forget: if the user previously configured sharing, re-open the Mongo
  // connection in the background. A failure here is non-fatal — the UI surfaces it.
  tryAutoConnectSharing();
```

If `app.whenReady()` in your copy looks like:

```js
app.whenReady().then(() => {
  createWindow();
  // ... other setup
});
```

Make it:

```js
app.whenReady().then(() => {
  createWindow();
  // ... other setup
  tryAutoConnectSharing();
});
```

- [ ] **Step 4: Disconnect on app quit**

Find the existing `app.on('before-quit', ...)` handler (or similar shutdown path) in `main.js`. Add a Mongo disconnect to it. Search for `'before-quit'` or `'will-quit'`. Inside that handler, add:

```js
  // Close sharing Mongo connection. await is safe here because before-quit is async.
  sharingMongo.disconnect().catch(() => { /* ignore */ });
```

If no such handler exists, add one:

```js
app.on('before-quit', () => {
  sharingMongo.disconnect().catch(() => { /* ignore */ });
});
```

- [ ] **Step 5: Smoke-test that the app starts**

Run: `npm start`
Expected: app launches normally. No new errors in the terminal. The new handlers are registered but not yet called from the renderer.

Close the app.

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "feat(sharing): wire mongo client and IPC handlers into main process"
```

---

## Task 6: Expose sharing IPC in preload.js

**Files:**
- Modify: `preload.js`

- [ ] **Step 1: Add sharing API to the context bridge**

Read `preload.js` to see the existing `contextBridge.exposeInMainWorld(...)` structure. Add the following three methods and one event listener inside the exposed API object. If the existing exposure looks like:

```js
contextBridge.exposeInMainWorld('api', {
  // ... existing methods
});
```

Add these entries alongside the existing ones:

```js
  sharing: {
    getConnectionStatus: () => ipcRenderer.invoke('sharing:getConnectionStatus'),
    configureConnection: (cfg) => ipcRenderer.invoke('sharing:configureConnection', cfg),
    clearConnection: () => ipcRenderer.invoke('sharing:clearConnection'),
    onConnectionStateChanged: (cb) => {
      const listener = (_evt, state) => cb(state);
      ipcRenderer.on('sharing:connection-state-changed', listener);
      return () => ipcRenderer.removeListener('sharing:connection-state-changed', listener);
    },
  },
```

The grouping under `sharing:` keeps the renderer call site clean: `window.api.sharing.configureConnection(...)`.

- [ ] **Step 2: Smoke test — app launches, no console errors**

Run: `npm start`
Open DevTools (Ctrl+Shift+I). In the console, type `window.api.sharing` and confirm it shows the four methods.

- [ ] **Step 3: Manually invoke getConnectionStatus from DevTools**

In the DevTools console:

```js
await window.api.sharing.getConnectionStatus()
```

Expected: `{ state: 'disconnected' }`.

Close the app.

- [ ] **Step 4: Commit**

```bash
git add preload.js
git commit -m "feat(sharing): expose sharing IPC bridge in preload"
```

---

## Task 7: Add Settings section markup to index.html

**Files:**
- Modify: `index.html`

The Settings surface in this app is a modal. Find where the existing Settings modal is defined (search for `id="settings-modal"` or `settings-modal`). We add a new section inside that modal titled "Shared automations."

- [ ] **Step 1: Locate the Settings modal body**

Search `index.html` for `settings-modal`. Inside the modal body (the scrollable content area that contains existing Settings groups), find an appropriate insertion point — typically at the bottom of the existing groups, before the modal's close/footer.

- [ ] **Step 2: Insert the new section markup**

Add this markup as a new Settings group. If the existing groups follow a pattern like `<div class="settings-group">...</div>`, match that pattern. If not, use this standalone block:

```html
<div class="settings-group" id="settings-sharing-group">
  <h3>Shared automations</h3>
  <p class="settings-help">
    Collaborate on automations with colleagues by connecting to a shared MongoDB database
    (Cosmos DB for MongoDB vCore or Atlas). Local automations are unaffected.
  </p>

  <div id="sharing-status-row" class="sharing-status sharing-status-disconnected">
    <span class="sharing-status-dot"></span>
    <span class="sharing-status-text">Not configured</span>
  </div>

  <!-- Connect form: shown when disconnected -->
  <div id="sharing-connect-form">
    <label for="sharing-connection-string">Connection string</label>
    <input
      type="password"
      id="sharing-connection-string"
      placeholder="mongodb+srv://user:password@cluster.mongo.cosmos.azure.com/"
      autocomplete="off"
      spellcheck="false"
    />

    <label for="sharing-db-name">Database name</label>
    <input type="text" id="sharing-db-name" value="Claudes" />

    <div class="sharing-form-actions">
      <button id="sharing-connect-btn" type="button">Connect</button>
    </div>

    <div id="sharing-error" class="sharing-error" hidden></div>
  </div>

  <!-- Connected info: shown when connected -->
  <div id="sharing-connected-info" hidden>
    <div class="sharing-connection-details">
      <div><span class="sharing-label">Database:</span> <span id="sharing-db-name-display"></span></div>
      <div><span class="sharing-label">Host:</span> <span id="sharing-host-display"></span></div>
    </div>
    <div class="sharing-form-actions">
      <button id="sharing-change-db-btn" type="button" class="sharing-danger-btn">Change database…</button>
    </div>
    <p class="sharing-help-small">
      Organizations and invites are added in the next phase. For now this only verifies the connection.
    </p>
  </div>
</div>
```

- [ ] **Step 3: Smoke test — open Settings, confirm the section renders**

Run: `npm start`
Open Settings (wherever it's triggered in the existing UI). Scroll to the bottom. Confirm the new "Shared automations" section appears with the "Not configured" status, connection string field, database name field (default `Claudes`), and Connect button.

Close the app.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(sharing): add shared automations section to settings modal"
```

---

## Task 8: Wire the Settings section in renderer.js

**Files:**
- Modify: `renderer.js`
- Modify: `styles.css`

- [ ] **Step 1: Add the sharing controller logic**

Open `renderer.js`. Find an appropriate place to add new top-level module code — most existing feature modules are initialized near the end of the file or inside a DOMContentLoaded block. Add this block alongside them (a logical spot is near the end of the file, inside the same init flow that sets up the Settings modal):

```js
// --- Shared automations (Settings section) ---

(function initSharingSettings() {
  const statusRow = document.getElementById('sharing-status-row');
  if (!statusRow) return; // settings markup not present
  const statusText = statusRow.querySelector('.sharing-status-text');
  const connectForm = document.getElementById('sharing-connect-form');
  const connectedInfo = document.getElementById('sharing-connected-info');
  const connStringInput = document.getElementById('sharing-connection-string');
  const dbNameInput = document.getElementById('sharing-db-name');
  const connectBtn = document.getElementById('sharing-connect-btn');
  const changeDbBtn = document.getElementById('sharing-change-db-btn');
  const errorDiv = document.getElementById('sharing-error');
  const dbDisplay = document.getElementById('sharing-db-name-display');
  const hostDisplay = document.getElementById('sharing-host-display');

  function setStatusClass(cls) {
    statusRow.classList.remove(
      'sharing-status-disconnected',
      'sharing-status-connecting',
      'sharing-status-connected',
      'sharing-status-error'
    );
    statusRow.classList.add(cls);
  }

  function showError(msg) {
    errorDiv.textContent = msg;
    errorDiv.hidden = false;
  }

  function clearError() {
    errorDiv.textContent = '';
    errorDiv.hidden = true;
  }

  function render(state) {
    switch (state.state) {
      case 'disconnected':
        setStatusClass('sharing-status-disconnected');
        statusText.textContent = 'Not configured';
        connectForm.hidden = false;
        connectedInfo.hidden = true;
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
        break;
      case 'connecting':
        setStatusClass('sharing-status-connecting');
        statusText.textContent = 'Connecting…';
        connectForm.hidden = false;
        connectedInfo.hidden = true;
        connectBtn.disabled = true;
        connectBtn.textContent = 'Connecting…';
        break;
      case 'connected':
        setStatusClass('sharing-status-connected');
        statusText.textContent = `Connected to ${state.dbName}`;
        connectForm.hidden = true;
        connectedInfo.hidden = false;
        dbDisplay.textContent = state.dbName;
        hostDisplay.textContent = state.hostRedacted;
        break;
      case 'error':
        setStatusClass('sharing-status-error');
        statusText.textContent = 'Connection error';
        connectForm.hidden = false;
        connectedInfo.hidden = true;
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
        showError(state.error || 'Unknown error');
        break;
    }
    if (state.state !== 'error') clearError();
  }

  async function refresh() {
    const state = await window.api.sharing.getConnectionStatus();
    render(state);
  }

  connectBtn.addEventListener('click', async () => {
    clearError();
    const connectionString = connStringInput.value;
    const dbName = dbNameInput.value;
    const result = await window.api.sharing.configureConnection({ connectionString, dbName });
    if (!result.ok) {
      showError(result.error);
    } else {
      // Clear the connection string input — we don't want to keep a plaintext
      // copy in the DOM after a successful save.
      connStringInput.value = '';
    }
  });

  changeDbBtn.addEventListener('click', async () => {
    const confirmed = confirm(
      'Switching the database disconnects you from all current orgs. ' +
      'Shared automations in the current database will stop appearing. Continue?'
    );
    if (!confirmed) return;
    await window.api.sharing.clearConnection();
  });

  window.api.sharing.onConnectionStateChanged((state) => render(state));
  refresh();
})();
```

- [ ] **Step 2: Add styles for the sharing section**

Open `styles.css`. Append these rules at the end of the file:

```css
/* --- Shared automations Settings section --- */

#settings-sharing-group .sharing-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 6px;
  margin: 8px 0 12px 0;
  background: rgba(255, 255, 255, 0.04);
}

#settings-sharing-group .sharing-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: 0 0 10px;
}

.sharing-status-disconnected .sharing-status-dot { background: #666; }
.sharing-status-connecting   .sharing-status-dot { background: #e0a030; animation: sharing-pulse 1.2s infinite; }
.sharing-status-connected    .sharing-status-dot { background: #3dbb60; }
.sharing-status-error        .sharing-status-dot { background: #c24040; }

@keyframes sharing-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}

#settings-sharing-group .sharing-status-text {
  font-size: 13px;
}

#settings-sharing-group .sharing-form-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}

#settings-sharing-group .sharing-danger-btn {
  background: #5a2020;
  border-color: #7a3030;
}

#settings-sharing-group .sharing-danger-btn:hover {
  background: #7a3030;
}

#settings-sharing-group .sharing-error {
  color: #ff8080;
  font-size: 12px;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  background: rgba(194, 64, 64, 0.12);
  white-space: pre-wrap;
}

#settings-sharing-group .sharing-connection-details {
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  margin-bottom: 8px;
}

#settings-sharing-group .sharing-connection-details .sharing-label {
  color: #888;
  margin-right: 6px;
}

#settings-sharing-group .sharing-help,
#settings-sharing-group .sharing-help-small {
  color: #999;
  font-size: 12px;
  line-height: 1.4;
}

#settings-sharing-group .sharing-help-small {
  margin-top: 8px;
}

#settings-sharing-group label {
  display: block;
  margin-top: 10px;
  font-size: 12px;
  color: #bbb;
}

#settings-sharing-group input[type="text"],
#settings-sharing-group input[type="password"] {
  width: 100%;
  margin-top: 4px;
}
```

- [ ] **Step 3: Smoke test — the Settings section is interactive**

Run: `npm start`. Open Settings → scroll to Shared automations.

Confirm:
- Status row shows `Not configured` with a gray dot.
- Connection string field is a password-masked input.
- Database name field defaults to `Claudes`.
- Clicking Connect with empty fields shows an inline error.
- Clicking Connect with `mongodb://127.0.0.1:1/` → shows the status row go through `Connecting…` → `Connection error` with an inline error message.

- [ ] **Step 4: Commit**

```bash
git add renderer.js styles.css
git commit -m "feat(sharing): wire settings section to sharing IPC bridge"
```

---

## Task 9: End-to-end manual verification

**Files:** none modified

This task is a hands-on test that exercises Phase 1 against a real Mongo database. It confirms the keychain-backed persistence works across app restarts.

- [ ] **Step 1: Run a local Mongo (if you don't already have one)**

If you have Docker:

```bash
docker run --rm -d --name claudes-phase1-mongo -p 27017:27017 mongo:7
```

Alternatively, use a temporary Cosmos vCore or Atlas connection. Any Mongo 7-compatible server works.

- [ ] **Step 2: Configure the connection in the app**

Run: `npm start`
Open Settings → Shared automations.
Enter: `mongodb://localhost:27017/` (or your real connection string).
Database name: `Claudes-phase1-test`
Click Connect.

Expected:
- Status row: `Connecting…` with a pulsing amber dot.
- After 1–5s: `Connected to Claudes-phase1-test` with a green dot.
- Connection string field is cleared.
- Connected info block shows the database name and redacted host.

- [ ] **Step 3: Confirm the encrypted file exists**

Open a terminal:

```bash
ls -la ~/.claudes/shared-creds.enc
```

Expected: file exists, non-zero size, binary content (not JSON).

- [ ] **Step 4: Restart the app**

Quit the app completely. Start it again: `npm start`.

Open Settings → Shared automations.

Expected: status row is `Connecting…` briefly, then `Connected to Claudes-phase1-test` (auto-reconnected from the encrypted file).

- [ ] **Step 5: Disconnect**

Click "Change database…". Confirm the dialog.

Expected:
- Status row: `Not configured`.
- Connect form reappears.
- `~/.claudes/shared-creds.enc` is deleted (`ls -la ~/.claudes/shared-creds.enc` → no such file).

- [ ] **Step 6: Stop the test Mongo**

```bash
docker stop claudes-phase1-mongo
```

- [ ] **Step 7: Commit nothing — or a docs note if you found anything worth recording**

No code changes expected. If the manual test surfaced a bug, fix it in a follow-up commit with a descriptive message. Otherwise, Phase 1 is complete.

---

## Self-review checklist (run before declaring Phase 1 done)

- [ ] Unit tests pass: `npm test`
- [ ] Integration tests pass: `npm run test:integration`
- [ ] App starts and quits cleanly with no console errors: `npm start`
- [ ] Settings section renders on a fresh install (no `shared-creds.enc` file)
- [ ] Connect with a bad connection string shows an error and does not write to disk
- [ ] Connect with a good connection string persists across restart
- [ ] Disconnect deletes the encrypted file
- [ ] `safeStorage.isEncryptionAvailable()` returning false is handled gracefully (can't easily test without a Linux sandbox, but the code path exists and the UI returns the error string)
- [ ] No changes to `automations.json`, `projects.json`, scheduler loop, or any existing feature

---

## Deferred to later phases

| Item | Phase |
|---|---|
| Orgs, users, memberships collections and UI | 2 |
| Invite blob format + redemption flow | 2 |
| Index creation on collections | 2 (first collection write) |
| `automations` collection + promote-to-shared | 3 |
| Scheduler merges shared automations | 3 |
| Presence heartbeat | 3 |
| Edit locks | 4 |
| Reviewed editing + drafts | 5 |
| Run requests + history in Mongo | 6 |
| Live streaming via change streams | 7 |
| Handoff flow | 8 |
| Retention TTLs | 9 |

Each is its own plan under `docs/superpowers/plans/`. Do not start Phase 2 until Phase 1 is reviewed and merged.
