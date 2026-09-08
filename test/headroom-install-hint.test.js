'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { chooseInstallCommand, FALLBACK_INSTALL_COMMAND } = require('../lib/headroom-install-hint');

test('uv wins when both uv and pipx are present', () => {
  const result = chooseInstallCommand({ hasUv: true, hasPipx: true });
  assert.deepStrictEqual(result, {
    installer: 'uv',
    command: 'uv tool install --python 3.13 "headroom-ai[all]"',
  });
});

test('pipx is chosen when only pipx is present', () => {
  const result = chooseInstallCommand({ hasUv: false, hasPipx: true });
  assert.deepStrictEqual(result, {
    installer: 'pipx',
    command: 'pipx install --python python3.13 "headroom-ai[all]"',
  });
});

test('falls back to the pipx command when neither uv nor pipx is detected', () => {
  const result = chooseInstallCommand({ hasUv: false, hasPipx: false });
  assert.deepStrictEqual(result, { installer: null, command: FALLBACK_INSTALL_COMMAND });
  assert.strictEqual(FALLBACK_INSTALL_COMMAND, 'pipx install --python python3.13 "headroom-ai[all]"');
});

test('missing/garbage input is coerced defensively and never throws', () => {
  assert.deepStrictEqual(chooseInstallCommand(), { installer: null, command: FALLBACK_INSTALL_COMMAND });
  assert.deepStrictEqual(chooseInstallCommand(null), { installer: null, command: FALLBACK_INSTALL_COMMAND });
  assert.deepStrictEqual(chooseInstallCommand({ hasUv: 'yes', hasPipx: 0 }), {
    installer: 'uv',
    command: 'uv tool install --python 3.13 "headroom-ai[all]"',
  });
  assert.deepStrictEqual(chooseInstallCommand({ hasUv: 0, hasPipx: 'yes' }), {
    installer: 'pipx',
    command: 'pipx install --python python3.13 "headroom-ai[all]"',
  });
});
