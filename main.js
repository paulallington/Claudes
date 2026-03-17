const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

let mainWindow;
let ptyServerProcess;

const CONFIG_DIR = path.join(os.homedir(), '.claudes');
const CONFIG_FILE = path.join(CONFIG_DIR, 'projects.json');

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

// --- Pty Server ---

function findSystemNode() {
  try {
    const result = execFileSync('where', ['node'], { encoding: 'utf8' });
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
      env: { ...process.env }
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 600,
    minHeight: 400,
    title: 'Claudes',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#1a1a2e',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#16213e',
      symbolColor: '#e0e0e0',
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
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

ipcMain.handle('git:status', (event, projectPath) => {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
    return output.trim().split('\n').filter(Boolean).map(line => ({
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

ipcMain.handle('git:commit', (event, projectPath, message) => {
  try {
    execFileSync('git', ['commit', '-m', message], { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
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

ipcMain.handle('launch:getConfigs', (event, projectPath) => {
  const launchPath = path.join(projectPath, '.vscode', 'launch.json');
  try {
    let content = fs.readFileSync(launchPath, 'utf8');
    // Strip JSONC comments
    content = content.replace(/\/\/.*$/gm, '');
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');
    content = content.replace(/,\s*([\]}])/g, '$1');
    const data = JSON.parse(content);
    return data.configurations || [];
  } catch {
    return [];
  }
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
    mainWindow?.webContents.send('update:available', { version: info.version });
  });

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update:downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[auto-updater]', err.message);
  });

  autoUpdater.checkForUpdatesAndNotify();
}

ipcMain.handle('update:install', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

// --- App Lifecycle ---

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await startPtyServer();
    createWindow();
    setupAutoUpdater();
  });
}

app.on('window-all-closed', () => {
  if (ptyServerProcess) {
    ptyServerProcess.kill();
  }
  app.quit();
});

app.on('before-quit', () => {
  if (ptyServerProcess) {
    ptyServerProcess.kill();
  }
});
