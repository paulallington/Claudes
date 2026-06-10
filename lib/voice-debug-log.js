const fs = require('fs');

// Append a line to a log file, rotating it aside to <path>.1 once it exceeds
// maxBytes (keeps one previous file; .1 is overwritten on the next rotation).
// Best-effort: never throws to the caller.
function appendWithRotation(filePath, line, maxBytes) {
  try {
    let size = 0;
    try { size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0; } catch (e) { size = 0; }
    if (maxBytes && size >= maxBytes) {
      try { fs.renameSync(filePath, filePath + '.1'); } catch (e) { /* rotation best-effort */ }
    }
    fs.appendFileSync(filePath, line + '\n', 'utf8');
  } catch (e) { /* logging must never break the app */ }
}

module.exports = { appendWithRotation };
