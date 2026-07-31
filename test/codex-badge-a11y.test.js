'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

test('Codex badge exposes launch and live safety state to keyboard and accessibility APIs', () => {
  const createStart = renderer.indexOf('function createColumnHeader');
  const createEnd = renderer.indexOf('// Subscription chip', createStart);
  const createBadge = renderer.slice(createStart, createEnd);
  assert.match(createBadge, /codexBadge\.tabIndex\s*=\s*0/);
  assert.match(createBadge, /updateCodexBadgeAccessibility\(codexBadge/);

  const helperStart = renderer.indexOf('function updateCodexBadgeAccessibility');
  const helperEnd = renderer.indexOf('function createColumnHeader', helperStart);
  const helper = renderer.slice(helperStart, helperEnd);
  assert.match(helper, /Launch preset:/);
  assert.match(helper, /Effective approval:/);
  assert.match(helper, /Effective sandbox:/);
  assert.match(helper, /setAttribute\('aria-label'/);

  const stateStart = renderer.indexOf('function applyCodexThreadState');
  const stateEnd = renderer.indexOf('function handleCodexThreadState', stateStart);
  const stateUpdate = renderer.slice(stateStart, stateEnd);
  assert.match(stateUpdate, /updateCodexBadgeAccessibility\(badge/);
});
