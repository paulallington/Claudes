// test/profile-resolve.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { resolveProfile, profileClaudeRoot, PRIMARY_ID } = require('../lib/profile-resolve');

const PROFILES = [
  { id: 'primary', name: 'Primary', configDir: null, colour: '#d97757' },
  { id: 'pf_work', name: 'Work', configDir: '/home/me/.claudes/profiles/pf_work', colour: '#5b8def' }
];
const base = { profiles: PROFILES, defaultProfileId: 'primary' };

test('falls back to the global default when nothing is assigned', () => {
  const r = resolveProfile(base);
  assert.strictEqual(r.id, 'primary');
  assert.strictEqual(r.isPrimary, true);
  assert.deepStrictEqual(r.env, {});
});

test('primary sets no CLAUDE_CONFIG_DIR', () => {
  const r = resolveProfile({ ...base, projectProfileId: 'primary' });
  assert.deepStrictEqual(r.env, {});
});

test('a secondary profile sets CLAUDE_CONFIG_DIR', () => {
  const r = resolveProfile({ ...base, projectProfileId: 'pf_work' });
  assert.strictEqual(r.isPrimary, false);
  assert.deepStrictEqual(r.env, { CLAUDE_CONFIG_DIR: '/home/me/.claudes/profiles/pf_work' });
});

test('column beats workspace beats project beats default', () => {
  assert.strictEqual(resolveProfile({ ...base, projectProfileId: 'pf_work' }).id, 'pf_work');
  assert.strictEqual(resolveProfile({
    ...base, projectProfileId: 'pf_work', workspaceProfileId: 'primary'
  }).id, 'primary');
  assert.strictEqual(resolveProfile({
    ...base, projectProfileId: 'primary', workspaceProfileId: 'primary', columnProfileId: 'pf_work'
  }).id, 'pf_work');
});

test('null/empty assignments are treated as "inherit", not as a selection', () => {
  const r = resolveProfile({ ...base, projectProfileId: 'pf_work', columnProfileId: null, workspaceProfileId: '' });
  assert.strictEqual(r.id, 'pf_work');
});

test('an unknown id resolves to Primary and reports a warning', () => {
  const r = resolveProfile({ ...base, columnProfileId: 'pf_deleted' });
  assert.strictEqual(r.id, 'primary');
  assert.strictEqual(r.warning, 'unknown-profile:pf_deleted');
});

test('a missing Primary entry still yields a usable Primary', () => {
  const r = resolveProfile({ profiles: [], defaultProfileId: 'primary' });
  assert.strictEqual(r.id, 'primary');
  assert.strictEqual(r.configDir, null);
  assert.deepStrictEqual(r.env, {});
});

test('a garbage profiles argument does not throw', () => {
  const r = resolveProfile({ profiles: null, defaultProfileId: null });
  assert.strictEqual(r.id, 'primary');
});

test('profileClaudeRoot returns ~/.claude for Primary and the config dir otherwise', () => {
  assert.strictEqual(
    profileClaudeRoot({ id: 'primary', configDir: null }, '/home/me'),
    path.join('/home/me', '.claude')
  );
  assert.strictEqual(
    profileClaudeRoot({ id: 'pf_work', configDir: '/home/me/.claudes/profiles/pf_work' }, '/home/me'),
    '/home/me/.claudes/profiles/pf_work'
  );
});

test('PRIMARY_ID is stable', () => {
  assert.strictEqual(PRIMARY_ID, 'primary');
});
