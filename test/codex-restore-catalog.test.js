'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

test('session restore waits for the Codex catalog only for Codex entries', () => {
  const restoreStart = renderer.indexOf('function restoreSessions');
  const restoreEnd = renderer.indexOf('// Strip args that don\'t apply', restoreStart);
  const restore = renderer.slice(restoreStart, restoreEnd);

  assert.match(restore, /if \(e && e\.kind === 'codex'\) \{\s*await ensureCodexCatalog\(\);/);
  assert.match(restore, /if \(ment && ment\.kind === 'codex'\) \{\s*await ensureCodexCatalog\(\);/);
});
