const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeTheme, shell, Tray, Menu, nativeImage, Notification, powerMonitor, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { detectCrossings: detectPlanLimitCrossings } = require('./lib/plan-limit-thresholds');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const http = require('http');

// Per-launch auth token for the local pty-server WebSocket. Generated fresh
// each time Electron starts, passed to pty-server via env, and handed to the
// renderer via IPC. The renderer presents it as a Sec-WebSocket-Protocol on
// connect; pty-server rejects the handshake if it doesn't match. Without
// this, any local process (including any web page in any browser) could
// connect to 127.0.0.1:<ptyPort> and spawn arbitrary commands as the user.
const PTY_AUTH_TOKEN = crypto.randomBytes(32).toString('hex');

// Set appUserModelId early so Windows uses a consistent taskbar icon across restarts
app.setAppUserModelId('com.thecodeguy.claudes');

let mainWindow;
let tray;
let isQuitting = false;
let hookServer;
let hookServerPort;
const ptyPort = app.isPackaged ? 3456 : 3457;
const hookServerListenPort = app.isPackaged ? 53456 : 53457;
let ptyServerProcess;

const CONFIG_DIR = path.join(os.homedir(), '.claudes');
// Dev builds use a separate projects file so running dev alongside an
// installed production instance doesn't let the two fight over the same
// config (last-write-wins → surprising "deleted project came back" bugs).
const CONFIG_FILE = path.join(CONFIG_DIR, app.isPackaged ? 'projects.json' : 'projects-dev.json');
const LOOPS_FILE = path.join(CONFIG_DIR, app.isPackaged ? 'loops.json' : 'loops-dev.json');
const LOOPS_RUNS_DIR = path.join(CONFIG_DIR, app.isPackaged ? 'loop-runs' : 'loop-runs-dev');
const AUTOMATIONS_FILE = path.join(CONFIG_DIR, app.isPackaged ? 'automations.json' : 'automations-dev.json');
const AUTOMATIONS_RUNS_DIR = path.join(CONFIG_DIR, app.isPackaged ? 'automation-runs' : 'automation-runs-dev');
const AGENTS_DIR_DEFAULT = path.join(CONFIG_DIR, app.isPackaged ? 'agents' : 'agents-dev');
const ENDPOINTS_FILE = path.join(CONFIG_DIR, app.isPackaged ? 'endpoints.json' : 'endpoints-dev.json');
const SNIPPETS_FILE = path.join(CONFIG_DIR, app.isPackaged ? 'snippets.json' : 'snippets-dev.json');

// --- Path containment ---
//
// Many IPC handlers accept renderer-supplied paths. Without containment, any
// renderer compromise (XSS, malicious paste, future bug) can read or write
// any file the desktop user can — ssh keys, browser cookies, system files.
// `assertInsideAllowedRoots` resolves the input and verifies it sits within
// one of:
//   - any project root the user has explicitly added (config.projects[].path)
//   - ~/.claudes/                 (this app's config)
//   - ~/.claude/                  (Claude CLI's data — sessions, history)
// Symlink escapes are blocked via realpath when the target exists.
function listAllowedRoots() {
  const roots = [path.resolve(CONFIG_DIR), path.resolve(path.join(os.homedir(), '.claude'))];
  try {
    const cfg = readConfig();
    if (Array.isArray(cfg.projects)) {
      for (const p of cfg.projects) {
        if (p && typeof p.path === 'string' && p.path) roots.push(path.resolve(p.path));
      }
    }
  } catch { /* fall through with built-in roots */ }
  return roots;
}
function isInsideRoot(target, root) {
  // Case-insensitive containment check on win32 to match the FS contract.
  const tNorm = process.platform === 'win32' ? target.toLowerCase() : target;
  const rNorm = process.platform === 'win32' ? root.toLowerCase() : root;
  if (tNorm === rNorm) return true;
  const sep = rNorm.endsWith(path.sep) ? '' : path.sep;
  return tNorm.startsWith(rNorm + sep);
}
function assertInsideAllowedRoots(input) {
  if (typeof input !== 'string' || !input) throw new Error('refused: empty path');
  // Reject UNC paths outright — they are network locations and a renderer
  // should never need to push the app at one.
  if (/^\\\\/.test(input) || /^\/\//.test(input)) throw new Error('refused: UNC path');
  let resolved = path.resolve(input);
  // If the path exists and is a symlink (or under one), realpath will reveal
  // the true target so we can check containment against the real FS location.
  try { resolved = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved); }
  catch { /* doesn't exist yet (e.g. write-then-create) — that's ok */ }
  const roots = listAllowedRoots();
  for (const r of roots) {
    if (isInsideRoot(resolved, r)) return resolved;
  }
  throw new Error('refused: path outside allowed roots');
}

// --- Config ---

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readConfig() {
  ensureConfigDir();
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // Drop any corrupt null entries (can appear from a failed drag-reorder splice).
    if (Array.isArray(cfg.projects)) {
      cfg.projects = cfg.projects.filter((p) => p && typeof p === 'object');
    } else {
      cfg.projects = [];
    }
    return cfg;
  } catch {
    return { projects: [], activeProjectIndex: -1 };
  }
}

function writeConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

// The renderer calls saveProjects on every drag/resize/tab tweak, which previously
// hit fs.writeFileSync on every event. Debounce so we coalesce bursts into a single
// write, and flush synchronously on quit so nothing is lost.
const CONFIG_WRITE_DEBOUNCE_MS = 400;
let pendingConfig = null;
let pendingConfigTimer = null;

function scheduleWriteConfig(config) {
  pendingConfig = config;
  if (pendingConfigTimer) return;
  pendingConfigTimer = setTimeout(() => {
    pendingConfigTimer = null;
    const cfg = pendingConfig;
    pendingConfig = null;
    if (cfg) {
      try { writeConfig(cfg); } catch (err) { console.error('writeConfig failed:', err); }
    }
  }, CONFIG_WRITE_DEBOUNCE_MS);
}

function flushPendingConfig() {
  if (pendingConfigTimer) { clearTimeout(pendingConfigTimer); pendingConfigTimer = null; }
  if (pendingConfig) {
    const cfg = pendingConfig;
    pendingConfig = null;
    try { writeConfig(cfg); } catch (err) { console.error('writeConfig failed:', err); }
  }
}

// --- Endpoint Presets ---
//
// Each preset is one of:
//   { id, name, baseUrl, authToken: { encrypted: <b64> }, model }     // normal case
//   { id, name, baseUrl, authToken: { plain: <string> }, model }      // safeStorage unavailable
// The "Anthropic (cloud)" default is synthetic — never persisted.
//
// Endpoints live in their own file (ENDPOINTS_FILE), not projects.json. The
// renderer round-trips projects.json wholesale on every project edit; if we
// stored endpoints there too, those writes would clobber any preset added
// outside the renderer's view.

function encryptToken(plain) {
  if (!plain) return { plain: '' };
  if (safeStorage.isEncryptionAvailable()) {
    return { encrypted: safeStorage.encryptString(plain).toString('base64') };
  }
  return { plain };
}

function decryptToken(stored) {
  if (!stored) return '';
  if (typeof stored === 'string') return stored;
  if (stored.plain != null) return stored.plain;
  if (stored.encrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'));
    } catch {
      return '';
    }
  }
  return '';
}

function readEndpoints() {
  ensureConfigDir();
  try {
    const raw = fs.readFileSync(ENDPOINTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.endpoints)) return data.endpoints;
    return [];
  } catch {
    return [];
  }
}

function writeEndpoints(list) {
  ensureConfigDir();
  fs.writeFileSync(ENDPOINTS_FILE, JSON.stringify({ endpoints: list }, null, 2), 'utf8');
}

function getEndpointById(id) {
  if (!id) return null;
  const list = readEndpoints();
  return list.find((e) => e && e.id === id) || null;
}

function buildEndpointEnv(endpointId, modelOverride) {
  const preset = getEndpointById(endpointId);
  if (!preset) return null;
  const token = decryptToken(preset.authToken);
  // Per-project model override (set by the endpoint model dropdown in the
  // spawn options) takes precedence over the preset's default model.
  const model = (modelOverride && String(modelOverride).trim()) || preset.model || '';
  // ANTHROPIC_AUTH_TOKEN must be set to *something* — if it's empty or missing
  // the Claude CLI falls back to the user's real Anthropic credentials and
  // sends them to whatever local server we've pointed it at. A dummy value
  // keeps it honest. LM Studio (and other local servers without auth) will
  // accept any string.
  const authToken = token || 'no-auth';
  // URL-embedded creds (e.g. https://user:pass@ngrok-tunnel/) must be lifted
  // out: undici (used by Claude CLI's internal fetch) refuses URLs with
  // userinfo. Forward them as a Basic auth header via ANTHROPIC_CUSTOM_HEADERS.
  //
  // Auth header conflict: ANTHROPIC_AUTH_TOKEN makes Claude emit
  // `Authorization: Bearer ...`. If we also set Basic via custom headers, the
  // proxy sees two Authorization values and 401s. Switch the upstream auth to
  // ANTHROPIC_API_KEY (sent as `x-api-key`, not `Authorization`) when URL
  // creds are present so the Basic header is the only Authorization header
  // reaching the proxy. LM Studio and similar local servers ignore x-api-key.
  const { url: cleanBaseUrl, basicAuth } = extractUrlCredentials(preset.baseUrl || '');
  const env = {
    ANTHROPIC_BASE_URL: cleanBaseUrl,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    DISABLE_PROMPT_CACHING: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
    // Local-model context discipline — without these, a single large bash or
    // MCP tool result can blow past the model's context window in one turn.
    // Conservative caps that won't hurt typical workflows but stop runaway
    // file dumps from triggering autocompact thrash.
    BASH_MAX_OUTPUT_LENGTH: '8000',
    MAX_MCP_OUTPUT_TOKENS: '10000',
    MAX_THINKING_TOKENS: '2000'
  };
  if (basicAuth) {
    env.ANTHROPIC_CUSTOM_HEADERS = 'Authorization: Basic ' + basicAuth;
    env.ANTHROPIC_API_KEY = authToken;
  } else {
    env.ANTHROPIC_AUTH_TOKEN = authToken;
  }
  return env;
}

// Look up a project by its filesystem path and return the env block for its
// configured endpoint preset, or null if the project has no preset selected.
// Used by background spawn paths (headless runs, automation agents, automation
// managers) which only know the project path, not the renderer's cached state.
function getProjectEndpointEnvByPath(projectPath) {
  if (!projectPath) return null;
  const cfg = readConfig();
  const project = (cfg.projects || []).find((p) => p && p.path === projectPath);
  if (!project) return null;
  const id = project.spawnOptions && project.spawnOptions.endpointId;
  if (!id) return null;
  const modelOverride = project.spawnOptions && project.spawnOptions.endpointModel;
  return buildEndpointEnv(id, modelOverride);
}

// --- Loops Persistence ---

function readLoops() {
  ensureConfigDir();
  try {
    return JSON.parse(fs.readFileSync(LOOPS_FILE, 'utf8'));
  } catch {
    return { globalEnabled: true, maxConcurrentRuns: 3, loops: [] };
  }
}

// --- Automations Persistence ---

function readAutomations() {
  ensureConfigDir();
  try {
    return JSON.parse(fs.readFileSync(AUTOMATIONS_FILE, 'utf8'));
  } catch {
    return { globalEnabled: true, maxConcurrentRuns: 3, agentReposBaseDir: AGENTS_DIR_DEFAULT, automations: [] };
  }
}

function writeAutomations(data) {
  ensureConfigDir();
  fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Prompt snippet library — persists to ~/.claudes/snippets.json. Each snippet
// has { id, trigger, label, body }. Triggered in the renderer by typing
// "\trigger" in a column terminal.
function readSnippets() {
  try { return JSON.parse(fs.readFileSync(SNIPPETS_FILE, 'utf8')); }
  catch { return { snippets: [] }; }
}
function writeSnippets(data) {
  ensureConfigDir();
  fs.writeFileSync(SNIPPETS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function ensureAgentRunsDir(automationId, agentId) {
  const dir = path.join(AUTOMATIONS_RUNS_DIR, automationId, agentId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function saveAgentRun(automationId, agentId, runData) {
  const dir = ensureAgentRunsDir(automationId, agentId);
  const filename = new Date(runData.startedAt).toISOString().replace(/[:.]/g, '-') + '.json';
  if (runData.output && runData.output.length > 50000) {
    runData.output = runData.output.substring(0, 50000) + '\n...[truncated]';
  }
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(runData, null, 2), 'utf8');
  pruneAgentRuns(dir);
}

function pruneAgentRuns(dir) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    while (files.length > 50) {
      fs.unlinkSync(path.join(dir, files.shift()));
    }
  } catch { /* ignore */ }
}

function getAgentHistory(automationId, agentId, count) {
  const dir = path.join(AUTOMATIONS_RUNS_DIR, automationId, agentId);
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
    const results = [];
    for (let i = 0; i < Math.min(count || 5, files.length); i++) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, files[i]), 'utf8'));
      results.push({
        startedAt: data.startedAt,
        completedAt: data.completedAt,
        durationMs: data.durationMs,
        status: data.status,
        summary: data.summary,
        attentionItems: data.attentionItems || [],
        costUsd: data.costUsd,
        exitCode: data.exitCode
      });
    }
    return results;
  } catch {
    return [];
  }
}

function migrateLoopsToAutomations() {
  // Only migrate if loops.json exists and automations.json does not
  if (!fs.existsSync(LOOPS_FILE) || fs.existsSync(AUTOMATIONS_FILE)) return;

  console.log('[Migration] Migrating loops.json to automations.json...');

  // Backup loops.json
  const backupPath = path.join(CONFIG_DIR, 'loops.backup.json');
  fs.copyFileSync(LOOPS_FILE, backupPath);
  console.log('[Migration] Backed up loops.json to loops.backup.json');

  const loopData = JSON.parse(fs.readFileSync(LOOPS_FILE, 'utf8'));

  const automationsData = {
    globalEnabled: loopData.globalEnabled !== undefined ? loopData.globalEnabled : true,
    maxConcurrentRuns: loopData.maxConcurrentRuns || 3,
    agentReposBaseDir: AGENTS_DIR_DEFAULT,
    automations: []
  };

  // Transform each loop into an automation with a single agent
  (loopData.loops || []).forEach(loop => {
    const automationId = generateAutomationId();
    const agentId = generateAgentId();

    const agent = {
      id: agentId,
      name: loop.name,
      prompt: loop.prompt,
      schedule: loop.schedule,
      runMode: 'independent',
      runAfter: [],
      runOnUpstreamFailure: false,
      passUpstreamContext: false,
      isolation: { enabled: false, clonePath: null },
      enabled: loop.enabled !== undefined ? loop.enabled : true,
      skipPermissions: loop.skipPermissions || false,
      firstStartOnly: loop.firstStartOnly || false,
      dbConnectionString: loop.dbConnectionString || null,
      dbReadOnly: loop.dbReadOnly !== false,
      lastRunAt: loop.lastRunAt || null,
      lastRunStatus: loop.lastRunStatus || null,
      lastError: loop.lastError || null,
      lastSummary: loop.lastSummary || null,
      lastAttentionItems: loop.lastAttentionItems || null,
      currentRunStartedAt: loop.currentRunStartedAt || null
    };

    const automation = {
      id: automationId,
      name: loop.name,
      projectPath: loop.projectPath,
      agents: [agent],
      enabled: loop.enabled !== undefined ? loop.enabled : true,
      createdAt: loop.createdAt || new Date().toISOString()
    };

    automationsData.automations.push(automation);

    // Migrate run history: loop-runs/{loopId}/ -> automation-runs/{automationId}/{agentId}/
    const oldRunDir = path.join(LOOPS_RUNS_DIR, loop.id);
    if (fs.existsSync(oldRunDir)) {
      const newRunDir = path.join(AUTOMATIONS_RUNS_DIR, automationId, agentId);
      fs.mkdirSync(newRunDir, { recursive: true });
      const runFiles = fs.readdirSync(oldRunDir).filter(f => f.endsWith('.json'));
      runFiles.forEach(file => {
        fs.copyFileSync(path.join(oldRunDir, file), path.join(newRunDir, file));
      });
      console.log('[Migration] Migrated ' + runFiles.length + ' run files for loop "' + loop.name + '"');
    }
  });

  writeAutomations(automationsData);
  console.log('[Migration] Created automations.json with ' + automationsData.automations.length + ' automations');
}

function generateAutomationId() {
  return 'auto_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
}

function generateAgentId() {
  return 'agent_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
}

// --- Pty Server ---

function findSystemNode() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['node'], { encoding: 'utf8' });
    return result.trim().split(/\r?\n/)[0];
  } catch {
    return 'node';
  }
}

function getPtyServerScript() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'pty-server.js');
  }
  return path.join(__dirname, 'pty-server.js');
}

function startPtyServer() {
  return new Promise((resolve, reject) => {
    const nodePath = findSystemNode();
    const serverScript = getPtyServerScript();

    ptyServerProcess = spawn(nodePath, [serverScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PTY_PORT: String(ptyPort), PTY_AUTH_TOKEN }
    });

    ptyServerProcess.stderr.on('data', (data) => {
      console.error('[pty-server]', data.toString());
    });

    ptyServerProcess.on('exit', (code) => {
      console.log('[pty-server] exited with code', code);
    });

    // Wait for ready signal
    let resolved = false;
    ptyServerProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (!resolved && output.includes('READY:')) {
        resolved = true;
        resolve();
      }
      console.log('[pty-server]', output.trim());
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(); // proceed anyway after timeout
      }
    }, 5000);
  });
}

// --- Window ---

function wasLaunchedAtLogin() {
  if (process.platform === 'darwin') {
    return app.getLoginItemSettings().wasOpenedAtLogin;
  }
  return process.argv.includes('--hidden');
}

function createWindow() {
  const config = readConfig();
  const isLight = config.theme === 'auto' ? !nativeTheme.shouldUseDarkColors : config.theme === 'light';
  const startHidden = wasLaunchedAtLogin();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 600,
    minHeight: 400,
    show: !startHidden,
    title: 'Claudes',
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon-tray.ico' : 'icon.png'),
    backgroundColor: isLight ? '#ffffff' : '#1a1a2e',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: isLight ? '#e8ecf1' : '#16213e',
      symbolColor: isLight ? '#1f2328' : '#e0e0e0',
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');

  if (startHidden && process.platform === 'darwin') {
    app.dock.hide();
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (process.platform === 'darwin') {
        mainWindow.hide();
        app.dock.hide();
      } else {
        // On Windows: minimize instead of hide so the taskbar button still works
        mainWindow.minimize();
      }
    }
  });

  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('theme:osChanged', nativeTheme.shouldUseDarkColors);
    }
    for (const win of popoutWindows.values()) {
      if (!win.isDestroyed()) win.webContents.send('theme:osChanged', nativeTheme.shouldUseDarkColors);
    }
  });
}

// Registry of open popout windows keyed by project path.
const popoutWindows = new Map();

// Short-lived store of column-transfer data between main and popout windows.
// The sending side writes here before requesting the pop-out (or before close);
// the receiving side reads and deletes here on startup / pop-in.
const pendingPopoutTransfers = new Map();

function createProjectWindow(projectKey) {
  if (popoutWindows.has(projectKey)) {
    const existing = popoutWindows.get(projectKey);
    if (!existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return existing;
    }
    popoutWindows.delete(projectKey);
  }

  const config = readConfig();
  const project = config.projects.find((p) => p.path === projectKey);
  if (!project) return null;

  const isLight = config.theme === 'auto' ? !nativeTheme.shouldUseDarkColors : config.theme === 'light';
  const bounds = project.popoutBounds || {};

  const win = new BrowserWindow({
    width: bounds.width || 1200,
    height: bounds.height || 800,
    x: typeof bounds.x === 'number' ? bounds.x : undefined,
    y: typeof bounds.y === 'number' ? bounds.y : undefined,
    minWidth: 600,
    minHeight: 400,
    title: 'Claudes \u2013 ' + (project.name || projectKey),
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon-tray.ico' : 'icon.png'),
    backgroundColor: isLight ? '#ffffff' : '#1a1a2e',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: isLight ? '#e8ecf1' : '#16213e',
      symbolColor: isLight ? '#1f2328' : '#e0e0e0',
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html', {
    query: { mode: 'popout', projectKey: projectKey }
  });

  const saveBoundsDebounced = debouncePopoutBounds(projectKey, win);
  win.on('move', saveBoundsDebounced);
  win.on('resize', saveBoundsDebounced);

  win.on('close', (event) => {
    if (win.isDestroyed()) return;
    if (win._skipCloseBookkeeping) return;

    // First pass: pause the close, collect transfer data from the popout so
    // main can reattach to its ptys, persist it, then allow the close to
    // proceed on the second entry into this handler.
    if (!win._transferCollected && !isQuitting) {
      event.preventDefault();
      win._transferCollected = true;
      const collectJs = 'typeof collectPopoutTransferForClose === "function" ? collectPopoutTransferForClose() : []';
      win.webContents.executeJavaScript(collectJs, true).then((transfer) => {
        if (transfer && transfer.length > 0) {
          pendingPopoutTransfers.set(projectKey, transfer);
        }
      }).catch(() => {}).finally(() => {
        if (!win.isDestroyed()) win.close();
      });
      return;
    }

    try {
      const b = win.getBounds();
      const cfg = readConfig();
      const p = cfg.projects.find((x) => x.path === projectKey);
      if (p) {
        p.popoutBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        if (!isQuitting) {
          p.poppedOut = false;
        }
        scheduleWriteConfig(cfg);
        broadcastConfigUpdated(cfg);
      }
    } catch (err) {
      console.error('popout close bookkeeping failed:', err);
    }
  });

  win.on('closed', () => {
    popoutWindows.delete(projectKey);
  });

  popoutWindows.set(projectKey, win);
  return win;
}

// Per-window debounce for bounds persistence so drag events don't flood writeConfig.
const POPOUT_BOUNDS_DEBOUNCE_MS = 300;
function debouncePopoutBounds(projectKey, win) {
  let timer = null;
  return function () {
    if (win.isDestroyed()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      const cfg = readConfig();
      const p = cfg.projects.find((x) => x.path === projectKey);
      if (!p) return;
      p.popoutBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      scheduleWriteConfig(cfg);
      // Intentionally no broadcastConfigUpdated here — bounds changes are
      // internal to the popout. Broadcasting would race with pending renderer
      // edits (like project removal) and overwrite them with readConfig()'s
      // pre-debounce disk state.
    }, POPOUT_BOUNDS_DEBOUNCE_MS);
  };
}

function broadcastConfigUpdated(config) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config:updated', config);
  }
  for (const win of popoutWindows.values()) {
    if (!win.isDestroyed()) {
      win.webContents.send('config:updated', config);
    }
  }
}

// --- IPC Handlers ---

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('config:getProjects', () => {
  return readConfig();
});

ipcMain.handle('config:saveProjects', (event, config) => {
  scheduleWriteConfig(config);
});

// --- Endpoint preset IPC handlers ---
//
// Renderer sees plaintext tokens through these handlers. Encrypted blobs
// never leave main; the spawn flow asks for the env block via endpoint:getEnv
// rather than handing the token to the renderer when it can be avoided.

ipcMain.handle('endpoint:list', () => {
  const list = readEndpoints();
  return list.map((e) => ({
    id: e.id,
    name: e.name || '',
    baseUrl: e.baseUrl || '',
    model: e.model || '',
    hasToken: !!decryptToken(e.authToken),
    fallbackId: e.fallbackId || null,
    contextWindow: e.contextWindow || null
  }));
});

ipcMain.handle('endpoint:get', (event, id) => {
  const e = getEndpointById(id);
  if (!e) return null;
  return {
    id: e.id,
    name: e.name || '',
    baseUrl: e.baseUrl || '',
    model: e.model || '',
    authToken: decryptToken(e.authToken),
    fallbackId: e.fallbackId || null,
    contextWindow: e.contextWindow || null
  };
});

// Claude Code internally appends `/v1/messages` etc. to ANTHROPIC_BASE_URL,
// so the stored base URL must be the host root WITHOUT a trailing `/v1`.
// LM Studio's OpenAI-compat router is rooted at `/v1/*`, so users tend to
// paste `http://host:port/v1` thinking that's the API root — strip it.
function normalizeBaseUrl(input) {
  let url = String(input || '').trim();
  url = url.replace(/\/+$/, '');         // trailing slashes
  url = url.replace(/\/v1\/?$/i, '');    // trailing /v1 (case insensitive)
  return url;
}

// Extract user:pass@ credentials from a URL so callers can send Basic auth
// explicitly. Required because:
//   1. Node's undici fetch (Node 18+) refuses URLs with embedded userinfo —
//      "Request cannot be constructed from a URL that includes credentials".
//   2. The Claude CLI's internal fetch hits the same restriction when
//      ANTHROPIC_BASE_URL contains creds.
// Common shape: ngrok tunnel basic-auth, e.g. https://user:pass@host/...
// Returns { url: <stripped>, basicAuth: <base64('user:pass')> | null }.
function extractUrlCredentials(rawUrl) {
  const input = String(rawUrl || '');
  if (!input) return { url: '', basicAuth: null };
  try {
    const u = new URL(input);
    if (!u.username && !u.password) return { url: input, basicAuth: null };
    const user = decodeURIComponent(u.username || '');
    const pass = decodeURIComponent(u.password || '');
    u.username = '';
    u.password = '';
    // URL.toString() normalizes trailing slash on origin-only URLs — strip it
    // so the result round-trips cleanly through normalizeBaseUrl.
    let clean = u.toString();
    if (!u.pathname || u.pathname === '/') clean = clean.replace(/\/$/, '');
    return { url: clean, basicAuth: Buffer.from(user + ':' + pass).toString('base64') };
  } catch {
    return { url: input, basicAuth: null };
  }
}

ipcMain.handle('endpoint:save', (event, preset) => {
  if (!preset || typeof preset !== 'object') {
    throw new Error('endpoint:save requires a preset object');
  }
  const list = readEndpoints();
  const id = preset.id || ('ep_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));

  // Optional fallbackId: must reference another existing preset, never self.
  // Empty string / undefined / null all mean "no fallback".
  let fallbackId = null;
  if (preset.fallbackId) {
    if (preset.fallbackId === id) {
      return { ok: false, error: 'Fallback cannot be the same preset.' };
    }
    if (!list.find((e) => e && e.id === preset.fallbackId)) {
      return { ok: false, error: 'Fallback endpoint does not exist.' };
    }
    fallbackId = String(preset.fallbackId);
  }

  // Optional context window — used by the column ctx meter as denominator.
  // Falsy/invalid values are stored as null so renderer treats it as "unset".
  let contextWindow = null;
  if (preset.contextWindow != null) {
    const n = typeof preset.contextWindow === 'string' ? parseInt(preset.contextWindow, 10) : preset.contextWindow;
    if (Number.isFinite(n) && n > 0) contextWindow = n;
  }

  const stored = {
    id,
    name: String(preset.name || '').trim(),
    baseUrl: normalizeBaseUrl(preset.baseUrl),
    model: String(preset.model || '').trim(),
    authToken: encryptToken(String(preset.authToken || '')),
    fallbackId,
    contextWindow
  };
  const idx = list.findIndex((e) => e && e.id === id);
  if (idx >= 0) list[idx] = stored;
  else list.push(stored);
  writeEndpoints(list);
  // Push to all windows so other open instances reload their dropdown.
  BrowserWindow.getAllWindows().forEach((w) => {
    try { w.webContents.send('endpoints:updated'); } catch { /* ignore */ }
  });
  return { id, ok: true };
});

ipcMain.handle('endpoint:delete', (event, id) => {
  const list = readEndpoints().filter((e) => e && e.id !== id);
  writeEndpoints(list);
  BrowserWindow.getAllWindows().forEach((w) => {
    try { w.webContents.send('endpoints:updated'); } catch { /* ignore */ }
  });
  return { ok: true };
});

ipcMain.handle('endpoint:getEnv', (event, id, modelOverride) => {
  return buildEndpointEnv(id, modelOverride);
});

ipcMain.handle('endpoint:fetchModels', async (event, args) => {
  // Accept either `http://host:port` or `http://host:port/v1`; we store the
  // bare host but tolerate either form on the way in.
  const baseUrl = normalizeBaseUrl((args && args.baseUrl) || '');
  const authToken = String((args && args.authToken) || '');
  if (!baseUrl) return { ok: false, error: 'Base URL is required' };
  // URL-embedded creds (ngrok-style basic auth) must be stripped before fetch
  // — undici refuses URLs with userinfo. Promote them to a Basic auth header.
  // If both URL creds and an explicit token exist, URL creds win because the
  // proxy layer is what's gating the request.
  const { url: cleanBase, basicAuth } = extractUrlCredentials(baseUrl);
  const url = cleanBase + '/v1/models';
  const headers = {};
  if (basicAuth) headers['Authorization'] = 'Basic ' + basicAuth;
  else if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + res.statusText };
    const data = await res.json();
    const arr = Array.isArray(data && data.data) ? data.data : (Array.isArray(data) ? data : []);
    const models = arr.map((m) => (m && (m.id || m.model || m.name)) || '').filter(Boolean);
    // Best-effort context-length probe. LM Studio surfaces these on /v1/models;
    // vLLM uses max_model_len; some servers use context_length or n_ctx.
    function pickCtx(m) {
      if (!m || typeof m !== 'object') return null;
      const candidates = [
        m.loaded_context_length, m.max_context_length, m.context_length,
        m.max_model_len, m.n_ctx, m.context_window
      ];
      for (const v of candidates) {
        const n = typeof v === 'string' ? parseInt(v, 10) : v;
        if (Number.isFinite(n) && n > 0) return n;
      }
      return null;
    }
    const modelInfo = arr
      .map((m) => ({ id: (m && (m.id || m.model || m.name)) || '', context: pickCtx(m) }))
      .filter((m) => m.id);
    return { ok: true, models, modelInfo };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'Request timed out' : (err && err.message) || 'Fetch failed';
    return { ok: false, error: msg };
  }
});

ipcMain.handle('popout:setTransfer', (event, projectKey, transferList) => {
  if (transferList && transferList.length > 0) {
    pendingPopoutTransfers.set(projectKey, transferList);
  } else {
    pendingPopoutTransfers.delete(projectKey);
  }
});

ipcMain.handle('popout:takeTransfer', (event, projectKey) => {
  const list = pendingPopoutTransfers.get(projectKey);
  pendingPopoutTransfers.delete(projectKey);
  return list || null;
});

ipcMain.handle('project:popOut', (event, projectKey) => {
  const cfg = readConfig();
  const project = cfg.projects.find((p) => p.path === projectKey);
  if (!project) return false;
  project.poppedOut = true;
  scheduleWriteConfig(cfg);
  broadcastConfigUpdated(cfg);
  createProjectWindow(projectKey);
  return true;
});

ipcMain.handle('project:popIn', (event, projectKey) => {
  const cfg = readConfig();
  const project = cfg.projects.find((p) => p.path === projectKey);
  if (!project) return false;
  project.poppedOut = false;
  scheduleWriteConfig(cfg);
  broadcastConfigUpdated(cfg);
  const win = popoutWindows.get(projectKey);
  if (win && !win.isDestroyed()) {
    win.close();
  }
  return true;
});

ipcMain.handle('project:focusPopoutWindow', (event, projectKey) => {
  const win = popoutWindows.get(projectKey);
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
});

ipcMain.handle('project:closePopoutWindow', (event, projectKey) => {
  const win = popoutWindows.get(projectKey);
  if (win && !win.isDestroyed()) {
    // Sentinel so the close handler skips its config bookkeeping.
    win._skipCloseBookkeeping = true;
    win.close();
  }
  return true;
});

ipcMain.handle('app:getStartWithOS', () => {
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin;
});

ipcMain.handle('app:setStartWithOS', (event, enabled) => {
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true
    });
  } else {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: enabled ? ['--hidden'] : []
    });
  }
});

ipcMain.handle('theme:setTitleBarOverlay', (event, colors) => {
  const apply = (win) => {
    if (!win || win.isDestroyed()) return;
    win.setTitleBarOverlay({
      color: colors.color,
      symbolColor: colors.symbolColor,
      height: 40
    });
    win.setBackgroundColor(colors.color);
  };
  apply(mainWindow);
  for (const win of popoutWindows.values()) apply(win);
});

// --- Session Management ---

// Convert a project path to Claude's project key format.
// Claude CLI encodes every non-alphanumeric character (colons, slashes,
// backslashes, spaces, dots, underscores, …) as a single '-'. Consecutive
// non-alphanumerics each become their own '-' (no collapsing). Leading '-'s
// are stripped so unix paths starting with '/' don't begin with a separator.
// Examples:
//   D:\Git Repos\Claudes  → D--Git-Repos-Claudes
//   /Users/devel          → Users-devel
//   D:\foo\.bar           → D--foo--bar
function projectPathToClaudeKey(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+/, '');
}

// Get recent session IDs for a project by scanning Claude's data directory
ipcMain.handle('sessions:getRecent', (event, projectPath) => {
  const claudeKey = projectPathToClaudeKey(projectPath);
  const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', claudeKey);

  try {
    if (!fs.existsSync(claudeProjectDir)) return [];

    const files = fs.readdirSync(claudeProjectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const filePath = path.join(claudeProjectDir, f);
        const stat = fs.statSync(filePath);
        return {
          sessionId: f.replace('.jsonl', ''),
          modified: stat.mtimeMs
        };
      })
      .sort((a, b) => b.modified - a.modified);

    return files;
  } catch {
    return [];
  }
});

// Get the title (first user message) from a Claude session JSONL file
ipcMain.handle('sessions:getTitle', (event, projectPath, sessionId) => {
  const claudeKey = projectPathToClaudeKey(projectPath);
  const jsonlPath = path.join(os.homedir(), '.claude', 'projects', claudeKey, sessionId + '.jsonl');
  try {
    // Read only first 32KB — the first user message is always near the top
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(32768);
    const bytesRead = fs.readSync(fd, buf, 0, 32768, 0);
    fs.closeSync(fd);
    const content = buf.toString('utf8', 0, bytesRead);
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type === 'user' && msg.message && msg.message.content) {
        let text = typeof msg.message.content === 'string'
          ? msg.message.content
          : msg.message.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
        // Strip XML/HTML delimiters (from skill invocations etc.)
        text = text.replace(/[<>]/g, '').trim();
        if (!text) continue;
        const firstLine = text.split('\n')[0].trim();
        if (!firstLine) continue;
        return firstLine.length > 40 ? firstLine.substring(0, 37) + '...' : firstLine;
      }
    }
    return null;
  } catch {
    return null;
  }
});

// Save/load session state per project (which sessions were open in columns)
ipcMain.handle('sessions:save', (event, projectPath, sessionData) => {
  try {
    const safeBase = assertInsideAllowedRoots(projectPath);
    const claudesDir = path.join(safeBase, '.claudes');
    if (!fs.existsSync(claudesDir)) {
      fs.mkdirSync(claudesDir, { recursive: true });
    }
    const sessionsFile = path.join(claudesDir, 'sessions.json');
    fs.writeFileSync(sessionsFile, JSON.stringify({ sessions: sessionData }, null, 2), 'utf8');
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('sessions:load', (event, projectPath) => {
  try {
    const safeBase = assertInsideAllowedRoots(projectPath);
    const sessionsFile = path.join(safeBase, '.claudes', 'sessions.json');
    const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    return data.sessions || [];
  } catch {
    return [];
  }
});

// --- CLAUDE.md Management ---

ipcMain.handle('claudemd:read', (event, projectPath) => {
  try {
    const safeBase = assertInsideAllowedRoots(projectPath);
    const filePath = path.join(safeBase, 'CLAUDE.md');
    if (!fs.existsSync(filePath)) return { exists: false, content: '' };
    return { exists: true, content: fs.readFileSync(filePath, 'utf8') };
  } catch {
    return { exists: false, content: '' };
  }
});

ipcMain.handle('claudemd:save', (event, projectPath, content) => {
  try {
    const safeBase = assertInsideAllowedRoots(projectPath);
    const filePath = path.join(safeBase, 'CLAUDE.md');
    if (typeof content !== 'string') return { success: false, error: 'content must be a string' };
    if (Buffer.byteLength(content, 'utf8') > FS_WRITE_MAX_BYTES) {
      return { success: false, error: 'content exceeds write size cap (5MB)' };
    }
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Explorer Panel IPC ---

const FS_WRITE_MAX_BYTES = 5 * 1024 * 1024;  // 5 MB cap on writes — well above any text file the editor handles

ipcMain.handle('fs:readFile', (event, filePath) => {
  try {
    const safe = assertInsideAllowedRoots(filePath);
    const stats = fs.statSync(safe);
    if (stats.size > 2 * 1024 * 1024) {
      return { error: 'File is too large to edit (>2MB)' };
    }
    const buf = fs.readFileSync(safe);
    // Check for binary content (null bytes in first 8KB)
    const sample = buf.slice(0, 8192);
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0) return { error: 'Cannot edit binary files' };
    }
    return { content: buf.toString('utf8') };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('fs:writeFile', (event, filePath, content) => {
  try {
    const safe = assertInsideAllowedRoots(filePath);
    if (typeof content !== 'string') return { success: false, error: 'content must be a string' };
    if (Buffer.byteLength(content, 'utf8') > FS_WRITE_MAX_BYTES) {
      return { success: false, error: 'content exceeds write size cap (5MB)' };
    }
    fs.writeFileSync(safe, content, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fs:readDir', (event, dirPath) => {
  try {
    const safe = assertInsideAllowedRoots(dirPath);
    const entries = fs.readdirSync(safe, { withFileTypes: true });
    const excluded = new Set(['node_modules', '.git', '__pycache__', '.next', '.nuxt']);
    return entries
      .filter(e => !excluded.has(e.name))
      .map(e => ({
        name: e.name,
        path: path.join(safe, e.name),
        isDirectory: e.isDirectory()
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
});

ipcMain.handle('fs:searchFiles', (event, rootDir, query) => {
  let safeRoot;
  try { safeRoot = assertInsideAllowedRoots(rootDir); } catch { return []; }
  const excluded = new Set(['node_modules', '.git', '__pycache__', '.next', '.nuxt', 'dist', '.cache', 'coverage']);
  const results = [];
  const lowerQuery = String(query || '').toLowerCase();
  const MAX_RESULTS = 100;

  function walk(dir) {
    if (results.length >= MAX_RESULTS) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (results.length >= MAX_RESULTS) return;
        if (excluded.has(e.name)) continue;
        const fullPath = path.join(dir, e.name);
        const relativePath = path.relative(safeRoot, fullPath);
        if (e.name.toLowerCase().includes(lowerQuery)) {
          results.push({ name: e.name, path: fullPath, relativePath, isDirectory: e.isDirectory() });
        }
        if (e.isDirectory()) walk(fullPath);
      }
    } catch { /* skip inaccessible dirs */ }
  }

  walk(safeRoot);
  return results;
});

// Async git runner — never block the Electron main thread.
// execFile() preserves stderr/stdout on error like execFileSync does.
function runGit(cwd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: timeout || 5000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = err.stderr || stderr;
        err.stdout = err.stdout || stdout;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

ipcMain.handle('git:status', async (event, projectPath) => {
  try {
    const output = await runGit(projectPath, ['status', '--porcelain'], 5000);
    return output.replace(/\s+$/, '').split('\n').filter(Boolean).map(line => ({
      status: line.substring(0, 2),
      file: line.substring(3)
    }));
  } catch {
    return [];
  }
});

ipcMain.handle('git:branch', async (event, projectPath) => {
  try {
    return (await runGit(projectPath, ['branch', '--show-current'], 5000)).trim();
  } catch {
    return '';
  }
});

ipcMain.handle('git:stageFile', async (event, projectPath, filePath) => {
  try {
    await runGit(projectPath, ['add', '--', filePath], 5000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:unstageFile', async (event, projectPath, filePath) => {
  try {
    await runGit(projectPath, ['reset', 'HEAD', '--', filePath], 5000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:stageAll', async (event, projectPath) => {
  try {
    await runGit(projectPath, ['add', '-A'], 5000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:unstageAll', async (event, projectPath) => {
  try {
    await runGit(projectPath, ['reset', 'HEAD'], 10000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:commit', async (event, projectPath, message, amend) => {
  try {
    const args = amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message];
    await runGit(projectPath, args, 10000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:pull', async (event, projectPath) => {
  try {
    const output = await runGit(projectPath, ['pull'], 30000);
    return { success: true, output: output.trim() || 'Pull complete' };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:push', async (event, projectPath) => {
  try {
    await runGit(projectPath, ['push'], 30000);
    return { success: true, output: 'Push complete' };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:discardFile', async (event, projectPath, filePath) => {
  try {
    await runGit(projectPath, ['checkout', '--', filePath], 5000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:branches', async (event, projectPath) => {
  try {
    const output = await runGit(projectPath, ['branch', '--list', '--no-color'], 5000);
    return output.trim().split('\n').filter(Boolean).map(line => ({
      name: line.replace(/^\*?\s+/, ''),
      isCurrent: line.startsWith('*')
    }));
  } catch {
    return [];
  }
});

// Reject branch names that look like option flags or that contain shell-ish
// metacharacters. Without this, `git checkout --orphan` and similar are
// reachable from the renderer. Pattern conforms to the safe subset of
// git-check-ref-format(1).
function isSafeGitRefName(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name.startsWith('-')) return false;
  if (name.length > 200) return false;
  if (!/^[A-Za-z0-9._/+-]+$/.test(name)) return false;
  if (name.includes('..')) return false;
  if (name.endsWith('.lock')) return false;
  return true;
}

ipcMain.handle('git:checkout', async (event, projectPath, branchName) => {
  if (!isSafeGitRefName(branchName)) {
    return { success: false, error: 'refused: invalid branch name' };
  }
  try {
    // Trailing `--` ensures git treats branchName as a ref, not an option.
    await runGit(projectPath, ['checkout', branchName, '--'], 10000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:createBranch', async (event, projectPath, branchName) => {
  if (!isSafeGitRefName(branchName)) {
    return { success: false, error: 'refused: invalid branch name' };
  }
  try {
    await runGit(projectPath, ['checkout', '-b', branchName, '--'], 10000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:aheadBehind', async (event, projectPath) => {
  try {
    const output = await runGit(projectPath, ['rev-list', '--count', '--left-right', 'HEAD...@{upstream}'], 5000);
    const parts = output.trim().split(/\s+/);
    return { ahead: parseInt(parts[0]) || 0, behind: parseInt(parts[1]) || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
});

ipcMain.handle('git:diff', async (event, projectPath, filePath, staged) => {
  try {
    const args = staged ? ['diff', '--cached', '--', filePath] : ['diff', '--', filePath];
    return await runGit(projectPath, args, 5000);
  } catch {
    // For untracked files, show full content as additions
    try {
      const content = await fs.promises.readFile(path.join(projectPath, filePath), 'utf8');
      return content.split('\n').map(line => '+' + line).join('\n');
    } catch {
      return '';
    }
  }
});

ipcMain.handle('git:graphLog', async (event, projectPath, count) => {
  try {
    const output = await runGit(projectPath, ['log', '--format=%H|%h|%P|%s|%an|%ar|%D', '-' + (count || 50), '--no-color'], 10000);
    return output.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('|');
      return {
        hash: parts[0],
        abbrev: parts[1],
        parents: parts[2] ? parts[2].split(' ').filter(Boolean) : [],
        message: parts[3],
        author: parts[4],
        relativeDate: parts[5],
        refs: parts[6] ? parts[6].split(',').map(r => r.trim()).filter(Boolean) : []
      };
    });
  } catch {
    return [];
  }
});

ipcMain.handle('git:stashList', async (event, projectPath) => {
  try {
    const output = await runGit(projectPath, ['stash', 'list', '--no-color'], 5000);
    return output.trim().split('\n').filter(Boolean).map((line, i) => {
      const match = line.match(/^stash@\{(\d+)\}:\s*(.*)$/);
      return match ? { index: parseInt(match[1]), message: match[2] } : { index: i, message: line };
    });
  } catch {
    return [];
  }
});

ipcMain.handle('git:stashPush', async (event, projectPath, message) => {
  try {
    const args = message ? ['stash', 'push', '-m', message] : ['stash', 'push'];
    await runGit(projectPath, args, 10000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:stashPop', async (event, projectPath) => {
  try {
    await runGit(projectPath, ['stash', 'pop'], 10000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:commitDetail', async (event, projectPath, hash) => {
  try {
    const [metaOutput, statOutput] = await Promise.all([
      runGit(projectPath, ['show', '--format=%H|%s|%an|%aI', '-s', hash, '--no-color'], 10000),
      runGit(projectPath, ['show', '--numstat', '--format=', hash, '--no-color'], 10000)
    ]);
    const meta = metaOutput.trim().split('|');
    const files = [];
    const statLines = statOutput.trim().split('\n').filter(Boolean);
    for (let i = 0; i < statLines.length; i++) {
      const parts = statLines[i].split('\t');
      if (parts.length >= 3) {
        files.push({
          file: parts[2],
          insertions: parts[0] === '-' ? 0 : parseInt(parts[0]) || 0,
          deletions: parts[1] === '-' ? 0 : parseInt(parts[1]) || 0
        });
      }
    }
    return { hash: meta[0], message: meta[1], author: meta[2], date: meta[3], files: files };
  } catch (err) {
    return { hash: hash, message: '', author: '', date: '', files: [], error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:diffCommit', async (event, projectPath, hash, filePath) => {
  try {
    const args = filePath
      ? ['show', '--pretty=format:', '-p', hash, '--', filePath]
      : ['show', '--pretty=format:', '-p', hash];
    const output = await runGit(projectPath, args, 10000);
    return output.replace(/^\n+/, '');
  } catch {
    return '';
  }
});

ipcMain.handle('git:diffStat', async (event, projectPath, staged) => {
  try {
    const args = staged ? ['diff', '--numstat', '--cached'] : ['diff', '--numstat'];
    const output = await runGit(projectPath, args, 5000);
    return output.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      return {
        insertions: parts[0] === '-' ? 0 : parseInt(parts[0]) || 0,
        deletions: parts[1] === '-' ? 0 : parseInt(parts[1]) || 0,
        file: parts[2]
      };
    });
  } catch {
    return [];
  }
});

function stripJsoncComments(text) {
  // Match strings first (preserve them), then strip // and /* */ comments
  return text.replace(/"(?:[^"\\]|\\.)*"|\/\/.*$|\/\*[\s\S]*?\*\//gm, function (match) {
    if (match.startsWith('"')) return match;
    return '';
  });
}

function parseJsonc(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  content = stripJsoncComments(content);
  content = content.replace(/,\s*([\]}])/g, '$1');
  return JSON.parse(content);
}

function findLaunchSettingsConfigs(projectPath) {
  const configs = [];
  function scanDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'bin' || entry.name === 'obj') continue;
        const subDir = path.join(dir, entry.name);
        const lsPath = path.join(subDir, 'Properties', 'launchSettings.json');
        try {
          const data = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
          if (!data.profiles) continue;
          // Scan for .csproj files in this directory
          const csprojFiles = [];
          try {
            const dirEntries = fs.readdirSync(subDir);
            for (const f of dirEntries) {
              if (f.endsWith('.csproj')) csprojFiles.push(f);
            }
          } catch { /* can't read dir */ }
          // If no .csproj found, fall back to directory name
          if (csprojFiles.length === 0) csprojFiles.push(null);
          for (const [profileName, profile] of Object.entries(data.profiles)) {
            if (profile.commandName === 'IISExpress') continue;
            for (const csproj of csprojFiles) {
              const name = csprojFiles.length > 1 && csproj
                ? profileName + ' (' + csproj + ')'
                : profileName;
              configs.push({
                name: name,
                type: 'dotnet-run',
                project: csproj ? path.join(subDir, csproj) : null,
                cwd: subDir,
                env: profile.environmentVariables || {},
                applicationUrl: profile.applicationUrl || '',
                commandLineArgs: profile.commandLineArgs || '',
                _source: 'launchSettings',
                _readonly: true
              });
            }
          }
        } catch { /* no launchSettings here, scan children */ }
        if (dir === projectPath) scanDir(subDir);
      }
    } catch { /* can't read dir */ }
  }
  scanDir(projectPath);
  return configs;
}

ipcMain.handle('launch:getConfigs', (event, projectPath) => {
  let configs = [];
  // VS Code launch.json
  const launchPath = path.join(projectPath, '.vscode', 'launch.json');
  try {
    const data = parseJsonc(launchPath);
    const vsConfigs = (data.configurations || []).map(c => Object.assign({}, c, { _source: 'launch.json', _readonly: true }));
    configs = configs.concat(vsConfigs);
  } catch { /* no launch.json or parse error */ }
  // .NET launchSettings.json
  configs = configs.concat(findLaunchSettingsConfigs(projectPath));
  // Custom configs from .claudes/launch.json
  const customPath = path.join(projectPath, '.claudes', 'launch.json');
  try {
    const customData = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    const customConfigs = (customData.configurations || []).map(c => Object.assign({}, c, { _source: 'custom', _readonly: false }));
    configs = configs.concat(customConfigs);
  } catch { /* no custom config or parse error */ }
  // Env profiles from .claudes/env-profiles.json
  let envProfiles = {};
  const profilesPath = path.join(projectPath, '.claudes', 'env-profiles.json');
  try {
    envProfiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  } catch { /* no profiles or parse error */ }
  // Recent launches
  let recentLaunches = [];
  const recentPath = path.join(projectPath, '.claudes', 'recent-launches.json');
  try {
    recentLaunches = JSON.parse(fs.readFileSync(recentPath, 'utf8'));
  } catch { /* no recent launches */ }
  return { configs, envProfiles, recentLaunches };
});

ipcMain.handle('launch:saveRecentLaunches', (event, projectPath, recentLaunches) => {
  try {
    const safeBase = assertInsideAllowedRoots(projectPath);
    const dirPath = path.join(safeBase, '.claudes');
    try { fs.mkdirSync(dirPath, { recursive: true }); } catch { /* exists */ }
    fs.writeFileSync(path.join(dirPath, 'recent-launches.json'), JSON.stringify(recentLaunches, null, 2), 'utf8');
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('launch:saveConfigs', (event, projectPath, configurations) => {
  try {
    const safeBase = assertInsideAllowedRoots(projectPath);
    const dirPath = path.join(safeBase, '.claudes');
    try { fs.mkdirSync(dirPath, { recursive: true }); } catch { /* exists */ }
    fs.writeFileSync(path.join(dirPath, 'launch.json'), JSON.stringify({ configurations }, null, 2), 'utf8');
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('launch:saveEnvProfiles', (event, projectPath, profiles) => {
  try {
    const safeBase = assertInsideAllowedRoots(projectPath);
    const dirPath = path.join(safeBase, '.claudes');
    try { fs.mkdirSync(dirPath, { recursive: true }); } catch { /* exists */ }
    fs.writeFileSync(path.join(dirPath, 'env-profiles.json'), JSON.stringify(profiles, null, 2), 'utf8');
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('launch:scanCsproj', (event, dirPath) => {
  try {
    const safe = assertInsideAllowedRoots(dirPath);
    return fs.readdirSync(safe).filter(f => f.endsWith('.csproj'));
  } catch { return []; }
});

ipcMain.handle('launch:browseFile', async (event, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || []
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('launch:readEnvFile', (event, filePath) => {
  try {
    const safe = assertInsideAllowedRoots(filePath);
    const content = fs.readFileSync(safe, 'utf8');
    const env = {};
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      let val = trimmed.substring(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
    return env;
  } catch { return {}; }
});

// --- Usage ---

const readline = require('readline');
const USAGE_CACHE_FILE = path.join(CONFIG_DIR, 'usage-cache.json');
const USAGE_PARSE_CONCURRENCY = 8;

function readUsageCache() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeUsageCache(cache) {
  try {
    ensureConfigDir();
    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch { /* ignore */ }
}

// Parse a single jsonl session file, streaming line by line and cheap-rejecting
// lines that don't carry usage/timestamp data before JSON.parse. Returns the
// per-session digest or null if the file has no assistant usage events.
function parseSessionFile(filePath) {
  return new Promise((resolve) => {
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
    let model = '';
    let firstTimestamp = null, lastTimestamp = null;
    let messageCount = 0;
    let lastTurn = null; // { input, output, cacheRead, cacheCreation, total }

    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    } catch {
      resolve(null);
      return;
    }
    stream.on('error', () => resolve(null));

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      // Most lines are tool calls / user prompts we don't aggregate from.
      // Skip the JSON.parse cost unless the line is plausibly relevant.
      const hasUsage = line.indexOf('"usage"') !== -1;
      const hasTimestamp = line.indexOf('"timestamp"') !== -1;
      if (!hasUsage && !hasTimestamp) return;

      let entry;
      try { entry = JSON.parse(line); } catch { return; }

      if (entry.type === 'assistant' && entry.message && entry.message.usage) {
        const u = entry.message.usage;
        const i = u.input_tokens || 0;
        const o = u.output_tokens || 0;
        const cr = u.cache_read_input_tokens || 0;
        const cc = u.cache_creation_input_tokens || 0;
        inputTokens += i;
        outputTokens += o;
        cacheReadTokens += cr;
        cacheCreationTokens += cc;
        if (!model && entry.message.model) model = entry.message.model;
        messageCount++;
        // Overwrite each turn — final value is the last assistant message's usage.
        lastTurn = {
          input: i,
          output: o,
          cacheRead: cr,
          cacheCreation: cc,
          total: i + o + cr + cc
        };
      }

      if (entry.timestamp) {
        const ts = typeof entry.timestamp === 'number' ? entry.timestamp : new Date(entry.timestamp).getTime();
        if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
        if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
      }
    });
    rl.on('close', () => {
      if (messageCount === 0) {
        resolve(null);
        return;
      }
      resolve({
        inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
        model, firstTimestamp, lastTimestamp, messageCount, lastTurn
      });
    });
    rl.on('error', () => resolve(null));
  });
}

// Run an async function with limited concurrency over an input array.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

// Plan-usage limits (Max/Pro plan: 5h session, 7d weekly, etc.). Calls the
// undocumented OAuth-authed endpoint that Claude Code's /usage uses, reading
// the bearer token from the CLI's credentials file. Cached briefly because the
// server-side data updates on its own cadence and we don't want to hammer it.
const PLAN_USAGE_CACHE_MS = 30_000;
let planUsageCache = { data: null, fetchedAt: 0 };

ipcMain.handle('usage:getPlanLimits', async (_event, force) => {
  const now = Date.now();
  if (!force && planUsageCache.data && (now - planUsageCache.fetchedAt) < PLAN_USAGE_CACHE_MS) {
    return { ok: true, data: planUsageCache.data, fetchedAt: planUsageCache.fetchedAt, cached: true };
  }

  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  let token;
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    token = creds?.claudeAiOauth?.accessToken;
  } catch {
    return { ok: false, error: 'no-creds', message: 'Could not read ~/.claude/.credentials.json — Claude Code not logged in?' };
  }
  if (!token) {
    return { ok: false, error: 'no-oauth', message: 'No OAuth token found (API-key users do not have plan limits).' };
  }

  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20'
      }
    });
    if (res.status === 401) {
      return { ok: false, error: 'unauthorized', message: 'OAuth token expired. Run any Claude Code command to refresh.' };
    }
    if (!res.ok) {
      return { ok: false, error: 'http-' + res.status, message: 'Usage endpoint returned HTTP ' + res.status };
    }
    const data = await res.json();
    planUsageCache = { data, fetchedAt: now };
    return { ok: true, data, fetchedAt: now, cached: false };
  } catch (e) {
    return { ok: false, error: 'fetch-failed', message: e.message };
  }
});

ipcMain.handle('usage:detectThresholdCrossings', (_event, prev, next) => {
  try { return detectPlanLimitCrossings(prev, next); } catch { return []; }
});

const { fuzzyRank } = require('./lib/fuzzy-rank');
ipcMain.handle('palette:rank', (_event, items, query) => fuzzyRank(items, query, x => x.label));

const { lastAssistantContextTokens, modelContextLimit } = require('./lib/session-context-tokens');

// One-shot read of the live context-token count for a session.
// Renderer calls this every ~10s while a Claude column is live.
ipcMain.handle('session:contextTokens', (_event, projectPath, sessionId, sinceMs) => {
  if (!projectPath || !sessionId) return null;
  // projectPath is the renderer's projectKey, which is the raw filesystem path
  // (e.g. "D:\\Git Repos\\Claudes"). Claude stores sessions under the encoded
  // form (e.g. "D--Git-Repos-Claudes"), so we must encode before joining.
  const claudeKey = projectPathToClaudeKey(projectPath);
  const filePath = path.join(os.homedir(), '.claude', 'projects', claudeKey, sessionId + '.jsonl');
  return lastAssistantContextTokens(filePath, sinceMs);
});

ipcMain.handle('session:modelContextLimit', (_event, model) => modelContextLimit(model));

ipcMain.handle('notify:show', (_event, opts) => {
  try {
    if (!opts || typeof opts !== 'object') return false;
    if (!Notification.isSupported()) return false;
    const notif = new Notification({ title: opts.title || 'Claudes', body: opts.body || '' });
    notif.show();
    return true;
  } catch { return false; }
});

ipcMain.handle('usage:getAll', async () => {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  const results = [];
  const cache = readUsageCache();
  const nextCache = {};

  let projectDirs;
  try {
    projectDirs = await fs.promises.readdir(claudeProjectsDir);
  } catch {
    return results;
  }

  // Enumerate all jsonl files up front so we can parse in parallel.
  const jobs = [];
  for (const dir of projectDirs) {
    const projectDir = path.join(claudeProjectsDir, dir);
    let dirStat;
    try { dirStat = await fs.promises.stat(projectDir); } catch { continue; }
    if (!dirStat.isDirectory()) continue;

    let entries;
    try { entries = await fs.promises.readdir(projectDir); } catch { continue; }

    for (const file of entries) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, file);
      let fileStat;
      try { fileStat = await fs.promises.stat(filePath); } catch { continue; }
      const sessionId = file.replace('.jsonl', '');
      jobs.push({
        cacheKey: dir + '/' + sessionId,
        projectKey: dir,
        sessionId,
        filePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs
      });
    }
  }

  const parsed = await mapLimit(jobs, USAGE_PARSE_CONCURRENCY, async (job) => {
    const cached = cache[job.cacheKey];
    if (cached && cached.mtimeMs === job.mtimeMs && cached.size === job.size) {
      return { job, digest: cached };
    }
    const digest = await parseSessionFile(job.filePath);
    if (!digest) return { job, digest: null };
    return {
      job,
      digest: Object.assign({ mtimeMs: job.mtimeMs, size: job.size }, digest)
    };
  });

  for (const { job, digest } of parsed) {
    if (!digest) continue;
    nextCache[job.cacheKey] = digest;
    results.push({
      projectKey: job.projectKey,
      sessionId: job.sessionId,
      model: digest.model,
      inputTokens: digest.inputTokens,
      outputTokens: digest.outputTokens,
      cacheReadTokens: digest.cacheReadTokens,
      cacheCreationTokens: digest.cacheCreationTokens,
      messageCount: digest.messageCount,
      firstTimestamp: digest.firstTimestamp,
      lastTimestamp: digest.lastTimestamp,
      lastTurn: digest.lastTurn,
      fileSize: digest.size,
      modified: digest.mtimeMs
    });
  }

  writeUsageCache(nextCache);
  global.__lastUsageDigest = results;
  return results;
});

const { sessionCost: calcSessionCost } = require('./lib/cost-calc');

// Roll up per-session costs into totals by model, project, and day.
// Uses the digest cached by usage:getAll (call usage:getAll first; otherwise
// returns zeros). Costs are computed from each session's single `model` plus
// its aggregate token counts — see plan note about multi-model sessions.
function rollupCosts(digests, sinceMs) {
  const byModel = { opus: 0, sonnet: 0, haiku: 0, unknown: 0 };
  const byProject = {};
  const byDay = {};
  // Per-bucket breakdown so the user can see *where* the cost is coming from
  // (cache reads on long sessions are usually the dominant chunk).
  const byBucket = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  let total = 0;
  if (!Array.isArray(digests)) return { total, byModel, byProject, byDay, byBucket };
  for (const d of digests) {
    if (!d) continue;
    if (sinceMs && d.lastTimestamp && d.lastTimestamp < sinceMs) continue;
    const inp = d.inputTokens || 0;
    const cc = d.cacheCreationTokens || 0;
    const cr = d.cacheReadTokens || 0;
    const out = d.outputTokens || 0;
    const c = calcSessionCost({ model: d.model || '', input: inp, cacheCreation: cc, cacheRead: cr, output: out });
    if (!c) continue;
    // Per-bucket breakdown reuses the same calc (zero out the others) so the
    // pieces always add up to the total — no risk of drift from a separate
    // pricing path.
    byBucket.input         += calcSessionCost({ model: d.model || '', input: inp });
    byBucket.cacheCreation += calcSessionCost({ model: d.model || '', cacheCreation: cc });
    byBucket.cacheRead     += calcSessionCost({ model: d.model || '', cacheRead: cr });
    byBucket.output        += calcSessionCost({ model: d.model || '', output: out });
    total += c;
    const m = String(d.model || '').toLowerCase();
    if (m.indexOf('opus') !== -1) byModel.opus += c;
    else if (m.indexOf('sonnet') !== -1) byModel.sonnet += c;
    else if (m.indexOf('haiku') !== -1) byModel.haiku += c;
    else byModel.unknown += c;
    if (d.projectKey) byProject[d.projectKey] = (byProject[d.projectKey] || 0) + c;
    if (d.lastTimestamp) {
      const day = new Date(d.lastTimestamp).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + c;
    }
  }
  return { total, byModel, byProject, byDay, byBucket };
}

ipcMain.handle('usage:getCosts', async (_event, filter) => {
  const now = Date.now();
  let sinceMs = null;
  if (filter === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    sinceMs = start.getTime();
  } else if (filter === '7d') {
    sinceMs = now - 7 * 24 * 60 * 60 * 1000;
  } else if (filter === '30d') {
    sinceMs = now - 30 * 24 * 60 * 60 * 1000;
  }
  return rollupCosts(global.__lastUsageDigest || [], sinceMs);
});

// Full-text search across all session JSONLs. Streaming-style: returns first
// `limit` hits with surrounding context. Case-insensitive substring match
// (no regex for V1).
ipcMain.handle('sessions:search', async (_event, query, limit, projectPath) => {
  if (!query || typeof query !== 'string' || query.length < 2) return [];
  const max = Math.max(1, Math.min(200, limit || 50));
  const needle = query.toLowerCase();
  const root = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs;
  if (projectPath && typeof projectPath === 'string') {
    // Scope: current project only — restrict the scan to a single dir.
    const onlyDir = projectPathToClaudeKey(projectPath);
    try {
      const stat = await fs.promises.stat(path.join(root, onlyDir));
      if (!stat.isDirectory()) return [];
    } catch { return []; }
    projectDirs = [onlyDir];
  } else {
    try { projectDirs = await fs.promises.readdir(root); } catch { return []; }
  }

  // Extract the user/assistant message text from a parsed JSONL entry, or null
  // if the entry isn't a content-bearing message (tool calls, system events,
  // file metadata, etc.). We only want hits that match real conversation text,
  // not tool inputs or paths.
  function extractMessageText(obj) {
    if (!obj || !obj.message || !obj.message.content) return null;
    if (obj.type !== 'user' && obj.type !== 'assistant') return null;
    const c = obj.message.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      // Assistant messages may interleave text + tool_use parts; we only want text.
      return c.map(p => (p && typeof p.text === 'string') ? p.text : '').join(' ');
    }
    return null;
  }

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
      // Cheap pre-filter: skip files where the needle doesn't appear at all.
      if (content.toLowerCase().indexOf(needle) === -1) continue;

      // Walk lines; first line whose extracted message-text contains the needle is the hit.
      const lines = content.split('\n');
      let matched = null;
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (!line || line[0] !== '{') continue;
        if (line.toLowerCase().indexOf(needle) === -1) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const text = extractMessageText(obj);
        if (!text) continue;
        if (text.toLowerCase().indexOf(needle) === -1) continue;
        matched = { text, lineIndex: li };
        break;
      }
      if (!matched) continue;  // matches were only in tool inputs / metadata — skip the file

      // Trim to ~200 chars around the needle for display
      const text = matched.text;
      const matchInText = text.toLowerCase().indexOf(needle);
      const start = Math.max(0, matchInText - 80);
      const end = Math.min(text.length, matchInText + 120);
      const trimmed = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');

      hits.push({
        projectKey: dir,
        sessionId: file.replace('.jsonl', ''),
        snippet: trimmed,
        matchedAt: matched.lineIndex
      });
      if (hits.length >= max) break outer;
    }
  }
  return hits;
});

// Prompt-history search across ~/.claude/history.jsonl. Returns hits in
// reverse-chronological order (most recent first). Distinct from sessions:search
// — that one searches assistant transcripts; this one searches user prompts.
ipcMain.handle('history:search', async (_event, query, limit, projectPath) => {
  if (!query || typeof query !== 'string' || query.length < 2) return [];
  const max = Math.max(1, Math.min(200, limit || 100));
  const file = path.join(os.homedir(), '.claude', 'history.jsonl');
  let content;
  try { content = await fs.promises.readFile(file, 'utf8'); } catch { return []; }
  const needle = query.toLowerCase();
  // history.jsonl stores `entry.project` as the raw filesystem path. Compare
  // raw-to-raw to keep the path-shape contract identical to what the entry
  // already uses, avoiding any double-encoding mismatch.
  const scopedProject = (projectPath && typeof projectPath === 'string') ? projectPath : null;
  const lines = content.split('\n');
  const hits = [];
  for (let i = lines.length - 1; i >= 0 && hits.length < max; i--) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    if (line.toLowerCase().indexOf(needle) === -1) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (scopedProject && (entry.project || '') !== scopedProject) continue;
    const text = entry.display || '';
    if (!text) continue;
    if (text.toLowerCase().indexOf(needle) === -1) continue;
    // Trim to ~200 chars around the needle
    const matchIdx = text.toLowerCase().indexOf(needle);
    const start = Math.max(0, matchIdx - 80);
    const end = Math.min(text.length, matchIdx + 120);
    const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    hits.push({
      text,
      snippet,
      project: entry.project || '',
      ts: entry.timestamp || null
    });
  }
  return hits;
});

// --- Auto Updater ---

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function setupAutoUpdater() {
  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes || ''
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update:downloaded', {
      version: info.version,
      releaseNotes: info.releaseNotes || ''
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update:progress', { percent: progress.percent });
  });

  autoUpdater.on('error', (err) => {
    console.error('[auto-updater]', err.message);
    mainWindow?.webContents.send('update:error', { message: err.message });
  });

  autoUpdater.checkForUpdatesAndNotify();
}

ipcMain.handle('update:install', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

ipcMain.handle('clipboard:readText', () => {
  return clipboard.readText();
});

ipcMain.handle('clipboard:writeText', (event, text) => {
  clipboard.writeText(text);
});

ipcMain.handle('theme:getOsDark', () => {
  return nativeTheme.shouldUseDarkColors;
});

ipcMain.handle('claude:getConfigPath', () => {
  return path.join(os.homedir(), '.claude', 'settings.json');
});

// --- Hook Server ---

function startHookServer() {
  hookServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/hook') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const event = JSON.parse(body);
          mainWindow?.webContents.send('hook:event', event);
        } catch {}
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  hookServer.on('error', (err) => {
    console.error('[hook-server] listen error:', err.message);
  });
  hookServer.listen(hookServerListenPort, '127.0.0.1', () => {
    hookServerPort = hookServerListenPort;
    console.log('[hook-server] listening on port', hookServerPort);
    // Self-heal: if the user's settings.json already has our sentinel entries
    // pointing at a different port (e.g. dev↔packaged switch), rewrite them to
    // the current port so they don't have to disconnect+reconnect every launch.
    try { syncHookPortInSettings(hookServerListenPort); } catch (err) {
      console.error('[hook-server] failed to sync port in settings.json:', err && err.message);
    }
  });
}

function syncHookPortInSettings(port) {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(file)) return;  // no settings = nothing to sync
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return; }  // malformed — leave alone
  if (!data || !data.hooks) return;
  const wanted = buildHookCommand(port);
  let changed = 0;
  for (const ev of Object.keys(data.hooks)) {
    const groups = data.hooks[ev];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || g.matcher !== CLAUDES_HOOK_SENTINEL) continue;
      if (!Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (h && h.type === 'command' && typeof h.command === 'string' && h.command !== wanted) {
          h.command = wanted;
          changed++;
        }
      }
    }
  }
  if (changed > 0) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    console.log('[hook-server] re-pointed', changed, 'sentinel hook(s) to port', port);
  }
}

ipcMain.handle('hooks:getPort', () => hookServerPort);

const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit',
  'Stop', 'SubagentStop', 'Notification',
  'SessionStart', 'SessionEnd', 'PreCompact'
];

// Sentinel matcher we use to identify our hook entries on subsequent calls.
const CLAUDES_HOOK_SENTINEL = '__claudes_inspector__';

function buildHookCommand(port) {
  // Cross-platform curl invocation. curl ships with Windows 10+, macOS, and
  // every Linux distro this app runs on. -d @- reads stdin. The double-quoted
  // header value is parsed identically by cmd.exe and POSIX shells.
  return 'curl -s -X POST http://127.0.0.1:' + port + '/hook -d @- -H "Content-Type: application/json"';
}

function readClaudeSettings() {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { file, data: JSON.parse(raw) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { file, data: {} };
    throw err;
  }
}

function writeClaudeSettings(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

ipcMain.handle('hooks:isConfigured', () => {
  try {
    const { data } = readClaudeSettings();
    if (!data || !data.hooks) return false;
    // Detect any of our entries by matcher sentinel.
    for (const ev of HOOK_EVENTS) {
      const groups = data.hooks[ev];
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (g && g.matcher === CLAUDES_HOOK_SENTINEL) return true;
      }
    }
    return false;
  } catch { return false; }
});

ipcMain.handle('hooks:configure', () => {
  try {
    const { file, data } = readClaudeSettings();
    // Backup the current file (always — even if data was empty, mark the moment).
    try {
      const backupPath = file + '.claudes-bak.' + Date.now();
      const exists = fs.existsSync(file);
      if (exists) fs.copyFileSync(file, backupPath);
    } catch { /* backup is best-effort */ }

    if (!data.hooks) data.hooks = {};
    const command = buildHookCommand(hookServerListenPort);
    let added = 0;
    for (const ev of HOOK_EVENTS) {
      if (!Array.isArray(data.hooks[ev])) data.hooks[ev] = [];
      // Skip if our sentinel entry already exists for this event.
      const already = data.hooks[ev].some((g) => g && g.matcher === CLAUDES_HOOK_SENTINEL);
      if (already) continue;
      data.hooks[ev].push({
        matcher: CLAUDES_HOOK_SENTINEL,
        hooks: [{ type: 'command', command }]
      });
      added++;
    }
    writeClaudeSettings(file, data);
    return { ok: true, added, port: hookServerListenPort };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('hooks:disconnect', () => {
  try {
    const { file, data } = readClaudeSettings();
    if (!data || !data.hooks) return { ok: true, removed: 0 };
    let removed = 0;
    for (const ev of HOOK_EVENTS) {
      const groups = data.hooks[ev];
      if (!Array.isArray(groups)) continue;
      const filtered = groups.filter((g) => {
        if (g && g.matcher === CLAUDES_HOOK_SENTINEL) { removed++; return false; }
        return true;
      });
      data.hooks[ev] = filtered;
      // Drop the array entirely if it became empty (keeps settings.json tidy).
      if (data.hooks[ev].length === 0) delete data.hooks[ev];
    }
    if (Object.keys(data.hooks).length === 0) delete data.hooks;
    writeClaudeSettings(file, data);
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
ipcMain.handle('pty:getPort', () => ptyPort);
ipcMain.handle('pty:getAuthToken', () => PTY_AUTH_TOKEN);

ipcMain.handle('window:flashFrame', () => {
  if (mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
});

ipcMain.handle('window:stopFlashFrame', () => {
  if (mainWindow && mainWindow.isFocused()) {
    mainWindow.flashFrame(false);
  }
});

// Allow only navigable web schemes through openExternal. Without this filter
// a renderer compromise (XSS, malicious markdown, etc.) could trigger
// file://, vscode://, ms-msdt:, and similar handlers that lead to local
// code execution (Follina-class).
const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
ipcMain.handle('shell:openExternal', (event, url) => {
  try {
    const parsed = new URL(String(url));
    if (!SAFE_EXTERNAL_SCHEMES.has(parsed.protocol)) {
      console.warn('[shell:openExternal] refused scheme:', parsed.protocol);
      return Promise.reject(new Error('refused: unsupported URL scheme'));
    }
    return shell.openExternal(parsed.toString());
  } catch (err) {
    console.warn('[shell:openExternal] invalid URL:', err.message);
    return Promise.reject(new Error('refused: invalid URL'));
  }
});

ipcMain.handle('shell:showItemInFolder', (event, fullPath) => {
  shell.showItemInFolder(fullPath);
});

// Refuse the OS handler-launch surface for executable file types and UNC
// paths. shell.openPath happily runs .bat / .lnk / .scr / .hta etc. with the
// user's privileges; combined with any renderer XSS that becomes RCE.
const UNSAFE_OPENPATH_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.hta', '.pif', '.msi', '.msp',
  '.lnk', '.url', '.vbs', '.vbe', '.js', '.jse', '.ws', '.wsf', '.wsh',
  '.ps1', '.psm1', '.cpl', '.reg', '.jar', '.dll', '.app'
]);
ipcMain.handle('shell:openPath', (event, fullPath) => {
  const p = String(fullPath || '');
  if (!p) return Promise.resolve('refused: empty path');
  // Block UNC paths — they can trigger DLL search-order hijacks and cross
  // a network trust boundary in a way the user never asked for.
  if (/^\\\\/.test(p) || /^\/\//.test(p)) {
    console.warn('[shell:openPath] refused UNC:', p);
    return Promise.resolve('refused: UNC path');
  }
  const ext = path.extname(p).toLowerCase();
  if (UNSAFE_OPENPATH_EXTS.has(ext)) {
    console.warn('[shell:openPath] refused exec extension:', ext);
    return Promise.resolve('refused: executable extension');
  }
  return shell.openPath(p);
});

// --- Automations IPC Handlers ---

ipcMain.handle('automations:getAll', () => {
  return readAutomations();
});

ipcMain.handle('automations:getForProject', (event, projectPath) => {
  const data = readAutomations();
  const normalized = projectPath.replace(/\\/g, '/');
  return data.automations.filter(a => a.projectPath.replace(/\\/g, '/') === normalized);
});

ipcMain.handle('automations:create', (event, config) => {
  const data = readAutomations();
  const automationId = generateAutomationId();

  // First pass: generate real IDs and build a mapping from temp IDs
  const idMap = {};
  const agents = (config.agents || []).map((agentConfig, idx) => {
    const newId = generateAgentId();
    // Map temp_N references to the real ID
    idMap['temp_' + idx] = newId;
    if (agentConfig.id) idMap[agentConfig.id] = newId;
    return Object.assign({
      id: newId,
      runMode: 'independent',
      runAfter: [],
      runOnUpstreamFailure: false,
      passUpstreamContext: false,
      isolation: { enabled: false, clonePath: null },
      enabled: true,
      skipPermissions: false,
      firstStartOnly: false,
      dbConnectionString: null,
      dbReadOnly: true,
      lastRunAt: null,
      lastRunStatus: null,
      lastError: null,
      lastSummary: null,
      lastAttentionItems: null,
      currentRunStartedAt: null
    }, agentConfig, { id: newId });
  });

  // Second pass: remap runAfter references from temp IDs to real IDs
  agents.forEach(agent => {
    if (agent.runAfter && agent.runAfter.length > 0) {
      agent.runAfter = agent.runAfter.map(ref => idMap[ref] || ref);
    }
  });

  const automation = {
    id: automationId,
    name: config.name,
    projectPath: config.projectPath,
    agents: agents,
    enabled: true,
    createdAt: new Date().toISOString(),
    runWindow: config.runWindow || null
  };

  data.automations.push(automation);
  writeAutomations(data);
  return automation;
});

ipcMain.handle('automations:update', (event, automationId, updates) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return null;
  const safeFields = ['name', 'enabled', 'manager', 'runWindow'];
  safeFields.forEach(field => {
    if (updates[field] !== undefined) automation[field] = updates[field];
  });
  writeAutomations(data);
  return automation;
});

ipcMain.handle('automations:updateAgent', (event, automationId, agentId, updates) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return null;
  const agent = automation.agents.find(ag => ag.id === agentId);
  if (!agent) return null;
  const safeFields = ['name', 'prompt', 'schedule', 'runMode', 'runAfter', 'runOnUpstreamFailure',
    'passUpstreamContext', 'isolation', 'enabled', 'skipPermissions', 'firstStartOnly', 'dbConnectionString', 'dbReadOnly',
    'endpointId', 'endpointModel'];
  safeFields.forEach(field => {
    if (updates[field] !== undefined) agent[field] = updates[field];
  });
  writeAutomations(data);
  return agent;
});

ipcMain.handle('automations:addAgent', (event, automationId, agentConfig) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return null;
  const agent = Object.assign({
    id: generateAgentId(),
    runMode: 'independent',
    runAfter: [],
    runOnUpstreamFailure: false,
    passUpstreamContext: false,
    isolation: { enabled: false, clonePath: null },
    enabled: true,
    skipPermissions: false,
    firstStartOnly: false,
    dbConnectionString: null,
    dbReadOnly: true,
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    lastSummary: null,
    lastAttentionItems: null,
    currentRunStartedAt: null
  }, agentConfig);
  automation.agents.push(agent);
  writeAutomations(data);
  return agent;
});

ipcMain.handle('automations:removeAgent', (event, automationId, agentId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return null;
  const agent = automation.agents.find(ag => ag.id === agentId);
  if (!agent) return { removed: false };

  // Clean up clone directory if isolated
  if (agent.isolation && agent.isolation.enabled && agent.isolation.clonePath) {
    try { fs.rmSync(agent.isolation.clonePath, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Clean up run history
  const runDir = path.join(AUTOMATIONS_RUNS_DIR, automationId, agentId);
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // Remove references from other agents' runAfter arrays
  automation.agents.forEach(ag => {
    if (ag.runAfter) {
      ag.runAfter = ag.runAfter.filter(id => id !== agentId);
      if (ag.runAfter.length === 0 && ag.runMode === 'run_after') {
        ag.runMode = 'independent';
      }
    }
  });

  automation.agents = automation.agents.filter(ag => ag.id !== agentId);
  writeAutomations(data);
  return { removed: true };
});

ipcMain.handle('automations:delete', (event, automationId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (automation) {
    automation.agents.forEach(agent => {
      if (agent.isolation && agent.isolation.enabled && agent.isolation.clonePath) {
        try { fs.rmSync(agent.isolation.clonePath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  }
  data.automations = data.automations.filter(a => a.id !== automationId);
  writeAutomations(data);
  const runDir = path.join(AUTOMATIONS_RUNS_DIR, automationId);
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return true;
});

ipcMain.handle('automations:deleteAllForProject', (event, projectPath) => {
  const data = readAutomations();
  const normalized = projectPath.replace(/\\/g, '/');
  const toDelete = data.automations.filter(a => a.projectPath.replace(/\\/g, '/') === normalized);

  // Clean up clone directories and run history
  toDelete.forEach(automation => {
    automation.agents.forEach(agent => {
      if (agent.isolation && agent.isolation.enabled && agent.isolation.clonePath) {
        try { fs.rmSync(agent.isolation.clonePath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
    if (automation.manager && automation.manager.isolation && automation.manager.isolation.clonePath) {
      try { fs.rmSync(automation.manager.isolation.clonePath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    const runDir = path.join(AUTOMATIONS_RUNS_DIR, automation.id);
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  data.automations = data.automations.filter(a => a.projectPath.replace(/\\/g, '/') !== normalized);
  writeAutomations(data);
  return { deleted: toDelete.length };
});

ipcMain.handle('automations:toggle', (event, automationId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return null;
  automation.enabled = !automation.enabled;
  if (automation.enabled) {
    automation.agents.forEach(ag => { ag.lastError = null; });
  }
  writeAutomations(data);
  return automation;
});

ipcMain.handle('automations:toggleAgent', (event, automationId, agentId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return null;
  const agent = automation.agents.find(ag => ag.id === agentId);
  if (!agent) return null;
  agent.enabled = !agent.enabled;
  if (agent.enabled) agent.lastError = null;
  writeAutomations(data);
  return agent;
});

ipcMain.handle('automations:setAllEnabled', (event, projectPath, enabled) => {
  const data = readAutomations();
  const normalized = projectPath.replace(/\\/g, '/');
  let count = 0;
  data.automations.forEach(a => {
    if (a.projectPath.replace(/\\/g, '/') === normalized) {
      a.enabled = enabled;
      if (enabled) a.agents.forEach(ag => { ag.lastError = null; });
      count++;
    }
  });
  writeAutomations(data);
  return { count };
});

ipcMain.handle('automations:toggleGlobal', () => {
  const data = readAutomations();
  data.globalEnabled = !data.globalEnabled;
  writeAutomations(data);
  return data.globalEnabled;
});

ipcMain.handle('automations:getAgentHistory', (event, automationId, agentId, count) => {
  return getAgentHistory(automationId, agentId, count);
});

ipcMain.handle('automations:getAgentRunDetail', (event, automationId, agentId, startedAt) => {
  const dir = path.join(AUTOMATIONS_RUNS_DIR, automationId, agentId);
  try {
    const filename = new Date(startedAt).toISOString().replace(/[:.]/g, '-') + '.json';
    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    // Fallback: search by startedAt field
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (data.startedAt === startedAt) return data;
    }
  } catch { /* ignore */ }
  return null;
});

ipcMain.handle('automations:getAgentLiveOutput', (event, automationId, agentId) => {
  const key = automationId + ':' + agentId;
  const liveChunks = agentLiveOutputBuffers.get(key);
  if (liveChunks) return liveChunks.join('');
  return null;
});

ipcMain.handle('automations:runAgentNow', async (event, automationId, agentId) => {
  try {
    await runAgent(automationId, agentId);
  } catch (err) {
    // Ensure currentRunStartedAt is cleared if runAgent threw unexpectedly
    try {
      const data = readAutomations();
      const auto = data.automations.find(a => a.id === automationId);
      if (auto) {
        const ag = auto.agents.find(a => a.id === agentId);
        if (ag && ag.currentRunStartedAt) {
          ag.currentRunStartedAt = null;
          ag.lastRunStatus = 'error';
          ag.lastError = err.message || 'Unexpected error starting agent';
          writeAutomations(data);
        }
      }
    } catch { /* avoid double-fault */ }
    const key = automationId + ':' + agentId;
    runningAgents.delete(key);
    if (mainWindow) mainWindow.webContents.send('automations:agent-completed', {
      automationId, agentId, status: 'error', error: err.message || 'Unexpected error starting agent'
    });
  }
  return true;
});

ipcMain.handle('automations:runAutomationNow', async (event, automationId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return false;
  // Run all independent agents — dependents will cascade
  const promises = [];
  automation.agents.forEach(agent => {
    if (agent.enabled && agent.runMode === 'independent') {
      promises.push(runAgent(automation.id, agent.id).catch(() => {}));
    }
  });
  await Promise.all(promises);
  return true;
});

function safeRemoveDir(dirPath) {
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', dirPath], { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
    } else {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch { /* ignore — directory may be partially removed or locked */ }
}

ipcMain.handle('automations:setupAgentClone', async (event, automationId, agentId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return { error: 'Automation not found' };
  const agent = automation.agents.find(ag => ag.id === agentId);
  if (!agent) return { error: 'Agent not found' };
  if (!agent.isolation || !agent.isolation.enabled) return { error: 'Agent does not have isolation enabled' };

  // Determine clone path
  const baseDir = data.agentReposBaseDir || AGENTS_DIR_DEFAULT;
  const projectName = automation.projectPath.split(/[/\\]/).pop();
  const agentDirName = agent.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const clonePath = path.join(baseDir, projectName, agentDirName);

  // Check if clone already exists with correct remote
  if (fs.existsSync(clonePath)) {
    try {
      const existingRemote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: clonePath, encoding: 'utf8' }).trim();
      let sourceRemote = '';
      try {
        sourceRemote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: automation.projectPath, encoding: 'utf8' }).trim();
      } catch { /* no remote */ }
      if (existingRemote === sourceRemote || existingRemote === automation.projectPath) {
        agent.isolation.clonePath = clonePath;
        writeAutomations(data);
        return { clonePath, status: 'reused' };
      }
      // Different remote — clean up and re-clone
      safeRemoveDir(clonePath);
    } catch {
      // Not a valid git repo — clean up and re-clone
      safeRemoveDir(clonePath);
    }
  }

  // Get remote URL from project
  let remoteUrl = '';
  try {
    remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: automation.projectPath, encoding: 'utf8' }).trim();
  } catch {
    remoteUrl = automation.projectPath;
    if (mainWindow) mainWindow.webContents.send('automations:clone-progress', {
      automationId, agentId, line: 'WARNING: No git remote configured. Cloning from local path.\n'
    });
  }

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(clonePath), { recursive: true });

  // Clone
  return new Promise((resolve) => {
    // Trailing `--` between flags and positional args defends against the
    // "remote URL begins with --upload-pack=..." class of git CVEs where a
    // repo's saved remote URL is parsed as a git option.
    const child = spawn('git', ['clone', '--', remoteUrl, clonePath], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (chunk) => {
      if (mainWindow) mainWindow.webContents.send('automations:clone-progress', {
        automationId, agentId, line: chunk.toString()
      });
    });
    child.stderr.on('data', (chunk) => {
      if (mainWindow) mainWindow.webContents.send('automations:clone-progress', {
        automationId, agentId, line: chunk.toString()
      });
    });

    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        const freshData = readAutomations();
        const freshAuto = freshData.automations.find(a => a.id === automationId);
        if (freshAuto) {
          const freshAgent = freshAuto.agents.find(ag => ag.id === agentId);
          if (freshAgent) {
            freshAgent.isolation.clonePath = clonePath;
            writeAutomations(freshData);
          }
        }
        resolve({ clonePath, status: 'cloned' });
      } else {
        resolve({ error: 'git clone failed with exit code ' + exitCode });
      }
    });

    child.on('error', (err) => {
      resolve({ error: 'git clone error: ' + err.message });
    });
  });
});

ipcMain.handle('automations:getCloneStatus', (event, automationId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return {};
  const status = {};
  automation.agents.forEach(agent => {
    if (agent.isolation && agent.isolation.enabled) {
      if (agent.isolation.clonePath && fs.existsSync(agent.isolation.clonePath)) {
        status[agent.id] = 'ready';
      } else if (agent.isolation.clonePath) {
        status[agent.id] = 'missing';
      } else {
        status[agent.id] = 'pending';
      }
    } else {
      status[agent.id] = 'not-isolated';
    }
  });
  return status;
});

ipcMain.handle('automations:export', (event, projectPath) => {
  const data = readAutomations();
  const normalized = projectPath.replace(/\\/g, '/');
  const automations = data.automations
    .filter(a => a.projectPath.replace(/\\/g, '/') === normalized)
    .map(a => {
      const exported = {
        name: a.name,
        agents: a.agents.map(ag => {
          // Convert runAfter IDs to agent names for portability
          const runAfterNames = (ag.runAfter || []).map(id => {
            const upstream = a.agents.find(other => other.id === id);
            return upstream ? upstream.name : id;
          });
          return {
            name: ag.name, prompt: ag.prompt, schedule: ag.schedule,
            runMode: ag.runMode, runAfter: runAfterNames, runOnUpstreamFailure: ag.runOnUpstreamFailure,
            passUpstreamContext: ag.passUpstreamContext || false,
            isolation: { enabled: ag.isolation ? ag.isolation.enabled : false },
            skipPermissions: ag.skipPermissions || false, firstStartOnly: ag.firstStartOnly || false,
            dbConnectionString: ag.dbConnectionString || null, dbReadOnly: ag.dbReadOnly !== false
          };
        })
      };
      if (a.manager && a.manager.enabled) {
        exported.manager = {
          enabled: true,
          prompt: a.manager.prompt || '',
          triggerOn: a.manager.triggerOn || 'failure',
          includeFullOutput: a.manager.includeFullOutput || false,
          skipPermissions: a.manager.skipPermissions || false,
          dbConnectionString: a.manager.dbConnectionString || null,
          dbReadOnly: a.manager.dbReadOnly !== false,
          isolation: { enabled: a.manager.isolation ? a.manager.isolation.enabled : false },
          maxRetries: a.manager.maxRetries || 1
        };
      }
      return exported;
    });
  if (automations.length === 0) return { cancelled: true };
  const result = dialog.showSaveDialogSync(mainWindow, {
    title: 'Export Automations',
    defaultPath: 'automations-export.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!result) return { cancelled: true };
  const payload = { exportedAt: new Date().toISOString(), source: projectPath, automations };
  fs.writeFileSync(result, JSON.stringify(payload, null, 2), 'utf8');
  return { path: result, count: automations.length };
});

ipcMain.handle('automations:exportOne', (event, automationId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return { cancelled: true };
  const exported = {
    name: automation.name,
    agents: automation.agents.map(ag => {
      const runAfterNames = (ag.runAfter || []).map(id => {
        const upstream = automation.agents.find(other => other.id === id);
        return upstream ? upstream.name : id;
      });
      return {
        name: ag.name, prompt: ag.prompt, schedule: ag.schedule,
        runMode: ag.runMode, runAfter: runAfterNames, runOnUpstreamFailure: ag.runOnUpstreamFailure,
        passUpstreamContext: ag.passUpstreamContext || false,
        isolation: { enabled: ag.isolation ? ag.isolation.enabled : false },
        skipPermissions: ag.skipPermissions || false, firstStartOnly: ag.firstStartOnly || false,
        dbConnectionString: ag.dbConnectionString || null, dbReadOnly: ag.dbReadOnly !== false
      };
    })
  };
  if (automation.manager && automation.manager.enabled) {
    exported.manager = {
      enabled: true,
      prompt: automation.manager.prompt || '',
      triggerOn: automation.manager.triggerOn || 'failure',
      includeFullOutput: automation.manager.includeFullOutput || false,
      skipPermissions: automation.manager.skipPermissions || false,
      dbConnectionString: automation.manager.dbConnectionString || null,
      dbReadOnly: automation.manager.dbReadOnly !== false,
      isolation: { enabled: automation.manager.isolation ? automation.manager.isolation.enabled : false },
      maxRetries: automation.manager.maxRetries || 1
    };
  }
  const safeName = automation.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const result = dialog.showSaveDialogSync(mainWindow, {
    title: 'Export Automation',
    defaultPath: 'automation-' + safeName + '.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!result) return { cancelled: true };
  const payload = { exportedAt: new Date().toISOString(), automations: [exported] };
  fs.writeFileSync(result, JSON.stringify(payload, null, 2), 'utf8');
  return { path: result, count: 1 };
});

ipcMain.handle('automations:previewImport', (event) => {
  const result = dialog.showOpenDialogSync(mainWindow, {
    title: 'Select Automations File',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (!result || result.length === 0) return { cancelled: true };
  try {
    const raw = JSON.parse(fs.readFileSync(result[0], 'utf8'));
    let automations = raw.automations || [];
    if (automations.length === 0 && raw.loops) {
      automations = raw.loops.map(l => ({ name: l.name, agents: [{ name: l.name }] }));
    }
    if (automations.length === 0 && raw.name && raw.agents) automations = [raw];
    if (automations.length === 0 && raw.name && raw.prompt) automations = [{ name: raw.name, agents: [{ name: raw.name }] }];
    if (automations.length === 0) return { error: 'No automations found in file' };

    const summary = automations.map(a => {
      const agentNames = (a.agents || []).map(ag => ag.name || 'unnamed');
      const hasManager = a.manager && a.manager.enabled;
      const isolatedCount = (a.agents || []).filter(ag => ag.isolation && ag.isolation.enabled).length;
      const managerIsolated = hasManager && a.manager.isolation && a.manager.isolation.enabled;
      return {
        name: a.name,
        agentCount: agentNames.length,
        agentNames: agentNames,
        hasManager: hasManager,
        isolatedCount: isolatedCount + (managerIsolated ? 1 : 0),
        hasChaining: (a.agents || []).some(ag => ag.runMode === 'run_after')
      };
    });

    const totalAgents = summary.reduce((s, a) => s + a.agentCount, 0);
    const totalManagers = summary.filter(a => a.hasManager).length;
    const totalIsolated = summary.reduce((s, a) => s + a.isolatedCount, 0);

    return {
      filePath: result[0],
      automationCount: automations.length,
      totalAgents: totalAgents,
      totalManagers: totalManagers,
      totalIsolated: totalIsolated,
      automations: summary
    };
  } catch (err) {
    return { error: 'Failed to parse file: ' + err.message };
  }
});

ipcMain.handle('automations:import', (event, projectPath, filePath) => {
  let result;
  if (filePath) {
    // Use provided file path (from preview flow)
    result = [filePath];
  } else {
    result = dialog.showOpenDialogSync(mainWindow, {
      title: 'Import Automations',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    });
  }
  if (!result || result.length === 0) return { cancelled: true };
  try {
    const raw = JSON.parse(fs.readFileSync(result[0], 'utf8'));

    // Support both old loops format and new automations format
    let automations = raw.automations || [];
    if (automations.length === 0 && raw.loops) {
      automations = raw.loops.map(l => ({
        name: l.name,
        agents: [{
          name: l.name, prompt: l.prompt, schedule: l.schedule,
          skipPermissions: l.skipPermissions || false, firstStartOnly: l.firstStartOnly || false,
          dbConnectionString: l.dbConnectionString || null, dbReadOnly: l.dbReadOnly !== false
        }]
      }));
    }
    if (automations.length === 0 && raw.name && raw.agents) {
      automations = [raw];
    }
    if (automations.length === 0 && raw.name && raw.prompt) {
      automations = [{
        name: raw.name,
        agents: [{
          name: raw.name, prompt: raw.prompt, schedule: raw.schedule,
          skipPermissions: raw.skipPermissions || false, firstStartOnly: raw.firstStartOnly || false,
          dbConnectionString: raw.dbConnectionString || null, dbReadOnly: raw.dbReadOnly !== false
        }]
      }];
    }
    if (automations.length === 0) return { error: 'No automations found in file' };

    const data = readAutomations();
    let count = 0;
    const importedIds = [];

    automations.forEach(imported => {
      const automationId = generateAutomationId();
      // First pass: generate IDs and build mapping
      const importIdMap = {};
      const agents = (imported.agents || []).map((ag, idx) => {
        const newId = generateAgentId();
        if (ag.id) importIdMap[ag.id] = newId;
        importIdMap['temp_' + idx] = newId;
        return Object.assign({
          id: newId,
          runMode: 'independent',
          runAfter: [],
          runOnUpstreamFailure: false,
          passUpstreamContext: false,
          isolation: { enabled: false, clonePath: null },
          enabled: true,
          skipPermissions: false,
          firstStartOnly: false,
          dbConnectionString: null,
          dbReadOnly: true,
          lastRunAt: null,
          lastRunStatus: null,
          lastError: null,
          lastSummary: null,
          lastAttentionItems: null,
          currentRunStartedAt: null
        }, ag, { id: newId, isolation: { enabled: ag.isolation ? ag.isolation.enabled : false, clonePath: null } });
      });
      // Build name-to-id map for name-based runAfter references
      const nameToIdMap = {};
      agents.forEach(ag => { nameToIdMap[ag.name] = ag.id; });

      // Second pass: remap runAfter references (supports both IDs and agent names)
      agents.forEach(agent => {
        if (agent.runAfter && agent.runAfter.length > 0) {
          agent.runAfter = agent.runAfter.map(ref => importIdMap[ref] || nameToIdMap[ref] || ref);
        }
      });

      // Import manager config if present
      let managerConfig = { enabled: false };
      if (imported.manager && imported.manager.enabled) {
        managerConfig = Object.assign({
          enabled: true,
          prompt: '',
          triggerOn: 'failure',
          includeFullOutput: false,
          skipPermissions: false,
          dbConnectionString: null,
          dbReadOnly: true,
          isolation: { enabled: false, clonePath: null },
          maxRetries: 1,
          lastRunAt: null,
          lastRunStatus: null,
          lastSummary: null,
          needsHuman: false,
          humanContext: null
        }, imported.manager, {
          isolation: { enabled: imported.manager.isolation ? imported.manager.isolation.enabled : false, clonePath: null }
        });
      }

      const hasIsolation = agents.some(ag => ag.isolation && ag.isolation.enabled) ||
        (managerConfig.enabled && managerConfig.isolation && managerConfig.isolation.enabled);

      data.automations.push({
        id: automationId,
        name: imported.name,
        projectPath: projectPath,
        agents: agents,
        manager: managerConfig,
        enabled: false,
        createdAt: new Date().toISOString()
      });
      importedIds.push({ id: automationId, name: imported.name, needsClone: hasIsolation });
      count++;
    });

    writeAutomations(data);
    return { count, importedIds };
  } catch (err) {
    return { error: 'Failed to import: ' + err.message };
  }
});

ipcMain.handle('automations:validateDependencies', (event, agents) => {
  if (hasCyclicDependencies(agents)) {
    return { valid: false, error: 'Circular dependency detected in agent run-after chain' };
  }
  return { valid: true };
});

ipcMain.handle('automations:getSettings', () => {
  const data = readAutomations();
  return {
    globalEnabled: data.globalEnabled !== undefined ? data.globalEnabled : true,
    agentReposBaseDir: data.agentReposBaseDir || AGENTS_DIR_DEFAULT,
    runWindow: data.runWindow || null
  };
});

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

ipcMain.handle('automations:runManager', (event, automationId) => {
  managerRetryCounters.delete(automationId); // Reset retries for manual trigger
  runManager(automationId);
  return true;
});

ipcMain.handle('automations:dismissManager', (event, automationId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation || !automation.manager) return false;
  automation.manager.needsHuman = false;
  automation.manager.humanContext = null;
  writeAutomations(data);
  if (mainWindow) mainWindow.webContents.send('automations:manager-completed', {
    automationId, status: 'dismissed', needsHuman: false
  });
  return true;
});

ipcMain.handle('automations:getManagerStatus', (event, automationId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation || !automation.manager) return { enabled: false };
  return {
    enabled: automation.manager.enabled,
    lastRunStatus: automation.manager.lastRunStatus,
    lastSummary: automation.manager.lastSummary,
    needsHuman: automation.manager.needsHuman,
    humanContext: automation.manager.humanContext,
    running: runningManagers.has(automationId)
  };
});

ipcMain.handle('automations:getManagerHistory', (event, automationId, count) => {
  const dir = path.join(AUTOMATIONS_RUNS_DIR, automationId, '_manager');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
    const results = [];
    for (let i = 0; i < Math.min(count || 5, files.length); i++) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, files[i]), 'utf8'));
      results.push({
        startedAt: data.startedAt,
        completedAt: data.completedAt,
        durationMs: data.durationMs,
        status: data.status,
        summary: data.summary,
        needsHuman: data.needsHuman,
        actions: data.actions,
        output: data.output
      });
    }
    return results;
  } catch {
    return [];
  }
});

ipcMain.handle('automations:getManagerLiveOutput', (event, automationId) => {
  const chunks = managerLiveOutputBuffers.get(automationId);
  if (chunks) return chunks.join('');
  return null;
});

ipcMain.handle('automations:setupManagerClone', async (event, automationId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation || !automation.manager) return { error: 'Automation or manager not found' };
  if (!automation.manager.isolation || !automation.manager.isolation.enabled) return { error: 'Manager isolation not enabled' };

  const baseDir = data.agentReposBaseDir || AGENTS_DIR_DEFAULT;
  const projectName = automation.projectPath.split(/[/\\]/).pop();
  const automationDirName = automation.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const clonePath = path.join(baseDir, projectName, '_manager-' + automationDirName);

  if (fs.existsSync(clonePath)) {
    try {
      const existingRemote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: clonePath, encoding: 'utf8' }).trim();
      let sourceRemote = '';
      try {
        sourceRemote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: automation.projectPath, encoding: 'utf8' }).trim();
      } catch { /* no remote */ }
      if (existingRemote === sourceRemote || existingRemote === automation.projectPath) {
        const freshData = readAutomations();
        const freshAuto = freshData.automations.find(a => a.id === automationId);
        if (freshAuto && freshAuto.manager) {
          freshAuto.manager.isolation.clonePath = clonePath;
          writeAutomations(freshData);
        }
        return { clonePath, status: 'reused' };
      }
      // Different remote — clean up and re-clone
      safeRemoveDir(clonePath);
    } catch {
      // Not a valid git repo — clean up and re-clone
      safeRemoveDir(clonePath);
    }
  }

  let remoteUrl = '';
  try {
    remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: automation.projectPath, encoding: 'utf8' }).trim();
  } catch {
    remoteUrl = automation.projectPath;
  }

  fs.mkdirSync(path.dirname(clonePath), { recursive: true });

  return new Promise((resolve) => {
    const child = spawn('git', ['clone', '--', remoteUrl, clonePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => {
      if (mainWindow) mainWindow.webContents.send('automations:clone-progress', { automationId, agentId: '_manager', line: chunk.toString() });
    });
    child.stderr.on('data', (chunk) => {
      if (mainWindow) mainWindow.webContents.send('automations:clone-progress', { automationId, agentId: '_manager', line: chunk.toString() });
    });
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        const freshData = readAutomations();
        const freshAuto = freshData.automations.find(a => a.id === automationId);
        if (freshAuto && freshAuto.manager) {
          freshAuto.manager.isolation.clonePath = clonePath;
          writeAutomations(freshData);
        }
        resolve({ clonePath, status: 'cloned' });
      } else {
        resolve({ error: 'git clone failed with exit code ' + exitCode });
      }
    });
    child.on('error', (err) => { resolve({ error: 'git clone error: ' + err.message }); });
  });
});

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

ipcMain.handle('snippets:list', () => readSnippets().snippets || []);

ipcMain.handle('snippets:save', (_event, snippet) => {
  if (!snippet || typeof snippet !== 'object') return null;
  const data = readSnippets();
  if (!Array.isArray(data.snippets)) data.snippets = [];
  if (snippet.id) {
    const i = data.snippets.findIndex(s => s.id === snippet.id);
    if (i >= 0) data.snippets[i] = snippet; else data.snippets.push(snippet);
  } else {
    snippet.id = 'snip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    data.snippets.push(snippet);
  }
  writeSnippets(data);
  return snippet;
});

ipcMain.handle('snippets:delete', (_event, id) => {
  if (!id) return false;
  const data = readSnippets();
  data.snippets = (data.snippets || []).filter(s => s.id !== id);
  writeSnippets(data);
  return true;
});

// --- Automations Scheduler & Execution ---

const agentLiveOutputBuffers = new Map(); // 'automationId:agentId' -> string[] chunks
const runningAgents = new Map(); // 'automationId:agentId' -> child process
const agentQueue = []; // {automationId, agentId} objects waiting for a slot
const runningManagers = new Map(); // automationId -> child process
const managerRetryCounters = new Map(); // automationId -> number of retries this cycle
const managerLiveOutputBuffers = new Map(); // automationId -> string[] chunks

const AGENT_PROMPT_SUFFIX = '\n\nEnd your response with a JSON block wrapped in :::loop-result markers like this:\n:::loop-result\n{"summary": "Brief one-line summary", "attentionItems": [{"summary": "Short description", "detail": "Full context"}]}\n:::loop-result\nIf there are no issues, use an empty attentionItems array.';

const MANAGER_PROMPT_TEMPLATE = `You are the Automation Manager for "{name}".

A pipeline run has just completed. Your job is to:
1. Review all agent results below
2. Identify any failures or issues
3. Investigate root causes using the codebase and database
4. Take corrective action if possible (re-running agents, etc.)
5. Escalate to the human ONLY if you cannot resolve the issue

{pipelineReport}

RULES:
- If an agent failed due to a transient error (timeout, network issue), re-run it
- If an agent failed due to a code or data issue, investigate the root cause
- Do NOT re-run an agent more than {maxRetries} time(s) — you have used {retriesUsed} retries so far
- If you cannot resolve the issue, set needsHuman to true and provide clear context for the human
- Always explain what you found and what you did

{customPrompt}

End your response with a JSON block wrapped in :::manager-result markers like this:
:::manager-result
{"summary": "Brief description", "attentionItems": [{"summary": "...", "detail": "..."}], "actions": [{"type": "rerun_agent", "agentId": "agent_id_here"} or {"type": "rerun_all"} or {"type": "report"}], "needsHuman": false, "humanContext": "Only if needsHuman is true"}
:::manager-result`;

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

function findClaudePath() {
  try {
    const result = execFileSync('where', ['claude'], { encoding: 'utf8' });
    return result.trim().split(/\r?\n/)[0];
  } catch {
    return 'claude';
  }
}

let claudePath = null;

function getClaudePath() {
  if (!claudePath) claudePath = findClaudePath();
  return claudePath;
}

function parseAgentResult(output) {
  const result = { summary: '', attentionItems: [] };
  // Try structured :::loop-result block first
  const match = output.match(/:::loop-result\s*\n([\s\S]*?)\n\s*:::loop-result/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      result.summary = parsed.summary || '';
      result.attentionItems = parsed.attentionItems || [];
      return result;
    } catch { /* fall through to heuristic */ }
  }
  // Heuristic fallback: extract last paragraph as summary
  const lines = output.trim().split('\n');
  result.summary = lines[lines.length - 1].substring(0, 200);
  // Look for attention patterns
  const patterns = [/ACTION NEEDED:\s*(.+)/gi, /WARNING:\s*(.+)/gi, /FAILING:\s*(.+)/gi, /ERROR:\s*(.+)/gi];
  patterns.forEach((pat) => {
    let m;
    while ((m = pat.exec(output)) !== null) {
      result.attentionItems.push({ summary: m[1].substring(0, 200), detail: '' });
    }
  });
  return result;
}

function parseManagerResult(output) {
  const result = { summary: '', attentionItems: [], actions: [], needsHuman: false, humanContext: null };
  const match = output.match(/:::manager-result\s*\n([\s\S]*?)\n\s*:::manager-result/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      result.summary = parsed.summary || '';
      result.attentionItems = parsed.attentionItems || [];
      result.actions = parsed.actions || [];
      result.needsHuman = !!parsed.needsHuman;
      result.humanContext = parsed.humanContext || null;
      return result;
    } catch { /* fall through */ }
  }
  // Fallback: treat entire output as summary, assume needs human
  const lines = output.trim().split('\n');
  result.summary = lines[lines.length - 1].substring(0, 200);
  result.needsHuman = true;
  result.humanContext = 'Manager did not produce structured output. Please review the raw output.';
  return result;
}

function buildPipelineReport(automation, includeFullOutput) {
  let report = 'PIPELINE STRUCTURE:\n';
  automation.agents.forEach((ag, i) => {
    const mode = ag.runMode === 'run_after' ? 'runs after ' + (ag.runAfter || []).map(id => {
      const up = automation.agents.find(a => a.id === id);
      return up ? up.name : id;
    }).join(', ') : 'independent';
    report += '- Agent ' + (i + 1) + ': "' + ag.name + '" (' + mode + (ag.isolation && ag.isolation.enabled ? ', isolated' : '') + ')\n';
  });
  report += '\nAGENT RESULTS:\n';
  automation.agents.forEach(ag => {
    report += '\n--- ' + ag.name + ' — ' + (ag.lastRunStatus || 'not run').toUpperCase() + ' ---\n';
    if (ag.lastSummary) report += 'Summary: ' + ag.lastSummary + '\n';
    if (ag.lastError) report += 'Error: ' + ag.lastError + '\n';
    if (ag.lastAttentionItems && ag.lastAttentionItems.length > 0) {
      report += 'Attention items:\n';
      ag.lastAttentionItems.forEach(item => {
        report += '  - ' + item.summary + (item.detail ? ': ' + item.detail : '') + '\n';
      });
    }
    if (includeFullOutput) {
      const history = getAgentHistory(automation.id, ag.id, 1);
      if (history.length > 0) {
        const dir = path.join(AUTOMATIONS_RUNS_DIR, automation.id, ag.id);
        try {
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
          if (files.length > 0) {
            const runData = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
            if (runData.output) report += 'Full output:\n' + runData.output.substring(0, 10000) + '\n';
          }
        } catch { /* ignore */ }
      }
    }
  });
  const completed = automation.agents.filter(ag => ag.lastRunStatus === 'completed').length;
  const errored = automation.agents.filter(ag => ag.lastRunStatus === 'error').length;
  const skipped = automation.agents.filter(ag => ag.lastRunStatus === 'skipped').length;
  report += '\nOVERALL STATUS: ' + completed + ' completed, ' + errored + ' error, ' + skipped + ' skipped\n';
  return report;
}

function sendManagerNotification(automation, summary) {
  if (mainWindow && mainWindow.isFocused()) return;
  const notif = new Notification({
    title: 'Automation Manager — ' + automation.name,
    body: (summary || '').substring(0, 100),
    icon: path.join(__dirname, 'icon.png')
  });
  notif.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('automations:focus-manager', { automationId: automation.id });
    }
  });
  notif.show();
}

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

function shouldRunAgent(data, automation, agent, now) {
  if (!isWithinRunWindow(data.runWindow, now)) return false;
  if (!isWithinRunWindow(automation.runWindow, now)) return false;
  if (!agent.enabled) return false;
  if (agent.currentRunStartedAt) return false;
  if (agent.runMode === 'run_after') return false; // Only triggered by upstream completion
  if (agent.schedule.type === 'app_startup') return false;
  if (agent.schedule.type === 'manual') return false;

  if (agent.schedule.type === 'interval') {
    if (!agent.lastRunAt) return true;
    const elapsed = now - new Date(agent.lastRunAt).getTime();
    return elapsed >= agent.schedule.minutes * 60000;
  }

  if (agent.schedule.type === 'time_of_day') {
    const date = new Date(now);
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const today = dayNames[date.getDay()];
    if (agent.schedule.days && agent.schedule.days.indexOf(today) === -1) return false;
    const nowMinutes = date.getHours() * 60 + date.getMinutes();
    const times = agent.schedule.times || [{ hour: agent.schedule.hour, minute: agent.schedule.minute || 0 }];
    const lastRun = agent.lastRunAt ? new Date(agent.lastRunAt) : null;

    for (const t of times) {
      const schedMinutes = t.hour * 60 + (t.minute || 0);
      if (nowMinutes < schedMinutes) continue;
      if (lastRun && lastRun.toDateString() === date.toDateString()) {
        const lastRunMinutes = lastRun.getHours() * 60 + lastRun.getMinutes();
        if (lastRunMinutes >= schedMinutes) continue;
      }
      return true;
    }
    return false;
  }
  return false;
}


function preRunPull(clonePath) {
  return new Promise((resolve) => {
    let branch = 'master';
    try {
      execFileSync('git', ['checkout', 'master'], { cwd: clonePath, encoding: 'utf8', stdio: 'pipe' });
    } catch {
      try {
        execFileSync('git', ['checkout', 'main'], { cwd: clonePath, encoding: 'utf8', stdio: 'pipe' });
        branch = 'main';
      } catch (e) {
        resolve({ error: 'Failed to checkout master/main: ' + e.message });
        return;
      }
    }
    try {
      execFileSync('git', ['pull', 'origin', branch], { cwd: clonePath, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
      resolve({ ok: true });
    } catch (e) {
      resolve({ error: 'git pull failed: ' + e.message });
    }
  });
}

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
    env: opts.env ? Object.assign({}, process.env, opts.env) : Object.assign({}, process.env)
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

// --- Headless Runner ---

const runningHeadless = new Map(); // runId -> { child, cleanup, projectPath, cancelled? }

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

  // Resolve the connection name for the dock chip.
  let connectionName = 'Cloud';
  if (spawnOptions.endpointId) {
    const preset = getEndpointById(spawnOptions.endpointId);
    if (preset) connectionName = preset.name || 'local';
  }

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
    exitCode: null,
    connectionName
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

  const endpointEnv = getProjectEndpointEnvByPath(projectPath);
  const spawned = spawnHeadlessClaude(prompt, projectPath, {
    skipPermissions: !!spawnOptions.skipPermissions,
    bare: !!spawnOptions.bare,
    model: endpointEnv ? null : (spawnOptions.model || null),
    env: endpointEnv,
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

// Resolve the env block for an agent. Agents created or edited with the
// per-agent connection picker have an explicit `endpointId` field (null = cloud,
// string = preset id). Legacy agents that pre-date the picker have no field
// at all — they fall back to the project's configured endpoint so we don't
// silently switch a user's existing automations to cloud.
function getAgentEndpointEnv(agent, projectPath) {
  if (agent && Object.prototype.hasOwnProperty.call(agent, 'endpointId')) {
    if (!agent.endpointId) return null;
    return buildEndpointEnv(agent.endpointId, agent.endpointModel || null);
  }
  return getProjectEndpointEnvByPath(projectPath);
}

async function runAgent(automationId, agentId) {
  let data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return;
  const agent = automation.agents.find(ag => ag.id === agentId);
  if (!agent) return;

  const key = automationId + ':' + agentId;
  if (runningAgents.has(key)) return;

  // Check concurrency limit (shared across loops and agents)
  const totalRunning = runningAgents.size;
  if (totalRunning >= (data.maxConcurrentRuns || 3)) {
    if (!agentQueue.some(q => q.automationId === automationId && q.agentId === agentId)) {
      agentQueue.push({ automationId, agentId });
    }
    return;
  }

  // Determine working directory
  let cwd = automation.projectPath;
  if (agent.isolation && agent.isolation.enabled) {
    if (!agent.isolation.clonePath || !fs.existsSync(agent.isolation.clonePath)) {
      agent.lastRunStatus = 'error';
      agent.lastError = 'Working directory not found — run setup again';
      writeAutomations(data);
      if (mainWindow) mainWindow.webContents.send('automations:agent-completed', {
        automationId, agentId, status: 'error', error: agent.lastError
      });
      return;
    }
    cwd = agent.isolation.clonePath;

    // Pre-run pull
    const pullResult = await preRunPull(cwd);
    if (pullResult.error) {
      agent.lastRunStatus = 'error';
      agent.lastError = pullResult.error;
      writeAutomations(data);
      if (mainWindow) mainWindow.webContents.send('automations:agent-completed', {
        automationId, agentId, status: 'error', error: agent.lastError
      });
      return;
    }
    // Re-read data after async pull
    data = readAutomations();
  }

  // Validate working directory
  if (!fs.existsSync(cwd)) {
    agent.lastRunStatus = 'error';
    agent.lastError = 'Working directory not found: ' + cwd;
    agent.enabled = false;
    writeAutomations(data);
    if (mainWindow) mainWindow.webContents.send('automations:agent-completed', {
      automationId, agentId, status: 'error', error: agent.lastError
    });
    return;
  }

  // Capacity gate: skip the run if any configured usage window is too full.
  // Each gate is per-agent; absent / null means no gate for that window.
  const sessionGate = agent.usageGate && typeof agent.usageGate.sessionMaxPct === 'number'
    ? agent.usageGate.sessionMaxPct
    : null;
  const weeklyGate = agent.usageGate && typeof agent.usageGate.weeklyMaxPct === 'number'
    ? agent.usageGate.weeklyMaxPct
    : null;
  if ((sessionGate != null || weeklyGate != null) && planUsageCache && planUsageCache.data) {
    const planData = planUsageCache.data;
    let skipReason = null;
    if (sessionGate != null && planData.five_hour && typeof planData.five_hour.utilization === 'number') {
      const util = planData.five_hour.utilization;
      if (util > sessionGate) {
        skipReason = 'Skipped: session usage ' + util.toFixed(1) + '% > gate ' + sessionGate + '%';
      }
    }
    if (!skipReason && weeklyGate != null && planData.seven_day && typeof planData.seven_day.utilization === 'number') {
      const util = planData.seven_day.utilization;
      if (util > weeklyGate) {
        skipReason = 'Skipped: weekly usage ' + util.toFixed(1) + '% > gate ' + weeklyGate + '%';
      }
    }
    if (skipReason) {
      const skipData = readAutomations();
      const skipAuto = skipData.automations.find(a => a.id === automationId);
      if (skipAuto) {
        const skipAgent = skipAuto.agents.find(ag => ag.id === agentId);
        if (skipAgent) {
          skipAgent.lastRunStatus = 'skipped';
          skipAgent.lastRunAt = new Date().toISOString();
          skipAgent.lastError = skipReason;
          writeAutomations(skipData);
        }
      }
      if (mainWindow) mainWindow.webContents.send('automations:agent-completed', {
        automationId, agentId, status: 'skipped', error: skipReason
      });
      return;
    }
  }

  // Mark as running
  const freshData1 = readAutomations();
  const freshAuto1 = freshData1.automations.find(a => a.id === automationId);
  if (freshAuto1) {
    const freshAgent1 = freshAuto1.agents.find(ag => ag.id === agentId);
    if (freshAgent1) {
      freshAgent1.currentRunStartedAt = new Date().toISOString();
      writeAutomations(freshData1);
    }
  }

  if (mainWindow) mainWindow.webContents.send('automations:agent-started', { automationId, agentId });

  const startedAt = new Date().toISOString();
  const outputChunks = [];
  const textChunks = [];

  let promptPrefix = '';
  if (agent.dbConnectionString && agent.dbReadOnly !== false) {
    promptPrefix = 'CRITICAL CONSTRAINT: This agent has READ-ONLY database access. You MUST NOT attempt to write, update, insert, delete, drop, rename, or modify any data in the database. This includes using $merge, $out, or any write stages in aggregation pipelines. Do NOT attempt to bypass this restriction by using shell commands (mongosh, mongo, etc.) or any other method. If the task requires writing to the database, report it as an attention item explaining what write would be needed, but do not perform it.\n\n';
  }
  let fullPrompt = promptPrefix + agent.prompt + AGENT_PROMPT_SUFFIX;

  // If passUpstreamContext is enabled, prepend upstream agents' summaries
  if (agent.passUpstreamContext && agent.runMode === 'run_after' && agent.runAfter && agent.runAfter.length > 0) {
    const upstreamParts = [];
    agent.runAfter.forEach(upstreamId => {
      const upstreamAgent = automation.agents.find(ag => ag.id === upstreamId);
      if (upstreamAgent) {
        let info = '';
        if (upstreamAgent.lastSummary) info = upstreamAgent.lastSummary;
        if (upstreamAgent.lastAttentionItems && upstreamAgent.lastAttentionItems.length > 0) {
          info += '\nAttention items: ' + upstreamAgent.lastAttentionItems.map(i => i.summary).join('; ');
        }
        if (info) upstreamParts.push('--- Output from "' + upstreamAgent.name + '" ---\n' + info);
      }
    });
    if (upstreamParts.length > 0) {
      fullPrompt = 'CONTEXT FROM UPSTREAM AGENTS:\n' + upstreamParts.join('\n\n') + '\n\n---\n\nYOUR TASK:\n' + fullPrompt;
    }
  }

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
    env: getAgentEndpointEnv(agent, automation.projectPath),
    onRaw: (raw) => { outputChunks.push(raw); },
    onText: (text) => {
      textChunks.push(text);
      if (mainWindow) mainWindow.webContents.send('automations:agent-output', { automationId, agentId, chunk: text });
    }
  });
  const child = spawned.child;

  runningAgents.set(key, child);
  agentLiveOutputBuffers.set(key, textChunks);

  child.on('close', (exitCode) => {
    runningAgents.delete(key);
    agentLiveOutputBuffers.delete(key);
    spawned.cleanup();

    const completedAt = new Date().toISOString();
    let runStatus = exitCode === 0 ? 'completed' : 'error';
    let parsed = { summary: '', attentionItems: [] };

    try {
      const displayOutput = textChunks.join('');
      parsed = parseAgentResult(displayOutput);

      const runData = {
        automationId, agentId,
        startedAt, completedAt,
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
        exitCode,
        status: runStatus,
        summary: parsed.summary,
        output: displayOutput,
        attentionItems: parsed.attentionItems,
        costUsd: null
      };

      saveAgentRun(automationId, agentId, runData);
    } catch { /* don't let save failure prevent state cleanup below */ }

    // Always clear currentRunStartedAt — this is critical to prevent stuck state
    try {
      const freshData = readAutomations();
      const freshAuto = freshData.automations.find(a => a.id === automationId);
      if (freshAuto) {
        const freshAgent = freshAuto.agents.find(ag => ag.id === agentId);
        if (freshAgent) {
          freshAgent.currentRunStartedAt = null;
          freshAgent.lastRunAt = completedAt;
          freshAgent.lastRunStatus = runStatus;
          freshAgent.lastError = exitCode === 0 ? null : 'Exit code: ' + exitCode;
          freshAgent.lastSummary = parsed.summary || null;
          freshAgent.lastAttentionItems = parsed.attentionItems || [];
          writeAutomations(freshData);
        }

        // Trigger dependent agents
        triggerDependentAgents(automationId, agentId, runStatus, freshData);

        // Check if pipeline is fully complete — trigger manager if configured
        checkPipelineComplete(automationId);
      }
    } catch { /* avoid crashing the close handler */ }

    // Always notify renderer
    if (mainWindow) {
      mainWindow.webContents.send('automations:agent-completed', {
        automationId, agentId,
        status: runStatus,
        summary: parsed.summary,
        attentionItems: parsed.attentionItems,
        exitCode
      });

      if (parsed.attentionItems.length > 0) {
        mainWindow.flashFrame(true);
      }
    }

    // Process queue
    if (agentQueue.length > 0) {
      const next = agentQueue.shift();
      runAgent(next.automationId, next.agentId);
    }
  });

  child.on('error', (err) => {
    runningAgents.delete(key);
    agentLiveOutputBuffers.delete(key);
    spawned.cleanup();
    try {
      const freshData = readAutomations();
      const freshAuto = freshData.automations.find(a => a.id === automationId);
      if (freshAuto) {
        const freshAgent = freshAuto.agents.find(ag => ag.id === agentId);
        if (freshAgent) {
          freshAgent.currentRunStartedAt = null;
          freshAgent.lastRunStatus = 'error';
          freshAgent.lastError = err.message;
          writeAutomations(freshData);
        }
      }
    } catch { /* avoid crashing the error handler */ }
    if (mainWindow) mainWindow.webContents.send('automations:agent-completed', {
      automationId, agentId, status: 'error', error: err.message
    });
    if (agentQueue.length > 0) {
      const next = agentQueue.shift();
      runAgent(next.automationId, next.agentId);
    }
  });
}

function triggerDependentAgents(automationId, completedAgentId, completedStatus, data) {
  const automation = data ? data.automations.find(a => a.id === automationId) : null;
  if (!automation) return;

  automation.agents.forEach(agent => {
    if (agent.runMode !== 'run_after') return;
    if (!agent.enabled) return;
    if (!agent.runAfter || !agent.runAfter.includes(completedAgentId)) return;

    // Check if ALL upstream agents have completed
    const allUpstreamDone = agent.runAfter.every(upstreamId => {
      const upstream = automation.agents.find(ag => ag.id === upstreamId);
      if (!upstream) return true; // Missing upstream treated as complete
      return upstream.lastRunStatus && !upstream.currentRunStartedAt;
    });

    if (!allUpstreamDone) return;

    // Check if any upstream failed
    const anyFailed = agent.runAfter.some(upstreamId => {
      const upstream = automation.agents.find(ag => ag.id === upstreamId);
      return upstream && (upstream.lastRunStatus === 'error' || upstream.lastRunStatus === 'skipped');
    });

    if (anyFailed && !agent.runOnUpstreamFailure) {
      // Skip this agent and cascade the skip
      const freshData = readAutomations();
      const freshAuto = freshData.automations.find(a => a.id === automationId);
      if (freshAuto) {
        const freshAgent = freshAuto.agents.find(ag => ag.id === agent.id);
        if (freshAgent) {
          freshAgent.lastRunStatus = 'skipped';
          freshAgent.lastError = 'Upstream agent failed or was skipped';
          writeAutomations(freshData);
        }
        // Cascade skip to agents depending on this one
        triggerDependentAgents(automationId, agent.id, 'skipped', freshData);
      }
      if (mainWindow) mainWindow.webContents.send('automations:agent-completed', {
        automationId, agentId: agent.id, status: 'skipped'
      });
      return;
    }

    // All upstream done and either all succeeded or runOnUpstreamFailure is true
    runAgent(automationId, agent.id);
  });
}

async function runManager(automationId) {
  let data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return;
  if (!automation.manager || !automation.manager.enabled) return;
  if (runningManagers.has(automationId)) return;

  const manager = automation.manager;
  let cwd = automation.projectPath;

  // Use isolated clone if configured
  if (manager.isolation && manager.isolation.enabled) {
    if (!manager.isolation.clonePath || !fs.existsSync(manager.isolation.clonePath)) {
      // Auto-setup clone for manager
      const baseDir = data.agentReposBaseDir || AGENTS_DIR_DEFAULT;
      const projectName = automation.projectPath.split(/[/\\]/).pop();
      const automationDirName = automation.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      const clonePath = path.join(baseDir, projectName, '_manager-' + automationDirName);

      if (!fs.existsSync(clonePath)) {
        // Clone the repo
        let remoteUrl = '';
        try {
          remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: automation.projectPath, encoding: 'utf8' }).trim();
        } catch {
          remoteUrl = automation.projectPath;
        }
        fs.mkdirSync(path.dirname(clonePath), { recursive: true });
        try {
          execFileSync('git', ['clone', '--', remoteUrl, clonePath], { encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
        } catch (e) {
          console.error('[Manager] Clone failed:', e.message);
          // Fall back to project path
          cwd = automation.projectPath;
        }
      }

      if (fs.existsSync(clonePath)) {
        // Update the stored clone path
        const freshCloneData = readAutomations();
        const freshCloneAuto = freshCloneData.automations.find(a => a.id === automationId);
        if (freshCloneAuto && freshCloneAuto.manager) {
          freshCloneAuto.manager.isolation.clonePath = clonePath;
          writeAutomations(freshCloneData);
        }
        cwd = clonePath;
      }
    } else {
      cwd = manager.isolation.clonePath;
    }

    // Pre-run pull if using isolated clone
    if (cwd !== automation.projectPath) {
      const pullResult = await preRunPull(cwd);
      if (pullResult.error) {
        console.error('[Manager] Pre-run pull failed:', pullResult.error);
        // Continue anyway — stale code is better than no investigation
      }
      data = readAutomations(); // Re-read after async
    }
  }

  if (!fs.existsSync(cwd)) return;

  // Build the prompt
  const pipelineReport = buildPipelineReport(automation, manager.includeFullOutput);
  const retriesUsed = managerRetryCounters.get(automationId) || 0;
  let prompt = MANAGER_PROMPT_TEMPLATE
    .replace('{name}', automation.name)
    .replace('{pipelineReport}', pipelineReport)
    .replace('{maxRetries}', String(manager.maxRetries || 1))
    .replace('{retriesUsed}', String(retriesUsed))
    .replace('{customPrompt}', manager.prompt || '');

  // Update state
  const freshData = readAutomations();
  const freshAuto = freshData.automations.find(a => a.id === automationId);
  if (freshAuto && freshAuto.manager) {
    freshAuto.manager.lastRunAt = new Date().toISOString();
    freshAuto.manager.lastRunStatus = 'running';
    freshAuto.manager.needsHuman = false;
    freshAuto.manager.humanContext = null;
    writeAutomations(freshData);
  }

  if (mainWindow) mainWindow.webContents.send('automations:manager-started', { automationId });

  const startedAt = new Date().toISOString();
  const textChunks = [];

  const args = ['--print', prompt, '--output-format', 'stream-json', '--verbose'];
  if (manager.skipPermissions) args.push('--dangerously-skip-permissions');

  // Database MCP config (same pattern as agents)
  let mcpConfigPath = null;
  if (manager.dbConnectionString) {
    const mcpArgs = ['-y', 'mongodb-mcp-server@latest'];
    if (manager.dbReadOnly !== false) mcpArgs.push('--readOnly');
    const mcpConfig = {
      mcpServers: {
        mongodb: {
          command: 'npx',
          args: mcpArgs,
          env: { MDB_MCP_CONNECTION_STRING: manager.dbConnectionString }
        }
      }
    };
    mcpConfigPath = path.join(AUTOMATIONS_RUNS_DIR, automationId + '_manager_mcp.json');
    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), 'utf8');
    args.push('--mcp-config', mcpConfigPath);

    if (manager.dbReadOnly !== false) {
      const allowedTools = [
        'mcp__mongodb__find', 'mcp__mongodb__count', 'mcp__mongodb__collection-indexes',
        'mcp__mongodb__collection-schema', 'mcp__mongodb__collection-storage-size',
        'mcp__mongodb__db-stats', 'mcp__mongodb__explain', 'mcp__mongodb__export',
        'mcp__mongodb__list-collections', 'mcp__mongodb__list-databases',
        'mcp__mongodb__mongodb-logs', 'mcp__mongodb__list-knowledge-sources',
        'mcp__mongodb__search-knowledge',
        'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'
      ];
      args.push('--allowedTools', allowedTools.join(','));
    }
  }

  const managerEndpointEnv = getProjectEndpointEnvByPath(automation.projectPath);
  const child = spawn(getClaudePath(), args, {
    cwd: cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: managerEndpointEnv
      ? Object.assign({}, process.env, managerEndpointEnv)
      : Object.assign({}, process.env)
  });

  runningManagers.set(automationId, child);
  managerLiveOutputBuffers.set(automationId, textChunks);

  let streamBuffer = '';
  child.stdout.on('data', (chunk) => {
    const raw = chunk.toString();
    streamBuffer += raw;
    const lines = streamBuffer.split('\n');
    streamBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        let text = '';
        if (evt.type === 'assistant' && evt.message && evt.message.content) {
          evt.message.content.forEach(block => { if (block.type === 'text') text += block.text; });
        } else if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
          text = evt.delta.text;
        } else if (evt.type === 'result' && evt.result) {
          if (typeof evt.result === 'string') text = evt.result;
          else if (Array.isArray(evt.result)) evt.result.forEach(block => { if (block.type === 'text') text += block.text; });
        }
        if (text) {
          textChunks.push(text);
          if (mainWindow) mainWindow.webContents.send('automations:manager-output', { automationId, chunk: text });
        }
      } catch { /* skip */ }
    }
  });

  child.stderr.on('data', (chunk) => {
    textChunks.push(chunk.toString());
    if (mainWindow) mainWindow.webContents.send('automations:manager-output', { automationId, chunk: chunk.toString() });
  });

  child.on('close', (exitCode) => {
    runningManagers.delete(automationId);
    managerLiveOutputBuffers.delete(automationId);
    if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }

    const completedAt = new Date().toISOString();
    const displayOutput = textChunks.join('');
    const parsed = parseManagerResult(displayOutput);

    // Save manager run history
    const managerRunDir = path.join(AUTOMATIONS_RUNS_DIR, automationId, '_manager');
    if (!fs.existsSync(managerRunDir)) fs.mkdirSync(managerRunDir, { recursive: true });
    const runFilename = new Date(startedAt).toISOString().replace(/[:.]/g, '-') + '.json';
    const runData = {
      startedAt, completedAt,
      durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      exitCode, status: exitCode === 0 ? 'completed' : 'error',
      summary: parsed.summary, output: displayOutput.substring(0, 50000),
      attentionItems: parsed.attentionItems, actions: parsed.actions,
      needsHuman: parsed.needsHuman, humanContext: parsed.humanContext
    };
    try { fs.writeFileSync(path.join(managerRunDir, runFilename), JSON.stringify(runData, null, 2), 'utf8'); } catch { /* ignore */ }

    // Execute actions
    let actionsExecuted = false;
    if (parsed.actions && parsed.actions.length > 0 && !parsed.needsHuman) {
      const currentRetries = managerRetryCounters.get(automationId) || 0;
      const maxRetries = (automation.manager && automation.manager.maxRetries) || 1;

      parsed.actions.forEach(action => {
        if (action.type === 'rerun_agent' && action.agentId) {
          if (currentRetries < maxRetries) {
            managerRetryCounters.set(automationId, currentRetries + 1);
            runAgent(automationId, action.agentId);
            actionsExecuted = true;
          } else {
            // Exceeded retries — escalate
            parsed.needsHuman = true;
            parsed.humanContext = (parsed.humanContext || '') + '\nMax retries (' + maxRetries + ') reached for agent re-runs. Manual intervention needed.';
          }
        } else if (action.type === 'rerun_all') {
          if (currentRetries < maxRetries) {
            managerRetryCounters.set(automationId, currentRetries + 1);
            const freshD = readAutomations();
            const freshA = freshD.automations.find(a => a.id === automationId);
            if (freshA) {
              freshA.agents.forEach(ag => {
                if (ag.enabled && ag.runMode === 'independent') runAgent(automationId, ag.id);
              });
            }
            actionsExecuted = true;
          } else {
            parsed.needsHuman = true;
            parsed.humanContext = (parsed.humanContext || '') + '\nMax retries (' + maxRetries + ') reached. Manual intervention needed.';
          }
        }
      });
    }

    // Update manager state
    const finalData = readAutomations();
    const finalAuto = finalData.automations.find(a => a.id === automationId);
    if (finalAuto && finalAuto.manager) {
      finalAuto.manager.lastRunAt = completedAt;
      finalAuto.manager.lastSummary = parsed.summary || null;

      if (exitCode !== 0) {
        finalAuto.manager.lastRunStatus = 'error';
        finalAuto.manager.needsHuman = true;
        finalAuto.manager.humanContext = 'Manager process exited with code ' + exitCode;
      } else if (parsed.needsHuman) {
        finalAuto.manager.lastRunStatus = 'escalated';
        finalAuto.manager.needsHuman = true;
        finalAuto.manager.humanContext = parsed.humanContext;
      } else if (actionsExecuted) {
        finalAuto.manager.lastRunStatus = 'acted';
        // Don't clear retry counter — it resets on next fresh pipeline trigger
      } else {
        finalAuto.manager.lastRunStatus = 'resolved';
        managerRetryCounters.delete(automationId);
      }
      writeAutomations(finalData);
    }

    // Notify renderer
    if (mainWindow) {
      mainWindow.webContents.send('automations:manager-completed', {
        automationId,
        status: finalAuto ? finalAuto.manager.lastRunStatus : 'error',
        summary: parsed.summary,
        needsHuman: parsed.needsHuman,
        humanContext: parsed.humanContext,
        actions: parsed.actions
      });

      // Windows notification + flash if needs human
      if (parsed.needsHuman) {
        mainWindow.flashFrame(true);
        sendManagerNotification(automation, parsed.summary);
      }
    }
  });

  child.on('error', (err) => {
    runningManagers.delete(automationId);
    if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
    const errData = readAutomations();
    const errAuto = errData.automations.find(a => a.id === automationId);
    if (errAuto && errAuto.manager) {
      errAuto.manager.lastRunStatus = 'error';
      errAuto.manager.needsHuman = true;
      errAuto.manager.humanContext = 'Manager failed to start: ' + err.message;
      writeAutomations(errData);
    }
    if (mainWindow) {
      mainWindow.webContents.send('automations:manager-completed', {
        automationId, status: 'error', needsHuman: true, summary: err.message
      });
      mainWindow.flashFrame(true);
      sendManagerNotification(automation, 'Manager failed: ' + err.message);
    }
  });
}

const pipelineCompleteTimers = {};

function checkPipelineComplete(automationId) {
  clearTimeout(pipelineCompleteTimers[automationId]);
  pipelineCompleteTimers[automationId] = setTimeout(() => {
    const data = readAutomations();
    const automation = data.automations.find(a => a.id === automationId);
    if (!automation) return;
    if (!automation.manager || !automation.manager.enabled) return;
    if (runningManagers.has(automationId)) return;

    // Check all agents are in terminal state
    const allDone = automation.agents.every(ag => !ag.currentRunStartedAt);
    const anyRan = automation.agents.some(ag => ag.lastRunStatus);
    if (!allDone || !anyRan) return;

    const anyFailed = automation.agents.some(ag =>
      ag.lastRunStatus === 'error' || ag.lastRunStatus === 'skipped'
    );

    if (automation.manager.triggerOn === 'always' ||
        (automation.manager.triggerOn === 'failure' && anyFailed)) {
      runManager(automationId);
    }
  }, 2000);
}

function hasCyclicDependencies(agents) {
  const visited = new Set();
  const inStack = new Set();

  function dfs(agentId) {
    if (inStack.has(agentId)) return true; // Cycle found
    if (visited.has(agentId)) return false;
    visited.add(agentId);
    inStack.add(agentId);

    const agent = agents.find(ag => ag.id === agentId);
    if (agent && agent.runAfter) {
      for (const upstreamId of agent.runAfter) {
        if (dfs(upstreamId)) return true;
      }
    }

    inStack.delete(agentId);
    return false;
  }

  for (const agent of agents) {
    if (dfs(agent.id)) return true;
  }
  return false;
}

let schedulerTimer = null;

function startAutomationScheduler() {
  // Startup recovery: clear stale "running" states in automations
  const data = readAutomations();
  let changed = false;
  data.automations.forEach(automation => {
    automation.agents.forEach(agent => {
      if (agent.currentRunStartedAt) {
        agent.currentRunStartedAt = null;
        agent.lastRunStatus = 'interrupted';
        agent.lastError = 'App closed during run';
        changed = true;
      }
    });
  });
  if (changed) writeAutomations(data);

  // Also clean up legacy loop states
  if (fs.existsSync(LOOPS_FILE)) {
    try {
      const loopData = JSON.parse(fs.readFileSync(LOOPS_FILE, 'utf8'));
      let loopChanged = false;
      (loopData.loops || []).forEach(loop => {
        if (loop.currentRunStartedAt) {
          loop.currentRunStartedAt = null;
          loop.lastRunStatus = 'interrupted';
          loopChanged = true;
        }
      });
      if (loopChanged) fs.writeFileSync(LOOPS_FILE, JSON.stringify(loopData, null, 2), 'utf8');
    } catch { /* ignore */ }
  }

  // Run agents scheduled as app_startup
  setTimeout(() => {
    const startupData = readAutomations();
    if (!startupData.globalEnabled) return;
    const now = new Date();
    if (!isWithinRunWindow(startupData.runWindow, now)) return;
    const todayStr = now.toDateString();
    startupData.automations.forEach(automation => {
      if (!automation.enabled) return;
      if (!isWithinRunWindow(automation.runWindow, now)) return;
      automation.agents.forEach(agent => {
        if (!agent.enabled) return;
        if (agent.runMode === 'run_after') return;
        if (!agent.schedule || agent.schedule.type !== 'app_startup') return;

        if (agent.firstStartOnly && agent.lastRunAt) {
          const lastRunDate = new Date(agent.lastRunAt).toDateString();
          if (lastRunDate === todayStr) return;
        }
        runAgent(automation.id, agent.id);
      });
    });
  }, 5000);

  // Check every 30 seconds
  schedulerTimer = setInterval(() => {
    const autoData = readAutomations();
    if (!autoData.globalEnabled) return;
    const now = Date.now();
    autoData.automations.forEach(automation => {
      if (!automation.enabled) return;
      automation.agents.forEach(agent => {
        if (shouldRunAgent(autoData, automation, agent, now)) {
          runAgent(automation.id, agent.id);
        }
      });
    });
  }, 30000);
}

function stopAutomationScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  // Kill running agents
  runningAgents.forEach((child) => {
    try { child.kill(); } catch { /* ignore */ }
  });
  runningAgents.clear();

  // Kill running managers
  runningManagers.forEach((child) => {
    try { child.kill(); } catch { /* ignore */ }
  });
  runningManagers.clear();

  // Mark all running agents as interrupted
  const data = readAutomations();
  let changed = false;
  data.automations.forEach(automation => {
    automation.agents.forEach(agent => {
      if (agent.currentRunStartedAt) {
        agent.currentRunStartedAt = null;
        agent.lastRunStatus = 'interrupted';
        agent.lastError = 'App closed during run';
        changed = true;
      }
    });
  });
  if (changed) writeAutomations(data);
}

// --- Tray ---

function createTray() {
  const iconFile = process.platform === 'win32' ? 'icon-tray.ico' : 'icon-tray.png';
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', iconFile)
    : path.join(__dirname, iconFile);
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(process.platform === 'darwin' ? trayIcon.resize({ width: 18, height: 18 }) : trayIcon);
  tray.setToolTip('Claudes');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Claudes',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// --- App Lifecycle ---

// In dev mode (not packaged), skip single-instance lock so dev can run alongside production
const isDev = !app.isPackaged;
const gotLock = isDev || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  if (!isDev) {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }

  app.whenReady().then(async () => {
    reconcileInterruptedHeadlessRuns();
    await startPtyServer();
    startHookServer();
    createTray();
    createWindow();
    setupAutoUpdater();
    migrateLoopsToAutomations();
    startAutomationScheduler();

    const cfg = readConfig();
    for (const p of cfg.projects) {
      if (p && p.poppedOut) {
        createProjectWindow(p.path);
      }
    }

    powerMonitor.on('resume', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('power:resume');
      }
      for (const win of popoutWindows.values()) {
        if (!win.isDestroyed()) win.webContents.send('power:resume');
      }
    });
  });

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      if (process.platform === 'darwin') {
        app.dock.show();
      }
    }
  });
}

app.on('window-all-closed', () => {
  // On close-to-tray, windows are hidden not closed, so this only fires on actual quit
  if (process.platform !== 'darwin') {
    stopAutomationScheduler();
    if (ptyServerProcess) {
      ptyServerProcess.kill();
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  for (const win of popoutWindows.values()) {
    if (!win.isDestroyed()) {
      try { win.close(); } catch {}
    }
  }
  flushPendingConfig();
  stopAutomationScheduler();
  if (ptyServerProcess) {
    ptyServerProcess.kill();
  }
});
