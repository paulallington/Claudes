const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'pty-server.js'), 'utf8');

// pty-server.js's own header comments (e.g. diagLogDir's inlining rationale)
// intentionally quote strings like require('./lib/...') as prose explaining why
// that require must NOT exist — matching those comment lines verbatim would
// make this test permanently red regardless of the real code. Strip full-line
// comments before scanning so only executable statements are checked. This is
// deliberately narrow (full-line `//` only): a relative require quoted inside a
// /* block */ comment, or trailing after code as `// require('./x')`, is left in
// CODE_ONLY and will FAIL this test. That's fail-safe by design — do not "fix" a
// spurious failure by widening the strip; move the offending prose instead.
const CODE_ONLY = SRC
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

test('pty-server.js has no relative requires at all (only pty-server.js is unpacked from the asar)', () => {
  // package.json's build.asarUnpack unpacks pty-server.js itself (plus icons,
  // node-pty, ws) but nothing else — no lib/, no other project files. ANY
  // require('./something') or require('../something') here throws
  // MODULE_NOT_FOUND at startup and crash-loops the whole terminal server
  // ("Terminal server is down — reconnecting..."), not just require('./lib/...').
  // See diagLogDir's and resolveSpawnCommand's inlining for the previously-fixed
  // precedents (commit 309915c and this one). Bare specifiers — require('ws'),
  // require('node-pty'), require('child_process'), etc. — are fine and must keep
  // matching through.
  assert.doesNotMatch(
    CODE_ONLY,
    /require\s*\(\s*['"`]\.\.?\//,
    'pty-server.js must not require(\'./...\') or require(\'../...\') — only pty-server.js itself is unpacked from the asar, so any relative require crash-loops the packaged app'
  );
});
