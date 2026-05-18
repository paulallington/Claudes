const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeTheme, shell, Tray, Menu, nativeImage, Notification, powerMonitor, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { detectCrossings: detectPlanLimitCrossings } = require('./lib/plan-limit-thresholds');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const http = require('http');
const { resolveWorktreeCandidates, pathIsDirectory } = require('./lib/path-utils');
const { findLastGitBranch } = require('./lib/session-branch');
const { detectActiveWorktree } = require('./lib/worktree-detect');
const ReviewComments = require('./lib/review-comments');
const https = require('https');

// macOS GUI launches (Dock/Finder) inherit launchd's minimal PATH —
// `/usr/bin:/bin:/usr/sbin:/sbin` — which omits Homebrew, ~/.local/bin, nvm,
// etc. That's why `which claude` returns nothing and every `spawn(claude,…)`
// or `spawn(node,…)` ENOENTs (e.g. headless runs produce "no output"). Fix
// it once at process start so EVERY subsequent spawn/execFile inherits a
// real PATH.
if (process.platform !== 'win32') {
  const extras = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), '.volta/bin'),
    path.join(os.homedir(), '.fnm'),
    path.join(os.homedir(), 'bin'),
    path.join(os.homedir(), '.claude/bin'),
  ];
  const have = new Set((process.env.PATH || '').split(path.delimiter).filter(Boolean));
  const missing = extras.filter((p) => !have.has(p));
  if (missing.length) {
    process.env.PATH = [process.env.PATH || '', ...missing].filter(Boolean).join(path.delimiter);
  }
}

// Cross-platform persistent diagnostic logger. Writes lifecycle/quit/crash
// events to a per-OS app-log path so we can investigate intermittent freezes
// (the user can force-quit and the trail still survives).
//
//   macOS:   ~/Library/Logs/Claudes/claudes.log
//   Windows: %LOCALAPPDATA%\Claudes\Logs\claudes.log
//   Linux:   ~/.local/state/Claudes/logs/claudes.log
//
// app.getPath('logs') would resolve these for us but isn't safe to call before
// 'ready'; we want logging during early startup, so we hand-roll the path.
function diagLogDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', 'Claudes');
  }
  if (process.platform === 'win32') {
    // %LOCALAPPDATA% is set on every supported Windows; fall back to the
    // standard path if it isn't, so packaged installs without that env still
    // get a usable directory.
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Claudes', 'Logs');
  }
  // Linux / others: XDG state dir, with a sensible fallback.
  const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(xdgState, 'Claudes', 'logs');
}
let diagLogStream = null;
let diagLogFilePath = null;
function diagLogInit() {
  try {
    const dir = diagLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'claudes.log');
    // Roll if >5MB so the file doesn't grow forever.
    try {
      const st = fs.statSync(file);
      if (st.size > 5 * 1024 * 1024) {
        try { fs.unlinkSync(file + '.old'); } catch {}
        fs.renameSync(file, file + '.old');
      }
    } catch {}
    diagLogStream = fs.createWriteStream(file, { flags: 'a' });
    diagLogFilePath = file;
    diagLogStream.write(`\n=== ${new Date().toISOString()} Claudes launch pid=${process.pid} platform=${process.platform} ===\n`);
  } catch (e) {
    // Logging is best-effort — never let it break startup.
    console.error('[diagLog] init failed:', e && e.message);
  }
}
function diagLog(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
  console.log(line);
  if (diagLogStream) {
    try { diagLogStream.write(new Date().toISOString() + ' ' + line + '\n'); } catch {}
  }
}
diagLogInit();

// Lightweight perf instrumentation. Every PERF_SAMPLE_MS we ask Electron
// for per-process CPU/memory and log a single line. Hook traffic is
// counted between samples so we can see throughput.
//
// To read each [perf] line: "tails=N hooks=H | Browser cpu=X% mem=YMB;
// Renderer cpu=X% mem=YMB; …". Sustained high CPU on one process points
// at where to look (Browser = Electron main; Renderer = the window's UI).
const PERF_SAMPLE_MS = 15_000;
let perfHookCount = 0;
let perfFsEvents = 0;        // raw fs.watch callbacks
let perfCtxReads = 0;        // session:contextTokens IPC handler calls (cache + miss)
function incrPerfHook() { perfHookCount++; }
function incrPerfFsEvent() { perfFsEvents++; }
function incrPerfCtxRead() { perfCtxReads++; }
function perfSample() {
  try {
    const metrics = (typeof app !== 'undefined' && app.getAppMetrics) ? app.getAppMetrics() : [];
    const procs = metrics.map((m) => {
      const cpu = m.cpu && typeof m.cpu.percentCPUUsage === 'number' ? m.cpu.percentCPUUsage.toFixed(1) : '?';
      const memMB = m.memory && m.memory.workingSetSize ? Math.round(m.memory.workingSetSize / 1024) : '?';
      // type values: Browser, Renderer, GPU, Utility, Tab, Zygote
      const label = m.type + (m.name ? ('/' + m.name.replace(/\s+/g, '')) : '');
      return label + ' cpu=' + cpu + '% mem=' + memMB + 'MB';
    });
    const cols = (typeof clawdTails !== 'undefined' && clawdTails.size) || 0;
    const ctxStats = (typeof sampleAndResetReadStats === 'function') ? sampleAndResetReadStats() : { fullReads: 0, bytesRead: 0 };
    const ctxMB = ctxStats.bytesRead >= 1024 * 1024
      ? (ctxStats.bytesRead / (1024 * 1024)).toFixed(1) + 'MB'
      : Math.round(ctxStats.bytesRead / 1024) + 'KB';
    diagLog('[perf] tails=' + cols
      + ' hooks=' + perfHookCount
      + ' fsEvents=' + perfFsEvents
      + ' ctxReads=' + perfCtxReads + '/' + ctxStats.fullReads + 'full(' + ctxMB + ')'
      + ' | ' + procs.join('; '));
  } catch (err) {
    diagLog('[perf] sample failed:', err && err.message);
  }
  perfHookCount = 0;
  perfFsEvents = 0;
  perfCtxReads = 0;
}
// Schedule once app is ready so getAppMetrics has the full process tree.
if (typeof app !== 'undefined') {
  app.whenReady().then(() => {
    setInterval(perfSample, PERF_SAMPLE_MS).unref();
    // First sample after 5s — lets startup quiesce before we baseline.
    setTimeout(perfSample, 5000).unref();
  });
}

// Surface uncaught failures so silent crashes leave a trail on disk.
process.on('uncaughtException', (err) => {
  diagLog('[crash] uncaughtException:', err && (err.stack || err.message || String(err)));
});
process.on('unhandledRejection', (reason) => {
  diagLog('[crash] unhandledRejection:', reason && (reason.stack || reason.message || String(reason)));
});

// Per-launch auth token for the local pty-server WebSocket. Generated fresh
// each time Electron starts, passed to pty-server via env, and handed to the
// renderer via IPC. The renderer presents it as a Sec-WebSocket-Protocol on
// connect; pty-server rejects the handshake if it doesn't match. Without
// this, any local process (including any web page in any browser) could
// connect to 127.0.0.1:<ptyPort> and spawn arbitrary commands as the user.
const PTY_AUTH_TOKEN = crypto.randomBytes(32).toString('hex');

// Per-launch token gating the local hook HTTP server (POST /hook). Without this,
// any local process — including a JS payload running in any browser tab — could
// fabricate a hook event that gets forwarded into the renderer over IPC, which
// is exactly the cross-process attack surface Electron CSP doesn't cover.
// Token is included in the curl command we write into the user's settings.json,
// re-synced on every launch (same flow as the port). Re-syncs cost one file
// write at startup, which is negligible.
const HOOK_AUTH_TOKEN = crypto.randomBytes(32).toString('hex');

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
const PIPELINES_FILE = path.join(CONFIG_DIR, app.isPackaged ? 'pipelines.json' : 'pipelines-dev.json');
const DEFAULT_PIPELINES = {
  version: 1,
  pipeline: {
    id: 'default',
    name: 'Default workflow',
    userSteps: [
      { id: 'anchor-plan', label: 'Plan', keywords: [] },
      { id: 'anchor-execute', label: 'Execute', keywords: [] }
    ]
  }
};
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

// Exposed to the renderer so the endpoint-presets UI can warn the user when
// tokens will be stored plaintext (typical on Linux without a keyring, or in
// headless WSL). Backed by Electron's safeStorage — DPAPI on win32, Keychain
// on darwin, libsecret on Linux when present.
ipcMain.handle('security:isTokenStorageEncrypted', () => {
  try { return safeStorage.isEncryptionAvailable(); }
  catch { return false; }
});

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
  // macOS GUI apps launched from Finder/Dock inherit a minimal PATH that
  // omits Homebrew and nvm, so plain `which node` fails and a bare `node`
  // spawn ENOENTs. Augment PATH with the usual install dirs before probing,
  // and fall back to scanning known locations directly.
  const extraDirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    path.join(os.homedir(), '.volta/bin'),
    path.join(os.homedir(), '.fnm'),
    path.join(os.homedir(), 'n/bin'),
  ];
  const augmentedPath = [process.env.PATH || '', ...extraDirs]
    .filter(Boolean)
    .join(path.delimiter);

  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['node'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: augmentedPath },
    });
    const found = result.trim().split(/\r?\n/)[0];
    if (found) return found;
  } catch { /* fall through to direct probing */ }

  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];

  try {
    const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
    const versions = fs.readdirSync(nvmDir)
      .filter((v) => v.startsWith('v'))
      .sort()
      .reverse();
    for (const v of versions) {
      candidates.push(path.join(nvmDir, v, 'bin/node'));
    }
  } catch { /* no nvm install */ }

  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* not present */ }
  }

  return 'node';
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
    let resolved = false;

    // Opt-in: pty-server runs `claude update` on every startup if this env
    // is '1'. Off by default to avoid running whichever `claude` binary is
    // first on PATH unprompted. See Settings → Updates.
    const autoUpdateClaude = readConfig().autoUpdateClaude === true ? '1' : '0';
    ptyServerProcess = spawn(nodePath, [serverScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PTY_PORT: String(ptyPort), PTY_AUTH_TOKEN, CLAUDES_AUTO_UPDATE_CLAUDE: autoUpdateClaude }
    });

    ptyServerProcess.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        dialog.showErrorBox(
          'Node.js not found',
          `Claudes needs Node.js to run its terminal server, but couldn't find a "node" binary.\n\n` +
          `Tried: ${nodePath}\n\n` +
          `Install Node.js (e.g. via Homebrew: "brew install node") and relaunch Claudes.`
        );
      } else {
        dialog.showErrorBox('Failed to start terminal server', String(err && err.message || err));
      }
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    ptyServerProcess.stderr.on('data', (data) => {
      const s = data.toString();
      console.error('[pty-server]', s);
      if (diagLogStream) { try { diagLogStream.write(new Date().toISOString() + ' [pty-server:stderr] ' + s.trimEnd() + '\n'); } catch {} }
    });

    ptyServerProcess.on('exit', (code, signal) => {
      diagLog('[pty-server] exited with code', code, 'signal', signal || '(none)');
    });

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

// Defense-in-depth: prevent renderer-induced navigation away from the
// loaded index.html and refuse all window.open / target=_blank requests.
// shell.openExternal is the only sanctioned way to escape the app.
function lockdownWebContents(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
        shell.openExternal(parsed.toString()).catch(() => {});
      }
    } catch { /* ignore unparseable URLs */ }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    // Allow navigation only within the app's own file:// origin (initial load).
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'file:') {
        event.preventDefault();
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
          shell.openExternal(parsed.toString()).catch(() => {});
        }
      }
    } catch {
      event.preventDefault();
    }
  });
  // Refuse webview tag attachment outright — there are none today, but if a
  // future template snuck one in we don't want it inheriting privileges.
  wc.on('will-attach-webview', (event /*, webPreferences, params*/) => {
    event.preventDefault();
  });
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
      nodeIntegration: false,
      // Defence-in-depth: run the renderer in the OS sandbox. The preload only
      // talks to main via contextBridge + ipcRenderer.invoke, both of which are
      // sandbox-compatible, so this is a free upgrade.
      sandbox: true,
      // Off: we don't need Google's spell-check service phoning home, and
      // we don't use <webview> at all.
      spellcheck: false,
      webviewTag: false
    }
  });

  // xterm captures these at the renderer; intercept here so F11/Esc still work.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.alt || input.control || input.meta || input.shift) return;
    if (input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'Escape' && mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
      event.preventDefault();
    }
  });

  lockdownWebContents(mainWindow.webContents);
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
      nodeIntegration: false,
      // Defence-in-depth: run the renderer in the OS sandbox. The preload only
      // talks to main via contextBridge + ipcRenderer.invoke, both of which are
      // sandbox-compatible, so this is a free upgrade.
      sandbox: true,
      // Off: we don't need Google's spell-check service phoning home, and
      // we don't use <webview> at all.
      spellcheck: false,
      webviewTag: false
    }
  });

  // xterm captures these at the renderer; intercept here so F11/Esc still work.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.alt || input.control || input.meta || input.shift) return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'Escape' && win.isFullScreen()) {
      win.setFullScreen(false);
      event.preventDefault();
    }
  });

  lockdownWebContents(win.webContents);
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
  // The renderer doesn't manage sync state — those fields are written via
  // the dedicated sync:* IPC handlers. If we accept the renderer's payload
  // verbatim every column close/resize would clobber sync.sourcePath and
  // per-project syncExport/syncImports. Merge the on-disk authoritative
  // sync state back on top before persisting.
  try {
    const onDisk = readConfig();
    if (onDisk && onDisk.sync) config.sync = onDisk.sync;
    const onDiskByPath = new Map();
    for (const p of (onDisk.projects || [])) {
      if (p && p.path) onDiskByPath.set(p.path, p);
    }
    for (const p of (config.projects || [])) {
      if (!p || !p.path) continue;
      const auth = onDiskByPath.get(p.path);
      if (auth) {
        if ('syncExport' in auth) p.syncExport = auth.syncExport;
        if ('syncImports' in auth) p.syncImports = auth.syncImports;
      }
    }
  } catch (err) { console.error('sync-preserve merge failed:', err); }

  scheduleWriteConfig(config);
  // A project's sync flags may have just changed — re-apply watchers so the
  // change takes effect without an app restart. Cheap when nothing relevant
  // moved; lib/sync stops + restarts per-project watchers atomically.
  try { reapplySyncFromConfig(config); } catch (err) { console.error('sync re-apply failed:', err); }
});

// --- Cross-device session sync ---
//
// Glues lib/sync.js to the IPC layer. Global settings (sync source path,
// device name) live on the root of projects.json alongside `projects`.
// Per-project state lives on each project entry as { syncExport, syncImports }.

const sessionSync = require('./lib/sync');

function syncLog(line) { console.log(line); }

function reapplySyncFromConfig(cfg) {
  const c = cfg || readConfig();
  const settings = (c && c.sync) || {};
  sessionSync.applyAllProjects({
    homedir: os.homedir(),
    projects: c.projects || [],
    syncSource: settings.sourcePath || null,
    deviceName: settings.deviceName || null,
    log: syncLog
  });
}

ipcMain.handle('sync:getSettings', () => {
  const cfg = readConfig();
  const s = (cfg && cfg.sync) || {};
  return {
    sourcePath: s.sourcePath || '',
    deviceName: s.deviceName || os.hostname() || ''
  };
});

ipcMain.handle('sync:setSettings', (_event, settings) => {
  if (!settings || typeof settings !== 'object') return { error: 'invalid settings' };
  const cfg = readConfig();
  cfg.sync = {
    sourcePath: typeof settings.sourcePath === 'string' ? settings.sourcePath : '',
    deviceName: typeof settings.deviceName === 'string' && settings.deviceName.trim()
      ? settings.deviceName.trim()
      : (os.hostname() || 'device')
  };
  writeConfig(cfg);
  reapplySyncFromConfig(cfg);
  return cfg.sync;
});

ipcMain.handle('sync:browseFolder', async (_event, opts) => {
  const defaultPath = (opts && opts.defaultPath) || os.homedir();
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('sync:setProjectExport', (_event, projectPath, enabled) => {
  const cfg = readConfig();
  const project = (cfg.projects || []).find((p) => p && p.path === projectPath);
  if (!project) return { error: 'project not found' };
  project.syncExport = !!enabled;
  writeConfig(cfg);
  reapplySyncFromConfig(cfg);
  return { ok: true };
});

ipcMain.handle('sync:addProjectImport', (_event, projectPath, importFolder) => {
  if (!importFolder) return { error: 'no folder' };
  const cfg = readConfig();
  const project = (cfg.projects || []).find((p) => p && p.path === projectPath);
  if (!project) return { error: 'project not found' };
  if (!Array.isArray(project.syncImports)) project.syncImports = [];
  if (!project.syncImports.includes(importFolder)) {
    project.syncImports.push(importFolder);
  }
  writeConfig(cfg);
  reapplySyncFromConfig(cfg);
  return { ok: true, imports: project.syncImports };
});

ipcMain.handle('sync:removeProjectImport', (_event, projectPath, importFolder) => {
  const cfg = readConfig();
  const project = (cfg.projects || []).find((p) => p && p.path === projectPath);
  if (!project) return { error: 'project not found' };
  project.syncImports = (project.syncImports || []).filter((p) => p !== importFolder);
  writeConfig(cfg);
  reapplySyncFromConfig(cfg);
  return { ok: true, imports: project.syncImports };
});

ipcMain.handle('sync:getProjectStatus', (_event, projectPath) => {
  const cfg = readConfig();
  const project = (cfg.projects || []).find((p) => p && p.path === projectPath);
  const settings = (cfg && cfg.sync) || {};
  if (!project) return { syncExport: false, syncImports: [], exportFolder: null };
  return {
    syncExport: !!project.syncExport,
    syncImports: project.syncImports || [],
    exportFolder: sessionSync.resolveExportFolder(
      settings.sourcePath || '',
      settings.deviceName || os.hostname() || '',
      project.name || path.basename(project.path)
    )
  };
});

ipcMain.handle('sync:forceProject', async (_event, projectPath) => {
  return sessionSync.forceSyncProject(projectPath, { log: syncLog });
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

ipcMain.handle('pipelines:get', () => {
  ensureConfigDir();
  try {
    const raw = fs.readFileSync(PIPELINES_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.pipeline && Array.isArray(data.pipeline.userSteps)) {
      const steps = data.pipeline.userSteps;
      const hasPlan = steps.some(s => s && s.id === 'anchor-plan');
      const hasExec = steps.some(s => s && s.id === 'anchor-execute');
      if (!hasPlan) steps.unshift({ id: 'anchor-plan', label: 'Plan', keywords: [] });
      if (!hasExec) {
        const planIdx = steps.findIndex(s => s && s.id === 'anchor-plan');
        steps.splice(planIdx + 1, 0, { id: 'anchor-execute', label: 'Execute', keywords: [] });
      }
      return data;
    }
  } catch (e) { /* file missing, parse error, wrong shape */ }
  return DEFAULT_PIPELINES;
});

ipcMain.handle('pipelines:save', (event, data) => {
  ensureConfigDir();
  // Pass-through unknown top-level fields (forward compat); ensure shape on key fields.
  const incoming = (data && typeof data === 'object') ? data : {};
  const pipeline = (incoming.pipeline && typeof incoming.pipeline === 'object')
    ? incoming.pipeline
    : { id: 'default', name: 'Default workflow', userSteps: [
        { id: 'anchor-plan', label: 'Plan', keywords: [] },
        { id: 'anchor-execute', label: 'Execute', keywords: [] }
      ] };
  const userSteps = Array.isArray(pipeline.userSteps) ? pipeline.userSteps : [];
  const payload = {
    ...incoming,
    version: typeof incoming.version === 'number' ? incoming.version : 1,
    pipeline: {
      ...pipeline,
      id: pipeline.id || 'default',
      name: pipeline.name || 'Default workflow',
      userSteps: userSteps
    }
  };
  const tmp = PIPELINES_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, PIPELINES_FILE);
    return true;
  } catch (err) {
    console.error('pipelines:save failed:', err);
    return false;
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
  // In dev (`npm start`), process.execPath is the bundled electron.exe with no
  // app-path arg, so any registration would launch Electron's default welcome
  // screen on boot. Pretend the setting is off so the UI stays consistent with
  // setStartWithOS being a no-op.
  if (!app.isPackaged) return false;
  // On Windows, getLoginItemSettings only reports openAtLogin: true when the
  // stored registry entry's args exactly match what we query with. Since the
  // setter writes ['--hidden'], the getter must query with ['--hidden'] too —
  // querying with the default [] silently returned false even when the
  // registry entry was present, so the checkbox un-ticked itself on every
  // re-open of the Settings modal. macOS ignores `args`, so this is a no-op
  // there.
  const lookup = process.platform === 'darwin' ? {} : { args: ['--hidden'] };
  return app.getLoginItemSettings(lookup).openAtLogin;
});

ipcMain.handle('app:setStartWithOS', (event, enabled) => {
  // Refuse to register a startup item from dev — process.execPath points at
  // node_modules\electron\dist\electron.exe and Windows would launch the
  // default Electron welcome screen on boot.
  if (!app.isPackaged) return;
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
  // Claude CLI uses the raw substitution, keeping any leading dashes — so
  // /Users/ashleypayne/Repos/Claudes becomes -Users-ashleypayne-Repos-Claudes
  // on macOS/Linux. The earlier `.replace(/^-+/, '')` stripped that leading
  // dash, making session discovery silently miss every directory on Unix
  // hosts (Windows paths start with a drive letter so they weren't affected).
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
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

// Read the LAST gitBranch recorded in a session JSONL. Tail-reads the file
// (last ~64KB) since Claude appends turns over time and the most recent
// branch is always near the end. Returns null on missing file / no match.
ipcMain.handle('git:detectSessionBranch', (event, projectPath, sessionId) => {
  if (!projectPath || !sessionId) return null;
  try {
    const claudeKey = projectPathToClaudeKey(projectPath);
    const jsonlPath = path.join(os.homedir(), '.claude', 'projects', claudeKey, sessionId + '.jsonl');
    const stat = fs.statSync(jsonlPath);
    const tailSize = Math.min(stat.size, 64 * 1024);
    if (tailSize === 0) return null;
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(tailSize);
      fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
      const content = buf.toString('utf8');
      return findLastGitBranch(content);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
});

// Phase 3: detect which worktree the session is actively working in by
// scanning the JSONL tail for `cd <path>` commands and `"file_path":"..."`
// entries. The Claude CLI's recorded gitBranch reflects ITS own cwd (project
// root) — useless for sessions that do their work via Bash `cd worktree && ...`.
ipcMain.handle('git:detectSessionWorktree', async (event, projectPath, sessionId) => {
  if (!projectPath || !sessionId) return null;
  try {
    const claudeKey = projectPathToClaudeKey(projectPath);
    const jsonlPath = path.join(os.homedir(), '.claude', 'projects', claudeKey, sessionId + '.jsonl');
    const stat = fs.statSync(jsonlPath);
    const tailSize = Math.min(stat.size, 512 * 1024);
    if (tailSize === 0) return null;
    const fd = fs.openSync(jsonlPath, 'r');
    let content;
    try {
      const buf = Buffer.alloc(tailSize);
      fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
      content = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const worktrees = await listGitWorktrees(projectPath);
    return detectActiveWorktree(content, worktrees);
  } catch {
    return null;
  }
});

// Save/load session state per project.
//
// Disk shape (synthesized v2): { version: 2, sessions: [...], rowHeightRatios: [...],
//   workspaces: { "<ws-id>": { sessions: [...], rowHeightRatios: [...] } } }
// Each session entry: { sessionId, title, rowIdx, widthRatio }
// Legacy shapes:
//   - HEAD-only v2 (pre-workspaces): { version: 2, rows: [{ heightRatio, columns: [...] }] }
//   - personal/main flat: { sessions: [...], workspaces: { id: { sessions: [...] } } }
//   - very old: bare array
// Renderer's persistSessions/restoreSessions handle promotion; main.js just persists the blob atomically
// (tmp+rename so a partial write can't corrupt multi-workspace state).
ipcMain.handle('sessions:save', (event, projectPath, blob) => {
  const safeBase = assertInsideAllowedRoots(projectPath);
  const claudesDir = path.join(safeBase, '.claudes');
  if (!fs.existsSync(claudesDir)) {
    fs.mkdirSync(claudesDir, { recursive: true });
  }
  const target = path.join(claudesDir, 'sessions.json');
  const tmp = target + '.tmp';
  // Accept either the new blob shape or a bare array (legacy callers).
  // Spread the input first so top-level fields like `version` and `rowHeightRatios`
  // round-trip; then overwrite `sessions` and `workspaces` with defensive defaults.
  const payload = Array.isArray(blob)
    ? { sessions: blob, workspaces: {} }
    : {
        ...((blob && typeof blob === 'object') ? blob : {}),
        sessions: Array.isArray(blob && blob.sessions) ? blob.sessions : [],
        workspaces: (blob && blob.workspaces && typeof blob.workspaces === 'object') ? blob.workspaces : {}
      };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, target);
});

ipcMain.handle('sessions:load', (event, projectPath) => {
  try {
    const safeBase = assertInsideAllowedRoots(projectPath);
    const sessionsFile = path.join(safeBase, '.claudes', 'sessions.json');
    const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return {
        ...data,
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        workspaces: (data.workspaces && typeof data.workspaces === 'object') ? data.workspaces : {}
      };
    }
    return { sessions: [], workspaces: {} };
  } catch {
    return { sessions: [], workspaces: {} };
  }
});

// --- Sticky Notes Persistence ---
// Primary: <project>/.claudes/sticky-notes.json (back-compat with pre-workspaces users).
// Sub-workspace: <project>/.claudes/sticky-notes-<workspaceId>.json — one overlay per workspace.
// Writes are debounced per-(project, workspace), atomic (tmp + rename), and flushed on quit.
// Malformed JSON on load is quarantined to sticky-notes.corrupt-<ts>.json so user content isn't silently overwritten.
//
// personal-only: workspace awareness added on the personal/main branch so the
// mdrichardson fork ships a usable build before upstream rebases either
// feat/workspaces or feat/sticky-notes to absorb the same fix. See
// docs/superpowers/plans/2026-04-24-sticky-notes-workspace-aware-rebase.md
// (on feat/workspaces) for the upstream plan.

const STICKY_NOTES_WRITE_DEBOUNCE_MS = 400;
const pendingStickyNotes = new Map(); // stickyKey -> { projectPath, workspaceId, timer, notes }

function stickyKey(projectPath, workspaceId) {
  return (workspaceId == null) ? projectPath : (projectPath + '::' + workspaceId);
}

function stickyNotesFile(projectPath, workspaceId) {
  const dir = path.join(projectPath, '.claudes');
  return (workspaceId == null)
    ? path.join(dir, 'sticky-notes.json')
    : path.join(dir, 'sticky-notes-' + workspaceId + '.json');
}

function writeStickyNotesAtomic(projectPath, workspaceId, notes) {
  const claudesDir = path.join(projectPath, '.claudes');
  if (!fs.existsSync(claudesDir)) {
    fs.mkdirSync(claudesDir, { recursive: true });
  }
  const target = stickyNotesFile(projectPath, workspaceId);
  const tmp = target + '.tmp';
  const payload = JSON.stringify({ notes: Array.isArray(notes) ? notes : [] }, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, target);
}

function scheduleWriteStickyNotes(projectPath, workspaceId, notes) {
  const key = stickyKey(projectPath, workspaceId);
  const existing = pendingStickyNotes.get(key);
  if (existing && existing.timer) {
    clearTimeout(existing.timer);
  }
  const entry = { projectPath, workspaceId, notes, timer: null };
  entry.timer = setTimeout(() => {
    pendingStickyNotes.delete(key);
    try { writeStickyNotesAtomic(projectPath, workspaceId, entry.notes); } catch (err) { console.error('writeStickyNotes failed:', err); }
  }, STICKY_NOTES_WRITE_DEBOUNCE_MS);
  pendingStickyNotes.set(key, entry);
}

function flushPendingStickyNotes() {
  for (const [, entry] of pendingStickyNotes.entries()) {
    if (entry.timer) clearTimeout(entry.timer);
    try { writeStickyNotesAtomic(entry.projectPath, entry.workspaceId, entry.notes); } catch (err) { console.error('writeStickyNotes failed:', err); }
  }
  pendingStickyNotes.clear();
}

ipcMain.handle('sticky-notes:load', (event, projectPath, workspaceId) => {
  const notesFile = stickyNotesFile(projectPath, workspaceId);
  if (!fs.existsSync(notesFile)) return [];
  let raw;
  try {
    raw = fs.readFileSync(notesFile, 'utf8');
  } catch {
    return [];
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    try {
      const corrupt = path.join(projectPath, '.claudes',
        'sticky-notes' + (workspaceId == null ? '' : '-' + workspaceId) + '.corrupt-' + Date.now() + '.json');
      fs.renameSync(notesFile, corrupt);
    } catch (err) {
      console.error('sticky-notes quarantine failed:', err);
    }
    return [];
  }
  const notes = Array.isArray(data && data.notes) ? data.notes : [];
  // Forward-compat defaults for v1 files that lack new keys.
  return notes.map((n) => {
    const out = {
      id: n.id,
      content: typeof n.content === 'string' ? n.content : '',
      x: typeof n.x === 'number' ? n.x : 20,
      y: typeof n.y === 'number' ? n.y : 20,
      width: typeof n.width === 'number' ? n.width : 240,
      height: typeof n.height === 'number' ? n.height : 180,
      color: typeof n.color === 'string' ? n.color : 'yellow',
      fontSize: typeof n.fontSize === 'number' ? n.fontSize : 15
    };
    if (n.anchor && typeof n.anchor === 'object') out.anchor = n.anchor;
    return out;
  });
});

ipcMain.handle('sticky-notes:save', (event, projectPath, workspaceId, notes) => {
  scheduleWriteStickyNotes(projectPath, workspaceId, notes);
});

// --- Review Comments Persistence ---
// Per-(workspace, session, scope) JSON files under <project>/.claudes/.
// Filename rules:
//   wsId=null,  sid=known,    scope=working      -> review-comments-<sid>.json
//   wsId=ws,    sid=known,    scope=working      -> review-comments-<ws>-<sid>.json
//   wsId=null,  sid=known,    scope=commit-X     -> review-comments-<sid>-commit-<hash7>.json
//   wsId=ws,    sid=known,    scope=commit-X     -> review-comments-<ws>-<sid>-commit-<hash7>.json
//   wsId=null,  sid=null,     scope=working,col  -> review-comments-pending-<colId>.json
//   wsId=ws,    sid=null,     scope=working,col  -> review-comments-<ws>-pending-<colId>.json
//   wsId=null,  sid=no-session,scope=working     -> review-comments-no-session.json
// Writes are debounced per-(project, ws, sid|colId, scope), atomic (tmp+rename), flushed on quit.
// Read-modify-write merges incoming with existing on disk so popout + main editing same session
// don't silently overwrite each other; source (incoming) wins on id conflict.
// Malformed JSON on load is quarantined to <filename>.corrupt-<ts>.json.

const REVIEW_COMMENTS_WRITE_DEBOUNCE_MS = 400;
const pendingReviewComments = new Map();

function reviewCommentsKey(projectPath, workspaceId, sessionId, scope, colId) {
  return projectPath + '::' +
    (workspaceId == null ? '' : workspaceId) + '::' +
    (sessionId == null ? '' : sessionId) + '::' +
    (scope || '') + '::' +
    (colId == null ? '' : colId);
}

function reviewCommentsFile(projectPath, workspaceId, sessionId, scope, colId) {
  const dir = path.join(projectPath, '.claudes');
  const wsPrefix = (workspaceId == null) ? '' : (workspaceId + '-');
  let basename;
  if (sessionId == null) {
    // Pending (no session yet) — colId required
    basename = 'review-comments-' + wsPrefix + 'pending-' + colId + '.json';
  } else {
    // Known session id (or 'no-session' sentinel)
    if (scope === 'working') {
      basename = 'review-comments-' + wsPrefix + sessionId + '.json';
    } else {
      // scope is 'commit-<hash7>' — caller composed it; we suffix the basename
      basename = 'review-comments-' + wsPrefix + sessionId + '-' + scope + '.json';
    }
  }
  return path.join(dir, basename);
}

function writeReviewCommentsAtomic(projectPath, workspaceId, sessionId, scope, comments, colId) {
  const claudesDir = path.join(projectPath, '.claudes');
  if (!fs.existsSync(claudesDir)) {
    fs.mkdirSync(claudesDir, { recursive: true });
  }
  const target = reviewCommentsFile(projectPath, workspaceId, sessionId, scope, colId);
  // Read-modify-write merge: source (incoming) wins on id conflict.
  const existing = ReviewComments.readReviewCommentsFromDisk(target);
  const merged = ReviewComments.migratePendingComments(
    Array.isArray(comments) ? comments : [],
    existing
  );
  const tmp = target + '.tmp';
  const payload = JSON.stringify({ comments: merged }, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, target);
}

function scheduleWriteReviewComments(projectPath, workspaceId, sessionId, scope, comments, colId) {
  const key = reviewCommentsKey(projectPath, workspaceId, sessionId, scope, colId);
  const existing = pendingReviewComments.get(key);
  if (existing && existing.timer) {
    clearTimeout(existing.timer);
  }
  const entry = { projectPath, workspaceId, sessionId, scope, colId, comments, timer: null };
  entry.timer = setTimeout(() => {
    pendingReviewComments.delete(key);
    try {
      writeReviewCommentsAtomic(projectPath, workspaceId, sessionId, scope, entry.comments, colId);
    } catch (err) {
      console.error('writeReviewComments failed:', err);
    }
  }, REVIEW_COMMENTS_WRITE_DEBOUNCE_MS);
  pendingReviewComments.set(key, entry);
}

function flushPendingReviewComments() {
  for (const [, entry] of pendingReviewComments.entries()) {
    if (entry.timer) clearTimeout(entry.timer);
    try {
      writeReviewCommentsAtomic(entry.projectPath, entry.workspaceId, entry.sessionId, entry.scope, entry.comments, entry.colId);
    } catch (err) {
      console.error('writeReviewComments failed:', err);
    }
  }
  pendingReviewComments.clear();
}

function validateReviewSegments(workspaceId, sessionId, scope, colId) {
  if (workspaceId != null) ReviewComments.safeIdSegment(workspaceId);
  if (sessionId != null) ReviewComments.safeIdSegment(sessionId);
  if (colId != null) ReviewComments.safeIdSegment(colId);
  if (scope != null && scope !== 'working') {
    // Commit scope: split 'commit-<hash7>' and validate the hash segment.
    if (typeof scope !== 'string' || scope.indexOf('commit-') !== 0) {
      throw new Error('invalid scope: ' + scope);
    }
    const hash = scope.slice('commit-'.length);
    ReviewComments.safeIdSegment(hash);
  }
}

ipcMain.handle('review-comments:load', (event, projectPath, wsId, sessionId, scope, colId) => {
  try {
    validateReviewSegments(wsId, sessionId, scope, colId);
  } catch (err) {
    console.error('review-comments:load validation failed:', err);
    return [];
  }
  const file = reviewCommentsFile(projectPath, wsId, sessionId, scope, colId);
  return ReviewComments.readReviewCommentsFromDisk(file);
});

ipcMain.handle('review-comments:save', (event, projectPath, wsId, sessionId, scope, comments, colId) => {
  try {
    validateReviewSegments(wsId, sessionId, scope, colId);
  } catch (err) {
    console.error('review-comments:save validation failed:', err);
    return;
  }
  scheduleWriteReviewComments(projectPath, wsId, sessionId, scope, comments, colId);
});

// Rename per-column review-comments files when a column transitions from
// pending (no sessionId) -> resumed (sessionId), or oldSid -> newSid.
function migrateReviewCommentsForColumnImpl(projectPath, wsId, oldSid, newSid, colId) {
  if (oldSid == null && newSid == null) return { migrated: 0 };
  if (oldSid != null && newSid != null && oldSid === newSid) return { migrated: 0 };

  try {
    if (wsId != null) ReviewComments.safeIdSegment(wsId);
    if (oldSid != null) ReviewComments.safeIdSegment(oldSid);
    if (newSid != null) ReviewComments.safeIdSegment(newSid);
    if (colId != null) ReviewComments.safeIdSegment(colId);
  } catch (err) {
    console.error('migrateReviewCommentsForColumn validation failed:', err);
    return { migrated: 0 };
  }

  const claudesDir = path.join(projectPath, '.claudes');
  if (!fs.existsSync(claudesDir)) return { migrated: 0 };
  const wsPrefix = (wsId == null) ? '' : (wsId + '-');
  let migrated = 0;

  if (oldSid == null && newSid != null) {
    // pending -> known session
    if (colId == null) return { migrated: 0 };
    const pendingBase = 'review-comments-' + wsPrefix + 'pending-' + colId + '.json';
    const pendingPath = path.join(claudesDir, pendingBase);
    if (!fs.existsSync(pendingPath)) return { migrated: 0 };
    const targetBase = 'review-comments-' + wsPrefix + newSid + '.json';
    const targetPath = path.join(claudesDir, targetBase);
    try {
      const srcArr = ReviewComments.readReviewCommentsFromDisk(pendingPath);
      const dstArr = ReviewComments.readReviewCommentsFromDisk(targetPath);
      const merged = ReviewComments.migratePendingComments(srcArr, dstArr);
      fs.writeFileSync(targetPath + '.tmp', JSON.stringify({ comments: merged }, null, 2), 'utf8');
      fs.renameSync(targetPath + '.tmp', targetPath);
      try { fs.unlinkSync(pendingPath); } catch (err) { console.error('migrate unlink pending failed:', err); }
      migrated++;
    } catch (err) {
      console.error('migrate pending->session failed:', err);
    }
    return { migrated };
  }

  if (oldSid != null && newSid != null && oldSid !== newSid) {
    // Find all files matching review-comments-<wsPrefix><oldSid>...
    const oldBaseStart = 'review-comments-' + wsPrefix + oldSid;
    let entries;
    try {
      entries = fs.readdirSync(claudesDir);
    } catch (err) {
      console.error('migrate readdir failed:', err);
      return { migrated: 0 };
    }
    for (const entry of entries) {
      if (!entry.startsWith(oldBaseStart)) continue;
      // Anything after oldBaseStart should start with '.' (just .json) or '-' (commit-...)
      // and must end in .json. Avoid e.g. matching a different sid that begins with oldSid.
      const tail = entry.slice(oldBaseStart.length);
      if (!tail.endsWith('.json')) continue;
      if (tail.length > 0 && tail[0] !== '.' && tail[0] !== '-') continue;
      const newEntry = 'review-comments-' + wsPrefix + newSid + tail;
      const oldPath = path.join(claudesDir, entry);
      const newPath = path.join(claudesDir, newEntry);
      try {
        const srcArr = ReviewComments.readReviewCommentsFromDisk(oldPath);
        const dstArr = ReviewComments.readReviewCommentsFromDisk(newPath);
        const merged = ReviewComments.migratePendingComments(srcArr, dstArr);
        fs.writeFileSync(newPath + '.tmp', JSON.stringify({ comments: merged }, null, 2), 'utf8');
        fs.renameSync(newPath + '.tmp', newPath);
        try { fs.unlinkSync(oldPath); } catch (err) { console.error('migrate unlink old failed:', err); }
        migrated++;
      } catch (err) {
        console.error('migrate oldSid->newSid failed for ' + entry + ':', err);
      }
    }
    return { migrated };
  }

  return { migrated: 0 };
}

// Flush any in-flight pending save for this column under the OLD identity
// (any scope, any colId), so we don't race the rename in migrateForColumn.
function flushPendingForColumn(projectPath, wsId, sessionId, colId) {
  for (const [key, entry] of Array.from(pendingReviewComments.entries())) {
    // Match if same project + workspace, AND same column under either
    // session id OR pending colId (covers both pending->real and real->real).
    if (entry.projectPath !== projectPath) continue;
    if ((entry.workspaceId || null) !== (wsId || null)) continue;
    var matchesSession = (sessionId != null && entry.sessionId === sessionId);
    var matchesColId = (colId != null && entry.colId === colId);
    if (!matchesSession && !matchesColId) continue;
    if (entry.timer) clearTimeout(entry.timer);
    pendingReviewComments.delete(key);
    try {
      writeReviewCommentsAtomic(entry.projectPath, entry.workspaceId, entry.sessionId, entry.scope, entry.comments, entry.colId);
    } catch (err) {
      console.error('flushPendingForColumn failed:', err);
    }
  }
}

ipcMain.handle('review-comments:migrateForColumn', (event, projectPath, wsId, oldSid, newSid, colId) => {
  flushPendingForColumn(projectPath, wsId, oldSid, colId);
  return migrateReviewCommentsForColumnImpl(projectPath, wsId, oldSid, newSid, colId);
});

// Scrub all sticky-notes-<wsId>* and review-comments-<wsId>-* artifacts for a workspace.
// Implementation lives in lib/review-comments.js so it's testable without booting Electron.
ipcMain.handle('workspace:scrubArtifacts', (event, projectPath, wsId) => {
  try {
    return ReviewComments.scrubArtifactsImpl(projectPath, wsId);
  } catch (err) {
    console.error('workspace:scrubArtifacts failed:', err);
    return { removed: 0 };
  }
});

// --- Named layouts (per project, persisted in projects.json) ---
//
// A layout snapshot is the user's chosen arrangement of rows / columns for a
// project: how many columns, what each spawns (claude vs custom cmd), the env
// it carries (endpoint preset, model), and any column title. Restoring a
// layout re-spawns those columns in the same shape — useful for "investigate
// bug X" vs "review PRs" workflows.

function listLayouts(projectPath) {
  const cfg = readConfig();
  const proj = (cfg.projects || []).find(p => p && p.path === projectPath);
  return (proj && Array.isArray(proj.layouts)) ? proj.layouts : [];
}
function saveLayouts(projectPath, layouts) {
  const cfg = readConfig();
  const proj = (cfg.projects || []).find(p => p && p.path === projectPath);
  if (!proj) return false;
  proj.layouts = Array.isArray(layouts) ? layouts : [];
  writeConfig(cfg);
  return true;
}

ipcMain.handle('layouts:list', (event, projectPath) => listLayouts(projectPath));
ipcMain.handle('layouts:save', (event, projectPath, name, layout) => {
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'name required' };
  if (!layout || typeof layout !== 'object') return { ok: false, error: 'layout required' };
  const existing = listLayouts(projectPath);
  const next = existing.filter(l => l.name !== name);
  next.push({ name: name.trim(), savedAt: Date.now(), layout });
  return { ok: saveLayouts(projectPath, next) };
});
ipcMain.handle('layouts:delete', (event, projectPath, name) => {
  const existing = listLayouts(projectPath);
  return { ok: saveLayouts(projectPath, existing.filter(l => l.name !== name)) };
});

// --- MCP server config (.mcp.json) ---
//
// .mcp.json lives at the project root and follows the Claude Code schema:
//   { "mcpServers": { "name": { "command", "args", "env", "transport" } } }
// We expose read/write IPCs so the renderer can offer a CRUD UI without
// users editing JSON by hand.
ipcMain.handle('mcp:read', (event, projectPath) => {
  try {
    const safeBase = assertInsideAllowedRoots(projectPath);
    const filePath = path.join(safeBase, '.mcp.json');
    if (!fs.existsSync(filePath)) return { exists: false, mcpServers: {} };
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return { exists: true, mcpServers: (data && data.mcpServers) || {} };
  } catch (err) {
    return { exists: false, mcpServers: {}, error: err && err.message };
  }
});

ipcMain.handle('mcp:write', (event, projectPath, mcpServers) => {
  try {
    const safeBase = assertInsideAllowedRoots(projectPath);
    if (!mcpServers || typeof mcpServers !== 'object') return { ok: false, error: 'mcpServers must be an object' };
    // Re-read existing file to preserve top-level keys we don't manage (e.g. some
    // forks store additional settings here). Fall back to a fresh object when absent.
    const filePath = path.join(safeBase, '.mcp.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { /* missing or malformed — overwrite from scratch */ }
    const out = Object.assign({}, existing, { mcpServers });
    fs.writeFileSync(filePath, JSON.stringify(out, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
});

// --- Claude Code extensions discovery ---
// Lists files under .claude/{agents,skills,commands} both project-local and
// global (~/.claude). The renderer uses this to surface a unified manager UI
// without each request scanning each scope separately.
ipcMain.handle('extensions:list', (event, projectPath) => {
  const out = { agents: [], skills: [], commands: [] };

  function scanScope(baseDir, scope) {
    function scanCategory(category) {
      const dir = path.join(baseDir, category);
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          // skills/<name>/SKILL.md style
          const skillFile = path.join(full, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            out[category].push({ name: e.name, path: skillFile, scope });
            continue;
          }
          // commands can also be nested directories (subdirs of namespaced commands)
          try {
            const inner = fs.readdirSync(full, { withFileTypes: true });
            for (const i of inner) {
              if (i.isFile() && (i.name.endsWith('.md') || i.name.endsWith('.json'))) {
                out[category].push({ name: e.name + '/' + i.name.replace(/\.(md|json)$/, ''), path: path.join(full, i.name), scope });
              }
            }
          } catch { /* unreadable */ }
        } else if (e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.json'))) {
          out[category].push({ name: e.name.replace(/\.(md|json)$/, ''), path: full, scope });
        }
      }
    }
    scanCategory('agents');
    scanCategory('skills');
    scanCategory('commands');
  }

  // Global first so project entries shadow global ones with the same name in
  // the renderer's grouping. .claude is always an allowed root.
  scanScope(path.join(os.homedir(), '.claude'), 'global');
  try {
    if (projectPath) {
      const safe = assertInsideAllowedRoots(projectPath);
      scanScope(path.join(safe, '.claude'), 'project');
    }
  } catch { /* project scope unavailable */ }
  return out;
});

// Create a new extension file from a tiny template so the manager UI can
// produce something the user can immediately edit.
ipcMain.handle('extensions:create', (event, projectPath, category, name, scope) => {
  if (!['agents', 'skills', 'commands'].includes(category)) return { ok: false, error: 'bad category' };
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.\-]+$/.test(name)) {
    return { ok: false, error: 'invalid name' };
  }
  let baseDir;
  if (scope === 'global') baseDir = path.join(os.homedir(), '.claude');
  else {
    try { baseDir = path.join(assertInsideAllowedRoots(projectPath), '.claude'); }
    catch { return { ok: false, error: 'project path not allowed' }; }
  }
  const dir = path.join(baseDir, category);
  let filePath;
  let content;
  if (category === 'skills') {
    filePath = path.join(dir, name, 'SKILL.md');
    content = '---\nname: ' + name + '\ndescription: A short summary of when to use this skill.\n---\n\n# ' + name + '\n\nReplace this with the skill body.\n';
    try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); }
    catch { /* exists */ }
  } else {
    filePath = path.join(dir, name + '.md');
    content = category === 'agents'
      ? '---\nname: ' + name + '\ndescription: Triggered when the user wants…\nmodel: sonnet\n---\n\nYou are a focused sub-agent that…\n'
      : '# /' + name + '\n\nReplace this with the slash-command body. The user invokes it as `/' + name + '` from the chat.\n';
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch { /* exists */ }
  }
  if (fs.existsSync(filePath)) return { ok: false, error: 'already exists', path: filePath };
  try { fs.writeFileSync(filePath, content, 'utf8'); }
  catch (err) { return { ok: false, error: err && err.message }; }
  return { ok: true, path: filePath };
});

ipcMain.handle('extensions:delete', (event, targetPath) => {
  let safe;
  try { safe = assertInsideAllowedRoots(targetPath); }
  catch { return { ok: false, error: 'forbidden' }; }
  // Only allow under a .claude/ directory — extra guard so a compromised
  // renderer can't ask us to delete arbitrary files via this IPC.
  if (!/[\\/]\.claude[\\/]/.test(safe)) return { ok: false, error: 'not inside .claude' };
  try {
    const st = fs.statSync(safe);
    if (st.isDirectory()) fs.rmSync(safe, { recursive: true, force: true });
    else fs.unlinkSync(safe);
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
  return { ok: true };
});

// --- CLAUDE.md Management ---

// Sentinel passed by the renderer when it wants to edit the global
// ~/.claude/CLAUDE.md (a Claude CLI feature: instructions that apply to every
// project). Resolved here so we never expose the home path directly to the
// renderer and so assertInsideAllowedRoots still gates writes.
const GLOBAL_CLAUDEMD_SENTINEL = '__GLOBAL__';
function resolveClaudeMdRoot(arg) {
  if (arg === GLOBAL_CLAUDEMD_SENTINEL) {
    return path.join(os.homedir(), '.claude');
  }
  return arg;
}

ipcMain.handle('claudemd:read', (event, projectPath) => {
  try {
    const safeBase = assertInsideAllowedRoots(resolveClaudeMdRoot(projectPath));
    const filePath = path.join(safeBase, 'CLAUDE.md');
    if (!fs.existsSync(filePath)) return { exists: false, content: '' };
    return { exists: true, content: fs.readFileSync(filePath, 'utf8') };
  } catch {
    return { exists: false, content: '' };
  }
});

ipcMain.handle('claudemd:save', (event, projectPath, content) => {
  try {
    const safeBase = assertInsideAllowedRoots(resolveClaudeMdRoot(projectPath));
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

// Minimal .gitignore matcher. Implements the common subset:
//   - blank / # comments skipped
//   - trailing /  : matches directories only
//   - leading /   : anchored to the gitignore root
//   - bare name   : matches by basename anywhere in the tree
//   - patterns with / (not leading): anchored relative to gitignore root
//   - * wildcards inside a segment (no cross-segment ** support here)
//   - ! negation is honoured (later rule wins)
// Always implicitly ignores .git and node_modules so even repos without a
// .gitignore don't flood the explorer.
const GITIGNORE_CACHE = new Map(); // rootDir -> { mtime, rules }
const ALWAYS_IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.next', '.nuxt', 'dist', '.cache', 'coverage', '.venv', 'venv', 'target']);

function compileGitignorePattern(line) {
  let neg = false;
  if (line.startsWith('!')) { neg = true; line = line.slice(1); }
  let dirOnly = false;
  if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
  let anchored = false;
  if (line.startsWith('/')) { anchored = true; line = line.slice(1); }
  // If the pattern contains a slash (and isn't bare), it's anchored from root.
  if (!anchored && line.includes('/')) anchored = true;
  // Escape regex metachars except `*` and `?`, then translate globs.
  const re = line.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  let pattern;
  if (anchored) {
    // Match against the relative path from gitignore root.
    pattern = '^' + re + '(/.*)?$';
  } else {
    // Match against any path segment by basename, OR by trailing path component.
    pattern = '(^|/)' + re + '(/.*)?$';
  }
  return { neg, dirOnly, re: new RegExp(pattern) };
}

function loadGitignoreRules(root) {
  const file = path.join(root, '.gitignore');
  let stat;
  try { stat = fs.statSync(file); }
  catch { GITIGNORE_CACHE.set(root, { mtime: 0, rules: [] }); return []; }
  const cached = GITIGNORE_CACHE.get(root);
  if (cached && cached.mtime === stat.mtimeMs) return cached.rules;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { /* race condition — proceed empty */ }
  const rules = raw.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      try { return compileGitignorePattern(l); }
      catch { return null; }
    })
    .filter(Boolean);
  GITIGNORE_CACHE.set(root, { mtime: stat.mtimeMs, rules });
  return rules;
}

function isIgnoredByGitignore(rules, relPath, isDir) {
  // Normalise to forward slashes (gitignore patterns use /).
  const p = relPath.split(path.sep).join('/');
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(p)) ignored = !r.neg;
  }
  return ignored;
}

ipcMain.handle('fs:readDir', (event, dirPath) => {
  try {
    const safe = assertInsideAllowedRoots(dirPath);
    const entries = fs.readdirSync(safe, { withFileTypes: true });
    // Walk up to find a gitignore root: the nearest configured project that
    // contains `safe`. Falls back to `safe` itself if it's a project root.
    let gitRoot = safe;
    try {
      const cfg = readConfig();
      if (Array.isArray(cfg.projects)) {
        for (const p of cfg.projects) {
          if (p && typeof p.path === 'string' && isInsideRoot(safe, path.resolve(p.path))) {
            gitRoot = path.resolve(p.path);
            break;
          }
        }
      }
    } catch { /* fall through */ }
    const rules = loadGitignoreRules(gitRoot);
    return entries
      .filter(e => !ALWAYS_IGNORED_DIRS.has(e.name))
      .filter(e => {
        const full = path.join(safe, e.name);
        const rel = path.relative(gitRoot, full);
        return !isIgnoredByGitignore(rules, rel, e.isDirectory());
      })
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
  const rules = loadGitignoreRules(safeRoot);
  const results = [];
  const lowerQuery = String(query || '').toLowerCase();
  const MAX_RESULTS = 100;

  function walk(dir) {
    if (results.length >= MAX_RESULTS) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (results.length >= MAX_RESULTS) return;
        if (ALWAYS_IGNORED_DIRS.has(e.name)) continue;
        const fullPath = path.join(dir, e.name);
        const relativePath = path.relative(safeRoot, fullPath);
        if (isIgnoredByGitignore(rules, relativePath, e.isDirectory())) continue;
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

// fs.watch wiring for the active project root so the Explorer can refresh
// itself when files appear, disappear, or get renamed. One watcher per
// project root; events are coalesced to avoid spamming the renderer.
const FS_WATCHERS = new Map(); // root -> { watcher, timer }
const FS_WATCH_DEBOUNCE_MS = 250;

function emitFsChanged(root) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('fs:changed', root); } catch { /* window closing */ }
}

ipcMain.handle('fs:startWatch', (event, projectPath) => {
  let safe;
  try { safe = assertInsideAllowedRoots(projectPath); } catch { return { ok: false, error: 'forbidden' }; }
  if (FS_WATCHERS.has(safe)) return { ok: true, alreadyWatching: true };
  try {
    // recursive: true is the only sensible mode here. Supported on darwin/win32
    // natively, and on Linux since Node 20. Fall back to a non-recursive watcher
    // if the platform refuses recursive.
    let watcher;
    function onFsEvent() { incrPerfFsEvent(); scheduleEmit(); }
    try { watcher = fs.watch(safe, { recursive: true }, onFsEvent); }
    catch { watcher = fs.watch(safe, { recursive: false }, onFsEvent); }
    let timer = null;
    function scheduleEmit() {
      if (timer) return;
      timer = setTimeout(() => { timer = null; emitFsChanged(safe); }, FS_WATCH_DEBOUNCE_MS);
    }
    watcher.on('error', (err) => {
      console.warn('[fs:watch] error on', safe, '-', err && err.message);
    });
    FS_WATCHERS.set(safe, { watcher, timer: null });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
});

ipcMain.handle('fs:stopWatch', (event, projectPath) => {
  let safe;
  try { safe = assertInsideAllowedRoots(projectPath); } catch { return { ok: false }; }
  const entry = FS_WATCHERS.get(safe);
  if (!entry) return { ok: true };
  try { entry.watcher.close(); } catch { /* ignore */ }
  FS_WATCHERS.delete(safe);
  return { ok: true };
});

app.on('before-quit', () => {
  // Make sure native watcher handles are released even if the renderer hasn't
  // explicitly unwatched.
  for (const [root, entry] of FS_WATCHERS) {
    try { entry.watcher.close(); } catch { /* */ }
  }
  FS_WATCHERS.clear();
});

// Project-wide content grep. Plain substring (case-insensitive) match across
// files under projectRoot, respecting .gitignore. Cheap enough for ~50k files
// without a worker on modern SSDs; capped at 300 hits + 5 MB per file to keep
// the renderer responsive on huge repos.
ipcMain.handle('fs:searchContent', (event, projectRoot, query) => {
  let safeRoot;
  try { safeRoot = assertInsideAllowedRoots(projectRoot); } catch { return []; }
  const q = String(query || '');
  if (q.length < 2) return [];
  const needle = q.toLowerCase();
  const rules = loadGitignoreRules(safeRoot);
  const hits = [];
  const MAX_HITS = 300;
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  // Skip binary-looking extensions outright; reading their content is wasteful.
  const BINARY_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico','.tif','.tiff','.psd','.svg','.mp3','.mp4','.mov','.avi','.webm','.wav','.flac','.ogg','.zip','.gz','.tar','.7z','.rar','.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.bin','.dat','.dll','.so','.dylib','.exe','.class','.jar','.wasm','.lock','.svg']);

  function scanFile(filePath) {
    if (hits.length >= MAX_HITS) return;
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTS.has(ext)) return;
    let st;
    try { st = fs.statSync(filePath); } catch { return; }
    if (st.size > MAX_FILE_BYTES) return;
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { return; }
    // Quick reject — most files don't contain the needle.
    const lower = content.toLowerCase();
    let idx = lower.indexOf(needle);
    if (idx === -1) return;
    // Compute line/snippet for the first 3 matches in this file.
    let matchCount = 0;
    while (idx !== -1 && matchCount < 3 && hits.length < MAX_HITS) {
      const lineStart = content.lastIndexOf('\n', idx - 1) + 1;
      const lineEnd = (content.indexOf('\n', idx) === -1) ? content.length : content.indexOf('\n', idx);
      const line = content.slice(lineStart, lineEnd);
      // 1-based line number (count newlines before idx).
      let lineNo = 1;
      for (let i = 0; i < lineStart; i++) if (content.charCodeAt(i) === 10) lineNo++;
      hits.push({
        path: filePath,
        relativePath: path.relative(safeRoot, filePath),
        line: lineNo,
        snippet: line.length > 240 ? line.slice(0, 240) + '…' : line
      });
      matchCount++;
      idx = lower.indexOf(needle, idx + needle.length);
    }
  }

  function walk(dir) {
    if (hits.length >= MAX_HITS) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= MAX_HITS) return;
      if (ALWAYS_IGNORED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(safeRoot, full);
      if (isIgnoredByGitignore(rules, rel, e.isDirectory())) continue;
      if (e.isDirectory()) walk(full);
      else scanFile(full);
    }
  }
  walk(safeRoot);
  return hits;
});

// Async git runner — never block the Electron main thread.
// execFile() preserves stderr/stdout on error like execFileSync does.
//
// cwd is constrained to the configured allowed roots so a compromised renderer
// can't aim destructive git ops (checkout/discardFile/pull/push/stashPop) at an
// arbitrary directory on disk. Read-only ops are also restricted so we don't
// leak the contents of arbitrary repos.
function runGit(cwd, args, timeout) {
  return new Promise((resolve, reject) => {
    let safeCwd;
    try { safeCwd = assertInsideAllowedRoots(cwd); }
    catch (e) {
      const err = new Error('refused: cwd outside allowed roots');
      err.stderr = e && e.message ? e.message : 'forbidden';
      return reject(err);
    }
    execFile('git', args, { cwd: safeCwd, encoding: 'utf8', timeout: timeout || 5000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = err.stderr || stderr;
        err.stdout = err.stdout || stdout;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// Accepts a 4-64 hex commit hash and rejects anything that could be parsed by
// git as an option (leading `-`) or that contains shell-ish chars. Used by the
// commit/diff handlers that take an arbitrary ref from the renderer.
function isSafeGitHash(hash) {
  return typeof hash === 'string' && /^[0-9a-fA-F]{4,64}$/.test(hash);
}

ipcMain.handle('git:status', async (event, projectPath, branch) => {
  // Branch override: working/staged status is only meaningful for the
  // currently checked-out branch, so report empty for any other branch.
  if (branch) return [];
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

ipcMain.handle('git:branch', async (event, projectPath, branch) => {
  if (branch) return branch;
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

ipcMain.handle('git:aheadBehind', async (event, projectPath, branch) => {
  if (branch) {
    try {
      // ahead = local-only, behind = upstream-only, matching the shape
      // returned by the no-branch path. left = upstream, right = branch.
      const output = await runGit(
        projectPath,
        ['rev-list', '--left-right', '--count', 'refs/remotes/origin/' + branch + '...refs/heads/' + branch],
        5000
      );
      const parts = output.trim().split(/\s+/);
      return { ahead: parseInt(parts[1]) || 0, behind: parseInt(parts[0]) || 0 };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }
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

ipcMain.handle('git:graphLog', async (event, projectPath, count, branch) => {
  try {
    const args = ['log', '--format=%H|%h|%P|%s|%an|%ar|%D', '-' + (count || 50), '--no-color'];
    if (branch) args.push('refs/heads/' + branch);
    const output = await runGit(projectPath, args, 10000);
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
  if (!isSafeGitHash(hash)) {
    return { hash: '', message: '', author: '', date: '', files: [], error: 'refused: invalid commit hash' };
  }
  try {
    const [metaOutput, statOutput] = await Promise.all([
      runGit(projectPath, ['show', '--format=%H|%s|%an|%aI', '-s', hash, '--no-color', '--'], 10000),
      runGit(projectPath, ['show', '--numstat', '--format=', hash, '--no-color', '--'], 10000)
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
  if (!isSafeGitHash(hash)) return '';
  try {
    const args = filePath
      ? ['show', '--pretty=format:', '-p', hash, '--', filePath]
      : ['show', '--pretty=format:', '-p', hash, '--'];
    const output = await runGit(projectPath, args, 10000);
    return output.replace(/^\n+/, '');
  } catch {
    return '';
  }
});

ipcMain.handle('git:diffStat', async (event, projectPath, staged, branch) => {
  // Branch override: working/staged diffs only mean something for the
  // currently checked-out branch. For a non-checked-out branch the renderer
  // should call git:diffStatVsBase instead.
  if (branch) return [];
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

// Branch-vs-base diff: file-level numstat for `<base>...<branch>`.
// baseRef defaults to origin/main, falling back to origin/master, then HEAD.
ipcMain.handle('git:diffStatVsBase', async (event, projectPath, branch, baseRef) => {
  if (!projectPath || !branch) return [];
  const tryBases = baseRef ? [baseRef] : ['origin/main', 'origin/master', 'HEAD'];
  for (const base of tryBases) {
    try {
      const output = await runGit(
        projectPath,
        ['diff', '--numstat', base + '...refs/heads/' + branch],
        10000
      );
      return output.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        return {
          insertions: parts[0] === '-' ? 0 : parseInt(parts[0]) || 0,
          deletions: parts[1] === '-' ? 0 : parseInt(parts[1]) || 0,
          file: parts[2]
        };
      });
    } catch {
      // try next base
    }
  }
  return [];
});

async function listGitWorktrees(projectPath) {
  if (!projectPath) return [];
  try {
    const out = await runGit(projectPath, ['worktree', 'list', '--porcelain'], 5000);
    const entries = [];
    let cur = {};
    for (const rawLine of out.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (line.startsWith('worktree ')) {
        if (cur.path) entries.push(cur);
        cur = { path: line.slice('worktree '.length).trim() };
      } else if (line.startsWith('branch ')) {
        cur.branch = line.slice('branch '.length).trim();
      } else if (line === '') {
        if (cur.path) { entries.push(cur); cur = {}; }
      }
    }
    if (cur.path) entries.push(cur);
    return entries;
  } catch {
    return [];
  }
}

ipcMain.handle('paths:resolveWorktree', (event, projectPath, value) =>
  resolveWorktreeCandidates(projectPath, value, fs.promises.stat, listGitWorktrees));

ipcMain.handle('paths:exists', (event, p) =>
  pathIsDirectory(p, fs.promises.stat));

ipcMain.handle('git:isInsideWorkTree', async (event, cwd) => {
  if (!cwd) return false;
  try {
    const out = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], 5000);
    return out.trim() === 'true';
  } catch {
    return false;
  }
});

// --- Git: merge / rebase / conflict / tag / cherry-pick / file history ---

ipcMain.handle('git:merge', async (event, projectPath, branchName) => {
  if (!isSafeGitRefName(branchName)) return { success: false, error: 'refused: invalid branch name' };
  try {
    await runGit(projectPath, ['merge', branchName, '--no-edit'], 30000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:rebase', async (event, projectPath, branchName) => {
  if (!isSafeGitRefName(branchName)) return { success: false, error: 'refused: invalid branch name' };
  try {
    await runGit(projectPath, ['rebase', branchName], 30000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:mergeAbort', async (event, projectPath) => {
  try { await runGit(projectPath, ['merge', '--abort'], 5000); return { success: true }; }
  catch (err) { return { success: false, error: (err.stderr || err.message).toString().trim() }; }
});
ipcMain.handle('git:rebaseAbort', async (event, projectPath) => {
  try { await runGit(projectPath, ['rebase', '--abort'], 5000); return { success: true }; }
  catch (err) { return { success: false, error: (err.stderr || err.message).toString().trim() }; }
});
ipcMain.handle('git:rebaseContinue', async (event, projectPath) => {
  try { await runGit(projectPath, ['rebase', '--continue'], 10000); return { success: true }; }
  catch (err) { return { success: false, error: (err.stderr || err.message).toString().trim() }; }
});
ipcMain.handle('git:mergeContinue', async (event, projectPath) => {
  // Modern git: `git merge --continue` finalises a conflicted merge once
  // everything is staged.
  try { await runGit(projectPath, ['commit', '--no-edit'], 10000); return { success: true }; }
  catch (err) { return { success: false, error: (err.stderr || err.message).toString().trim() }; }
});

// Conflict resolution helpers. After checkout --ours / --theirs the file must
// still be staged via git add to mark the conflict resolved.
ipcMain.handle('git:resolveOurs', async (event, projectPath, filePath) => {
  try {
    await runGit(projectPath, ['checkout', '--ours', '--', filePath], 5000);
    await runGit(projectPath, ['add', '--', filePath], 5000);
    return { success: true };
  } catch (err) { return { success: false, error: (err.stderr || err.message).toString().trim() }; }
});
ipcMain.handle('git:resolveTheirs', async (event, projectPath, filePath) => {
  try {
    await runGit(projectPath, ['checkout', '--theirs', '--', filePath], 5000);
    await runGit(projectPath, ['add', '--', filePath], 5000);
    return { success: true };
  } catch (err) { return { success: false, error: (err.stderr || err.message).toString().trim() }; }
});

// Reports the current "operation" state so the renderer can show a banner.
// Walks the .git directory for MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD
// markers — cheaper and more reliable than parsing `git status --porcelain`
// for the same info.
ipcMain.handle('git:opState', async (event, projectPath) => {
  try {
    const gitDir = (await runGit(projectPath, ['rev-parse', '--git-dir'], 5000)).trim();
    const gd = path.isAbsolute(gitDir) ? gitDir : path.join(projectPath, gitDir);
    const state = { merging: false, rebasing: false, cherryPicking: false, conflictFiles: [] };
    if (fs.existsSync(path.join(gd, 'MERGE_HEAD'))) state.merging = true;
    if (fs.existsSync(path.join(gd, 'rebase-merge')) || fs.existsSync(path.join(gd, 'rebase-apply'))) state.rebasing = true;
    if (fs.existsSync(path.join(gd, 'CHERRY_PICK_HEAD'))) state.cherryPicking = true;
    // Conflict file list from porcelain — entries with U / DD / AA / etc.
    if (state.merging || state.rebasing || state.cherryPicking) {
      try {
        const out = await runGit(projectPath, ['status', '--porcelain'], 5000);
        out.split('\n').forEach(line => {
          if (!line) return;
          const code = line.substring(0, 2);
          if (code.includes('U') || code === 'DD' || code === 'AA') {
            state.conflictFiles.push(line.substring(3));
          }
        });
      } catch { /* swallow */ }
    }
    return state;
  } catch {
    return { merging: false, rebasing: false, cherryPicking: false, conflictFiles: [] };
  }
});

// Tag list / create / delete.
ipcMain.handle('git:tags', async (event, projectPath) => {
  try {
    const out = await runGit(projectPath, ['for-each-ref', '--format=%(refname:short)|%(objectname:short)|%(subject)', 'refs/tags', '--sort=-creatordate'], 10000);
    return out.split('\n').filter(Boolean).map(line => {
      const parts = line.split('|');
      return { name: parts[0], hash: parts[1], subject: parts.slice(2).join('|') };
    });
  } catch { return []; }
});
ipcMain.handle('git:tagCreate', async (event, projectPath, tagName, hash) => {
  if (!isSafeGitRefName(tagName)) return { success: false, error: 'refused: invalid tag name' };
  if (hash && !isSafeGitHash(hash)) return { success: false, error: 'refused: invalid hash' };
  try {
    const args = hash ? ['tag', tagName, hash] : ['tag', tagName];
    await runGit(projectPath, args, 5000);
    return { success: true };
  } catch (err) { return { success: false, error: (err.stderr || err.message).toString().trim() }; }
});
ipcMain.handle('git:tagDelete', async (event, projectPath, tagName) => {
  if (!isSafeGitRefName(tagName)) return { success: false, error: 'refused: invalid tag name' };
  try {
    await runGit(projectPath, ['tag', '-d', tagName], 5000);
    return { success: true };
  } catch (err) { return { success: false, error: (err.stderr || err.message).toString().trim() }; }
});

// Cherry-pick onto current branch.
ipcMain.handle('git:cherryPick', async (event, projectPath, hash) => {
  if (!isSafeGitHash(hash)) return { success: false, error: 'refused: invalid hash' };
  try { await runGit(projectPath, ['cherry-pick', hash], 30000); return { success: true }; }
  catch (err) { return { success: false, error: (err.stderr || err.message).toString().trim() }; }
});

// File history: git log for a single path. Returns up to `limit` commits with
// hash / subject / author / date.
ipcMain.handle('git:fileHistory', async (event, projectPath, filePath, limit) => {
  try {
    const n = Math.max(1, Math.min(500, parseInt(limit) || 50));
    const out = await runGit(projectPath, ['log', '-n', String(n), '--format=%h|%s|%an|%aI', '--no-color', '--', filePath], 15000);
    return out.split('\n').filter(Boolean).map(line => {
      const parts = line.split('|');
      return { hash: parts[0], message: parts[1], author: parts[2], date: parts[3] };
    });
  } catch { return []; }
});

// Blame for a single file: line -> { hash, author, time, content }
ipcMain.handle('git:blame', async (event, projectPath, filePath) => {
  try {
    const out = await runGit(projectPath, ['blame', '--line-porcelain', '--', filePath], 15000);
    const lines = out.split('\n');
    const result = [];
    let current = null;
    for (const line of lines) {
      if (/^[0-9a-f]{40,}\s/.test(line)) {
        if (current) result.push(current);
        const parts = line.split(' ');
        current = { hash: parts[0].slice(0, 8), author: '', time: 0, content: '' };
      } else if (line.startsWith('author ')) {
        if (current) current.author = line.slice(7);
      } else if (line.startsWith('author-time ')) {
        if (current) current.time = parseInt(line.slice(12)) * 1000;
      } else if (line.startsWith('\t')) {
        if (current) { current.content = line.slice(1); result.push(current); current = null; }
      }
    }
    if (current) result.push(current);
    return result;
  } catch { return []; }
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

function detectNpmScripts(projectPath) {
  const out = [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
    if (data && data.scripts && typeof data.scripts === 'object') {
      for (const [name, body] of Object.entries(data.scripts)) {
        out.push({
          name: 'npm: ' + name,
          type: 'custom',
          command: 'npm',
          args: ['run', name],
          cwd: projectPath,
          _source: 'package.json',
          _readonly: true,
          _hint: typeof body === 'string' ? body : ''
        });
      }
    }
  } catch { /* no package.json or invalid */ }
  return out;
}

function detectMakefileTargets(projectPath) {
  const out = [];
  try {
    const content = fs.readFileSync(path.join(projectPath, 'Makefile'), 'utf8');
    // Lines like "target: deps" — ignore special targets and pattern rules.
    const seen = new Set();
    const re = /^([A-Za-z0-9_.\-\/]+)\s*:\s*(?!=)/gm;
    let m;
    while ((m = re.exec(content)) !== null) {
      const t = m[1];
      if (t.startsWith('.') || t.includes('%')) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push({ name: 'make: ' + t, type: 'custom', command: 'make', args: [t], cwd: projectPath, _source: 'Makefile', _readonly: true });
      if (out.length >= 40) break;
    }
  } catch { /* no Makefile */ }
  return out;
}

function detectCargoBinaries(projectPath) {
  const out = [];
  try {
    const txt = fs.readFileSync(path.join(projectPath, 'Cargo.toml'), 'utf8');
    // Crude TOML parse — we don't depend on a TOML lib in main. Pull the
    // package name and any [[bin]] entries; covers the common case.
    const pkgNameMatch = /\[package\][\s\S]*?name\s*=\s*"([^"]+)"/.exec(txt);
    if (pkgNameMatch) {
      out.push({ name: 'cargo run', type: 'custom', command: 'cargo', args: ['run'], cwd: projectPath, _source: 'Cargo.toml', _readonly: true });
      out.push({ name: 'cargo test', type: 'custom', command: 'cargo', args: ['test'], cwd: projectPath, _source: 'Cargo.toml', _readonly: true });
    }
    const binRe = /\[\[bin\]\][\s\S]*?name\s*=\s*"([^"]+)"/g;
    let m;
    while ((m = binRe.exec(txt)) !== null) {
      out.push({ name: 'cargo run --bin ' + m[1], type: 'custom', command: 'cargo', args: ['run', '--bin', m[1]], cwd: projectPath, _source: 'Cargo.toml', _readonly: true });
    }
  } catch { /* no Cargo.toml */ }
  return out;
}

function detectPyProjectScripts(projectPath) {
  const out = [];
  try {
    const txt = fs.readFileSync(path.join(projectPath, 'pyproject.toml'), 'utf8');
    // Same caveat as Cargo — minimal TOML parser. Pull [project.scripts] entries.
    const block = /\[project\.scripts\]([\s\S]*?)(?:\n\[|$)/.exec(txt);
    if (block) {
      const lineRe = /^([A-Za-z0-9_.\-]+)\s*=\s*"([^"]+)"/gm;
      let m;
      while ((m = lineRe.exec(block[1])) !== null) {
        out.push({ name: 'pip: ' + m[1], type: 'custom', command: m[1], args: [], cwd: projectPath, _source: 'pyproject.toml', _readonly: true });
      }
    }
  } catch { /* no pyproject.toml */ }
  return out;
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
  // Auto-detected from common build/runner manifests
  configs = configs.concat(detectNpmScripts(projectPath));
  configs = configs.concat(detectMakefileTargets(projectPath));
  configs = configs.concat(detectCargoBinaries(projectPath));
  configs = configs.concat(detectPyProjectScripts(projectPath));
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
// Server-issued cooldown: when the endpoint returns 429 with a Retry-After,
// honour it. Hammering during cooldown extends the limit further.
let planUsageRetryAtMs = 0;

ipcMain.handle('usage:getPlanLimits', async (_event, force) => {
  const now = Date.now();
  if (!force && planUsageCache.data && (now - planUsageCache.fetchedAt) < PLAN_USAGE_CACHE_MS) {
    return { ok: true, data: planUsageCache.data, fetchedAt: planUsageCache.fetchedAt, cached: true };
  }

  // Honour server cooldown regardless of `force` — the user clicking refresh
  // can't get fresh data when the API has told us to wait, and bypassing this
  // would just push the unlock further out.
  if (planUsageRetryAtMs > now) {
    const remainSec = Math.round((planUsageRetryAtMs - now) / 1000);
    return {
      ok: false,
      error: 'rate-limited',
      retryAtMs: planUsageRetryAtMs,
      message: 'Usage endpoint rate-limited — retry in ' + (remainSec >= 60 ? Math.round(remainSec / 60) + ' min' : remainSec + 's') + '.'
    };
  }

  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  let token;
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    token = creds?.claudeAiOauth?.accessToken;
  } catch {
    // macOS: Claude CLI stores credentials in the login keychain under
    // service "Claude Code-credentials" instead of the plaintext file.
    // Without this fallback the mini usage bar silently stays blank on Mac.
    if (process.platform === 'darwin') {
      try {
        const raw = execFileSync('/usr/bin/security', [
          'find-generic-password',
          '-s', 'Claude Code-credentials',
          '-a', os.userInfo().username,
          '-w'
        ], { encoding: 'utf8' }).trim();
        const creds = JSON.parse(raw);
        token = creds?.claudeAiOauth?.accessToken;
      } catch {
        return { ok: false, error: 'no-creds', message: 'Could not read Claude credentials from the macOS keychain — is Claude Code logged in?' };
      }
    } else {
      return { ok: false, error: 'no-creds', message: 'Could not read ~/.claude/.credentials.json — Claude Code not logged in?' };
    }
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
    if (res.status === 429) {
      // Clamp Retry-After to [60s, 1h] so a server bug can't pin the bar
      // dead forever, and a missing/zero header still produces a real cooldown.
      const raw = parseInt(res.headers.get('retry-after') || '', 10);
      const retryAfterSec = Math.max(60, Math.min(Number.isFinite(raw) && raw > 0 ? raw : 60, 3600));
      planUsageRetryAtMs = now + retryAfterSec * 1000;
      return {
        ok: false,
        error: 'rate-limited',
        retryAtMs: planUsageRetryAtMs,
        message: 'Usage endpoint rate-limited (HTTP 429) — retry in ' + (retryAfterSec >= 60 ? Math.round(retryAfterSec / 60) + ' min' : retryAfterSec + 's') + '.'
      };
    }
    if (!res.ok) {
      return { ok: false, error: 'http-' + res.status, message: 'Usage endpoint returned HTTP ' + res.status };
    }
    const data = await res.json();
    planUsageCache = { data, fetchedAt: now };
    planUsageRetryAtMs = 0;
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

const { lastAssistantContextTokens, modelContextLimit, sampleAndResetReadStats } = require('./lib/session-context-tokens');

// One-shot read of the live context-token count for a session.
// Renderer calls this every ~10s while a Claude column is live.
ipcMain.handle('session:contextTokens', (_event, projectPath, sessionId, sinceMs) => {
  if (!projectPath || !sessionId) return null;
  // projectPath is the renderer's projectKey, which is the raw filesystem path
  // (e.g. "D:\\Git Repos\\Claudes"). Claude stores sessions under the encoded
  // form (e.g. "D--Git-Repos-Claudes"), so we must encode before joining.
  const claudeKey = projectPathToClaudeKey(projectPath);
  const filePath = path.join(os.homedir(), '.claude', 'projects', claudeKey, sessionId + '.jsonl');
  // Perf instrumentation — count every IPC call. Actual fs.readFileSync
  // invocations and bytes read are tracked inside the lib and sampled by
  // perfSample below, so we can see cache effectiveness in the perf line.
  incrPerfCtxRead();
  return lastAssistantContextTokens(filePath, sinceMs);
});

ipcMain.handle('session:modelContextLimit', (_event, model) => modelContextLimit(model));

// ---------- Clawd: per-column session-state machine over JSONL ----------
// Watches each column's session JSONL and maintains a small per-tail state
// machine modelled on clawd-tank/host/clawd_tank_daemon/daemon.py:
//
//   state: 'idle' | 'working' | 'thinking' | 'sleeping'
//   tool:  string (only meaningful when state === 'working')
//
// Transitions (derived from JSONL line shape, since we don't have direct
// hook visibility here):
//
//   assistant message with tool_use   → state='working', tool=<last tool_use.name>
//   assistant message with thinking-only (no tool_use, no text) → state='thinking'
//   assistant message with text-only (no tool_use)              → state='idle'
//   user message with text (not tool_result)                    → state='thinking'
//   user message with only tool_result                          → no state change
//
// Events are only emitted to the renderer when the *resolved state* changes.
// That avoids the constant cross-fade flicker when Claude alternates tools
// (Read → Edit → Read) — the widget only flips when the tool category does.
const clawdTails = new Map();
// columnId -> { filePath, offset, buf, timer, sender, sessionId,
//               state: { kind, tool }, lastEmitted: { kind, tool } }

function _clawdLineToTransition(line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (!entry || typeof entry !== 'object') return null;

  if (entry.type === 'assistant' && entry.message && Array.isArray(entry.message.content)) {
    let lastTool = null;
    let hasThinking = false;
    let hasText = false;
    for (const part of entry.message.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'tool_use' && typeof part.name === 'string') lastTool = part.name;
      else if (part.type === 'thinking') hasThinking = true;
      else if (part.type === 'text') hasText = true;
    }
    if (lastTool) return { kind: 'working', tool: lastTool };
    if (hasText) return { kind: 'idle' };
    if (hasThinking) return { kind: 'thinking' };
    return null;
  }

  if (entry.type === 'user' && entry.message && Array.isArray(entry.message.content)) {
    // A real user prompt (any non-tool_result content) means Claude is now
    // processing — mirror clawd-tank's dismiss+UserPromptSubmit → 'thinking'.
    for (const part of entry.message.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type !== 'tool_result') return { kind: 'thinking' };
    }
    return null;
  }
  return null;
}

function _clawdStatesEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'working') return (a.tool || '') === (b.tool || '');
  return true;
}

function _clawdEmitIfChanged(columnId, t, initial) {
  if (_clawdStatesEqual(t.state, t.lastEmitted)) return;
  t.lastEmitted = { kind: t.state.kind, tool: t.state.tool || '' };
  if (!t.sender || t.sender.isDestroyed()) return;
  const payload = { columnId, kind: t.state.kind };
  if (t.state.kind === 'working') payload.tool = t.state.tool || '';
  if (initial) payload.initial = true;
  try { t.sender.send('clawd:event', payload); } catch {}
}

function _clawdReplayBuffer(t, text, opts) {
  const combined = t.buf + text;
  const lines = combined.split('\n');
  t.buf = opts && opts.flush ? '' : (lines.pop() || '');
  for (const line of lines) {
    if (!line.trim()) continue;
    const next = _clawdLineToTransition(line);
    if (!next) continue;
    t.state = next;
  }
}

function clawdPollTail(columnId) {
  const t = clawdTails.get(columnId);
  if (!t) return;
  let stat;
  try { stat = fs.statSync(t.filePath); } catch { return; }
  if (stat.size === t.offset) return;
  if (stat.size < t.offset) { t.offset = 0; t.buf = ''; }
  let chunk = '';
  try {
    const fd = fs.openSync(t.filePath, 'r');
    const buf = Buffer.alloc(stat.size - t.offset);
    fs.readSync(fd, buf, 0, buf.length, t.offset);
    fs.closeSync(fd);
    chunk = buf.toString('utf8');
  } catch { return; }
  t.offset = stat.size;
  _clawdReplayBuffer(t, chunk, { flush: false });
  _clawdEmitIfChanged(columnId, t, false);
}

function clawdStartTail(columnId, projectPath, sessionId, sender) {
  clawdStopTail(columnId);
  if (!projectPath || !sessionId) return;
  const claudeKey = projectPathToClaudeKey(projectPath);
  const filePath = path.join(os.homedir(), '.claude', 'projects', claudeKey, sessionId + '.jsonl');
  let offset = 0;
  try { offset = fs.statSync(filePath).size; } catch {}
  const t = {
    filePath, offset, buf: '', sender, sessionId,
    state: { kind: 'idle' },
    lastEmitted: null,
  };
  t.timer = setInterval(() => clawdPollTail(columnId), 150);
  clawdTails.set(columnId, t);
  // Deliberately no initial emit. Resurrecting the last turn's state from
  // the JSONL was misleading (a brand-new column would inherit yesterday's
  // tool_use as its "current" state). The widget defaults to idle and the
  // first real transition — from a hook or a fresh JSONL line — drives it.
}

function clawdStopTail(columnId) {
  const t = clawdTails.get(columnId);
  if (!t) return;
  clearInterval(t.timer);
  clawdTails.delete(columnId);
}

ipcMain.handle('clawd:startTail', (event, args) => {
  if (!args) return;
  clawdStartTail(args.columnId, args.projectPath, args.sessionId, event.sender);
});
ipcMain.handle('clawd:stopTail', (_event, args) => {
  if (!args) return;
  clawdStopTail(args.columnId);
});

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
//
// electron-updater on macOS is backed by Squirrel.Mac, which refuses to apply
// an update unless both the running app and the new bundle have matching
// valid Developer ID signatures. We don't sign the macOS build, so on darwin
// we replace the Squirrel flow with a custom GitHub-polling updater that
// downloads the DMG to ~/Downloads and opens it in Finder — the user drags
// the new Claudes.app over the old one. The renderer-side IPC contract
// (`update:available`, `update:progress`, `update:downloaded`, `update:error`,
// and the `update:install` handler) is identical on both code paths, so the
// existing update banner in renderer.js works unchanged.

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function setupAutoUpdater() {
  if (process.platform === 'darwin') {
    setupDarwinUpdater();
    return;
  }

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

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall();
  });
}

// Manual "Check for updates" trigger from the toolbar. On darwin it pokes
// our custom GitHub-polling updater; elsewhere it asks electron-updater to
// re-check (which the auto flow only does once at startup).
ipcMain.handle('update:checkNow', async () => {
  if (process.platform === 'darwin') {
    if (typeof darwinCheckForUpdates !== 'function') return { error: 'updater not initialised' };
    return darwinCheckForUpdates({ manual: true });
  }
  try {
    const result = await autoUpdater.checkForUpdatesAndNotify();
    const latest = result && result.updateInfo && result.updateInfo.version;
    if (!latest || !isNewerVersion(latest, app.getVersion())) {
      mainWindow?.webContents.send('update:none', { version: app.getVersion() });
      return { available: false };
    }
    return { available: true, version: latest };
  } catch (err) {
    mainWindow?.webContents.send('update:error', { message: err.message });
    return { error: err.message };
  }
});

// --- macOS custom updater ---

// Integer-triplet comparison sufficient for our X.Y.Z release scheme — avoids
// pulling in a real semver dep.
function isNewerVersion(latestTag, current) {
  const norm = (v) => String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [la, lb, lc] = norm(latestTag);
  const [ca, cb, cc] = norm(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

// Manual-trigger entry point — populated by setupDarwinUpdater so the
// toolbar "Check for updates" item can poke the same check function the
// hourly timer uses.
let darwinCheckForUpdates = null;

function setupDarwinUpdater() {
  const REPO = 'paulallington/Claudes';
  const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h
  const INITIAL_DELAY_MS = 30 * 1000;       // give the window a moment to render

  let downloadedDmgPath = null;
  let downloading = false;
  let notifiedVersion = null;

  function fetchJson(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        method: 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Claudes-Updater'
        }
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (err) { reject(err); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('timeout')));
      req.end();
    });
  }

  function downloadFile(url, targetPath, onProgress) {
    return new Promise((resolve, reject) => {
      const sink = fs.createWriteStream(targetPath);
      sink.on('error', reject);

      function get(href, redirects) {
        const u = new URL(href);
        const req = https.request({
          method: 'GET',
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: { 'User-Agent': 'Claudes-Updater' }
        }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            if (redirects > 5) return reject(new Error('too many redirects'));
            // GitHub release asset URLs redirect to S3 with a presigned URL.
            return get(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error('HTTP ' + res.statusCode));
          }
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let received = 0;
          res.on('data', (chunk) => {
            received += chunk.length;
            sink.write(chunk);
            if (total && onProgress) onProgress((received / total) * 100);
          });
          res.on('end', () => { sink.end(resolve); });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error('timeout')));
        req.end();
      }
      get(url, 0);
    });
  }

  async function checkForUpdates(opts) {
    const manual = !!(opts && opts.manual);
    try {
      const release = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
      const tag = release && release.tag_name;
      if (!tag || !isNewerVersion(tag, app.getVersion())) {
        // Manual check needs to tell the user nothing's there so they don't
        // wonder if it silently failed.
        if (manual) mainWindow?.webContents.send('update:none', { version: app.getVersion() });
        return { available: false };
      }
      const version = tag.replace(/^v/, '');

      // Only re-notify when a *different* newer version appears (otherwise
      // every hourly check would re-fire the banner and spam the user).
      // Manual checks always re-notify so the user gets visible feedback.
      if (notifiedVersion !== version || manual) {
        notifiedVersion = version;
        mainWindow?.webContents.send('update:available', {
          version,
          releaseNotes: release.body || ''
        });
      }

      if (downloading || downloadedDmgPath) return { available: true, version };

      const asset = (release.assets || []).find((a) => a.name && a.name.endsWith(`-mac-${ARCH}.dmg`));
      if (!asset) {
        console.error('[darwin-updater] no DMG asset for arch', ARCH, 'in', tag);
        return { available: true, version, error: 'no-asset' };
      }

      downloading = true;
      const target = path.join(app.getPath('temp'), asset.name);
      try {
        await downloadFile(asset.browser_download_url, target, (pct) => {
          mainWindow?.webContents.send('update:progress', { percent: pct });
        });
        downloadedDmgPath = target;
        mainWindow?.webContents.send('update:downloaded', {
          version,
          releaseNotes: release.body || ''
        });
      } finally {
        downloading = false;
      }
      return { available: true, version };
    } catch (err) {
      console.error('[darwin-updater]', err.message);
      mainWindow?.webContents.send('update:error', { message: err.message });
      return { error: err.message };
    }
  }
  darwinCheckForUpdates = checkForUpdates;

  ipcMain.handle('update:install', async () => {
    if (!downloadedDmgPath) return;
    // Tell Finder to mount + open the DMG before we quit, so the user lands
    // on the drag-to-Applications window with no app left to block the
    // replace.
    await shell.openPath(downloadedDmgPath);
    setTimeout(() => app.quit(), 1500);
  });

  setTimeout(checkForUpdates, INITIAL_DELAY_MS);
  setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}

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
    // DNS-rebinding mitigation: only accept Host headers that name the loopback
    // address with the right port. A browser tab that has a DNS name resolving
    // to 127.0.0.1 would otherwise be able to POST here from a different origin.
    const host = (req.headers.host || '').toLowerCase();
    const expectedA = '127.0.0.1:' + hookServerListenPort;
    const expectedB = 'localhost:' + hookServerListenPort;
    if (host !== expectedA && host !== expectedB) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/hook') {
      // Reject unauthenticated callers. The curl command we write into
      // settings.json carries the token; anything else POST'ing here is hostile.
      const token = req.headers['x-auth-token'];
      let tokenOk = false;
      if (typeof token === 'string' && token.length === HOOK_AUTH_TOKEN.length) {
        try {
          tokenOk = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(HOOK_AUTH_TOKEN));
        } catch { tokenOk = false; }
      }
      if (!tokenOk) {
        res.writeHead(401);
        res.end();
        return;
      }
      let body = '';
      let aborted = false;
      // Bound the body — a hook event payload is normally a few KB; cap at 1 MB
      // so a malicious local process can't pin memory by streaming forever.
      req.on('data', chunk => {
        if (aborted) return;
        body += chunk;
        if (body.length > 1024 * 1024) {
          aborted = true;
          res.writeHead(413);
          res.end();
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          const event = JSON.parse(body);
          incrPerfHook();
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
    diagLog('[hook-server] listening on port', hookServerPort);
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
  let migrated = 0;
  let removedLegacy = 0;
  // Strip Claudes-owned groups from events we no longer subscribe to (e.g.
  // PostToolUse — saves a curl fork per tool call).
  for (const ev of REMOVED_HOOK_EVENTS) {
    const groups = data.hooks[ev];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => {
      if (isClaudesHookGroup(g)) { removedLegacy++; return false; }
      return true;
    });
    if (kept.length) data.hooks[ev] = kept; else delete data.hooks[ev];
  }
  for (const ev of Object.keys(data.hooks)) {
    const groups = data.hooks[ev];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isClaudesHookGroup(g)) continue;
      // Heal legacy entries where the sentinel was stuffed into `matcher` for
      // tool-use events (which prevented the hook from ever firing).
      if (g.matcher === CLAUDES_HOOK_SENTINEL && TOOL_NAME_MATCHER_EVENTS.has(ev)) {
        delete g.matcher;
        migrated++;
      }
      if (!Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (h && h.type === 'command' && typeof h.command === 'string' && h.command !== wanted) {
          h.command = wanted;
          changed++;
        }
      }
    }
  }
  if (changed > 0 || migrated > 0 || removedLegacy > 0) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    diagLog('[hook-server] sync: re-pointed', changed, 'hook(s); migrated', migrated, 'legacy matchers; removed', removedLegacy, 'unused-event hook(s); port', port);
  }
}

ipcMain.handle('hooks:getPort', () => hookServerPort);

// Events we actively listen to. PostToolUse was previously included but its
// curl-per-call cost was significant on busy turns (every tool call = 1 fork)
// and the Clawd state machine doesn't use it for anything — PreToolUse +
// Stop are enough. Listed here as REMOVED_HOOK_EVENTS so existing installs
// get cleaned up on next configure/sync.
const HOOK_EVENTS = [
  'PreToolUse', 'UserPromptSubmit',
  'Stop', 'SubagentStop', 'Notification',
  'SessionStart', 'SessionEnd', 'PreCompact'
];
const REMOVED_HOOK_EVENTS = ['PostToolUse'];

// Legacy sentinel matcher we *used* to write into `matcher` to identify our
// own hook entries. Problem: Claude Code treats `matcher` as a tool-name
// regex for PreToolUse/PostToolUse, so the sentinel value never matched any
// real tool and our hooks never fired. New entries omit `matcher` (or set it
// to a permissive wildcard for tool-use events). The sentinel is still
// recognised for back-compat detection and migration.
const CLAUDES_HOOK_SENTINEL = '__claudes_inspector__';

// Events whose `matcher` field is a regex matched against the tool name.
// Empty/wildcard means "fire for every tool". For these we want no matcher.
const TOOL_NAME_MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

// Does this hook group belong to Claudes? Identifies via command URL pattern
// (resilient to matcher changes and per-launch token rotation) or the legacy
// sentinel matcher.
function isClaudesHookGroup(g) {
  if (!g) return false;
  if (g.matcher === CLAUDES_HOOK_SENTINEL) return true;
  if (!Array.isArray(g.hooks)) return false;
  return g.hooks.some((h) =>
    h && h.type === 'command' &&
    typeof h.command === 'string' &&
    /127\.0\.0\.1:\d+\/hook/.test(h.command) &&
    /X-Auth-Token:/i.test(h.command)
  );
}

function buildHookCommand(port) {
  // Cross-platform curl invocation. curl ships with Windows 10+, macOS, and
  // every Linux distro this app runs on. -d @- reads stdin. The double-quoted
  // header values are parsed identically by cmd.exe and POSIX shells. The
  // auth-token header gates the local /hook endpoint — see HOOK_AUTH_TOKEN.
  return 'curl -s -X POST http://127.0.0.1:' + port + '/hook -d @-' +
    ' -H "Content-Type: application/json"' +
    ' -H "X-Auth-Token: ' + HOOK_AUTH_TOKEN + '"';
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

// "Configured" means EVERY event in HOOK_EVENTS has the Claudes sentinel.
// Previously this returned true on first match, which meant a partial install
// (e.g. only PostToolUse — common after older versions of this code) hid the
// Connect button and stranded the user without a way to top up the missing
// events. Now Connect stays visible until coverage is complete; configure() is
// idempotent so clicking it on a partial install just fills in the gaps.
ipcMain.handle('hooks:isConfigured', () => {
  try {
    const { data } = readClaudeSettings();
    if (!data || !data.hooks) return false;
    for (const ev of HOOK_EVENTS) {
      const groups = data.hooks[ev];
      if (!Array.isArray(groups)) return false;
      if (!groups.some(isClaudesHookGroup)) return false;
    }
    return true;
  } catch { return false; }
});

// Per-event hook coverage report — used by the Clawd settings pane so the
// user can see exactly which events are wired up vs missing.
ipcMain.handle('hooks:status', () => {
  try {
    const { data } = readClaudeSettings();
    const hooks = (data && data.hooks) || {};
    const wired = [];
    const missing = [];
    for (const ev of HOOK_EVENTS) {
      const groups = Array.isArray(hooks[ev]) ? hooks[ev] : [];
      (groups.some(isClaudesHookGroup) ? wired : missing).push(ev);
    }
    return { wired, missing, total: HOOK_EVENTS.length };
  } catch (e) {
    return { wired: [], missing: HOOK_EVENTS.slice(), total: HOOK_EVENTS.length, error: String(e && e.message || e) };
  }
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
    let migrated = 0;
    let removed = 0;
    // Strip any Claudes-owned groups for events we no longer subscribe to.
    // Saves a curl fork per matching tool call on busy turns.
    for (const ev of REMOVED_HOOK_EVENTS) {
      const groups = data.hooks[ev];
      if (!Array.isArray(groups)) continue;
      const kept = groups.filter((g) => {
        if (isClaudesHookGroup(g)) { removed++; return false; }
        return true;
      });
      if (kept.length) data.hooks[ev] = kept; else delete data.hooks[ev];
    }
    for (const ev of HOOK_EVENTS) {
      if (!Array.isArray(data.hooks[ev])) data.hooks[ev] = [];
      // Migrate any legacy Claudes groups: for tool-use events, the sentinel
      // value sat in `matcher` and prevented the hook from firing (matcher is
      // a tool-name regex there). Strip it; leave label-style sentinels alone
      // for events where matcher is informational.
      for (const g of data.hooks[ev]) {
        if (g && g.matcher === CLAUDES_HOOK_SENTINEL && TOOL_NAME_MATCHER_EVENTS.has(ev)) {
          delete g.matcher;
          migrated++;
        }
      }
      if (data.hooks[ev].some(isClaudesHookGroup)) continue;
      const group = { hooks: [{ type: 'command', command }] };
      // For non-tool-use events Claude Code uses `matcher` as a label or
      // event-subtype filter; including a recognisable string is harmless and
      // helps users grep settings.json. Skip it for tool-use events so we
      // actually match every tool.
      if (!TOOL_NAME_MATCHER_EVENTS.has(ev)) group.matcher = CLAUDES_HOOK_SENTINEL;
      data.hooks[ev].push(group);
      added++;
    }
    writeClaudeSettings(file, data);
    return { ok: true, added, migrated, removed, port: hookServerListenPort };
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
        if (isClaudesHookGroup(g)) { removed++; return false; }
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
  // Same containment rule as shell:openPath — reveal-in-folder is a low-impact
  // API but a compromised renderer should not get to navigate Explorer to
  // arbitrary paths on disk.
  try {
    const safe = assertInsideAllowedRoots(fullPath);
    shell.showItemInFolder(safe);
  } catch { /* refused */ }
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

// Launch the user's configured external editor (default: `code` on PATH).
// Accepts either a single path (string) or [projectPath, filePath]. For the
// two-arg form we invoke `<editor> <folder> -g <file>` so VS Code opens the
// folder as a workspace AND focuses the file. Paths with spaces are quoted
// explicitly because shell:true on Windows lets cmd.exe re-tokenize the line
// and silently splits "D:\Git Repos\Foo" into two arguments.
// Falls back to shell.openPath when the command isn't found.
ipcMain.handle('editor:openExternal', async (event, targetPath) => {
  const rawArgs = Array.isArray(targetPath) ? targetPath : [targetPath];
  const safeArgs = [];
  for (const p of rawArgs) {
    if (!p || typeof p !== 'string') continue;
    try { safeArgs.push(assertInsideAllowedRoots(p)); }
    catch { return { ok: false, error: 'refused: path outside allowed roots' }; }
  }
  if (safeArgs.length === 0) return { ok: false, error: 'no target path' };
  const cfg = readConfig();
  const cmd = (cfg && typeof cfg.externalEditorCommand === 'string' && cfg.externalEditorCommand.trim())
    || (process.platform === 'win32' ? 'code.cmd' : 'code');

  // For the two-arg [folder, file] form, use `code <folder> -g <file>` so the
  // workspace is opened and the file is focused. Single-arg form passes
  // through unchanged (folder OR file).
  let invocationArgs;
  if (safeArgs.length >= 2) {
    invocationArgs = [safeArgs[0], '-g', safeArgs[1]];
  } else {
    invocationArgs = safeArgs;
  }

  function quoteForWin(s) {
    // cmd.exe doesn't honour backslash-escape; wrap any arg with whitespace,
    // & ; | < > ^ in double quotes. Embedded double quotes are doubled.
    if (!/[\s&;|<>^"]/.test(s)) return s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  return new Promise((resolve) => {
    let child;
    if (process.platform === 'win32') {
      // Run through cmd.exe so the .cmd shim resolves, but we build the
      // command line ourselves (with explicit quoting) instead of letting
      // shell:true do it — Node's auto-quoting doesn't cover arg arrays
      // when shell is on, and spaces get split.
      const cmdLine = quoteForWin(cmd) + ' ' + invocationArgs.map(quoteForWin).join(' ');
      child = spawn(cmdLine, [], { detached: true, stdio: 'ignore', shell: true });
    } else {
      child = spawn(cmd, invocationArgs, { detached: true, stdio: 'ignore' });
    }

    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      // Fall back to OS handler on the last arg (file > folder), better than
      // silently doing nothing.
      shell.openPath(safeArgs[safeArgs.length - 1]).then((msg) => {
        resolve({ ok: !msg, error: err && err.message, fallback: 'openPath', openPathMessage: msg });
      });
    });
    child.on('spawn', () => {
      if (settled) return;
      settled = true;
      try { child.unref(); } catch {}
      resolve({ ok: true });
    });
  });
});

ipcMain.handle('editor:getExternalCommand', () => {
  const cfg = readConfig();
  return (cfg && typeof cfg.externalEditorCommand === 'string') ? cfg.externalEditorCommand : '';
});

ipcMain.handle('editor:setExternalCommand', (event, cmd) => {
  const cfg = readConfig();
  cfg.externalEditorCommand = typeof cmd === 'string' ? cmd.trim() : '';
  writeConfig(cfg);
  return { ok: true };
});

ipcMain.handle('config:getAutoUpdateClaude', () => {
  return readConfig().autoUpdateClaude === true;
});
ipcMain.handle('config:setAutoUpdateClaude', (event, enabled) => {
  const cfg = readConfig();
  cfg.autoUpdateClaude = !!enabled;
  writeConfig(cfg);
  return { ok: true };
});

// Persisted terminal settings (font / scrollback / cursor / background colour).
// Read by the renderer when constructing each Terminal so user prefs apply
// to every spawn.
ipcMain.handle('config:getTerminalSettings', () => {
  const cfg = readConfig();
  return cfg.terminal || {};
});
ipcMain.handle('config:setTerminalSettings', (event, settings) => {
  const cfg = readConfig();
  cfg.terminal = Object.assign({}, cfg.terminal || {}, settings && typeof settings === 'object' ? settings : {});
  writeConfig(cfg);
  return { ok: true, settings: cfg.terminal };
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

// Sanitise a single path segment so it cannot escape its parent directory
// (no '..', no separators) and is safe on Windows (no reserved chars). Used
// where renderer-supplied automation/project metadata flows into a path.
function sanitiseDirSegment(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

// Verify that a constructed path resolves to a location strictly inside the
// expected parent directory. Combined with sanitiseDirSegment, this catches
// any future regression where a segment leaks past the sanitiser.
function assertInsideParent(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return c;
  const sep = p.endsWith(path.sep) ? '' : path.sep;
  const ok = process.platform === 'win32'
    ? c.toLowerCase().startsWith((p + sep).toLowerCase())
    : c.startsWith(p + sep);
  if (!ok) throw new Error('refused: child path escapes parent');
  return c;
}

function safeRemoveDir(dirPath) {
  // Use fs.rmSync on every platform (Node 16+ handles Windows locked files
  // and long paths via maxRetries/retryDelay). Previously this branched to
  // `cmd /c rmdir /s /q <dirPath>` on Windows; cmd re-parses its tail, so
  // metacharacters (& | ^ %) in dirPath could result in command injection
  // if the path ever flowed from renderer-controlled data.
  try {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* ignore — directory may be partially removed or locked */ }
}

ipcMain.handle('automations:setupAgentClone', async (event, automationId, agentId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return { error: 'Automation not found' };
  const agent = automation.agents.find(ag => ag.id === agentId);
  if (!agent) return { error: 'Agent not found' };
  if (!agent.isolation || !agent.isolation.enabled) return { error: 'Agent does not have isolation enabled' };

  // Determine clone path. Both segments are sanitised — `automation.projectPath`
  // can be persisted with `..` or odd characters and would otherwise let
  // safeRemoveDir delete arbitrary directories outside agentReposBaseDir.
  const baseDir = data.agentReposBaseDir || AGENTS_DIR_DEFAULT;
  const projectName = sanitiseDirSegment((automation.projectPath || '').split(/[/\\]/).pop());
  const agentDirName = sanitiseDirSegment(agent.name).toLowerCase();
  const clonePath = path.join(baseDir, projectName, agentDirName);
  try { assertInsideParent(clonePath, baseDir); }
  catch (err) { return { error: err.message }; }

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
  const projectName = sanitiseDirSegment((automation.projectPath || '').split(/[/\\]/).pop());
  const automationDirName = sanitiseDirSegment(automation.name).toLowerCase();
  const clonePath = path.join(baseDir, projectName, '_manager-' + automationDirName);
  try { assertInsideParent(clonePath, baseDir); }
  catch (err) { return { error: err.message }; }

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
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = execFileSync(lookup, ['claude'], { encoding: 'utf8' });
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
      const projectName = sanitiseDirSegment((automation.projectPath || '').split(/[/\\]/).pop());
      const automationDirName = sanitiseDirSegment(automation.name).toLowerCase();
      const clonePath = path.join(baseDir, projectName, '_manager-' + automationDirName);
      try { assertInsideParent(clonePath, baseDir); }
      catch (err) { console.error('[Manager] Refused clone path:', err.message); return; }

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
  // Per-platform sizing: macOS menu bar wants 18x18 templates; KDE / GNOME
  // legacy tray prefers 22x22; Windows scales the .ico automatically. Picking
  // a sane Linux default avoids a giant icon on KDE Plasma.
  let sized = trayIcon;
  if (process.platform === 'darwin') sized = trayIcon.resize({ width: 18, height: 18 });
  else if (process.platform === 'linux') sized = trayIcon.resize({ width: 22, height: 22 });
  tray = new Tray(sized);
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
    // Spin up sync watchers for any project that already has sync enabled
    // from a previous session.
    try { reapplySyncFromConfig(cfg); } catch (err) { console.error('sync boot failed:', err); }
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

// SIGTERM → 2s → SIGKILL. node-pty children of the pty-server can occasionally
// ignore a polite SIGTERM (e.g. a Claude CLI mid-write to a foreign PTY).
// Without escalation the parent Electron process waits forever on quit.
function killPtyServer() {
  if (!ptyServerProcess || ptyServerProcess.killed) return;
  const child = ptyServerProcess;
  const pid = child.pid;
  diagLog('[quit] killPtyServer: SIGTERM ->', pid);
  try { child.kill('SIGTERM'); } catch (e) { diagLog('[quit] SIGTERM threw:', e && e.message); }
  setTimeout(() => {
    if (child.killed) {
      diagLog('[quit] pty-server', pid, 'already gone, SIGKILL not needed');
      return;
    }
    diagLog('[quit] pty-server', pid, 'still alive after 2s — SIGKILL');
    try { child.kill('SIGKILL'); } catch (e) { diagLog('[quit] SIGKILL threw:', e && e.message); }
  }, 2000).unref();
}

app.on('window-all-closed', () => {
  // On close-to-tray, windows are hidden not closed, so this only fires on actual quit
  if (process.platform !== 'darwin') {
    stopAutomationScheduler();
    killPtyServer();
    app.quit();
  }
});

app.on('before-quit', () => {
  const t0 = Date.now();
  const step = (label) => diagLog('[quit] +' + (Date.now() - t0) + 'ms ' + label);
  step('before-quit: start');
  isQuitting = true;
  step('popouts close: ' + popoutWindows.size);
  for (const win of popoutWindows.values()) {
    if (!win.isDestroyed()) {
      try { win.close(); } catch {}
    }
  }
  step('flushPendingConfig');
  flushPendingConfig();
  flushPendingStickyNotes();
  flushPendingReviewComments();
  step('stopAutomationScheduler');
  stopAutomationScheduler();
  step('clawdTails clear: ' + clawdTails.size);
  for (const [colId, t] of clawdTails) {
    try { clearInterval(t.timer); } catch {}
  }
  clawdTails.clear();
  step('killPtyServer');
  killPtyServer();
  // The hook server's listening socket keeps the event loop alive; close it
  // so Electron can actually exit instead of hanging in 'will-quit'.
  if (hookServer) {
    step('hookServer.closeAllConnections + close');
    try { if (typeof hookServer.closeAllConnections === 'function') hookServer.closeAllConnections(); } catch (e) { diagLog('[quit] closeAllConnections threw:', e && e.message); }
    try { hookServer.close(() => step('hookServer: close callback')); } catch (e) { diagLog('[quit] hookServer.close threw:', e && e.message); }
    hookServer = null;
  }
  step('FS_WATCHERS close: ' + FS_WATCHERS.size);
  step('before-quit: done');
});

app.on('will-quit', () => { diagLog('[quit] will-quit fired'); });
app.on('quit', () => { diagLog('[quit] quit fired'); });

// Renderer/child-process death and blocked-unload capture — classic culprits
// behind "Cmd+Q (or Alt+F4) hangs and I have to Force Quit". Cross-platform.
app.on('render-process-gone', (_event, _wc, details) => {
  diagLog('[crash] render-process-gone:', JSON.stringify(details));
});
app.on('child-process-gone', (_event, details) => {
  diagLog('[crash] child-process-gone:', JSON.stringify(details));
});
app.on('web-contents-created', (_event, wc) => {
  wc.on('will-prevent-unload', () => {
    // A beforeunload handler returning falsy will block quit. Log it,
    // don't override — we want to know if it's happening.
    diagLog('[quit] will-prevent-unload fired on wc id=' + wc.id + ' url=' + wc.getURL());
  });
  wc.on('unresponsive', () => {
    diagLog('[crash] webContents unresponsive: id=' + wc.id + ' url=' + wc.getURL());
  });
  wc.on('responsive', () => {
    diagLog('[crash] webContents responsive again: id=' + wc.id);
  });
});
