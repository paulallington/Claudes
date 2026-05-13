// Cross-device session sync.
//
// One-way replication of Claude CLI .jsonl files via the user's existing
// cloud-storage client (Google Drive Desktop, OneDrive, iCloud, Syncthing,
// etc.). We never talk to a cloud API ourselves — the user points us at a
// local directory that their sync tool mirrors to the cloud.
//
// Topology:
//   ~/.claude/projects/<localKey>/                       ← Claude CLI writes here
//                  └── push watcher ─→
//   <syncSource>/<deviceName>/<projectName>/             ← cloud-mirrored
//                  ←─ pull watcher ──
//   ~/.claude/projects/<localKey>/                       ← other machine's CLI reads here
//
// Each session.jsonl has exactly one origin device; the import side never
// overwrites the export side's folder. If the same session UUID is resumed
// on two machines, both grow independently and the user sees both versions
// in the resume picker — an explicit fork rather than a corruption.

const fs = require('fs');
const path = require('path');

// Map<projectPath, { exportWatcher, importWatchers: Map<importPath, watcher>, debounce }>
const projectWatchers = new Map();

// Debounce window for filesystem events. fs.watch fires multiple events per
// write on most platforms; we coalesce them per-file so a chatty Claude
// session doesn't trigger a copy per token.
const COPY_DEBOUNCE_MS = 750;
// Don't propagate writes older than this on initial scan — protects against
// thrashing the cloud upload queue with ancient sessions when the user first
// enables sync on a long-running project.
const INITIAL_SCAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function safeMkdirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
}

// Copy src → dst only when src is newer or the sizes differ. Avoids
// re-copying files the previous watcher tick already mirrored.
function copyIfChanged(src, dst) {
  let srcStat;
  try { srcStat = fs.statSync(src); } catch { return false; }
  if (!srcStat.isFile()) return false;
  try {
    const dstStat = fs.statSync(dst);
    if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) {
      return false;
    }
  } catch { /* dst doesn't exist — copy */ }
  safeMkdirSync(path.dirname(dst));
  fs.copyFileSync(src, dst);
  // Preserve mtime so subsequent runs can short-circuit. Without this every
  // restart would re-copy every file regardless of content.
  try { fs.utimesSync(dst, srcStat.atime, srcStat.mtime); } catch { /* best-effort */ }
  return true;
}

function listJsonlFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch { return []; }
}

// Slug a project name into a directory-safe form. We use this for the
// <projectName> path segment in the sync source so the user can read the
// folder structure with their file browser without seeing encoded paths.
function slugifyProjectName(name) {
  return String(name || 'project')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'project';
}

// Path-key encoding mirroring main.js's projectPathToClaudeKey — duplicated
// here to avoid a circular require. Update both together if Claude CLI ever
// changes its encoding.
function projectPathToClaudeKey(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function localClaudeProjectDir(homedir, projectPath) {
  return path.join(homedir, '.claude', 'projects', projectPathToClaudeKey(projectPath));
}

function exportTargetDir(syncSource, deviceName, projectName) {
  return path.join(syncSource, slugifyProjectName(deviceName), slugifyProjectName(projectName));
}

// One-shot initial mirror — copy everything in `src` into `dst` so the sync
// folder seeds correctly the first time it's enabled.
function initialMirror(src, dst, onCopy) {
  const now = Date.now();
  for (const f of listJsonlFiles(src)) {
    const sp = path.join(src, f);
    let st;
    try { st = fs.statSync(sp); } catch { continue; }
    if (now - st.mtimeMs > INITIAL_SCAN_MAX_AGE_MS) continue;
    const dp = path.join(dst, f);
    if (copyIfChanged(sp, dp) && onCopy) onCopy(f);
  }
}

// Per-project debounced copier. Returns a function that, given a filename,
// schedules a copy from src/<file> → dst/<file>.
function makeDebouncedCopier(src, dst, onCopy) {
  const pending = new Map(); // filename -> timer
  return function schedule(file) {
    if (!file || !file.endsWith('.jsonl')) return;
    if (pending.has(file)) clearTimeout(pending.get(file));
    pending.set(file, setTimeout(() => {
      pending.delete(file);
      try {
        if (copyIfChanged(path.join(src, file), path.join(dst, file)) && onCopy) onCopy(file);
      } catch (err) {
        console.error('[sync] copy failed', src, '→', dst, file, err.message);
      }
    }, COPY_DEBOUNCE_MS));
  };
}

function startExportWatcher(opts) {
  const { homedir, projectPath, projectName, syncSource, deviceName, log } = opts;
  if (!syncSource || !deviceName) return null;
  const src = localClaudeProjectDir(homedir, projectPath);
  const dst = exportTargetDir(syncSource, deviceName, projectName);

  try { safeMkdirSync(dst); }
  catch (err) {
    if (log) log('[sync] cannot create export dir ' + dst + ': ' + err.message);
    return null;
  }
  if (!fs.existsSync(src)) {
    // Claude CLI hasn't created the project dir yet — watcher would error.
    // We'll create it so fs.watch attaches, but it's expected to be empty
    // until the user starts a Claude column in this project.
    safeMkdirSync(src);
  }

  initialMirror(src, dst, (f) => log && log('[sync] export seed: ' + f));
  const copy = makeDebouncedCopier(src, dst, (f) => log && log('[sync] exported: ' + f));
  let watcher;
  try { watcher = fs.watch(src, { persistent: false }, (_event, filename) => copy(filename)); }
  catch (err) {
    if (log) log('[sync] watch failed on ' + src + ': ' + err.message);
    return null;
  }
  watcher.on('error', (err) => log && log('[sync] export watch error: ' + err.message));
  return watcher;
}

function startImportWatcher(opts) {
  const { homedir, projectPath, importSrc, log } = opts;
  if (!importSrc) return null;
  const dst = localClaudeProjectDir(homedir, projectPath);
  safeMkdirSync(dst);
  if (!fs.existsSync(importSrc)) {
    if (log) log('[sync] import source missing: ' + importSrc);
    return null;
  }
  initialMirror(importSrc, dst, (f) => log && log('[sync] imported (seed): ' + f));
  const copy = makeDebouncedCopier(importSrc, dst, (f) => log && log('[sync] imported: ' + f));
  let watcher;
  try { watcher = fs.watch(importSrc, { persistent: false }, (_event, filename) => copy(filename)); }
  catch (err) {
    if (log) log('[sync] watch failed on ' + importSrc + ': ' + err.message);
    return null;
  }
  watcher.on('error', (err) => log && log('[sync] import watch error: ' + err.message));
  return watcher;
}

function stopProjectWatchers(projectPath) {
  const w = projectWatchers.get(projectPath);
  if (!w) return;
  if (w.exportWatcher) { try { w.exportWatcher.close(); } catch { /* ignore */ } }
  if (w.importWatchers) {
    for (const iw of w.importWatchers.values()) {
      try { iw.close(); } catch { /* ignore */ }
    }
  }
  projectWatchers.delete(projectPath);
}

// Apply (or re-apply) sync configuration for a single project. Idempotent:
// stops anything running for this project first, then starts whatever the
// current config requires. Call this after any setting that affects sync
// changes (global settings, per-project toggles).
function applyProjectSync(opts) {
  const { homedir, project, syncSource, deviceName, log } = opts;
  if (!project || !project.path) return;
  stopProjectWatchers(project.path);

  const projectName = project.name || path.basename(project.path);
  const state = { exportWatcher: null, importWatchers: new Map() };

  if (project.syncExport && syncSource && deviceName) {
    state.exportWatcher = startExportWatcher({
      homedir, projectPath: project.path, projectName, syncSource, deviceName, log
    });
  }
  const imports = Array.isArray(project.syncImports) ? project.syncImports : [];
  for (const importSrc of imports) {
    const w = startImportWatcher({ homedir, projectPath: project.path, importSrc, log });
    if (w) state.importWatchers.set(importSrc, w);
  }

  if (state.exportWatcher || state.importWatchers.size > 0) {
    projectWatchers.set(project.path, state);
  }
}

function applyAllProjects(opts) {
  const { homedir, projects, syncSource, deviceName, log } = opts;
  for (const p of (projects || [])) {
    applyProjectSync({ homedir, project: p, syncSource, deviceName, log });
  }
}

function stopAll() {
  for (const projectPath of Array.from(projectWatchers.keys())) {
    stopProjectWatchers(projectPath);
  }
}

module.exports = {
  applyProjectSync,
  applyAllProjects,
  stopProjectWatchers,
  stopAll,
  exportTargetDir,
  slugifyProjectName,
  // Exposed for the renderer-facing IPC: returns the project's export folder
  // path so the user can see where their syncs land.
  resolveExportFolder(syncSource, deviceName, projectName) {
    if (!syncSource || !deviceName || !projectName) return null;
    return exportTargetDir(syncSource, deviceName, projectName);
  }
};
