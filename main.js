const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeTheme, shell, Tray, Menu, nativeImage, Notification } = require('electron');
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
  const safeFields = ['name', 'enabled', 'manager'];
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
    'passUpstreamContext', 'isolation', 'enabled', 'skipPermissions', 'firstStartOnly', 'dbConnectionString', 'dbReadOnly'];
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
      // Second pass: remap runAfter references
      agents.forEach(agent => {
        if (agent.runAfter && agent.runAfter.length > 0) {
          agent.runAfter = agent.runAfter.map(ref => importIdMap[ref] || ref);
        }
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

ipcMain.handle('automations:validateDependencies', (event, agents) => {
  if (hasCyclicDependencies(agents)) {
    return { valid: false, error: 'Circular dependency detected in agent run-after chain' };
  }
  return { valid: true };
});

ipcMain.handle('automations:getSettings', () => {
  const data = readAutomations();
  return {
    agentReposBaseDir: data.agentReposBaseDir || path.join(os.homedir(), '.claudes', 'agents')
  };
});

ipcMain.handle('automations:updateSettings', (event, settings) => {
  const data = readAutomations();
  if (settings.agentReposBaseDir !== undefined) {
    data.agentReposBaseDir = settings.agentReposBaseDir;
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

  const baseDir = data.agentReposBaseDir || path.join(os.homedir(), '.claudes', 'agents');
  const projectName = automation.projectPath.split(/[/\\]/).pop();
  const clonePath = path.join(baseDir, projectName, '_manager');

  if (fs.existsSync(clonePath)) {
    const freshData = readAutomations();
    const freshAuto = freshData.automations.find(a => a.id === automationId);
    if (freshAuto && freshAuto.manager) {
      freshAuto.manager.isolation.clonePath = clonePath;
      writeAutomations(freshData);
    }
    return { clonePath, status: 'reused' };
  }

  let remoteUrl = '';
  try {
    remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: automation.projectPath, encoding: 'utf8' }).trim();
  } catch {
    remoteUrl = automation.projectPath;
  }

  fs.mkdirSync(path.dirname(clonePath), { recursive: true });

  return new Promise((resolve) => {
    const child = spawn('git', ['clone', remoteUrl, clonePath], { stdio: ['ignore', 'pipe', 'pipe'] });
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

function shouldRunAgent(agent, now) {
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

  const args = ['--print', fullPrompt, '--output-format', 'stream-json', '--verbose'];
  if (agent.skipPermissions) args.push('--dangerously-skip-permissions');

  // Database MCP config
  let mcpConfigPath = null;
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
    mcpConfigPath = path.join(AUTOMATIONS_RUNS_DIR, automationId + '_' + agentId + '_mcp.json');
    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), 'utf8');
    args.push('--mcp-config', mcpConfigPath);

    if (agent.dbReadOnly !== false) {
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

  const child = spawn(getClaudePath(), args, {
    cwd: cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env)
  });

  runningAgents.set(key, child);
  agentLiveOutputBuffers.set(key, textChunks);

  let streamBuffer = '';
  child.stdout.on('data', (chunk) => {
    const raw = chunk.toString();
    outputChunks.push(raw);
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
        if (text) {
          textChunks.push(text);
          if (mainWindow) mainWindow.webContents.send('automations:agent-output', { automationId, agentId, chunk: text });
        }
      } catch { /* skip non-JSON lines */ }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    textChunks.push(text);
    if (mainWindow) mainWindow.webContents.send('automations:agent-output', { automationId, agentId, chunk: text });
  });

  child.on('close', (exitCode) => {
    runningAgents.delete(key);
    agentLiveOutputBuffers.delete(key);
    if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }

    const completedAt = new Date().toISOString();
    const displayOutput = textChunks.join('');
    const parsed = parseAgentResult(displayOutput);

    const runData = {
      automationId, agentId,
      startedAt, completedAt,
      durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      exitCode,
      status: exitCode === 0 ? 'completed' : 'error',
      summary: parsed.summary,
      output: displayOutput,
      attentionItems: parsed.attentionItems,
      costUsd: null
    };

    saveAgentRun(automationId, agentId, runData);

    // Update agent config
    const freshData = readAutomations();
    const freshAuto = freshData.automations.find(a => a.id === automationId);
    if (freshAuto) {
      const freshAgent = freshAuto.agents.find(ag => ag.id === agentId);
      if (freshAgent) {
        freshAgent.currentRunStartedAt = null;
        freshAgent.lastRunAt = completedAt;
        freshAgent.lastRunStatus = runData.status;
        freshAgent.lastError = exitCode === 0 ? null : 'Exit code: ' + exitCode;
        freshAgent.lastSummary = parsed.summary || null;
        freshAgent.lastAttentionItems = parsed.attentionItems || [];
        writeAutomations(freshData);
      }

      // Trigger dependent agents
      triggerDependentAgents(automationId, agentId, runData.status, freshData);

      // Check if pipeline is fully complete — trigger manager if configured
      checkPipelineComplete(automationId);
    }

    // Notify renderer
    if (mainWindow) {
      mainWindow.webContents.send('automations:agent-completed', {
        automationId, agentId,
        status: runData.status,
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
    if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
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
      const baseDir = data.agentReposBaseDir || path.join(os.homedir(), '.claudes', 'agents');
      const projectName = automation.projectPath.split(/[/\\]/).pop();
      const clonePath = path.join(baseDir, projectName, '_manager');

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
          execFileSync('git', ['clone', remoteUrl, clonePath], { encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
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

  const child = spawn(getClaudePath(), args, {
    cwd: cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env)
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
    const todayStr = new Date().toDateString();
    startupData.automations.forEach(automation => {
      if (!automation.enabled) return;
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
        if (shouldRunAgent(agent, now)) {
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
    await startPtyServer();
    startHookServer();
    createTray();
    createWindow();
    setupAutoUpdater();
    migrateLoopsToAutomations();
    startAutomationScheduler();
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
  stopAutomationScheduler();
  if (ptyServerProcess) {
    ptyServerProcess.kill();
  }
});
