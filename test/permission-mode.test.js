'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  VALID_PERMISSION_MODES,
  permissionModeToArgs,
  migratePermissionMode
} = require('../lib/permission-mode');

test('VALID_PERMISSION_MODES: exact set and order', () => {
  assert.deepStrictEqual(VALID_PERMISSION_MODES, [
    'default', 'plan', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'
  ]);
});

test('permissionModeToArgs: bypassPermissions uses the legacy skip flag', () => {
  assert.deepStrictEqual(
    permissionModeToArgs('bypassPermissions'),
    ['--dangerously-skip-permissions']
  );
});

test('permissionModeToArgs: plan/acceptEdits/dontAsk/auto use --permission-mode', () => {
  assert.deepStrictEqual(permissionModeToArgs('plan'), ['--permission-mode', 'plan']);
  assert.deepStrictEqual(permissionModeToArgs('acceptEdits'), ['--permission-mode', 'acceptEdits']);
  assert.deepStrictEqual(permissionModeToArgs('dontAsk'), ['--permission-mode', 'dontAsk']);
  assert.deepStrictEqual(permissionModeToArgs('auto'), ['--permission-mode', 'auto']);
});

test('permissionModeToArgs: default and unrecognized values produce no args', () => {
  assert.deepStrictEqual(permissionModeToArgs('default'), []);
  assert.deepStrictEqual(permissionModeToArgs(''), []);
  assert.deepStrictEqual(permissionModeToArgs(undefined), []);
  assert.deepStrictEqual(permissionModeToArgs(null), []);
  assert.deepStrictEqual(permissionModeToArgs('garbage'), []);
});

test('permissionModeToArgs: returns a fresh array each call (no shared mutable state)', () => {
  const a = permissionModeToArgs('plan');
  a.push('mutated');
  assert.deepStrictEqual(permissionModeToArgs('plan'), ['--permission-mode', 'plan']);
});

test('migratePermissionMode: a valid permissionMode wins', () => {
  assert.strictEqual(migratePermissionMode({ permissionMode: 'plan' }), 'plan');
  assert.strictEqual(migratePermissionMode({ permissionMode: 'auto' }), 'auto');
  assert.strictEqual(migratePermissionMode({ permissionMode: 'bypassPermissions' }), 'bypassPermissions');
});

test('migratePermissionMode: invalid mode falls through to legacy skip flag', () => {
  assert.strictEqual(
    migratePermissionMode({ permissionMode: 'nonsense', skipPermissions: true }),
    'bypassPermissions'
  );
});

test('migratePermissionMode: invalid mode with no legacy flag becomes default', () => {
  assert.strictEqual(migratePermissionMode({ permissionMode: 'nonsense' }), 'default');
});

test('migratePermissionMode: legacy skipPermissions:true migrates to bypassPermissions', () => {
  assert.strictEqual(migratePermissionMode({ skipPermissions: true }), 'bypassPermissions');
});

test('migratePermissionMode: skipPermissions:false and empty/missing input become default', () => {
  assert.strictEqual(migratePermissionMode({ skipPermissions: false }), 'default');
  assert.strictEqual(migratePermissionMode({}), 'default');
  assert.strictEqual(migratePermissionMode(null), 'default');
  assert.strictEqual(migratePermissionMode(undefined), 'default');
});
