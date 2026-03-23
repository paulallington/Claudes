const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeTheme, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const http = require('http');

let mainWindow;
let hookServer;
let hookServerPort;
const ptyPort = app.isPackaged ? 3456 : 3457;
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

function createWindow() {
  const config = readConfig();
  const isLight = config.theme === 'auto' ? !nativeTheme.shouldUseDarkColors : config.theme === 'light';

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 600,
    minHeight: 400,
    title: 'Claudes',
    icon: path.join(__dirname, 'icon.ico'),
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

ipcMain.handle('git:log', (event, projectPath, count) => {
  try {
    const output = execFileSync('git', ['log', '--oneline', '-' + (count || 10), '--no-color'], { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
    return output.trim().split('\n').filter(Boolean).map(line => {
      const spaceIdx = line.indexOf(' ');
      return { hash: line.substring(0, spaceIdx), message: line.substring(spaceIdx + 1) };
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
  return { configs, envProfiles };
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
