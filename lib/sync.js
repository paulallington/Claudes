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
const fsp = require('fs').promises;
const path = require('path');

// Map<projectPath, { exportWatcher, importWatchers: Map<importPath, watcher>,
//                    rescueTimer, exportCtx, importCtxs }>
// exportCtx / importCtxs carry the params the periodic rescan needs.
const projectWatchers = new Map();

// Debounce window for filesystem events. fs.watch fires multiple events per
// write on most platforms; we coalesce them per-file so a chatty Claude
// session doesn't trigger a copy per token.
const COPY_DEBOUNCE_MS = 750;
// Don't propagate writes older than this on initial scan — protects against
// thrashing the cloud upload queue with ancient sessions when the user first
// enables sync on a long-running project.
const INITIAL_SCAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Periodic rescan to catch fs.watch events the OS dropped — common on
// cloud-mirrored folders (Drive Desktop, OneDrive) where files appear via
// the cloud client rather than a normal write syscall.
const RESCUE_INTERVAL_MS = 3 * 60 * 1000;

async function safeMkdir(dir) {
  try { await fsp.mkdir(dir, { recursive: true }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
}

// Copy src → dst only when src is newer or the sizes differ. Async so a
// large initial mirror doesn't block the main process for seconds. Returns
// true if a copy actually happened, false otherwise.
async function copyIfChanged(src, dst) {
  let srcStat;
  try { srcStat = await fsp.stat(src); } catch { return false; }
  if (!srcStat.isFile()) return false;
  try {
    const dstStat = await fsp.stat(dst);
    if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) {
      return false;
    }
  } catch { /* dst doesn't exist — copy */ }
  await safeMkdir(path.dirname(dst));
  await fsp.copyFile(src, dst);
  // Preserve mtime so subsequent runs can short-circuit. Without this every
  // restart would re-copy every file regardless of content.
  try { await fsp.utimes(dst, srcStat.atime, srcStat.mtime); } catch { /* best-effort */ }
  return true;
}

async function listJsonlFiles(dir) {
  try {
    const entries = await fsp.readdir(dir);
    return entries.filter((f) => f.endsWith('.jsonl'));
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

// Fire-and-forget full mirror of every .jsonl in src → dst. Each file is
// awaited individually but we yield between files so the event loop stays
// responsive (the IPC reply doesn't wait on this).
async function mirrorFolder(src, dst, opts) {
  opts = opts || {};
  const honourAge = opts.honourAge !== false;
  const now = Date.now();
  const files = await listJsonlFiles(src);
  for (const f of files) {
    const sp = path.join(src, f);
    let st;
    try { st = await fsp.stat(sp); } catch { continue; }
    if (honourAge && now - st.mtimeMs > INITIAL_SCAN_MAX_AGE_MS) continue;
    const dp = path.join(dst, f);
    try {
      if (await copyIfChanged(sp, dp) && opts.onCopy) opts.onCopy(f);
    } catch (err) {
      if (opts.log) opts.log('[sync] mirror copy failed ' + sp + ': ' + err.message);
    }
    // Yield so the main process can handle other IPC during a big mirror.
    await new Promise((r) => setImmediate(r));
  }
}

// Per-watch debounced copier. Returns a function that, given a filename,
// schedules a single-file copy from src/<file> → dst/<file>.
function makeDebouncedCopier(src, dst, log, tag) {
  const pending = new Map(); // filename -> timer
  return function schedule(file) {
    if (!file || !file.endsWith('.jsonl')) return;
    if (pending.has(file)) clearTimeout(pending.get(file));
    pending.set(file, setTimeout(async () => {
      pending.delete(file);
      try {
        const did = await copyIfChanged(path.join(src, file), path.join(dst, file));
        if (did && log) log('[sync] ' + tag + ': ' + file);
      } catch (err) {
        if (log) log('[sync] copy failed ' + tag + ' ' + file + ': ' + err.message);
      }
    }, COPY_DEBOUNCE_MS));
  };
}

function startExportWatcher(opts) {
  const { homedir, projectPath, projectName, syncSource, deviceName, log } = opts;
  if (!syncSource || !deviceName) return { watcher: null, ctx: null };
  const src = localClaudeProjectDir(homedir, projectPath);
  const dst = exportTargetDir(syncSource, deviceName, projectName);

  // Synchronous-ish setup but cheap: just mkdirs + attach watcher. The
  // mirror itself is fire-and-forget below.
  try {
    fs.mkdirSync(dst, { recursive: true });
    fs.mkdirSync(src, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST' && log) log('[sync] cannot prepare export dirs: ' + err.message);
  }

  const copy = makeDebouncedCopier(src, dst, log, 'exported');
  let watcher;
  try { watcher = fs.watch(src, { persistent: false }, (_event, filename) => copy(filename)); }
  catch (err) {
    if (log) log('[sync] watch failed on ' + src + ': ' + err.message);
    return { watcher: null, ctx: null };
  }
  watcher.on('error', (err) => log && log('[sync] export watch error: ' + err.message));

  // Seed without blocking — IPC has already returned by the time this runs.
  mirrorFolder(src, dst, { onCopy: (f) => log && log('[sync] export seed: ' + f), log });

  return { watcher, ctx: { src, dst } };
}

function startImportWatcher(opts) {
  const { homedir, projectPath, importSrc, log } = opts;
  if (!importSrc) return { watcher: null, ctx: null };
  const dst = localClaudeProjectDir(homedir, projectPath);
  try { fs.mkdirSync(dst, { recursive: true }); }
  catch (err) { if (err.code !== 'EEXIST' && log) log('[sync] mkdir failed ' + dst + ': ' + err.message); }
  if (!fs.existsSync(importSrc)) {
    if (log) log('[sync] import source missing: ' + importSrc);
    return { watcher: null, ctx: null };
  }
  const copy = makeDebouncedCopier(importSrc, dst, log, 'imported');
  let watcher;
  try { watcher = fs.watch(importSrc, { persistent: false }, (_event, filename) => copy(filename)); }
  catch (err) {
    if (log) log('[sync] watch failed on ' + importSrc + ': ' + err.message);
    return { watcher: null, ctx: null };
  }
  watcher.on('error', (err) => log && log('[sync] import watch error: ' + err.message));

  // Background seed — never block the IPC reply.
  mirrorFolder(importSrc, dst, { onCopy: (f) => log && log('[sync] import seed: ' + f), log });

  return { watcher, ctx: { src: importSrc, dst } };
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
  if (w.rescueTimer) clearInterval(w.rescueTimer);
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
  const state = {
    exportWatcher: null,
    importWatchers: new Map(),
    exportCtx: null,
    importCtxs: new Map(),
    rescueTimer: null
  };

  if (project.syncExport && syncSource && deviceName) {
    const { watcher, ctx } = startExportWatcher({
      homedir, projectPath: project.path, projectName, syncSource, deviceName, log
    });
    state.exportWatcher = watcher;
    state.exportCtx = ctx;
  }
  const imports = Array.isArray(project.syncImports) ? project.syncImports : [];
  for (const importSrc of imports) {
    const { watcher, ctx } = startImportWatcher({ homedir, projectPath: project.path, importSrc, log });
    if (watcher) {
      state.importWatchers.set(importSrc, watcher);
      state.importCtxs.set(importSrc, ctx);
    }
  }

  // Periodic rescan catches events fs.watch missed (cloud-mirror folders
  // drop events constantly on macOS and Windows). Cheap when nothing changed.
  if (state.exportCtx || state.importCtxs.size > 0) {
    state.rescueTimer = setInterval(() => { runRescan(state, log); }, RESCUE_INTERVAL_MS);
    projectWatchers.set(project.path, state);
  }
}

function runRescan(state, log) {
  if (state.exportCtx) {
    mirrorFolder(state.exportCtx.src, state.exportCtx.dst, {
      onCopy: (f) => log && log('[sync] rescan exported: ' + f), log
    });
  }
  for (const ctx of state.importCtxs.values()) {
    mirrorFolder(ctx.src, ctx.dst, {
      onCopy: (f) => log && log('[sync] rescan imported: ' + f), log
    });
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

// Immediate full rescan for a single project — backs the "Force sync"
// command. Ignores the "30-day max age" guard so it also pulls older
// sessions the user might want.
async function forceSyncProject(projectPath, opts) {
  const state = projectWatchers.get(projectPath);
  if (!state) return { ok: false, error: 'sync not active for this project' };
  const log = opts && opts.log;
  const tasks = [];
  if (state.exportCtx) {
    tasks.push(mirrorFolder(state.exportCtx.src, state.exportCtx.dst, {
      honourAge: false,
      onCopy: (f) => log && log('[sync] force exported: ' + f), log
    }));
  }
  for (const ctx of state.importCtxs.values()) {
    tasks.push(mirrorFolder(ctx.src, ctx.dst, {
      honourAge: false,
      onCopy: (f) => log && log('[sync] force imported: ' + f), log
    }));
  }
  await Promise.all(tasks);
  return { ok: true };
}

module.exports = {
  applyProjectSync,
  applyAllProjects,
  stopProjectWatchers,
  stopAll,
  forceSyncProject,
  exportTargetDir,
  slugifyProjectName,
  resolveExportFolder(syncSource, deviceName, projectName) {
    if (!syncSource || !deviceName || !projectName) return null;
    return exportTargetDir(syncSource, deviceName, projectName);
  }
};
