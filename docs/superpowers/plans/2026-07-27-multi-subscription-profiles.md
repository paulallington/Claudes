# Multi-subscription Claude Profiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-27-multi-subscription-profiles-design.md`

**Goal:** Let the user assign different Claude Code subscriptions (separate Anthropic accounts) to projects, workspaces, columns and automations, and show every subscription's usage in the sidebar bar.

**Architecture:** Each subscription is a "profile" — a name plus a config directory. The Claude CLI is pointed at it via the `CLAUDE_CONFIG_DIR` environment variable at spawn time. The profile named "Primary" has `configDir: null`, means `~/.claude`, and sets no environment variable, so the entire existing single-subscription behaviour is preserved bit-for-bit until a second profile is created. A single pure module, `lib/profile-resolve.js`, is the only place that decides which profile a column/automation belongs to; every path that currently hardcodes `~/.claude` derives its root from that decision instead.

**Tech Stack:** Electron (main + sandboxed renderer, no `require()` in renderer), Node.js `node:test` + `node:assert` for tests, UMD-pattern pure modules in `lib/`.

## Global Constraints

- **`npm test` must pass with zero failures**, including pre-existing tests. It runs `node --test` over `test/*.test.js` and requires no `node_modules`.
- **`lib/` modules must be pure and UMD**: no `electron`, no `fs`, no app state. End every module with the `module.exports` + `window.*` pair (see `lib/voice-transcript-path.js:99-104`). The renderer is sandboxed and cannot `require()`.
- **Primary must remain a no-op.** Any code path, with no profiles configured beyond Primary, must behave exactly as it does today. This is the single most important constraint in this plan.
- **A `profileId` read from any file other than `profiles.json` is an untrusted key, never a path.** Look it up in the registry; unknown ids resolve to Primary. (Carries forward commit `4abadb2`.)
- **Never copy the `oauthAccount` key** (or any top-level key) from `~/.claude.json` when seeding a profile. Only the per-project trust allowlist is copied.
- **Terminology:** Spawn / Kill / Respawn. Terminal background stays `#1a1a2e`. Product name "Claudes".
- **No generic `.hidden` class** exists in `styles.css` — add a component-scoped rule for any new toggled element.
- **Commit after every task.** Test and implementation in the same commit.

---

## File Structure

**New files:**

| File | Responsibility |
|---|---|
| `lib/profile-resolve.js` | Pure cascade resolution: inputs → `{ id, name, configDir, isPrimary, colour, env, warning }`, plus `profileClaudeRoot()`. |
| `lib/profile-seed.js` | Pure extraction of the safe subset of `~/.claude.json` for seeding a new profile. |
| `test/profile-resolve.test.js` | Tests for the above. |
| `test/profile-seed.test.js` | Tests for the above. |

**Modified files:**

| File | Change |
|---|---|
| `main.js` | `profiles.json` store, `profile:*` IPC family, re-rooted session/usage/history handlers, per-profile usage polling, settings mirror. |
| `preload.js` | Bridge the `profile:*` handlers. |
| `renderer.js` | Profile pickers (5 surfaces), mini-bar loop, per-profile notifications, spawn env merge, column chip. |
| `index.html` | Subscriptions panel markup, picker markup. |
| `styles.css` | Subscriptions panel, profile chip, per-profile mini-bar group. |
| `lib/voice-transcript-path.js` | `homeDir` → `claudeRoot`. |
| `lib/sync.js` | `claudeSessionsDir` takes a root. |
| `CLAUDE.md`, `docs/voice.md` | Document the subsystem. |

---

### Task 1: Profile resolution core

The pure cascade. Nothing else can be built until this exists.

**Files:**
- Create: `lib/profile-resolve.js`
- Test: `test/profile-resolve.test.js`

**Interfaces:**
- Produces:
  - `resolveProfile({ profiles, defaultProfileId, columnProfileId, workspaceProfileId, projectProfileId }) → { id, name, configDir, isPrimary, colour, env, warning }`
  - `profileClaudeRoot(profile, homeDir) → string`
  - `PRIMARY_ID` = `'primary'`

- [ ] **Step 1: Write the failing tests**

```js
// test/profile-resolve.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { resolveProfile, profileClaudeRoot, PRIMARY_ID } = require('../lib/profile-resolve');

const PROFILES = [
  { id: 'primary', name: 'Primary', configDir: null, colour: '#d97757' },
  { id: 'pf_work', name: 'Work', configDir: '/home/me/.claudes/profiles/pf_work', colour: '#5b8def' }
];
const base = { profiles: PROFILES, defaultProfileId: 'primary' };

test('falls back to the global default when nothing is assigned', () => {
  const r = resolveProfile(base);
  assert.strictEqual(r.id, 'primary');
  assert.strictEqual(r.isPrimary, true);
  assert.deepStrictEqual(r.env, {});
});

test('primary sets no CLAUDE_CONFIG_DIR', () => {
  const r = resolveProfile({ ...base, projectProfileId: 'primary' });
  assert.deepStrictEqual(r.env, {});
});

test('a secondary profile sets CLAUDE_CONFIG_DIR', () => {
  const r = resolveProfile({ ...base, projectProfileId: 'pf_work' });
  assert.strictEqual(r.isPrimary, false);
  assert.deepStrictEqual(r.env, { CLAUDE_CONFIG_DIR: '/home/me/.claudes/profiles/pf_work' });
});

test('column beats workspace beats project beats default', () => {
  assert.strictEqual(resolveProfile({ ...base, projectProfileId: 'pf_work' }).id, 'pf_work');
  assert.strictEqual(resolveProfile({
    ...base, projectProfileId: 'pf_work', workspaceProfileId: 'primary'
  }).id, 'primary');
  assert.strictEqual(resolveProfile({
    ...base, projectProfileId: 'primary', workspaceProfileId: 'primary', columnProfileId: 'pf_work'
  }).id, 'pf_work');
});

test('null/empty assignments are treated as "inherit", not as a selection', () => {
  const r = resolveProfile({ ...base, projectProfileId: 'pf_work', columnProfileId: null, workspaceProfileId: '' });
  assert.strictEqual(r.id, 'pf_work');
});

test('an unknown id resolves to Primary and reports a warning', () => {
  const r = resolveProfile({ ...base, columnProfileId: 'pf_deleted' });
  assert.strictEqual(r.id, 'primary');
  assert.strictEqual(r.warning, 'unknown-profile:pf_deleted');
});

test('a missing Primary entry still yields a usable Primary', () => {
  const r = resolveProfile({ profiles: [], defaultProfileId: 'primary' });
  assert.strictEqual(r.id, 'primary');
  assert.strictEqual(r.configDir, null);
  assert.deepStrictEqual(r.env, {});
});

test('a garbage profiles argument does not throw', () => {
  const r = resolveProfile({ profiles: null, defaultProfileId: null });
  assert.strictEqual(r.id, 'primary');
});

test('profileClaudeRoot returns ~/.claude for Primary and the config dir otherwise', () => {
  assert.strictEqual(
    profileClaudeRoot({ id: 'primary', configDir: null }, '/home/me'),
    path.join('/home/me', '.claude')
  );
  assert.strictEqual(
    profileClaudeRoot({ id: 'pf_work', configDir: '/home/me/.claudes/profiles/pf_work' }, '/home/me'),
    '/home/me/.claudes/profiles/pf_work'
  );
});

test('PRIMARY_ID is stable', () => {
  assert.strictEqual(PRIMARY_ID, 'primary');
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test test/profile-resolve.test.js`
Expected: FAIL — `Cannot find module '../lib/profile-resolve'`

- [ ] **Step 3: Write the implementation**

```js
// lib/profile-resolve.js
const path = require('path');

const PRIMARY_ID = 'primary';
const PRIMARY_FALLBACK = { id: PRIMARY_ID, name: 'Primary', configDir: null, colour: '#d97757' };

/**
 * Resolve which Claude profile a column/automation runs under.
 *
 * The cascade is column -> workspace -> project -> global default. The first
 * non-empty id in that chain is the SELECTION; if that id is not in the
 * registry the result is Primary plus a warning. Falling through to the next
 * level on an unknown id would silently mask corrupt config, and the delete
 * flow already rewrites dangling references.
 *
 * `profileId` values arrive from sessions.json / projects.json /
 * automations.json and are therefore untrusted. They are only ever used as
 * registry KEYS — never as paths. Only profiles.json (app-written) supplies
 * configDir.
 */
function resolveProfile(input) {
  const o = input || {};
  const list = Array.isArray(o.profiles) ? o.profiles : [];
  const byId = Object.create(null);
  for (const p of list) {
    if (p && typeof p.id === 'string' && p.id) byId[p.id] = p;
  }

  const chain = [o.columnProfileId, o.workspaceProfileId, o.projectProfileId, o.defaultProfileId];
  let selected = null;
  for (const id of chain) {
    if (typeof id === 'string' && id) { selected = id; break; }
  }

  let warning = null;
  let profile;
  if (!selected) {
    profile = byId[PRIMARY_ID] || PRIMARY_FALLBACK;
  } else if (byId[selected]) {
    profile = byId[selected];
  } else {
    warning = 'unknown-profile:' + selected;
    profile = byId[PRIMARY_ID] || PRIMARY_FALLBACK;
  }

  const configDir = (typeof profile.configDir === 'string' && profile.configDir) ? profile.configDir : null;
  const isPrimary = !configDir;

  return {
    id: profile.id || PRIMARY_ID,
    name: profile.name || 'Primary',
    configDir,
    isPrimary,
    colour: profile.colour || PRIMARY_FALLBACK.colour,
    // Primary sets NO env var at all. This is what makes the whole feature a
    // no-op for single-subscription users.
    env: isPrimary ? {} : { CLAUDE_CONFIG_DIR: configDir },
    warning
  };
}

/**
 * The root that stands in for `~/.claude` for this profile: transcripts live
 * at <root>/projects/<key>/<id>.jsonl, credentials at <root>/.credentials.json.
 */
function profileClaudeRoot(profile, homeDir) {
  const dir = profile && typeof profile.configDir === 'string' && profile.configDir ? profile.configDir : null;
  return dir || path.join(homeDir, '.claude');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveProfile, profileClaudeRoot, PRIMARY_ID };
}
if (typeof window !== 'undefined') {
  window.ProfileResolve = { resolveProfile, profileClaudeRoot, PRIMARY_ID };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test test/profile-resolve.test.js`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add lib/profile-resolve.js test/profile-resolve.test.js
git commit -m "feat(profiles): pure profile resolution cascade"
```

---

### Task 2: Profile seed extraction

Deciding what a new profile inherits from `~/.claude.json`. Pure, because getting this wrong leaks a credential.

**Files:**
- Create: `lib/profile-seed.js`
- Test: `test/profile-seed.test.js`

**Interfaces:**
- Produces: `extractSeedClaudeJson(primaryClaudeJson) → object` — a new `.claude.json` body containing only `{ projects: { <key>: { <allowlisted trust keys> } } }`.

**Context for the implementer:** `~/.claude.json` is the Claude CLI's own state file. Its top level holds `oauthAccount` (the account identity), `userID`, caches and telemetry. Its `projects` map holds one entry per directory the CLI has run in, and those entries carry the folder-trust decision. Copying the trust decision means a new profile does not stop on "do you trust this folder?" the first time a column spawns; copying anything at the top level would carry account identity across profiles, which is exactly wrong.

- [ ] **Step 1: Write the failing tests**

```js
// test/profile-seed.test.js
const test = require('node:test');
const assert = require('node:assert');
const { extractSeedClaudeJson, TRUST_KEYS } = require('../lib/profile-seed');

const PRIMARY = {
  oauthAccount: { accountUuid: 'secret-account', emailAddress: 'me@example.com' },
  userID: 'secret-user',
  machineID: 'abc',
  cachedStatsigGates: { a: 1 },
  projects: {
    'D:/repo/one': {
      hasTrustDialogAccepted: true,
      allowedTools: ['Bash(npm test)'],
      hasClaudeMdExternalIncludesApproved: true,
      projectOnboardingSeenCount: 3,
      lastSessionId: 'sess-abc',
      lastCost: 1.23,
      lastTotalInputTokens: 5000,
      mcpServers: { foo: {} }
    },
    'D:/repo/two': { hasTrustDialogAccepted: false }
  }
};

test('copies no top-level keys at all', () => {
  const seed = extractSeedClaudeJson(PRIMARY);
  assert.deepStrictEqual(Object.keys(seed), ['projects']);
});

test('never copies the oauth account or user id', () => {
  const seed = extractSeedClaudeJson(PRIMARY);
  const serialised = JSON.stringify(seed);
  assert.ok(!serialised.includes('secret-account'));
  assert.ok(!serialised.includes('secret-user'));
  assert.strictEqual(seed.oauthAccount, undefined);
  assert.strictEqual(seed.userID, undefined);
});

test('copies only the allowlisted trust keys per project', () => {
  const seed = extractSeedClaudeJson(PRIMARY);
  assert.deepStrictEqual(Object.keys(seed.projects['D:/repo/one']).sort(), [
    'allowedTools',
    'hasClaudeMdExternalIncludesApproved',
    'hasTrustDialogAccepted',
    'projectOnboardingSeenCount'
  ]);
});

test('drops per-project session and cost telemetry', () => {
  const p = extractSeedClaudeJson(PRIMARY).projects['D:/repo/one'];
  assert.strictEqual(p.lastSessionId, undefined);
  assert.strictEqual(p.lastCost, undefined);
  assert.strictEqual(p.lastTotalInputTokens, undefined);
});

test('drops per-project mcpServers (the app scopes MCP explicitly at spawn)', () => {
  const p = extractSeedClaudeJson(PRIMARY).projects['D:/repo/one'];
  assert.strictEqual(p.mcpServers, undefined);
});

test('omits projects that have no allowlisted keys', () => {
  const seed = extractSeedClaudeJson({ projects: { 'D:/repo/x': { lastCost: 1 } } });
  assert.deepStrictEqual(seed.projects, {});
});

test('keeps a project whose trust was explicitly declined', () => {
  const seed = extractSeedClaudeJson(PRIMARY);
  assert.deepStrictEqual(seed.projects['D:/repo/two'], { hasTrustDialogAccepted: false });
});

test('tolerates missing/garbage input', () => {
  assert.deepStrictEqual(extractSeedClaudeJson(null), { projects: {} });
  assert.deepStrictEqual(extractSeedClaudeJson({}), { projects: {} });
  assert.deepStrictEqual(extractSeedClaudeJson({ projects: 'nope' }), { projects: {} });
  assert.deepStrictEqual(extractSeedClaudeJson({ projects: { a: null } }), { projects: {} });
});

test('the allowlist is exported and closed', () => {
  assert.deepStrictEqual([...TRUST_KEYS].sort(), [
    'allowedTools',
    'hasClaudeMdExternalIncludesApproved',
    'hasTrustDialogAccepted',
    'projectOnboardingSeenCount'
  ]);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test test/profile-seed.test.js`
Expected: FAIL — `Cannot find module '../lib/profile-seed'`

- [ ] **Step 3: Write the implementation**

```js
// lib/profile-seed.js

// Per-project keys carried into a new profile's .claude.json. Deliberately a
// closed allowlist, not a denylist: the CLI adds keys over time, and a
// denylist would silently start copying whatever is added next. Everything
// here is a decision the USER made about a folder; everything excluded is
// either telemetry, cache, or account identity.
const TRUST_KEYS = [
  'hasTrustDialogAccepted',
  'allowedTools',
  'hasClaudeMdExternalIncludesApproved',
  'projectOnboardingSeenCount'
];

/**
 * Build the .claude.json body for a freshly created profile from the primary
 * account's .claude.json.
 *
 * NO top-level key is copied. `oauthAccount` is the account identity and must
 * come from a real `/login` in the new profile; copying it would cross the
 * subscriptions over. Only the per-project trust allowlist survives, so the
 * first column on a new profile does not stall on the folder-trust prompt.
 */
function extractSeedClaudeJson(primary) {
  const out = { projects: {} };
  const src = primary && typeof primary === 'object' ? primary.projects : null;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;

  for (const key of Object.keys(src)) {
    const entry = src[key];
    if (!entry || typeof entry !== 'object') continue;
    const kept = {};
    let any = false;
    for (const k of TRUST_KEYS) {
      if (Object.prototype.hasOwnProperty.call(entry, k)) { kept[k] = entry[k]; any = true; }
    }
    if (any) out.projects[key] = kept;
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractSeedClaudeJson, TRUST_KEYS };
}
if (typeof window !== 'undefined') {
  window.ProfileSeed = { extractSeedClaudeJson, TRUST_KEYS };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test test/profile-seed.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add lib/profile-seed.js test/profile-seed.test.js
git commit -m "feat(profiles): safe seed extraction from primary .claude.json"
```

---

### Task 3: Profile store and IPC family in main

Persist profiles and expose them. Follows the endpoints pattern exactly (`main.js:373`, `main.js:595`).

**Files:**
- Modify: `main.js` (near the endpoint handlers, ~line 1498)
- Modify: `preload.js` (near `endpointList`, line 225)

**Interfaces:**
- Consumes: `resolveProfile`, `profileClaudeRoot`, `PRIMARY_ID` from Task 1; `extractSeedClaudeJson` from Task 2.
- Produces (main-internal): `readProfiles()`, `writeProfiles(list)`, `getProfileById(id)`, `resolveProfileFor({ columnProfileId, workspaceProfileId, projectProfileId })`, `claudeRootFor(profileId)`.
- Produces (IPC): `profile:list`, `profile:create`, `profile:update`, `profile:delete`, `profile:setDefault`, `profile:getEnv`, `profile:reseed`.
- Produces (preload): `profileList`, `profileCreate`, `profileUpdate`, `profileDelete`, `profileSetDefault`, `profileGetEnv`, `profileReseed`.

- [ ] **Step 1: Add the constant and store helpers**

In `main.js`, beside `ENDPOINTS_FILE` (line 373):

```js
const PROFILES_FILE = path.join(CONFIG_DIR, app.isPackaged ? 'profiles.json' : 'profiles-dev.json');
const PROFILES_DIR = path.join(CONFIG_DIR, app.isPackaged ? 'profiles' : 'profiles-dev');
```

Then, after the endpoint store helpers, add:

```js
const { resolveProfile, profileClaudeRoot, PRIMARY_ID } = require('./lib/profile-resolve');
const { extractSeedClaudeJson } = require('./lib/profile-seed');

// Profiles live in their own file, not projects.json, for the same reason
// endpoints do (see the ENDPOINTS_FILE note): the renderer round-trips
// projects.json wholesale and would clobber anything written outside its view.
const DEFAULT_PRIMARY = { id: PRIMARY_ID, name: 'Primary', configDir: null, colour: '#d97757' };

function readProfiles() {
  ensureConfigDir();
  let data = null;
  try { data = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); } catch { data = null; }
  const list = (data && Array.isArray(data.profiles)) ? data.profiles.filter((p) => p && p.id) : [];
  // Primary is synthetic when absent: a missing/corrupt profiles.json must
  // still yield a working single-subscription app.
  if (!list.find((p) => p.id === PRIMARY_ID)) list.unshift({ ...DEFAULT_PRIMARY });
  const defaultProfileId = (data && typeof data.defaultProfileId === 'string' && list.find((p) => p.id === data.defaultProfileId))
    ? data.defaultProfileId
    : PRIMARY_ID;
  return { profiles: list, defaultProfileId };
}

function writeProfiles(store) {
  ensureConfigDir();
  atomicWriteJson(PROFILES_FILE, {
    defaultProfileId: store.defaultProfileId || PRIMARY_ID,
    profiles: store.profiles || []
  });
  BrowserWindow.getAllWindows().forEach((w) => {
    try { w.webContents.send('profiles:updated'); } catch { /* ignore */ }
  });
}

// The single resolution entry point for main. Every re-rooted handler goes
// through this, never through its own homedir join.
function resolveProfileFor(sel) {
  const store = readProfiles();
  const r = resolveProfile({
    profiles: store.profiles,
    defaultProfileId: store.defaultProfileId,
    columnProfileId: sel && sel.columnProfileId,
    workspaceProfileId: sel && sel.workspaceProfileId,
    projectProfileId: sel && sel.projectProfileId
  });
  if (r.warning) console.warn('[profiles]', r.warning, '- falling back to Primary');
  return r;
}

// Root that stands in for ~/.claude for a given profile id.
function claudeRootFor(profileId) {
  return profileClaudeRoot(resolveProfileFor({ columnProfileId: profileId }), os.homedir());
}
```

- [ ] **Step 2: Verify the app still starts unchanged**

Run: `npm start`
Expected: app launches, columns spawn, sidebar usage bar renders exactly as before. `~/.claudes/profiles-dev.json` is NOT yet created (nothing has written it).

- [ ] **Step 3: Add the IPC handlers**

```js
ipcMain.handle('profile:list', () => {
  const store = readProfiles();
  return {
    defaultProfileId: store.defaultProfileId,
    profiles: store.profiles.map((p) => ({
      id: p.id,
      name: p.name || '',
      colour: p.colour || DEFAULT_PRIMARY.colour,
      isPrimary: !p.configDir,
      // Sign-in status, so the Subscriptions panel can say "needs /login"
      // without the renderer ever seeing a token.
      signedIn: profileHasCredentials(p)
    }))
  };
});

function profileHasCredentials(p) {
  const root = profileClaudeRoot(p, os.homedir());
  try {
    if (fs.existsSync(path.join(root, '.credentials.json'))) return true;
  } catch { /* fall through */ }
  // Primary on macOS keeps credentials in the login keychain, not a file.
  if (process.platform === 'darwin' && !p.configDir) {
    try {
      execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials',
        '-a', os.userInfo().username, '-w'], { encoding: 'utf8' });
      return true;
    } catch { return false; }
  }
  return false;
}

ipcMain.handle('profile:create', (event, input) => {
  const name = String((input && input.name) || '').trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  const store = readProfiles();
  if (store.profiles.length >= 8) return { ok: false, error: 'Profile limit reached (8).' };

  const id = 'pf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  // The app allocates the directory. A user-supplied path is never accepted —
  // that is what keeps assertInsideAllowedRoots correct without a new root.
  const configDir = path.join(PROFILES_DIR, id);
  try {
    fs.mkdirSync(configDir, { recursive: true });
    seedProfileDir(configDir);
  } catch (e) {
    return { ok: false, error: 'Could not create profile directory: ' + e.message };
  }

  store.profiles.push({
    id, name,
    configDir,
    colour: String((input && input.colour) || '#5b8def')
  });
  writeProfiles(store);
  return { ok: true, id, configDir };
});

// Copy the parts of the primary setup that make a profile behave like the app
// the user already has: settings (hooks, permissions), global memory, agents,
// and the folder-trust map. Never credentials.
function seedProfileDir(configDir) {
  const primaryRoot = path.join(os.homedir(), '.claude');
  for (const rel of ['settings.json', 'CLAUDE.md']) {
    try {
      const src = path.join(primaryRoot, rel);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(configDir, rel));
    } catch (e) { console.warn('[profiles] seed skipped', rel, e.message); }
  }
  try {
    const agentsSrc = path.join(primaryRoot, 'agents');
    if (fs.existsSync(agentsSrc)) fs.cpSync(agentsSrc, path.join(configDir, 'agents'), { recursive: true });
  } catch (e) { console.warn('[profiles] seed skipped agents', e.message); }

  try {
    const primaryJson = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    atomicWriteJson(path.join(configDir, '.claude.json'), extractSeedClaudeJson(primaryJson));
  } catch (e) { console.warn('[profiles] seed skipped trust map', e.message); }
}

ipcMain.handle('profile:reseed', (event, id) => {
  const p = readProfiles().profiles.find((x) => x && x.id === id);
  if (!p || !p.configDir) return { ok: false, error: 'Cannot re-seed Primary.' };
  try { seedProfileDir(p.configDir); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('profile:update', (event, input) => {
  const id = input && input.id;
  const store = readProfiles();
  const p = store.profiles.find((x) => x && x.id === id);
  if (!p) return { ok: false, error: 'No such profile.' };
  if (input.name != null) p.name = String(input.name).trim() || p.name;
  if (input.colour != null) p.colour = String(input.colour);
  // configDir is app-owned and never accepted from the renderer.
  writeProfiles(store);
  return { ok: true };
});

ipcMain.handle('profile:setDefault', (event, id) => {
  const store = readProfiles();
  if (!store.profiles.find((p) => p && p.id === id)) return { ok: false, error: 'No such profile.' };
  store.defaultProfileId = id;
  writeProfiles(store);
  return { ok: true };
});

ipcMain.handle('profile:delete', (event, id) => {
  if (id === PRIMARY_ID) return { ok: false, error: 'Primary cannot be deleted.' };
  const store = readProfiles();
  const p = store.profiles.find((x) => x && x.id === id);
  if (!p) return { ok: false, error: 'No such profile.' };

  // Clear dangling references BEFORE removing the profile so nothing ever
  // resolves through the unknown-id path in normal operation.
  const reassigned = clearProfileReferences(id);

  try {
    if (p.configDir && p.configDir.startsWith(PROFILES_DIR + path.sep)) {
      fs.rmSync(p.configDir, { recursive: true, force: true });
    }
  } catch (e) { console.warn('[profiles] could not remove dir', e.message); }

  store.profiles = store.profiles.filter((x) => x.id !== id);
  if (store.defaultProfileId === id) store.defaultProfileId = PRIMARY_ID;
  writeProfiles(store);
  return { ok: true, reassigned };
});

ipcMain.handle('profile:getEnv', (event, sel) => {
  return resolveProfileFor(sel || {}).env;
});
```

**Note on the `startsWith(PROFILES_DIR + path.sep)` guard in delete:** `configDir` comes from `profiles.json`, which the app writes — but a hand-edited file must not be able to turn "delete profile" into "delete arbitrary directory". This is the same class of guard as the automations clone-path sanitisation.

- [ ] **Step 4: Write `clearProfileReferences`**

```js
// Strip a deleted profile's id out of projects.json (project + workspace) and
// automations.json, and out of every project's sessions.json. Returns a list of
// what was reassigned so the UI can tell the user.
function clearProfileReferences(id) {
  const reassigned = [];
  try {
    const projects = readProjectsConfig();
    let dirty = false;
    for (const proj of (projects.projects || [])) {
      if (proj.profileId === id) { proj.profileId = null; dirty = true; reassigned.push('project: ' + proj.name); }
      for (const ws of (proj.workspaces || [])) {
        if (ws.profileId === id) { ws.profileId = null; dirty = true; reassigned.push('workspace: ' + ws.name); }
      }
    }
    if (dirty) writeProjectsConfig(projects);
  } catch (e) { console.warn('[profiles] projects cleanup failed', e.message); }

  try {
    const autos = readAutomations();
    let dirty = false;
    for (const a of autos) {
      if (a && a.profileId === id) { a.profileId = null; dirty = true; reassigned.push('automation: ' + (a.name || a.id)); }
    }
    if (dirty) writeAutomations(autos);
  } catch (e) { console.warn('[profiles] automations cleanup failed', e.message); }

  return reassigned;
}
```

**Implementer note:** `readProjectsConfig` / `writeProjectsConfig` / `readAutomations` / `writeAutomations` are placeholders for whatever the existing helpers are named in `main.js` — grep for `CONFIG_FILE` and `AUTOMATIONS_FILE` and use the real ones. Column-level `profileId` in each project's `sessions.json` is deliberately NOT rewritten here: those files live under project directories that may not exist, and Task 1's unknown-id fallback already handles them safely.

- [ ] **Step 5: Bridge in preload.js**

Beside `endpointList` (line 225):

```js
profileList: () => ipcRenderer.invoke('profile:list'),
profileCreate: (input) => ipcRenderer.invoke('profile:create', input),
profileUpdate: (input) => ipcRenderer.invoke('profile:update', input),
profileDelete: (id) => ipcRenderer.invoke('profile:delete', id),
profileSetDefault: (id) => ipcRenderer.invoke('profile:setDefault', id),
profileGetEnv: (sel) => ipcRenderer.invoke('profile:getEnv', sel),
profileReseed: (id) => ipcRenderer.invoke('profile:reseed', id),
onProfilesUpdated: (cb) => ipcRenderer.on('profiles:updated', () => cb()),
```

- [ ] **Step 6: Verify by hand**

Run `npm start`, open DevTools console in the app and run:

```js
await electronAPI.profileList()
// → { defaultProfileId: 'primary', profiles: [ { id:'primary', name:'Primary', isPrimary:true, signedIn:true } ] }
await electronAPI.profileGetEnv({})
// → {}   ← Primary must produce an EMPTY env block
```

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test
git add main.js preload.js
git commit -m "feat(profiles): profiles.json store, IPC family, create/delete/seed"
```

---

### Task 4: Re-root the pure transcript modules

`lib/voice-transcript-path.js` and `lib/sync.js` currently bake `.claude` into their joins. They gain a root instead.

**Files:**
- Modify: `lib/voice-transcript-path.js:13-43`
- Modify: `lib/sync.js:93`
- Modify: `test/voice-transcript-path.test.js`
- Test: `test/voice-transcript-path.test.js` (new cases)

**Interfaces:**
- Produces: `columnTranscriptPath(claudeRoot, projectKey, sessionId)`, `isUnderProjectsRoot(claudeRoot, p)`, `resolveTranscriptPath({ claudeRoot, ... })` — where `claudeRoot` is `<configDir>` or `<home>/.claude`, i.e. the directory that *contains* `projects/`.

**This is a breaking signature change.** Every caller must be updated in the same commit. Callers: `main.js` voice handlers, `renderer.js` voice paths. Grep `columnTranscriptPath|resolveTranscriptPath|isUnderProjectsRoot`.

- [ ] **Step 1: Write the failing tests**

Add to `test/voice-transcript-path.test.js`:

```js
test('builds a transcript path under an explicit claude root', () => {
  const p = columnTranscriptPath('/home/me/.claudes/profiles/pf_work', 'D:\\Git Repos\\Claudes', 'sess-123');
  assert.strictEqual(
    p,
    path.join('/home/me/.claudes/profiles/pf_work', 'projects', 'D--Git-Repos-Claudes', 'sess-123.jsonl')
  );
});

test('a Primary-rooted transcript is rejected against a secondary root', () => {
  // The silent-failure case: a secondary-profile column looked up under
  // Primary's root finds nothing and voice goes quiet with no error.
  const primaryPath = path.join('/home/me/.claude', 'projects', 'proj', 'sess.jsonl');
  assert.strictEqual(isUnderProjectsRoot('/home/me/.claudes/profiles/pf_work', primaryPath), false);
  assert.strictEqual(isUnderProjectsRoot('/home/me/.claude', primaryPath), true);
});

test('resolveTranscriptPath honours the profile root', () => {
  const root = '/home/me/.claudes/profiles/pf_work';
  const good = path.join(root, 'projects', 'proj', 'sess.jsonl');
  const r = resolveTranscriptPath({
    claudeRoot: root, projectKey: 'proj', sessionId: 'sess', exists: (p) => p === good
  });
  assert.strictEqual(r.resolvedPath, good);
});

test('resolveTranscriptPath rejects a caller-supplied path from another profile', () => {
  const otherProfile = path.join('/home/me/.claude', 'projects', 'proj', 'sess.jsonl');
  const r = resolveTranscriptPath({
    claudeRoot: '/home/me/.claudes/profiles/pf_work',
    transcriptPath: otherProfile,
    projectKey: 'proj', sessionId: 'sess',
    exists: () => true
  });
  assert.strictEqual(r.resolvedPath, null);
});
```

Then update every existing test in that file: replace the `'/home/me'` home argument with `path.join('/home/me', '.claude')` and the `homeDir:` option key with `claudeRoot:`. The existing assertions about traversal, extension checks and case-insensitivity stay as they are — the security properties must not regress.

- [ ] **Step 2: Run and verify they fail**

Run: `node --test test/voice-transcript-path.test.js`
Expected: FAIL on the new cases and on the renamed option key.

- [ ] **Step 3: Change the implementation**

In `lib/voice-transcript-path.js`, rename the first parameter and drop the `.claude` segment:

```js
function columnTranscriptPath(claudeRoot, projectKey, sessionId) {
  if (!claudeRoot || !projectKey || !sessionId) return null;
  const claudeKey = String(projectKey).replace(/[^a-zA-Z0-9]/g, '-');
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(claudeRoot, 'projects', claudeKey, safeId + '.jsonl');
}

function isUnderProjectsRoot(claudeRoot, p) {
  let root = path.resolve(path.join(claudeRoot, 'projects'));
  let resolved = path.resolve(p);
  if (process.platform === 'win32') { root = root.toLowerCase(); resolved = resolved.toLowerCase(); }
  return resolved === root || resolved.startsWith(root + path.sep);
}
```

In `resolveTranscriptPath`, rename `o.homeDir` → `o.claudeRoot` and the local `home` → `root` (three use sites: the two `columnTranscriptPath` calls and the `accepts` predicate). Update the JSDoc.

In `lib/sync.js:93`:

```js
// was: path.join(homedir, '.claude', 'projects', projectPathToClaudeKey(projectPath))
function claudeSessionsDir(claudeRoot, projectPath) {
  return path.join(claudeRoot, 'projects', projectPathToClaudeKey(projectPath));
}
```

- [ ] **Step 4: Update every caller**

```bash
grep -rn "columnTranscriptPath\|resolveTranscriptPath\|isUnderProjectsRoot\|claudeSessionsDir" main.js renderer.js lib/
```

At each call site pass `claudeRootFor(col.profileId)` in main, or the root threaded from `profile:getEnv` in the renderer. Where a caller has no profile context yet, pass `path.join(os.homedir(), '.claude')` explicitly and leave a `// TODO(profiles): thread column profileId` comment — Task 5 removes those.

- [ ] **Step 5: Run the full suite and verify it passes**

Run: `npm test`
Expected: PASS, all tests including the pre-existing voice ones.

- [ ] **Step 6: Commit**

```bash
git add lib/voice-transcript-path.js lib/sync.js test/voice-transcript-path.test.js main.js renderer.js
git commit -m "refactor(profiles): transcript helpers take a claude root, not a homedir"
```

---

### Task 5: Thread the profile through spawn and persistence

A column must remember which profile it spawned on, and get it back on restore.

**Files:**
- Modify: `renderer.js:11373` (`spawnOpts`), `renderer.js:11380`, the column persistence path, the column restore path
- Modify: `main.js` session handlers (`sessions:getRecent` 1815, `sessions:exists` 1846, `sessions:getTitle` 1861, `git:detectSessionWorktree` 1897, `getSessionContextTokens` ~3771, last-turn ~3891)

**Interfaces:**
- Consumes: `electronAPI.profileGetEnv(sel)` from Task 3; `claudeRootFor(profileId)` from Task 3.
- Produces: `col.profileId` on the in-memory column; `profileId` on the `sessions.json` session entry; a `profileId` argument on the six re-rooted IPC handlers.

- [ ] **Step 1: Add profileId to the session handlers, defaulting to Primary**

Each of the six handlers gains a trailing `profileId` argument and swaps its `os.homedir(), '.claude'` join for `claudeRootFor(profileId)`. For example, `sessions:getRecent`:

```js
ipcMain.handle('sessions:getRecent', (event, projectPath, profileId) => {
  const claudeKey = projectPathToClaudeKey(projectPath);
  const claudeProjectDir = path.join(claudeRootFor(profileId), 'projects', claudeKey);
  // ...rest unchanged
});
```

`claudeRootFor(undefined)` returns `~/.claude`, so **every existing caller that does not pass the argument keeps working unchanged.** That is deliberate: it lets this task land without updating all callers atomically.

Update the matching `preload.js` methods to accept and forward the extra argument.

- [ ] **Step 2: Verify the no-argument path is unchanged**

Run: `npm start`, open a project with existing sessions.
Expected: the session list, titles and ctx meter behave exactly as before.

- [ ] **Step 3: Merge the profile env at spawn**

In `renderer.js`, `spawnOpts` (line 11373) merges endpoint env into `o.env`. Profile env merges the same way. Because `profileGetEnv` is async and `spawnOpts` is sync, cache the resolved env the same way `currentEndpointEnv` is cached (renderer.js:133, refreshed at 11837):

```js
var currentProfileEnv = null;    // env block from profile:getEnv, or null
var currentProfileId = null;     // resolved id, for the column chip and persistence

// Refresh whenever the spawn profile picker changes, the active project or
// workspace changes, or 'profiles:updated' fires.
function refreshProfileSelection() {
  var sel = {
    columnProfileId: optProfile && optProfile.value ? optProfile.value : null,
    workspaceProfileId: activeWorkspace ? activeWorkspace.profileId : null,
    projectProfileId: activeProject ? activeProject.profileId : null
  };
  return window.electronAPI.profileGetEnv(sel).then(function (env) {
    currentProfileEnv = (env && Object.keys(env).length) ? env : null;
    return window.electronAPI.profileList();
  }).then(function (store) {
    currentProfileId = resolveIdLocally(store, sel);   // same cascade, for display
    updateSpawnButtonLabel();
  }).catch(function () { currentProfileEnv = null; currentProfileId = null; });
}
```

Then in `spawnOpts`, after the endpoint merge at line 11380:

```js
if (currentEndpointEnv) o.env = currentEndpointEnv;
// Profile env (CLAUDE_CONFIG_DIR) layers on top of, and never replaces, the
// endpoint env: they bind different things (credentials vs base URL) and a
// column can legitimately have both.
if (currentProfileEnv) o.env = Object.assign({}, o.env, currentProfileEnv);
if (currentProfileId) o.profileId = currentProfileId;
```

**Do not touch `maybeBindHeadroom` (renderer.js:882).** It merges its own env with `Object.assign({}, msg.env, env)` and is orthogonal — Headroom binds `ANTHROPIC_BASE_URL`, profiles bind credentials.

- [ ] **Step 4: Persist and restore**

Where a column is serialised into `sessions.json`, add `profileId: col.profileId || null`. Where a column is restored, set `col.profileId` from the entry and pass it to the six session handlers and to the voice/ctx paths (removing the `TODO(profiles)` comments from Task 4 step 4).

Omit the key when null, matching how `cwd` is omitted when it equals the project root — existing files without `profileId` must keep working untouched.

- [ ] **Step 5: Verify in the running app**

Run `npm start`. With only Primary configured:
- Spawn a column → DevTools: the WS `create` message carries **no** `CLAUDE_CONFIG_DIR`.
- Kill the app, relaunch → columns restore, transcripts and ctx meters resolve as before.

- [ ] **Step 6: Commit**

```bash
git add main.js preload.js renderer.js
git commit -m "feat(profiles): thread profile through spawn env and session persistence"
```

---

### Task 6: Per-profile usage polling

**Files:**
- Modify: `main.js:3594-3682` (`usage:getPlanLimits`)
- Modify: `preload.js:72`

**Interfaces:**
- Produces: `usage:getPlanLimits(force, profileId)` → the same result shape as today, plus `profileId`.

- [ ] **Step 1: Convert the module-level cache and cooldown to per-profile maps**

```js
const PLAN_USAGE_CACHE_MS = 30_000;
// Keyed by profile id. One account being rate-limited must never blank
// another's bars, which is exactly what the old scalars would do.
const planUsageCache = new Map();     // id -> { data, fetchedAt }
const planUsageRetryAt = new Map();   // id -> ms timestamp
```

- [ ] **Step 2: Read credentials from the profile's root**

Replace `main.js:3619`:

```js
const profile = resolveProfileFor({ columnProfileId: profileId });
const root = profileClaudeRoot(profile, os.homedir());
const credsPath = path.join(root, '.credentials.json');
let token;
try {
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  token = creds?.claudeAiOauth?.accessToken;
} catch {
  // macOS keychain fallback applies to PRIMARY ONLY. A secondary profile's
  // credentials must come from its own config dir; if the CLI turns out to
  // keychain them globally on macOS, secondary profiles are unsupported there
  // (see Task 12) and this must not silently hand back Primary's token.
  if (process.platform === 'darwin' && profile.isPrimary) {
    // ...existing keychain block unchanged...
  } else if (process.platform === 'darwin') {
    return { ok: false, error: 'no-creds-macos', profileId: profile.id,
             message: 'Secondary profiles are not supported on macOS yet.' };
  } else {
    return { ok: false, error: 'no-creds', profileId: profile.id,
             message: 'Not signed in — run /login in a column on this profile.' };
  }
}
```

**This macOS branch is the single most important correctness detail in this task.** Falling through to the keychain for a secondary profile would report Primary's usage under the other profile's name — a wrong number that looks right.

- [ ] **Step 3: Key every cache read/write and every early return by profile id**

Replace each `planUsageCache.data` / `planUsageRetryAtMs` reference with the map equivalent, and add `profileId: profile.id` to every returned object so the renderer can route results to the right block.

- [ ] **Step 4: Update preload**

```js
getPlanLimits: (force, profileId) => ipcRenderer.invoke('usage:getPlanLimits', force, profileId),
```

- [ ] **Step 5: Verify**

In the app's DevTools console:

```js
await electronAPI.getPlanLimits(false)            // Primary, unchanged behaviour
await electronAPI.getPlanLimits(false, 'primary') // identical result
```

- [ ] **Step 6: Commit**

```bash
git add main.js preload.js
git commit -m "feat(profiles): per-profile usage polling with per-profile cache and cooldown"
```

---

### Task 7: Multi-profile usage bar

**Files:**
- Modify: `renderer.js:13895-13973` (`renderPlanLimitsMini`, `renderPlanLimitsMiniFrom`), `renderer.js:14111` (`loadPlanLimits`)
- Modify: `index.html` (mini-bar container), `styles.css`

**Interfaces:**
- Consumes: `electronAPI.getPlanLimits(force, profileId)` from Task 6; `electronAPI.profileList()` from Task 3.

- [ ] **Step 1: Make the poll fan out**

```js
function loadPlanLimits(force) {
  return window.electronAPI.profileList().then(function (store) {
    var profiles = (store && store.profiles) || [];
    // Stagger so N profiles don't burst the endpoint simultaneously.
    return Promise.all(profiles.map(function (p, i) {
      return new Promise(function (res) { setTimeout(res, i * 250); })
        .then(function () { return window.electronAPI.getPlanLimits(!!force, p.id); })
        .then(function (r) { return { profile: p, result: r }; })
        .catch(function (e) { return { profile: p, result: { ok: false, message: String(e) } }; });
    }));
  }).then(function (entries) {
    renderPlanLimitsMiniAll(entries);
    if (!usageModal.classList.contains('hidden')) renderPlanLimits(entries);
    entries.forEach(handleCrossingsForProfile);
    return entries;
  });
}
```

- [ ] **Step 2: Render one group per profile**

`renderPlanLimitsMiniFrom` already builds Session/Week rows for one dataset — keep it, and wrap it:

```js
function renderPlanLimitsMiniAll(entries) {
  var el = document.getElementById('plan-limits-mini');
  if (!el) return;
  el.innerHTML = '';
  if (!entries.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');

  entries.forEach(function (e) {
    var group = document.createElement('div');
    group.className = 'plan-limits-mini-group';

    // The brand caption is now always shown when there is more than one
    // Claude group, not only when the Codex bar is stacked above.
    if (entries.length > 1 || codexBarVisible) {
      var title = document.createElement('div');
      title.className = 'plan-limits-mini-title';
      var chip = document.createElement('span');
      chip.className = 'plan-limits-mini-chip';
      chip.style.background = e.profile.colour;
      title.appendChild(chip);
      title.appendChild(document.createTextNode(
        entries.length > 1 ? 'Claude · ' + e.profile.name : 'Claude'
      ));
      group.appendChild(title);
    }

    var r = e.result;
    var data = (r && r.ok && r.data) ? r.data : lastGoodByProfile[e.profile.id];
    if (r && r.ok && r.data) {
      lastGoodByProfile[e.profile.id] = r.data;
      persistLastGoodPlanLimits(e.profile.id, r.data, r.fetchedAt || Date.now());
    }

    if (!data) {
      var msg = document.createElement('div');
      msg.className = 'plan-limits-mini-signin';
      // A stale token is the normal state for an account you have not used
      // lately — say what to do, don't show an error.
      msg.textContent = (r && (r.error === 'no-creds' || r.error === 'unauthorized'))
        ? 'Sign in' : '—';
      group.appendChild(msg);
    } else {
      renderPlanLimitsMiniFrom(group, data, r && r.error === 'rate-limited');
    }
    el.appendChild(group);
  });

  if (typeof updatePlanLimitsPopover === 'function') updatePlanLimitsPopover();
}
```

**Change `renderPlanLimitsMiniFrom` to append into the element it is given and to stop owning the `hidden` class and the caption** — that is now the wrapper's job.

Two signature changes go with this, both required:

- `lastGoodPlanLimitsData` (a single dataset) becomes `lastGoodByProfile` (an object keyed by profile id), and `lastGoodPlanLimitsAtMs` becomes `lastGoodAtByProfile`.
- `persistLastGoodPlanLimits(data, atMs)` becomes `persistLastGoodPlanLimits(profileId, data, atMs)`, and its `localStorage` key gains the profile id. The matching restore-at-startup read must key by id too.

Without both, a stale Primary snapshot renders under a secondary profile's name after a restart — a wrong number that looks right, which is worse than a blank bar. Update `setCodexBarVisible` (`renderer.js:13986`) to re-render via `renderPlanLimitsMiniAll` from the cached entries rather than the old single-dataset path.

- [ ] **Step 3: Per-profile threshold crossings**

`prevPlanLimitsData` becomes `prevByProfile`, keyed by id. The notification text gains the profile name when more than one profile exists:

```js
function handleCrossingsForProfile(entry) {
  var r = entry.result, id = entry.profile.id;
  if (!r || !r.ok || !r.data) return;
  var prev = prevByProfile[id];
  if (prev) {
    window.electronAPI.detectThresholdCrossings(prev, r.data).then(function (crossings) {
      if (crossings && crossings.length) handleThresholdCrossings(crossings, entry.profile);
    });
  }
  prevByProfile[id] = r.data;
  updateColumnDeltaPills(r.data, id);   // only columns on this profile
}
```

`handleThresholdCrossings(crossings, profile)` prefixes the notification with `profile.name + ': '` when `profile` is non-Primary, and the 90% automation-pause prompt filters to automations resolving to that profile.

`updateColumnDeltaPills(data, profileId)` must only touch columns whose `col.profileId` resolves to `profileId`, otherwise a column on one subscription shows another's delta.

- [ ] **Step 4: Styles**

Add to `styles.css` — remember there is no global `.hidden`, so scope any new toggled element:

```css
.plan-limits-mini-group { margin-bottom: 6px; }
.plan-limits-mini-group:last-child { margin-bottom: 0; }
.plan-limits-mini-chip {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  margin-right: 5px; vertical-align: middle;
}
.plan-limits-mini-signin {
  font-size: 11px; opacity: .65; padding: 2px 0; cursor: pointer;
}
```

- [ ] **Step 5: Verify in the running app**

Run `npm start` with only Primary configured.
Expected: the bar looks **exactly** as it does today — one uncaptioned Claude group (or captioned "Claude" if the Codex bar is showing). Any visual change at this point is a regression.

- [ ] **Step 6: Commit**

```bash
git add renderer.js index.html styles.css
git commit -m "feat(profiles): render one usage group per subscription"
```

---

### Task 8: Settings mirror on write

Primary stays authoritative; writes fan out so a hook enabled in the app is live on every profile.

**Files:**
- Modify: `main.js:4701`, `main.js:4809` (settings writes), `main.js:5808-5830` (global CLAUDE.md write)

**Interfaces:**
- Produces: `mirrorToProfiles(relPath) → { ok, failed: string[] }`

- [ ] **Step 1: Write the mirror helper**

```js
// Primary (~/.claude) is authoritative for app-managed config. After a
// successful write there, copy the file into every secondary profile so a hook
// or permission the user just enabled is live on every subscription. Profiles
// are clones that differ only in credentials and transcripts.
//
// A failure here MUST surface. Silently diverging profiles is precisely the
// "why isn't my hook running on that column" bug this design exists to avoid.
function mirrorToProfiles(relPath) {
  const src = path.join(os.homedir(), '.claude', relPath);
  const failed = [];
  if (!fs.existsSync(src)) return { ok: true, failed };
  for (const p of readProfiles().profiles) {
    if (!p.configDir) continue;   // Primary is the source
    try {
      const dest = path.join(p.configDir, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    } catch (e) {
      console.warn('[profiles] mirror failed', p.name, relPath, e.message);
      failed.push(p.name);
    }
  }
  return { ok: failed.length === 0, failed };
}
```

- [ ] **Step 2: Call it after each successful write**

After the settings write at `main.js:4701` and `4809`, and the CLAUDE.md write at `5808`:

```js
const mirror = mirrorToProfiles('settings.json');   // or 'CLAUDE.md'
if (!mirror.ok) {
  BrowserWindow.getAllWindows().forEach((w) => {
    try { w.webContents.send('profiles:mirrorFailed', { file: 'settings.json', profiles: mirror.failed }); }
    catch { /* ignore */ }
  });
}
```

Add a `profiles:mirrorFailed` listener in `preload.js` and a toast in `renderer.js`: *"Could not sync settings.json to profile(s): Work. Those columns may behave differently."*

- [ ] **Step 3: Verify the no-secondary-profile case is a true no-op**

With only Primary configured, `readProfiles().profiles` contains one entry with `configDir: null`, the loop body never runs, and `mirrorToProfiles` returns `{ ok: true, failed: [] }` without touching the disk.

Run `npm start`, toggle a hook in the hooks manager.
Expected: `~/.claude/settings.json` updated exactly as before; no other file written.

- [ ] **Step 4: Commit**

```bash
git add main.js preload.js renderer.js
git commit -m "feat(profiles): mirror app-managed settings from Primary to secondaries"
```

---

### Task 9: Union the global aggregates

**Files:**
- Modify: `main.js:3933` (`usage:getAll`), `main.js:4059-4081` (`usage:getCosts`), `main.js:4167` (history)

- [ ] **Step 1: Scan every profile's projects dir in `usage:getAll`**

Replace the single `claudeProjectsDir` (line 3934) with a loop over profiles, tagging each digest with its profile:

```js
const roots = readProfiles().profiles.map((p) => ({
  profileId: p.id,
  profileName: p.name,
  dir: path.join(profileClaudeRoot(p, os.homedir()), 'projects')
}));
```

Each result entry gains `profileId` and `profileName`. **Cache keys must include the profile id** — two profiles can hold a session file with the same name for the same project key, and a shared key would serve one profile's digest for the other's file.

- [ ] **Step 2: Same for `usage:getCosts` and the history reader**

`usage:getCosts` consumes the digest from `usage:getAll`, so it inherits the profile tag; add a profile breakdown to its rollup. The history reader (`main.js:4167`) concatenates every profile's `history.jsonl`, sorted by timestamp.

- [ ] **Step 3: Verify**

Run `npm start`, open the Usage modal with only Primary configured.
Expected: identical totals to before the change.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(profiles): union usage and history across all profiles"
```

---

### Task 10: Subscriptions settings panel

**Files:**
- Modify: `index.html` (panel markup in global settings), `renderer.js` (panel logic), `styles.css`

Model this on the existing endpoints manager markup and logic — find it by grepping `endpointList` in `renderer.js` and copy its structure rather than inventing a new one.

- [ ] **Step 1: Add the panel markup**

A section in global settings containing: a list of profiles (colour chip, name, "Default" badge, sign-in status), and per-row actions Rename / Recolour / Set default / Re-seed from Primary / Delete. Below the list, an "Add subscription" row with a name field and a create button. Primary's row has no Delete.

- [ ] **Step 2: Wire the logic**

```js
function renderProfilesPanel() {
  window.electronAPI.profileList().then(function (store) {
    // ...build rows; disable Delete on the Primary row...
  });
}
window.electronAPI.onProfilesUpdated(renderProfilesPanel);
```

On create, show the sign-in instruction verbatim, since nothing else tells the user what to do next:

> **Profile created.** Spawn a column on this subscription and run `/login` to sign in. Your hooks, permissions and global CLAUDE.md were copied from Primary.

On delete, confirm with the reassignment list returned by `profile:delete`:

> Delete "Work"? Its config directory is removed. These will fall back to Primary: project: Foo, automation: nightly-sweep.

- [ ] **Step 3: Verify in the running app**

Create a profile, confirm `~/.claudes/profiles-dev/<id>/` exists containing `settings.json`, `CLAUDE.md` and a `.claude.json` whose only top-level key is `projects`. Confirm no `oauthAccount` anywhere in it. Delete it, confirm the directory is gone.

- [ ] **Step 4: Commit**

```bash
git add index.html renderer.js styles.css
git commit -m "feat(profiles): Subscriptions panel in global settings"
```

---

### Task 11: Assignment pickers and the column chip

**Files:**
- Modify: `renderer.js` (project settings, workspace row, spawn options, automation editor, column header), `index.html`, `styles.css`

- [ ] **Step 1: Add a shared picker builder**

```js
// One builder for all four pickers so the "inherit" semantics can't drift.
function buildProfilePicker(selectEl, currentId, inheritLabel) {
  return window.electronAPI.profileList().then(function (store) {
    selectEl.innerHTML = '';
    var inherit = document.createElement('option');
    inherit.value = '';
    inherit.textContent = inheritLabel;      // '' means inherit — never an id
    selectEl.appendChild(inherit);
    store.profiles.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name + (p.signedIn ? '' : ' (not signed in)');
      selectEl.appendChild(o);
    });
    selectEl.value = currentId || '';
  });
}
```

- [ ] **Step 2: Place the four pickers**

| Surface | `inheritLabel` | Persists to |
|---|---|---|
| Project settings | `Global default` | `projects.json` project `profileId` |
| Workspace row | `Inherit from project` | `projects.json` workspace `profileId` |
| Spawn options | `Inherit` | in-memory `optProfile`, then column `profileId` |
| Automation editor | `Inherit from project` | `automations.json` `profileId` |

Every one persists `null` for the empty value, never `''`, so the cascade in Task 1 treats it as "inherit".

Changing the spawn picker calls `refreshProfileSelection()` from Task 5.

- [ ] **Step 3: Column header chip**

```js
function updateColumnProfileChip(col) {
  if (!col.profileChipEl) return;
  // Shown ONLY for non-Primary columns, so a single-subscription user's UI is
  // visually identical to today.
  var show = col.profileId && col.profileId !== 'primary';
  col.profileChipEl.classList.toggle('column-profile-chip-shown', !!show);
  if (show) {
    var p = (profilesCache || []).find(function (x) { return x.id === col.profileId; });
    col.profileChipEl.textContent = p ? p.name : '?';
    col.profileChipEl.style.background = p ? p.colour : '#888';
  }
}
```

- [ ] **Step 4: Verify**

With only Primary configured: no chips anywhere, all four pickers show only "inherit" plus "Primary", and the app looks unchanged.

- [ ] **Step 5: Commit**

```bash
git add renderer.js index.html styles.css
git commit -m "feat(profiles): assignment pickers and column profile chip"
```

---

### Task 12: Automations, headless and manager-mode inheritance

**Files:**
- Modify: `main.js` (automation runner, headless spawn, manager clone paths)

- [ ] **Step 1: Resolve the profile when an automation run starts**

```js
const profile = resolveProfileFor({
  columnProfileId: automation.profileId,
  projectProfileId: projectFor(automation) && projectFor(automation).profileId
});
```

Merge `profile.env` into the spawn env alongside the existing `MDB_MCP_CONNECTION_STRING` / endpoint env.

- [ ] **Step 2: Make manager workers inherit explicitly**

Where the manager clones a worker agent, copy the manager's **resolved** `profile.id` onto the worker's spawn selection. Do not leave it unset — an unset worker resolves through the project, which may differ from the manager, and a single manager run would then burn two subscriptions at once.

- [ ] **Step 3: Register background session ids against their profile**

`backgroundSessionIds` (`main.js:1858`) exists so interactive columns never adopt a background session id. With profiles, an automation's transcript lands under **its** profile's `projects/` dir, so the interactive session scan must not treat a same-named file under a different root as a match. Store `profileId` alongside each background id and compare both.

- [ ] **Step 4: Verify**

Run an automation with no profile set.
Expected: it runs on the project's profile, or Primary — identical to today's behaviour.

- [ ] **Step 5: Commit**

```bash
git add main.js renderer.js
git commit -m "feat(profiles): automation, headless and manager-worker profile inheritance"
```

---

### Task 13: macOS credential verification

The one open question in the spec. **Do this before shipping, not after.**

**Files:**
- Modify: `main.js` (`profile:create` guard), `renderer.js` (panel message)
- Modify: the spec document, recording the finding

- [ ] **Step 1: Run the experiment on a Mac**

```bash
mkdir -p /tmp/cc-profile-test
CLAUDE_CONFIG_DIR=/tmp/cc-profile-test claude
# run /login, complete the OAuth flow with a DIFFERENT account
ls -la /tmp/cc-profile-test/.credentials.json    # present?
security find-generic-password -s "Claude Code-credentials" -a "$USER" -w | head -c 80
```

Three possible findings:

1. **Credentials land in `/tmp/cc-profile-test/.credentials.json`** — secondary profiles work on macOS. Nothing to do beyond removing the guard.
2. **Credentials go to the keychain under a config-dir-scoped service name** — record the naming scheme and extend `profileHasCredentials` and the usage-poll credential read to use it.
3. **Credentials overwrite the single global keychain entry** — secondary profiles are unsupported on macOS. The two accounts would fight over one keychain slot.

- [ ] **Step 2: Implement the finding**

If finding 3, guard `profile:create` on macOS:

```js
if (process.platform === 'darwin') {
  return { ok: false, error: 'unsupported-platform',
    message: 'Multiple subscriptions are not supported on macOS — the Claude CLI stores all credentials in a single keychain entry.' };
}
```

and grey the "Add subscription" control with that message as its tooltip. Task 6 already returns `no-creds-macos` for the polling path, so a profiles.json copied from a Windows machine degrades cleanly rather than reporting Primary's usage under another name.

- [ ] **Step 3: Record the finding in the spec**

Replace the "Unverified on macOS" paragraph in `docs/superpowers/specs/2026-07-27-multi-subscription-profiles-design.md` with what actually happened, including the date and the CLI version tested.

- [ ] **Step 4: Commit**

```bash
git add main.js renderer.js docs/superpowers/specs/2026-07-27-multi-subscription-profiles-design.md
git commit -m "fix(profiles): macOS credential behaviour verified and handled"
```

---

### Task 14: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/voice.md`, `EVALUATION-TASKS.md`

- [ ] **Step 1: Add a Subsystems entry to `CLAUDE.md`**

Under "Subsystems", after the Endpoints entry:

> - **Subscriptions / profiles** (`lib/profile-resolve.js`, `lib/profile-seed.js`, `profile:` handlers) — multiple Claude Code accounts, one per profile. A profile is a name plus a config dir; the CLI is pointed at it with `CLAUDE_CONFIG_DIR` at spawn. **Primary has `configDir: null`, means `~/.claude`, and sets no env var** — so with no secondary profile configured every path behaves exactly as it did before the feature existed. Assignment cascades column → workspace → project → global default, resolved *only* by `resolveProfile`. A `profileId` from `sessions.json`/`projects.json`/`automations.json` is an untrusted registry key, never a path; unknown ids fall back to Primary. App-managed config (`settings.json`, global `CLAUDE.md`, `agents/`) is authored on Primary and mirrored to secondaries on write. Transcripts, history and usage credentials all live under the owning profile's root.

Also add to the Project Config section: `profileId` on project, workspace and session entries, omitted when null.

- [ ] **Step 2: Add a profiles note to `docs/voice.md`**

> Voice must resolve transcripts under the **column's profile root**, not `~/.claude`. A wrong root produces no error — the file simply is not found and the column silently stops speaking. `resolveTranscriptPath` takes `claudeRoot` for exactly this reason.

- [ ] **Step 3: Close out `EVALUATION-TASKS.md`** if any backlog item is resolved or newly relevant, and add the macOS finding if secondary profiles ended up unsupported there.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/voice.md EVALUATION-TASKS.md
git commit -m "docs(profiles): document the subscriptions subsystem"
```

---

## Final Verification

- [ ] **Run the full suite**

```bash
npm test
```
Expected: all tests pass, zero failures, including every pre-existing test.

- [ ] **Drive the running app** — `npm test` passing proves nothing here. The `lib/` modules are pure and the suite runs without `node_modules`; it cannot tell you whether a column spawns. The acceptance check is the app:

  - [ ] With only Primary configured, the app is **visually and behaviourally identical** to before: no chips, one usage group, columns spawn and restore, voice speaks, hooks fire.
  - [ ] Create a second profile; confirm its directory contains `settings.json`, `CLAUDE.md` and a `.claude.json` with `projects` as its only top-level key.
  - [ ] Spawn a column on it, run `/login`, sign in with the second account.
  - [ ] Both usage groups render live percentages with the right names.
  - [ ] Voice speaks on the secondary-profile column.
  - [ ] Restart the app; the secondary column restores and reattaches to its own transcript.
  - [ ] The ctx meter populates on the secondary column.
  - [ ] Toggle a hook in the app; confirm it appears in the secondary profile's `settings.json` and fires on its column.
  - [ ] An automation assigned to the secondary profile runs on it.
  - [ ] Delete the secondary profile; confirm the dir is gone and the reassignment list was accurate.

- [ ] **Review** — per the spec's routing note, the profile-resolution core and the credential-reading path (Tasks 1, 3, 6) get a lineage-diverse review before merge. Recusal applies: the reviewer must not be the engine that wrote them.
