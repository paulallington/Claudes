const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pty-server.js'), 'utf8');

// pty-server.js's own header comments (e.g. diagLogDir's inlining rationale)
// intentionally quote the string require('./lib/...') as prose explaining why
// that require must NOT exist — matching those comment lines verbatim would
// make this test permanently red regardless of the real code. Strip full-line
// comments before scanning so only executable statements are checked.
const CODE_ONLY = SRC
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

test('pty-server.js never requires from ./lib/ (packaged app has no lib/ next to it)', () => {
  // pty-server.js runs from app.asar.unpacked/ under system Node in the packaged
  // app, but lib/ is only unpacked if build.asarUnpack lists it — today it doesn't,
  // so lib/ lives solely inside the packed app.asar. A require('./lib/...') here
  // throws MODULE_NOT_FOUND at startup and crash-loops the whole terminal server
  // ("Terminal server is down — reconnecting..."). See diagLogDir's inlining for
  // the identical, previously-fixed precedent (commit 309915c).
  assert.doesNotMatch(
    CODE_ONLY,
    /require\(\s*['"]\.\/lib\//,
    'pty-server.js must not require(\'./lib/...\') — lib/ is not unpacked from the asar, so this crash-loops the packaged app'
  );
});
