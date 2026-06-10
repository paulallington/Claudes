const fs = require('fs');

// Atomic JSON write: roll the current file aside to <path>.bak, write to a
// pid-scoped temp, fsync, then rename over the real path. A crash/kill at any
// instant leaves either the old complete file or the new complete file — never
// a truncated one.
function atomicWriteJson(filePath, obj) {
  const json = JSON.stringify(obj, null, 2);
  const tmp = filePath + '.tmp-' + process.pid;
  try { if (fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + '.bak'); } catch (e) { /* best-effort backup */ }
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, json, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

// Read + parse JSON. On parse failure: quarantine the corrupt file to
// <path>.corrupt-<ts>, then try to recover from <path>.bak. Returns
// { data, recovered }: recovered=true whenever we had to fall back (so callers
// can avoid cementing a non-authoritative read). data is null if nothing usable.
function readJsonWithRecovery(filePath) {
  try {
    return { data: JSON.parse(fs.readFileSync(filePath, 'utf8')), recovered: false };
  } catch (err) {
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
        const quarantine = filePath + '.corrupt-' + Date.now();
        fs.copyFileSync(filePath, quarantine);
        console.error('[config] corrupt file quarantined to', quarantine, '-', err.message);
      }
    } catch (e) { /* best-effort quarantine */ }
    try {
      const bak = filePath + '.bak';
      if (fs.existsSync(bak)) {
        const data = JSON.parse(fs.readFileSync(bak, 'utf8'));
        console.error('[config] recovered from backup', bak);
        return { data, recovered: true };
      }
    } catch (e) { console.error('[config] backup recovery failed:', e.message); }
    return { data: null, recovered: true };
  }
}

module.exports = { atomicWriteJson, readJsonWithRecovery };
