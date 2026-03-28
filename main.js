const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeTheme, shell, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const http = require('http');

let mainWindow;
let tray;
let isQuitting = false;
let hookServer;
let hookServerPort;
const ptyPort = app.isPackaged ? 3456 : 3457;
let ptyServerProcess;

const CONFIG_DIR = path.join(os.homedir(), '.claudes');
const CONFIG_FILE = path.join(CONFIG_DIR, 'projects.json');
const LOOPS_FILE = path.join(CONFIG_DIR, 'loops.json');
const LOOPS_RUNS_DIR = path.join(CONFIG_DIR, 'loop-runs');
const AUTOMATIONS_FILE = path.join(CONFIG_DIR, 'automations.json');
const AUTOMATIONS_RUNS_DIR = path.join(CONFIG_DIR, 'automation-runs');

// --- Config ---

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readConfig() {
  ensureConfigDir();
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { projects: [], activeProjectIndex: -1 };
  }
}

function writeConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
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

function writeLoops(data) {
  ensureConfigDir();
  fs.writeFileSync(LOOPS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// --- Automations Persistence ---

function readAutomations() {
  ensureConfigDir();
  try {
    return JSON.parse(fs.readFileSync(AUTOMATIONS_FILE, 'utf8'));
  } catch {
    return { globalEnabled: true, maxConcurrentRuns: 3, agentReposBaseDir: path.join(os.homedir(), '.claudes', 'agents'), automations: [] };
  }
}

function writeAutomations(data) {
  ensureConfigDir();
  fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
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
    agentReposBaseDir: path.join(os.homedir(), '.claudes', 'agents'),
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

function ensureLoopRunsDir(loopId) {
  const dir = path.join(LOOPS_RUNS_DIR, loopId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function saveLoopRun(loopId, runData) {
  const dir = ensureLoopRunsDir(loopId);
  const filename = new Date(runData.startedAt).toISOString().replace(/[:.]/g, '-') + '.json';
  if (runData.output && runData.output.length > 50000) {
    runData.output = runData.output.substring(0, 50000) + '\n...[truncated]';
  }
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(runData, null, 2), 'utf8');
  pruneLoopRuns(loopId, dir);
}

function pruneLoopRuns(loopId, dir) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    while (files.length > 50) {
      fs.unlinkSync(path.join(dir, files.shift()));
    }
  } catch { /* ignore */ }
}

function getLoopHistory(loopId, count) {
  const dir = path.join(LOOPS_RUNS_DIR, loopId);
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

function generateLoopId() {
  return 'loop_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
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
      env: { ...process.env, PTY_PORT: String(ptyPort) }
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
      mainWindow.hide();
      if (process.platform === 'darwin') {
        app.dock.hide();
      }
    }
  });

  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send('theme:osChanged', nativeTheme.shouldUseDarkColors);
  });
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
  writeConfig(config);
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
  if (mainWindow) {
    mainWindow.setTitleBarOverlay({
      color: colors.color,
      symbolColor: colors.symbolColor,
      height: 40
    });
    mainWindow.setBackgroundColor(colors.color);
  }
});

// --- Session Management ---

// Convert a project path to Claude's project key format
function projectPathToClaudeKey(projectPath) {
  return projectPath.replace(/[:/\\]/g, '-').replace(/^-/, '');
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
        // Strip XML/HTML tags (from skill invocations etc.)
        text = text.replace(/<[^>]+>/g, '').trim();
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
  const claudesDir = path.join(projectPath, '.claudes');
  if (!fs.existsSync(claudesDir)) {
    fs.mkdirSync(claudesDir, { recursive: true });
  }
  const sessionsFile = path.join(claudesDir, 'sessions.json');
  fs.writeFileSync(sessionsFile, JSON.stringify({ sessions: sessionData }, null, 2), 'utf8');
});

ipcMain.handle('sessions:load', (event, projectPath) => {
  const sessionsFile = path.join(projectPath, '.claudes', 'sessions.json');
  try {
    const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    return data.sessions || [];
  } catch {
    return [];
  }
});

// --- CLAUDE.md Management ---

ipcMain.handle('claudemd:read', (event, projectPath) => {
  const filePath = path.join(projectPath, 'CLAUDE.md');
  try {
    if (!fs.existsSync(filePath)) return { exists: false, content: '' };
    return { exists: true, content: fs.readFileSync(filePath, 'utf8') };
  } catch {
    return { exists: false, content: '' };
  }
});

ipcMain.handle('claudemd:save', (event, projectPath, content) => {
  const filePath = path.join(projectPath, 'CLAUDE.md');
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Explorer Panel IPC ---

ipcMain.handle('fs:readFile', (event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 2 * 1024 * 1024) {
      return { error: 'File is too large to edit (>2MB)' };
    }
    const buf = fs.readFileSync(filePath);
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
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fs:readDir', (event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const excluded = new Set(['node_modules', '.git', '__pycache__', '.next', '.nuxt']);
    return entries
      .filter(e => !excluded.has(e.name))
      .map(e => ({
        name: e.name,
        path: path.join(dirPath, e.name),
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
  const excluded = new Set(['node_modules', '.git', '__pycache__', '.next', '.nuxt', 'dist', '.cache', 'coverage']);
  const results = [];
  const lowerQuery = query.toLowerCase();
  const MAX_RESULTS = 100;

  function walk(dir) {
    if (results.length >= MAX_RESULTS) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (results.length >= MAX_RESULTS) return;
        if (excluded.has(e.name)) continue;
        const fullPath = path.join(dir, e.name);
        const relativePath = path.relative(rootDir, fullPath);
        if (e.name.toLowerCase().includes(lowerQuery)) {
          results.push({ name: e.name, path: fullPath, relativePath, isDirectory: e.isDirectory() });
        }
        if (e.isDirectory()) walk(fullPath);
      }
    } catch { /* skip inaccessible dirs */ }
  }

  walk(rootDir);
  return results;
});

ipcMain.handle('git:status', (event, projectPath) => {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
    return output.replace(/\s+$/, '').split('\n').filter(Boolean).map(line => ({
      status: line.substring(0, 2),
      file: line.substring(3)
    }));
  } catch {
    return [];
  }
});

ipcMain.handle('git:branch', (event, projectPath) => {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd: projectPath, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return '';
  }
});

ipcMain.handle('git:stageFile', (event, projectPath, filePath) => {
  try {
    execFileSync('git', ['add', '--', filePath], { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:unstageFile', (event, projectPath, filePath) => {
  try {
    execFileSync('git', ['reset', 'HEAD', '--', filePath], { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:stageAll', (event, projectPath) => {
  try {
    execFileSync('git', ['add', '-A'], { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:unstageAll', (event, projectPath) => {
  try {
    execFileSync('git', ['reset', 'HEAD'], { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:commit', (event, projectPath, message, amend) => {
  try {
    const args = amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message];
    execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:pull', (event, projectPath) => {
  try {
    const output = execFileSync('git', ['pull'], { cwd: projectPath, encoding: 'utf8', timeout: 30000 });
    return { success: true, output: output.trim() || 'Pull complete' };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:push', (event, projectPath) => {
  try {
    execFileSync('git', ['push'], { cwd: projectPath, encoding: 'utf8', timeout: 30000 });
    return { success: true, output: 'Push complete' };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:discardFile', (event, projectPath, filePath) => {
  try {
    execFileSync('git', ['checkout', '--', filePath], { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:branches', (event, projectPath) => {
  try {
    const output = execFileSync('git', ['branch', '--list', '--no-color'], { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
    return output.trim().split('\n').filter(Boolean).map(line => ({
      name: line.replace(/^\*?\s+/, ''),
      isCurrent: line.startsWith('*')
    }));
  } catch {
    return [];
  }
});

ipcMain.handle('git:checkout', (event, projectPath, branchName) => {
  try {
    execFileSync('git', ['checkout', branchName], { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:createBranch', (event, projectPath, branchName) => {
  try {
    execFileSync('git', ['checkout', '-b', branchName], { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:aheadBehind', (event, projectPath) => {
  try {
    const output = execFileSync('git', ['rev-list', '--count', '--left-right', 'HEAD...@{upstream}'], { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
    const parts = output.trim().split(/\s+/);
    return { ahead: parseInt(parts[0]) || 0, behind: parseInt(parts[1]) || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
});

ipcMain.handle('git:diff', (event, projectPath, filePath, staged) => {
  try {
    const args = staged ? ['diff', '--cached', '--', filePath] : ['diff', '--', filePath];
    return execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
  } catch (err) {
    // For untracked files, show full content as additions
    try {
      const content = require('fs').readFileSync(require('path').join(projectPath, filePath), 'utf8');
      return content.split('\n').map(line => '+' + line).join('\n');
    } catch {
      return '';
    }
  }
});

ipcMain.handle('git:graphLog', (event, projectPath, count) => {
  try {
    const output = execFileSync('git', ['log', '--format=%H|%h|%P|%s|%an|%ar|%D', '-' + (count || 50), '--no-color'], { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
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

ipcMain.handle('git:stashList', (event, projectPath) => {
  try {
    const output = execFileSync('git', ['stash', 'list', '--no-color'], { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
    return output.trim().split('\n').filter(Boolean).map((line, i) => {
      const match = line.match(/^stash@\{(\d+)\}:\s*(.*)$/);
      return match ? { index: parseInt(match[1]), message: match[2] } : { index: i, message: line };
    });
  } catch {
    return [];
  }
});

ipcMain.handle('git:stashPush', (event, projectPath, message) => {
  try {
    const args = message ? ['stash', 'push', '-m', message] : ['stash', 'push'];
    execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:stashPop', (event, projectPath) => {
  try {
    execFileSync('git', ['stash', 'pop'], { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err.stderr || err.message).toString().trim() };
  }
});

ipcMain.handle('git:commitDetail', (event, projectPath, hash) => {
  try {
    // Get metadata
    const metaOutput = execFileSync('git', ['show', '--format=%H|%s|%an|%aI', '-s', hash, '--no-color'], { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
    const meta = metaOutput.trim().split('|');
    // Get file stats with --numstat for exact counts and full paths
    const statOutput = execFileSync('git', ['show', '--numstat', '--format=', hash, '--no-color'], { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
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

ipcMain.handle('git:diffCommit', (event, projectPath, hash, filePath) => {
  try {
    // git show with --pretty suppresses commit metadata, leaving only the diff
    const args = filePath
      ? ['show', '--pretty=format:', '-p', hash, '--', filePath]
      : ['show', '--pretty=format:', '-p', hash];
    const output = execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
    // Strip leading blank lines that --pretty=format: sometimes produces
    return output.replace(/^\n+/, '');
  } catch {
    return '';
  }
});

ipcMain.handle('git:diffStat', (event, projectPath, staged) => {
  try {
    const args = staged ? ['diff', '--numstat', '--cached'] : ['diff', '--numstat'];
    const output = execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
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
  const dirPath = path.join(projectPath, '.claudes');
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch { /* exists */ }
  fs.writeFileSync(path.join(dirPath, 'recent-launches.json'), JSON.stringify(recentLaunches, null, 2), 'utf8');
});

ipcMain.handle('launch:saveConfigs', (event, projectPath, configurations) => {
  const dirPath = path.join(projectPath, '.claudes');
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch { /* exists */ }
  fs.writeFileSync(path.join(dirPath, 'launch.json'), JSON.stringify({ configurations }, null, 2), 'utf8');
});

ipcMain.handle('launch:saveEnvProfiles', (event, projectPath, profiles) => {
  const dirPath = path.join(projectPath, '.claudes');
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch { /* exists */ }
  fs.writeFileSync(path.join(dirPath, 'env-profiles.json'), JSON.stringify(profiles, null, 2), 'utf8');
});

ipcMain.handle('launch:scanCsproj', (event, dirPath) => {
  try {
    return fs.readdirSync(dirPath).filter(f => f.endsWith('.csproj'));
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
    const content = fs.readFileSync(filePath, 'utf8');
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

ipcMain.handle('usage:getAll', () => {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  const results = [];

  try {
    if (!fs.existsSync(claudeProjectsDir)) return results;

    const projectDirs = fs.readdirSync(claudeProjectsDir);
    for (const dir of projectDirs) {
      const projectDir = path.join(claudeProjectsDir, dir);
      let stat;
      try { stat = fs.statSync(projectDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      let jsonlFiles;
      try {
        jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      } catch { continue; }

      for (const file of jsonlFiles) {
        const filePath = path.join(projectDir, file);
        let fileStat;
        try { fileStat = fs.statSync(filePath); } catch { continue; }

        const sessionId = file.replace('.jsonl', '');
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;
        let model = '';
        let firstTimestamp = null;
        let lastTimestamp = null;
        let messageCount = 0;

        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n').filter(Boolean);
          for (const line of lines) {
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }

            if (entry.type === 'assistant' && entry.message && entry.message.usage) {
              const u = entry.message.usage;
              inputTokens += (u.input_tokens || 0);
              outputTokens += (u.output_tokens || 0);
              cacheReadTokens += (u.cache_read_input_tokens || 0);
              cacheCreationTokens += (u.cache_creation_input_tokens || 0);
              if (!model && entry.message.model) model = entry.message.model;
              messageCount++;
            }

            if (entry.timestamp) {
              const ts = typeof entry.timestamp === 'number' ? entry.timestamp : new Date(entry.timestamp).getTime();
              if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
              if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
            }
          }
        } catch { continue; }

        if (messageCount > 0) {
          results.push({
            projectKey: dir,
            sessionId,
            model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            messageCount,
            firstTimestamp,
            lastTimestamp,
            fileSize: fileStat.size,
            modified: fileStat.mtimeMs
          });
        }
      }
    }
  } catch { /* ignore top-level errors */ }

  return results;
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
  hookServer.listen(0, '127.0.0.1', () => {
    hookServerPort = hookServer.address().port;
    console.log('[hook-server] listening on port', hookServerPort);
  });
}

ipcMain.handle('hooks:getPort', () => hookServerPort);
ipcMain.handle('pty:getPort', () => ptyPort);

ipcMain.handle('window:flashFrame', () => {
  if (mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
});

ipcMain.handle('shell:openExternal', (event, url) => {
  return shell.openExternal(url);
});

ipcMain.handle('shell:showItemInFolder', (event, fullPath) => {
  shell.showItemInFolder(fullPath);
});

ipcMain.handle('shell:openPath', (event, fullPath) => {
  return shell.openPath(fullPath);
});

// --- Loop Management IPC ---

ipcMain.handle('loops:getAll', () => {
  return readLoops();
});

ipcMain.handle('loops:getForProject', (event, projectPath) => {
  const data = readLoops();
  const normalized = projectPath.replace(/\\/g, '/');
  return data.loops.filter(l => l.projectPath.replace(/\\/g, '/') === normalized);
});

ipcMain.handle('loops:create', (event, loopConfig) => {
  const data = readLoops();
  const loop = Object.assign({
    id: generateLoopId(),
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    currentRunStartedAt: null
  }, loopConfig);
  data.loops.push(loop);
  writeLoops(data);
  return loop;
});

ipcMain.handle('loops:update', (event, loopId, updates) => {
  const data = readLoops();
  const loop = data.loops.find(l => l.id === loopId);
  if (!loop) return null;
  const safeFields = ['name', 'prompt', 'schedule', 'enabled', 'firstStartOnly', 'skipPermissions', 'dbConnectionString', 'dbReadOnly'];
  safeFields.forEach(field => {
    if (updates[field] !== undefined) loop[field] = updates[field];
  });
  writeLoops(data);
  return loop;
});

ipcMain.handle('loops:delete', (event, loopId) => {
  const data = readLoops();
  data.loops = data.loops.filter(l => l.id !== loopId);
  writeLoops(data);
  const runDir = path.join(LOOPS_RUNS_DIR, loopId);
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return true;
});

ipcMain.handle('loops:toggle', (event, loopId) => {
  const data = readLoops();
  const loop = data.loops.find(l => l.id === loopId);
  if (!loop) return null;
  loop.enabled = !loop.enabled;
  if (loop.enabled) loop.lastError = null;
  writeLoops(data);
  return loop;
});

ipcMain.handle('loops:toggleGlobal', () => {
  const data = readLoops();
  data.globalEnabled = !data.globalEnabled;
  writeLoops(data);
  return data.globalEnabled;
});

ipcMain.handle('loops:runNow', (event, loopId) => {
  runLoop(loopId);
  return true;
});

ipcMain.handle('loops:getHistory', (event, loopId, count) => {
  return getLoopHistory(loopId, count);
});

ipcMain.handle('loops:getRunDetail', (event, loopId, startedAt) => {
  const dir = path.join(LOOPS_RUNS_DIR, loopId);
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

ipcMain.handle('loops:export', (event, projectPath) => {
  const data = readLoops();
  const normalized = projectPath.replace(/\\/g, '/');
  const loops = data.loops
    .filter(l => l.projectPath.replace(/\\/g, '/') === normalized)
    .map(l => ({ name: l.name, prompt: l.prompt, schedule: l.schedule, skipPermissions: l.skipPermissions || false, firstStartOnly: l.firstStartOnly || false, dbConnectionString: l.dbConnectionString || null, dbReadOnly: l.dbReadOnly !== false }));
  if (loops.length === 0) return { cancelled: true };
  const result = dialog.showSaveDialogSync(mainWindow, {
    title: 'Export Loops',
    defaultPath: 'loops-export.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!result) return { cancelled: true };
  const payload = { exportedAt: new Date().toISOString(), source: projectPath, loops };
  fs.writeFileSync(result, JSON.stringify(payload, null, 2), 'utf8');
  return { path: result, count: loops.length };
});

ipcMain.handle('loops:exportOne', (event, loopId) => {
  const data = readLoops();
  const loop = data.loops.find(l => l.id === loopId);
  if (!loop) return { cancelled: true };
  const exported = { name: loop.name, prompt: loop.prompt, schedule: loop.schedule, skipPermissions: loop.skipPermissions || false, firstStartOnly: loop.firstStartOnly || false, dbConnectionString: loop.dbConnectionString || null, dbReadOnly: loop.dbReadOnly !== false };
  const safeName = loop.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const result = dialog.showSaveDialogSync(mainWindow, {
    title: 'Export Loop',
    defaultPath: 'loop-' + safeName + '.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!result) return { cancelled: true };
  const payload = { exportedAt: new Date().toISOString(), loops: [exported] };
  fs.writeFileSync(result, JSON.stringify(payload, null, 2), 'utf8');
  return { path: result, count: 1 };
});

ipcMain.handle('loops:import', (event, projectPath) => {
  const result = dialog.showOpenDialogSync(mainWindow, {
    title: 'Import Loops',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (!result || result.length === 0) return { cancelled: true };
  try {
    const raw = JSON.parse(fs.readFileSync(result[0], 'utf8'));
    const loops = raw.loops || (raw.name && raw.prompt ? [raw] : []);
    if (loops.length === 0) return { error: 'No loops found in file' };
    const data = readLoops();
    const created = [];
    loops.forEach(l => {
      const loop = {
        id: generateLoopId(),
        name: l.name,
        prompt: l.prompt,
        schedule: l.schedule,
        projectPath: projectPath,
        skipPermissions: l.skipPermissions || false,
        firstStartOnly: l.firstStartOnly || false,
        dbConnectionString: l.dbConnectionString || null,
        dbReadOnly: l.dbReadOnly !== false,
        enabled: true,
        createdAt: new Date().toISOString(),
        lastRunAt: null,
        lastRunStatus: null,
        lastError: null,
        currentRunStartedAt: null
      };
      data.loops.push(loop);
      created.push(loop);
    });
    writeLoops(data);
    return { count: created.length };
  } catch (err) {
    return { error: 'Failed to import: ' + err.message };
  }
});

ipcMain.handle('loops:getLiveOutput', (event, loopId) => {
  // Return accumulated output for a currently running loop
  const liveChunks = liveOutputBuffers.get(loopId);
  if (liveChunks) return liveChunks.join('');
  return null;
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

  const agents = (config.agents || []).map(agentConfig => {
    return Object.assign({
      id: generateAgentId(),
      runMode: 'independent',
      runAfter: [],
      runOnUpstreamFailure: false,
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
  });

  const automation = {
    id: automationId,
    name: config.name,
    projectPath: config.projectPath,
    agents: agents,
    enabled: true,
    createdAt: new Date().toISOString()
  };

  data.automations.push(automation);
  writeAutomations(data);
  return automation;
});

ipcMain.handle('automations:update', (event, automationId, updates) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return null;
  const safeFields = ['name', 'enabled'];
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
    'isolation', 'enabled', 'skipPermissions', 'firstStartOnly', 'dbConnectionString', 'dbReadOnly'];
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

ipcMain.handle('automations:runAgentNow', (event, automationId, agentId) => {
  runAgent(automationId, agentId);
  return true;
});

ipcMain.handle('automations:runAutomationNow', (event, automationId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return false;
  // Run all independent agents — dependents will cascade
  automation.agents.forEach(agent => {
    if (agent.enabled && agent.runMode === 'independent') {
      runAgent(automation.id, agent.id);
    }
  });
  return true;
});

ipcMain.handle('automations:setupAgentClone', async (event, automationId, agentId) => {
  const data = readAutomations();
  const automation = data.automations.find(a => a.id === automationId);
  if (!automation) return { error: 'Automation not found' };
  const agent = automation.agents.find(ag => ag.id === agentId);
  if (!agent) return { error: 'Agent not found' };
  if (!agent.isolation || !agent.isolation.enabled) return { error: 'Agent does not have isolation enabled' };

  // Determine clone path
  const baseDir = data.agentReposBaseDir || path.join(os.homedir(), '.claudes', 'agents');
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
      return { error: 'Directory exists but has different remote: ' + existingRemote };
    } catch {
      return { error: 'Directory exists but is not a git repository: ' + clonePath };
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
    const child = spawn('git', ['clone', remoteUrl, clonePath], {
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
    .map(a => ({
      name: a.name,
      agents: a.agents.map(ag => ({
        name: ag.name, prompt: ag.prompt, schedule: ag.schedule,
        runMode: ag.runMode, runAfter: ag.runAfter, runOnUpstreamFailure: ag.runOnUpstreamFailure,
        isolation: { enabled: ag.isolation ? ag.isolation.enabled : false },
        skipPermissions: ag.skipPermissions || false, firstStartOnly: ag.firstStartOnly || false,
        dbConnectionString: ag.dbConnectionString || null, dbReadOnly: ag.dbReadOnly !== false
      }))
    }));
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
    agents: automation.agents.map(ag => ({
      name: ag.name, prompt: ag.prompt, schedule: ag.schedule,
      runMode: ag.runMode, runAfter: ag.runAfter, runOnUpstreamFailure: ag.runOnUpstreamFailure,
      isolation: { enabled: ag.isolation ? ag.isolation.enabled : false },
      skipPermissions: ag.skipPermissions || false, firstStartOnly: ag.firstStartOnly || false,
      dbConnectionString: ag.dbConnectionString || null, dbReadOnly: ag.dbReadOnly !== false
    }))
  };
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

ipcMain.handle('automations:import', (event, projectPath) => {
  const result = dialog.showOpenDialogSync(mainWindow, {
    title: 'Import Automations',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
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

    automations.forEach(imported => {
      const automationId = generateAutomationId();
      const agents = (imported.agents || []).map(ag => {
        const newId = generateAgentId();
        return Object.assign({
          id: newId,
          runMode: 'independent',
          runAfter: [],
          runOnUpstreamFailure: false,
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

      data.automations.push({
        id: automationId,
        name: imported.name,
        projectPath: projectPath,
        agents: agents,
        enabled: true,
        createdAt: new Date().toISOString()
      });
      count++;
    });

    writeAutomations(data);
    return { count };
  } catch (err) {
    return { error: 'Failed to import: ' + err.message };
  }
});

// --- Loop Scheduler & Execution ---

const runningLoops = new Map(); // loopId -> child process
const liveOutputBuffers = new Map(); // loopId -> string[] chunks
const agentLiveOutputBuffers = new Map(); // 'automationId:agentId' -> string[] chunks
const loopQueue = []; // loopIds waiting for a slot

const LOOP_PROMPT_SUFFIX = '\n\nEnd your response with a JSON block wrapped in :::loop-result markers like this:\n:::loop-result\n{"summary": "Brief one-line summary", "attentionItems": [{"summary": "Short description", "detail": "Full context"}]}\n:::loop-result\nIf there are no issues, use an empty attentionItems array.';

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

function parseLoopResult(output) {
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

function shouldRunLoop(loop, now) {
  if (!loop.enabled) return false;
  if (loop.currentRunStartedAt) return false;
  if (loop.schedule.type === 'app_startup') return false; // only triggered on app start
  if (loop.schedule.type === 'manual') return false; // only triggered manually

  if (loop.schedule.type === 'interval') {
    if (!loop.lastRunAt) return true;
    const elapsed = now - new Date(loop.lastRunAt).getTime();
    return elapsed >= loop.schedule.minutes * 60000;
  }

  if (loop.schedule.type === 'time_of_day') {
    const date = new Date(now);
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const today = dayNames[date.getDay()];
    if (loop.schedule.days && loop.schedule.days.indexOf(today) === -1) return false;
    const nowMinutes = date.getHours() * 60 + date.getMinutes();

    // Support multiple times (new format) or single time (legacy)
    const times = loop.schedule.times || [{ hour: loop.schedule.hour, minute: loop.schedule.minute || 0 }];
    const lastRun = loop.lastRunAt ? new Date(loop.lastRunAt) : null;

    for (const t of times) {
      const schedMinutes = t.hour * 60 + (t.minute || 0);
      if (nowMinutes < schedMinutes) continue;
      // Check we haven't already run for this time slot today
      if (lastRun && lastRun.toDateString() === date.toDateString()) {
        const lastRunMinutes = lastRun.getHours() * 60 + lastRun.getMinutes();
        // If last run was after this slot's time, it's already been handled
        if (lastRunMinutes >= schedMinutes) continue;
      }
      return true;
    }
    return false;
  }
  return false;
}

function runLoop(loopId) {
  let data = readLoops();
  const loop = data.loops.find((l) => l.id === loopId);
  if (!loop) return;
  if (runningLoops.has(loopId)) return;

  // Check concurrency limit
  if (runningLoops.size >= (data.maxConcurrentRuns || 3)) {
    if (loopQueue.indexOf(loopId) === -1) loopQueue.push(loopId);
    return;
  }

  // Validate project path
  if (!fs.existsSync(loop.projectPath)) {
    loop.lastRunStatus = 'error';
    loop.lastError = 'Project path not found: ' + loop.projectPath;
    loop.enabled = false;
    writeLoops(data);
    if (mainWindow) mainWindow.webContents.send('loops:run-completed', {
      loopId: loopId, status: 'error', error: loop.lastError
    });
    return;
  }

  // Mark as running
  loop.currentRunStartedAt = new Date().toISOString();
  writeLoops(data);

  if (mainWindow) mainWindow.webContents.send('loops:run-started', { loopId: loopId });

  const startedAt = new Date().toISOString();
  const outputChunks = [];
  const textChunks = []; // Human-readable text for display
  let promptPrefix = '';
  if (loop.dbConnectionString && loop.dbReadOnly !== false) {
    promptPrefix = 'CRITICAL CONSTRAINT: This loop has READ-ONLY database access. You MUST NOT attempt to write, update, insert, delete, drop, rename, or modify any data in the database. This includes using $merge, $out, or any write stages in aggregation pipelines. Do NOT attempt to bypass this restriction by using shell commands (mongosh, mongo, etc.) or any other method. If the task requires writing to the database, report it as an attention item explaining what write would be needed, but do not perform it.\n\n';
  }
  const fullPrompt = promptPrefix + loop.prompt + LOOP_PROMPT_SUFFIX;

  const args = ['--print', fullPrompt, '--output-format', 'stream-json', '--verbose'];
  if (loop.skipPermissions) args.push('--dangerously-skip-permissions');

  // Database MCP config
  let mcpConfigPath = null;
  if (loop.dbConnectionString) {
    const mcpArgs = ['-y', 'mongodb-mcp-server@latest'];
    if (loop.dbReadOnly !== false) mcpArgs.push('--readOnly');
    const mcpConfig = {
      mcpServers: {
        mongodb: {
          command: 'npx',
          args: mcpArgs,
          env: {
            MDB_MCP_CONNECTION_STRING: loop.dbConnectionString
          }
        }
      }
    };
    mcpConfigPath = path.join(LOOPS_RUNS_DIR, loopId + '_mcp.json');
    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), 'utf8');
    args.push('--mcp-config', mcpConfigPath);

    // Allowlist-only mode when read-only: deny everything except safe read tools.
    // A blocklist is insufficient — Claude can bypass via Bash (e.g. mongosh).
    if (loop.dbReadOnly !== false) {
      const allowedTools = [
        // Read-only MongoDB MCP tools
        'mcp__mongodb__find',
        'mcp__mongodb__count',
        'mcp__mongodb__collection-indexes',
        'mcp__mongodb__collection-schema',
        'mcp__mongodb__collection-storage-size',
        'mcp__mongodb__db-stats',
        'mcp__mongodb__explain',
        'mcp__mongodb__export',
        'mcp__mongodb__list-collections',
        'mcp__mongodb__list-databases',
        'mcp__mongodb__mongodb-logs',
        'mcp__mongodb__list-knowledge-sources',
        'mcp__mongodb__search-knowledge',
        // Safe file/code reading tools
        'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'
      ];
      args.push('--allowedTools', allowedTools.join(','));
    }
  }

  const child = spawn(getClaudePath(), args, {
    cwd: loop.projectPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env)
  });

  runningLoops.set(loopId, child);
  liveOutputBuffers.set(loopId, textChunks);

  let streamBuffer = '';
  child.stdout.on('data', (chunk) => {
    const raw = chunk.toString();
    outputChunks.push(raw);
    // Parse streaming JSON events (newline-delimited JSON)
    streamBuffer += raw;
    const lines = streamBuffer.split('\n');
    streamBuffer = lines.pop(); // keep incomplete line in buffer
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
          // Final result — extract text from content blocks
          if (typeof evt.result === 'string') {
            text = evt.result;
          } else if (Array.isArray(evt.result)) {
            evt.result.forEach(block => {
              if (block.type === 'text') text += block.text;
            });
          }
        }
        if (text) {
          textChunks.push(text);
          if (mainWindow) mainWindow.webContents.send('loops:output', { loopId, chunk: text });
        }
      } catch { /* skip non-JSON lines */ }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    textChunks.push(text);
    if (mainWindow) mainWindow.webContents.send('loops:output', { loopId, chunk: text });
  });

  child.on('close', (exitCode) => {
    runningLoops.delete(loopId);
    liveOutputBuffers.delete(loopId);
    // Clean up temp MCP config
    if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }

    const completedAt = new Date().toISOString();
    const displayOutput = textChunks.join('');
    const parsed = parseLoopResult(displayOutput);

    const runData = {
      loopId: loopId,
      startedAt: startedAt,
      completedAt: completedAt,
      durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      exitCode: exitCode,
      status: exitCode === 0 ? 'completed' : 'error',
      summary: parsed.summary,
      output: displayOutput,
      attentionItems: parsed.attentionItems,
      costUsd: null
    };

    saveLoopRun(loopId, runData);

    // Update loop config
    const freshData = readLoops();
    const freshLoop = freshData.loops.find((l) => l.id === loopId);
    if (freshLoop) {
      freshLoop.currentRunStartedAt = null;
      freshLoop.lastRunAt = completedAt;
      freshLoop.lastRunStatus = runData.status;
      freshLoop.lastError = exitCode === 0 ? null : 'Exit code: ' + exitCode;
      freshLoop.lastSummary = parsed.summary || null;
      freshLoop.lastAttentionItems = parsed.attentionItems || [];
      writeLoops(freshData);
    }

    // Notify renderer
    if (mainWindow) {
      mainWindow.webContents.send('loops:run-completed', {
        loopId: loopId,
        status: runData.status,
        summary: parsed.summary,
        attentionItems: parsed.attentionItems,
        exitCode: exitCode
      });

      if (parsed.attentionItems.length > 0) {
        mainWindow.flashFrame(true);
      }
    }

    // Process queue
    if (loopQueue.length > 0) {
      const nextId = loopQueue.shift();
      runLoop(nextId);
    }
  });

  child.on('error', (err) => {
    runningLoops.delete(loopId);
    if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
    const freshData = readLoops();
    const freshLoop = freshData.loops.find((l) => l.id === loopId);
    if (freshLoop) {
      freshLoop.currentRunStartedAt = null;
      freshLoop.lastRunStatus = 'error';
      freshLoop.lastError = err.message;
      writeLoops(freshData);
    }
    if (mainWindow) mainWindow.webContents.send('loops:run-completed', {
      loopId: loopId, status: 'error', error: err.message
    });
    if (loopQueue.length > 0) {
      const nextId = loopQueue.shift();
      runLoop(nextId);
    }
  });
}

let loopSchedulerTimer = null;

function startLoopScheduler() {
  // Startup recovery: clear stale "running" states
  const data = readLoops();
  let changed = false;
  data.loops.forEach((loop) => {
    if (loop.currentRunStartedAt) {
      loop.currentRunStartedAt = null;
      loop.lastRunStatus = 'interrupted';
      loop.lastError = 'App closed during run';
      changed = true;
    }
  });
  if (changed) writeLoops(data);

  // Run loops scheduled as app_startup
  setTimeout(() => {
    const startupData = readLoops();
    if (!startupData.globalEnabled) return;
    const todayStr = new Date().toDateString();
    startupData.loops.forEach((loop) => {
      if (!loop.enabled) return;
      if (!loop.schedule || loop.schedule.type !== 'app_startup') return;

      if (loop.firstStartOnly && loop.lastRunAt) {
        const lastRunDate = new Date(loop.lastRunAt).toDateString();
        if (lastRunDate === todayStr) return; // already ran today
      }
      runLoop(loop.id);
    });
  }, 5000); // slight delay to let the app fully initialize

  // Check every 30 seconds
  loopSchedulerTimer = setInterval(() => {
    const loopData = readLoops();
    if (!loopData.globalEnabled) return;
    const now = Date.now();
    loopData.loops.forEach((loop) => {
      if (shouldRunLoop(loop, now)) {
        runLoop(loop.id);
      }
    });
  }, 30000);
}

function stopLoopScheduler() {
  if (loopSchedulerTimer) {
    clearInterval(loopSchedulerTimer);
    loopSchedulerTimer = null;
  }
  runningLoops.forEach((child) => {
    try { child.kill(); } catch { /* ignore */ }
  });
  runningLoops.clear();
  const data = readLoops();
  let changed = false;
  data.loops.forEach((loop) => {
    if (loop.currentRunStartedAt) {
      loop.currentRunStartedAt = null;
      loop.lastRunStatus = 'interrupted';
      loop.lastError = 'App closed during run';
      changed = true;
    }
  });
  if (changed) writeLoops(data);
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
    await startPtyServer();
    startHookServer();
    createTray();
    createWindow();
    setupAutoUpdater();
    migrateLoopsToAutomations();
    startLoopScheduler();
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
    stopLoopScheduler();
    if (ptyServerProcess) {
      ptyServerProcess.kill();
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopLoopScheduler();
  if (ptyServerProcess) {
    ptyServerProcess.kill();
  }
});
