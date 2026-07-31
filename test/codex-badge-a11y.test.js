'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('Codex badge has a readable light-theme palette', () => {
  assert.match(styles, /\[data-theme="light"\] \.column-header \.col-codex-badge\s*\{[^}]*background:\s*rgba\(9, 105, 218,[^}]*color:\s*#0550ae/s);
});

test('Codex badge reveals its detailed live metadata on hover and keyboard focus', () => {
  const helperStart = renderer.indexOf('function updateCodexBadgeAccessibility');
  const helperEnd = renderer.indexOf('function createColumnHeader', helperStart);
  const helper = renderer.slice(helperStart, helperEnd);
  assert.match(helper, /badge\.dataset\.details\s*=\s*description\.join\('\\n'\)/);
  assert.match(styles, /\.codex-badge-tooltip\s*\{[^}]*white-space:\s*pre-line/s);
  assert.match(styles, /\.codex-badge-tooltip\.codex-badge-tooltip-shown\s*\{[^}]*visibility:\s*visible[^}]*opacity:\s*1/s);
  assert.match(styles, /\.col-codex-badge:focus-visible\s*\{[^}]*outline:/s);
});

test('Codex badge details use a viewport-clamped body overlay outside clipping column rows', () => {
  assert.match(index, /<script src="\.\/lib\/codex-badge-placement\.js"><\/script>/);
  const showStart = renderer.indexOf('function showCodexBadgeDetails');
  const showEnd = renderer.indexOf('function updateCodexBadgeAccessibility', showStart);
  const show = renderer.slice(showStart, showEnd);
  assert.match(show, /document\.body\.appendChild\(tooltip\)/);
  assert.match(show, /window\.CodexBadgePlacement\.placeBadgeTooltip/);

  const createStart = renderer.indexOf('function createColumnHeader');
  const createEnd = renderer.indexOf('// Subscription chip', createStart);
  const create = renderer.slice(createStart, createEnd);
  assert.match(create, /codexBadge\.addEventListener\('mouseenter', showCodexBadgeDetails\)/);
  assert.match(create, /codexBadge\.addEventListener\('focus', showCodexBadgeDetails\)/);
  assert.match(create, /codexBadge\.addEventListener\('mouseleave', hideCodexBadgeDetails\)/);
  assert.match(create, /codexBadge\.addEventListener\('blur', hideCodexBadgeDetails\)/);

  assert.match(styles, /\.codex-badge-tooltip\s*\{[^}]*position:\s*fixed[^}]*max-width:\s*calc\(100vw - 16px\)/s);
});

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

test('direct CLI fallback remains disclosed by the Codex badge in narrow columns', () => {
  const fallbackStart = renderer.indexOf('function markCodexFallback');
  const fallbackEnd = renderer.indexOf('function applyCodexThreadState', fallbackStart);
  const fallback = renderer.slice(fallbackStart, fallbackEnd);
  assert.match(fallback, /querySelector\('\.col-codex-badge'\)/);
  assert.match(fallback, /badge\.textContent\s*=\s*'Direct fallback'/);
  assert.match(fallback, /badge\.classList\.add\('col-codex-badge-fallback'\)/);
  assert.match(fallback, /updateCodexBadgeAccessibility\(badge,\s*null,\s*'Direct fallback · Live context and native resume unavailable'\)/);

  const liveStart = renderer.indexOf('function applyCodexThreadState');
  const liveEnd = renderer.indexOf('function handleCodexThreadState', liveStart);
  const live = renderer.slice(liveStart, liveEnd);
  assert.match(live, /badge\.textContent\s*=\s*'Codex'/);
  assert.match(live, /badge\.classList\.remove\('col-codex-badge-fallback'\)/);
});
